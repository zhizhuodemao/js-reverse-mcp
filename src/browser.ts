/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {setupCloak} from './cloak.js';
import {installConsoleBridge} from './consoleBridge.js';
import {logger} from './logger.js';
import type {Browser, BrowserContext} from './third_party/index.js';
import {chromium} from './third_party/index.js';

type BrowserCloseMode = 'connected-cdp' | 'launched' | 'persistent-context';

export interface BrowserResult {
  browser: Browser | undefined;
  context: BrowserContext;
  closeMode: BrowserCloseMode;
}

let browserResult: BrowserResult | undefined;

// Runtime launch option overrides set by launch_browser. These take precedence
// over CLI args and allow switching browsers without restarting the MCP.
export type ManagedBrowser = 'chrome' | 'edge' | 'cloak';

export interface RuntimeLaunchOverrides {
  browser: ManagedBrowser;
  binaryPath?: string;
}
let runtimeOverrides: RuntimeLaunchOverrides | undefined;

export function setRuntimeLaunchOverrides(
  overrides: RuntimeLaunchOverrides | undefined,
): void {
  runtimeOverrides = overrides;
}

export function getRuntimeLaunchOverrides():
  | RuntimeLaunchOverrides
  | undefined {
  return runtimeOverrides;
}

const BROWSER_OCCUPIED_MESSAGE =
  'The MCP browser is currently occupied by another session. Ask the user to close the other MCP/browser debugging window, or start a separate session with --isolated or a different --browserUrl.';

// Persistent user data directories.
//
// IMPORTANT: each managed browser uses a physically isolated profile. Mixing
// profile state across different Chromium binaries causes startup races and
// broken sessions.
//
// NOTE: the default path is preserved across the chrome-devtools-mcp →
// js-reverse-mcp rename so existing users keep their login state.
const DEFAULT_USER_DATA_DIR = path.join(
  os.homedir(),
  '.cache',
  'chrome-devtools-mcp',
  'chrome-profile',
);
const DEFAULT_CLOAK_DATA_DIR = path.join(
  os.homedir(),
  '.cache',
  'chrome-devtools-mcp',
  'cloak-profile',
);
const DEFAULT_EDGE_DATA_DIR = path.join(
  os.homedir(),
  '.cache',
  'chrome-devtools-mcp',
  'edge-profile',
);

export async function ensureBrowserConnected(options: {
  browserURL?: string;
}): Promise<BrowserResult> {
  if (browserResult) {
    return browserResult;
  }

  if (!options.browserURL) {
    throw new Error('browserURL must be provided');
  }

  // Resolve the WebSocket debugger URL from the CDP HTTP endpoint.
  const url = new URL('/json/version', options.browserURL);
  const res = await fetch(url.toString());
  const json = (await res.json()) as {webSocketDebuggerUrl?: string};
  const endpoint = json.webSocketDebuggerUrl;
  if (!endpoint) {
    throw new Error(
      `No webSocketDebuggerUrl in CDP /json/version response from ${options.browserURL}. ` +
        'Make sure the browser was started with --remote-debugging-port.',
    );
  }

  logger('Connecting Patchright via CDP to', endpoint);
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(endpoint);
  } catch (error) {
    if (isBrowserOccupiedError(error)) {
      throw new Error(
        `${BROWSER_OCCUPIED_MESSAGE} The CDP endpoint ${options.browserURL} appears to be in use.`,
        {cause: error},
      );
    }
    throw error;
  }
  logger('Connected Patchright');

  const context = browser.contexts()[0];
  if (!context) {
    throw new Error('No browser context found after connecting');
  }

  browserResult = {browser, context, closeMode: 'connected-cdp'};

  // Clear cached result when browser disconnects so we can reconnect.
  browser.on('disconnected', () => {
    logger('Browser disconnected, clearing cached browser result');
    browserResult = undefined;
  });

  return browserResult;
}

export interface McpLaunchOptions {
  userDataDir?: string;
  isolated: boolean;
  logFile?: fs.WriteStream;
  browser?: ManagedBrowser;
  browserBinaryPath?: string;
  fingerprintSeed?: number;
  proxy?: string;
  locale?: string;
  timezone?: string;
  headless?: boolean;
  blockWebRtc?: boolean;
  blockImages?: boolean;
  windowWidth?: number;
  windowHeight?: number;
}

/** Block image loading via route interception (mirrors Python's block_images).
 *  Uses resourceType() for accurate detection (catches extensionless image
 *  endpoints and query-string URLs). route.fallback() passes non-image
 *  requests to the next registered handler so instrumentation routes are
 *  not bypassed.
 */
async function blockImages(context: BrowserContext): Promise<void> {
  await context.route('**/*', route => {
    if (route.request().resourceType() === 'image') {
      return route.abort();
    }
    return route.fallback();
  });
}

export async function launch(
  options: McpLaunchOptions,
): Promise<BrowserResult> {
  const {isolated} = options;
  const managedBrowser = options.browser ?? 'chrome';

  // CloakBrowser: resolve the binary and fingerprint seed before
  // anything else. For persistent profiles the seed is persisted there so the
  // virtual identity is stable across launches; --isolated gets a fresh seed.
  //
  // Chrome, Edge, and CloakBrowser use separate persistent profile directories.
  const defaultProfileDir =
    managedBrowser === 'cloak'
      ? DEFAULT_CLOAK_DATA_DIR
      : managedBrowser === 'edge'
        ? DEFAULT_EDGE_DATA_DIR
        : DEFAULT_USER_DATA_DIR;
  const persistentProfileDir = isolated
    ? undefined
    : (options.userDataDir ?? defaultProfileDir);
  const cloakSetup =
    managedBrowser === 'cloak'
      ? await setupCloak(
          persistentProfileDir,
          options.browserBinaryPath,
          options.fingerprintSeed,
        )
      : null;
  const executablePath =
    cloakSetup?.executablePath ??
    (managedBrowser === 'edge' ? options.browserBinaryPath : undefined);

  const args: string[] = [
    '--test-type',
    '--hide-crash-restore-bubble',
    ...(options.windowWidth && options.windowHeight
      ? [`--window-size=${options.windowWidth},${options.windowHeight}`]
      : []),
    ...(cloakSetup?.args ?? []),
    // Disable WebRTC to prevent IP leaks (mirrors Python's block_webrtc option).
    ...(options.blockWebRtc
      ? ['--enforce-webrtc-ip-handling-policy=disable-non-proxied-udp']
      : []),
  ];

  // Playwright resolves installed stable Chrome/Edge by channel. CloakBrowser
  // and explicitly configured Edge builds provide their own executable path.
  const channel = executablePath
    ? undefined
    : managedBrowser === 'edge'
      ? 'msedge'
      : 'chrome';

  // Build context options. viewport:null exposes real OS dimensions (avoids
  // the 1280x720 fake-viewport bot signal). New options mirror Python version.
  const contextOptions = {
    viewport: null as null,
    ignoreHTTPSErrors: true,
    ...(options.proxy ? {proxy: {server: options.proxy}} : {}),
    ...(options.locale ? {locale: options.locale} : {}),
    ...(options.timezone ? {timezoneId: options.timezone} : {}),
  };

  // --isolated mode: launch() + newContext() for clean isolated context.
  // Creates an incognito-like context with no persisted state.
  if (isolated) {
    const browser = await chromium.launch({
      channel,
      executablePath,
      headless: options.headless ?? false,
      chromiumSandbox: true,
      args,
    });

    const context = await browser.newContext(contextOptions);
    await installConsoleBridge(context);
    if (options.blockImages) await blockImages(context);
    if (context.pages().length === 0) await context.newPage();
    return {browser, context, closeMode: 'launched'};
  }

  // Default: launchPersistentContext for full state persistence
  // (cookies, IndexedDB, Cache Storage, Service Workers, localStorage).
  // persistentProfileDir is non-undefined here because the isolated branch
  // returned above; assert via the non-null assertion to satisfy the type.
  const userDataDir = persistentProfileDir!;
  try {
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel,
      executablePath,
      headless: options.headless ?? false,
      chromiumSandbox: true,
      args,
      ...contextOptions,
    });

    await installConsoleBridge(context);
    if (options.blockImages) await blockImages(context);
    return {browser: undefined, context, closeMode: 'persistent-context'};
  } catch (error) {
    if (isBrowserOccupiedError(error)) {
      throw new Error(
        `${BROWSER_OCCUPIED_MESSAGE} The persistent browser profile is already in use: ${userDataDir}.`,
        {cause: error},
      );
    }
    throw error;
  }
}

export async function ensureBrowserLaunched(
  options: McpLaunchOptions,
): Promise<BrowserResult> {
  if (browserResult) {
    return browserResult;
  }
  browserResult = await launch(options);

  // Clear cached result when browser is manually closed so we can relaunch.
  const {browser, context} = browserResult;
  if (browser) {
    browser.on('disconnected', () => {
      logger('Browser disconnected, clearing cached browser result');
      browserResult = undefined;
    });
  } else {
    // Persistent context mode (no browser object) — listen on context.
    context.on('close', () => {
      logger('Browser context closed, clearing cached browser result');
      browserResult = undefined;
    });
  }

  return browserResult;
}

function isBrowserOccupiedError(error: unknown): boolean {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return [
    'the browser is already running',
    'processsingleton',
    'another cdp client already connected',
    'already connected',
    'already attached',
    'already in use',
  ].some(fragment => message.includes(fragment));
}

export async function closeBrowser(reason: string): Promise<void> {
  const result = browserResult;
  if (!result) {
    return;
  }
  browserResult = undefined;

  const closeReason = `MCP shutdown: ${reason}`;
  logger('Closing browser due to', closeReason);

  if (result.closeMode === 'connected-cdp' && result.browser) {
    await closeConnectedCdpBrowser(result.browser, closeReason);
    return;
  }

  if (result.closeMode === 'launched' && result.browser) {
    await result.context.close({reason: closeReason}).catch(error => {
      logger('Failed to close browser context during shutdown', error);
    });
    await result.browser.close({reason: closeReason}).catch(error => {
      logger('Failed to close browser during shutdown', error);
    });
    return;
  }

  await result.context.close({reason: closeReason}).catch(error => {
    logger('Failed to close persistent browser context during shutdown', error);
  });
}

async function closeConnectedCdpBrowser(
  browser: Browser,
  reason: string,
): Promise<void> {
  if (browser.isConnected()) {
    try {
      const session = await browser.newBrowserCDPSession();
      await session.send('Browser.close');
    } catch (error) {
      logger('Failed to send Browser.close over CDP during shutdown', error);
    }
  }

  await browser.close({reason}).catch(error => {
    logger(
      'Failed to close connected browser transport during shutdown',
      error,
    );
  });
}
