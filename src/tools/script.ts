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
    mainWorld: zod
      .boolean()
      .optional()
      .default(false)
      .describe(
        'Execute the function in the page main world instead of the default isolated context. ' +
          'Use this when you need to access page-defined globals (e.g. window.bdms, window.app). ' +
          'The function must be synchronous and return a JSON-serializable value.',
      ),
    frameIndex: zod
      .number()
      .int()
      .optional()
      .describe(
        'When paused at a breakpoint, which call frame to evaluate in (0 = top frame). ' +
          'If omitted, uses the top frame. Use get_paused_info to see available frames.',
      ),
    outputFile: zod
      .string()
      .optional()
      .describe(
        'If provided, saves the evaluation result to this local file path instead of returning it in the chat. Useful for dumping large data, ArrayBuffer, or Uint8Array memory regions. The script should return the data you want to dump.',
      ),
  },
  handler: async (request, response, context) => {
    const {function: fnString, mainWorld, frameIndex, outputFile} = request.params;

    const wrapResultSync = (fn: string) => `(() => {
      try {
        const result = (${fn})();
        if (result instanceof ArrayBuffer || ArrayBuffer.isView(result)) {
          const buffer = result.buffer || result;
          const bytes = new Uint8Array(buffer, result.byteOffset || 0, result.byteLength || result.length);
          let binary = '';
          const chunkSize = 8192;
          for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
          }
          return JSON.stringify({ type: 'base64', data: btoa(binary) });
        }
        return JSON.stringify({ type: 'json', data: JSON.stringify(result) });
      } catch (e) {
        return JSON.stringify({ type: 'error', data: e.message || String(e) });
      }
    })()`;

    const wrapResultAsync = (fn: string) => `async () => {
      try {
        const result = await (${fn})();
        if (result instanceof ArrayBuffer || ArrayBuffer.isView(result)) {
          const buffer = result.buffer || result;
          const bytes = new Uint8Array(buffer, result.byteOffset || 0, result.byteLength || result.length);
          if (typeof FileReader !== 'undefined' && typeof Blob !== 'undefined') {
            const blob = new Blob([bytes]);
            return await new Promise((resolve) => {
              const reader = new FileReader();
              reader.onload = () => resolve(JSON.stringify({ type: 'base64', data: reader.result.split(',')[1] }));
              reader.readAsDataURL(blob);
            });
          } else {
            let binary = '';
            const chunkSize = 8192;
            for (let i = 0; i < bytes.length; i += chunkSize) {
              binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
            }
            return JSON.stringify({ type: 'base64', data: btoa(binary) });
          }
        }
        return JSON.stringify({ type: 'json', data: JSON.stringify(result) });
      } catch (e) {
        return JSON.stringify({ type: 'error', data: e.message || String(e) });
      }
    }`;

    const handleEvalResult = async (rawString: string) => {
      let parsed: { type: string, data: string };
      try {
        parsed = JSON.parse(rawString);
      } catch {
        parsed = { type: 'json', data: rawString };
      }
      
      if (parsed.type === 'error') {
        throw new Error(`Script evaluation error: ${parsed.data}`);
      }

      if (outputFile) {
        if (parsed.type === 'base64') {
          const binaryData = Buffer.from(parsed.data, 'base64');
          const res = await context.saveFile(binaryData, outputFile);
          response.appendResponseLine(`Saved binary memory dump to ${res.filename} (${binaryData.length} bytes).`);
        } else {
          const textData = new TextEncoder().encode(parsed.data === undefined ? 'undefined' : parsed.data);
          const res = await context.saveFile(textData, outputFile);
          response.appendResponseLine(`Saved JSON result to ${res.filename} (${textData.length} bytes).`);
        }
        return;
      }

      response.appendResponseLine('Script ran on page and returned:');
      if (parsed.type === 'base64') {
        response.appendResponseLine(`[Binary Data: ${Buffer.from(parsed.data, 'base64').length} bytes. Use outputFile to save to disk.]`);
      } else {
        response.appendResponseLine('```json');
        response.appendResponseLine(`${parsed.data ?? 'undefined'}`);
        response.appendResponseLine('```');
      }
    };

    const debugger_ = context.debuggerContext;
    if (debugger_.isEnabled() && debugger_.isPaused()) {
      const pausedState = debugger_.getPausedState();
      const frameIdx = frameIndex ?? 0;
      if (frameIdx < 0 || frameIdx >= pausedState.callFrames.length) {
        throw new Error(
          `frameIndex ${frameIdx} is out of range (0-${pausedState.callFrames.length - 1})`,
        );
      }
      const callFrameId = pausedState.callFrames[frameIdx]?.callFrameId;
      if (callFrameId) {
        const result = await debugger_.evaluateOnCallFrame(
          callFrameId,
          wrapResultSync(fnString),
          {returnByValue: true},
        );

        if (result.exceptionDetails) {
          const errMsg =
            result.exceptionDetails.exception?.description ||
            result.exceptionDetails.text;
          throw new Error(`Script evaluation error: ${errMsg}`);
        }

        await handleEvalResult(result.result.value as string);
        return;
      }
    }

    if (mainWorld) {
      const frame = context.getSelectedFrame();
      const bridgeId = `__mcp_bridge_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const result = await withTimeout(
        frame.evaluate(async ({fn, id}) => {
          const el = document.createElement('div');
          el.id = id;
          el.style.display = 'none';
          document.documentElement.appendChild(el);

          const script = document.createElement('script');
          script.textContent = `
            (async function() {
              var el = document.getElementById(${JSON.stringify(id)});
              try {
                var result = await (${fn})();
                el.setAttribute('data-result', result);
              } catch(e) {
                el.setAttribute('data-error', e.message || String(e));
              }
            })();
          `;
          document.documentElement.appendChild(script);
          script.remove();

          // Wait for result
          return new Promise<string>((resolve, reject) => {
            const check = () => {
              if (!document.getElementById(id)) return reject(new Error('Bridge element removed'));
              const err = el.getAttribute('data-error');
              if (err) {
                el.remove();
                return reject(new Error(err));
              }
              const res = el.getAttribute('data-result');
              if (res !== null) {
                el.remove();
                return resolve(res);
              }
              setTimeout(check, 50);
            };
            check();
          });
        }, {fn: wrapResultAsync(fnString), id: bridgeId}),
        DEFAULT_SCRIPT_TIMEOUT,
        'Script evaluation timed out',
      );

      await handleEvalResult(result);
      return;
    }

    let fnHandle: JSHandle<unknown> | undefined;
    try {
      const frame = context.getSelectedFrame();
      fnHandle = await withTimeout(
        frame.evaluateHandle(`(${wrapResultAsync(fnString)})`),
        DEFAULT_SCRIPT_TIMEOUT,
        'Script evaluation timed out',
      );
      await context.waitForEventsAfterAction(async () => {
        const result = await withTimeout(
          frame.evaluate(async fn => {
            // @ts-expect-error no types.
            return await fn();
          }, fnHandle),
          DEFAULT_SCRIPT_TIMEOUT,
          'Script execution timed out',
        );
        await handleEvalResult(result as string);
      });
    } finally {
      if (fnHandle) {
        void fnHandle.dispose();
      }
    }
  },
});
