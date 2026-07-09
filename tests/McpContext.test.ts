/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {McpContext} from '../src/McpContext.js';

function createContext(browserContext: {pages(): unknown[]}): McpContext {
  return Reflect.construct(McpContext as unknown as abstract new (
    ...args: unknown[]
  ) => McpContext, [
    browserContext,
    (() => {}) as unknown,
    {experimentalDevToolsDebugging: false},
  ]);
}

function createPage() {
  return {
    on() {},
    off() {},
    isClosed() {
      return false;
    },
    url() {
      return 'https://example.com';
    },
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
  };
}

test('createPagesSnapshot handles an empty page list without selecting undefined', async () => {
  const context = createContext({
    pages() {
      return [];
    },
  });

  const pages = await context.createPagesSnapshot();

  assert.deepEqual(pages, []);
  assert.throws(() => context.getSelectedPage(), /No page selected/);
});

test('createPagesSnapshot clears the selected page when the page list becomes empty', async () => {
  const page = createPage();
  let pages = [page];
  const context = createContext({
    pages() {
      return pages;
    },
  });

  await context.createPagesSnapshot();
  assert.equal(context.getSelectedPage(), page);

  pages = [];
  const nextPages = await context.createPagesSnapshot();

  assert.deepEqual(nextPages, []);
  assert.throws(() => context.getSelectedPage(), /No page selected/);
});

test('selectPage rejects undefined pages', () => {
  const context = createContext({
    pages() {
      return [];
    },
  });

  assert.throws(
    () => context.selectPage(undefined as unknown as never),
    /Cannot select an undefined page/,
  );
});
