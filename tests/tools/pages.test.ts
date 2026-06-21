/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {waitForNavigationOrPause} from '../../src/tools/pages.js';

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
