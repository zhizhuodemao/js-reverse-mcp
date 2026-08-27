/**
 * @license
 * Copyright 2026
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';

import type {ManagedBrowser} from './browser.js';

const MANAGED_BROWSERS = new Set<ManagedBrowser>(['chrome', 'edge', 'cloak']);

export interface BrowserConnectionConfig {
  browser?: ManagedBrowser;
  cloakBinaryPath?: string;
  edgeBinaryPath?: string;
}

const MCP_ROOT =
  path.basename(path.dirname(import.meta.dirname)) === 'build'
    ? path.resolve(import.meta.dirname, '../..')
    : path.resolve(import.meta.dirname, '..');

export const BROWSER_CONFIG_FILE = path.join(
  MCP_ROOT,
  'browser-connection',
  'config.json',
);

export function loadBrowserConnectionConfig(
  filePath = BROWSER_CONFIG_FILE,
): BrowserConnectionConfig {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    const browser = parseBrowser(config.browser);
    const cloakBinaryPath = parseNonEmptyString(config.cloakBinaryPath);
    const edgeBinaryPath = parseNonEmptyString(config.edgeBinaryPath);
    return {browser, cloakBinaryPath, edgeBinaryPath};
  } catch {
    return {};
  }
}

function parseBrowser(value: unknown): ManagedBrowser | undefined {
  if (typeof value !== 'string') return undefined;
  return MANAGED_BROWSERS.has(value as ManagedBrowser)
    ? (value as ManagedBrowser)
    : undefined;
}

function parseNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
