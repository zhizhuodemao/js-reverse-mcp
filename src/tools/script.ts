/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {zod} from '../third_party/index.js';
import type {JSHandle} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './ToolDefinition.js';

// Default script evaluation timeout in milliseconds (30 seconds)
const DEFAULT_SCRIPT_TIMEOUT = 30000;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

export const evaluateScript = defineTool({
  name: 'evaluate_script',
  description: `Evaluate a JavaScript function inside the currently selected page. Returns the response as JSON
so returned values have to JSON-serializable. When execution is paused at a breakpoint, automatically evaluates in the paused call frame context.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    function: zod.string().describe(
      `A JavaScript function declaration to be executed by the tool in the currently selected page.
Example without arguments: \`() => {
  return document.title
}\` or \`async () => {
  return await fetch("example.com")
}\`.
Example with arguments: \`(el) => {
  return el.innerText;
}\`
`,
    ),
  },
  handler: async (request, response, context) => {
    // When paused at a breakpoint, evaluate in the paused call frame context
    // to avoid a 30s timeout that would confuse the agent.
    const debugger_ = context.debuggerContext;
    if (debugger_.isEnabled() && debugger_.isPaused()) {
      const pausedState = debugger_.getPausedState();
      const callFrameId = pausedState.callFrames[0]?.callFrameId;
      if (callFrameId) {
        const expression = `(async () => JSON.stringify(await (${request.params.function})()))()`;
        const result = await debugger_.evaluateOnCallFrame(
          callFrameId,
          expression,
          {returnByValue: true, awaitPromise: true},
        );

        if (result.exceptionDetails) {
          const errMsg =
            result.exceptionDetails.exception?.description ||
            result.exceptionDetails.text;
          throw new Error(`Script evaluation error: ${errMsg}`);
        }

        const value = result.result.value as string | undefined;
        response.appendResponseLine(
          'Script ran on page (paused context) and returned:',
        );
        response.appendResponseLine('```json');
        response.appendResponseLine(`${value ?? 'undefined'}`);
        response.appendResponseLine('```');
        return;
      }
    }

    let fn: JSHandle<unknown> | undefined;
    try {
      const frame = context.getSelectedFrame();
      fn = await withTimeout(
        frame.evaluateHandle(`(${request.params.function})`),
        DEFAULT_SCRIPT_TIMEOUT,
        'Script evaluation timed out',
      );
      await context.waitForEventsAfterAction(async () => {
        const result = await withTimeout(
          frame.evaluate(async fn => {
            // @ts-expect-error no types.
            return JSON.stringify(await fn());
          }, fn),
          DEFAULT_SCRIPT_TIMEOUT,
          'Script execution timed out',
        );
        response.appendResponseLine('Script ran on page and returned:');
        response.appendResponseLine('```json');
        response.appendResponseLine(`${result}`);
        response.appendResponseLine('```');
      });
    } finally {
      if (fn) {
        void fn.dispose();
      }
    }
  },
});
