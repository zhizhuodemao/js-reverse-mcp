# Pending Request Hang Root Cause

Status: analysis  
Scope: root cause and design requirements; no implementation in this document.

## Summary

The immediate failure was a tool hang while exporting a network request:

```json
{
  "reqid": 138,
  "outputFile": ".../blocked_second_load_all.json",
  "outputPart": "all"
}
```

The selected request was not a completed HTTP exchange. It was an XHR/Fetch
request paused at an XHR breakpoint before the request could finish. Exporting
response-oriented data for that request caused the tool to wait for data that
could not become available until execution resumed.

This is not only a single missing timeout. The deeper issue is that the current
tool surface does not clearly distinguish three different states:

1. A completed request with response data.
2. A pending request that has been issued but has no response yet.
3. A request paused at a breakpoint before or during send, where waiting for a
   response is structurally wrong.

When these states are not explicit, the model naturally chooses `outputPart:
"all"` as a "save everything" operation, even though "everything" is not
available.

## What Happened

The workflow was:

1. Clear site state.
2. Set an XHR breakpoint.
3. Reload the page.
4. Let the first Akamai sensor request pass.
5. Stop at the second sensor request.
6. Export `document.cookie` and browser state.
7. Attempt to export the stopped request with `outputPart: "all"`.

At step 7, the request was visible in `list_network_requests` as:

```text
reqid=138 ... [xhr] POST ... [pending]
```

The model treated `reqid=138` as a normal request artifact and attempted to
export a full snapshot. That was the wrong operation for this state.

For this workflow, the useful material was:

- `document.cookie`
- user agent
- current page URL / ready state
- loaded sensor script source
- Akamai endpoint URL

The pending request's response headers, response body, status code, final
sizes, and Set-Cookie data were not available and should not have been requested.

## Root Cause

### 1. Tool semantics allowed an invalid mental model

`list_network_requests` currently exposes one primitive for several different
jobs:

- list request indexes
- inspect one request
- export request body
- export response body
- export response headers
- export a JSON bundle with `outputPart: "all"`

The name `all` implies completeness. For a pending request, that implication is
false.

From an agent's perspective, "I need to preserve material" plus a visible
`reqid` plus an `outputPart: "all"` option strongly suggests exporting that
request. The tool description does not make the pending-state boundary strong
enough.

### 2. Pending-state guidance was missing from list output

The list output showed `[pending]`, but it did not say what actions are valid
or invalid for a pending request.

The model needed a direct instruction at the point of decision:

```text
pending: response unavailable. Use requestBody/queryParams only if needed, or
use paused-frame evaluation to inspect in-flight variables. Do not export
responseBody, responseHeaders, or all for completed response data until the
request finishes.
```

Without this guidance, the model had to infer behavior from a terse status
label. That is not reliable enough for an agent-facing tool.

### 3. Some code paths waited without a hard upper bound

The network list path was already fixed to avoid waiting on pending requests.
However, other paths still contain potentially unbounded or overly long waits:

- request detail rendering can call `request.response()`
- network export can call `request.response()`
- full network snapshot can call `request.response()`
- response export can call `response.body()`
- script source saving can wait on CDP calls
- any tool can hold the global tool mutex while it waits

Because tool execution is serialized by a global mutex, one hung tool blocks
subsequent tools. The user then sees unrelated later calls as "stuck", even if
those later calls are not themselves the root cause.

### 4. The tool did not actively reject invalid response export

For `outputPart: "responseHeaders"` and `outputPart: "responseBody"`, a pending
request should be an immediate, explicit error:

```text
Request is still pending; response data is not available. Resume first, or
export requestBody/queryParams if you only need request-side data.
```

Waiting for a response in this state is not helpful. It teaches the model the
wrong workflow and risks deadlocking the tool queue.

### 5. Paused breakpoint workflows need explicit operating rules

When execution is paused at an XHR breakpoint, there are two different valid
workflows:

1. Capture pre-send material:
   - read cookies / UA / loaded scripts / endpoint
   - inspect call-frame variables if the request body is needed
   - do not export response data

2. Capture completed network data:
   - resume execution
   - wait for the request to complete
   - then export response headers/body or a completed snapshot

The tool surface did not make this distinction obvious.

## First-Principles Design Requirements

### Requirement 1: tools must not wait forever

Every tool call must have a maximum execution boundary. A specific operation
may still fail or time out, but it must return control to the user.

This matters more in this project than in a normal CLI because one hung MCP
tool holds the global tool mutex and blocks every later MCP call.

Recommended policy:

- Default tool-level timeout: 20 seconds.
- Keep shorter existing operation-specific timeouts where they make sense.
- Return a structured tool error on timeout, with the next safe action.
- Do not rely only on Playwright or CDP defaults; wrap tool handlers at the MCP
  boundary.

### Requirement 2: pending request output must be action-oriented

List output should not only show `[pending]`. It should guide the model toward
valid next actions.

Recommended list marker:

```text
[pending: response unavailable; use requestBody/queryParams or paused-frame
evaluation, not responseBody/responseHeaders/all]
```

The wording can be shorter in final output, but it must be explicit enough that
an agent does not choose response export while paused.

### Requirement 3: response exports must reject pending requests immediately

For pending requests:

- `outputPart: "responseHeaders"` must return immediately with a clear error.
- `outputPart: "responseBody"` must return immediately with a clear error.

These modes are response-side operations. If there is no response yet, waiting
is usually the wrong behavior, especially when paused at a breakpoint.

### Requirement 4: `outputPart: "all"` must not imply waiting for completion

`all` should not wait for unavailable response data. It has two acceptable
behaviors:

1. Reject pending requests and tell the model to resume or export request-side
   data only.
2. Export a partial current-state snapshot with explicit pending metadata.

For the current product direction, the safer choice is rejection. It prevents
the model from believing it has a complete network artifact when it does not.

Recommended error:

```text
Request is pending, so outputPart="all" cannot produce a complete network
snapshot. Do not wait for response data while paused. Use outputPart="requestBody"
or "queryParams", or inspect paused call-frame variables. Resume the request
before exporting response data.
```

### Requirement 5: avoid new variants unless the primitive is unclear

Adding a new `requestSnapshot` output mode is probably unnecessary right now.
The existing primitive is enough if the states are enforced:

- `requestBody` means request body only.
- `queryParams` means parsed query only.
- `responseHeaders` means completed response headers only.
- `responseBody` means completed response body only.
- `all` means complete network snapshot only, not "wait until complete".

The first-principles fix is to make invalid states impossible or explicit, not
to add more tool variants.

### Requirement 6: paused XHR breakpoint guidance must be built into tools

When the debugger is paused for XHR/Fetch and a network request is pending,
tool output should teach the correct workflow:

```text
Execution is paused at an XHR/Fetch breakpoint. If you need the in-flight
request body, inspect the paused call frame with get_paused_info or
evaluate_script(frameIndex=...). If you need response headers/body, resume first.
For cookie/UA/script material, export document.cookie, navigator.userAgent, and
script source instead of exporting the pending request.
```

This is not just documentation. The guidance must appear in the tool output or
error path where the model made the wrong choice.

## Concrete Failure Mode to Prevent

Bad behavior:

```text
list_network_requests(reqid=138, outputPart="all", outputFile="...")
```

where request 138 is pending and execution is paused at an XHR breakpoint.

The tool waits on `request.response()`, holding the global tool mutex. A later
call such as `save_script_source` appears to hang because it cannot acquire the
mutex.

Required behavior:

```text
Request 138 is pending; outputPart="all" requires a completed response and will
not wait. Use requestBody/queryParams or inspect paused call-frame variables.
Resume first if you need response data.
```

The tool must return immediately.

## Related Failure: Navigation Pause Still Waits

A separate but related failure exists in `navigate_page({type:"reload"})`.

The intended behavior is:

1. Start reload.
2. If navigation reaches `domcontentloaded`, return success.
3. If execution pauses at a breakpoint before navigation completes, return the
   paused status immediately.
4. Do not wait for the full navigation timeout in the paused case.

The current local code partially implements this with
`waitForNavigationOrPause()`, but the implementation is incomplete.

### What the code currently does

In `src/tools/pages.ts`, `reload` calls:

```ts
const result = await waitForNavigationOrPause(
  page.reload({
    ...options,
    waitUntil: 'domcontentloaded',
  }),
  debugger_,
);
```

If `result.status === "paused"`, the tool appends the correct message:

```text
Page reload started but execution is paused at a breakpoint. Use
get_paused_info to inspect, then resume to continue loading.
```

However, after the switch block, the handler still executes:

```ts
if (debugger_.isEnabled()) {
  await debugger_.restoreXHRBreakpoints();
}
```

`restoreXHRBreakpoints()` sends CDP commands:

```ts
await this.#client.send('DOMDebugger.setXHRBreakpoint', {url});
```

If execution is paused and navigation has not completed, this post-navigation
restore step can itself wait or hang. The user then still experiences
`navigate_page` as not returning immediately, even though the pause was already
detected.

### Root cause

The code treats "paused during navigation" as a normal post-navigation state.
That is incorrect.

When navigation pauses at a breakpoint, navigation is not complete. Running
post-navigation cleanup or restoration synchronously defeats the purpose of
fast paused return.

### Required navigation behavior

For `navigate_page`:

- If navigation completes, restore XHR breakpoints synchronously as before.
- If navigation fails normally, return the failure as before.
- If navigation pauses, append the paused guidance and return immediately.
- Do not run `restoreXHRBreakpoints()` in the paused path.

The restore can happen later when the user resumes and navigation completes, or
as a best-effort operation with a short timeout only after completion.

### Secondary race: stale paused state after resume

There is also a smaller race before navigation:

```ts
if (debugger_.isEnabled() && debugger_.isPaused()) {
  await debugger_.resume();
}
```

`Debugger.resume` is sent, but the local paused state is cleared only when the
`Debugger.resumed` event arrives. If the handler continues before that event is
processed, `waitForNavigationOrPause()` may see stale `isPaused() === true` and
return `paused` too early.

This race is less likely to cause a hang, but it can cause incorrect paused
reporting.

Required behavior:

- After `resume()`, wait briefly for the resumed state, or clear local paused
  state synchronously after a successful `Debugger.resume`.
- Keep a timeout so resume state synchronization cannot hang.

### Navigation fix direction

Minimal safe fix:

1. Track whether the navigation result was `paused`.
2. If paused, append the paused message, set page list output, and return from
   the handler before `restoreXHRBreakpoints()`.
3. Only call `restoreXHRBreakpoints()` when navigation result is `completed`.
4. Wrap `restoreXHRBreakpoints()` in a short timeout or make it fire-and-forget
   with logged errors, because it is not important enough to block user control.
5. Add tests that assert a paused navigation path does not call the restore
   function.

## Implementation Direction

Recommended minimal implementation, in order:

1. Add a reusable tool-level timeout wrapper around every registered MCP tool
   call in `src/main.ts`.
2. Add pending-state detection helper for network requests based on failure and
   `request.timing().responseEnd`.
3. Update `list_network_requests` list formatting so pending rows include
   next-action guidance.
4. Update `exportNetworkRequestPart`:
   - `responseHeaders`: reject pending immediately.
   - `responseBody`: reject pending immediately.
   - `all`: reject pending immediately with guidance.
   - `requestBody` and `queryParams`: continue to work for pending requests.
5. Update request detail rendering so inspecting a pending `reqid` shows
   request-side data and pending guidance without waiting for response data.
6. Update `navigate_page` paused paths so post-navigation restoration is skipped
   and the tool returns immediately.
7. Add tests for:
   - pending request list row guidance.
   - pending `responseHeaders` rejection.
   - pending `responseBody` rejection.
   - pending `all` rejection.
   - paused navigation does not call `restoreXHRBreakpoints()`.
   - tool-level timeout releases the mutex and returns an error.

## Non-Goals

- Do not add a new tool for every export variant.
- Do not make `all` mean "wait until the request completes".
- Do not hide pending requests from list output.
- Do not silently produce response fields for data that does not exist.
- Do not rely on the model to remember a convention that the tool can enforce.

## Expected Agent Behavior After Fix

For paused XHR breakpoint workflows, the model should do this:

1. Use `list_network_requests` only to identify completed vs pending requests.
2. If the target request is pending:
   - do not export `all`, `responseHeaders`, or `responseBody`.
   - export `document.cookie`, user agent, script source, and endpoint if that
     is the task.
   - use paused-frame inspection for in-flight request body if needed.
3. If response data is needed:
   - resume execution.
   - wait until the request completes.
   - then export response data.

This keeps the workflow correct, reduces accidental traffic, and prevents
tool-level hangs.
