/**
 * @license
 * Copyright 2026
 * SPDX-License-Identifier: Apache-2.0
 */

import {randomInt} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';

interface CloakBrowserModule {
  ensureBinary(): Promise<string>;
  binaryInfo(): {installed: boolean};
}

async function loadCloakBrowser(): Promise<CloakBrowserModule> {
  try {
    return (await import('cloakbrowser')) as unknown as CloakBrowserModule;
  } catch {
    throw new Error(
      '--cloak requires the `cloakbrowser` package. ' +
        'Install it with `npm install cloakbrowser`, or re-run via ' +
        '`npx js-reverse-mcp@latest --cloak` to pull it as an optional dependency.',
    );
  }
}

/**
 * Redirect `console.log` / `console.info` to stderr for the duration of `fn`.
 *
 * MCP servers use **stdout** as the JSON-RPC channel — any non-protocol bytes
 * there corrupt the protocol and the client disconnects. cloakbrowser's
 * `ensureBinary()` writes download progress via `console.log` (stdout), so we
 * must redirect those writes to stderr while it runs. Progress is still
 * visible (stderr surfaces in the MCP client's server log panel).
 */
async function withStdoutRedirectedToStderr<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const origLog = console.log;
  const origInfo = console.info;
  console.log = (...args: unknown[]) => console.error(...args);
  console.info = (...args: unknown[]) => console.error(...args);
  try {
    return await fn();
  } finally {
    console.log = origLog;
    console.info = origInfo;
  }
}

function getOrCreateSeed(profileDir: string): number {
  const seedFile = path.join(profileDir, '.cloak-seed');
  if (existsSync(seedFile)) {
    const parsed = Number.parseInt(readFileSync(seedFile, 'utf8').trim(), 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  if (!existsSync(profileDir)) {
    mkdirSync(profileDir, {recursive: true});
  }
  const seed = randomInt(10000, 100000);
  writeFileSync(seedFile, String(seed), 'utf8');
  return seed;
}

export interface CloakSetup {
  executablePath: string;
  args: string[];
}

/**
 * Resolve the CloakBrowser binary and build the cloak-specific args.
 *
 * When profileDir is provided, the fingerprint seed is persisted there so the
 * same profile always presents the same virtual identity (a stable "returning
 * visitor"). When undefined (isolated mode), a random seed is generated for
 * this launch only.
 */
export async function setupCloak(
  profileDir: string | undefined,
): Promise<CloakSetup> {
  const cloak = await loadCloakBrowser();

  // cloakbrowser writes download progress to stdout (`console.log`).
  // We must redirect those writes to stderr to avoid corrupting the MCP
  // JSON-RPC channel — see the helper's docstring above.
  const executablePath = await withStdoutRedirectedToStderr(async () => {
    if (!cloak.binaryInfo().installed) {
      process.stderr.write(
        '[js-reverse-mcp] Downloading CloakBrowser stealth binary (~200MB, one-time setup)...\n',
      );
    }
    return cloak.ensureBinary();
  });

  const seed = profileDir
    ? getOrCreateSeed(profileDir)
    : randomInt(10000, 100000);

  // ALWAYS spoof as Windows desktop — even on macOS.
  //
  // Reason: CloakBrowser ships 57 C++ fingerprint patches for Linux/Windows
  // platform builds but only 26 for macOS (per cloak's own README — the macOS
  // build leaves real GPU strings and several other signals untouched because
  // the small pool of real Mac GPUs makes spoofed values *more* detectable
  // than real ones in their target scraping scenarios).
  //
  // For this MCP's use case (debugging strong anti-bot sites), the full
  // Windows-profile spoof is strictly better — it activates all 57 patches
  // and reports a generic Windows desktop fingerprint that anti-bot databases
  // see by the millions.
  //
  // CloakBrowser's own troubleshooting (README §"macOS: Blocked on some sites
  // that pass on Linux") explicitly recommends this when macOS profile gets
  // blocked: "switch to a Windows fingerprint profile by passing
  // stealth_args=False and manually setting --fingerprint-platform=windows".
  const platform = 'windows';

  // NOTE: We intentionally do NOT include `--no-sandbox` here even though
  // CloakBrowser's getDefaultStealthArgs adds it. Their default targets
  // Docker/Linux-CI use cases where the setuid sandbox helper isn't available.
  // This MCP is a desktop debugging tool — the OS sandbox works fine,
  // and `--no-sandbox` triggers Chrome's "unsupported command-line flag"
  // infobar that hangs over every tab.
  return {
    executablePath,
    args: [`--fingerprint=${seed}`, `--fingerprint-platform=${platform}`],
  };
}
