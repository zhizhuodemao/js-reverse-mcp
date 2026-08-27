/**
 * @license
 * Copyright 2026
 * SPDX-License-Identifier: Apache-2.0
 */

import {randomInt} from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SEED_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

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
  // Read existing seed (fast path — no lock needed for reads)
  const existingSeed = readSeedFile(seedFile);
  if (existingSeed !== undefined) return existingSeed;
  if (!existsSync(profileDir)) mkdirSync(profileDir, {recursive: true});
  const seed = randomInt(10000, 100000);
  // Use exclusive-create (O_EXCL) to win a potential startup race.
  // If another process created the file between our existsSync and here,
  // openSync throws — we fall back to reading the winner's seed instead.
  try {
    const fd = openSync(seedFile, 'wx');
    writeFileSync(fd, String(seed), 'utf8');
    closeSync(fd);
    return seed;
  } catch {
    // Another instance created the file first. It may not have finished writing
    // yet, so wait briefly for a valid seed instead of using a divergent local
    // random seed for the same persistent profile.
    const winnerSeed = waitForSeedFile(seedFile);
    if (winnerSeed !== undefined) return winnerSeed;
    throw new Error(
      `Failed to read CloakBrowser fingerprint seed: ${seedFile}`,
    );
  }
}

function readSeedFile(seedFile: string): number | undefined {
  if (!existsSync(seedFile)) return undefined;
  const parsed = Number.parseInt(readFileSync(seedFile, 'utf8').trim(), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function waitForSeedFile(seedFile: string): number | undefined {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    const parsed = readSeedFile(seedFile);
    if (parsed !== undefined) return parsed;
    // Atomics.wait() is allowed on the Node.js main thread (unlike browsers).
    // It blocks synchronously for 10 ms — intentional here since this entire
    // function is synchronous and we need to spin-wait for a concurrent write
    // to complete. Only reachable on the extremely rare path where two MCP
    // processes start simultaneously with the same profile directory.
    Atomics.wait(SEED_WAIT_BUFFER, 0, 0, 10);
  }
  return readSeedFile(seedFile);
}

function resolveExplicitBinaryPath(binaryPath: string): string {
  const expanded = binaryPath.startsWith('~')
    ? path.join(os.homedir(), binaryPath.slice(1))
    : binaryPath;
  const resolved = path.resolve(expanded);
  if (!existsSync(resolved)) {
    throw new Error(`CloakBrowser binary does not exist: ${resolved}`);
  }
  return resolved;
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
 *
 * When fingerprintSeed is provided, it overrides both the persisted and random
 * seed — useful for reproducing a specific virtual identity across launches.
 */
export async function setupCloak(
  profileDir: string | undefined,
  binaryPath: string | undefined,
  fingerprintSeed?: number,
): Promise<CloakSetup> {
  const executablePath = binaryPath
    ? resolveExplicitBinaryPath(binaryPath)
    : await resolveDownloadedBinaryPath();

  let seed: number;
  if (fingerprintSeed !== undefined) {
    seed = fingerprintSeed;
    // Also persist the explicit seed so the profile stays consistent.
    if (profileDir) {
      if (!existsSync(profileDir)) mkdirSync(profileDir, {recursive: true});
      writeFileSync(path.join(profileDir, '.cloak-seed'), String(seed), 'utf8');
    }
  } else {
    seed = profileDir ? getOrCreateSeed(profileDir) : randomInt(10000, 100000);
  }

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

async function resolveDownloadedBinaryPath(): Promise<string> {
  const cloak = await loadCloakBrowser();

  // cloakbrowser writes download progress to stdout (`console.log`).
  // We must redirect those writes to stderr to avoid corrupting the MCP
  // JSON-RPC channel — see the helper's docstring above.
  return await withStdoutRedirectedToStderr(async () => {
    if (!cloak.binaryInfo().installed) {
      process.stderr.write(
        '[js-reverse-mcp] Downloading CloakBrowser stealth binary (~200MB, one-time setup)...\n',
      );
    }
    return cloak.ensureBinary();
  });
}
