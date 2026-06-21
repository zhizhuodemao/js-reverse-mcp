/**
 * @license
 * Copyright 2025 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {Mutex} from '../src/Mutex.js';

test('mutex acquire can time out while another caller holds the lock', async () => {
  const mutex = new Mutex();
  const guard = await mutex.acquire();

  await assert.rejects(
    () => mutex.acquire({timeoutMs: 1}),
    /Timed out waiting for another tool call to finish/,
  );

  guard.dispose();
  const nextGuard = await mutex.acquire({timeoutMs: 100});
  nextGuard.dispose();
});
