/**
 * @license
 * Copyright 2026
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import type {McpContext} from '../../src/McpContext.js';
import {McpResponse} from '../../src/McpResponse.js';
import {
  browserBinaryInfo,
  checkBrowserUpdate,
  launchBrowser,
  listTraceFiles,
  queryTraceFile,
  rewriteInstrumentedSource,
  updateBrowserBinary,
} from '../../src/tools/cloakCompat.js';
import {boolParam, intParam, stringParam} from '../../src/tools/paramHelpers.js';

test('AST instrumentation rewrites safe member reads only', () => {
  const result = rewriteInstrumentedSource(
    `const ua = navigator.userAgent;
     navigator.userAgent = 'patched';
     navigator.getBattery();
     const literal = 'navigator.userAgent';`,
    {
      tag: 'probe',
      mode: 'ast',
      rewriteMemberAccess: true,
      maxRewrites: 20,
      filterPropertyNames: ['userAgent'],
      filterObjectNames: ['navigator'],
      fallbackOnError: false,
    },
  );

  assert.equal(result.mode, 'ast');
  assert.equal(result.edits, 1);
  assert.match(
    result.source,
    /__mcp_tap_get\("probe","navigator\.userAgent",navigator\.userAgent\)/,
  );
  assert.match(result.source, /navigator\.userAgent=["']patched["']/);
  assert.match(result.source, /navigator\.getBattery\(\)/);
  assert.match(result.source, /["']navigator\.userAgent["']/);
});

test('AST instrumentation falls back to scanner on parse errors', () => {
  const result = rewriteInstrumentedSource(
    'const broken = ; navigator.userAgent;',
    {
      tag: 'probe',
      mode: 'ast',
      rewriteMemberAccess: true,
      maxRewrites: 20,
      filterPropertyNames: ['userAgent'],
      filterObjectNames: ['navigator'],
      fallbackOnError: true,
    },
  );

  assert.equal(result.mode, 'regex');
  assert.equal(result.edits, 1);
  assert.match(result.fallbackReason ?? '', /Unexpected token/);
});

// boolParam: OpenCode-style string boolean coercion
test('boolParam coerces string "true"/"false" to boolean', () => {
  const schema = boolParam();
  assert.equal(schema.parse('true'), true);
  assert.equal(schema.parse('false'), false);
  assert.equal(schema.parse('TRUE'), true);
  assert.equal(schema.parse('  false  '), false);
});

test('boolParam passes through real booleans', () => {
  const schema = boolParam().optional().default(false);
  assert.equal(schema.parse(true), true);
  assert.equal(schema.parse(false), false);
  assert.equal(schema.parse(undefined), false);
});

test('boolParam rejects invalid strings', () => {
  const schema = boolParam();
  assert.throws(() => schema.parse('yes'), /Expected boolean/);
  assert.throws(() => schema.parse(1), /Expected boolean/);
});

// intParam: 0 → undefined coercion
test('intParam coerces 0 to undefined', () => {
  const schema = intParam().optional();
  assert.equal(schema.parse(0), undefined);
  assert.equal(schema.parse(12), 12);
  assert.equal(schema.parse('7'), 7);
  assert.equal(schema.parse('0'), undefined);
});

// stringParam: empty string → undefined coercion
test('stringParam coerces empty/blank to undefined', () => {
  const schema = stringParam().optional();
  assert.equal(schema.parse(''), undefined);
  assert.equal(schema.parse('  '), undefined);
  assert.equal(schema.parse('hello'), 'hello');
});

test('browser control/info tools do not require a browser context', () => {
  assert.equal(browserBinaryInfo.requiresBrowserContext, false);
  assert.equal(checkBrowserUpdate.requiresBrowserContext, false);
  assert.equal(updateBrowserBinary.requiresBrowserContext, false);
  assert.equal(launchBrowser.requiresBrowserContext, false);
  assert.equal(listTraceFiles.requiresBrowserContext, false);
  assert.equal(queryTraceFile.requiresBrowserContext, false);
});

test('launch_browser reports configured state before a browser exists', async () => {
  const frame = {url: () => 'about:blank', name: () => ''};
  const page = {url: () => 'about:blank', mainFrame: () => frame};
  const context = {
    getPages: () => [],
    getSelectedPage: () => page,
  } as unknown as McpContext;
  const response = new McpResponse();

  await launchBrowser.handler({params: {}}, response, context);

  assert.match(response.responseLines.join('\n'), /"status": "configured"/);
});
