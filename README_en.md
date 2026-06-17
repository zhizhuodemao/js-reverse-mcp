# JS Reverse MCP

English | [中文](README.md)

A JavaScript reverse engineering MCP server that enables AI coding assistants (Claude, Cursor, Copilot) to debug and analyze JavaScript code in web pages.

Built on the [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs) protocol-layer anti-detection, with an optional [CloakBrowser](https://github.com/CloakHQ/CloakBrowser) source-level fingerprint mode for strong anti-bot sites. Headed mode, persistent login, and zero JS injection — looks and behaves like a real Chrome.

## Features

- **Headed debugging by default**: see the browser, set breakpoints, step through JS — the way a real reverse engineer works
- **Persistent login state**: cookies and localStorage survive across sessions
- **Two-layer anti-detection**: Patchright avoids `Runtime.enable`/`Console.enable` CDP leaks at the protocol level; opt-in `--cloak` adds 49 source-level C++ fingerprint patches (canvas, WebGL, audio, GPU, fonts) via the CloakBrowser binary
- **Script analysis**: list all loaded JS scripts, search code, get/save source
- **Breakpoint debugging**: set/remove breakpoints, conditional breakpoints, precise positioning in minified code
- **Execution control**: pause/resume, step over/into/out with source context in response
- **Runtime inspection**: evaluate at breakpoints, inspect scope variables
- **Network analysis**: request initiator call stacks, XHR breakpoints, WebSocket message analysis

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

## Anti-Detection

Stealth in this project is cleanly layered. The wrapper itself injects **zero** JavaScript and runs no `Object.defineProperty` hacks — those would themselves become detectable. All anti-detection happens in two well-separated layers:

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

## Tools (21)

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

| Tool                     | Description                                                          |
| ------------------------ | -------------------------------------------------------------------- |
| `list_network_requests`  | List network requests, or get one by reqid                           |
| `get_request_initiator`  | Get JavaScript call stack for a network request                      |
| `get_websocket_messages` | List WebSocket connections, analyze messages, or get message details |

### Inspection

| Tool                    | Description                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `evaluate_script`       | Execute JavaScript in the page (supports paused context, main world, and saving results/binary data to file) |
| `list_console_messages` | List console messages, or get one by msgid                                                                   |

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
