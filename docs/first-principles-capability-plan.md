# First-Principles Capability Plan: Network Export and Local Inputs

Status: proposal  
Scope: design only; no implementation in this document.

## Problem

Two useful workflows are currently awkward:

1. Network analysis often needs exact request or response data on disk. The current `list_network_requests(reqid=...)` detail view is useful for inspection, but response and request bodies are formatted as inline MCP text and may be truncated or unavailable in the rendered response.
2. Browser-side JavaScript often needs large local inputs such as JSON, base64, binary samples, captured payloads, or configuration. The current `evaluate_script` tool can execute strong model-written JavaScript, but the model has to inline data manually when the data lives in local files.

The solution should not add new tools for every variant. That would make the MCP surface larger, make tool selection harder for agents, and drift away from the core primitives already present in the project.

## Design Principle

Tools should represent primitives, not variants.

- `list_network_requests` is the primitive for network observation and request detail inspection.
- `evaluate_script` is the primitive for executing JavaScript in the selected browser frame or paused call frame.
- File export is an output mode of an existing primitive.
- Local file input is an input mode of an existing primitive.

The model should not choose between "network detail" and "network export" tools, or between "evaluate script" and "evaluate script with local file" tools. It should use the same primitive and opt into file input/output with explicit parameters.

## Current State

### `list_network_requests`

Current behavior:

- Without `reqid`, lists collected requests.
- With `reqid`, attaches a single request detail view.
- Request body is read from `HTTPRequest.postData()`.
- Response body is read from `HTTPResponse.body()`.
- Inline body display is limited and text-oriented.
- Binary response bodies are not materialized; they are displayed as `<binary data>`.
- GET query parameters are only visible as part of the full URL.

Limitations:

- No file output parameter exists for request or response data.
- Inline output can truncate important data.
- The model has no structured prompt from the tool telling it when exact export is the correct next step.

### `evaluate_script`

Current behavior:

- Accepts a JavaScript function string.
- Executes it in isolated world, main world, or paused call frame depending on parameters and debugger state.
- Can write the function result to `outputFile`.

Limitations:

- No way to pass local files as function inputs.
- Large JSON/base64/binary values must be manually pasted into the function string.
- Loading a JavaScript function body from a local file is not the main need; the model can write JavaScript well. The missing primitive is local data injection.

## Browser File Access Boundary

Normal web page JavaScript cannot read arbitrary local filesystem paths such as `/Users/chen/data.json`.

Relevant browser rules:

- The File API lets web content read local files only after user selection, typically through `<input type="file">` or drag and drop. See MDN: <https://developer.mozilla.org/en-US/docs/Web/API/File_API/Using_files_from_web_applications>
- File inputs do not expose the real local path. Browsers intentionally show fake paths such as `C:\fakepath\...` to avoid leaking local filesystem structure. See MDN: <https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/file>
- Chrome's File System Access API also requires user-mediated picker flows and permissions. See Chrome Developers: <https://developer.chrome.com/docs/capabilities/web-apis/file-system-access>
- `file:///` pages are not a general escape hatch. Modern browsers often treat file origins as opaque origins, and same-directory files may still trigger CORS-like restrictions. See MDN: <https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy>

Therefore this project should not describe the feature as "the browser reads a local path".

Correct mental model:

1. The MCP server reads local files within its filesystem permissions.
2. The MCP server serializes the file contents into an explicit argument payload.
3. `evaluate_script` executes the model-written function in the browser and passes that payload as an argument.

This keeps the browser security model clear and avoids teaching agents a false capability.

## Proposed API Changes

### Extend `list_network_requests`

Add optional parameters:

```ts
outputFile?: string;
outputPart?: "all" | "responseBody" | "requestBody" | "queryParams";
```

Behavior:

- `outputFile` is only meaningful with `reqid`.
- If `reqid` is omitted, `outputFile` should be rejected with a clear message.
- If `outputFile` is omitted, current inline behavior remains, but body sections should be described as previews when they are limited.
- If `outputFile` is provided, the selected part is written to disk without inline truncation.
- If `outputPart` is omitted, default to `"all"`.

Output modes:

| `outputPart`     | File content                                                                                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"responseBody"` | Raw response body bytes when available.                                                                                                                                                                   |
| `"requestBody"`  | Request body bytes/string from the captured request. For GET requests this is usually empty.                                                                                                              |
| `"queryParams"`  | Pretty JSON object/array representation of parsed URL query parameters.                                                                                                                                   |
| `"all"`          | Pretty JSON bundle with method, URL, resource type, status, headers, query params, request body metadata, and response body metadata/content. Binary bodies should be base64 encoded in this JSON bundle. |

GET payload terminology:

- The tool description should explicitly say: for GET requests, "payload" means parsed URL query parameters.
- Do not imply that normal GET requests have a request body.

Annotation:

- Because `outputFile` writes to disk, `list_network_requests` should no longer be annotated as `readOnlyHint: true` after this parameter is added.
- MCP annotations are static; they cannot be truthfully read-only for list mode and write-capable for export mode at the same time.

### Extend `evaluate_script`

Add optional parameter:

```ts
localFilePath?: string;
```

Function calling convention:

Current no-argument functions continue to work:

```js
async () => {
  return document.title;
};
```

When `localFilePath` is provided, the evaluated function receives one argument:

```js
async ({localFile}) => {
  const payload = JSON.parse(localFile.text);
  return window.sign(payload);
};
```

The `localFile` object represents exactly one local file.

Normalized shape:

```ts
type LocalFileInput = {
  // Absolute resolved path.
  path: string;
  // Basename of path.
  name: string;
  // Byte length.
  size: number;
  // Exact original bytes.
  base64: string;
  // Present only when the file is valid UTF-8.
  text?: string;
};
```

Important behavior:

- The model still writes the JavaScript function.
- `localFilePath` is a data input, not a script source input.
- The browser page does not read local paths. The server reads the local file and passes its contents into the function argument.
- There is no persistent import state. Each call reads the file and passes it to that call's function only.
- If the model wants to keep data for later calls, it should explicitly assign it in JavaScript, for example `window.__mcpPayload = JSON.parse(localFile.text)` with `mainWorld: true`.
- `outputFile` keeps its existing meaning: save the evaluated function result to local disk.

Safety constraints:

- Exactly one local file is supported.
- The path must be absolute.
- Relative paths are rejected.
- `file://` URLs are rejected.
- `~` expansion is rejected.
- Globs are rejected.
- Directories are rejected.
- The path must point to a regular file.
- Enforce a max file size. Proposed default: 5 MiB.
- Paused call-frame evaluation should be more conservative because the payload is embedded into a CDP expression. Proposed default: 512 KiB.
- Tool description must warn that file contents are passed into page JS. If the function sends those contents over the network, local file content can leave the machine.

## Model Guidance Requirements

The implementation should make the intended agent behavior discoverable from tool descriptions and from tool output.

### `list_network_requests` guidance

Tool description should include guidance similar to:

> Use inline request details for inspection. Use `outputFile` when you need exact bytes, full bodies, replay inputs, signature inputs, large request bodies, long GET query payloads, binary responses, or data that will be decoded with external tools. For GET requests, query parameters are the payload-like data.

Inline detail output should provide export hints when applicable:

```text
Response body preview shown: 10000 of 286412 bytes.
For exact bytes, re-run:
list_network_requests({ reqid: 17, outputPart: "responseBody", outputFile: "captures/req17-response.bin" })
```

Suggested hint triggers:

| Trigger                                                                                             | Suggested hint         |
| --------------------------------------------------------------------------------------------------- | ---------------------- |
| URL length > 2000 chars                                                                             | Export `queryParams`.  |
| Query string length > 1000 chars                                                                    | Export `queryParams`.  |
| Request body length > 8192 bytes/chars                                                              | Export `requestBody`.  |
| Response body exceeds inline limit                                                                  | Export `responseBody`. |
| Response is not UTF-8                                                                               | Export `responseBody`. |
| `content-type` indicates binary, protobuf, image, archive, wasm, or octet-stream                    | Export `responseBody`. |
| Task wording implies exactness: full, raw, bytes, replay, signature, encrypt, decrypt, decode, diff | Prefer `outputFile`.   |

The tool cannot directly see the user's natural-language task wording inside the handler, so that part belongs in parameter descriptions and tool description.

### `evaluate_script` guidance

Tool description should include guidance similar to:

> Keep JavaScript logic in `function`. Use `localFilePath` for one local data file, commonly a network body or JSON exported by another tool. The path must be absolute. The MCP server reads this file and passes it as `localFile`; browser JavaScript does not read local paths.

Examples should emphasize data injection:

```js
async ({localFile}) => {
  const params = JSON.parse(localFile.text);
  return window.makeSignature(params);
};
```

Do not emphasize loading JavaScript functions from files. That pattern is less useful and creates a second execution mental model. If the model wants persistent data for later calls, it should explicitly write JavaScript state, for example `window.__mcpPayload = JSON.parse(localFile.text)` with `mainWorld: true`.

## Implementation Plan

### Network export

1. Extend `src/tools/network.ts` schema with `outputFile` and `outputPart`.
2. In `list_network_requests` handler:
   - If `outputFile` is present without `reqid`, append a clear error response or throw a validation-style error.
   - If `reqid` is present with `outputFile`, perform export in the handler and append a short saved-file summary.
   - If `reqid` is present without `outputFile`, keep the existing `response.attachNetworkRequest(reqid)` path.
3. Extract network detail collection into a reusable helper, likely near `src/formatters/networkFormatter.ts` or a new `src/networkSnapshot.ts`.
4. The helper should collect:
   - method
   - URL
   - parsed query params
   - resource type
   - request headers
   - response status
   - response headers when available
   - request body text/bytes when available
   - response body bytes when available
   - failure state
5. Preserve the current inline display path, but update body copy to call it a preview when truncated or not byte-exact.
6. Add export hints to inline details when thresholds are triggered.
7. Update `readOnlyHint` for `list_network_requests` to `false`.
8. Run docs generation after implementation so `docs/tool-reference.md` reflects the schema.

### Evaluate script input files

1. Extend `src/tools/script.ts` schema with `localFilePath`.
2. Add server-side local file loading using `fs.promises.readFile`.
3. Normalize the file into a JSON-serializable `localFile` object containing absolute path, basename, byte size, base64, and optional UTF-8 text.
4. Validate:
   - absolute path
   - not a `file://` URL
   - no `~` expansion
   - no glob-like characters
   - regular file
   - max file size
   - stricter paused call-frame size
5. Pass one argument into the evaluated function:
   - Existing function with zero parameters still works because JavaScript ignores extra arguments.
   - Functions that need the file can declare `({localFile}) => ...`.
6. Apply the same argument passing path to:
   - isolated world execution
   - main world execution
   - paused call-frame execution, if feasible
7. Enforce a smaller file-size limit for paused call-frame evaluation because the payload is embedded into a CDP expression.
8. Keep `outputFile` behavior unchanged.

## Testing Plan

### Unit or integration tests for network export

- Listing requests remains unchanged when no export params are provided.
- `outputFile` without `reqid` fails clearly.
- GET request with long query exports `queryParams` JSON.
- POST JSON body exports `requestBody`.
- Large text response exports full `responseBody`, while inline view remains preview-limited.
- Binary response exports raw bytes.
- `all` export includes metadata and encodes binary safely.

### Unit or integration tests for evaluate input files

- Absolute UTF-8 file is available as `localFile.text`.
- Absolute binary file is available as `localFile.base64`.
- Relative paths fail before page execution.
- `file://` URLs fail before page execution.
- Directories fail before page execution.
- Oversized input fails.
- Existing no-argument `evaluate_script` calls still work.
- `localFilePath` works with `outputFile` result saving.

## Documentation Updates

After implementation:

- Update README tool summary if needed.
- Run `npm run docs` to regenerate `docs/tool-reference.md`.
- Add examples to the generated descriptions through schema descriptions, not by hand-editing `docs/tool-reference.md`.

## Non-Goals

- Do not add `export_network_request`.
- Do not add `evaluate_script_file`.
- Do not make browser page JavaScript read arbitrary local paths.
- Do not add directory import, glob import, or recursive file loading.
- Do not silently export large data without explicit `outputFile`.
- Do not make inline MCP responses the source of truth for large or binary data.
