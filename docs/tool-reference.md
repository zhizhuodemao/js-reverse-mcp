<!-- AUTO GENERATED DO NOT EDIT - run 'npm run docs' to update-->

# Chrome DevTools MCP Tool Reference

- **[Navigation automation](#navigation-automation)** (3 tools)
  - [`navigate_page`](#navigate_page)
  - [`new_page`](#new_page)
  - [`select_page`](#select_page)
- **[Network](#network)** (2 tools)
  - [`get_websocket_messages`](#get_websocket_messages)
  - [`list_network_requests`](#list_network_requests)
- **[Debugging](#debugging)** (4 tools)
  - [`evaluate_script`](#evaluate_script)
  - [`list_console_messages`](#list_console_messages)
  - [`select_frame`](#select_frame)
  - [`take_screenshot`](#take_screenshot)
- **[JS Reverse Engineering](#js-reverse-engineering)** (14 tools)
  - [`break_on_xhr`](#break_on_xhr)
  - [`get_paused_info`](#get_paused_info)
  - [`get_request_initiator`](#get_request_initiator)
  - [`get_script_source`](#get_script_source)
  - [`inject_before_load`](#inject_before_load)
  - [`list_breakpoints`](#list_breakpoints)
  - [`list_scripts`](#list_scripts)
  - [`pause_or_resume`](#pause_or_resume)
  - [`remove_breakpoint`](#remove_breakpoint)
  - [`save_script_source`](#save_script_source)
  - [`search_in_sources`](#search_in_sources)
  - [`set_breakpoint_on_text`](#set_breakpoint_on_text)
  - [`step`](#step)
  - [`trace_function`](#trace_function)

## Navigation automation

### `navigate_page`

**Description:** Navigates the currently selected page to a URL, or performs back/forward/reload navigation. Waits for DOMContentLoaded event (not full page load). Default timeout is 10 seconds. After navigation, stale script IDs are cleared and fresh ones are captured automatically. All breakpoints (URL, XHR, DOM) are preserved across navigation.

**Parameters:**

- **ignoreCache** (boolean) _(optional)_: Whether to ignore cache on reload.
- **timeout** (integer) _(optional)_: Maximum wait time in milliseconds. If set to 0, the default timeout will be used.
- **type** (enum: "url", "back", "forward", "reload") _(optional)_: Navigate the page by URL, back or forward in history, or reload.
- **url** (string) _(optional)_: Target URL (only type=url)

---

### `new_page`

**Description:** Creates a new page and navigates to the specified URL. Waits for DOMContentLoaded event (not full page load). Default timeout is 10 seconds.

**Parameters:**

- **timeout** (integer) _(optional)_: Maximum wait time in milliseconds. If set to 0, the default timeout will be used.
- **url** (string) **(required)**: URL to load in a new page.

---

### `select_page`

**Description:** Lists all open pages in the browser. Pass pageIdx to select a page as context for future tool calls.

**Parameters:**

- **pageIdx** (number) _(optional)_: The index of the page to select. If omitted, lists all pages without changing selection.

---

## Network

### `get_websocket_messages`

**Description:** Lists WebSocket connections or gets messages for a specific connection. Without wsid, lists all connections. With wsid, gets messages. Set analyze=true to group messages by pattern. Use groupId to filter by group. Use frameIndex to get a single message's full detail.

**Parameters:**

- **analyze** (boolean) _(optional)_: Set to true to analyze and group messages by pattern/fingerprint. Returns statistics and sample indices for each message type.
- **direction** (enum: "sent", "received") _(optional)_: Filter by direction: "sent" or "received".
- **frameIndex** (integer) _(optional)_: Get a single message by its frame index (0-based). Returns full detail for that message.
- **groupId** (string) _(optional)_: Filter by group ID (A, B, C, ...). Run with analyze=true first to get group IDs.
- **includePreservedConnections** (boolean) _(optional)_: Set to true to return the preserved connections over the last 3 navigations (only for listing connections without wsid).
- **pageIdx** (integer) _(optional)_: Page number (0-based).
- **pageSize** (integer) _(optional)_: Messages per page (for messages mode) or connections per page (for list mode). Defaults to 10.
- **show_content** (boolean) _(optional)_: Set to true to show full message payload. Default false (summary only) to avoid large binary output.
- **urlFilter** (string) _(optional)_: Filter connections by URL (only for listing connections without wsid).
- **wsid** (number) _(optional)_: The wsid of the WebSocket connection. If omitted, lists all connections.

---

### `list_network_requests`

**Description:** List network requests for the currently selected page since the last navigation. Results are sorted newest-first. By default returns the 20 most recent requests; use pageSize/pageIdx to paginate. Pass reqid to get a single request's full details.

**Parameters:**

- **includePreservedRequests** (boolean) _(optional)_: Set to true to return the preserved requests over the last 3 navigations.
- **pageIdx** (integer) _(optional)_: Page number to return (0-based). When omitted, returns the first page.
- **pageSize** (integer) _(optional)_: Maximum number of requests to return. Defaults to 20.
- **reqid** (number) _(optional)_: The reqid of a specific network request to get full details for. If omitted, lists all requests.
- **resourceTypes** (array) _(optional)_: Filter requests to only return requests of the specified resource types. When omitted or empty, returns all requests.
- **urlFilter** (string) _(optional)_: Filter requests by URL. Only requests containing this substring will be returned.

---

## Debugging

### `evaluate_script`

**Description:** Evaluate a JavaScript function inside the currently selected page. Returns the response as JSON
so returned values have to JSON-serializable. When execution is paused at a breakpoint, automatically evaluates in the paused call frame context.

**Parameters:**

- **function** (string) **(required)**: A JavaScript function declaration to be executed by the tool in the currently selected page.
  Example without arguments: `() => {
  return document.title
}` or `async () => {
  return await fetch("example.com")
}`.
  Example with arguments: `(el) => {
  return el.innerText;
}`

- **mainWorld** (boolean) _(optional)_: Execute the function in the page main world instead of the default isolated context. Use this when you need to access page-defined globals (e.g. window.bdms, window.app). The function must be synchronous and return a JSON-serializable value.

---

### `list_console_messages`

**Description:** List all console messages for the currently selected page since the last navigation. Pass msgid to get a single message by its ID.

**Parameters:**

- **includePreservedMessages** (boolean) _(optional)_: Set to true to return the preserved messages over the last 3 navigations.
- **msgid** (number) _(optional)_: The msgid of a console message on the page from the listed console messages
- **pageIdx** (integer) _(optional)_: Page number to return (0-based). When omitted, returns the first page.
- **pageSize** (integer) _(optional)_: Maximum number of messages to return. When omitted, returns all requests.
- **types** (array) _(optional)_: Filter messages to only return messages of the specified resource types. When omitted or empty, returns all messages.

---

### `select_frame`

**Description:** Lists all frames (including iframes) in the current page. Pass frameIdx to switch execution context to that frame for [`evaluate_script`](#evaluate_script) and other tools.

**Parameters:**

- **frameIdx** (integer) _(optional)_: The frame index to select. 0 = main frame. If omitted, lists all frames without changing selection.

---

### `take_screenshot`

**Description:** Take a screenshot of the page or element.

**Parameters:**

- **filePath** (string) _(optional)_: The absolute path, or a path relative to the current working directory, to save the screenshot to instead of attaching it to the response.
- **format** (enum: "png", "jpeg") _(optional)_: Type of format to save the screenshot as. Default is "png"
- **fullPage** (boolean) _(optional)_: If set to true takes a screenshot of the full page instead of the currently visible viewport. Incompatible with uid.
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

- **includeScopes** (boolean) _(optional)_: Whether to include scope variables (default: true).
- **maxScopeDepth** (integer) _(optional)_: Maximum scope depth to traverse (default: 2).

---

### `get_request_initiator`

**Description:** Gets the JavaScript call stack that initiated a network request. This helps trace which code triggered an API call.

**Parameters:**

- **requestId** (integer) **(required)**: The request ID (from [`list_network_requests`](#list_network_requests)) to get the initiator for.

---

### `get_script_source`

**Description:** Gets a small snippet of a JavaScript script source by URL (recommended) or script ID. Supports line range (for normal files) or character offset (for minified single-line files). Prefer using url over scriptId — URLs remain stable across page navigations while script IDs become invalid after reload. IMPORTANT: This tool is designed for reading small code regions (e.g. around breakpoints or search results). You MUST always specify startLine/endLine or offset/length. To read an entire script file, use curl to download it by its URL instead.

**Parameters:**

- **endLine** (integer) _(optional)_: End line number (1-based). Use for multi-line files.
- **length** (integer) _(optional)_: Number of characters to return when using offset (default: 1000).
- **offset** (integer) _(optional)_: Character offset to start from (0-based). Use for minified single-line files.
- **scriptId** (string) _(optional)_: Script ID (from [`list_scripts`](#list_scripts)). Becomes invalid after page navigation — prefer url instead.
- **startLine** (integer) _(optional)_: Start line number (1-based). Use for multi-line files.
- **url** (string) _(optional)_: Script URL (preferred). Stable across page navigations. Exact match first, then substring match.

---

### `inject_before_load`

**Description:** Injects a JavaScript script that runs before any page script on every page load. Pass script to inject, or pass identifier to remove a previously injected script.

**Parameters:**

- **identifier** (string) _(optional)_: The identifier of a previously injected script to remove.
- **script** (string) _(optional)_: JavaScript code to inject. Runs before any page script. Example: Object.defineProperty(window, "h5sign", { set(v) { debugger; this.\_h5sign = v; }, get() { return this.\_h5sign; } })

---

### `list_breakpoints`

**Description:** Lists all active breakpoints in the current debugging session. Breakpoints persist across page navigations and are automatically restored after reload/goto/back/forward.

**Parameters:** None

---

### `list_scripts`

**Description:** Lists all JavaScript scripts loaded in the current page. Returns script ID, URL, and source map information. Use this to find scripts before setting breakpoints or searching. Script IDs are automatically refreshed after page navigation, so listed IDs are always valid.

**Parameters:**

- **filter** (string) _(optional)_: Optional filter string to match against script URLs (case-insensitive partial match).

---

### `pause_or_resume`

**Description:** Toggles JavaScript execution. If paused, resumes execution. If running, pauses execution.

**Parameters:** None

---

### `remove_breakpoint`

**Description:** Removes breakpoints and automatically resumes execution if paused. Pass breakpointId to remove a code breakpoint, url to remove an XHR breakpoint, or neither to remove ALL breakpoints (code + XHR).

**Parameters:**

- **breakpointId** (string) _(optional)_: The breakpoint ID to remove (from [`list_breakpoints`](#list_breakpoints) or [`set_breakpoint_on_text`](#set_breakpoint_on_text)).
- **url** (string) _(optional)_: The XHR breakpoint URL pattern to remove.

---

### `save_script_source`

**Description:** Saves the full source code of a JavaScript script to a local file. Use this to download complete script sources for offline analysis, especially for large or minified files that are too big to view inline with [`get_script_source`](#get_script_source).

**Parameters:**

- **filePath** (string) **(required)**: Local file path to save the script source to.
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

**Description:** Sets a breakpoint on specific code (function name, statement, etc.) by searching for it and automatically determining the exact position. Works with both normal and minified files. Breakpoints persist across page navigations.

**Parameters:**

- **condition** (string) _(optional)_: Optional condition expression. Breakpoint only triggers when this evaluates to true.
- **occurrence** (integer) _(optional)_: Which occurrence to break on (1 = first, 2 = second, etc.).
- **text** (string) **(required)**: The code text to find and set breakpoint on (e.g., "function myFunc", "fetchData(", "apiCall").
- **urlFilter** (string) _(optional)_: Only search in scripts whose URL contains this string (case-insensitive).

---

### `step`

**Description:** Steps JavaScript execution. Use direction "over" to skip function calls, "into" to enter function bodies, "out" to exit the current function. Returns the new location with source context.

**Parameters:**

- **direction** (enum: "over", "into", "out") **(required)**: [`Step`](#step) direction: "over" (next statement), "into" (enter function), "out" (exit function).

---

### `trace_function`

**Description:** Traces calls to a function by its name in the source code. Works for ANY function including module-internal functions (webpack/rollup bundled). Uses "logpoints" (conditional breakpoints) to log arguments without pausing execution. Trace breakpoints persist across page navigations.

**Parameters:**

- **functionName** (string) **(required)**: The function name to trace. Will search for "function NAME" or "NAME = function" or "NAME(" patterns.
- **logArgs** (boolean) _(optional)_: Whether to log function arguments (default: true).
- **logThis** (boolean) _(optional)_: Whether to log "this" context (default: false).
- **pause** (boolean) _(optional)_: Whether to actually pause execution (default: false, just logs).
- **traceId** (string) _(optional)_: Custom ID for this trace. Used to identify in logs.
- **urlFilter** (string) _(optional)_: Only search in scripts matching this URL pattern.

---
