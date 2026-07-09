# JS Reverse MCP

English | [中文](README.md)

An AI-first / AI-native JavaScript reverse engineering MCP server that lets coding assistants (Claude, Cursor, Copilot) debug, locate, save, and replay JavaScript behavior in real web pages like an analyst.

It does not simply expose raw Chrome DevTools APIs to the model. It reorganizes scripts, breakpoints, network traffic, WebSocket data, browser state, and local file I/O into tools shaped for continuous AI Agent reasoning and action. Anti-detection is one supporting capability: default [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs) protocol-layer stealth, plus optional [CloakBrowser](https://github.com/CloakHQ/CloakBrowser) source-level fingerprint mode for strong anti-bot sites.

## Tired of Reconfiguring Agents? Try Bloome

<p align="center">
  <a href="https://bloome.im/login?ref=zhizhuodemao">
    <img src="images/广告图片.png" alt="Bloome: Accelerating the world's transition to human-agent teams" width="100%">
  </a>
</p>

[Bloome](https://bloome.im/login?ref=zhizhuodemao) lets Claude, ChatGPT, DeepSeek, and other AI agents collaborate in the same cloud conversation. For JavaScript reverse-engineering and debugging, you can work from web or mobile with zero setup, then share configured agents with your team.

## Features

- **AI-native tool design**: tool granularity, output boundaries, and error guidance are designed around Agent decisions
- **Replayable workflows**: script source, raw network data, and binary results can be exported to local files and reused as later inputs
- **Breakpoint-context execution**: evaluate directly in paused call frames, inspect scope variables, step through code with source context
- **Script analysis**: list loaded JS, search code, get/save source, and auto-format large minified scripts
- **Network & WebSocket analysis**: request initiator stacks, XHR breakpoints, Set-Cookie detection, raw body/header export, WebSocket message grouping
- **Browser-state replay**: clear current-site cookies, cache, storage, and sessionStorage to reproduce cookie and anti-bot initialization flows
- **Headed + persistent by default**: visible browser, cookies and localStorage survive across sessions
- **Optional anti-detection layer**: Patchright protocol-layer stealth by default; add `--cloak` for CloakBrowser on strong anti-bot sites

## Requirements

- [Node.js](https://nodejs.org/) v20.19 or later
- [Chrome](https://www.google.com/chrome/) stable

## Quick Start (npx)

No installation required. Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "js-reverse": {
      "command": "npx",
      "args": ["js-reverse-mcp"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add js-reverse npx js-reverse-mcp
```

### Codex

```bash
codex mcp add js-reverse -- npx js-reverse-mcp
```

### Cursor

Go to `Cursor Settings` -> `MCP` -> `New MCP Server`, and use the configuration above.

### VS Code Copilot

```bash
code --add-mcp '{"name":"js-reverse","command":"npx","args":["js-reverse-mcp"]}'
```

## Local Installation (Alternative)

```bash
git clone https://github.com/zhizhuodemao/js-reverse-mcp.git
cd js-reverse-mcp
npm install
npm run build
```

Then use local path in your MCP configuration:

```json
{
  "mcpServers": {
    "js-reverse": {
      "command": "node",
      "args": ["/path/to/js-reverse-mcp/build/src/index.js"]
    }
  }
}
```

## AI-First Design

The core goal of this project is not "operate a browser". It is to let an AI Agent complete a real JavaScript reverse-engineering loop: open a page, pass risk checks, locate scripts, save source, set breakpoints, trigger behavior, inspect runtime state, export network material, reset state, and continue reasoning.

Several design choices show up throughout the codebase:

- **Tools are Agent primitives, not DevTools menu items**: `list_network_requests` can list an index, inspect a `reqid`, or export exact material with `outputFile`; `evaluate_script` can run in the page, in a paused call frame, and with one local file passed through `localFilePath`.
- **Outputs should guide the next action**: list output stays short and scannable; detail output is bounded; large results point to export paths; pending requests explicitly tell the Agent to resume before reading response data instead of waiting forever.
- **Local files are the analysis workbench**: `save_script_source`, `list_network_requests(..., outputFile)`, and `evaluate_script(..., localFilePath)` let the Agent move between browser state, network captures, and local files without stuffing huge code or binary blobs into chat context.
- **State can be cleaned and replayed**: the default profile preserves login state; `--isolated` gives a disposable clean environment; `clear_site_data` clears current-site state for repeated cookie-generation, risk-control, and request-chain analysis.
- **Anti-detection serves the debugging loop**: silent CDP navigation, real viewport, Google referer, Patchright, and CloakBrowser exist so the Agent can enter the target page and keep analyzing. This project is not a generic crawler framework.

## Anti-Detection (Supporting Capability)

Anti-detection is one of js-reverse-mcp's supporting capabilities. The wrapper itself injects **zero** JavaScript and runs no `Object.defineProperty` hacks — those would themselves become detectable. All anti-detection happens in two well-separated layers:

| Layer                                 | Default mode                                                                                                      | `--cloak` mode                                                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Protocol layer** (CDP)              | Patchright: skips `Runtime.enable`/`Console.enable`, evaluates in isolated worlds, strips automation launch flags | Same                                                                                                               |
| **Source layer** (C++ binary patches) | None — uses system Google Chrome as-is                                                                            | CloakBrowser binary (49 C++ patches: `navigator.webdriver`, canvas, WebGL, audio, GPU, fonts, screen, WebRTC, TLS) |
| **Profile directory**                 | `~/.cache/chrome-devtools-mcp/chrome-profile` (persistent login)                                                  | `~/.cache/chrome-devtools-mcp/cloak-profile` (physically isolated from the default)                                |
| **Browser used**                      | Your installed Google Chrome (with Web Store, extensions, sync)                                                   | Custom Chromium build (no Google services, no Web Store)                                                           |

Other navigation-level safeguards (both modes):

- **Silent CDP navigation** — page-load tools never call `Network.enable` / `Debugger.enable`, request/console collection is purely Playwright-level until a tool explicitly needs CDP
- **Google referer** — `new_page` sends `referer: https://www.google.com/` by default
- **Real OS viewport** — Playwright's fake 1280×720 viewport is disabled; the browser shows your real screen size

When to enable `--cloak`: only for sites that block you on fingerprint despite all of the above. See [docs/cloak.en.md](docs/cloak.en.md) for the full guide and tradeoffs.

## Tools (22)

### Page & Navigation

| Tool              | Description                                                   |
| ----------------- | ------------------------------------------------------------- |
| `select_page`     | List open pages, or select one by index as debugging context  |
| `new_page`        | Create a new page and navigate to URL                         |
| `navigate_page`   | Navigate, go back, forward, or reload                         |
| `select_frame`    | List all frames (iframes), or select one as execution context |
| `take_screenshot` | Take a page screenshot                                        |

### Script Analysis

| Tool                 | Description                                                             |
| -------------------- | ----------------------------------------------------------------------- |
| `list_scripts`       | List all JavaScript scripts loaded in the page                          |
| `get_script_source`  | Get script source snippet by line range or character offset             |
| `save_script_source` | Save full script source to a local file (for large/minified/WASM files) |
| `search_in_sources`  | Search for strings or regex patterns across all scripts                 |

### Breakpoint & Execution Control

| Tool                     | Description                                                      |
| ------------------------ | ---------------------------------------------------------------- |
| `set_breakpoint_on_text` | Set breakpoint by searching code text (works with minified code) |
| `break_on_xhr`           | Set XHR/Fetch breakpoint by URL pattern                          |
| `remove_breakpoint`      | Remove breakpoint(s) by ID, URL, or all; auto-resumes            |
| `list_breakpoints`       | List all active breakpoints                                      |
| `get_paused_info`        | Get paused state, call stack and scope variables                 |
| `pause_or_resume`        | Toggle pause/resume execution                                    |
| `step`                   | Step over, into, or out with source context in response          |

### Network & WebSocket

| Tool                     | Description                                                                   |
| ------------------------ | ----------------------------------------------------------------------------- |
| `list_network_requests`  | List requests, inspect one request, or export raw headers/body/query material |
| `get_request_initiator`  | Get JavaScript call stack for a network request                               |
| `get_websocket_messages` | List WebSocket connections, analyze messages, or get message details          |

### Browser State

| Tool              | Description                                                                |
| ----------------- | -------------------------------------------------------------------------- |
| `clear_site_data` | Clear current-site cookies, HTTP cache, origin storage, and sessionStorage |

### Inspection

| Tool                    | Description                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `evaluate_script`       | Execute JavaScript in page or paused context, with main-world mode, result export, and one local input file |
| `list_console_messages` | List console messages, or get one by msgid                                                                  |

## Usage Examples

### Basic JS Reverse Engineering Workflow

1. **Open the target page**

```
Open https://example.com and list all loaded JS scripts
```

2. **Find target functions**

```
Search all scripts for code containing "encrypt"
```

3. **Set breakpoints**

```
Set a breakpoint at the entry of the encryption function
```

4. **Trigger and analyze**

```
Trigger an action on the page, then inspect arguments, call stack and scope variables when the breakpoint hits
```

### WebSocket Protocol Analysis

```
List WebSocket connections, analyze message patterns, view messages of specific types
```

### Agent-Friendly Full Capture Flow

Navigation intentionally stays CDP-silent during the first page load. The recommended flow is to pass risk controls first, then reload with collectors active:

```
1. Open the target page with new_page
2. Call list_network_requests to activate collectors
3. Reload with navigate_page(type="reload")
4. Call list_network_requests again to inspect the complete request list
5. Export key reqids with outputFile when exact material is needed
```

### Cookie / Risk-Control Replay Flow

```
1. Run clear_site_data to reset current-site state
2. Reload with navigate_page(type="reload")
3. Use list_network_requests to find cookie-setting or sensor-submitting requests
4. Export requestBody / responseHeaders / responseBody
5. Use evaluate_script + localFilePath to recompute or verify in page context
```

## Configuration Options

The CLI is intentionally minimal — four flags, all optional. Default behavior is what you want 99% of the time.

| Option             | Description                                                                                                                                                                                                                                                                           | Default |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `--cloak`          | Use CloakBrowser stealth-patched Chromium binary instead of system Chrome. Adds 49 source-level C++ fingerprint patches. Binary auto-downloads (~200MB) on first use. Identity is persisted per profile. See [docs/cloak.en.md](docs/cloak.en.md).                                    | `false` |
| `--isolated`       | Use a temporary user data directory (cookies/localStorage not persisted, auto-cleaned on close)                                                                                                                                                                                       | `false` |
| `--browserUrl, -u` | Connect to a running Chrome instance via CDP HTTP endpoint (e.g. `http://127.0.0.1:9222`). The MCP probes it to find the WebSocket debugger URL. See [docs/cdp-endpoint.en.md](docs/cdp-endpoint.en.md) for how to obtain this endpoint from local Chrome, AdsPower, BitBrowser, etc. | –       |
| `--logFile`        | Path to write debug logs (also set env `DEBUG=*` for verbose logs)                                                                                                                                                                                                                    | –       |

### Example Configurations

**Default — system Chrome with persistent login** (recommended for most debugging):

```json
{
  "mcpServers": {
    "js-reverse": {
      "command": "npx",
      "args": ["js-reverse-mcp"]
    }
  }
}
```

**`--cloak` — strong anti-bot sites** (Cloudflare Turnstile / FingerprintJS / DataDome):

> **Strongly recommended: pre-download the binary first** (one-time, ~30–60 seconds). Without this, the first `--cloak` MCP launch silently downloads ~200MB and looks like the server is hanging:
>
> ```bash
> npx cloakbrowser install
> ```
>
> The `cloakbrowser` package is already pulled in via `optionalDependencies`; this command just triggers its built-in binary download with a visible progress bar.

```json
{
  "mcpServers": {
    "js-reverse-cloak": {
      "command": "npx",
      "args": ["js-reverse-mcp", "--cloak"]
    }
  }
}
```

**Both at once** — separate MCP instances with isolated profiles, pick the right one for the target site:

```json
{
  "mcpServers": {
    "js-reverse": {
      "command": "npx",
      "args": ["js-reverse-mcp"]
    },
    "js-reverse-cloak": {
      "command": "npx",
      "args": ["js-reverse-mcp", "--cloak"]
    }
  }
}
```

**`--isolated` — clean profile every run** (no cookies/localStorage persisted):

```json
{
  "mcpServers": {
    "js-reverse": {
      "command": "npx",
      "args": ["js-reverse-mcp", "--isolated"]
    }
  }
}
```

### Connect to a Running Chrome / Third-Party Fingerprint Browser

`--browserUrl` accepts **CDP endpoints only** (an HTTP endpoint that responds to `/json/version`), not vendor-private Local APIs. For how to obtain the CDP port from local Chrome, AdsPower, BitBrowser, etc., see the dedicated guide:

📖 **[docs/cdp-endpoint.en.md — How to get the CDP debug endpoint](docs/cdp-endpoint.en.md)**

Shortest path (local Chrome):

```bash
# Close all existing Chrome windows first, then:
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
```

```json
{
  "mcpServers": {
    "js-reverse": {
      "command": "npx",
      "args": ["js-reverse-mcp", "--browserUrl", "http://127.0.0.1:9222"]
    }
  }
}
```

Fingerprint browsers (AdsPower, BitBrowser, etc.) hand out a **randomly assigned CDP port every launch** — you must call the vendor's Local API to start a profile and extract the port from the response. Full walkthrough and sample launcher scripts in the doc above.

## Troubleshooting

### Blocked by anti-bot systems

If a site blocks you (e.g. Zhihu returning error 40362, Cloudflare challenge looping):

1. **Try `--isolated` first** — wipes any contaminated state from previous runs:
   ```json
   "args": ["js-reverse-mcp", "--isolated"]
   ```
2. **If that doesn't help, enable `--cloak`** — adds 49 source-level fingerprint patches:
   ```json
   "args": ["js-reverse-mcp", "--cloak"]
   ```
3. **Manually clear the persistent profile** (last resort, deletes your saved logins):
   ```bash
   rm -rf ~/.cache/chrome-devtools-mcp/chrome-profile
   ```

See [docs/cloak.en.md](docs/cloak.en.md) for when `--cloak` is the right call (and when it isn't).

## Security Notice

This tool exposes browser content to MCP clients, allowing inspection, debugging, and modification of any data in the browser. Do not use it on pages containing sensitive information.

## License

Apache-2.0
