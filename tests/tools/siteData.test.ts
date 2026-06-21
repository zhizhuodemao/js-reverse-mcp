/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {clearSiteData} from '../../src/tools/siteData.js';

test('clear_site_data fails fast while execution is paused', async () => {
  await assert.rejects(
    () =>
      clearSiteData.handler(
        {params: {}},
        {} as never,
        {
          debuggerContext: {
            isEnabled: () => true,
            isPaused: () => true,
          },
        } as never,
      ),
    /clear_site_data needs page JavaScript/,
  );
});
