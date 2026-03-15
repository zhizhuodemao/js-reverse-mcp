/**
 * Minimal Patchright test - no MCP framework, no CDP sessions, no event listeners.
 * Tests whether raw Patchright Node.js can open Zhihu without being blocked.
 *
 * Usage: node test_raw_patchright.mjs
 */
import {chromium} from 'patchright';

const STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--test-type',
  '--start-maximized',
  '--window-position=0,0',
  '--window-size=1920,1080',
  '--lang=en-US',
  '--accept-lang=en-US',
  '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4',
  '--ignore-gpu-blocklist',
  '--force-color-profile=srgb',
  '--font-render-hinting=none',
  '--enable-features=NetworkService,NetworkServiceInProcess,TrustTokens,TrustTokensAlwaysAllowIssuance',
  '--disable-features=AudioServiceOutOfProcess,TranslateUI,BlinkGenPropertyTrees',
  '--enable-async-dns',
  '--enable-tcp-fast-open',
  '--enable-web-bluetooth',
  '--mute-audio',
  '--disable-sync',
  '--use-mock-keychain',
  '--disable-translate',
  '--disable-voice-input',
  '--hide-scrollbars',
  '--autoplay-policy=user-gesture-required',
  '--disable-ipc-flooding-protection',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-client-side-phishing-detection',
  '--safebrowsing-disable-auto-update',
  '--disable-domain-reliability',
  '--metrics-recording-only',
  '--disable-cookie-encryption',
  '--disable-logging',
  '--disable-dev-shm-usage',
  '--disable-crash-reporter',
  '--disable-partial-raster',
  '--disable-gesture-typing',
  '--disable-checker-imaging',
  '--disable-prompt-on-repost',
  '--aggressive-cache-discard',
  '--disable-threaded-animation',
  '--disable-threaded-scrolling',
  '--enable-simple-cache-backend',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-new-content-rendering-timeout',
  '--disable-image-animation-resync',
  '--disable-offer-upload-credit-cards',
  '--disable-offer-store-unmasked-wallet-cards',
  '--enable-surface-synchronization',
  '--run-all-compositor-stages-before-draw',
  '--cloud-import',
  '--disable-print-preview',
  '--prerender-from-omnibox=disabled',
  '--disable-layer-tree-host-memory-pressure',
  '--disable-component-extensions-with-background-pages',
  '--fingerprinting-canvas-image-data-noise',
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--force-webrtc-ip-handling-policy',
];

const HARMFUL_ARGS = [
  '--enable-automation',
  '--disable-popup-blocking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-extensions',
];

const DEFAULT_ARGS = [
  '--no-pings',
  '--no-first-run',
  '--disable-infobars',
  '--disable-breakpad',
  '--no-service-autorun',
  '--homepage=about:blank',
  '--password-store=basic',
  '--disable-hang-monitor',
  '--no-default-browser-check',
  '--disable-session-crashed-bubble',
  '--disable-search-engine-choice-screen',
];

async function main() {
  console.log('Launching Patchright (raw, no MCP)...');

  // Use launch() + newContext() like Scrapling, NOT launchPersistentContext
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: [...DEFAULT_ARGS, ...STEALTH_ARGS, '--hide-crash-restore-bubble'],
    ignoreDefaultArgs: HARMFUL_ARGS,
  });

  const context = await browser.newContext({
    viewport: {width: 1920, height: 1080},
    screen: {width: 1920, height: 1080},
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    isMobile: false,
    hasTouch: false,
    serviceWorkers: 'allow',
    permissions: ['geolocation', 'notifications'],
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();

  console.log('Navigating to Zhihu (plain goto, no CDP listeners)...');

  // Pure goto - no extra CDP sessions, no event listeners, no waitForEventsAfterAction
  await page.goto('https://zhuanlan.zhihu.com/p/1930714592423703026', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
    referer: 'https://www.google.com/',
  });

  // Wait a bit for JS challenge to execute
  await page.waitForTimeout(5000);

  const title = await page.title();
  const url = page.url();
  const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '');

  console.log('\n--- Result ---');
  console.log('Title:', title);
  console.log('URL:', url);
  console.log('Body preview:', bodyText.substring(0, 300));

  // Check if blocked
  if (bodyText.includes('40362') || bodyText.includes('异常')) {
    console.log('\n❌ BLOCKED by Zhihu anti-bot');
  } else if (title && !title.includes('error')) {
    console.log('\n✅ Page loaded successfully');
  } else {
    console.log('\n⚠️  Unclear result, check manually');
  }

  // Keep browser open for manual inspection
  console.log('\nBrowser stays open for inspection. Press Ctrl+C to exit.');
  await new Promise(() => {}); // hang forever
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
