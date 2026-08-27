# js-reverse-mcp Anti-Detection Architecture

English | [中文](anti-detection-work.md)

Anti-detection in js-reverse-mcp is **cleanly layered**. The wrapper layer (this MCP itself) does **zero JS injection and zero `Object.defineProperty` hacks** — those would themselves become detection signals. All real anti-detection work happens in two orthogonal layers: the **protocol layer** (Patchright) and the optional **source layer** (CloakBrowser binary).

## Architecture Overview

```
┌────────────────────────────────────────────────────────────┐
│ What the site's JS can see (the surface)                   │
├────────────────────────────────────────────────────────────┤
│ Protocol layer: Patchright (always on, both modes)         │
│  • Does NOT call Runtime.enable / Console.enable (classic  │
│    CDP leaks)                                              │
│  • Evaluates in isolated execution context by default      │
│  • Sanitizes default launch args (strips --enable-automation) │
│  • Provides Closed Shadow Root access                      │
├────────────────────────────────────────────────────────────┤
│ Source layer: CloakBrowser binary (only with --cloak)      │
│  • 49 C++ patches: navigator.webdriver / canvas / WebGL /  │
│    audio / fonts / GPU / screen / WebRTC / TLS             │
│  • Fingerprint derived from a seed, persisted per profile  │
└────────────────────────────────────────────────────────────┘
                            ↑
    Wrapper layer (this MCP) — ZERO stealth responsibility:
       • Launch / connect Chrome
       • Silent CDP navigation
       • Google referer
       • Real OS viewport
       • Injects NO JS, hacks NO properties
```

## Mode Comparison

| Dimension                        | Default mode                                  | `--cloak` mode                                                     |
| -------------------------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| Browser binary                   | System Google Chrome                          | CloakBrowser custom Chromium (based on 145)                        |
| Protocol-layer stealth           | Patchright                                    | Patchright                                                         |
| Source-layer fingerprint patches | None                                          | 49 C++ patches                                                     |
| Profile directory                | `~/.cache/chrome-devtools-mcp/chrome-profile` | `~/.cache/chrome-devtools-mcp/cloak-profile` (physically isolated) |
| Chrome Web Store / Google sync   | ✅                                            | ❌ (Chromium has no Google closed-source services)                 |
| Anti-bot bypass rate             | Medium                                        | High (passes 30+ detection sites in CloakBrowser's tests)          |

Full comparison and `--cloak` guide: [cloak.en.md](cloak.en.md)

## Wrapper-Layer Navigation-Time Safeguards

While the bulk of anti-detection lives in Patchright + cloak, the wrapper has a few non-negotiable safeguards around **navigation**:

### 1. Silent CDP navigation

During page load, **no CDP domains are activated**. `Network.enable` / `Debugger.enable` / `Audits.enable` are all deferred until the first **non-navigation** tool call.

**Why this matters**: anti-bot scripts (Zhihu's 40362, Cloudflare challenges, reCAPTCHA, etc.) **actively probe CDP traffic** during page load. Seeing a `Network.requestWillBeSent` subscription is an instant bot verdict. Deferring initialization = let the risk-control JS run, get through, then open the debugging channel.

Relevant code:

- `src/McpContext.ts:ensureCollectorsInitialized()` — deferred init entry point
- `src/main.ts` — special-cases `ToolCategory.NAVIGATION` tools, skipping collector init

### 2. Google referer

The `new_page` tool defaults to `referer: https://www.google.com/`. This mimics the most common "clicked through from Google Search" inbound path, reducing the suspicion score that some sites apply to direct visits.

Relevant code: `src/tools/pages.ts:46` (`DEFAULT_REFERER`).

### 3. Real OS viewport

`viewport: null` disables Playwright's default 1280×720 fake viewport — the browser reports the **real screen dimensions**. The fake viewport itself is a bot signal.

Relevant code: `src/browser.ts`, in `contextOptions = { viewport: null, ... }`.

### 4. Headed-only

`headless: false` is hardcoded. This MCP is a **visual debugging tool for human analysts**, not a headless scraper. Headless mode remains detectable by various means even with cloak patches, so the `--headless` flag is intentionally never exposed.

### 5. `--test-type` banner suppression

The wrapper hard-injects `--test-type` — **not for stealth, as a UX flag**. It tells Chrome to shut up: otherwise every "dev-only" flag Patchright/cloak injects produces a yellow "unsupported command-line flag" banner at the top of every tab.

Relevant code: `src/browser.ts:113`.

### 6. Physically isolated profile dirs

`--cloak` and default mode **never share a profile directory**. Cross-version state (cache, extensions, shader cache) between different Chromium builds triggers `Network.setCacheDisabled` internal errors that crash launch outright.

Relevant code: `src/browser.ts:36-37` (`DEFAULT_USER_DATA_DIR` / `DEFAULT_CLOAK_DATA_DIR`).

## Design Principles (Do Not Violate)

These principles came from real burns. **Read them before changing code.**

### Principle 1: NEVER do JS-level anti-detection

The wrapper layer must **never** use `addInitScript` or `Object.defineProperty` to modify `navigator.*` / `screen.*` / `chrome.*` properties. Such hacks:

- Leave detectable getter/setter traces via `Object.getOwnPropertyDescriptor` (real Chrome has these as data properties, not accessors)
- Cause `Error.stack` to contain `UtilityScript` / `eval at ...` markers
- Make the hacked function's `.toString()` no longer return `[native code]`

Strong anti-bot systems (Google reCAPTCHA, FingerprintJS, etc.) **specifically check for these traces**. **JS patches backfire and trigger "unusual traffic" blocks**.

**Real anti-detection happens in two places only**: C++ binary layer (cloak) + CDP protocol layer (Patchright).

The project once had `src/stealth-init.ts` trying to patch `chrome.runtime` / `screen.availHeight` / similar "leftover leaks". It got detected by Google. **Deleted. Do not reintroduce.**

### Principle 2: NEVER do config-level fingerprint hacks

Launch args like `--lang=en-US`, `--window-size=1920,1080`, `--fingerprinting-canvas-image-data-noise` are also stealth anti-patterns:

- Attempt to fake a real browser via flags
- Break with every Chrome update
- The flag combination itself becomes a fingerprint

The right approach: use **real OS defaults** (`viewport: null`), or use cloak binary's **source-layer patches** (`--fingerprint=<seed>` lets the binary derive a consistent fingerprint internally).

The project once had a 137-line `STEALTH_ARGS` going down this path. **Deleted. Do not reintroduce.**

### Principle 3: CDP must be deferred

See "Wrapper-Layer Navigation-Time Safeguards §1". Any code that triggers `Network.enable` / `Debugger.enable` / `Audits.enable` during navigation defeats anti-detection.

### Principle 4: Distinguish "stealth deletion" from "UX deletion"

When cleaning up stealth code, **classify by runtime behavior, not by filename**. For example, `--test-type` was historically lumped with stealth flags, but its actual runtime role is **UX (banner suppression)**, not stealth. Lumping them together led to deleting `--test-type` and immediately getting yellow banners on every page.

Test before deleting: "What does this flag actually do at runtime? Would removing it produce an immediate visible change for the user?"

### Principle 5: Headed-only

`headless: false` is hardcoded; the `--headless` flag is **not exposed**. Reasoning:

- The user's mental model is "see the browser to debug"
- Headless still has detection vectors that fingerprint patches don't cover
- Exposing a `--headless` flag is a trap for users

## Known Residual Leaks

These leaks also exist in Patchright, Scrapling, and similar tools. **They do not break mainstream anti-bot tests**:

| Detection                       | Current value                     | Expected                 | Notes                                                                           |
| ------------------------------- | --------------------------------- | ------------------------ | ------------------------------------------------------------------------------- |
| `chrome.runtime`                | `undefined`                       | Should be a full object  | Chrome hides this when controlled via CDP; cloak binary doesn't patch it either |
| `chrome.app`                    | `undefined`                       | Same as above            | Same                                                                            |
| `Error.stack` from `evaluate()` | contains isolated-context markers | Should be a normal stack | Patchright's isolated world marker, only visible in evaluate call stacks        |

**Do not try to patch these at the JS level** — see Principle 1.

## CDP-Aware Debugging Workflow

Because navigation tools intentionally keep CDP silent, **requests, console messages, WebSocket connections, and JS script lists are not collected during initial page load**. This is by design — pass risk controls first, then open the debugging channel.

Recommended workflow (**navigate first, then reload**):

```
# 1. Navigate to target (silent, passes risk controls)
new_page(url="https://example.com")

# 2. Any non-navigation tool call — triggers CDP collector activation
list_network_requests()   # returns empty here, but collectors are now active

# 3. Reload to capture everything
navigate_page(type="reload")

# 4. Now you see the full request list
list_network_requests()
```

## Further Reading

- Full `--cloak` guide, profile/fingerprint identity binding, dual-MCP setup: [cloak.en.md](cloak.en.md)
- CloakBrowser project (49 C++ patches explained): https://github.com/CloakHQ/CloakBrowser
- How Patchright's protocol-layer stealth works: https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs
