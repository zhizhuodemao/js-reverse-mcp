/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {YargsOptions} from './third_party/index.js';
import {yargs, hideBin} from './third_party/index.js';

export const cliOptions = {
  browserUrl: {
    type: 'string',
    description:
      'Connect to a running Chrome instance via CDP HTTP endpoint (e.g., http://127.0.0.1:9222). The MCP will probe the endpoint to find the WebSocket debugger URL.',
    alias: 'u',
    coerce: (url: string | undefined) => {
      if (!url) {
        return;
      }
      try {
        new URL(url);
      } catch {
        throw new Error(`Provided browserUrl ${url} is not valid URL.`);
      }
      return url;
    },
  },
  isolated: {
    type: 'boolean',
    description:
      'Create a temporary user-data-dir that is auto-cleaned when the browser closes. Use this for runs where you do NOT want cookies/localStorage to persist into your default profile.',
    default: false,
  },
  logFile: {
    type: 'string',
    describe:
      'Path to a file to write debug logs to. Set the env variable `DEBUG` to `*` to enable verbose logs. Useful for submitting bug reports.',
  },
  cloak: {
    type: 'boolean',
    description:
      'Use CloakBrowser stealth-patched Chromium instead of system Chrome. ' +
      'Adds source-level fingerprint patches (canvas/WebGL/audio/GPU). ' +
      'Binary auto-downloads (~200MB) on first use unless --cloakBinaryPath is set. Identity is persisted ' +
      'per profile in <profile>/.cloak-seed.',
    // No `default: false` here on purpose: yargs treats a defaulted boolean as
    // "set", which makes `conflicts` fire even when the user only passed
    // `--browserUrl`. Leaving it undefined keeps the conflict check honest.
    conflicts: ['browserUrl', 'edge', 'edgeBinaryPath'],
  },
  cloakBinaryPath: {
    type: 'string',
    description:
      'Path to an existing CloakBrowser/Chromium executable for --cloak. ' +
      'When provided, js-reverse-mcp uses it directly and skips cloakbrowser auto-download.',
    conflicts: ['browserUrl', 'edge', 'edgeBinaryPath'],
  },
  edge: {
    type: 'boolean',
    description:
      'Use installed Microsoft Edge instead of system Chrome. Edge uses its own persistent profile directory.',
    conflicts: ['browserUrl', 'cloak', 'cloakBinaryPath'],
  },
  edgeBinaryPath: {
    type: 'string',
    description:
      'Path to a Microsoft Edge executable. When omitted, the installed stable Edge channel is used.',
    conflicts: ['browserUrl', 'cloak', 'cloakBinaryPath'],
  },
  proxy: {
    type: 'string',
    description:
      'Proxy server for the browser, e.g. http://host:port or socks5://host:port. ' +
      'Supports optional username/password: http://user:pass@host:port.',
  },
  locale: {
    type: 'string',
    description:
      'Browser locale, e.g. zh-CN, en-US. Affects navigator.language and Accept-Language header.',
  },
  timezone: {
    type: 'string',
    description:
      'Browser timezone ID, e.g. Asia/Shanghai, America/New_York. Affects Date/Intl APIs.',
  },
  fingerprintSeed: {
    type: 'number',
    description:
      'Override the CloakBrowser fingerprint seed (integer 10000–99999). ' +
      'Only effective with --cloak. Useful for reproducing a specific virtual identity.',
    conflicts: ['browserUrl'],
    coerce: (seed: number | undefined) => {
      if (seed === undefined) return seed;
      if (!Number.isInteger(seed) || seed < 10000 || seed > 99999) {
        throw new Error(
          'fingerprintSeed must be an integer between 10000 and 99999.',
        );
      }
      return seed;
    },
  },
  headless: {
    type: 'boolean',
    description: 'Launch the browser in headless mode (no visible window).',
    default: false,
  },
  blockWebRtc: {
    type: 'boolean',
    description:
      'Disable WebRTC to prevent IP leaks through STUN/TURN. ' +
      'Adds --enforce-webrtc-ip-handling-policy=disable-non-proxied-udp.',
    default: false,
  },
  blockImages: {
    type: 'boolean',
    description: 'Block image resource loading to speed up navigation.',
    default: false,
  },
  windowWidth: {
    type: 'number',
    description: 'Browser window/viewport width in pixels (default 1920).',
    default: 1920,
  },
  windowHeight: {
    type: 'number',
    description: 'Browser window/viewport height in pixels (default 1080).',
    default: 1080,
  },
  humanize: {
    type: 'boolean',
    description:
      'Enable human-like mouse movement, typing delays, and scroll bursts. ' +
      'Makes click/type_text/human_scroll tools simulate natural human input.',
    default: false,
  },
  humanPreset: {
    type: 'string',
    choices: ['default', 'careful'],
    description:
      'Human behavior preset: default (normal speed) or careful (slower, more pauses).',
    default: 'default',
  },
  geoip: {
    type: 'boolean',
    description:
      'Auto-detect locale and timezone from the proxy exit IP (requires --proxy). ' +
      'Overrides --locale and --timezone if lookup succeeds.',
    default: false,
  },
} satisfies Record<string, YargsOptions>;

export function parseArguments(version: string, argv = process.argv) {
  const yargsInstance = yargs(hideBin(argv))
    .scriptName('npx js-reverse-mcp@latest')
    .options(cliOptions)
    .example([
      [
        '$0',
        'Launch system Chrome (stable) with the default persistent profile',
      ],
      [
        '$0 --cloak',
        'Use CloakBrowser stealth-patched Chromium (source-level fingerprint patches)',
      ],
      [
        '$0 --cloak --cloakBinaryPath D:\\develop_software\\CloakBrowser\\chrome.exe',
        'Use an existing local CloakBrowser binary without auto-download',
      ],
      ['$0 --edge', 'Launch installed Microsoft Edge with a separate profile'],
      [
        '$0 --edgeBinaryPath "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"',
        'Launch a specific Microsoft Edge executable',
      ],
      [
        '$0 --isolated',
        'Run with a throwaway profile (no cookies/localStorage saved)',
      ],
      [
        '$0 --browserUrl http://127.0.0.1:9222',
        'Connect to a running Chrome instance instead of launching a new one',
      ],
      ['$0 --logFile /tmp/log.txt', 'Save debug logs to a file'],
      ['$0 --help', 'Print CLI options'],
    ]);

  const parsed = yargsInstance
    .wrap(Math.min(120, yargsInstance.terminalWidth()))
    .help()
    .version(version)
    .parseSync();

  if (parsed.cloakBinaryPath) {
    parsed.cloak = true;
  }
  if (parsed.edgeBinaryPath) {
    parsed.edge = true;
  }

  return parsed;
}
