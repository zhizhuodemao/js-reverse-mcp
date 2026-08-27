/**
 * @license
 * Copyright 2026
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

import {loadBrowserConnectionConfig} from '../src/browserConfig.js';

test('loads persisted browser and binary defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'js-reverse-config-'));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      browser: 'cloak',
      cloakBinaryPath: 'E:/mcps/CloakBrowser/chrome.exe',
    }),
  );

  assert.deepEqual(loadBrowserConnectionConfig(configFile), {
    browser: 'cloak',
    cloakBinaryPath: 'E:/mcps/CloakBrowser/chrome.exe',
    edgeBinaryPath: undefined,
  });
});

test('ignores malformed browser config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'js-reverse-config-'));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({browser: 'firefox'}));

  assert.deepEqual(loadBrowserConnectionConfig(configFile), {
    browser: undefined,
    cloakBinaryPath: undefined,
    edgeBinaryPath: undefined,
  });
});
