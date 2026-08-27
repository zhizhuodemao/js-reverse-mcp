# CloakBrowser Mode (`--cloak`)

`--cloak` is an **optional** launch flag for js-reverse-mcp, used when debugging sites with strong anti-bot protection. It swaps the system Chrome for the [CloakBrowser](https://github.com/CloakHQ/CloakBrowser) team's custom Chromium binary (49 C++ source-level fingerprint patches), stacked on top of the default Patchright protocol-layer stealth — forming a **two-layer anti-detection setup**.

## When to use `--cloak`

| Scenario                                                               | Recommendation                                                       |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Debugging your own app / internal company systems                      | **Default mode** (no `--cloak`)                                      |
| Debugging generic SaaS / e-commerce / social sites                     | **Default mode**                                                     |
| Debugging sites behind Cloudflare Turnstile / FingerprintJS / DataDome | **`--cloak`**                                                        |
| Need Google services (Gmail, Google Docs, etc.)                        | **Default mode** (cloak binary has no Google closed-source services) |
| Need your installed Chrome extensions                                  | **Default mode** (cloak has no Chrome Web Store)                     |

**Rule of thumb**: 99% of debugging uses the default mode (system Chrome + Patchright); only enable `--cloak` when you hit a specific anti-bot block.

## Enabling it

Add `--cloak` to your MCP config:

```json
{
  "mcpServers": {
    "js-reverse": {
      "command": "npx",
      "args": ["js-reverse-mcp", "--cloak"]
    }
  }
}
```

If you already have CloakBrowser locally, also pass `--cloakBinaryPath`. The MCP will use that executable directly and skip the first-run auto-download:

```json
{
  "mcpServers": {
    "js-reverse": {
      "command": "npx",
      "args": [
        "js-reverse-mcp",
        "--cloak",
        "--cloakBinaryPath",
        "D:\\develop_software\\CloakBrowser\\chrome.exe"
      ]
    }
  }
}
```

### **Strongly recommended: pre-download the binary first**

Without `--cloakBinaryPath`, the first `--cloak` launch silently downloads the ~200MB CloakBrowser binary to `~/.cloakbrowser/` (cached there forever after, zero latency on subsequent launches). But inside an MCP server, **the user sees no progress** for those 30–60 seconds — it looks like the MCP is hanging.

**Best practice: take this step out of the MCP context and run it manually once**:

```bash
npx cloakbrowser install
```

The `cloakbrowser` package is already in the npm cache via `js-reverse-mcp`'s `optionalDependencies`; this command just triggers its built-in download logic (visible progress bar + SHA-256 verification). After it completes, launching MCP with `--cloak` is instant.

## Two-Layer Anti-Detection Architecture

```
┌────────────────────────────────────────────────────────┐
│ What the site's JS sees (the surface)                  │
├────────────────────────────────────────────────────────┤
│ Protocol layer: Patchright                             │
│  • Does NOT call Runtime.enable (classic CDP leak)     │
│  • Does NOT call Console.enable                        │
│  • Evaluates in isolated execution contexts by default │
│  • Strips --enable-automation and similar launch flags │
├────────────────────────────────────────────────────────┤
│ Source layer: CloakBrowser binary (49 C++ patches)     │
│  • navigator.webdriver = false (property exists, matches real Chrome) │
│  • canvas / WebGL / audio / fonts spoofed at source    │
│  • GPU strings, screen dims derived from fingerprint seed │
│  • TLS / JA3 / JA4 fingerprints identical to real Chrome │
└────────────────────────────────────────────────────────┘
```

Neither layer injects JavaScript. Any `Object.defineProperty`-style anti-detection hack would itself become a fingerprint signal — we avoid that entirely.

## Platform spoof: Windows on every host (but ≠ full Linux/Win protection)

**`--cloak` mode ignores the real OS and uniformly passes `--fingerprint-platform=windows` to surface as a Windows desktop**. But this **does NOT mean** you get full Linux/Win-build protection when running on macOS:

| Platform build    | C++ patches |
| ----------------- | ----------- |
| Linux x64 / arm64 | **57**      |
| Windows x64       | **57**      |
| macOS arm64 / x64 | **26**      |

CloakBrowser's macOS build is **compiled with only 26 of the 57 patches**. When you run `--cloak` on a Mac, **regardless of `--fingerprint-platform`**, the underlying engine is still the macOS build with 26 patches. The `--fingerprint-platform=windows` flag only changes how the **derived fingerprint strings** look on the surface (UA, `navigator.platform`, GPU names) — **it does not magically add the 31 patches the macOS build was never shipped with**.

**Limitations of "cloak on macOS faking Windows"**:

- ✅ `navigator.userAgent`, `navigator.platform`, `screen.width/height` all surface Windows-desktop values
- ✅ WebGL vendor/renderer are derived into Windows GPU strings (e.g. `Google Inc. (NVIDIA)` + `RTX 3090`)
- ❌ **Fine-grained consistency of WebGL strings** (device ID format, version suffix, etc.) doesn't strictly match what real Windows + RTX 3090 outputs — active detectors (like BrowserScan) can spot the difference
- ❌ Internal consistency between canvas / audio / fonts and the GPU context — also part of the 31 patches not covered

### BrowserScan empirical comparison

| Setup                                                       | BrowserScan red flag on WebGL vendor/renderer?         |
| ----------------------------------------------------------- | ------------------------------------------------------ |
| Real macOS Chrome (the user's everyday browser)             | ❌ Not flagged                                         |
| basic mode (system Chrome + Patchright)                     | ❌ Not flagged                                         |
| **cloak macOS build with `--fingerprint-platform=windows`** | 🔴 **Flagged** (labeled "anti-fingerprint technology") |

So cloak on macOS, even with the Windows fingerprint switch, cannot fool BrowserScan's active WebGL check.

### How to actually get the full 57 patches

Run the **Linux or Windows build** of cloak:

```bash
# Docker, Linux build, CDP exposed on host
docker run -d --name cloak \
  -p 127.0.0.1:9222:9222 \
  cloakhq/cloakbrowser \
  cloakserve --headless=false
```

Then have the MCP connect via `--browserUrl http://127.0.0.1:9222` (one of the reasons we keep the `--browserUrl` flag).

**Costs of Docker on macOS**:

- Docker for Mac has no X server by default → the Linux browser runs but you can't see it
- noVNC workaround: a browser inside a browser, awkward to debug
- If you genuinely need a visible window AND strong anti-bot → a Linux/Windows host is easier

### Important: BrowserScan ≠ real production anti-bot

BrowserScan is an **active fingerprint detector** demo site, stricter than most production anti-bot. Cloudflare Turnstile / FingerprintJS / DataDome use **aggregate behavioral scoring**, looking at different signals.

**The real judgment criterion is "can I load the site I'm actually trying to debug"**:

- Loads fine → cloak macOS (26 patches) is sufficient, BrowserScan red flags don't matter
- Blocked → escalate to Docker Linux cloak

**Do not treat "BrowserScan all green" as a product goal**. It's a stress test, not reality.

### Switching back to native macOS profile

For rare cases (e.g. debugging content specifically targeting macOS Safari), edit the `const platform = 'windows'` line at `src/cloak.ts:99`.

## Differences vs default mode

| Dimension                         | Default (system Chrome)                       | `--cloak` (CloakBrowser binary)                            |
| --------------------------------- | --------------------------------------------- | ---------------------------------------------------------- |
| Browser binary                    | Installed Google Chrome                       | Custom build from Chromium open source                     |
| Chrome Web Store                  | ✅                                            | ❌ (Chromium has no Google closed-source services)         |
| Google sync / account integration | ✅                                            | ❌                                                         |
| Your installed extensions         | ✅ visible                                    | ❌ not visible                                             |
| Widevine DRM                      | ✅                                            | ❌ (encrypted video sites may not play)                    |
| Fingerprint protection            | Protocol layer (Patchright)                   | Protocol + source layer (49 C++ patches)                   |
| Startup speed                     | Fast                                          | First run: ~30-60s for download, then normal               |
| Anti-bot bypass rate              | Medium                                        | High (passes 30+ detection sites per CloakBrowser's tests) |
| Persistent profile path           | `~/.cache/chrome-devtools-mcp/chrome-profile` | `~/.cache/chrome-devtools-mcp/cloak-profile`               |

**Important: the two profile dirs are physically isolated.** Cross-pollination of cache/extension state between different Chromium versions corrupts startup.

## Profile ↔ Fingerprint Identity Binding

In `--cloak` mode, each profile directory is bound to a **persistent virtual identity**:

- First launch: random fingerprint seed (10000–99999) generated, written to `<profile>/.cloak-seed`
- Subsequent launches: read the same seed → **identical fingerprint** (canvas / WebGL / GPU / screen all match)
- Mimics "the same virtual device visiting the same site repeatedly" — less suspicious than a fresh device every time

### Want a brand new identity?

Delete the seed file:

```bash
rm ~/.cache/chrome-devtools-mcp/cloak-profile/.cloak-seed
```

Next launch generates a new one.

### Want a throwaway run (no traces)?

Add `--isolated`:

```bash
npx js-reverse-mcp --cloak --isolated
```

Each launch gets a temporary profile + temporary random seed, auto-cleaned when the browser closes.

## Verifying `--cloak` is active

After launch, use the MCP tool `evaluate_script`:

```javascript
() => ({
  ua: navigator.userAgent,
  webdriver: navigator.webdriver,
  platform: navigator.platform,
  plugins: navigator.plugins.length,
});
```

Expected output:

```json
{
  "ua": "...Chrome/145.0.0.0 Safari/537.36",
  "webdriver": false,
  "platform": "MacIntel",
  "plugins": 5
}
```

The `Chrome/145.0.0.0` in the UA is the cloak binary's version (your system Chrome is typically newer, e.g., 142+). A mismatch confirms cloak is in effect.

For stricter anti-bot verification, visit:

- https://abrahamjuliot.github.io/creepjs/ — combined fingerprint trust score
- https://bot.sannysoft.com/ — automation-detection matrix
- https://browserscan.net/ — commercial anti-bot service

## Dual MCP Instances (Recommended)

If you need both regular debugging and strong-anti-bot debugging, configure two MCP instances:

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

The two instances have:

- Physically isolated profiles
- No awareness of each other
- Pick whichever fits the target site

## Troubleshooting

### macOS Gatekeeper blocks the first launch

The cloak binary is ad-hoc signed. On first run, macOS may refuse to launch it:

```bash
xattr -cr ~/.cloakbrowser/chromium-*/Chromium.app
```

### Startup fails with "Connection closed" / session errors

Usually caused by cross-version state left in the profile dir (cache/extension from a different Chromium build). With physical isolation in place this shouldn't happen, but if it does:

```bash
rm -rf ~/.cache/chrome-devtools-mcp/cloak-profile/
```

Next launch recreates it from scratch.

### Binary download fails

When cloakbrowser.dev is slow, the cloakbrowser package automatically falls back to GitHub Releases. You can also set environment variables manually:

```bash
# Custom download mirror
export CLOAKBROWSER_DOWNLOAD_URL=https://your-mirror.example.com

# Or point to a local Chromium binary you already have
export CLOAKBROWSER_BINARY_PATH=/path/to/your/Chromium
```

### Still blocked on strong anti-bot sites

The cloak binary only addresses the **fingerprint layer**. If you're still blocked, it's usually a different category of problem:

1. **Bad IP reputation**: data-center IPs are flagged by IP-reputation databases → use residential proxies
2. **Behavioral analysis**: actions are too fast/mechanical → out of scope for an MCP debugging tool
3. **TLS fingerprint**: cloak's TLS matches real Chrome, so this is rarely the cause

## Further Reading

- CloakBrowser project: https://github.com/CloakHQ/CloakBrowser
- Patchright project: https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs
- Project-wide anti-detection architecture: [anti-detection-work.en.md](anti-detection-work.en.md)
