# How to Get the CDP Debug Endpoint (input for `--browserUrl`)

`js-reverse-mcp` accepts **one** form of browser connection: an HTTP endpoint that speaks the Chrome DevTools Protocol (i.e. `--browserUrl http://127.0.0.1:<port>`). It probes `/json/version` to discover the WebSocket debugger URL and then takes over via Patchright over CDP.

> **Explicitly not supported**: vendor-private Local APIs (AdsPower `:50325`, BitBrowser `:54345`, etc.), Bearer Token authentication, `webdriver://`-style automation protocols. Those are management surfaces — they are **not** CDP. The MCP layer is plumbing only and is intentionally unaware of any specific vendor. How CDP is exposed is an upstream concern.

This doc covers exactly one thing: **how to obtain the real CDP endpoint from your browser of choice.**

---

## Generic: How to tell whether your port is actually CDP

One `curl`, four possible outcomes:

```bash
curl http://127.0.0.1:<port>/json/version
```

| Response                                           | Verdict                                                               |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| JSON containing `webSocketDebuggerUrl: "ws://..."` | ✅ It's CDP. Hand it to MCP.                                          |
| `Not Found` / `404` / anything non-JSON            | ❌ Not CDP (almost certainly a vendor's Local API port)               |
| `401` / `Unauthorized`                             | ❌ CDP never requires auth — if it asks for credentials, it's not CDP |
| `Connection refused` / can't connect               | ❌ Browser isn't running, or the port number is wrong                 |

If MCP reports `Unexpected token 'N', "Not Found" is not valid JSON`, it means MCP got a non-JSON response from `/json/version`. 99% of the time the port points at a vendor management API, not at CDP.

---

## Scenario 1: Local Chrome / Edge / Chromium

The simplest case: you start Chrome yourself with a debug port that you choose.

### macOS

```bash
# Close all existing Chrome windows first (REQUIRED), then:
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug
```

### Windows

```powershell
# PowerShell — close every Chrome window first
"C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:TEMP\chrome-debug"
```

### Linux

```bash
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug
```

### Edge / other Chromium-based browsers

Replace the executable (`msedge` for Edge, `brave-browser` for Brave, etc.). The flags are identical.

### Important notes

- **You must close every existing instance of the same browser first.** Otherwise Chrome silently reuses the running instance and ignores the new command — the debug port never opens.
- **Use a dedicated `--user-data-dir`** (like `/tmp/chrome-debug` above). Do **not** point it at your daily profile, or everything MCP does will land in your real account (cookies, extensions, history).
- Any unused port works; `9222` is just the community default.

### Verify + configure MCP

```bash
curl http://127.0.0.1:9222/json/version  # should return JSON with webSocketDebuggerUrl
```

`.mcp.json`:

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

---

## Scenario 2: AdsPower (detailed example)

AdsPower exposes **two different HTTP ports** that are easy to confuse:

| Port                                                              | What it is                                                            | Use it for MCP? |
| ----------------------------------------------------------------- | --------------------------------------------------------------------- | --------------- |
| `50325` (default)                                                 | AdsPower **Local API**, the management surface, requires Bearer Token | ❌ Not CDP      |
| Random port assigned each time you start a profile (e.g. `58229`) | The actual Chrome **CDP debug port**, no auth                         | ✅ Yes          |

The CDP port **changes every time you launch a profile** — you cannot hard-code it. The mandatory flow is: call Local API → launch the profile → read `debug_port` from the response → use it as `--browserUrl`.

### Step 1: Get an API key

AdsPower client → Automation → API → API Key. Mandatory in CLI mode or when "security check" is on; recommended either way.

### Step 2: Find your profile ID

```bash
curl 'http://127.0.0.1:50325/api/v1/user/list?page=1&page_size=10' \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

The `data.list[].user_id` field is your profile ID, e.g. `k1c4bc0d`.

### Step 3: Start the browser, grab `debug_port`

```bash
curl 'http://127.0.0.1:50325/api/v1/browser/start?user_id=YOUR_PROFILE_ID' \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

Success response:

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "ws": {
      "puppeteer": "ws://127.0.0.1:58229/devtools/browser/14bf4496-...",
      "selenium": "127.0.0.1:58229"
    },
    "debug_port": "58229",
    "webdriver": "/.../chromedriver"
  }
}
```

Record `data.debug_port` (here `58229` — yours will differ).

### Step 4: Hand to MCP

```bash
# Verify first
curl http://127.0.0.1:58229/json/version
```

`.mcp.json`:

```json
{
  "mcpServers": {
    "js-reverse-adspower": {
      "command": "npx",
      "args": ["js-reverse-mcp", "--browserUrl", "http://127.0.0.1:58229"]
    }
  }
}
```

### Port changes every launch — one-shot launcher script

Chain "start AdsPower → parse port → start MCP" into a single command. Bash version below (macOS/Linux); Windows users can adapt to PowerShell or run it through WSL.

```bash
#!/usr/bin/env bash
# scripts/adspower-mcp.sh
# Usage: ADSPOWER_API_KEY=xxx ADSPOWER_PROFILE_ID=k1c4bc0d ./adspower-mcp.sh
set -euo pipefail

: "${ADSPOWER_API_KEY:?need ADSPOWER_API_KEY}"
: "${ADSPOWER_PROFILE_ID:?need ADSPOWER_PROFILE_ID}"
ADSPOWER_HOST="${ADSPOWER_HOST:-http://127.0.0.1:50325}"

resp=$(curl -fsS "${ADSPOWER_HOST}/api/v1/browser/start?user_id=${ADSPOWER_PROFILE_ID}" \
  -H "Authorization: Bearer ${ADSPOWER_API_KEY}")

port=$(printf '%s' "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['debug_port'])")

# Sanity check: CDP must respond to /json/version
curl -fsS "http://127.0.0.1:${port}/json/version" >/dev/null

# Forward stdio to the MCP client (critical: MCP speaks over stdout)
exec npx js-reverse-mcp --browserUrl "http://127.0.0.1:${port}"
```

`.mcp.json` pointed at the script:

```json
{
  "mcpServers": {
    "js-reverse-adspower": {
      "command": "/absolute/path/to/adspower-mcp.sh",
      "env": {
        "ADSPOWER_API_KEY": "...",
        "ADSPOWER_PROFILE_ID": "..."
      }
    }
  }
}
```

> ⚠️ Before putting an API key in `.mcp.json`, confirm the file is gitignored. It is by default in this repo.

---

## Scenario 3: BitBrowser

The shape is similar to AdsPower but port and field names differ. The snippet below is based on BitBrowser's public docs and has **not** been tested in this repo's CI — verify against your actual responses.

| Port              | Use                                      |
| ----------------- | ---------------------------------------- |
| `54345` (default) | BitBrowser Local API (POST + JSON style) |

### Start a browser and get CDP

```bash
curl -X POST 'http://127.0.0.1:54345/browser/open' \
  -H 'Content-Type: application/json' \
  -d '{"id":"YOUR_PROFILE_ID"}'
```

Expected response (look at `data.http` — that's the CDP HTTP endpoint `127.0.0.1:<port>`):

```json
{
  "success": true,
  "data": {
    "http": "127.0.0.1:12345",
    "ws": "ws://127.0.0.1:12345/devtools/browser/xxxx",
    "driver": "/.../chromedriver",
    "port": 12345
  }
}
```

### Hand to MCP

```bash
curl http://127.0.0.1:12345/json/version  # verify
```

```json
{
  "mcpServers": {
    "js-reverse-bit": {
      "command": "npx",
      "args": ["js-reverse-mcp", "--browserUrl", "http://127.0.0.1:12345"]
    }
  }
}
```

Same caveat — ports change every launch. To automate, adapt the bash script from Scenario 2 by swapping the field name (`data.http` or `data.port` instead of `data.debug_port`).

---

## General troubleshooting

| Symptom                                                             | Cause                                                                                           | Fix                                                                                     |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `Unexpected token 'N', "Not Found"`                                 | MCP got non-JSON; wrong port                                                                    | Run `curl /json/version` yourself; almost always you handed MCP a vendor Local API port |
| `Unexpected token '<', "<!DOCTYPE..."`                              | Got HTML, wrong port                                                                            | Same as above                                                                           |
| `ECONNREFUSED`                                                      | Nothing listening on that port                                                                  | Browser isn't running, or the port number is wrong                                      |
| 401 / 403 / `Unauthorized`                                          | The port requires auth                                                                          | CDP never requires auth — this port is definitely not CDP                               |
| `/json/version` works but MCP says `The browser is already running` | You're using MCP's launch mode and your manually launched Chrome owns the default user-data-dir | Use `--browserUrl` mode (this doc), or use `--isolated`                                 |

---

## Other vendors (Multilogin / Hubstudio / Dolphin{anty} / VMLogin / Gologin / ...)

Identical shape, different API paths and field names. Three-step generic checklist:

1. Find the vendor's **Local API** docs (usually under "Automation" or "Developer" on their site).
2. Find the "start browser" endpoint. POST or GET, doesn't matter — look at the response for the CDP endpoint (keywords: `ws`, `webSocketDebuggerUrl`, `debug_port`, `http`, `puppeteerWs`).
3. Extract `host:port`. Verify with `curl http://host:port/json/version` that it returns `webSocketDebuggerUrl`, then pass to MCP via `--browserUrl`.

There is no reason to add vendor adapters at the MCP layer — **the MCP only cares about CDP; getting the port is your responsibility.**
