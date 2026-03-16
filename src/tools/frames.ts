/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Frame} from '../third_party/index.js';
import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './ToolDefinition.js';

function getFrameDepth(frame: Frame): number {
  let depth = 0;
  let parent = frame.parentFrame();
  while (parent) {
    depth++;
    parent = parent.parentFrame();
  }
  return depth;
}

/**
 * List frames or select a frame for code execution.
 */
export const selectFrame = defineTool({
  name: 'select_frame',
  description:
    'Lists all frames (including iframes) in the current page. Pass frameIdx to switch execution context to that frame for evaluate_script and other tools.',
  annotations: {
    title: 'Select Frame',
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    frameIdx: zod
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'The frame index to select. 0 = main frame. If omitted, lists all frames without changing selection.',
      ),
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    const frames = page.frames();
    const currentFrame = context.getSelectedFrame();

    if (request.params.frameIdx === undefined) {
      // List mode
      if (frames.length === 0) {
        response.appendResponseLine('No frames found.');
        return;
      }

      response.appendResponseLine(`Frames (${frames.length} total):\n`);

      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        const isSelected = frame === currentFrame;
        const indent = getFrameDepth(frame);
        const prefix = '  '.repeat(indent);
        const marker = isSelected ? ' [selected]' : '';
        const name = frame.name() ? ` name="${frame.name()}"` : '';
        response.appendResponseLine(
          `${prefix}${i}: ${frame.url() || '(empty)'}${name}${marker}`,
        );
      }
      return;
    }

    // Select mode
    const {frameIdx} = request.params;

    if (frameIdx >= frames.length) {
      response.appendResponseLine(
        `Invalid frame index ${frameIdx}. Available: 0-${frames.length - 1}.`,
      );
      return;
    }

    const frame = frames[frameIdx];

    if (frameIdx === 0) {
      context.resetSelectedFrame();
      response.appendResponseLine('Switched to main frame.');
    } else {
      context.selectFrame(frame);
      const name = frame.name() ? ` (name: "${frame.name()}")` : '';
      response.appendResponseLine(
        `Switched to frame ${frameIdx}: ${frame.url()}${name}`,
      );
    }
  },
});
