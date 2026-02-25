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

import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './ToolDefinition.js';

/**
 * List all loaded JavaScript scripts in the current page.
 */
export const listScripts = defineTool({
  name: 'list_scripts',
  description:
    'Lists all JavaScript scripts loaded in the current page. Returns script ID, URL, and source map information. Use this to find scripts before setting breakpoints or searching.',
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
      response.appendResponseLine(`  URL: ${script.url || '(inline/eval)'}`);
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
    'Gets the source code of a JavaScript script by its script ID. Supports line range (for normal files) or character offset (for minified single-line files). Use list_scripts first to find the script ID.',
  annotations: {
    title: 'Get Script Source',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: true,
  },
  schema: {
    scriptId: zod
      .string()
      .describe(
        'The script ID (from list_scripts) to get the source code for.',
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

    const {scriptId, startLine, endLine, offset, length} = request.params;

    try {
      const source = await debugger_.getScriptSource(scriptId);

      if (!source) {
        response.appendResponseLine(`No source found for script ${scriptId}.`);
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
      if (source.length > 50000) {
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
 * Find a string in a specific script and return its exact position with context.
 * Useful for setting breakpoints in minified files.
 */
export const findInScript = defineTool({
  name: 'find_in_script',
  description:
    'Finds a string in a specific script and returns its exact line/column position with surrounding context. Ideal for setting breakpoints in minified files where the entire code is on one line.',
  annotations: {
    title: 'Find in Script',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: true,
  },
  schema: {
    scriptId: zod
      .string()
      .describe('The script ID to search in (from list_scripts).'),
    query: zod.string().describe('The string to find in the script.'),
    contextChars: zod
      .number()
      .int()
      .optional()
      .default(100)
      .describe(
        'Number of characters to show before and after the match (default: 100).',
      ),
    occurrence: zod
      .number()
      .int()
      .optional()
      .default(1)
      .describe('Which occurrence to find (1 = first, 2 = second, etc.).'),
    caseSensitive: zod
      .boolean()
      .optional()
      .default(true)
      .describe('Whether the search is case-sensitive (default: true).'),
  },
  handler: async (request, response, context) => {
    const debugger_ = context.debuggerContext;

    if (!debugger_.isEnabled()) {
      response.appendResponseLine(
        'Debugger is not enabled. Please select a page first.',
      );
      return;
    }

    const {scriptId, query, contextChars, occurrence, caseSensitive} =
      request.params;

    try {
      const source = await debugger_.getScriptSource(scriptId);

      if (!source) {
        response.appendResponseLine(`No source found for script ${scriptId}.`);
        return;
      }

      // Find the occurrence
      const searchSource = caseSensitive ? source : source.toLowerCase();
      const searchQuery = caseSensitive ? query : query.toLowerCase();

      let position = -1;
      let currentOccurrence = 0;
      let searchStart = 0;

      while (currentOccurrence < occurrence) {
        position = searchSource.indexOf(searchQuery, searchStart);
        if (position === -1) {
          break;
        }
        currentOccurrence++;
        searchStart = position + 1;
      }

      if (position === -1) {
        response.appendResponseLine(
          `"${query}" not found in script ${scriptId}${occurrence > 1 ? ` (occurrence ${occurrence})` : ''}.`,
        );
        return;
      }

      // Calculate line and column (0-based for CDP)
      let lineNumber = 0;
      let columnNumber = position;
      for (let i = 0; i < position; i++) {
        if (source[i] === '\n') {
          lineNumber++;
          columnNumber = position - i - 1;
        }
      }

      // Extract context
      const contextStart = Math.max(0, position - contextChars);
      const contextEnd = Math.min(
        source.length,
        position + query.length + contextChars,
      );

      const beforeContext = source.substring(contextStart, position);
      const matchText = source.substring(position, position + query.length);
      const afterContext = source.substring(
        position + query.length,
        contextEnd,
      );

      const prefix = contextStart > 0 ? '...' : '';
      const suffix = contextEnd < source.length ? '...' : '';

      const script = debugger_.getScriptById(scriptId);
      const url = script?.url || '(inline)';

      response.appendResponseLine(`Found "${query}" in script ${scriptId}:`);
      response.appendResponseLine(`URL: ${url}`);
      response.appendResponseLine(
        `Position: line ${lineNumber + 1}, column ${columnNumber}`,
      );
      response.appendResponseLine(`Character offset: ${position}`);
      response.appendResponseLine('');
      response.appendResponseLine('Context:');
      response.appendResponseLine('```javascript');
      response.appendResponseLine(
        `${prefix}${beforeContext}【${matchText}】${afterContext}${suffix}`,
      );
      response.appendResponseLine('```');
      response.appendResponseLine('');
      response.appendResponseLine(
        `To set a breakpoint here: set_breakpoint(url: "${url}", lineNumber: ${lineNumber + 1}, columnNumber: ${columnNumber})`,
      );
    } catch (error) {
      response.appendResponseLine(
        `Error: ${error instanceof Error ? error.message : String(error)}`,
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
        'Maximum characters per line preview (default: 150). Set to 0 for full lines.',
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
        if (maxLineLength > 0 && preview.length > maxLineLength) {
          // Try to find the query position to center the preview
          const lowerContent = caseSensitive ? preview : preview.toLowerCase();
          const lowerQuery = caseSensitive ? query : query.toLowerCase();
          const matchPos = isRegex ? 0 : lowerContent.indexOf(lowerQuery);

          if (matchPos >= 0) {
            // Center around match position
            const halfLen = Math.floor(maxLineLength / 2);
            let start = Math.max(0, matchPos - halfLen);
            let end = start + maxLineLength;

            if (end > preview.length) {
              end = preview.length;
              start = Math.max(0, end - maxLineLength);
            }

            const prefix = start > 0 ? '...' : '';
            const suffix = end < preview.length ? '...' : '';
            preview = prefix + preview.substring(start, end) + suffix;
          } else {
            // Fallback: truncate from start
            preview = preview.substring(0, maxLineLength) + '...';
          }
        }

        response.appendResponseLine(`[${scriptId}] ${url}:${lineNum}`);
        response.appendResponseLine(`  ${preview}`);
        response.appendResponseLine('');
      }

      response.appendResponseLine('---');
      response.appendResponseLine(
        'Tip: Use get_script_source(scriptId, startLine, endLine) to view full context around a match.',
      );
    } catch (error) {
      response.appendResponseLine(
        `Error searching: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

/**
 * Set a breakpoint in a script.
 */
export const setBreakpoint = defineTool({
  name: 'set_breakpoint',
  description:
    'Sets a breakpoint in a JavaScript file at the specified line. The breakpoint will trigger when the code executes.',
  annotations: {
    title: 'Set Breakpoint',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {
    url: zod
      .string()
      .describe(
        'The URL of the JavaScript file (can be a partial match or regex pattern).',
      ),
    lineNumber: zod
      .number()
      .int()
      .describe('The line number to set the breakpoint (1-based).'),
    columnNumber: zod
      .number()
      .int()
      .optional()
      .default(0)
      .describe('Optional column number (0-based).'),
    condition: zod
      .string()
      .optional()
      .describe(
        'Optional condition expression. The breakpoint only triggers when this evaluates to true.',
      ),
    isRegex: zod
      .boolean()
      .optional()
      .default(false)
      .describe('Whether to treat the URL as a regex pattern.'),
  },
  handler: async (request, response, context) => {
    const debugger_ = context.debuggerContext;

    if (!debugger_.isEnabled()) {
      response.appendResponseLine(
        'Debugger is not enabled. Please select a page first.',
      );
      return;
    }

    const {url, lineNumber, columnNumber, condition, isRegex} = request.params;

    try {
      let breakpointInfo;
      // Convert 1-based to 0-based line number
      const line0based = lineNumber - 1;

      if (isRegex) {
        breakpointInfo = await debugger_.setBreakpointByUrlRegex(
          url,
          line0based,
          columnNumber,
          condition,
        );
      } else {
        breakpointInfo = await debugger_.setBreakpoint(
          url,
          line0based,
          columnNumber,
          condition,
        );
      }

      response.appendResponseLine(`Breakpoint set successfully!`);
      response.appendResponseLine(`- ID: ${breakpointInfo.breakpointId}`);
      response.appendResponseLine(`- URL: ${url}`);
      response.appendResponseLine(`- Line: ${lineNumber}`);
      if (condition) {
        response.appendResponseLine(`- Condition: ${condition}`);
      }
      if (breakpointInfo.locations.length > 0) {
        response.appendResponseLine(
          `- Resolved to ${breakpointInfo.locations.length} location(s)`,
        );
      }
    } catch (error) {
      response.appendResponseLine(
        `Error setting breakpoint: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

/**
 * Remove a breakpoint.
 */
export const removeBreakpoint = defineTool({
  name: 'remove_breakpoint',
  description:
    'Removes a breakpoint by its ID. Use list_breakpoints to see active breakpoints.',
  annotations: {
    title: 'Remove Breakpoint',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {
    breakpointId: zod
      .string()
      .describe(
        'The breakpoint ID to remove (from list_breakpoints or set_breakpoint).',
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

    const {breakpointId} = request.params;

    try {
      await debugger_.removeBreakpoint(breakpointId);
      response.appendResponseLine(
        `Breakpoint ${breakpointId} removed successfully.`,
      );
    } catch (error) {
      response.appendResponseLine(
        `Error removing breakpoint: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

/**
 * List all active breakpoints.
 */
export const listBreakpoints = defineTool({
  name: 'list_breakpoints',
  description: 'Lists all active breakpoints in the current debugging session.',
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
      .describe('Maximum scope depth to traverse (default: 2).'),
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
      response.appendResponseLine(`     CallFrameId: ${frame.callFrameId}`);
    }

    // Include scope variables if requested
    if (request.params.includeScopes && pausedState.callFrames.length > 0) {
      response.appendResponseLine('\n🔍 Scope Variables (top frame):');

      const topFrame = pausedState.callFrames[0];

      for (const scope of topFrame.scopeChain) {
        // Only show local and closure scopes, skip global
        if (scope.type === 'global') {
          continue;
        }

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
                // Limit to 20 variables
                const valueStr =
                  typeof variable.value === 'string'
                    ? `"${variable.value}"`
                    : JSON.stringify(variable.value);
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
            response.appendResponseLine('    (unable to retrieve variables)');
          }
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
export const resume = defineTool({
  name: 'resume',
  description:
    'Resumes JavaScript execution after being paused at a breakpoint. Execution continues until the next breakpoint or completion.',
  annotations: {
    title: 'Resume Execution',
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

    if (!debugger_.isPaused()) {
      response.appendResponseLine('Execution is not paused.');
      return;
    }

    try {
      await debugger_.resume();
      response.appendResponseLine('▶️ Execution resumed.');
    } catch (error) {
      response.appendResponseLine(
        `Error resuming: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

/**
 * Pause execution.
 */
export const pause = defineTool({
  name: 'pause',
  description:
    'Pauses JavaScript execution at the current point. Use this to interrupt running code.',
  annotations: {
    title: 'Pause Execution',
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

    if (debugger_.isPaused()) {
      response.appendResponseLine('Execution is already paused.');
      return;
    }

    try {
      await debugger_.pause();
      response.appendResponseLine(
        '⏸️ Pause requested. Waiting for execution to pause...',
      );
    } catch (error) {
      response.appendResponseLine(
        `Error pausing: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

/**
 * Step over to the next statement.
 */
export const stepOver = defineTool({
  name: 'step_over',
  description:
    'Steps over to the next statement, treating function calls as a single step. Use this to move through code without entering function bodies.',
  annotations: {
    title: 'Step Over',
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

    if (!debugger_.isPaused()) {
      response.appendResponseLine('Execution is not paused. Cannot step.');
      return;
    }

    try {
      await debugger_.stepOver();
      response.appendResponseLine(
        '⏭️ Stepped over. Use get_paused_info to see current state.',
      );
    } catch (error) {
      response.appendResponseLine(
        `Error stepping over: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

/**
 * Step into the next function call.
 */
export const stepInto = defineTool({
  name: 'step_into',
  description:
    'Steps into the next function call. Use this to enter and debug function bodies.',
  annotations: {
    title: 'Step Into',
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

    if (!debugger_.isPaused()) {
      response.appendResponseLine('Execution is not paused. Cannot step.');
      return;
    }

    try {
      await debugger_.stepInto();
      response.appendResponseLine(
        '⬇️ Stepped into. Use get_paused_info to see current state.',
      );
    } catch (error) {
      response.appendResponseLine(
        `Error stepping into: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

/**
 * Step out of the current function.
 */
export const stepOut = defineTool({
  name: 'step_out',
  description:
    'Steps out of the current function, continuing until the function returns. Use this to quickly exit a function.',
  annotations: {
    title: 'Step Out',
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

    if (!debugger_.isPaused()) {
      response.appendResponseLine('Execution is not paused. Cannot step.');
      return;
    }

    try {
      await debugger_.stepOut();
      response.appendResponseLine(
        '⬆️ Stepped out. Use get_paused_info to see current state.',
      );
    } catch (error) {
      response.appendResponseLine(
        `Error stepping out: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

/**
 * Evaluate expression in the current call frame context.
 */
export const evaluateOnCallframe = defineTool({
  name: 'evaluate_on_callframe',
  description:
    'Evaluates a JavaScript expression in the context of a specific call frame while paused. This allows you to inspect variables and execute code in the paused scope.',
  annotations: {
    title: 'Evaluate on Call Frame',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: true,
  },
  schema: {
    expression: zod.string().describe('The JavaScript expression to evaluate.'),
    frameIndex: zod
      .number()
      .int()
      .optional()
      .default(0)
      .describe(
        'The call frame index to evaluate in (0 = top frame, default: 0).',
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
      response.appendResponseLine('Execution is not paused. Cannot evaluate.');
      return;
    }

    const {expression, frameIndex} = request.params;

    if (frameIndex >= pausedState.callFrames.length) {
      response.appendResponseLine(
        `Invalid frame index ${frameIndex}. Available frames: 0-${pausedState.callFrames.length - 1}`,
      );
      return;
    }

    const callFrameId = pausedState.callFrames[frameIndex].callFrameId;

    try {
      const result = await debugger_.evaluateOnCallFrame(
        callFrameId,
        expression,
        {
          returnByValue: true,
          generatePreview: true,
        },
      );

      if (result.exceptionDetails) {
        response.appendResponseLine(
          `❌ Error: ${result.exceptionDetails.text}`,
        );
        if (result.exceptionDetails.exception) {
          response.appendResponseLine(
            `   ${result.exceptionDetails.exception.description || ''}`,
          );
        }
      } else {
        response.appendResponseLine(`📝 Result:`);
        if (result.result.value !== undefined) {
          const valueStr =
            typeof result.result.value === 'string'
              ? `"${result.result.value}"`
              : JSON.stringify(result.result.value, null, 2);
          response.appendResponseLine(valueStr);
        } else {
          response.appendResponseLine(
            result.result.description || `[${result.result.type}]`,
          );
        }
      }
    } catch (error) {
      response.appendResponseLine(
        `Error evaluating: ${error instanceof Error ? error.message : String(error)}`,
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
    'Sets a breakpoint on specific code (function name, statement, etc.) by searching for it and automatically determining the exact position. Works with both normal and minified files.',
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
      const source = await debugger_.getScriptSource(match.scriptId);
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
 * Hook a function to monitor its calls and return values.
 */
export const hookFunction = defineTool({
  name: 'hook_function',
  description:
    'Hooks a JavaScript function to log its calls, arguments, and return values. Useful for understanding how functions are used without setting breakpoints.',
  annotations: {
    title: 'Hook Function',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {
    target: zod
      .string()
      .describe(
        'The function to hook. Can be: global function name ("fetch"), object method ("XMLHttpRequest.prototype.open"), or path ("window.app.api.request").',
      ),
    logArgs: zod
      .boolean()
      .optional()
      .default(true)
      .describe('Whether to log function arguments (default: true).'),
    logResult: zod
      .boolean()
      .optional()
      .default(true)
      .describe('Whether to log return value (default: true).'),
    logStack: zod
      .boolean()
      .optional()
      .default(false)
      .describe('Whether to log call stack (default: false).'),
    hookId: zod
      .string()
      .optional()
      .describe(
        'Custom identifier for this hook. Used to unhook later. Defaults to target name.',
      ),
  },
  handler: async (request, response, context) => {
    const {target, logArgs, logResult, logStack, hookId} = request.params;
    const id = hookId || target.replace(/[^a-zA-Z0-9]/g, '_');

    // Split target into object path and method
    const parts = target.split('.');
    const methodName = parts.pop()!;
    const objectPath = parts.length > 0 ? parts.join('.') : 'window';

    const hookCode = `
(function() {
  const hookId = ${JSON.stringify(id)};
  const objectPath = ${JSON.stringify(objectPath)};
  const methodName = ${JSON.stringify(methodName)};
  const logArgs = ${logArgs};
  const logResult = ${logResult};
  const logStack = ${logStack};

  // Get the object
  let obj;
  try {
    obj = objectPath === 'window' ? window : eval(objectPath);
  } catch(e) {
    throw new Error('Cannot find object: ' + objectPath);
  }

  if (!obj || typeof obj[methodName] !== 'function') {
    throw new Error('Cannot find function: ' + methodName + ' on ' + objectPath);
  }

  // Store original and hooks registry
  window.__mcp_hooks__ = window.__mcp_hooks__ || {};
  if (window.__mcp_hooks__[hookId]) {
    return { success: false, message: 'Hook already exists with id: ' + hookId };
  }

  const original = obj[methodName];
  window.__mcp_hooks__[hookId] = { obj, methodName, original };

  // Create hooked function
  obj[methodName] = function(...args) {
    const callInfo = {
      hook: hookId,
      target: objectPath + '.' + methodName,
      timestamp: new Date().toISOString(),
    };

    if (logArgs) {
      callInfo.arguments = args.map(arg => {
        try {
          if (typeof arg === 'function') return '[Function]';
          if (arg instanceof Element) return '[Element: ' + arg.tagName + ']';
          return JSON.parse(JSON.stringify(arg));
        } catch(e) {
          return String(arg);
        }
      });
    }

    if (logStack) {
      callInfo.stack = new Error().stack?.split('\\n').slice(2, 6).map(s => s.trim());
    }

    console.log('[MCP Hook]', callInfo);

    try {
      const result = original.apply(this, args);

      // Handle promises
      if (result && typeof result.then === 'function') {
        return result.then(res => {
          if (logResult) {
            try {
              const resInfo = typeof res === 'object' ? JSON.parse(JSON.stringify(res)) : res;
              console.log('[MCP Hook Result]', { hook: hookId, result: resInfo });
            } catch(e) {
              console.log('[MCP Hook Result]', { hook: hookId, result: String(res) });
            }
          }
          return res;
        }).catch(err => {
          console.log('[MCP Hook Error]', { hook: hookId, error: err.message });
          throw err;
        });
      }

      if (logResult) {
        try {
          const resInfo = typeof result === 'object' ? JSON.parse(JSON.stringify(result)) : result;
          console.log('[MCP Hook Result]', { hook: hookId, result: resInfo });
        } catch(e) {
          console.log('[MCP Hook Result]', { hook: hookId, result: String(result) });
        }
      }

      return result;
    } catch(err) {
      console.log('[MCP Hook Error]', { hook: hookId, error: err.message });
      throw err;
    }
  };

  // Preserve function properties
  Object.keys(original).forEach(key => {
    try { obj[methodName][key] = original[key]; } catch(e) {}
  });

  return { success: true, hookId: hookId };
})();
`;

    try {
      const frame = context.getSelectedFrame();
      const result = await frame.evaluate(hookCode);

      if (result && typeof result === 'object') {
        if ((result as {success: boolean}).success) {
          response.appendResponseLine(`✅ Hook installed successfully!`);
          response.appendResponseLine(`- Hook ID: ${id}`);
          response.appendResponseLine(`- Target: ${target}`);
          response.appendResponseLine(`- Log args: ${logArgs}`);
          response.appendResponseLine(`- Log result: ${logResult}`);
          response.appendResponseLine(`- Log stack: ${logStack}`);
          response.appendResponseLine('');
          response.appendResponseLine(
            'Function calls will be logged to console. Use list_console_messages to view.',
          );
          response.appendResponseLine(
            `Use unhook_function(hookId: "${id}") to remove.`,
          );
        } else {
          response.appendResponseLine(
            `❌ ${(result as {message: string}).message}`,
          );
        }
      }
    } catch (error) {
      response.appendResponseLine(
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

/**
 * Remove a function hook.
 */
export const unhookFunction = defineTool({
  name: 'unhook_function',
  description: 'Removes a previously installed function hook.',
  annotations: {
    title: 'Unhook Function',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {
    hookId: zod
      .string()
      .describe('The hook ID to remove (from hook_function).'),
  },
  handler: async (request, response, context) => {
    const {hookId} = request.params;

    const unhookCode = `
(function() {
  const hookId = ${JSON.stringify(hookId)};
  if (!window.__mcp_hooks__ || !window.__mcp_hooks__[hookId]) {
    return { success: false, message: 'Hook not found: ' + hookId };
  }

  const { obj, methodName, original } = window.__mcp_hooks__[hookId];
  obj[methodName] = original;
  delete window.__mcp_hooks__[hookId];

  return { success: true };
})();
`;

    try {
      const frame = context.getSelectedFrame();
      const result = await frame.evaluate(unhookCode);

      if (result && typeof result === 'object') {
        if ((result as {success: boolean}).success) {
          response.appendResponseLine(
            `✅ Hook "${hookId}" removed successfully.`,
          );
        } else {
          response.appendResponseLine(
            `❌ ${(result as {message: string}).message}`,
          );
        }
      }
    } catch (error) {
      response.appendResponseLine(
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

/**
 * List all active hooks.
 */
export const listHooks = defineTool({
  name: 'list_hooks',
  description: 'Lists all active function hooks.',
  annotations: {
    title: 'List Hooks',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: true,
  },
  schema: {},
  handler: async (request, response, context) => {
    const listCode = `
(function() {
  if (!window.__mcp_hooks__) return [];
  return Object.keys(window.__mcp_hooks__).map(id => {
    const hook = window.__mcp_hooks__[id];
    return { id, target: hook.obj.constructor.name + '.' + hook.methodName };
  });
})();
`;

    try {
      const frame = context.getSelectedFrame();
      const hooks = (await frame.evaluate(listCode)) as Array<{
        id: string;
        target: string;
      }>;

      if (!hooks || hooks.length === 0) {
        response.appendResponseLine('No active hooks.');
        return;
      }

      response.appendResponseLine(`Active hooks (${hooks.length}):\n`);
      for (const hook of hooks) {
        response.appendResponseLine(`- ${hook.id}: ${hook.target}`);
      }
    } catch (error) {
      response.appendResponseLine(
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

/**
 * Inspect an object deeply.
 */
export const inspectObject = defineTool({
  name: 'inspect_object',
  description:
    'Deeply inspects a JavaScript object, showing its properties, prototype chain, and methods. Useful for understanding object structure.',
  annotations: {
    title: 'Inspect Object',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: true,
  },
  schema: {
    expression: zod
      .string()
      .describe(
        'JavaScript expression to evaluate and inspect (e.g., "window.app", "document.body", "myObject").',
      ),
    depth: zod
      .number()
      .int()
      .optional()
      .default(2)
      .describe('How deep to inspect nested objects (default: 2).'),
    showMethods: zod
      .boolean()
      .optional()
      .default(true)
      .describe('Whether to show methods (default: true).'),
    showPrototype: zod
      .boolean()
      .optional()
      .default(true)
      .describe('Whether to show prototype chain (default: true).'),
  },
  handler: async (request, response, context) => {
    const {expression, depth, showMethods, showPrototype} = request.params;

    const inspectCode = `
(function() {
  const maxDepth = ${depth};
  const showMethods = ${showMethods};
  const showPrototype = ${showPrototype};

  let target;
  try {
    target = eval(${JSON.stringify(expression)});
  } catch(e) {
    return { error: 'Cannot evaluate: ' + e.message };
  }

  if (target === null) return { type: 'null', value: null };
  if (target === undefined) return { type: 'undefined', value: undefined };

  const seen = new WeakSet();

  function inspect(obj, currentDepth) {
    if (currentDepth > maxDepth) return '[Max depth reached]';
    if (obj === null) return null;
    if (obj === undefined) return undefined;

    const type = typeof obj;
    if (type !== 'object' && type !== 'function') return obj;

    if (seen.has(obj)) return '[Circular]';
    seen.add(obj);

    if (Array.isArray(obj)) {
      if (obj.length > 100) return '[Array(' + obj.length + ')]';
      return obj.slice(0, 20).map(item => inspect(item, currentDepth + 1));
    }

    const result = {};
    const props = Object.getOwnPropertyNames(obj);

    for (const prop of props.slice(0, 50)) {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(obj, prop);
        const value = obj[prop];
        const valueType = typeof value;

        if (valueType === 'function') {
          if (showMethods) {
            result[prop] = '[Function: ' + (value.name || 'anonymous') + ']';
          }
        } else if (valueType === 'object' && value !== null) {
          result[prop] = inspect(value, currentDepth + 1);
        } else {
          result[prop] = value;
        }
      } catch(e) {
        result[prop] = '[Error: ' + e.message + ']';
      }
    }

    if (props.length > 50) {
      result['...'] = (props.length - 50) + ' more properties';
    }

    return result;
  }

  const result = {
    type: typeof target,
    constructor: target.constructor?.name,
    value: inspect(target, 0),
  };

  if (showPrototype && typeof target === 'object') {
    const protoChain = [];
    let proto = Object.getPrototypeOf(target);
    while (proto && protoChain.length < 5) {
      protoChain.push(proto.constructor?.name || 'Object');
      proto = Object.getPrototypeOf(proto);
    }
    result.prototypeChain = protoChain;
  }

  return result;
})();
`;

    try {
      const frame = context.getSelectedFrame();
      const result = await frame.evaluate(inspectCode);

      if (result && typeof result === 'object' && 'error' in result) {
        response.appendResponseLine(`❌ ${(result as {error: string}).error}`);
        return;
      }

      response.appendResponseLine(`Inspecting: ${expression}\n`);
      response.appendResponseLine('```json');
      response.appendResponseLine(JSON.stringify(result, null, 2));
      response.appendResponseLine('```');
    } catch (error) {
      response.appendResponseLine(
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

/**
 * Get browser storage data.
 */
export const getStorage = defineTool({
  name: 'get_storage',
  description:
    'Gets browser storage data including cookies, localStorage, and sessionStorage.',
  annotations: {
    title: 'Get Storage',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: true,
  },
  schema: {
    type: zod
      .enum(['all', 'cookies', 'localStorage', 'sessionStorage'])
      .optional()
      .default('all')
      .describe('Which storage to retrieve (default: all).'),
    filter: zod
      .string()
      .optional()
      .describe('Optional filter string to match against keys/names.'),
  },
  handler: async (request, response, context) => {
    const {type, filter} = request.params;

    const storageCode = `
(function() {
  const type = ${JSON.stringify(type)};
  const filter = ${JSON.stringify(filter)};
  const result = {};

  function matchFilter(key) {
    if (!filter) return true;
    return key.toLowerCase().includes(filter.toLowerCase());
  }

  if (type === 'all' || type === 'cookies') {
    const cookies = {};
    document.cookie.split(';').forEach(c => {
      const [name, ...valueParts] = c.trim().split('=');
      if (name && matchFilter(name)) {
        cookies[name] = valueParts.join('=');
      }
    });
    result.cookies = cookies;
  }

  if (type === 'all' || type === 'localStorage') {
    const local = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && matchFilter(key)) {
        try {
          const value = localStorage.getItem(key);
          try {
            local[key] = JSON.parse(value);
          } catch {
            local[key] = value;
          }
        } catch(e) {
          local[key] = '[Error reading]';
        }
      }
    }
    result.localStorage = local;
  }

  if (type === 'all' || type === 'sessionStorage') {
    const session = {};
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key && matchFilter(key)) {
        try {
          const value = sessionStorage.getItem(key);
          try {
            session[key] = JSON.parse(value);
          } catch {
            session[key] = value;
          }
        } catch(e) {
          session[key] = '[Error reading]';
        }
      }
    }
    result.sessionStorage = session;
  }

  return result;
})();
`;

    try {
      const frame = context.getSelectedFrame();
      const result = await frame.evaluate(storageCode);

      response.appendResponseLine(
        `Storage data${filter ? ` (filter: "${filter}")` : ''}:\n`,
      );
      response.appendResponseLine('```json');
      response.appendResponseLine(JSON.stringify(result, null, 2));
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
      await client.send('DOMDebugger.setXHRBreakpoint', {url});
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
 * Remove XHR/Fetch breakpoint.
 */
export const removeXhrBreakpoint = defineTool({
  name: 'remove_xhr_breakpoint',
  description: 'Removes an XHR/Fetch breakpoint.',
  annotations: {
    title: 'Remove XHR Breakpoint',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {
    url: zod.string().describe('The URL pattern to remove breakpoint for.'),
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
      await client.send('DOMDebugger.removeXHRBreakpoint', {url});
      response.appendResponseLine(`✅ XHR breakpoint removed for: "${url}"`);
    } catch (error) {
      response.appendResponseLine(
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

/**
 * Monitor events on an element or window.
 */
export const monitorEvents = defineTool({
  name: 'monitor_events',
  description:
    'Monitors DOM events on a specified element or window. Events will be logged to console.',
  annotations: {
    title: 'Monitor Events',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {
    selector: zod
      .string()
      .optional()
      .default('window')
      .describe(
        'CSS selector for element to monitor, or "window"/"document" (default: window).',
      ),
    events: zod
      .array(zod.string())
      .optional()
      .describe(
        'Specific events to monitor (e.g., ["click", "keydown"]). If not specified, monitors common events.',
      ),
    monitorId: zod
      .string()
      .optional()
      .describe('Custom ID for this monitor. Used to stop monitoring later.'),
  },
  handler: async (request, response, context) => {
    const {selector, events, monitorId} = request.params;
    const id = monitorId || selector?.replace(/[^a-zA-Z0-9]/g, '_') || 'window';

    const defaultEvents = [
      'click',
      'dblclick',
      'mousedown',
      'mouseup',
      'keydown',
      'keyup',
      'keypress',
      'submit',
      'change',
      'input',
      'focus',
      'blur',
    ];

    const monitorCode = `
(function() {
  const selector = ${JSON.stringify(selector)};
  const events = ${JSON.stringify(events || defaultEvents)};
  const monitorId = ${JSON.stringify(id)};

  window.__mcp_monitors__ = window.__mcp_monitors__ || {};
  if (window.__mcp_monitors__[monitorId]) {
    return { success: false, message: 'Monitor already exists: ' + monitorId };
  }

  let target;
  if (selector === 'window') {
    target = window;
  } else if (selector === 'document') {
    target = document;
  } else {
    target = document.querySelector(selector);
    if (!target) {
      return { success: false, message: 'Element not found: ' + selector };
    }
  }

  const listeners = {};

  events.forEach(eventType => {
    const handler = (e) => {
      const info = {
        monitor: monitorId,
        event: eventType,
        timestamp: new Date().toISOString(),
        target: e.target?.tagName || 'unknown',
      };

      if (e.target?.id) info.targetId = e.target.id;
      if (e.target?.className) info.targetClass = e.target.className;
      if (e.key) info.key = e.key;
      if (e.code) info.code = e.code;
      if (e.clientX !== undefined) info.position = { x: e.clientX, y: e.clientY };

      console.log('[MCP Event]', info);
    };

    target.addEventListener(eventType, handler, true);
    listeners[eventType] = handler;
  });

  window.__mcp_monitors__[monitorId] = { target, listeners };

  return { success: true, monitorId, eventCount: events.length };
})();
`;

    try {
      const frame = context.getSelectedFrame();
      const result = await frame.evaluate(monitorCode);

      if (result && typeof result === 'object') {
        if ((result as {success: boolean}).success) {
          const r = result as {monitorId: string; eventCount: number};
          response.appendResponseLine(`✅ Event monitor started!`);
          response.appendResponseLine(`- Monitor ID: ${r.monitorId}`);
          response.appendResponseLine(`- Target: ${selector}`);
          response.appendResponseLine(`- Events: ${r.eventCount} types`);
          response.appendResponseLine('');
          response.appendResponseLine(
            'Events will be logged to console. Use list_console_messages to view.',
          );
          response.appendResponseLine(
            `Use stop_monitor(monitorId: "${r.monitorId}") to stop.`,
          );
        } else {
          response.appendResponseLine(
            `❌ ${(result as {message: string}).message}`,
          );
        }
      }
    } catch (error) {
      response.appendResponseLine(
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

/**
 * Stop monitoring events.
 */
export const stopMonitor = defineTool({
  name: 'stop_monitor',
  description: 'Stops an event monitor.',
  annotations: {
    title: 'Stop Monitor',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {
    monitorId: zod.string().describe('The monitor ID to stop.'),
  },
  handler: async (request, response, context) => {
    const {monitorId} = request.params;

    const stopCode = `
(function() {
  const monitorId = ${JSON.stringify(monitorId)};
  if (!window.__mcp_monitors__ || !window.__mcp_monitors__[monitorId]) {
    return { success: false, message: 'Monitor not found: ' + monitorId };
  }

  const { target, listeners } = window.__mcp_monitors__[monitorId];
  Object.entries(listeners).forEach(([eventType, handler]) => {
    target.removeEventListener(eventType, handler, true);
  });

  delete window.__mcp_monitors__[monitorId];
  return { success: true };
})();
`;

    try {
      const frame = context.getSelectedFrame();
      const result = await frame.evaluate(stopCode);

      if (result && typeof result === 'object') {
        if ((result as {success: boolean}).success) {
          response.appendResponseLine(`✅ Monitor "${monitorId}" stopped.`);
        } else {
          response.appendResponseLine(
            `❌ ${(result as {message: string}).message}`,
          );
        }
      }
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
    'Traces calls to a function by its name in the source code. Works for ANY function including module-internal functions (webpack/rollup bundled). Uses "logpoints" (conditional breakpoints) to log arguments without pausing execution.',
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
          'Tip: Use search_in_sources to find the exact function signature, then use set_breakpoint.',
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
      const source = await debugger_.getScriptSource(match.scriptId);
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
