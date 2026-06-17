/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export enum ToolCategory {
  NAVIGATION = 'navigation',
  BROWSER_STATE = 'browser_state',
  NETWORK = 'network',
  DEBUGGING = 'debugging',
  REVERSE_ENGINEERING = 'reverse_engineering',
}

export const labels = {
  [ToolCategory.NAVIGATION]: 'Navigation automation',
  [ToolCategory.BROWSER_STATE]: 'Browser state',
  [ToolCategory.NETWORK]: 'Network',
  [ToolCategory.DEBUGGING]: 'Debugging',
  [ToolCategory.REVERSE_ENGINEERING]: 'JS Reverse Engineering',
};
