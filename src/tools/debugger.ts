/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * JS Reverse Engineering Tools
 *
 * This module provides tools for JavaScript debugging and reverse engineering:
 * - Script listing and source retrieval
 * - Source code search
 * - Breakpoint management
 * - Request initiator (call stack) analysis
 */

import type {CallFrame, DebuggerContext} from '../DebuggerContext.js';
import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import type {Response} from './ToolDefinition.js';
import {defineTool} from './ToolDefinition.js';

/**
 * After a step command, append a concise summary of where execution stopped.
 * Shows: function name, location, arguments, and a small code snippet.
 */
async function appendStepSummary(
  response: Response,
  debugger_: DebuggerContext,
  action: string,
  frame: CallFrame,
): Promise<void> {
  const line = frame.location.lineNumber + 1; // CDP is 0-based
  const col = frame.location.columnNumber + 1;
  const funcName = frame.functionName || '<anonymous>';
  const url = frame.url || `script:${frame.location.scriptId}`;
  const shortUrl = url.split('/').pop() || url;

  response.appendResponseLine(
    `${action} → ${shortUrl}:${line}:${col}, function ${funcName}`,
  );

  // Show function arguments via evaluateOnCallFrame
  try {
    const argsResult = await debugger_.evaluateOnCallFrame(
      frame.callFrameId,
      `(() => { try { return JSON.stringify(Array.from(arguments)).slice(0, 500); } catch(e) { return String(arguments.length) + ' args'; } })()`,
      {returnByValue: true},
    );
    if (argsResult.result.value && !argsResult.exceptionDetails) {
      response.appendResponseLine(`  args: ${argsResult.result.value}`);
    }
  } catch {
    // arguments not available (e.g. arrow function or global scope)
  }

  // Show a small code snippet around the exact column position
  try {
    const result = await debugger_.getScriptSource(frame.location.scriptId);
    const source = result.scriptSource;
    const lines = source.split('\n');
    const lineContent = lines[frame.location.lineNumber];
    if (lineContent) {
      const snippetLen = 200;
      const half = Math.floor(snippetLen / 2);
      const c = frame.location.columnNumber;
      const s = Math.max(0, c - half);
      const e = Math.min(lineContent.length, s + snippetLen);
      const prefix = s > 0 ? '...' : '';
      const suffix = e < lineContent.length ? '...' : '';
      response.appendResponseLine(
        `  > ${prefix}${lineContent.substring(s, e)}${suffix}`,
      );
    }
  } catch {
    // Source unavailable
  }
}

/**
 * List all loaded JavaScript scripts in the current page.
 */
export const listScripts = defineTool({
  name: 'list_scripts',
  description:
    'Lists all JavaScript scripts loaded in the current page. Returns script ID, URL, and source map information. Use this to find scripts before setting breakpoints or searching. Script IDs are automatically refreshed after page navigation, so listed IDs are always valid.',
  annotations: {
    title: 'List Scripts',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: true,
  },
  schema: {
    filter: zod
      .string()
      .optional()
      .describe(
        'Optional filter string to match against script URLs (case-insensitive partial match).',
      ),
  },
  handler: async (request, response, context) => {
    const debugger_ = context.debuggerContext;

    if (!debugger_.isEnabled()) {
      response.appendResponseLine(
        'Debugger is not enabled. Please select a page first.',
      );
      return;
    }

    let scripts = debugger_.getScripts();

    // Apply filter if provided
    if (request.params.filter) {
      scripts = debugger_.getScriptsByUrlPattern(request.params.filter);
    }

    // Filter out scripts without URLs (inline/eval scripts) unless they're the only ones
    const scriptsWithUrls = scripts.filter(s => s.url);
    const displayScripts =
      scriptsWithUrls.length > 0 ? scriptsWithUrls : scripts;

    if (displayScripts.length === 0) {
      response.appendResponseLine('No scripts found.');
      return;
    }

    response.appendResponseLine(`Found ${displayScripts.length} script(s):\n`);

    for (const script of displayScripts) {
      response.appendResponseLine(`- ID: ${script.scriptId}`);
      let displayUrl = script.url || '(inline/eval)';
      if (displayUrl.startsWith('data:') && displayUrl.length > 100) {
        displayUrl = displayUrl.substring(0, 100) + '... (truncated)';
      } else if (displayUrl.length > 200) {
        displayUrl = displayUrl.substring(0, 200) + '... (truncated)';
      }
      response.appendResponseLine(`  URL: ${displayUrl}`);
      if (script.sourceMapURL) {
        response.appendResponseLine(`  SourceMap: ${script.sourceMapURL}`);
      }
      response.appendResponseLine('');
    }
  },
});

/**
 * Get the source code of a script.
 */
export const getScriptSource = defineTool({
  name: 'get_script_source',
  description:
    'Gets a small snippet of a JavaScript script source by URL (recommended) or script ID. Supports line range (for normal files) or character offset (for minified single-line files). Prefer using url over scriptId — URLs remain stable across page navigations while script IDs become invalid after reload. IMPORTANT: This tool is designed for reading small code regions (e.g. around breakpoints or search results). You MUST always specify startLine/endLine or offset/length. To read an entire script file, use curl to download it by its URL instead.',
  annotations: {
    title: 'Get Script Source',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: true,
  },
  schema: {
    url: zod
      .string()
      .optional()
      .describe(
        'Script URL (preferred). Stable across page navigations. Exact match first, then substring match.',
      ),
    scriptId: zod
      .string()
      .optional()
      .describe(
        'Script ID (from list_scripts). Becomes invalid after page navigation — prefer url instead.',
      ),
    startLine: zod
      .number()
      .int()
      .optional()
      .describe('Start line number (1-based). Use for multi-line files.'),
    endLine: zod
      .number()
      .int()
      .optional()
      .describe('End line number (1-based). Use for multi-line files.'),
    offset: zod
      .number()
      .int()
      .optional()
      .describe(
        'Character offset to start from (0-based). Use for minified single-line files.',
      ),
    length: zod
      .number()
      .int()
      .optional()
      .default(1000)
      .describe(
        'Number of characters to return when using offset (default: 1000).',
      ),
  },
  handler: async (request, response, context) => {
    const debugger_ = context.debuggerContext;

    if (!debugger_.isEnabled()) {
      response.appendResponseLine(
        'Debugger is not enabled. Please select a page first.',
      );
      return;
    }

    const {url, startLine, endLine, offset, length} = request.params;
    let {scriptId} = request.params;

    if (!url && !scriptId) {
      response.appendResponseLine(
        'Either url or scriptId must be provided.',
      );
      return;
    }

    try {
      let source: string;
      let bytecode: string | undefined;
      if (url) {
        const result = await debugger_.getScriptSourceByUrl(url);
        source = result.source;
        bytecode = result.bytecode;
        scriptId = result.script.scriptId;
        response.appendResponseLine(
          `Resolved URL to script ${scriptId} (${result.script.url}).\n`,
        );
      } else {
        const result = await debugger_.getScriptSource(scriptId!);
        source = result.scriptSource;
        bytecode = result.bytecode;
      }

      if (!source && !bytecode) {
        response.appendResponseLine(`No source found for script ${scriptId}.`);
        return;
      }

      if (bytecode) {
        const binaryData = Buffer.from(bytecode, 'base64');
        response.appendResponseLine(
          `Script ${scriptId} is a WebAssembly binary file (${binaryData.length} bytes). Please use save_script_source to download it as a .wasm file.`,
        );
        return;
      }

      // Character offset mode (for minified files)
      if (offset !== undefined) {
        const start = Math.max(0, offset);
        const end = Math.min(source.length, start + length);
        const extract = source.substring(start, end);

        const prefix = start > 0 ? '...' : '';
        const suffix = end < source.length ? '...' : '';

        response.appendResponseLine(
          `Source for script ${scriptId} (chars ${start}-${end} of ${source.length}):\n`,
        );
        response.appendResponseLine('```javascript');
        response.appendResponseLine(`${prefix}${extract}${suffix}`);
        response.appendResponseLine('```');
        return;
      }

      // Line range mode (for normal files)
      if (startLine !== undefined || endLine !== undefined) {
        const lines = source.split('\n');
        const start = (startLine ?? 1) - 1; // Convert to 0-based
        const end = endLine ?? lines.length;
        const selectedLines = lines.slice(start, end);
        const content = selectedLines.join('\n');

        // If the selected range is too large, it's likely minified — suggest offset mode
        if (content.length > 1000) {
          const lineOffset = lines
            .slice(0, start)
            .reduce((sum, l) => sum + l.length + 1, 0);
          response.appendResponseLine(
            `Selected lines ${start + 1}-${Math.min(end, lines.length)} of script ${scriptId} are too large (${content.length} chars). This file is likely minified.`,
          );
          response.appendResponseLine(
            `Use offset/length params instead. The character offset for line ${start + 1} is ${lineOffset}.`,
          );
          response.appendResponseLine(`First 1000 characters:\n`);
          response.appendResponseLine('```javascript');
          response.appendResponseLine(content.substring(0, 1000) + '...');
          response.appendResponseLine('```');
          return;
        }

        response.appendResponseLine(
          `Source for script ${scriptId} (lines ${start + 1}-${Math.min(end, lines.length)}):\n`,
        );
        response.appendResponseLine('```javascript');
        for (let i = 0; i < selectedLines.length; i++) {
          response.appendResponseLine(`${start + i + 1}: ${selectedLines[i]}`);
        }
        response.appendResponseLine('```');
        return;
      }

      // Full source - but warn if it's too large
      if (source.length > 1000) {
        response.appendResponseLine(
          `Script ${scriptId} is large (${source.length} chars). Use offset/length or startLine/endLine to read portions.`,
        );
        response.appendResponseLine(`First 1000 characters:\n`);
        response.appendResponseLine('```javascript');
        response.appendResponseLine(source.substring(0, 1000) + '...');
        response.appendResponseLine('```');
      } else {
        response.appendResponseLine(`Source for script ${scriptId}:\n`);
        response.appendResponseLine('```javascript');
        response.appendResponseLine(source);
        response.appendResponseLine('```');
      }
    } catch (error) {
      response.appendResponseLine(
        `Error getting script source: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

/**
 * Save full script source to a local file.
 */
export const saveScriptSource = defineTool({
  name: 'save_script_source',
  description:
    'Saves the full source code of a JavaScript script to a local file. Use this to download complete script sources for offline analysis, especially for large or minified files that are too big to view inline with get_script_source.',
  annotations: {
    title: 'Save Script Source',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {
    url: zod
      .string()
      .optional()
      .describe(
        'Script URL (preferred). Stable across page navigations. Exact match first, then substring match.',
      ),
    scriptId: zod
      .string()
      .optional()
      .describe(
        'Script ID (from list_scripts). Becomes invalid after page navigation — prefer url instead.',
      ),
    filePath: zod
      .string()
      .describe('Local file path to save the script source to.'),
  },
  handler: async (request, response, context) => {
    const debugger_ = context.debuggerContext;

    if (!debugger_.isEnabled()) {
      response.appendResponseLine(
        'Debugger is not enabled. Please select a page first.',
      );
      return;
    }

    const {url, scriptId, filePath} = request.params;

    if (!url && !scriptId) {
      response.appendResponseLine(
        'Either url or scriptId must be provided.',
      );
      return;
    }

    try {
      let source: string;
      let bytecode: string | undefined;
      let resolvedId = scriptId;
      if (url) {
        const result = await debugger_.getScriptSourceByUrl(url);
        source = result.source;
        bytecode = result.bytecode;
        resolvedId = result.script.scriptId;
        response.appendResponseLine(
          `Resolved URL to script ${resolvedId} (${result.script.url}).`,
        );
      } else {
        const result = await debugger_.getScriptSource(scriptId!);
        source = result.scriptSource;
        bytecode = result.bytecode;
      }

      if (!source && !bytecode) {
        response.appendResponseLine(`No source found for script ${resolvedId}.`);
        return;
      }

      if (bytecode) {
        const binaryData = Buffer.from(bytecode, 'base64');
        const result = await context.saveFile(binaryData, filePath);
        response.appendResponseLine(
          `Saved WASM script source to ${result.filename} (${binaryData.length} bytes).`,
        );
      } else {
        const data = new TextEncoder().encode(source);
        const result = await context.saveFile(data, filePath);
        response.appendResponseLine(
          `Saved script source to ${result.filename} (${source.length} chars).`,
        );
      }
    } catch (error) {
      response.appendResponseLine(
        `Error saving script source: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

/**
 * Search for a string in all loaded scripts.
 */
export const searchInSources = defineTool({
  name: 'search_in_sources',
  description:
    'Searches for a string or regex pattern in all loaded JavaScript sources. Returns matching lines with script ID, URL, and line number. Use get_script_source with startLine/endLine to view full context around matches.',
  annotations: {
    title: 'Search in Sources',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: true,
  },
  schema: {
    query: zod.string().describe('The search query (string or regex pattern).'),
    caseSensitive: zod
      .boolean()
      .optional()
      .default(false)
      .describe('Whether the search should be case-sensitive.'),
    isRegex: zod
      .boolean()
      .optional()
      .default(false)
      .describe('Whether to treat the query as a regular expression.'),
    maxResults: zod
      .number()
      .int()
      .optional()
      .default(30)
      .describe('Maximum number of results to return (default: 30).'),
    maxLineLength: zod
      .number()
      .int()
      .optional()
      .default(150)
      .describe(
        'Maximum characters per matched line preview (default: 150). Increase if you need more context around the match.',
      ),
    excludeMinified: zod
      .boolean()
      .optional()
      .default(true)
      .describe(
        'Skip minified files (files with very long lines). Default: true.',
      ),
    urlFilter: zod
      .string()
      .optional()
      .describe(
        'Only search scripts whose URL contains this string (case-insensitive).',
      ),
  },
  handler: async (request, response, context) => {
    const debugger_ = context.debuggerContext;

    if (!debugger_.isEnabled()) {
      response.appendResponseLine(
        'Debugger is not enabled. Please select a page first.',
      );
      return;
    }

    const {
      query,
      caseSensitive,
      isRegex,
      maxResults,
      maxLineLength,
      excludeMinified,
      urlFilter,
    } = request.params;

    try {
      const result = await debugger_.searchInScripts(query, {
        caseSensitive,
        isRegex,
      });

      if (result.matches.length === 0) {
        response.appendResponseLine(`No matches found for "${query}".`);
        return;
      }

      // Filter matches
      let filteredMatches = result.matches;

      // Apply URL filter
      if (urlFilter) {
        const lowerFilter = urlFilter.toLowerCase();
        filteredMatches = filteredMatches.filter(
          m => m.url && m.url.toLowerCase().includes(lowerFilter),
        );
      }

      // Filter out minified files (lines > 10000 chars)
      const minifiedThreshold = 10000;
      let skippedMinified = 0;
      if (excludeMinified) {
        const beforeCount = filteredMatches.length;
        filteredMatches = filteredMatches.filter(m => {
          if (m.lineContent.length > minifiedThreshold) {
            return false;
          }
          return true;
        });
        skippedMinified = beforeCount - filteredMatches.length;
      }

      if (filteredMatches.length === 0) {
        response.appendResponseLine(`No matches found for "${query}".`);
        if (skippedMinified > 0) {
          response.appendResponseLine(
            `(${skippedMinified} matches in minified files were skipped. Set excludeMinified=false to include them.)`,
          );
        }
        return;
      }

      const displayMatches = filteredMatches.slice(0, maxResults);
      const totalMatches = filteredMatches.length;

      response.appendResponseLine(
        `Found ${totalMatches} match(es) for "${query}"${totalMatches > maxResults ? ` (showing first ${maxResults})` : ''}:`,
      );
      if (skippedMinified > 0) {
        response.appendResponseLine(
          `(${skippedMinified} matches in minified files skipped)`,
        );
      }
      response.appendResponseLine('');

      for (const match of displayMatches) {
        const lineNum = match.lineNumber + 1;
        const scriptId = match.scriptId;
        const url = match.url || '(inline)';

        // Truncate line content, centering around the match if possible
        let preview = match.lineContent.trim();
        const effectiveMaxLen = maxLineLength > 0 ? maxLineLength : 500;
        if (preview.length > effectiveMaxLen) {
          // Try to find the query position to center the preview
          const lowerContent = caseSensitive ? preview : preview.toLowerCase();
          const lowerQuery = caseSensitive ? query : query.toLowerCase();
          const matchPos = isRegex ? 0 : lowerContent.indexOf(lowerQuery);

          if (matchPos >= 0) {
            // Center around match position
            const halfLen = Math.floor(effectiveMaxLen / 2);
            let start = Math.max(0, matchPos - halfLen);
            let end = start + effectiveMaxLen;

            if (end > preview.length) {
              end = preview.length;
              start = Math.max(0, end - effectiveMaxLen);
            }

            const prefix = start > 0 ? '...' : '';
            const suffix = end < preview.length ? '...' : '';
            preview = prefix + preview.substring(start, end) + suffix;
          } else {
            // Fallback: truncate from start
            preview = preview.substring(0, effectiveMaxLen) + '...';
          }
        }

        response.appendResponseLine(`[${scriptId}] ${url}:${lineNum}`);
        response.appendResponseLine(`  ${preview}`);
        response.appendResponseLine('');
      }

      response.appendResponseLine('---');
      response.appendResponseLine(
        'Tip: Use get_script_source(url=..., startLine, endLine) to view full context around a match. Using url is preferred over scriptId as it stays valid across page navigations.',
      );
    } catch (error) {
      response.appendResponseLine(
        `Error searching: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

/**
 * Remove breakpoint(s). Supports removing a single code breakpoint by ID,
 * a single XHR breakpoint by URL, or all breakpoints at once.
 * Automatically resumes execution if currently paused.
 */
export const removeBreakpoint = defineTool({
  name: 'remove_breakpoint',
  description:
    'Removes breakpoints and automatically resumes execution if paused. Pass breakpointId to remove a code breakpoint, url to remove an XHR breakpoint, or neither to remove ALL breakpoints (code + XHR).',
  annotations: {
    title: 'Remove Breakpoint',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {
    breakpointId: zod
      .string()
      .optional()
      .describe(
        'The breakpoint ID to remove (from list_breakpoints or set_breakpoint_on_text).',
      ),
    url: zod
      .string()
      .optional()
      .describe('The XHR breakpoint URL pattern to remove.'),
  },
  handler: async (request, response, context) => {
    const debugger_ = context.debuggerContext;

    if (!debugger_.isEnabled()) {
      response.appendResponseLine(
        'Debugger is not enabled. Please select a page first.',
      );
      return;
    }

    const {breakpointId, url} = request.params;

    try {
      if (breakpointId) {
        // Remove a single code breakpoint by ID
        await debugger_.removeBreakpoint(breakpointId);
        response.appendResponseLine(
          `Breakpoint ${breakpointId} removed.`,
        );
      } else if (url) {
        // Remove a single XHR breakpoint by URL
        await debugger_.removeXHRBreakpoint(url);
        response.appendResponseLine(
          `XHR breakpoint for "${url}" removed.`,
        );
      } else {
        // Remove all breakpoints (code + XHR)
        const codeCount = debugger_.getBreakpoints().length;
        const xhrCount = debugger_.getXHRBreakpoints().length;
        if (codeCount === 0 && xhrCount === 0) {
          response.appendResponseLine('No active breakpoints to remove.');
          return;
        }
        await debugger_.removeAllBreakpoints();
        const parts: string[] = [];
        if (codeCount > 0) parts.push(`${codeCount} code`);
        if (xhrCount > 0) parts.push(`${xhrCount} XHR`);
        response.appendResponseLine(
          `Removed ${parts.join(' + ')} breakpoint(s).`,
        );
      }

      // Auto-resume if currently paused
      if (debugger_.isPaused()) {
        await debugger_.resume();
        response.appendResponseLine('▶️ Execution resumed.');
      }
    } catch (error) {
      response.appendResponseLine(
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

/**
 * List all active breakpoints.
 */
export const listBreakpoints = defineTool({
  name: 'list_breakpoints',
  description: 'Lists all active breakpoints in the current debugging session. Breakpoints persist across page navigations and are automatically restored after reload/goto/back/forward.',
  annotations: {
    title: 'List Breakpoints',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: true,
  },
  schema: {},
  handler: async (request, response, context) => {
    const debugger_ = context.debuggerContext;

    if (!debugger_.isEnabled()) {
      response.appendResponseLine(
        'Debugger is not enabled. Please select a page first.',
      );
      return;
    }

    const breakpoints = debugger_.getBreakpoints();

    if (breakpoints.length === 0) {
      response.appendResponseLine('No active breakpoints.');
      return;
    }

    response.appendResponseLine(
      `Active breakpoints (${breakpoints.length}):\n`,
    );

    for (const bp of breakpoints) {
      response.appendResponseLine(`- ID: ${bp.breakpointId}`);
      response.appendResponseLine(`  URL: ${bp.url}`);
      response.appendResponseLine(
        `  Line: ${bp.lineNumber + 1}, Column: ${bp.columnNumber}`,
      );
      if (bp.condition) {
        response.appendResponseLine(`  Condition: ${bp.condition}`);
      }
      if (bp.locations.length > 0) {
        response.appendResponseLine(`  Locations: ${bp.locations.length}`);
      }
      response.appendResponseLine('');
    }
  },
});

/**
 * Get the call stack (initiator) for a network request.
 */
export const getRequestInitiator = defineTool({
  name: 'get_request_initiator',
  description:
    'Gets the JavaScript call stack that initiated a network request. This helps trace which code triggered an API call.',
  annotations: {
    title: 'Get Request Initiator',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: true,
  },
  schema: {
    requestId: zod
      .number()
      .int()
      .describe(
        'The request ID (from list_network_requests) to get the initiator for.',
      ),
  },
  handler: async (request, response, context) => {
    const {requestId} = request.params;

    try {
      const httpRequest = context.getNetworkRequestById(requestId);
      const initiator = context.getRequestInitiator(httpRequest);

      if (!initiator) {
        response.appendResponseLine(
          `No initiator information found for request ${requestId}.`,
        );
        response.appendResponseLine(
          'This might be a navigation request or the initiator was not captured.',
        );
        return;
      }

      response.appendResponseLine(
        `Request initiator for ${httpRequest.url()}:\n`,
      );
      response.appendResponseLine(`Type: ${initiator.type}`);

      if (initiator.url) {
        response.appendResponseLine(`URL: ${initiator.url}`);
      }
      if (initiator.lineNumber !== undefined) {
        response.appendResponseLine(`Line: ${initiator.lineNumber + 1}`);
      }
      if (initiator.columnNumber !== undefined) {
        response.appendResponseLine(`Column: ${initiator.columnNumber}`);
      }

      if (initiator.stack && initiator.stack.callFrames.length > 0) {
        response.appendResponseLine('\nCall Stack:');
        for (let i = 0; i < initiator.stack.callFrames.length; i++) {
          const frame = initiator.stack.callFrames[i];
          const functionName = frame.functionName || '(anonymous)';
          const location = frame.url
            ? `${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`
            : `script ${frame.scriptId}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`;
          response.appendResponseLine(
            `  ${i + 1}. ${functionName} @ ${location}`,
          );
        }

        // Include parent stack if available (for async calls)
        if (
          initiator.stack.parent &&
          initiator.stack.parent.callFrames.length > 0
        ) {
          response.appendResponseLine('\nAsync Parent Stack:');
          for (let i = 0; i < initiator.stack.parent.callFrames.length; i++) {
            const frame = initiator.stack.parent.callFrames[i];
            const functionName = frame.functionName || '(anonymous)';
            const location = frame.url
              ? `${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`
              : `script ${frame.scriptId}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`;
            response.appendResponseLine(
              `  ${i + 1}. ${functionName} @ ${location}`,
            );
          }
        }
      }
    } catch (error) {
      response.appendResponseLine(
        `Error getting initiator: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

/**
 * Get the current paused state and debug information.
 */
export const getPausedInfo = defineTool({
  name: 'get_paused_info',
  description:
    'Gets information about the current paused state including call stack, current location, and scope variables. Use this after a breakpoint is hit to understand the execution context.',
  annotations: {
    title: 'Get Paused Info',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: true,
  },
  schema: {
    includeScopes: zod
      .boolean()
      .optional()
      .default(true)
      .describe('Whether to include scope variables (default: true).'),
    maxScopeDepth: zod
      .number()
      .int()
      .optional()
      .default(2)
      .describe(
        'Maximum scope depth to traverse (default: 2). ' +
          '1 = local scope only (function args & local vars), ' +
          '2 = local + closure scopes, ' +
          '3+ = all non-global scopes.',
      ),
    frameIndex: zod
      .number()
      .int()
      .optional()
      .default(0)
      .describe(
        'Which call frame to inspect scope variables for (0 = top frame). ' +
          'Use the call stack indices to pick a frame.',
      ),
  },
  handler: async (request, response, context) => {
    const debugger_ = context.debuggerContext;

    if (!debugger_.isEnabled()) {
      response.appendResponseLine(
        'Debugger is not enabled. Please select a page first.',
      );
      return;
    }

    const pausedState = debugger_.getPausedState();

    if (!pausedState.isPaused) {
      response.appendResponseLine('Execution is not paused.');
      response.appendResponseLine(
        'Set a breakpoint and trigger it to pause execution.',
      );
      return;
    }

    response.appendResponseLine('🔴 Execution Paused\n');

    if (pausedState.reason) {
      response.appendResponseLine(`Reason: ${pausedState.reason}`);
    }

    if (pausedState.hitBreakpoints && pausedState.hitBreakpoints.length > 0) {
      response.appendResponseLine(
        `Hit breakpoints: ${pausedState.hitBreakpoints.join(', ')}`,
      );
    }

    response.appendResponseLine('\n📍 Call Stack:');

    for (let i = 0; i < pausedState.callFrames.length; i++) {
      const frame = pausedState.callFrames[i];
      const script = debugger_.getScriptById(frame.location.scriptId);
      const url =
        script?.url || frame.url || `script:${frame.location.scriptId}`;
      const location = `${url}:${frame.location.lineNumber + 1}:${frame.location.columnNumber + 1}`;
      response.appendResponseLine(
        `  ${i}. ${frame.functionName} @ ${location}`,
      );
    }

    // Include scope variables if requested
    if (request.params.includeScopes && pausedState.callFrames.length > 0) {
      const frameIndex = request.params.frameIndex;
      if (frameIndex < 0 || frameIndex >= pausedState.callFrames.length) {
        response.appendResponseLine(
          `\n⚠️ frameIndex ${frameIndex} is out of range (0-${pausedState.callFrames.length - 1}).`,
        );
      } else {
        const selectedFrame = pausedState.callFrames[frameIndex];
        response.appendResponseLine(
          `\n🔍 Scope Variables (frame ${frameIndex}: ${selectedFrame.functionName || '<anonymous>'}):`,
        );

        const maxDepth = request.params.maxScopeDepth;
        // Scope priority: local(1) > closure(2) > block/catch/with/etc(3+)
        // Always skip global scope
        const scopePriority: Record<string, number> = {
          local: 1,
          closure: 2,
        };
        let scopeCount = 0;

        for (const scope of selectedFrame.scopeChain) {
          if (scope.type === 'global') {
            continue;
          }

          const priority = scopePriority[scope.type] ?? 3;
          if (priority > maxDepth) {
            continue;
          }
          scopeCount++;

          const scopeName = scope.name || scope.type;
          response.appendResponseLine(`\n  [${scopeName}]:`);

          if (scope.object.objectId) {
            try {
              const variables = await debugger_.getScopeVariables(
                scope.object.objectId,
              );

              if (variables.length === 0) {
                response.appendResponseLine('    (empty)');
              } else {
                for (const variable of variables.slice(0, 20)) {
                  let valueStr =
                    typeof variable.value === 'string'
                      ? `"${variable.value}"`
                      : JSON.stringify(variable.value);
                  if (valueStr && valueStr.length > 200) {
                    valueStr = valueStr.slice(0, 200) + '...(truncated)';
                  }
                  response.appendResponseLine(
                    `    ${variable.name}: ${valueStr}`,
                  );
                }
                if (variables.length > 20) {
                  response.appendResponseLine(
                    `    ... and ${variables.length - 20} more`,
                  );
                }
              }
            } catch {
              response.appendResponseLine(
                '    (unable to retrieve variables)',
              );
            }
          }
        }

        if (scopeCount === 0) {
          response.appendResponseLine(
            '    (no matching scopes — try increasing maxScopeDepth)',
          );
        }
      }
    }

    response.appendResponseLine(
      '\n💡 Use resume, step_over, step_into, or step_out to continue.',
    );
  },
});

/**
 * Resume execution after a breakpoint.
 */
export const pauseOrResume = defineTool({
  name: 'pause_or_resume',
  description:
    'Toggles JavaScript execution. If paused, resumes execution. If running, pauses execution.',
  annotations: {
    title: 'Pause / Resume',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {},
  handler: async (request, response, context) => {
    const debugger_ = context.debuggerContext;

    if (!debugger_.isEnabled()) {
      response.appendResponseLine(
        'Debugger is not enabled. Please select a page first.',
      );
      return;
    }

    try {
      if (debugger_.isPaused()) {
        await debugger_.resume();
        response.appendResponseLine('▶️ Execution resumed.');
      } else {
        await debugger_.pause();
        response.appendResponseLine(
          '⏸️ Pause requested. Waiting for execution to pause...',
        );
      }
    } catch (error) {
      response.appendResponseLine(
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

/**
 * Step execution: over, into, or out.
 */
export const step = defineTool({
  name: 'step',
  description:
    'Steps JavaScript execution. Use direction "over" to skip function calls, "into" to enter function bodies, "out" to exit the current function. Returns the new location with source context.',
  annotations: {
    title: 'Step',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {
    direction: zod
      .enum(['over', 'into', 'out'])
      .describe(
        'Step direction: "over" (next statement), "into" (enter function), "out" (exit function).',
      ),
  },
  handler: async (request, response, context) => {
    const debugger_ = context.debuggerContext;

    if (!debugger_.isEnabled()) {
      response.appendResponseLine(
        'Debugger is not enabled. Please select a page first.',
      );
      return;
    }

    if (!debugger_.isPaused()) {
      response.appendResponseLine('Execution is not paused. Cannot step.');
      return;
    }

    const {direction} = request.params;
    const labels = {
      over: '⏭️ Stepped over',
      into: '⬇️ Stepped into',
      out: '⬆️ Stepped out',
    } as const;

    try {
      const frame =
        direction === 'over'
          ? await debugger_.stepOver()
          : direction === 'into'
            ? await debugger_.stepInto()
            : await debugger_.stepOut();
      await appendStepSummary(response, debugger_, labels[direction], frame);
    } catch (error) {
      response.appendResponseLine(
        `Error stepping ${direction}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

/**
 * Set a breakpoint on specific code text (function name, statement, etc.)
 * Combines search + locate + set breakpoint in one step.
 */
export const setBreakpointOnText = defineTool({
  name: 'set_breakpoint_on_text',
  description:
    'Sets a breakpoint on specific code (function name, statement, etc.) by searching for it and automatically determining the exact position. Works with both normal and minified files. Breakpoints persist across page navigations.',
  annotations: {
    title: 'Set Breakpoint on Text',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {
    text: zod
      .string()
      .describe(
        'The code text to find and set breakpoint on (e.g., "function myFunc", "fetchData(", "apiCall").',
      ),
    urlFilter: zod
      .string()
      .optional()
      .describe(
        'Only search in scripts whose URL contains this string (case-insensitive).',
      ),
    occurrence: zod
      .number()
      .int()
      .optional()
      .default(1)
      .describe('Which occurrence to break on (1 = first, 2 = second, etc.).'),
    condition: zod
      .string()
      .optional()
      .describe(
        'Optional condition expression. Breakpoint only triggers when this evaluates to true.',
      ),
  },
  handler: async (request, response, context) => {
    const debugger_ = context.debuggerContext;

    if (!debugger_.isEnabled()) {
      response.appendResponseLine(
        'Debugger is not enabled. Please select a page first.',
      );
      return;
    }

    const {text, urlFilter, occurrence, condition} = request.params;

    try {
      // Step 1: Search for the text in all scripts
      const searchResult = await debugger_.searchInScripts(text, {
        caseSensitive: true,
        isRegex: false,
      });

      if (searchResult.matches.length === 0) {
        response.appendResponseLine(
          `"${text}" not found in any loaded script.`,
        );
        return;
      }

      // Apply URL filter if specified
      let matches = searchResult.matches;
      if (urlFilter) {
        const lowerFilter = urlFilter.toLowerCase();
        matches = matches.filter(
          m => m.url && m.url.toLowerCase().includes(lowerFilter),
        );
        if (matches.length === 0) {
          response.appendResponseLine(
            `"${text}" not found in scripts matching "${urlFilter}".`,
          );
          return;
        }
      }

      // Get the specified occurrence
      if (occurrence > matches.length) {
        response.appendResponseLine(
          `Only ${matches.length} occurrence(s) found, but occurrence ${occurrence} was requested.`,
        );
        return;
      }

      const match = matches[occurrence - 1];
      const script = debugger_.getScriptById(match.scriptId);
      const url = script?.url || match.url;

      if (!url) {
        response.appendResponseLine(
          'Cannot set breakpoint: script has no URL (inline script).',
        );
        return;
      }

      // Step 2: Get exact column position by searching in the script source
      const result = await debugger_.getScriptSource(match.scriptId);
      const source = result.scriptSource;
      let columnNumber = 0;

      // For minified files, find exact column
      const lines = source.split('\n');
      if (match.lineNumber < lines.length) {
        const lineContent = lines[match.lineNumber];
        const colPos = lineContent.indexOf(text);
        if (colPos >= 0) {
          columnNumber = colPos;
        }
      }

      // Step 3: Set the breakpoint
      const breakpointInfo = await debugger_.setBreakpoint(
        url,
        match.lineNumber,
        columnNumber,
        condition,
      );

      response.appendResponseLine(`✅ Breakpoint set successfully!`);
      response.appendResponseLine(`- ID: ${breakpointInfo.breakpointId}`);
      response.appendResponseLine(`- URL: ${url}`);
      response.appendResponseLine(
        `- Line: ${match.lineNumber + 1}, Column: ${columnNumber}`,
      );
      if (condition) {
        response.appendResponseLine(`- Condition: ${condition}`);
      }

      // Show context
      const contextStart = Math.max(0, columnNumber - 50);
      const contextEnd = Math.min(
        lines[match.lineNumber].length,
        columnNumber + text.length + 50,
      );
      const preview = lines[match.lineNumber].substring(
        contextStart,
        contextEnd,
      );
      const prefix = contextStart > 0 ? '...' : '';
      const suffix = contextEnd < lines[match.lineNumber].length ? '...' : '';

      response.appendResponseLine('');
      response.appendResponseLine('Context:');
      response.appendResponseLine('```javascript');
      response.appendResponseLine(`${prefix}${preview}${suffix}`);
      response.appendResponseLine('```');
    } catch (error) {
      response.appendResponseLine(
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

/**
 * Set XHR/Fetch breakpoint.
 */
export const breakOnXhr = defineTool({
  name: 'break_on_xhr',
  description:
    'Sets a breakpoint that triggers when an XHR/Fetch request URL contains the specified string.',
  annotations: {
    title: 'Break on XHR',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {
    url: zod.string().describe('URL pattern to break on (partial match).'),
  },
  handler: async (request, response, context) => {
    const debugger_ = context.debuggerContext;

    if (!debugger_.isEnabled()) {
      response.appendResponseLine(
        'Debugger is not enabled. Please select a page first.',
      );
      return;
    }

    const {url} = request.params;
    const client = debugger_.getClient();

    if (!client) {
      response.appendResponseLine('Debugger client not available.');
      return;
    }

    try {
      await debugger_.setXHRBreakpoint(url);
      response.appendResponseLine(
        `✅ XHR breakpoint set for URLs containing: "${url}"`,
      );
      response.appendResponseLine(
        'Debugger will pause when a matching XHR/Fetch request is made.',
      );
    } catch (error) {
      response.appendResponseLine(
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});


/**
 * Trace a function by name - works for module-internal functions.
 * Uses conditional breakpoints to log without pausing.
 */
export const traceFunction = defineTool({
  name: 'trace_function',
  description:
    'Traces calls to a function by its name in the source code. Works for ANY function including module-internal functions (webpack/rollup bundled). Uses "logpoints" (conditional breakpoints) to log arguments without pausing execution. Trace breakpoints persist across page navigations.',
  annotations: {
    title: 'Trace Function',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {
    functionName: zod
      .string()
      .describe(
        'The function name to trace. Will search for "function NAME" or "NAME = function" or "NAME(" patterns.',
      ),
    urlFilter: zod
      .string()
      .optional()
      .describe('Only search in scripts matching this URL pattern.'),
    logArgs: zod
      .boolean()
      .optional()
      .default(true)
      .describe('Whether to log function arguments (default: true).'),
    logThis: zod
      .boolean()
      .optional()
      .default(false)
      .describe('Whether to log "this" context (default: false).'),
    pause: zod
      .boolean()
      .optional()
      .default(false)
      .describe(
        'Whether to actually pause execution (default: false, just logs).',
      ),
    traceId: zod
      .string()
      .optional()
      .describe('Custom ID for this trace. Used to identify in logs.'),
  },
  handler: async (request, response, context) => {
    const debugger_ = context.debuggerContext;

    if (!debugger_.isEnabled()) {
      response.appendResponseLine(
        'Debugger is not enabled. Please select a page first.',
      );
      return;
    }

    const {functionName, urlFilter, logArgs, logThis, pause, traceId} =
      request.params;
    const id = traceId || `trace_${functionName}`;

    // Search patterns for function definitions
    const patterns = [
      `function ${functionName}`,
      `${functionName}=function`,
      `${functionName} = function`,
      `${functionName}=(`,
      `${functionName} = (`,
      `${functionName}(`,
      `${functionName}:function`,
      `${functionName}: function`,
    ];

    try {
      let foundMatch = null;

      // Search for each pattern
      for (const pattern of patterns) {
        const result = await debugger_.searchInScripts(pattern, {
          caseSensitive: true,
          isRegex: false,
        });

        let matches = result.matches;

        // Apply URL filter
        if (urlFilter) {
          const lowerFilter = urlFilter.toLowerCase();
          matches = matches.filter(
            m => m.url && m.url.toLowerCase().includes(lowerFilter),
          );
        }

        // Skip minified files with extremely long lines
        matches = matches.filter(m => m.lineContent.length < 100000);

        if (matches.length > 0) {
          foundMatch = {pattern, match: matches[0]};
          break;
        }
      }

      if (!foundMatch) {
        response.appendResponseLine(
          `❌ Function "${functionName}" not found in any script.`,
        );
        response.appendResponseLine('');
        response.appendResponseLine('Searched patterns:');
        for (const p of patterns.slice(0, 4)) {
          response.appendResponseLine(`  - "${p}"`);
        }
        response.appendResponseLine('');
        response.appendResponseLine(
          'Tip: Use search_in_sources to find the exact function signature, then use set_breakpoint_on_text.',
        );
        return;
      }

      const {match} = foundMatch;
      const script = debugger_.getScriptById(match.scriptId);
      const url = script?.url || match.url;

      if (!url) {
        response.appendResponseLine(
          'Cannot trace: script has no URL (inline script).',
        );
        return;
      }

      // Get exact column position
      const result = await debugger_.getScriptSource(match.scriptId);
      const source = result.scriptSource;
      const lines = source.split('\n');
      let columnNumber = 0;

      if (match.lineNumber < lines.length) {
        const lineContent = lines[match.lineNumber];
        const funcStart = lineContent.indexOf(foundMatch.pattern);
        if (funcStart >= 0) {
          // Find opening brace or paren after the pattern
          const afterPattern = lineContent.substring(
            funcStart + foundMatch.pattern.length,
          );
          const braceMatch = afterPattern.match(/[({]/);
          if (braceMatch && braceMatch.index !== undefined) {
            columnNumber =
              funcStart + foundMatch.pattern.length + braceMatch.index + 1;
          } else {
            columnNumber = funcStart;
          }
        }
      }

      // Build the logging expression
      const logParts = [`'[Trace ${id}] ${functionName} called'`];
      if (logArgs) {
        logParts.push(`'args:'`);
        logParts.push(`JSON.stringify(Array.from(arguments)).slice(0,500)`);
      }
      if (logThis) {
        logParts.push(`'this:'`);
        logParts.push(`this?.constructor?.name || typeof this`);
      }
      const logExpr = `console.log(${logParts.join(', ')})`;

      // If not pausing, wrap in expression that returns false
      const condition = pause ? logExpr : `(${logExpr}, false)`;

      // Set the breakpoint
      const breakpointInfo = await debugger_.setBreakpoint(
        url,
        match.lineNumber,
        columnNumber,
        condition,
      );

      response.appendResponseLine(`✅ Function trace installed!`);
      response.appendResponseLine(`- Trace ID: ${id}`);
      response.appendResponseLine(`- Function: ${functionName}`);
      response.appendResponseLine(
        `- Breakpoint ID: ${breakpointInfo.breakpointId}`,
      );
      response.appendResponseLine(
        `- Location: ${url}:${match.lineNumber + 1}:${columnNumber}`,
      );
      response.appendResponseLine(
        `- Mode: ${pause ? 'Pause on call' : 'Log only (no pause)'}`,
      );
      response.appendResponseLine('');
      response.appendResponseLine(
        'Calls will be logged to console. Use list_console_messages to view.',
      );
      response.appendResponseLine(
        `Use remove_breakpoint(breakpointId: "${breakpointInfo.breakpointId}") to stop tracing.`,
      );

      // Show context
      if (match.lineNumber < lines.length) {
        const lineContent = lines[match.lineNumber];
        const contextStart = Math.max(0, columnNumber - 30);
        const contextEnd = Math.min(lineContent.length, columnNumber + 50);
        const preview = lineContent.substring(contextStart, contextEnd);
        const prefix = contextStart > 0 ? '...' : '';
        const suffix = contextEnd < lineContent.length ? '...' : '';

        response.appendResponseLine('');
        response.appendResponseLine('Trace point:');
        response.appendResponseLine('```javascript');
        response.appendResponseLine(`${prefix}${preview}${suffix}`);
        response.appendResponseLine('```');
      }
    } catch (error) {
      response.appendResponseLine(
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

/**
 * Inject or remove a script that runs before every page load.
 */
export const injectScript = defineTool({
  name: 'inject_before_load',
  description:
    'Injects a JavaScript script that runs before any page script on every page load. Pass script to inject, or pass identifier to remove a previously injected script.',
  annotations: {
    title: 'Inject Before Load',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {
    script: zod
      .string()
      .optional()
      .describe(
        'JavaScript code to inject. Runs before any page script. Example: Object.defineProperty(window, "h5sign", { set(v) { debugger; this._h5sign = v; }, get() { return this._h5sign; } })',
      ),
    identifier: zod
      .string()
      .optional()
      .describe(
        'The identifier of a previously injected script to remove.',
      ),
  },
  handler: async (request, response, context) => {
    const debugger_ = context.debuggerContext;

    if (!debugger_.isEnabled()) {
      response.appendResponseLine(
        'Debugger is not enabled. Please select a page first.',
      );
      return;
    }

    const client = debugger_.getClient();
    if (!client) {
      response.appendResponseLine('Debugger client not available.');
      return;
    }

    const {script, identifier} = request.params;

    if (!script && !identifier) {
      response.appendResponseLine(
        'Either script (to inject) or identifier (to remove) must be provided.',
      );
      return;
    }

    try {
      await client.send('Page.enable');

      if (identifier) {
        // Remove mode
        await client.send('Page.removeScriptToEvaluateOnNewDocument', {
          identifier,
        });
        context.untrackInjectedScript(identifier);
        response.appendResponseLine(
          `Injected script ${identifier} removed.`,
        );
      } else {
        // Inject mode
        const result = await client.send(
          'Page.addScriptToEvaluateOnNewDocument',
          {source: script!},
        );
        const id = result.identifier;
        context.trackInjectedScript(id, script!);
        response.appendResponseLine(
          `Script injected. Identifier: ${id}`,
        );
        response.appendResponseLine(
          'It will run before any page script on every load.',
        );
        response.appendResponseLine(
          `To remove: inject_before_load(identifier: "${id}")`,
        );
      }
    } catch (error) {
      response.appendResponseLine(
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});
