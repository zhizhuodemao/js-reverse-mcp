/**
 * Test: Open Google, search, and get results.
 * No MCP framework - pure Patchright.
 *
 * Usage: node test_zhihu_search.mjs
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
  console.log('Launching Patchright...');

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: [...DEFAULT_ARGS, ...STEALTH_ARGS, '--hide-crash-restore-bubble'],
    ignoreDefaultArgs: HARMFUL_ARGS,
  });

  const context = await browser.newContext({
    viewport: null,
    colorScheme: 'dark',
    isMobile: false,
    hasTouch: false,
    serviceWorkers: 'allow',
    permissions: ['geolocation', 'notifications'],
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();

  // Step 1: Open Google
  console.log('Step 1: Opening Google...');
  await page.goto('https://www.google.com', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForTimeout(2000);

  const title = await page.title();
  console.log('Page title:', title);
  console.log('✅ Google loaded');

  // Step 2: Find and click search input
  console.log('\nStep 2: Clicking search box...');
  const searchInput = page.locator('textarea[name="q"], input[name="q"]').first();
  await searchInput.waitFor({timeout: 5000});
  await searchInput.click();
  await page.waitForTimeout(500);
  console.log('✅ Search box clicked');

  // Step 3: Type search query
  const query = 'Python uv package manager';
  console.log(`\nStep 3: Typing "${query}"...`);
  await page.keyboard.type(query, {delay: 80});
  await page.waitForTimeout(1000);
  console.log('✅ Query typed');

  // Step 4: Press Enter to search
  console.log('\nStep 4: Pressing Enter...');
  await page.keyboard.press('Enter');

  // Wait for search results
  try {
    await page.waitForSelector('#search, #rso', {timeout: 10000});
    console.log('✅ Search results container appeared');
  } catch {
    console.log('⚠️  Waiting for results page...');
  }
  await page.waitForTimeout(3000);

  const searchUrl = page.url();
  console.log('Search URL:', searchUrl);

  // Step 5: Check results
  console.log('\nStep 5: Checking results...');

  // Check for Cloudflare challenge
  const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 1000) || '');
  const pageTitle = await page.title();

  if (pageTitle.includes('Just a moment') || bodyText.includes('Cloudflare')) {
    console.log('❌ Cloudflare 5s shield triggered!');
  } else if (searchUrl.includes('search') || searchUrl.includes('q=')) {
    console.log('✅ Search results loaded!');
    const results = await page.evaluate(() => {
      const items = document.querySelectorAll('#search .g h3, #rso .g h3');
      return Array.from(items).slice(0, 5).map(el => el.innerText);
    });
    console.log('\nTop results:');
    results.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));
  } else {
    console.log('⚠️  Unclear result');
    console.log('Title:', pageTitle);
    console.log('Body preview:', bodyText.substring(0, 300));
  }

  // Take screenshot
  await page.screenshot({path: 'test_google_search_result.png'});
  console.log('\nScreenshot saved to test_google_search_result.png');

  console.log('\nBrowser stays open. Press Ctrl+C to exit.');
  await new Promise(() => {});
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
