/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {setupCloak} from './cloak.js';
import {logger} from './logger.js';
import type {Browser, BrowserContext} from './third_party/index.js';
import {chromium} from './third_party/index.js';

export interface BrowserResult {
  browser: Browser | undefined;
  context: BrowserContext;
}

let browserResult: BrowserResult | undefined;

// Persistent user data directories.
//
// IMPORTANT: cloak and non-cloak profiles MUST be physically isolated. They
// use different Chromium binaries with different feature sets — mixing state
// (extensions, shader cache, service workers) across them causes startup
// races and broken sessions. Pick the directory based on whether --cloak is
// set; never share.
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
  const json = (await res.json()) as {webSocketDebuggerUrl: string};
  const endpoint = json.webSocketDebuggerUrl;

  logger('Connecting Patchright via CDP to', endpoint);
  const browser = await chromium.connectOverCDP(endpoint);
  logger('Connected Patchright');

  const context = browser.contexts()[0];
  if (!context) {
    throw new Error('No browser context found after connecting');
  }

  browserResult = {browser, context};

  // Clear cached result when browser disconnects so we can reconnect.
  browser.on('disconnected', () => {
    logger('Browser disconnected, clearing cached browser result');
    browserResult = undefined;
  });

  return browserResult;
}

interface McpLaunchOptions {
  userDataDir?: string;
  isolated: boolean;
  logFile?: fs.WriteStream;
  cloak?: boolean;
}

export async function launch(
  options: McpLaunchOptions,
): Promise<BrowserResult> {
  const {isolated} = options;

  // --cloak: resolve the CloakBrowser binary and fingerprint seed before
  // anything else. For persistent profiles the seed is persisted there so the
  // virtual identity is stable across launches; --isolated gets a fresh seed.
  //
  // Cloak and non-cloak modes use SEPARATE persistent profile directories —
  // they're different browsers with different feature sets, sharing profile
  // state breaks both.
  const persistentProfileDir = isolated
    ? undefined
    : (options.userDataDir ??
      (options.cloak ? DEFAULT_CLOAK_DATA_DIR : DEFAULT_USER_DATA_DIR));
  const cloakSetup = options.cloak
    ? await setupCloak(persistentProfileDir)
    : null;
  const executablePath = cloakSetup?.executablePath;

  const args: string[] = [
    // UX flags (not stealth):
    //   --test-type tells Chrome it's running under an automation harness,
    //   which suppresses ALL "unsupported command-line flag" yellow banners
    //   that would otherwise appear for every flag Patchright/cloak add
    //   (--no-sandbox, --disable-blink-features=AutomationControlled,
    //   --disable-features=..., etc.). Without this you get a fresh banner
    //   on top of every page. Do NOT remove as part of any "stealth cleanup":
    //   this is purely a banner suppressor, not a config-level fingerprint.
    //   --hide-crash-restore-bubble hides the "Chrome didn't shut down
    //   correctly" bubble that appears whenever the MCP is killed/restarted.
    '--test-type',
    '--hide-crash-restore-bubble',
    ...(cloakSetup?.args ?? []),
  ];

  // System Chrome stable when not using cloak; cloak provides its own binary.
  const channel = executablePath ? undefined : 'chrome';

  // viewport: null disables Playwright's viewport emulation, exposing real
  // OS window/screen dimensions (avoids the 1280x720 fake-viewport bot signal).
  const contextOptions = {
    viewport: null,
    ignoreHTTPSErrors: true,
  };

  // --isolated mode: launch() + newContext() for clean isolated context.
  // Creates an incognito-like context with no persisted state.
  if (isolated) {
    const browser = await chromium.launch({
      channel,
      executablePath,
      headless: false,
      chromiumSandbox: true,
      args,
    });

    const context = await browser.newContext(contextOptions);

    if (context.pages().length === 0) {
      await context.newPage();
    }

    return {browser, context};
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
      headless: false,
      chromiumSandbox: true,
      args,
      ...contextOptions,
    });

    return {browser: undefined, context};
  } catch (error) {
    if ((error as Error).message.includes('The browser is already running')) {
      throw new Error(
        `The browser is already running for ${userDataDir}. Use --isolated to run a separate browser instance.`,
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
