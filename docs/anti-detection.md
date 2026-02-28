# Anti-Detection Strategy

## Current Implementation

### 1. stealth.min.js (bundled, from puppeteer-extra 2022)

Injected via `evaluateOnNewDocument`, covers:
- `navigator.webdriver` removal
- `window.chrome` object mocking
- `navigator.plugins` spoofing
- Headless mode indicators removal
- iframe contentWindow proxy
- WebGL fingerprint masking
- Error stack sanitization

### 2. stealth-patch.js (custom, appended after stealth.min.js)

Fixes gaps not covered by stealth.min.js:

- **`navigator.webdriver = false`**: stealth.min.js deletes the property entirely, but real Chrome has it on the prototype returning `false`. Websites detect deletion via `'webdriver' in navigator === false`.
- **CDP MouseEvent screenX/screenY fix**: When clicks are dispatched via CDP `Input.dispatchMouseEvent`, `screenX/screenY` incorrectly equal `clientX/clientY` (relative to iframe). Real clicks have `screenX/screenY` relative to the physical screen. Cloudflare Turnstile exploits this bug for precise bot detection. Fix: override `MouseEvent.prototype.screenX/screenY` and `PointerEvent.prototype.screenX/screenY` with randomized realistic values.

### 3. rebrowser-puppeteer-core (replaces puppeteer-core)

Drop-in replacement via npm alias (`puppeteer-core: npm:rebrowser-puppeteer-core@24.8.1`).

Core fix: disables automatic `Runtime.Enable` CDP command. All automation libraries (Puppeteer/Playwright/Selenium) call `Runtime.Enable` to discover execution contexts. This triggers `Runtime.consoleAPICalled` events which anti-bot systems (Cloudflare, DataDome) detect with just a few lines of JS. The rebrowser patches use `Runtime.addBinding` + `Page.createIsolatedWorld` instead.

Trade-off: pinned to puppeteer-core 24.8.1 (upstream is 24.31.0). Some newer APIs need `@ts-expect-error` comments: `handleDevToolsAsPage`, `browser.pages(includeAllPages)`, `ignoreCache` in reload, `'fedcm'` resource type.

### 4. Browser launch flags

- `ignoreDefaultArgs: ['--enable-automation']` — removes the Chrome automation infobar and related env vars
- `pipe: true` — uses pipe instead of WebSocket for CDP, slightly harder to detect externally

## What passes

| Test Site | Result |
|---|---|
| rebrowser-bot-detector | runtimeEnableLeak: PASS, all others: PASS |
| infosimples/detect-headless | All green (Headful), Devtool Protocol: "Not using" |
| bot.sannysoft.com | All checks passed |

## What does NOT pass

| Target | Detection | Why |
|---|---|---|
| **Cloudflare Turnstile** (e.g. steamdb.info) | Blocked even with manual click | Multi-layer detection: TLS fingerprint (JA3/JA4), HTTP/2 frame order, behavioral analysis, cryptographic proof-of-work, ML models. These operate at network/browser-engine level, not fixable via JS injection. |
| **Google Search reCAPTCHA** | 429 redirect to /sorry | Likely combination of: IP reputation (repeated testing flagged the IP), thin `x-client-data` header (empty Chrome profile has few field trials), and possibly residual CDP signals. Homepage loads fine; only search triggers it. |

## Why Cloudflare Turnstile cannot be bypassed with current architecture

Turnstile's detection is multi-dimensional and runs **before** any user interaction:

1. **TLS Fingerprint (JA3/JA4)**: Analyzed during SSL handshake. Cannot be modified via JavaScript. While Puppeteer uses the real Chrome binary (same TLS stack), other signals combined with TLS create the detection.

2. **HTTP/2 Frame Order**: The order and structure of HTTP/2 frames reveals client identity. Not controllable from JS.

3. **`evaluateOnNewDocument` Artifacts**: Scripts injected via CDP's `Page.addScriptToEvaluateOnNewDocument` can be detected through memory profiling and script parsing events. Anti-detect browsers that recompile Chromium avoid this entirely.

4. **Behavioral Biometrics**: Mouse movement patterns, click timing, scroll behavior are analyzed in real-time. Even manual interaction in an automated browser can differ subtly from organic browsing.

5. **Cryptographic Proof-of-Work**: Background JS challenges that require genuine browser execution. These run silently and verify browser integrity.

6. **Per-Customer ML Models**: Cloudflare deploys adaptive ML models trained on millions of interactions. Bypass techniques that work today may fail tomorrow.

## Industry approaches for strong protection

- **CAPTCHA solving services** (2captcha, CapSolver) — pay per solve
- **Anti-detect browsers** (Camoufox, Kameleo) — modified browser binaries
- **Connect to user's real Chrome** (`--browserUrl` / `--remote-debugging-port`) — real profile with cookies, history, field trials
- **Nodriver / undetected-chromedriver** — avoid CDP entirely, use different automation protocols

## Files changed

- `package.json` — puppeteer → rebrowser-puppeteer-core alias
- `scripts/stealth-patch.js` — new file, navigator.webdriver + screenX/screenY fixes
- `src/main.ts` — load stealth-patch.js after stealth.min.js
- `src/browser.ts` — @ts-expect-error for 24.8 compatibility
- `src/McpContext.ts` — @ts-expect-error for browser.pages()
- `src/PageCollector.ts` — @ts-expect-error for browser.pages()
- `src/WebSocketCollector.ts` — @ts-expect-error for browser.pages()
- `src/tools/network.ts` — removed 'fedcm' resource type (not in 24.8)
- `src/tools/pages.ts` — @ts-expect-error for ignoreCache
