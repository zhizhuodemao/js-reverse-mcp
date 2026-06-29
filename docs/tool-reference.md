<!-- AUTO GENERATED DO NOT EDIT - run 'npm run docs' to update-->

# Chrome DevTools MCP Tool Reference

- **[Navigation automation](#navigation-automation)** (3 tools)
  - [`navigate_page`](#navigate_page)
  - [`new_page`](#new_page)
  - [`select_page`](#select_page)
- **[Browser state](#browser-state)** (1 tools)
  - [`clear_site_data`](#clear_site_data)
- **[Network](#network)** (3 tools)
  - [`clear_network_requests`](#clear_network_requests)
  - [`get_websocket_messages`](#get_websocket_messages)
  - [`list_network_requests`](#list_network_requests)
- **[Debugging](#debugging)** (4 tools)
  - [`evaluate_script`](#evaluate_script)
  - [`list_console_messages`](#list_console_messages)
  - [`select_frame`](#select_frame)
  - [`take_screenshot`](#take_screenshot)
- **[JS Reverse Engineering](#js-reverse-engineering)** (12 tools)
  - [`break_on_xhr`](#break_on_xhr)
  - [`get_paused_info`](#get_paused_info)
  - [`get_request_initiator`](#get_request_initiator)
  - [`get_script_source`](#get_script_source)
  - [`list_breakpoints`](#list_breakpoints)
  - [`list_scripts`](#list_scripts)
  - [`pause_or_resume`](#pause_or_resume)
  - [`remove_breakpoint`](#remove_breakpoint)
  - [`save_script_source`](#save_script_source)
  - [`search_in_sources`](#search_in_sources)
  - [`set_breakpoint_on_text`](#set_breakpoint_on_text)
  - [`step`](#step)

## Navigation automation

### `navigate_page`

**Description:** Navigates the currently selected page to a URL, or performs back/forward/reload navigation. This tool only navigates; it does not clear cookies, storage, cache, or site data. Waits for DOMContentLoaded event (not full page load). Default timeout is 10 seconds. After navigation, stale script IDs are cleared and fresh ones are captured automatically when the debugger is enabled. Tracked code URL breakpoints and XHR/Fetch breakpoints are restored across navigation when possible.

**Parameters:**

- **timeout** (integer) _(optional)_: Maximum wait time in milliseconds. If set to 0, the default timeout will be used.
- **type** (enum: "url", "back", "forward", "reload") _(optional)_: Navigate the page by URL, back or forward in history, or reload.
- **url** (string) _(optional)_: Target URL (only type=url)

---

### `new_page`

**Description:** Opens a browser page and navigates to the specified URL. If an existing about:blank startup tab is still available, it is reused instead of opening an extra tab. Waits for DOMContentLoaded event (not full page load). Default timeout is 10 seconds.

**Parameters:**

- **timeout** (integer) _(optional)_: Maximum wait time in milliseconds. If set to 0, the default timeout will be used.
- **url** (string) **(required)**: URL to load in the opened browser page.

---

### `select_page`

**Description:** Lists all open pages in the browser. Pass pageIdx to select a page as context for future tool calls.

**Parameters:**

- **pageIdx** (number) _(optional)_: The index of the page to select. If omitted, lists all pages without changing selection.

---

## Browser state

### `clear_site_data`

**Description:** Clear browser state to create a clean replay environment for the currently selected page. This clears cookies that affect the current page's HTTP(S) frame URLs, clears browser HTTP cache, clears persistent storage for the current page's HTTP(S) frame origins, and clears sessionStorage in current page HTTP(S) frames. This tool does not reload the page. Cookie cleanup is scoped by cookie domain/path matching for the current page frames, not by all cookies in the browser context.

**Parameters:** None

---

## Network

### `clear_network_requests`

**Description:** Clear all collected network requests for the currently selected page, to establish a clean baseline before the action you want to study (the DevTools "clear, then act" workflow). This drops the in-memory request queue, releases the cached response-body byte budget, and clears the request initiator (call stack) maps for the page. It does not touch the browser, cookies, HTTP cache, storage, console, WebSocket messages, or any other page — use [`clear_site_data`](#clear_site_data) for browser state. reqids are not reused after clearing; newly collected requests continue from the previous high-water mark.

**Parameters:** None

---

### `get_websocket_messages`

**Description:** Lists WebSocket connections or gets messages for a specific connection. Without wsid, lists all connections. With wsid, gets messages. Set analyze=true to group messages by pattern. Use groupId to filter by group. Use frameIndex to get a single message's full detail by the raw frame index shown in message tables and analysis samples.

**Parameters:**

- **analyze** (boolean) _(optional)_: Set to true to analyze and group messages by pattern/fingerprint. Returns statistics and sample indices for each message type.
- **direction** (enum: "sent", "received") _(optional)_: Filter by direction: "sent" or "received".
- **frameIndex** (integer) _(optional)_: Get a single message by its raw frame index (0-based). Use the Idx values shown by message tables or the sample indices returned by analyze=true.
- **groupId** (string) _(optional)_: Filter by group ID (A, B, C, ...). Run with analyze=true first to get group IDs; if analyze used a direction filter, pass the same direction here.
- **includePreservedConnections** (boolean) _(optional)_: Set to true to return the preserved connections over the last 3 navigations (only for listing connections without wsid).
- **pageIdx** (integer) _(optional)_: Page number (0-based).
- **pageSize** (integer) _(optional)_: Messages per page (for messages mode) or connections per page (for list mode). Defaults to 10.
- **show_content** (boolean) _(optional)_: Set to true to show full message payload. Default false (summary only) to avoid large binary output.
- **urlFilter** (string) _(optional)_: Filter connections by URL (only for listing connections without wsid).
- **wsid** (number) _(optional)_: The wsid of the WebSocket connection. If omitted, lists all connections.

---

### `list_network_requests`

**Description:** List network requests for the currently selected page. Requests are held in a flat FIFO queue that is not cleared on navigation, so a request that already fired (e.g. a login POST that caused a redirect, or a pre-redirect beacon) stays inspectable after the page moves on; the queue keeps the most recent 5000 requests and the oldest roll off. To establish a clean baseline before the action you want to study (the DevTools "clear, then act" workflow), call [`clear_network_requests`](#clear_network_requests) first. Results are sorted newest-first and include request start time plus duration. By default returns the 20 most recent requests; use pageSize/pageIdx to paginate. Narrow the list with filters: methods (HTTP verb, e.g. ["POST"] to find form/credential/signature submissions), resourceTypes (resource category such as xhr/fetch/document — NOT the HTTP verb), and urlFilter (URL substring). Filters combine with AND; multiple values within one filter combine with OR. List output is an index: it shows status, summarized long URLs, and Set-Cookie names, not header/body contents. Pass reqid to inspect one request with timing, bounded inline headers where sensitive values such as Cookie, Authorization, and token-like headers are redacted, content-type-aware body previews, and a dedicated Set-Cookie section that shows raw values up to 1KB total. When exact bytes, full bodies, replay inputs, signature inputs, large request bodies, long GET query payloads, binary responses, full headers, full Set-Cookie values, or data for external decoding are needed, pass reqid with outputFile to export the selected data. For GET requests, payload-like data means parsed URL query parameters.

**Parameters:**

- **methods** (array) _(optional)_: Filter requests by HTTP method (the request verb). Matched case-insensitively. Pass one or more of GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS; multiple values are OR-ed (e.g. ["POST"] shows only POSTs, ["GET","POST"] shows both). Use this to hunt for submissions (POST/PUT/PATCH) versus reads (GET). This is the HTTP verb, distinct from resourceTypes which filters by resource category (xhr, document, ...). When omitted or empty, methods are not filtered.
- **outputFile** (string) _(optional)_: When reqid is provided, save network data to this local file instead of returning only inline text. Use this for exact bytes, large bodies, long GET query payloads, binary responses, replay/signature inputs, or data that will be decoded with external tools. Absolute paths and paths relative to the current working directory are supported. The response reports the resolved absolute path; use that path with [`evaluate_script`](#evaluate_script) localFilePath when browser-side processing is needed.
- **outputPart** (enum: "all", "responseHeaders", "responseBody", "requestBody", "queryParams") _(optional)_: Which part to export when outputFile is provided. "responseHeaders" saves response headers as JSON while preserving repeated headers such as Set-Cookie, "responseBody" saves raw response bytes, "requestBody" saves captured request body bytes, "queryParams" saves parsed URL query parameters as JSON, and "all" saves a JSON bundle with metadata, headers, query params, and body content/metadata. Defaults to "all".
- **pageIdx** (integer) _(optional)_: Page number to return (0-based). When omitted, returns the first page.
- **pageSize** (integer) _(optional)_: Maximum number of requests to return. Defaults to 20.
- **reqid** (number) _(optional)_: The reqid of a specific network request to get full details for. If omitted, lists all requests.
- **resourceTypes** (array) _(optional)_: Filter requests to only return requests of the specified resource types (xhr, fetch, document, script, ...). This is the resource category, NOT the HTTP verb — use methods for GET/POST filtering. When omitted or empty, returns all requests.
- **urlFilter** (string) _(optional)_: Filter requests by URL. Only requests containing this substring will be returned.

---

## Debugging

### `evaluate_script`

**Description:** Evaluate a JavaScript function inside the currently selected page. Returns the response as JSON
so returned values have to JSON-serializable. Inline JSON results are bounded; use outputFile for exact large results. When execution is paused at a breakpoint, automatically evaluates in the paused call frame context. Use localFilePath when the function needs one local data file, commonly a network body or JSON exported by another tool. The MCP server reads the file and passes it as localFile; browser JavaScript does not read local paths.

**Parameters:**

- **frameIndex** (integer) _(optional)_: When paused at a breakpoint, which call frame to evaluate in (0 = top frame). If omitted, uses the top frame. Use [`get_paused_info`](#get_paused_info) to see available frames.
- **function** (string) **(required)**: A JavaScript function declaration to be executed by the tool in the currently selected page.
  Example without arguments: `() => {
  return document.title
}` or `async () => {
  return await fetch("example.com")
}`.
  If localFilePath is provided, the function receives one argument: `async ({ localFile }) => { ... }`. Use localFile.text when present for UTF-8 text/JSON and localFile.base64 for exact bytes. To keep data for later calls, assign it explicitly in JavaScript, for example `window.__mcpPayload = JSON.parse(localFile.text)` with mainWorld=true.

- **localFilePath** (string) _(optional)_: Absolute path to one local file to pass to the evaluated function as localFile. Relative paths, file:// URLs, globs, ~, and directories are rejected. If provided, write the function as async ({ localFile }) => { ... }. Use localFile.text when present for UTF-8 text/JSON and localFile.base64 for exact bytes.
- **mainWorld** (boolean) _(optional)_: Execute the function in the page main world instead of the default isolated context. Use this when you need to access page-defined globals (e.g. window.bdms, window.app). Async functions are supported, and returned values must be JSON-serializable unless outputFile is used for binary data.
- **outputFile** (string) _(optional)_: If provided, saves the evaluation result to this local file path instead of returning it in the chat. JSON-serializable results are saved as JSON text; ArrayBuffer and Uint8Array results are saved as raw bytes. Useful for dumping large data or binary memory regions. The response reports the resolved absolute path.

---

### `list_console_messages`

**Description:** List all console messages for the currently selected page since the last navigation. Pass msgid to get a single message by its ID.

**Parameters:**

- **includePreservedMessages** (boolean) _(optional)_: Set to true to return the preserved messages over the last 3 navigations.
- **msgid** (number) _(optional)_: The msgid of a console message on the page from the listed console messages
- **pageIdx** (integer) _(optional)_: Page number to return (0-based). When omitted, returns the first page.
- **pageSize** (integer) _(optional)_: Maximum number of messages to return. When omitted, returns all messages.
- **types** (array) _(optional)_: Filter messages to only return messages of the specified console message types. When omitted or empty, returns all messages.

---

### `select_frame`

**Description:** Lists all frames (including iframes) in the current page. Pass frameIdx to switch the execution context used by [`evaluate_script`](#evaluate_script). Other tools may still operate at page level.

**Parameters:**

- **frameIdx** (integer) _(optional)_: The frame index to select. 0 = main frame. If omitted, lists all frames without changing selection.

---

### `take_screenshot`

**Description:** Take a screenshot of the currently selected page. By default captures the visible viewport; set fullPage=true to capture the full page.

**Parameters:**

- **filePath** (string) _(optional)_: The absolute path, or a path relative to the current working directory, to save the screenshot to instead of attaching it to the response.
- **format** (enum: "png", "jpeg") _(optional)_: Type of format to save the screenshot as. Default is "png"
- **fullPage** (boolean) _(optional)_: If set to true, captures the full page instead of the currently visible viewport.
- **quality** (number) _(optional)_: Compression quality for JPEG format (0-100). Higher values mean better quality but larger file sizes. Ignored for PNG format.

---

## JS Reverse Engineering

### `break_on_xhr`

**Description:** Sets a breakpoint that triggers when an XHR/Fetch request URL contains the specified string.

**Parameters:**

- **url** (string) **(required)**: URL pattern to break on (partial match).

---

### `get_paused_info`

**Description:** Gets information about the current paused state including call stack, current location, and scope variables. Use this after a breakpoint is hit to understand the execution context.

**Parameters:**

- **frameIndex** (integer) _(optional)_: Which call frame to inspect scope variables for (0 = top frame). Use the call stack indices to pick a frame.
- **includeScopes** (boolean) _(optional)_: Whether to include scope variables (default: true).
- **maxScopeDepth** (integer) _(optional)_: Maximum scope depth to traverse (default: 2). 1 = local scope only (function args &amp; local vars), 2 = local + closure scopes, 3+ = all non-global scopes.

---

### `get_request_initiator`

**Description:** Gets the JavaScript call stack that initiated a network request. This helps trace which code triggered an API call.

**Parameters:**

- **requestId** (integer) **(required)**: The request ID (from [`list_network_requests`](#list_network_requests)) to get the initiator for.

---

### `get_script_source`

**Description:** Gets a small snippet of a JavaScript script source by URL (recommended) or script ID. Supports line range (for normal files) or character offset (for minified single-line files). Prefer using url over scriptId — URLs remain stable across page navigations while script IDs become invalid after reload. This tool is designed for reading small code regions (e.g. around breakpoints or search results); specify startLine/endLine or offset/length for predictable inline output. If no range is provided, small sources are returned inline and large sources return a preview with guidance. To read an entire script file, especially a minified one, use [`save_script_source`](#save_script_source) instead. WASM scripts cannot be shown inline; use [`save_script_source`](#save_script_source) with a .wasm file path.

**Parameters:**

- **endLine** (integer) _(optional)_: End line number (1-based). Use for multi-line files.
- **length** (integer) _(optional)_: Number of characters to return when using offset (default: 1000).
- **offset** (integer) _(optional)_: Character offset to start from (0-based). Use for minified single-line files.
- **scriptId** (string) _(optional)_: Script ID (from [`list_scripts`](#list_scripts)). Becomes invalid after page navigation — prefer url instead.
- **startLine** (integer) _(optional)_: Start line number (1-based). Use for multi-line files.
- **url** (string) _(optional)_: Script URL (preferred). Stable across page navigations. Exact match first, then substring match.

---

### `list_breakpoints`

**Description:** Lists active code breakpoints and XHR/Fetch URL breakpoints in the current debugging session. Breakpoints are tracked by this MCP session and restored after reload/goto/back/forward when possible.

**Parameters:** None

---

### `list_scripts`

**Description:** Lists all JavaScript scripts loaded in the current page. Returns script ID, URL, and source map information. Use this to find scripts before setting breakpoints or searching. Script IDs are valid for the current page load only; after navigation, call [`list_scripts`](#list_scripts) again or prefer script URLs for follow-up tools.

**Parameters:**

- **filter** (string) _(optional)_: Optional filter string to match against script URLs (case-insensitive partial match).

---

### `pause_or_resume`

**Description:** Toggles JavaScript execution. If paused, resumes execution. If running, requests a pause at the next JavaScript statement.

**Parameters:** None

---

### `remove_breakpoint`

**Description:** Removes breakpoints. Pass breakpointId to remove a code breakpoint, url to remove an XHR breakpoint, or neither to remove ALL breakpoints (code + XHR).

**Parameters:**

- **breakpointId** (string) _(optional)_: The breakpoint ID to remove (from [`list_breakpoints`](#list_breakpoints) or [`set_breakpoint_on_text`](#set_breakpoint_on_text)).
- **url** (string) _(optional)_: The XHR breakpoint URL pattern to remove.

---

### `save_script_source`

**Description:** Saves the full source code of a JavaScript script to a local file. PREFERRED over [`get_script_source`](#get_script_source) whenever you need the whole file or want to search/read a minified script. This tool auto-formats (beautifies) minified .js/.mjs/.ts output via prettier so the saved file is human-readable. Use this for any non-trivial source inspection; only fall back to [`get_script_source`](#get_script_source) for tiny known regions (e.g. ±20 lines around a breakpoint). Typical workflow: call [`save_script_source`](#save_script_source), then inspect the saved local file with your available file-reading or search tools. NOTE: because the saved file may be beautified, its line numbers may not match the original script. If you later need to set a breakpoint, use the original URL/scriptId with [`set_breakpoint_on_text`](#set_breakpoint_on_text) rather than line numbers from the saved file.

**Parameters:**

- **filePath** (string) **(required)**: Local file path to save the script source to. Absolute paths and paths relative to the current working directory are supported. Use a .js/.mjs/.cjs/.jsx/.ts/.tsx extension to enable auto-format (prettier beautify); other extensions save raw source verbatim. For WASM scripts, use a .wasm extension.
- **format** (boolean) _(optional)_: Auto-format JavaScript/TypeScript output with prettier (beautifies minified code). Defaults to true. Set to false to save the raw original source verbatim.
- **scriptId** (string) _(optional)_: Script ID (from [`list_scripts`](#list_scripts)). Becomes invalid after page navigation — prefer url instead.
- **url** (string) _(optional)_: Script URL (preferred). Stable across page navigations. Exact match first, then substring match.

---

### `search_in_sources`

**Description:** Searches for a string or regex pattern in all loaded JavaScript sources. Returns matching lines with script ID, URL, and line number. Use [`get_script_source`](#get_script_source) with startLine/endLine to view full context around matches.

**Parameters:**

- **caseSensitive** (boolean) _(optional)_: Whether the search should be case-sensitive.
- **excludeMinified** (boolean) _(optional)_: Skip minified files (files with very long lines). Default: true.
- **isRegex** (boolean) _(optional)_: Whether to treat the query as a regular expression.
- **maxLineLength** (integer) _(optional)_: Maximum characters per matched line preview (default: 150). Increase if you need more context around the match.
- **maxResults** (integer) _(optional)_: Maximum number of results to return (default: 30).
- **query** (string) **(required)**: The search query (string or regex pattern).
- **urlFilter** (string) _(optional)_: Only search scripts whose URL contains this string (case-insensitive).

---

### `set_breakpoint_on_text`

**Description:** Sets a breakpoint on specific code (function name, statement, etc.) by searching loaded scripts and automatically determining a position. Optionally pass condition to reduce noisy hits after the code location is already precise; prefer text/urlFilter/occurrence for locating the breakpoint, and use condition only as a simple synchronous guard. Works with both normal and minified URL-backed scripts. Inline/eval scripts without a URL can be found but cannot receive this persistent URL breakpoint. Breakpoints persist across page navigations when the URL can be matched again.

**Parameters:**

- **condition** (string) _(optional)_: Optional synchronous JavaScript condition evaluated in the breakpoint call frame. Use only as a simple guard after choosing a precise code location; avoid complex logic, async work, or side effects. The breakpoint pauses only when this expression evaluates to true.
- **occurrence** (integer) _(optional)_: Which occurrence to break on (1 = first, 2 = second, etc.).
- **text** (string) **(required)**: The code text to find and set breakpoint on (e.g., "function myFunc", "fetchData(", "apiCall").
- **urlFilter** (string) _(optional)_: Only search in scripts whose URL contains this string (case-insensitive).

---

### `step`

**Description:** Steps JavaScript execution. Use direction "over" to skip function calls, "into" to enter function bodies, "out" to exit the current function. Returns the new location with source context.

**Parameters:**

- **direction** (enum: "over", "into", "out") **(required)**: [`Step`](#step) direction: "over" (next statement), "into" (enter function), "out" (exit function).

---
