/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BrowserContext, Frame, Page} from './third_party/index.js';

export interface ConsoleBridgeLog {
  id: number;
  level: string;
  text: string;
  args: string[];
  timestamp: number;
  location?: {url?: string; stack?: string};
}

export const CONSOLE_BRIDGE_SOURCE = `(() => {
  const target = globalThis;
  if (target.__mcpConsoleBridgeInstalled) return;
  Object.defineProperty(target, '__mcpConsoleBridgeInstalled', {value: true, configurable: true});
  if (!Array.isArray(target.__mcpConsoleLogs)) {
    Object.defineProperty(target, '__mcpConsoleLogs', {value: [], configurable: true});
  }
  if (typeof target.__mcpConsoleSeq !== 'number') {
    Object.defineProperty(target, '__mcpConsoleSeq', {value: 0, writable: true, configurable: true});
  }

  const format = value => {
    try {
      if (typeof value === 'string') return value;
      if (value === undefined) return 'undefined';
      if (typeof value === 'symbol') return value.toString();
      if (value instanceof Error) return value.stack || value.message;
      if (typeof value === 'object' && value !== null) {
        const json = JSON.stringify(value);
        return json === undefined ? String(value) : json;
      }
      return String(value);
    } catch {
      try { return String(value); } catch { return '[unserializable]'; }
    }
  };

  const stack = () => {
    try {
      return String(new Error().stack || '').split('\\n').slice(3).join('\\n');
    } catch {
      return '';
    }
  };

  for (const level of ['log', 'debug', 'info', 'warn', 'error', 'trace']) {
    const original = console[level];
    if (typeof original !== 'function') continue;
    if (original.__mcpConsoleBridgeWrapped) continue;
    const wrapped = function(...args) {
      try {
        const formatted = args.map(format);
        const logs = target.__mcpConsoleLogs;
        logs.push({
          id: ++target.__mcpConsoleSeq,
          level,
          text: formatted.join(' '),
          args: formatted,
          timestamp: Date.now(),
          location: {url: location.href, stack: stack()},
        });
        if (logs.length > 1000) logs.splice(0, logs.length - 1000);
      } catch {}
      return Reflect.apply(original, this, args);
    };
    Object.defineProperty(wrapped, '__mcpConsoleBridgeWrapped', {value: true});
    Object.defineProperty(wrapped, '__mcpConsoleBridgeOriginal', {value: original});
    console[level] = wrapped;
  }
})()`;

export async function installConsoleBridge(
  context: BrowserContext,
): Promise<void> {
  await Promise.all(context.pages().map(page => ensureConsoleBridge(page)));
}

export async function ensureConsoleBridge(target: Page | Frame): Promise<void> {
  await target.evaluate(CONSOLE_BRIDGE_SOURCE).catch(() => undefined);
}

export async function readConsoleBridgeLogs(
  page: Page,
  options: {clear?: boolean; id?: number} = {},
): Promise<ConsoleBridgeLog[]> {
  await ensureConsoleBridge(page);
  const isolatedLogs = await page
    .evaluate(({clear, id}) => {
      const target = globalThis as unknown as {
        __mcpConsoleLogs?: ConsoleBridgeLog[];
      };
      const logs = Array.isArray(target.__mcpConsoleLogs)
        ? target.__mcpConsoleLogs
        : [];
      const result =
        id === undefined ? [...logs] : logs.filter(log => log.id === id);
      if (clear) logs.length = 0;
      return result;
    }, options)
    .catch(() => []);
  const mainWorldLogs = await readMainWorldConsoleBridgeLogs(page, options);
  return [...isolatedLogs, ...mainWorldLogs];
}

async function readMainWorldConsoleBridgeLogs(
  page: Page,
  options: {clear?: boolean; id?: number},
): Promise<ConsoleBridgeLog[]> {
  return page
    .evaluate(
      ({clear, id}) => {
        const markerId = `__mcp_console_read_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const marker = document.createElement('div');
        marker.id = markerId;
        marker.style.display = 'none';
        document.documentElement.appendChild(marker);

        const script = document.createElement('script');
        script.textContent = `(() => {
          const marker = document.getElementById(${JSON.stringify(markerId)});
          try {
            const logs = Array.isArray(window.__mcpConsoleLogs) ? window.__mcpConsoleLogs : [];
            const id = ${id === undefined ? 'undefined' : JSON.stringify(id)};
            const result = id === undefined ? Array.from(logs) : logs.filter(log => log.id === id);
            marker.setAttribute('data-result', JSON.stringify(result));
            if (${clear ? 'true' : 'false'}) logs.length = 0;
          } catch (error) {
            marker.setAttribute('data-result', '[]');
          }
        })();`;
        document.documentElement.appendChild(script);
        script.remove();
        const raw = marker.getAttribute('data-result') ?? '[]';
        marker.remove();
        try {
          return JSON.parse(raw) as ConsoleBridgeLog[];
        } catch {
          return [];
        }
      },
      {clear: options.clear, id: options.id},
    )
    .catch(() => []);
}
