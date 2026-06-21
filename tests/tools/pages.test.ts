/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {navigatePage, waitForNavigationOrPause} from '../../src/tools/pages.js';

function createDebuggerState() {
  let enabled = true;
  let paused = false;
  return {
    debugger_: {
      isEnabled: () => enabled,
      isPaused: () => paused,
    },
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    setPaused: (value: boolean) => {
      paused = value;
    },
  };
}

test('waits for navigation when debugger does not pause', async () => {
  const state = createDebuggerState();

  const result = await waitForNavigationOrPause(
    Promise.resolve(),
    state.debugger_,
  );

  assert.deepEqual(result, {status: 'completed'});
});

test('returns paused when debugger pauses before navigation completes', async () => {
  const state = createDebuggerState();
  const navigation = new Promise(() => undefined);

  setTimeout(() => {
    state.setPaused(true);
  }, 0);

  const result = await waitForNavigationOrPause(navigation, state.debugger_);

  assert.deepEqual(result, {status: 'paused'});
});

test('navigate_page can return paused without auto-resuming', async () => {
  let resumeCalls = 0;
  let reloadCalls = 0;
  let clearScriptsCalls = 0;
  let includePages = false;
  const lines: string[] = [];

  await navigatePage.handler(
    {params: {type: 'reload'}},
    {
      appendResponseLine: (value: string) => lines.push(value),
      setIncludePages: (value: boolean) => {
        includePages = value;
      },
    } as never,
    {
      getSelectedPage: () => ({
        reload: () => {
          reloadCalls++;
          return new Promise(() => undefined);
        },
        url: () => 'https://example.test/',
      }),
      debuggerContext: {
        isEnabled: () => true,
        isPaused: () => true,
        clearScripts: () => {
          clearScriptsCalls++;
        },
        resume: () => {
          resumeCalls++;
          return Promise.resolve();
        },
      },
    } as never,
  );

  assert.equal(resumeCalls, 0);
  assert.equal(reloadCalls, 1);
  assert.equal(clearScriptsCalls, 1);
  assert.equal(includePages, true);
  assert.match(lines.join('\n'), /paused at a breakpoint/);
});
