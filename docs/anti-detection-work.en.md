# js-reverse-mcp Anti-Detection Work Log

## Background

js-reverse-mcp is a Node.js-based MCP Server that uses Patchright (Node.js) to control Chrome, providing DevTools debugging capabilities to AI coding assistants.

During testing, we discovered that visiting Zhihu column `https://zhuanlan.zhihu.com/p/1930714592423703026` was blocked, returning `{"error":{"code":40362,"message":"Your current request is abnormal, temporarily restricting this access"}}`.

Meanwhile, another Python project Scrapling using Patchright (Python) + similar launch arguments could open the same page successfully.

## Root Cause Analysis

### Verification Method: Controlled Variable Testing

We wrote a standalone test script `test_raw_patchright.mjs` using the exact same Patchright Node.js + STEALTH_ARGS as the MCP, but without loading the MCP framework layer. Result: **The standalone script could open Zhihu and Google normally**.

This proved:

- **NOT** a Patchright Node.js vs Python difference
- **NOT** a browser fingerprint issue (both fingerprints were identical)
- **The problem was 100% in the MCP framework layer**

### Root Cause 1: CDP Leaks During Navigation (Zhihu Blocking)

The MCP framework executes multiple CDP-related operations before and after `page.goto()` during navigation tool calls:

1. **`detectOpenDevToolsWindows()`** — Iterates all pages, creates CDP sessions for devtools:// pages and calls `Target.getTargetInfo`
2. **`createPagesSnapshot()`** — Internally calls `detectOpenDevToolsWindows()`
3. **`waitForEventsAfterAction()`** (fixed) — Creates additional CDP sessions to listen for `Page.frameStartedNavigating`

This CDP activity during page navigation was detected by Zhihu's JS challenge script.

### Root Cause 2: Contaminated Persistent user-data-dir (Zhihu Blocking)

Previous blocking incidents accumulated risk control markers (device IDs and reputation data in Cookie/Cache/LocalStorage). Resolved by clearing `~/.cache/chrome-devtools-mcp/chrome-profile` combined with CDP fixes.

### Root Cause 3: JS Init Script Actually Caused Detection (Google reCAPTCHA)

We wrote `src/stealth-init.ts` attempting to fix the following leaks via JS injection:

- `Error.stack` contains `UtilityScript` → Override `Error.prepareStackTrace`
- `chrome.runtime` / `chrome.app` missing → Create fake objects
- `screen.availHeight` equals `screen.height` → `Object.defineProperty` override
- `Notification.permission` abnormal → Override

**Result: These JS patches backfired and were detected by Google's anti-bot system.**

Anti-bot detection techniques include:

- Checking if `Object.getOwnPropertyDescriptor` returns a getter vs data property (real Chrome's screen properties are data properties, not getters)
- Checking if function `.toString()` contains `[native code]` (faked functions can't pass)
- Checking if `Error.prepareStackTrace` has been overridden

**Key Verification:**

1. Standalone script (no init script) → Google search works ✅
2. MCP + init script → Google triggers "unusual traffic" ❌
3. MCP without init script → Google search works ✅
4. All tests above used `launchPersistentContext`, ruling out launch method differences

**Conclusion: Scrapling also doesn't use init scripts, relying entirely on Patchright C++ patches + launch arguments. JS-level anti-detection patches are unreliable.**

## Completed Fixes

### 1. Base Anti-Detection Alignment

Configuration aligned with Scrapling:

| Layer                | Description                                        | Status |
| -------------------- | -------------------------------------------------- | ------ |
| Patchright Engine    | Using patchright v1.51.1 / patchright-core v1.58.2 | ✅     |
| Launch Arguments     | 60+ STEALTH_ARGS, aligned with Scrapling           | ✅     |
| HARMFUL_ARGS Removal | --enable-automation and 4 other arguments          | ✅     |
| Context Spoofing     | dark theme, isMobile=false, hasTouch=false         | ✅     |
| navigator.webdriver  | Patchright C++ patch active, value is false        | ✅     |
| Bot Detection Test   | sannysoft.com all passed                           | ✅     |

Related files:

- `src/stealth-args.ts` — Launch argument definitions (HARMFUL_ARGS / DEFAULT_ARGS / STEALTH_ARGS)
- `src/browser.ts` — Browser launch/connect logic

### 2. Google Referer Spoofing

**File:** `src/tools/pages.ts`

Scrapling includes `referer: 'https://www.google.com/'` with every `page.goto()`, simulating clicks from Google search results.

Changes:

- `new_page` tool: `page.goto(url, { referer: 'https://www.google.com/' })`
- `navigate_page` tool (type=url): Same as above

### 3. Viewport Uses Real Dimensions

**File:** `src/browser.ts`, `src/stealth-args.ts`

- `viewport: null` disables Playwright's viewport emulation, letting the OS manage window size natively
- Added `--window-size=1920,1080` launch argument
- `deviceScaleFactor` / `screen` only set when user explicitly specifies `--viewport`
- Exposes real Mac resolution (1512x982, colorDepth 30, DPR 2)

### 4. Lazy CDP Domain Initialization (Critical Fix)

**File:** `src/McpContext.ts`, `src/main.ts`

A core part of Patchright's anti-detection is **silent CDP**. However, the MCP Server originally enabled multiple CDP domains immediately at startup:

| Collector          | CDP Domain                           | Original Init Timing |
| ------------------ | ------------------------------------ | -------------------- |
| DebuggerContext    | `Debugger.enable`                    | McpContext.#init()   |
| NetworkCollector   | `Network.requestWillBeSent` listener | init() → addPage()   |
| ConsoleCollector   | `Audits.enable`                      | init() → addPage()   |
| WebSocketCollector | Network.webSocket\* listener         | init() → addPage()   |

**Fix:**

- `McpContext.#init()` no longer immediately initializes collectors
- Added `ensureCollectorsInitialized()` method, deferred to first non-navigation tool call
- In `main.ts`: `ToolCategory.NAVIGATION` category tools don't trigger collector initialization
- `reinitDebugger()` / `reinitDebuggerForFrame()` skip when collectors are uninitialized
- `newPage()` doesn't register collectors when uninitialized

### 5. Fully Silent Navigation Tools (Critical Fix)

**File:** `src/tools/pages.ts`, `src/main.ts`, `src/McpContext.ts`

Even after deferring collectors, CDP leaks remained in the navigation tool call chain:

| Leak Point                    | Location                | CDP Behavior                                                       |
| ----------------------------- | ----------------------- | ------------------------------------------------------------------ |
| `waitForEventsAfterAction()`  | pages.ts handler        | Creates CDP session + listens for `Page.frameStartedNavigating`    |
| `detectOpenDevToolsWindows()` | main.ts every tool call | Creates CDP session for devtools:// pages + `Target.getTargetInfo` |
| `createPagesSnapshot()`       | McpResponse.handle()    | Internally calls `detectOpenDevToolsWindows()`                     |

**Fix:**

- `new_page` / `navigate_page` no longer use `waitForEventsAfterAction()`, directly calls `page.goto()`
- Navigation tools in `main.ts` skip `detectOpenDevToolsWindows()`
- `createPagesSnapshot()` skips `detectOpenDevToolsWindows()` when collectors are uninitialized

**Post-fix navigation tool CDP timeline:**

```
1. getContext() — McpContext.#init() only does createPagesSnapshot() (no CDP session)
2. Skip detectOpenDevToolsWindows() ✅
3. Skip ensureCollectorsInitialized() ✅
4. context.newPage() — Pure Playwright API
5. page.goto() — Pure navigation, no extra CDP
6. response.handle() → createPagesSnapshot() (doesn't call detectOpenDevToolsWindows) ✅
```

**Core principle: Navigate to the target page first and pass bot detection → then activate CDP domains for reverse engineering.**

### 6. Remove JS Init Script (Critical Fix)

**Deleted file:** `src/stealth-init.ts`

JS-level anti-detection patches were detected by Google's anti-bot system, triggering "unusual traffic" blocking.

Specific patches removed:

- `Error.prepareStackTrace` override (filtering UtilityScript)
- Fake `chrome.runtime` / `chrome.app` objects
- `Object.defineProperty` override for `screen.availHeight` / `screen.availTop`
- `Object.defineProperty` override for `window.outerHeight` / `window.outerWidth`
- `Notification.permission` override
- `navigator.connection` property override

Also removed the `--initScript` CLI argument.

**Lesson: Don't do anti-detection patches at the JS level. Let Patchright C++ patches + launch arguments handle everything.**

### 7. Notification Permission Fix

**File:** `src/browser.ts`

Added `'notifications'` to the permissions array, changing `Notification.permission` from `"denied"` to `"granted"`.

## Current Status

**Zhihu ✅ Passed** — Page loads normally, no 40362 error.

**Google ✅ Passed** — Homepage loads normally, manual search returns results normally, no reCAPTCHA.

## Known Remaining Leaks

These leaks also exist in Scrapling (Python Patchright) and don't affect passing mainstream anti-bot detection:

| Detection Item                         | Current Value | Expected Value          | Notes                                                           |
| -------------------------------------- | ------------- | ----------------------- | --------------------------------------------------------------- |
| `Error.stack` contains `UtilityScript` | Present       | Should not exist        | Patchright execution context leak, only visible during evaluate |
| `chrome.runtime`                       | Missing       | Should have full object | Patchright C++ layer doesn't fully emulate                      |
| `chrome.app`                           | Missing       | Should have full object | Same as above                                                   |

**Note: Do not attempt to fix these leaks with JS init scripts — it will backfire.**

## Usage Notes

### Request Capture on Anti-Detection Sites

To pass bot detection, navigation tools (`new_page`, `navigate_page`) don't activate CDP collectors (Network/Console/WebSocket/Debugger) during execution. This means requests, console messages, WebSocket connections, and JS script lists during initial page load will not be captured.

**Recommended workflow: Navigate first, then reload**

1. Use `new_page` or `navigate_page` to navigate to the target page (passes bot detection but doesn't capture requests)
2. Call any non-navigation tool (e.g. `evaluate_script`, `list_network_requests`) to trigger CDP collector initialization
3. Use `navigate_page` with `reload` to refresh the page
4. Now all requests, console messages, scripts, etc. will be fully captured

```
# Step 1: Navigate to target page (silent mode, passes bot detection)
new_page(url="https://example.com")

# Step 2: Any non-navigation tool call triggers collector initialization
list_network_requests()  # Returns empty, but collectors are now started

# Step 3: Reload the page to fully capture all requests
navigate_page(type="reload")

# Step 4: Now you can see the complete request list
list_network_requests()  # Returns all requests
```

## File Change List

| File                      | Change Type | Description                                                                                          |
| ------------------------- | ----------- | ---------------------------------------------------------------------------------------------------- |
| `src/tools/pages.ts`      | Modified    | Added Google Referer; removed waitForEventsAfterAction                                               |
| `src/browser.ts`          | Modified    | viewport: null + conditional DPR; added notifications permission                                     |
| `src/stealth-args.ts`     | Modified    | Added --window-size=1920,1080                                                                        |
| `src/McpContext.ts`       | Modified    | Lazy CDP collector initialization; createPagesSnapshot conditionally skips detectOpenDevToolsWindows |
| `src/main.ts`             | Modified    | Navigation tools fully skip CDP operations; removed init script logic                                |
| `src/stealth-init.ts`     | **Deleted** | JS init script caused Google detection, removed                                                      |
| `src/cli.ts`              | Modified    | Removed --initScript CLI argument                                                                    |
| `test_raw_patchright.mjs` | Added       | Standalone test script, verified raw Patchright passes Zhihu                                         |
| `test_zhihu_search.mjs`   | Added       | Google search test script, verified no init script passes Google                                     |
