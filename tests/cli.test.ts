/**
 * @license
 * Copyright 2026
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {parseArguments} from '../src/cli.js';

test('--edge selects the installed Edge channel', () => {
  const parsed = parseArguments('test', ['node', 'cli', '--edge']);

  assert.equal(parsed.edge, true);
  assert.equal(parsed.edgeBinaryPath, undefined);
  assert.equal(parsed.cloak, undefined);
});

test('--edgeBinaryPath implicitly enables Edge', () => {
  const edgePath =
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const parsed = parseArguments('test', [
    'node',
    'cli',
    '--edgeBinaryPath',
    edgePath,
  ]);

  assert.equal(parsed.edge, true);
  assert.equal(parsed.edgeBinaryPath, edgePath);
  assert.equal(parsed.cloak, undefined);
});

test('--cloakBinaryPath continues to implicitly enable CloakBrowser', () => {
  const cloakPath = 'D:\\CloakBrowser\\chrome.exe';
  const parsed = parseArguments('test', [
    'node',
    'cli',
    '--cloakBinaryPath',
    cloakPath,
  ]);

  assert.equal(parsed.cloak, true);
  assert.equal(parsed.cloakBinaryPath, cloakPath);
  assert.equal(parsed.edge, undefined);
});
