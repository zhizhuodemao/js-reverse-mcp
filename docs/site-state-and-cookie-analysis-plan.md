# Site State Reset and Cookie Analysis Plan

Status: proposal  
Scope: design only; no implementation in this document.

## Background

This project is used for JavaScript reverse engineering and browser behavior
analysis. Cookie generation is a common target: a site may set cookies through
HTTP `Set-Cookie`, JavaScript `document.cookie`, redirects, service workers, or
state carried by local storage, IndexedDB, and cache storage.

Two workflows are currently awkward:

1. Inspecting a request does not show the complete response metadata needed for
   cookie analysis.
2. Resetting the current site's browser state requires manual browser actions
   or ad hoc `evaluate_script` snippets.

These two problems are related in the cookie analysis workflow, but they should
be solved as separate tool responsibilities.

## Problem 1: Incomplete Request Details

Current behavior:

- `list_network_requests` without `reqid` lists captured requests.
- `list_network_requests` with `reqid` shows a single request detail view.
- The detail view includes request headers, request body, response body, failure
  information, export hints, and redirect chain.
- The detail view does not print response headers.
- As a result, `Set-Cookie` is not visible in normal request inspection.

Why this matters:

- `Set-Cookie` is response metadata, not request metadata.
- Cookie generation analysis needs to identify exactly which response created or
  updated a cookie.
- Multiple `Set-Cookie` headers can appear on one response.
- A folded object representation is not enough for inspection because repeated
  headers lose their original line structure.

The export path is better but still not ideal:

- `outputPart: "all"` already attempts to export response headers via
  `response.allHeaders()`.
- This is only available through file export, not through normal request detail
  inspection.
- `allHeaders()` returns an object shape. It is convenient, but less precise for
  repeated headers such as `Set-Cookie`.

## Required Change 1: Complete Network Request Detail View

`list_network_requests({ reqid })` should show response headers directly in the
normal MCP text response.

The detail view should include:

```text
## Request https://example.com/path
Status: [success - 200]

### Request Headers
- accept: ...
- cookie: ...

### Request Body
...

### Response Headers
- content-type: ...
- set-cookie: ...
- set-cookie: ...

### Set-Cookie
- cookie_a=...; Path=/; HttpOnly; Secure; SameSite=None
- cookie_b=...; Domain=.example.com; Path=/; ...

### Response Body
...
```

Implementation requirements:

- Prefer `request.headersArray()` over `request.headers()` for request headers.
- Prefer `response.headersArray()` over `response.headers()` or object-shaped
  `response.allHeaders()` for response headers.
- Preserve repeated headers as repeated lines.
- Print a dedicated `### Set-Cookie` section when one or more `Set-Cookie`
  headers exist.
- Keep the existing `Response Body` behavior unchanged unless response body
  formatting is separately revised.

Rationale:

- `headersArray()` preserves repeated header entries.
- `Set-Cookie` is semantically special and should be easy to find.
- Normal request inspection should be sufficient for cookie analysis without
  requiring a file export round trip.

## Required Change 2: Mark Set-Cookie in Request Lists

For JavaScript reverse engineering workflows, request list output must indicate
which requests set cookies.

This is required, not optional.

Current list output makes the user inspect requests one by one to discover where
cookies are set. That is inefficient when a page creates many document, XHR,
fetch, image, script, and redirect requests.

The request list should mark responses that contain one or more `Set-Cookie`
headers:

```text
reqid=12 [document] GET https://example.com/ [success - 200] [set-cookie]
reqid=13 [fetch] POST https://example.com/api/init [success - 200]
reqid=14 [xhr] GET https://example.com/token [success - 200] [set-cookie]
```

Implementation requirements:

- The marker should be shown in `list_network_requests` list mode.
- The marker should also work with pagination, `resourceTypes`, `urlFilter`, and
  preserved request views when feasible.
- The marker should be based on actual response headers, not URL patterns or
  guessed resource types.
- Use `response.headersArray()` and check header names case-insensitively.
- If response headers are unavailable, omit the marker rather than guessing.

Performance note:

- List mode currently formats many requests.
- Checking response headers is async and may add overhead.
- This overhead is acceptable for the JS reverse workflow because identifying
  cookie-setting requests is a core use case.
- If needed later, cache a per-request `hasSetCookie` flag in the network
  collector or formatter layer.

## Problem 2: No Convenient Current-Site State Reset

Current behavior:

- Persistent browser profiles preserve cookies, localStorage, IndexedDB, cache
  storage, service workers, and other site data.
- `--isolated` starts a clean temporary profile, but it resets the whole browser
  context for the session.
- `evaluate_script` can clear some page-visible state, such as
  `localStorage.clear()` and `sessionStorage.clear()`.
- `evaluate_script` cannot reliably clear `HttpOnly` cookies, path/domain
  cookies, service workers, cache storage, or IndexedDB.

Why this matters:

- Cookie generation often depends on the site's prior state.
- Analysts need to repeatedly reset only the target site, then reload or replay
  the flow.
- Resetting the entire browser profile is too broad.
- Manually clearing state in the browser UI is slow and not reproducible.

## Required Change 3: Add `clear_site_data`

Add a new tool:

```text
clear_site_data
```

The tool should create a clean replay environment for the currently selected
page. It is intentionally zero-parameter: calling it means "clear the browser
state that would otherwise pollute the next replay."

Schema:

```ts
{
}
```

Behavior:

- Clear all cookies in the current browser context, including `HttpOnly`
  cookies. This is not scoped to the selected page: it clears cookies for all
  sites and pages that share the current browser context.
- Clear browser HTTP cache.
- Clear all persistent storage for the selected page's origin through CDP
  `Storage.clearDataForOrigin` with `storageTypes: "all"`. This covers
  localStorage, IndexedDB, Cache Storage, Service Workers, WebSQL, file systems,
  storage buckets, shared storage, and related CDP-supported origin data.
- Clear current page sessionStorage.
- Do not reload.

Rationale:

- Cookie generation analysis needs a clean environment, not a partially cleaned
  page.
- Leaving localStorage, IndexedDB, Cache Storage, or Service Workers behind can
  cause the next replay to differ from a fresh visit.
- The model should not choose cookie names, domains, paths, or storage types.
- Reload remains a separate explicit navigation action.

Implementation requirements:

- Derive the target URL from the selected page.
- Reject pages without a normal HTTP(S) origin, such as `about:blank`, `data:`,
  and `file:`, with a clear error.
- Clear cookies through the browser context, not through page JavaScript, using
  `browserContext.clearCookies()` with no filters.
- Clear browser HTTP cache through CDP `Network.clearBrowserCache`.
- Clear selected-origin persistent storage through CDP
  `Storage.clearDataForOrigin`.
- Clear sessionStorage with a page evaluation against the current page.
- Run cleanup best-effort: if one cleanup step fails, continue with the
  remaining steps.
- Return a concise summary of what was actually cleared and any warnings.

Example response:

```text
Browser state cleanup completed for https://www.example.com
URL: https://www.example.com/login

Cookies cleared: yes
Cookies found before clearing: 42
Cookie domains: example.com, google.com, doubleclick.net
Cookie names: _abck, bm_sz, session_id
Browser HTTP cache cleared: yes
Origin storage cleared: yes (Storage.clearDataForOrigin all)
Session storage cleared: yes
Warnings:
none

The page was not reloaded. Use navigate_page({type:"reload"}) to replay cookie generation.
```

## Tool Boundary

The changes should keep tool responsibilities orthogonal:

- `list_network_requests` observes and inspects network activity.
- `clear_site_data` creates a clean replay environment for the selected page.
- `navigate_page` triggers reloads or navigations.
- `evaluate_script` executes analyst-written JavaScript in the page or paused
  call-frame context.

`evaluate_script` should not be treated as a replacement for `clear_site_data`.
It cannot access `HttpOnly` cookies and cannot reliably reset all browser-managed
site state.

## Suggested Implementation Order

1. Add complete response header rendering to request detail view.
2. Add the dedicated `Set-Cookie` section to request detail view.
3. Add `[set-cookie]` markers to request list output.
4. Add zero-parameter `clear_site_data` with strong cleanup behavior.
5. Update generated tool documentation.
6. Run validation.

Validation commands:

```bash
npm run typecheck
npm run build
npm run docs
```

## Acceptance Criteria

Network inspection:

- `list_network_requests({ reqid })` shows response headers.
- Multiple `Set-Cookie` headers are shown as separate lines.
- A dedicated `Set-Cookie` section appears when relevant.
- Request list mode marks cookie-setting responses with `[set-cookie]`.
- Existing request body, response body, redirect chain, pagination, and export
  behavior remain compatible.

Site state reset:

- `clear_site_data` has no parameters.
- `clear_site_data` clears all cookies in the current browser context,
  including `HttpOnly` cookies. Other sites in the same browser context can lose
  cookie-based login state.
- `clear_site_data` clears browser HTTP cache.
- `clear_site_data` clears all persistent storage for the selected page's
  origin.
- `clear_site_data` clears current-page sessionStorage.
- The tool does not reload.
- The tool continues clearing what it can if an individual step fails.
- The tool returns a clear summary of what was actually cleared and any
  warnings.
