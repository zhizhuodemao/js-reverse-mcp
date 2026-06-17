/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {basename, dirname, join} from 'node:path';
import {snapshot} from 'node:test';

snapshot.setResolveSnapshotPath((testFilePath: string | undefined) => {
  if (!testFilePath) return 'unknown.snapshot';
  return join(dirname(testFilePath), `${basename(testFilePath)}.snapshot`);
});
