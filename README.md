# JS Reverse MCP

English | [中文](README_zh.md)

A JavaScript reverse engineering MCP server that enables AI coding assistants (Claude, Cursor, Copilot) to debug and analyze JavaScript code in web pages.

Built on the [Patchright](https://github.com/nicecaesar/patchright) anti-detection engine with multi-layered anti-bot bypass capabilities, allowing it to work on sites with bot detection such as Zhihu and Google.

## Features

- **Anti-detection browser**: Based on Patchright (Playwright anti-detection fork), 60+ stealth launch arguments, bypasses mainstream anti-bot systems
- **Script analysis**: List all loaded JS scripts, search code, get/save source code
- **Breakpoint debugging**: Set/remove breakpoints, conditional breakpoints, precise positioning in minified code
- **Execution control**: Pause/resume execution, step debugging (over/into/out) with source context
- **Runtime inspection**: Evaluate expressions at breakpoints, inspect scope variables
- **Network analysis**: View request initiator call stacks, set XHR breakpoints, WebSocket message analysis

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

js-reverse-mcp includes multi-layered anti-detection measures to work on sites with bot detection:

### Anti-Detection Architecture

| Layer                   | Description                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Patchright Engine       | C++ level anti-detection patches, removes `navigator.webdriver`, avoids `Runtime.enable` leaks                                                                                 |
| 60+ Stealth Args        | Removes automation signatures, bypasses headless detection, GPU/network/behavior fingerprint spoofing                                                                          |
| Harmful Args Removal    | Excludes `--enable-automation` and 4 other default Playwright arguments                                                                                                        |
| Silent CDP Navigation   | Navigation tools don't activate CDP domains, captures requests only through Playwright-level listeners, preventing anti-bot scripts from detecting debugging protocol activity |
| Google Referer Spoofing | All navigations automatically include `referer: https://www.google.com/`                                                                                                       |
| Persistent Login State  | Uses persistent user-data-dir by default, login state preserved across sessions                                                                                                |

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

| Option                 | Description                                         | Default   |
| ---------------------- | --------------------------------------------------- | --------- |
| `--browserUrl, -u`     | Connect to a running Chrome instance                | -         |
| `--wsEndpoint, -w`     | WebSocket endpoint connection                       | -         |
| `--headless`           | Run in headless mode                                | false     |
| `--executablePath, -e` | Custom Chrome executable path                       | -         |
| `--isolated`           | Use temporary user data directory (fresh each time) | false     |
| `--channel`            | Chrome channel: stable, canary, beta, dev           | stable    |
| `--viewport`           | Initial viewport size, e.g. `1280x720`              | real size |
| `--hideCanvas`         | Enable Canvas fingerprint noise                     | false     |
| `--blockWebrtc`        | Block WebRTC to prevent real IP leaks               | false     |
| `--disableWebgl`       | Disable WebGL to prevent GPU fingerprinting         | false     |
| `--noStealth`          | Disable stealth launch arguments (for debugging)    | false     |
| `--proxyServer`        | Proxy server configuration                          | -         |
| `--logFile`            | Debug log file path                                 | -         |

### Example Configurations

**Enhanced anti-detection (Canvas noise + WebRTC blocking):**

```json
{
  "mcpServers": {
    "js-reverse": {
      "command": "npx",
      "args": ["js-reverse-mcp", "--hideCanvas", "--blockWebrtc"]
    }
  }
}
```

**Isolated mode (no persistent login, fresh profile each time):**

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

### Connect to a Running Chrome Instance

1. Launch Chrome (close all Chrome windows first, then restart):

**macOS**

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
```

**Windows**

```bash
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%TEMP%\chrome-debug"
```

2. Configure MCP connection:

```json
{
  "mcpServers": {
    "js-reverse": {
      "command": "npx",
      "args": ["js-reverse-mcp", "--browser-url=http://127.0.0.1:9222"]
    }
  }
}
```

## Troubleshooting

### Blocked by Anti-Bot Systems

If you are blocked when visiting certain sites (e.g. Zhihu returning error 40362):

1. **Clear the contaminated profile**: Delete the `~/.cache/chrome-devtools-mcp/chrome-profile` directory
2. **Use isolated mode**: Add the `--isolated` flag
3. **Enable Canvas noise**: Add the `--hideCanvas` flag

## Security Notice

This tool exposes browser content to MCP clients, allowing inspection, debugging, and modification of any data in the browser. Do not use it on pages containing sensitive information.

## License

Apache-2.0
