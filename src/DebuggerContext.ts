/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Use devtools-protocol types for data structures.
// The CDPSession is typed as 'any' in this class to bridge
// devtools-protocol and patchright Protocol type incompatibilities.
import type {Protocol} from 'devtools-protocol';

export interface ScriptInfo {
  scriptId: string;
  url: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  hash: string;
  sourceMapURL?: string;
}

export interface BreakpointInfo {
  breakpointId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
  condition?: string;
  isRegex?: boolean;
  locations: Array<{
    scriptId: string;
    lineNumber: number;
    columnNumber: number;
  }>;
}

export interface SearchMatch {
  scriptId: string;
  url: string;
  lineNumber: number;
  lineContent: string;
}

export interface SearchResult {
  query: string;
  matches: SearchMatch[];
}

export interface CallFrame {
  callFrameId: string;
  functionName: string;
  location: {
    scriptId: string;
    lineNumber: number;
    columnNumber: number;
  };
  url: string;
  scopeChain: ScopeInfo[];
  this: RemoteObject;
}

export interface ScopeInfo {
  type:
    | 'global'
    | 'local'
    | 'with'
    | 'closure'
    | 'catch'
    | 'block'
    | 'script'
    | 'eval'
    | 'module'
    | 'wasm-expression-stack';
  object: RemoteObject;
  name?: string;
  startLocation?: {
    scriptId: string;
    lineNumber: number;
    columnNumber: number;
  };
  endLocation?: {
    scriptId: string;
    lineNumber: number;
    columnNumber: number;
  };
}

export interface RemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  description?: string;
  objectId?: string;
}

export interface PausedState {
  isPaused: boolean;
  reason?: string;
  callFrames: CallFrame[];
  data?: unknown;
  hitBreakpoints?: string[];
}

export interface ScopeVariable {
  name: string;
  type: string;
  value: unknown;
  description?: string;
}

export interface EvaluateResult {
  result: RemoteObject;
  exceptionDetails?: {
    text: string;
    exception?: RemoteObject;
  };
}

/**
 * DebuggerContext manages the Chrome DevTools Protocol Debugger domain.
 * It tracks loaded scripts, manages breakpoints, and provides search functionality.
 */
export class DebuggerContext {
  // Use 'any' to bridge devtools-protocol and patchright Protocol type incompatibilities
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #client: any = null;
  #scripts = new Map<string, ScriptInfo>(); // scriptId -> info
  #urlToScripts = new Map<string, string[]>(); // url -> scriptId[]
  #breakpoints = new Map<string, BreakpointInfo>(); // breakpointId -> info
  #xhrBreakpoints = new Set<string>(); // tracked XHR breakpoint URL patterns
  #enabled = false;
  #pausedState: PausedState = {isPaused: false, callFrames: []};

  /**
   * Enable the debugger and start tracking scripts.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async enable(client: any): Promise<void> {
    if (this.#enabled && this.#client === client) {
      return;
    }

    this.#client = client;
    this.#scripts.clear();
    this.#urlToScripts.clear();

    // Listen for script parsed events
    client.on('Debugger.scriptParsed', this.#onScriptParsed);

    // Listen for paused/resumed events
    client.on('Debugger.paused', this.#onPaused);
    client.on('Debugger.resumed', this.#onResumed);

    // Enable the debugger domain
    await client.send('Debugger.enable');

    // Set async call stack depth for better stack traces
    try {
      await client.send('Debugger.setAsyncCallStackDepth', {maxDepth: 32});
    } catch {
      // Ignore errors - some older versions may not support this
    }

    this.#enabled = true;
  }

  /**
   * Disable the debugger.
   */
  async disable(): Promise<void> {
    if (!this.#enabled || !this.#client) {
      return;
    }

    this.#client.off('Debugger.scriptParsed', this.#onScriptParsed);
    this.#client.off('Debugger.paused', this.#onPaused);
    this.#client.off('Debugger.resumed', this.#onResumed);

    try {
      await this.#client.send('Debugger.disable');
    } catch {
      // Ignore errors during cleanup
    }

    this.#scripts.clear();
    this.#urlToScripts.clear();
    this.#breakpoints.clear();
    this.#pausedState = {isPaused: false, callFrames: []};
    this.#enabled = false;
    this.#client = null;
  }

  /**
   * Check if debugger is enabled.
   */
  isEnabled(): boolean {
    return this.#enabled;
  }

  /**
   * Get the CDP client.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getClient(): any {
    return this.#client;
  }

  #onScriptParsed = (event: Protocol.Debugger.ScriptParsedEvent): void => {
    const scriptInfo: ScriptInfo = {
      scriptId: event.scriptId,
      url: event.url || '',
      startLine: event.startLine,
      startColumn: event.startColumn,
      endLine: event.endLine,
      endColumn: event.endColumn,
      hash: event.hash,
      sourceMapURL: event.sourceMapURL,
    };

    this.#scripts.set(event.scriptId, scriptInfo);

    // Index by URL for quick lookup
    if (event.url) {
      const scriptIds = this.#urlToScripts.get(event.url) || [];
      if (!scriptIds.includes(event.scriptId)) {
        scriptIds.push(event.scriptId);
        this.#urlToScripts.set(event.url, scriptIds);
      }
    }
  };

  #onPaused = (event: Protocol.Debugger.PausedEvent): void => {
    const callFrames: CallFrame[] = event.callFrames.map(frame => ({
      callFrameId: frame.callFrameId,
      functionName: frame.functionName || '<anonymous>',
      location: {
        scriptId: frame.location.scriptId,
        lineNumber: frame.location.lineNumber,
        columnNumber: frame.location.columnNumber ?? 0,
      },
      url: frame.url || '',
      scopeChain: frame.scopeChain.map(scope => ({
        type: scope.type as ScopeInfo['type'],
        object: {
          type: scope.object.type,
          subtype: scope.object.subtype,
          className: scope.object.className,
          value: scope.object.value,
          description: scope.object.description,
          objectId: scope.object.objectId,
        },
        name: scope.name,
        startLocation: scope.startLocation
          ? {
              scriptId: scope.startLocation.scriptId,
              lineNumber: scope.startLocation.lineNumber,
              columnNumber: scope.startLocation.columnNumber ?? 0,
            }
          : undefined,
        endLocation: scope.endLocation
          ? {
              scriptId: scope.endLocation.scriptId,
              lineNumber: scope.endLocation.lineNumber,
              columnNumber: scope.endLocation.columnNumber ?? 0,
            }
          : undefined,
      })),
      this: {
        type: frame.this.type,
        subtype: frame.this.subtype,
        className: frame.this.className,
        value: frame.this.value,
        description: frame.this.description,
        objectId: frame.this.objectId,
      },
    }));

    this.#pausedState = {
      isPaused: true,
      reason: event.reason,
      callFrames,
      data: event.data,
      hitBreakpoints: event.hitBreakpoints,
    };
  };

  #onResumed = (): void => {
    this.#pausedState = {isPaused: false, callFrames: []};
  };

  // ==================== Paused State Management ====================

  /**
   * Check if execution is paused.
   */
  isPaused(): boolean {
    return this.#pausedState.isPaused;
  }

  /**
   * Get the current paused state.
   */
  getPausedState(): PausedState {
    return this.#pausedState;
  }

  /**
   * Resume execution.
   */
  async resume(): Promise<void> {
    if (!this.#client) {
      throw new Error('Debugger not enabled');
    }
    if (!this.#pausedState.isPaused) {
      throw new Error('Execution is not paused');
    }
    await this.#client.send('Debugger.resume');
  }

  /**
   * Pause execution.
   */
  async pause(): Promise<void> {
    if (!this.#client) {
      throw new Error('Debugger not enabled');
    }
    await this.#client.send('Debugger.pause');
  }

  /**
   * Wait for the next Debugger.paused event after a step command.
   * Returns the top call frame from the new paused state.
   */
  #waitForPaused(timeoutMs = 10000): Promise<CallFrame> {
    return new Promise<CallFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#client?.off('Debugger.paused', onPaused);
        reject(new Error('Timed out waiting for debugger to pause after step'));
      }, timeoutMs);

      const onPaused = (event: Protocol.Debugger.PausedEvent): void => {
        clearTimeout(timer);
        this.#client?.off('Debugger.paused', onPaused);
        // The #onPaused handler will also fire and update #pausedState.
        // We resolve with the top frame from the event directly.
        const topFrame = event.callFrames[0];
        if (topFrame) {
          resolve({
            callFrameId: topFrame.callFrameId,
            functionName: topFrame.functionName || '<anonymous>',
            location: {
              scriptId: topFrame.location.scriptId,
              lineNumber: topFrame.location.lineNumber,
              columnNumber: topFrame.location.columnNumber ?? 0,
            },
            url: topFrame.url || '',
            scopeChain: [],
            this: {type: topFrame.this.type},
          });
        } else {
          reject(new Error('Paused with no call frames'));
        }
      };

      this.#client.on('Debugger.paused', onPaused);
    });
  }

  /**
   * Step over the next statement.
   * Returns the top call frame after pausing.
   */
  async stepOver(): Promise<CallFrame> {
    if (!this.#client) {
      throw new Error('Debugger not enabled');
    }
    if (!this.#pausedState.isPaused) {
      throw new Error('Execution is not paused');
    }
    const pausedPromise = this.#waitForPaused();
    await this.#client.send('Debugger.stepOver');
    return pausedPromise;
  }

  /**
   * Step into the next function call.
   * Returns the top call frame after pausing.
   */
  async stepInto(): Promise<CallFrame> {
    if (!this.#client) {
      throw new Error('Debugger not enabled');
    }
    if (!this.#pausedState.isPaused) {
      throw new Error('Execution is not paused');
    }
    const pausedPromise = this.#waitForPaused();
    await this.#client.send('Debugger.stepInto');
    return pausedPromise;
  }

  /**
   * Step out of the current function.
   * Returns the top call frame after pausing.
   */
  async stepOut(): Promise<CallFrame> {
    if (!this.#client) {
      throw new Error('Debugger not enabled');
    }
    if (!this.#pausedState.isPaused) {
      throw new Error('Execution is not paused');
    }
    const pausedPromise = this.#waitForPaused();
    await this.#client.send('Debugger.stepOut');
    return pausedPromise;
  }

  /**
   * Get variables from a scope.
   */
  async getScopeVariables(objectId: string): Promise<ScopeVariable[]> {
    if (!this.#client) {
      throw new Error('Debugger not enabled');
    }

    const result = await this.#client.send('Runtime.getProperties', {
      objectId,
      ownProperties: true,
      accessorPropertiesOnly: false,
      generatePreview: true,
    });

    const variables: ScopeVariable[] = [];

    for (const prop of result.result) {
      // Skip internal properties
      if (prop.name.startsWith('__') || prop.name === 'this') {
        continue;
      }

      const value = prop.value;
      if (!value) {
        continue;
      }

      variables.push({
        name: prop.name,
        type: value.type,
        value: value.value ?? value.description ?? `[${value.type}]`,
        description: value.description,
      });
    }

    return variables;
  }

  /**
   * Evaluate expression on a specific call frame.
   */
  async evaluateOnCallFrame(
    callFrameId: string,
    expression: string,
    options: {
      returnByValue?: boolean;
      generatePreview?: boolean;
    } = {},
  ): Promise<EvaluateResult> {
    if (!this.#client) {
      throw new Error('Debugger not enabled');
    }
    if (!this.#pausedState.isPaused) {
      throw new Error('Execution is not paused');
    }

    const result = await this.#client.send('Debugger.evaluateOnCallFrame', {
      callFrameId,
      expression,
      returnByValue: options.returnByValue ?? false,
      generatePreview: options.generatePreview ?? true,
    });

    return {
      result: {
        type: result.result.type,
        subtype: result.result.subtype,
        className: result.result.className,
        value: result.result.value,
        description: result.result.description,
        objectId: result.result.objectId,
      },
      exceptionDetails: result.exceptionDetails
        ? {
            text: result.exceptionDetails.text,
            exception: result.exceptionDetails.exception
              ? {
                  type: result.exceptionDetails.exception.type,
                  value: result.exceptionDetails.exception.value,
                  description: result.exceptionDetails.exception.description,
                }
              : undefined,
          }
        : undefined,
    };
  }

  // ==================== Script Management ====================

  /**
   * Get all loaded scripts.
   */
  getScripts(): ScriptInfo[] {
    return Array.from(this.#scripts.values());
  }

  /**
   * Get scripts by URL (exact match).
   */
  getScriptsByUrl(url: string): ScriptInfo[] {
    const scriptIds = this.#urlToScripts.get(url) || [];
    return scriptIds
      .map(id => this.#scripts.get(id))
      .filter((s): s is ScriptInfo => s !== undefined);
  }

  /**
   * Get scripts by URL pattern (partial match).
   */
  getScriptsByUrlPattern(pattern: string): ScriptInfo[] {
    const results: ScriptInfo[] = [];
    const lowerPattern = pattern.toLowerCase();

    for (const script of this.#scripts.values()) {
      if (script.url.toLowerCase().includes(lowerPattern)) {
        results.push(script);
      }
    }

    return results;
  }

  /**
   * Get script info by ID.
   */
  getScriptById(scriptId: string): ScriptInfo | undefined {
    return this.#scripts.get(scriptId);
  }

  /**
   * Get the source code of a script by URL.
   * Resolves URL to the most recent scriptId and returns both source and script info.
   */
  async getScriptSourceByUrl(
    url: string,
  ): Promise<{source: string; bytecode?: string; script: ScriptInfo}> {
    if (!this.#client) {
      throw new Error('Debugger not enabled');
    }

    // Try exact match first
    let scripts = this.getScriptsByUrl(url);

    // Fall back to substring match
    if (scripts.length === 0) {
      scripts = this.getScriptsByUrlPattern(url);
    }

    if (scripts.length === 0) {
      throw new Error(
        `No script found matching URL "${url}". Use list_scripts to see available scripts.`,
      );
    }

    // Pick the last script (most recent parse)
    const script = scripts[scripts.length - 1];
    const result = await this.getScriptSource(script.scriptId);
    return {source: result.scriptSource, bytecode: result.bytecode, script};
  }

  /**
   * Get the source code of a script.
   */
  async getScriptSource(
    scriptId: string,
  ): Promise<{scriptSource: string; bytecode?: string}> {
    if (!this.#client) {
      throw new Error('Debugger not enabled');
    }

    const script = this.#scripts.get(scriptId);

    try {
      const result = await this.#client.send('Debugger.getScriptSource', {
        scriptId,
      });

      return {
        scriptSource: result.scriptSource || '',
        bytecode: result.bytecode,
      };
    } catch (error) {
      if (script?.url.startsWith('data:')) {
        const parts = script.url.split(',');
        if (parts.length > 1) {
          const isBase64 = parts[0].endsWith(';base64');
          const data = parts.slice(1).join(',');
          if (isBase64) {
            if (script.url.includes('wasm')) {
              return {scriptSource: '', bytecode: data};
            }
            return {scriptSource: Buffer.from(data, 'base64').toString('utf-8')};
          } else {
            return {scriptSource: decodeURIComponent(data)};
          }
        }
      }
      throw error;
    }
  }

  /**
   * Search for a string in all scripts.
   */
  async searchInScripts(
    query: string,
    options: {
      caseSensitive?: boolean;
      isRegex?: boolean;
    } = {},
  ): Promise<SearchResult> {
    if (!this.#client) {
      throw new Error('Debugger not enabled');
    }

    const {caseSensitive = false, isRegex = false} = options;
    const matches: SearchMatch[] = [];

    // Search in each script
    for (const script of this.#scripts.values()) {
      // Skip scripts without URLs (inline scripts, eval, etc.)
      // unless they have meaningful content
      if (!script.url && !script.hash) {
        continue;
      }

      try {
        const result = await this.#client.send('Debugger.searchInContent', {
          scriptId: script.scriptId,
          query,
          caseSensitive,
          isRegex,
        });

        for (const match of result.result) {
          matches.push({
            scriptId: script.scriptId,
            url: script.url,
            lineNumber: match.lineNumber,
            lineContent: match.lineContent,
          });
        }
      } catch {
        // Skip scripts that can't be searched (e.g., wasm)
      }
    }

    return {query, matches};
  }

  /**
   * Clear cached scripts without disabling the debugger.
   * Use during same-page navigation where the CDP session stays
   * the same but old script IDs become invalid.
   */
  clearScripts(): void {
    this.#scripts.clear();
    this.#urlToScripts.clear();
  }

  /**
   * Re-set all breakpoints from the stored definitions via CDP.
   * Called after debugger re-enable to restore breakpoints that
   * were wiped by Debugger.disable.
   */
  async restoreBreakpoints(
    breakpoints: BreakpointInfo[],
  ): Promise<void> {
    if (!this.#client) {
      return;
    }

    for (const bp of breakpoints) {
      try {
        const params: Record<string, unknown> = {
          lineNumber: bp.lineNumber,
          columnNumber: bp.columnNumber,
        };
        if (bp.isRegex) {
          params.urlRegex = bp.url;
        } else {
          params.url = bp.url;
        }
        if (bp.condition) {
          params.condition = bp.condition;
        }

        const result = await this.#client.send(
          'Debugger.setBreakpointByUrl',
          params,
        );

        const restoredInfo: BreakpointInfo = {
          breakpointId: result.breakpointId,
          url: bp.url,
          lineNumber: bp.lineNumber,
          columnNumber: bp.columnNumber,
          condition: bp.condition,
          isRegex: bp.isRegex,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          locations: result.locations.map((loc: any) => ({
            scriptId: loc.scriptId,
            lineNumber: loc.lineNumber,
            columnNumber: loc.columnNumber ?? 0,
          })),
        };

        this.#breakpoints.set(result.breakpointId, restoredInfo);
      } catch {
        // Skip breakpoints that fail to restore
      }
    }
  }

  // ==================== XHR Breakpoint Management ====================

  /**
   * Set an XHR/Fetch breakpoint and track it for restoration after navigation.
   */
  async setXHRBreakpoint(url: string): Promise<void> {
    if (!this.#client) {
      throw new Error('Debugger not enabled');
    }
    await this.#client.send('DOMDebugger.setXHRBreakpoint', {url});
    this.#xhrBreakpoints.add(url);
  }

  /**
   * Remove an XHR/Fetch breakpoint.
   */
  async removeXHRBreakpoint(url: string): Promise<void> {
    if (!this.#client) {
      throw new Error('Debugger not enabled');
    }
    await this.#client.send('DOMDebugger.removeXHRBreakpoint', {url});
    this.#xhrBreakpoints.delete(url);
  }

  /**
   * Get all tracked XHR breakpoint URL patterns.
   */
  getXHRBreakpoints(): string[] {
    return Array.from(this.#xhrBreakpoints);
  }

  /**
   * Re-set all XHR breakpoints via CDP.
   * Called after navigation since Chrome resets DOMDebugger state.
   */
  async restoreXHRBreakpoints(): Promise<void> {
    if (!this.#client) {
      return;
    }
    for (const url of this.#xhrBreakpoints) {
      try {
        await this.#client.send('DOMDebugger.setXHRBreakpoint', {url});
      } catch {
        // Skip breakpoints that fail to restore
      }
    }
  }

  // ==================== Breakpoint Management ====================

  /**
   * Set a breakpoint by URL.
   */
  async setBreakpoint(
    url: string,
    lineNumber: number,
    columnNumber = 0,
    condition?: string,
  ): Promise<BreakpointInfo> {
    if (!this.#client) {
      throw new Error('Debugger not enabled');
    }

    const params: Protocol.Debugger.SetBreakpointByUrlRequest = {
      url,
      lineNumber,
      columnNumber,
    };

    if (condition) {
      params.condition = condition;
    }

    const result = await this.#client.send(
      'Debugger.setBreakpointByUrl',
      params,
    );

    const breakpointInfo: BreakpointInfo = {
      breakpointId: result.breakpointId,
      url,
      lineNumber,
      columnNumber,
      condition,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      locations: result.locations.map((loc: any) => ({
        scriptId: loc.scriptId,
        lineNumber: loc.lineNumber,
        columnNumber: loc.columnNumber ?? 0,
      })),
    };

    this.#breakpoints.set(result.breakpointId, breakpointInfo);

    return breakpointInfo;
  }

  /**
   * Set a breakpoint by URL regex pattern.
   */
  async setBreakpointByUrlRegex(
    urlRegex: string,
    lineNumber: number,
    columnNumber = 0,
    condition?: string,
  ): Promise<BreakpointInfo> {
    if (!this.#client) {
      throw new Error('Debugger not enabled');
    }

    const params: Protocol.Debugger.SetBreakpointByUrlRequest = {
      urlRegex,
      lineNumber,
      columnNumber,
    };

    if (condition) {
      params.condition = condition;
    }

    const result = await this.#client.send(
      'Debugger.setBreakpointByUrl',
      params,
    );

    const breakpointInfo: BreakpointInfo = {
      breakpointId: result.breakpointId,
      url: urlRegex, // Store the regex as the URL
      lineNumber,
      columnNumber,
      condition,
      isRegex: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      locations: result.locations.map((loc: any) => ({
        scriptId: loc.scriptId,
        lineNumber: loc.lineNumber,
        columnNumber: loc.columnNumber ?? 0,
      })),
    };

    this.#breakpoints.set(result.breakpointId, breakpointInfo);

    return breakpointInfo;
  }

  /**
   * Remove a breakpoint.
   */
  async removeBreakpoint(breakpointId: string): Promise<void> {
    if (!this.#client) {
      throw new Error('Debugger not enabled');
    }

    await this.#client.send('Debugger.removeBreakpoint', {breakpointId});
    this.#breakpoints.delete(breakpointId);
  }

  /**
   * Remove all breakpoints (code breakpoints + XHR breakpoints).
   */
  async removeAllBreakpoints(): Promise<void> {
    if (!this.#client) {
      throw new Error('Debugger not enabled');
    }

    const breakpointIds = Array.from(this.#breakpoints.keys());
    for (const breakpointId of breakpointIds) {
      try {
        await this.removeBreakpoint(breakpointId);
      } catch {
        // Ignore errors for individual breakpoints
      }
    }

    const xhrUrls = Array.from(this.#xhrBreakpoints);
    for (const url of xhrUrls) {
      try {
        await this.removeXHRBreakpoint(url);
      } catch {
        // Ignore errors for individual XHR breakpoints
      }
    }
  }

  /**
   * Get all active breakpoints.
   */
  getBreakpoints(): BreakpointInfo[] {
    return Array.from(this.#breakpoints.values());
  }

  /**
   * Get breakpoint by ID.
   */
  getBreakpointById(breakpointId: string): BreakpointInfo | undefined {
    return this.#breakpoints.get(breakpointId);
  }
}
