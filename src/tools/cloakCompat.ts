/**
 * @license
 * Copyright 2026
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import generateModule from '@babel/generator';
import {parse, type ParserPlugin} from '@babel/parser';
import traverseModule, {type NodePath} from '@babel/traverse';
import * as t from '@babel/types';

import {
  closeBrowser,
  getRuntimeLaunchOverrides,
  setRuntimeLaunchOverrides,
} from '../browser.js';
import type {ManagedBrowser} from '../browser.js';
import {
  BROWSER_CONFIG_FILE,
  loadBrowserConnectionConfig,
} from '../browserConfig.js';
import {ensureConsoleBridge, readConsoleBridgeLogs} from '../consoleBridge.js';
import {exportNetworkRequestPart} from '../formatters/networkFormatter.js';
import type {HumanConfig, CursorState} from '../human.js';
import {
  defaultHumanConfig,
  newCursorState,
  humanClickSelector,
  humanTypeText,
  humanScroll as humanScrollAction,
} from '../human.js';
import type {McpContext} from '../McpContext.js';
import {zod} from '../third_party/index.js';
import type {CDPSession, Page} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {boolParam} from './paramHelpers.js';
import {defineTool} from './ToolDefinition.js';

const WAIT_UNTIL = ['load', 'domcontentloaded', 'networkidle'] as const;
const REQUEST_ACTIONS = ['log', 'block', 'modify', 'mock', 'stop'] as const;
const HOOK_POSITIONS = ['before', 'after', 'replace'] as const;
const HOOK_MODES = ['intercept', 'trace'] as const;
const STORAGE_TYPES = ['local', 'session'] as const;
const COOKIE_ACTIONS = ['get', 'set', 'delete'] as const;
const SCRIPT_ACTIONS = ['list', 'get', 'save'] as const;
const MANAGED_BROWSERS = ['chrome', 'edge', 'cloak'] as const;

type InternalContext = McpContext;

const persistentHookIds = new WeakMap<InternalContext, Set<string>>();
const routeRegistry = new WeakMap<InternalContext, Map<string, unknown>>();
const sourceMapCache = new WeakMap<InternalContext, Map<string, unknown>>();
const cpuProfileSessions = new WeakMap<InternalContext, CDPSession>();
const eventListenerBreakpoints = new WeakMap<InternalContext, Set<string>>();
const cdpBreakpoints = new WeakMap<InternalContext, Map<string, unknown>>();
// Instrumentation route tracking: url_pattern �?{tag, stats, handler}
const instrumentationRoutes = new WeakMap<
  InternalContext,
  Map<string, {tag: string; stats: Record<string, unknown>; handler: unknown}>
>();
// Console watermark: tracks how many messages the user has already "cleared"
const consoleWatermark = new WeakMap<InternalContext, number>();
// Per-context cursor state for human-like mouse movement
const cursorStates = new WeakMap<InternalContext, CursorState>();

// Module-level humanize config (set at server startup via setHumanizeConfig)
let _humanizeEnabled = false;
let _humanConfig: HumanConfig = defaultHumanConfig();

/** Called by main.ts to propagate --humanize / --humanPreset settings. */
export function setHumanizeConfig(enabled: boolean, config: HumanConfig): void {
  _humanizeEnabled = enabled;
  _humanConfig = config;
}

// Module-level browser config set by main.ts at server startup.
let _configuredBrowser: ManagedBrowser = 'chrome';
let _configuredBrowserBinaryPath: string | undefined;

/**
 * Propagate CLI browser settings to the tools layer without introducing a
 * circular dependency on main.ts.
 */
export function setBrowserConfig(
  browser: ManagedBrowser,
  binaryPath: string | undefined,
): void {
  _configuredBrowser = browser;
  _configuredBrowserBinaryPath = binaryPath;
}

function getCursorState(internal: InternalContext): CursorState {
  let state = cursorStates.get(internal);
  if (!state) {
    state = newCursorState();
    cursorStates.set(internal, state);
  }
  return state;
}

// Headers that must be stripped when fulfilling a rewritten JS response to
// prevent content-length / encoding mismatches (mirrors Python version).
const STRIP_HEADERS = new Set([
  'content-length',
  'content-encoding',
  'transfer-encoding',
]);

// Runtime shim injected at the top of every instrumented script so that
// __mcp_tap_get / __mcp_tap_call are always defined before the rewritten code.
const INSTRUMENT_RUNTIME = `;(() => {
  if (window.__mcp_instrument_runtime) return;
  window.__mcp_instrument_runtime = true;
  window.__mcp_instrument_log = window.__mcp_instrument_log || [];
  window.__mcp_tap_get = function(tag, key, value) {
    try { window.__mcp_instrument_log.push({type:'tap_get', tag, key:String(key), value:String(value).slice(0,300), ts:Date.now()}); } catch(e) {}
    return value;
  };
  window.__mcp_tap_call = function(tag, key, fn, thisArg, args) {
    try { window.__mcp_instrument_log.push({type:'tap_call', tag, key:String(key), argc:args ? args.length : 0, ts:Date.now()}); } catch(e) {}
    try { return fn.apply(thisArg, args); }
    catch (e) { try { window.__mcp_instrument_log.push({type:'tap_call_err', tag, key:String(key), error:String(e), ts:Date.now()}); } catch(_) {} throw e; }
  };
})();
`;

function asInternalContext(context: unknown): InternalContext {
  return context as InternalContext;
}

interface SourceRewriteResult {
  source: string;
  edits: number;
  mode: 'ast' | 'regex';
  fallbackReason?: string;
}

interface SourceRewriteOptions {
  tag: string;
  mode: 'ast' | 'regex';
  rewriteMemberAccess: boolean;
  maxRewrites: number;
  filterPropertyNames?: string[];
  filterObjectNames?: string[];
  fallbackOnError: boolean;
}

export function rewriteInstrumentedSource(
  src: string,
  options: SourceRewriteOptions,
): SourceRewriteResult {
  if (options.mode === 'regex') {
    const [source, edits] = scannerRewrite(
      src,
      options.tag,
      options.rewriteMemberAccess,
      options.maxRewrites,
      options.filterPropertyNames,
      options.filterObjectNames,
    );
    return {source, edits, mode: 'regex'};
  }

  try {
    const [source, edits] = astRewrite(src, options);
    return {source, edits, mode: 'ast'};
  } catch (error) {
    if (!options.fallbackOnError) throw error;
    const [source, edits] = scannerRewrite(
      src,
      options.tag,
      options.rewriteMemberAccess,
      options.maxRewrites,
      options.filterPropertyNames,
      options.filterObjectNames,
    );
    return {
      source,
      edits,
      mode: 'regex',
      fallbackReason: error instanceof Error ? error.message : String(error),
    };
  }
}

const BABEL_PLUGINS: ParserPlugin[] = ['jsx'];
const generateCode = callableDefault(generateModule);
const traverseAst = callableDefault(traverseModule);

function callableDefault<T extends (...args: never[]) => unknown>(
  value: T | {default: T},
): T {
  return typeof value === 'function' ? value : value.default;
}

function astRewrite(
  src: string,
  options: SourceRewriteOptions,
): [string, number] {
  if (!options.rewriteMemberAccess) {
    return [INSTRUMENT_RUNTIME + '\n' + src, 0];
  }

  const propFilter = new Set(options.filterPropertyNames ?? []);
  const objFilter = new Set(options.filterObjectNames ?? []);
  const ast = parse(src, {
    allowReturnOutsideFunction: true,
    plugins: BABEL_PLUGINS,
    sourceType: 'unambiguous',
  });
  let edits = 0;

  traverseAst(ast, {
    MemberExpression(path) {
      if (edits >= options.maxRewrites) return;
      if (!isSafeMemberRead(path)) return;

      const info = memberAccessInfo(path.node, src);
      if (!info) return;
      if (objFilter.size > 0 && !objFilter.has(info.objectName)) return;
      if (
        propFilter.size > 0 &&
        (!info.propertyName || !propFilter.has(info.propertyName))
      ) {
        return;
      }

      const replacement = t.callExpression(
        t.memberExpression(
          t.identifier('window'),
          t.identifier('__mcp_tap_get'),
        ),
        [
          t.stringLiteral(options.tag),
          t.stringLiteral(info.key),
          t.cloneNode(path.node),
        ],
      );
      path.replaceWith(replacement);
      path.skip();
      edits++;
    },
  });

  const generated = generateCode(
    ast,
    {
      comments: false,
      compact: true,
      jsescOption: {minimal: true},
      minified: true,
    },
    src,
  ).code;
  return [INSTRUMENT_RUNTIME + '\n' + generated, edits];
}

interface MemberAccessInfo {
  objectName: string;
  propertyName?: string;
  key: string;
}

function memberAccessInfo(
  node: t.MemberExpression,
  src: string,
): MemberAccessInfo | undefined {
  if (!t.isIdentifier(node.object) && !t.isThisExpression(node.object)) {
    return undefined;
  }
  if (t.isPrivateName(node.property)) return undefined;

  const objectName = t.isIdentifier(node.object) ? node.object.name : 'this';
  const propertyName = staticPropertyName(node);
  const nodeStart = node.start;
  const nodeEnd = node.end;
  const key =
    nodeStart === null || nodeEnd === null
      ? propertyName
        ? `${objectName}.${propertyName}`
        : objectName
      : src.slice(nodeStart, nodeEnd);
  return {objectName, propertyName, key};
}

function staticPropertyName(node: t.MemberExpression): string | undefined {
  if (!node.computed && t.isIdentifier(node.property))
    return node.property.name;
  if (t.isStringLiteral(node.property)) return node.property.value;
  if (t.isNumericLiteral(node.property)) return String(node.property.value);
  return undefined;
}

function isSafeMemberRead(path: NodePath<t.MemberExpression>): boolean {
  if ('optional' in path.node && path.node.optional) return false;
  if (isWithinAssignmentTarget(path)) return false;

  const parent = path.parentPath;
  if (!parent) return true;
  if (parent.isCallExpression() && parent.node.callee === path.node)
    return false;
  if (parent.isOptionalCallExpression() && parent.node.callee === path.node)
    return false;
  if (parent.isNewExpression() && parent.node.callee === path.node)
    return false;
  if (parent.isTaggedTemplateExpression() && parent.node.tag === path.node)
    return false;
  return true;
}

function isWithinAssignmentTarget(path: NodePath<t.MemberExpression>): boolean {
  return Boolean(
    path.findParent(parent => {
      if (parent.isAssignmentExpression()) {
        return nodeContains(parent.node.left, path.node);
      }
      if (parent.isUpdateExpression()) {
        return nodeContains(parent.node.argument, path.node);
      }
      if (parent.isForInStatement() || parent.isForOfStatement()) {
        return nodeContains(parent.node.left, path.node);
      }
      return false;
    }),
  );
}

function nodeContains(container: t.Node, child: t.Node): boolean {
  if (container === child) return true;
  if (
    container.start == null ||
    container.end == null ||
    child.start == null ||
    child.end == null
  ) {
    return false;
  }
  return container.start <= child.start && child.end <= container.end;
}

/** Fallback scanner for scripts Babel cannot parse. Prefer AST mode. */
function scannerRewrite(
  src: string,
  tag: string,
  rewriteMemberAccess = true,
  maxRewrites = 20000,
  filterPropertyNames?: string[],
  filterObjectNames?: string[],
): [string, number] {
  let edits = 0;
  const propFilter = new Set(filterPropertyNames ?? []);
  const objFilter = new Set(filterObjectNames ?? []);

  if (!rewriteMemberAccess) return [INSTRUMENT_RUNTIME + '\n' + src, edits];

  const chunks: string[] = [];
  let last = 0;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === '/' && next === '/') {
      i = skipLineComment(src, i + 2);
      continue;
    }
    if (ch === '/' && next === '*') {
      i = skipBlockComment(src, i + 2);
      continue;
    }
    if (ch === '/' && looksLikeRegexStart(src, i)) {
      i = skipRegexLiteral(src, i + 1);
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipQuotedString(src, i + 1, ch);
      continue;
    }
    if (ch === '`') {
      i = skipTemplateLiteral(src, i + 1);
      continue;
    }

    if (!isIdentifierStart(ch) || isIdentifierPart(src[i - 1] ?? '')) {
      i++;
      continue;
    }

    const objEnd = readIdentifierEnd(src, i + 1);
    if (src[objEnd] !== '.') {
      i = objEnd;
      continue;
    }
    const propStart = objEnd + 1;
    if (!isIdentifierStart(src[propStart] ?? '')) {
      i = propStart;
      continue;
    }
    const propEnd = readIdentifierEnd(src, propStart + 1);
    const obj = src.slice(i, objEnd);
    const prop = src.slice(propStart, propEnd);
    const after = nextNonSpace(src, propEnd);

    if (objFilter.size > 0 && !objFilter.has(obj)) {
      i = propEnd;
      continue;
    }
    if (propFilter.size > 0 && !propFilter.has(prop)) {
      i = propEnd;
      continue;
    }
    if (
      edits >= maxRewrites ||
      src[after] === '(' ||
      isAssignmentOrUpdate(src, after)
    ) {
      i = propEnd;
      continue;
    }

    chunks.push(src.slice(last, i));
    chunks.push(
      `window.__mcp_tap_get(${JSON.stringify(tag)},${JSON.stringify(`${obj}.${prop}`)},${obj}.${prop})`,
    );
    last = propEnd;
    edits++;
    i = propEnd;
  }

  chunks.push(src.slice(last));
  const out = chunks.join('');
  return [INSTRUMENT_RUNTIME + '\n' + out, edits];
}

function isIdentifierStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch);
}

function isIdentifierPart(ch: string): boolean {
  return /[\w$]/.test(ch);
}

function readIdentifierEnd(src: string, index: number): number {
  while (index < src.length && isIdentifierPart(src[index])) index++;
  return index;
}

function nextNonSpace(src: string, index: number): number {
  while (index < src.length && /\s/.test(src[index])) index++;
  return index;
}

function prevNonSpace(src: string, index: number): string {
  while (index >= 0 && /\s/.test(src[index])) index--;
  return index >= 0 ? src[index] : '';
}

function isAssignmentOrUpdate(src: string, index: number): boolean {
  const ch = src[index];
  const pair = src.slice(index, index + 2);
  if (pair === '++' || pair === '--') return true;
  if (ch === '=' && src[index + 1] !== '=' && src[index - 1] !== '=')
    return true;
  return [
    '+=',
    '-=',
    '*=',
    '/=',
    '%=',
    '&=',
    '|=',
    '^=',
    '??=',
    '||=',
    '&&=',
  ].some(op => src.startsWith(op, index));
}

function skipLineComment(src: string, index: number): number {
  const end = src.indexOf('\n', index);
  return end === -1 ? src.length : end + 1;
}

function skipBlockComment(src: string, index: number): number {
  const end = src.indexOf('*/', index);
  return end === -1 ? src.length : end + 2;
}

function skipQuotedString(src: string, index: number, quote: string): number {
  while (index < src.length) {
    if (src[index] === '\\') {
      index += 2;
      continue;
    }
    if (src[index] === quote) return index + 1;
    index++;
  }
  return index;
}

function skipTemplateLiteral(src: string, index: number): number {
  while (index < src.length) {
    if (src[index] === '\\') {
      index += 2;
      continue;
    }
    if (src[index] === '`') return index + 1;
    index++;
  }
  return index;
}

function looksLikeRegexStart(src: string, index: number): boolean {
  const prev = prevNonSpace(src, index - 1);
  return !prev || '([{=,:;!&|?+-*~^<>'.includes(prev);
}

function skipRegexLiteral(src: string, index: number): number {
  let inClass = false;
  while (index < src.length) {
    const ch = src[index];
    if (ch === '\\') {
      index += 2;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      index++;
      while (/[a-z]/i.test(src[index] ?? '')) index++;
      return index;
    }
    index++;
  }
  return index;
}

/** Generate the "proxy" JSVMP hook source (Proxy-object mode). */
function jsvmpProxyHookSource(options: {
  maxEntries: number;
  proxyObjects: string[];
}): string {
  return `(() => {
  if (window.__mcp_jsvmp_hooked) return;
  window.__mcp_jsvmp_hooked = true;
  window.__mcp_jsvmp_log = window.__mcp_jsvmp_log || [];
  const maxEntries = ${options.maxEntries};
  const proxyObjects = ${JSON.stringify(options.proxyObjects)};
  function push(e) {
    try {
      if (window.__mcp_jsvmp_log.length < maxEntries)
        window.__mcp_jsvmp_log.push({...e, ts: Date.now(), stack: (new Error()).stack});
    } catch(_) {}
  }
  for (const name of proxyObjects) {
    try {
      const obj = window[name];
      if (!obj || typeof obj !== 'object') continue;
      window[name] = new Proxy(obj, {
        get(target, prop, recv) {
          const val = Reflect.get(target, prop, recv);
          push({type: 'get', object: name, key: String(prop), value: String(val).slice(0, 200)});
          // Bind function values to the real target to avoid "Illegal invocation"
          // when calling methods on Storage, Performance, etc. through the Proxy.
          return typeof val === 'function' ? val.bind(target) : val;
        },
        apply(target, thisArg, args) {
          push({type: 'apply', object: name, argc: args.length});
          return Reflect.apply(target, thisArg, args);
        },
      });
    } catch(e) {}
  }
})();`;
}

/** Generate the "transparent" JSVMP hook source (Reflect.get override). */
function jsvmpTransparentHookSource(maxEntries: number): string {
  return `(() => {
  if (window.__mcp_jsvmp_transparent_hooked) return;
  window.__mcp_jsvmp_transparent_hooked = true;
  window.__mcp_jsvmp_log = window.__mcp_jsvmp_log || [];
  const maxEntries = ${maxEntries};
  function push(e) {
    try {
      if (window.__mcp_jsvmp_log.length < maxEntries)
        window.__mcp_jsvmp_log.push({...e, ts: Date.now(), stack: (new Error()).stack});
    } catch(_) {}
  }
  const origGet = Reflect.get;
  Reflect.get = function(target, prop, recv) {
    const val = origGet.apply(this, arguments);
    try { push({type: 'reflect_get', key: String(prop), value: String(val).slice(0, 200)}); } catch(e) {}
    return val;
  };
  try { Reflect.get.toString = () => origGet.toString(); } catch(_) {}
})();`;
}

function appendJson(
  response: {appendResponseLine(value: string): void},
  value: unknown,
): void {
  response.appendResponseLine('```json');
  response.appendResponseLine(JSON.stringify(value, null, 2));
  response.appendResponseLine('```');
}

function appendUnsupportedPersistentClear(
  response: {appendResponseLine(value: string): void},
  count: number,
): void {
  appendJson(response, {
    status: 'unsupported',
    persistent_hooks_registered: count,
    note: 'Persistent init scripts cannot be removed from an existing Playwright/Patchright context. Restart the MCP server or create a new context to clear them.',
  });
}

function errorObject(error: unknown): {type: 'error'; error: string} {
  return {
    type: 'error',
    error: error instanceof Error ? error.message : String(error),
  };
}

async function getCdpSession(context: InternalContext): Promise<CDPSession> {
  return context.sessionProvider.getSession(context.getSelectedPage());
}

async function evaluateMainWorld(page: Page, source: string): Promise<void> {
  await page.evaluate(scriptSource => {
    const script = document.createElement('script');
    script.textContent = scriptSource;
    (document.documentElement || document.head || document.body).appendChild(
      script,
    );
    script.remove();
  }, source);
}

async function addPersistentMainWorldScript(
  context: InternalContext,
  name: string,
  source: string,
): Promise<void> {
  let ids = persistentHookIds.get(context);
  if (!ids) {
    ids = new Set<string>();
    persistentHookIds.set(context, ids);
  }
  if (ids.has(name)) return;
  await context.browserContext.addInitScript(source);
  ids.add(name);
}

function routeMap(context: InternalContext): Map<string, unknown> {
  let map = routeRegistry.get(context);
  if (!map) {
    map = new Map<string, unknown>();
    routeRegistry.set(context, map);
  }
  return map;
}

async function getScriptSourceByUrlOrId(
  context: InternalContext,
  url: string | undefined,
  scriptId: string | undefined,
): Promise<{scriptId: string; url: string; source: string; bytecode?: string}> {
  const debugger_ = context.debuggerContext;
  if (url) {
    const result = await debugger_.getScriptSourceByUrl(url);
    return {
      scriptId: result.script.scriptId,
      url: result.script.url,
      source: result.source,
      bytecode: result.bytecode,
    };
  }
  if (!scriptId) {
    throw new Error('url or script_id/scriptId is required');
  }
  const script = debugger_.getScriptById(scriptId);
  const result = await debugger_.getScriptSource(scriptId);
  return {
    scriptId,
    url: script?.url ?? '',
    source: result.scriptSource,
    bytecode: result.bytecode,
  };
}

function sourceSlice(
  source: string,
  startLine?: number,
  endLine?: number,
  offset?: number,
  length = 1000,
): string {
  if (offset !== undefined) {
    return source.slice(offset, offset + length);
  }
  if (startLine !== undefined || endLine !== undefined) {
    const lines = source.split('\n');
    const start = Math.max(0, (startLine ?? 1) - 1);
    const end = endLine ?? lines.length;
    return lines.slice(start, end).join('\n');
  }
  return source;
}

function hookPresetSource(preset: string): string {
  const base = `
(() => {
  const root = window;
  root.__mcp_hook_log = root.__mcp_hook_log || [];
  const push = (type, payload) => {
    try { root.__mcp_hook_log.push({type, ts: Date.now(), ...payload}); } catch (_) {}
  };
`;
  const end = `})();`;
  switch (preset) {
    case 'xhr':
      return `${base}
  if (!XMLHttpRequest.prototype.__mcp_xhr_hooked) {
    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) { this.__mcp_xhr = {method, url}; return open.call(this, method, url, ...rest); };
    XMLHttpRequest.prototype.send = function(body) { push('xhr', {method: this.__mcp_xhr?.method, url: this.__mcp_xhr?.url, body: String(body || '').slice(0, 2000)}); return send.call(this, body); };
    Object.defineProperty(XMLHttpRequest.prototype, '__mcp_xhr_hooked', {value: true});
  }
${end}`;
    case 'fetch':
      return `${base}
  if (!root.__mcp_fetch_hooked && typeof fetch === 'function') {
    const orig = fetch;
    root.fetch = function(input, init) { push('fetch', {url: String(input?.url || input), method: init?.method || 'GET', body: String(init?.body || '').slice(0, 2000)}); return orig.apply(this, arguments); };
    root.__mcp_fetch_hooked = true;
  }
${end}`;
    case 'crypto':
      return `${base}
  for (const name of ['btoa', 'atob']) {
    if (typeof root[name] === 'function' && !root[name].__mcp_hooked) {
      const orig = root[name];
      root[name] = function(value) { const result = orig.apply(this, arguments); push(name, {input: String(value).slice(0, 2000), result: String(result).slice(0, 2000)}); return result; };
      root[name].__mcp_hooked = true;
    }
  }
  if (root.JSON && !JSON.stringify.__mcp_hooked) {
    const orig = JSON.stringify;
    JSON.stringify = function(value) { const result = orig.apply(this, arguments); push('JSON.stringify', {inputType: typeof value, result: String(result).slice(0, 2000)}); return result; };
    JSON.stringify.__mcp_hooked = true;
  }
${end}`;
    case 'cookie':
      return `${base}
  try {
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie') || Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'cookie');
    if (desc && desc.set && !Document.prototype.__mcp_cookie_hooked) {
      Object.defineProperty(document, 'cookie', { configurable: true, get() { return desc.get.call(document); }, set(v) { push('cookie', {value: String(v)}); return desc.set.call(document, v); } });
      Document.prototype.__mcp_cookie_hooked = true;
    }
  } catch (_) {}
${end}`;
    case 'websocket':
      return `${base}
  if (typeof WebSocket === 'function' && !root.__mcp_ws_hooked) {
    const Orig = WebSocket;
    root.WebSocket = function(url, protocols) {
      const ws = protocols === undefined ? new Orig(url) : new Orig(url, protocols);
      push('websocket:create', {url: String(url)});
      const send = ws.send;
      ws.send = function(data) { push('websocket:send', {url: String(url), data: String(data).slice(0, 2000)}); return send.apply(this, arguments); };
      ws.addEventListener('message', ev => push('websocket:message', {url: String(url), data: String(ev.data).slice(0, 2000)}));
      return ws;
    };
    root.WebSocket.prototype = Orig.prototype;
    root.__mcp_ws_hooked = true;
  }
${end}`;
    case 'debugger_bypass':
      return `${base}
  push('debugger_bypass', {status: 'installed'});
${end}`;
    case 'runtime_probe':
      return `${base}
  push('runtime_probe', {userAgent: navigator.userAgent, platform: navigator.platform, webdriver: navigator.webdriver, screen: {width: screen.width, height: screen.height}});
${end}`;
    default:
      throw new Error(`Unknown preset: ${preset}`);
  }
}

function hookFunctionSource(options: {
  functionPath: string;
  mode: 'intercept' | 'trace';
  hookCode?: string;
  position: 'before' | 'after' | 'replace';
  nonOverridable: boolean;
  logArgs: boolean;
  logReturn: boolean;
  logStack: boolean;
  maxCaptures: number;
}): string {
  return `(() => {
    const path = ${JSON.stringify(options.functionPath)};
    const parts = path.split('.');
    let parent = window;
    for (let i = 0; i < parts.length - 1; i++) parent = parent?.[parts[i]];
    if (!parent) return;
    const key = parts[parts.length - 1];
    const original = parent[key];
    if (typeof original !== 'function' && ${JSON.stringify(options.position)} !== 'replace') return;
    // Use '__args' instead of 'arguments' �?'arguments' is reserved in strict
    // mode and cannot be used as a formal parameter name in Function().
    const runHook = (__code, __args, __this, __result) => Function('__args', '__this', '__result', __code)(__args, __this, __result);
    window.__mcp_hook_log = window.__mcp_hook_log || [];
    window.__mcp_hooks = window.__mcp_hooks || {};
    if (!window.__mcp_hooks[path]) window.__mcp_hooks[path] = original;
    let captures = 0;
    const wrapped = function(...args) {
      const __this = this;
      const record = (payload) => {
        if (captures++ >= ${options.maxCaptures}) return;
        window.__mcp_hook_log.push({type: 'function', path, ts: Date.now(), ...payload});
      };
      ${options.mode === 'trace' ? `let __result, __error; try { __result = original.apply(this, args); } catch(e) { __error = e; } record({args: ${options.logArgs ? 'args' : 'undefined'}, result: ${options.logReturn ? '__result' : 'undefined'}, error: __error ? String(__error) : undefined, stack: ${options.logStack ? 'new Error().stack' : 'undefined'}}); if (__error) throw __error; return __result;` : ''}
      ${options.mode === 'intercept' && options.position === 'before' ? `runHook(${JSON.stringify(options.hookCode ?? '')}, args, __this); return original.apply(this, args);` : ''}
      ${options.mode === 'intercept' && options.position === 'after' ? `const __result = original.apply(this, args); runHook(${JSON.stringify(options.hookCode ?? '')}, args, __this, __result); return __result;` : ''}
      ${options.mode === 'intercept' && options.position === 'replace' ? `return runHook(${JSON.stringify(options.hookCode ?? '')}, args, __this);` : ''}
    };
    try { wrapped.toString = () => original.toString(); } catch (_) {}
    if (${options.nonOverridable}) {
      Object.defineProperty(parent, key, {value: wrapped, configurable: false, writable: false});
    } else {
      parent[key] = wrapped;
    }
  })();`;
}

export const getPageInfo = defineTool({
  name: 'get_page_info',
  description: 'Get current page URL, title, viewport, and page count.',
  annotations: {category: ToolCategory.NAVIGATION, readOnlyHint: true},
  schema: {},
  handler: async (_request, response, context) => {
    const page = context.getSelectedPage();
    appendJson(response, {
      url: page.url(),
      title: await page.title(),
      viewport: page.viewportSize(),
      pages: context.getPages().map((p, index) => ({
        index,
        url: p.url(),
        selected: context.isPageSelected(p),
      })),
    });
  },
});

export const getCdpEndpoint = defineTool({
  name: 'get_cdp_endpoint',
  description: 'Return CDP connection availability for the selected page.',
  annotations: {category: ToolCategory.DEBUGGING, readOnlyHint: true},
  schema: {},
  handler: async (_request, response, context) => {
    const session = await getCdpSession(asInternalContext(context));
    appendJson(response, {status: 'available', session: Boolean(session)});
  },
});

export const navigate = defineTool({
  name: 'navigate',
  description:
    'Navigate to a URL with optional hook pre-injection and redirect tracing.',
  annotations: {category: ToolCategory.NAVIGATION, readOnlyHint: false},
  schema: {
    url: zod.string(),
    wait_until: zod.enum(WAIT_UNTIL).optional().default('load'),
    clear_network_capture: boolParam().optional().default(true),
    pre_inject_hooks: zod.array(zod.string()).optional(),
  },
  handler: async (request, response, context) => {
    if (request.params.clear_network_capture) {
      context.clearNetworkRequests();
    }
    if (request.params.pre_inject_hooks) {
      for (const preset of request.params.pre_inject_hooks) {
        const source = hookPresetSource(preset);
        await addPersistentMainWorldScript(
          asInternalContext(context),
          `preset:${preset}`,
          source,
        );
        await evaluateMainWorld(context.getSelectedPage(), source);
      }
    }
    const page = context.getSelectedPage();
    const result = await page.goto(request.params.url, {
      waitUntil: request.params.wait_until,
    });
    appendJson(response, {
      url: page.url(),
      title: await page.title(),
      status: result?.status() ?? null,
    });
  },
});

export const reload = defineTool({
  name: 'reload',
  description: 'Reload current page.',
  annotations: {category: ToolCategory.NAVIGATION, readOnlyHint: false},
  schema: {wait_until: zod.enum(WAIT_UNTIL).optional().default('load')},
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    const result = await page.reload({waitUntil: request.params.wait_until});
    appendJson(response, {
      url: page.url(),
      title: await page.title(),
      status: result?.status() ?? null,
    });
  },
});

export const click = defineTool({
  name: 'click',
  description:
    'Click a page element by selector. Uses human-like cursor movement when --humanize is enabled.',
  annotations: {category: ToolCategory.NAVIGATION, readOnlyHint: false},
  schema: {selector: zod.string()},
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    if (_humanizeEnabled) {
      const state = getCursorState(asInternalContext(context));
      await humanClickSelector(
        page,
        state,
        request.params.selector,
        _humanConfig,
      );
    } else {
      await page.click(request.params.selector);
    }
    appendJson(response, {
      status: 'clicked',
      selector: request.params.selector,
      humanize: _humanizeEnabled,
    });
  },
});

export const typeText = defineTool({
  name: 'type_text',
  description:
    'Type text into an input field. Uses variable delays and pauses when --humanize is enabled.',
  annotations: {category: ToolCategory.NAVIGATION, readOnlyHint: false},
  schema: {
    selector: zod.string(),
    text: zod.string(),
    delay: zod.number().int().optional().default(50),
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    if (_humanizeEnabled) {
      // Click the input first with human movement, then type with human delays
      const state = getCursorState(asInternalContext(context));
      await humanClickSelector(
        page,
        state,
        request.params.selector,
        _humanConfig,
      );
      await humanTypeText(page, request.params.text, _humanConfig);
    } else {
      await page.type(request.params.selector, request.params.text, {
        delay: request.params.delay,
      });
    }
    appendJson(response, {
      status: 'typed',
      selector: request.params.selector,
      length: request.params.text.length,
      humanize: _humanizeEnabled,
    });
  },
});

export const humanScroll = defineTool({
  name: 'human_scroll',
  description:
    'Scroll the selected page. Uses burst-chunk scrolling with settle delay when --humanize is enabled.',
  annotations: {category: ToolCategory.NAVIGATION, readOnlyHint: false},
  schema: {delta_y: zod.number().int().optional().default(600)},
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    if (_humanizeEnabled) {
      await humanScrollAction(page, request.params.delta_y, _humanConfig);
    } else {
      await page.mouse.wheel(0, request.params.delta_y);
    }
    appendJson(response, {
      status: 'scrolled',
      delta_y: request.params.delta_y,
      humanize: _humanizeEnabled,
    });
  },
});

export const waitFor = defineTool({
  name: 'wait_for',
  description: 'Wait for an element or URL substring.',
  annotations: {category: ToolCategory.NAVIGATION, readOnlyHint: true},
  schema: {
    selector: zod.string().optional(),
    url_pattern: zod.string().optional(),
    timeout: zod.number().int().optional().default(30000),
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    if (request.params.selector) {
      await page.waitForSelector(request.params.selector, {
        timeout: request.params.timeout,
      });
      appendJson(response, {
        status: 'found',
        selector: request.params.selector,
      });
      return;
    }
    if (request.params.url_pattern) {
      await page.waitForURL(`**${request.params.url_pattern}**`, {
        timeout: request.params.timeout,
      });
      appendJson(response, {status: 'matched', url: page.url()});
      return;
    }
    appendJson(response, {
      type: 'error',
      error: 'selector or url_pattern is required',
    });
  },
});

export const getConsoleLogs = defineTool({
  name: 'get_console_logs',
  description: 'Get collected console logs.',
  annotations: {category: ToolCategory.DEBUGGING, readOnlyHint: true},
  schema: {
    level: zod.string().optional(),
    keyword: zod.string().optional(),
    clear: boolParam().optional().default(false),
  },
  handler: async (request, response, context) => {
    const internal = asInternalContext(context);
    const allItems = internal.getConsoleData(true);
    // Implement watermark-based clear: messages before the watermark are hidden.
    const watermark = consoleWatermark.get(internal) ?? 0;
    const visibleItems = allItems.slice(watermark);
    let logs: Array<{
      level: string;
      text: string;
      timestamp?: number;
      location?: unknown;
    }> = visibleItems.map(item => {
      if ('type' in item) {
        return {
          level: item.type(),
          text: item.text(),
          location: item.location(),
        };
      }
      return {
        level: 'error',
        text: item instanceof Error ? item.message : String(item),
      };
    });
    if (request.params.level)
      logs = logs.filter(log => log.level === request.params.level);
    if (request.params.keyword)
      logs = logs.filter(log => log.text.includes(request.params.keyword!));
    const bridgeLogs = await readConsoleBridgeLogs(context.getSelectedPage(), {
      clear: request.params.clear,
    });
    // The console bridge is the primary source: it captures both isolated-world
    // and main-world console output with timestamps and stacks. The native
    // ConsoleCollector (read above into `logs`) captures a subset and, when both
    // are active, produces DUPLICATE entries for the same message. So when the
    // bridge has data, use it exclusively; otherwise fall back to the native
    // collector output already in `logs`.
    if (bridgeLogs.length > 0) {
      logs = bridgeLogs
        .map(log => ({
          level: log.level,
          text: log.text,
          timestamp: log.timestamp,
          location: log.location,
        }))
        .filter(entry => {
          if (request.params.level && entry.level !== request.params.level)
            return false;
          if (
            request.params.keyword &&
            !entry.text.includes(request.params.keyword)
          )
            return false;
          return true;
        });
    }
    if (request.params.clear) consoleWatermark.set(internal, allItems.length);
    appendJson(response, {
      logs,
      total: logs.length,
      cleared: request.params.clear,
    });
  },
});

export const cookies = defineTool({
  name: 'cookies',
  description: 'Cookie management: get, set, delete.',
  annotations: {category: ToolCategory.BROWSER_STATE, readOnlyHint: false},
  schema: {
    action: zod.enum(COOKIE_ACTIONS),
    domain: zod.string().optional(),
    cookies_list: zod.array(zod.record(zod.unknown())).optional(),
    name: zod.string().optional(),
  },
  handler: async (request, response, context) => {
    const browserContext = context.getSelectedPage().context();
    if (request.params.action === 'get') {
      let all = await browserContext.cookies();
      if (request.params.domain)
        all = all.filter(cookie =>
          cookie.domain.includes(request.params.domain!),
        );
      if (request.params.name)
        all = all.filter(cookie => cookie.name === request.params.name);
      appendJson(response, all);
      return;
    }
    if (request.params.action === 'set') {
      const list = request.params.cookies_list ?? [];
      await browserContext.addCookies(list as never);
      appendJson(response, {status: 'set', count: list.length});
      return;
    }
    const all = await browserContext.cookies();
    const targets = all.filter(cookie => {
      if (
        request.params.domain &&
        !cookie.domain.includes(request.params.domain)
      )
        return false;
      if (request.params.name && cookie.name !== request.params.name)
        return false;
      return true;
    });
    for (const cookie of targets) {
      await browserContext.clearCookies({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
      });
    }
    appendJson(response, {status: 'deleted', count: targets.length});
  },
});

export const getStorage = defineTool({
  name: 'get_storage',
  description: 'Get localStorage or sessionStorage for the selected page.',
  annotations: {category: ToolCategory.BROWSER_STATE, readOnlyHint: true},
  schema: {storage_type: zod.enum(STORAGE_TYPES).optional().default('local')},
  handler: async (request, response, context) => {
    const storageName =
      request.params.storage_type === 'session'
        ? 'sessionStorage'
        : 'localStorage';
    const value = await context.getSelectedPage().evaluate(name => {
      const storage = name === 'sessionStorage' ? sessionStorage : localStorage;
      return Object.fromEntries(
        Array.from({length: storage.length}, (_, index) => {
          const key = storage.key(index) ?? '';
          return [key, storage.getItem(key)];
        }),
      );
    }, storageName);
    appendJson(response, value);
  },
});

export const exportState = defineTool({
  name: 'export_state',
  description: 'Export browser cookies and storage state to JSON.',
  annotations: {category: ToolCategory.BROWSER_STATE, readOnlyHint: false},
  schema: {save_path: zod.string()},
  handler: async (request, response, context) => {
    const savePath = path.resolve(request.params.save_path);
    await context.getSelectedPage().context().storageState({path: savePath});
    appendJson(response, {status: 'saved', path: savePath});
  },
});

export const importState = defineTool({
  name: 'import_state',
  description:
    'Import cookies and register localStorage seed script from a Playwright storage_state file.',
  annotations: {category: ToolCategory.BROWSER_STATE, readOnlyHint: false},
  schema: {state_path: zod.string()},
  handler: async (request, response, context) => {
    const statePath = path.resolve(request.params.state_path);
    const state = JSON.parse(await fs.readFile(statePath, 'utf8')) as {
      cookies?: unknown[];
      origins?: Array<{
        origin: string;
        localStorage?: Array<{name: string; value: string}>;
      }>;
    };
    if (state.cookies?.length) {
      await context
        .getSelectedPage()
        .context()
        .addCookies(state.cookies as never);
    }
    if (state.origins?.length) {
      const script = `(() => { const states = ${JSON.stringify(state.origins)}; const item = states.find(x => x.origin === location.origin); if (item) for (const kv of item.localStorage || []) localStorage.setItem(kv.name, kv.value); })();`;
      await context.getSelectedPage().context().addInitScript(script);
      await context
        .getSelectedPage()
        .evaluate(scriptSource => Function(scriptSource)(), script)
        .catch(() => undefined);
    }
    appendJson(response, {
      status: 'imported',
      cookies: state.cookies?.length ?? 0,
      origins: state.origins?.length ?? 0,
    });
  },
});

export const resetBrowserState = defineTool({
  name: 'reset_browser_state',
  description: 'Reset MCP-side residual state and optionally cookies/storage.',
  annotations: {category: ToolCategory.BROWSER_STATE, readOnlyHint: false},
  schema: {
    clear_network_capture: boolParam().optional().default(true),
    clear_cookies: boolParam().optional().default(false),
    clear_storage: boolParam().optional().default(false),
    clear_persistent_hooks: boolParam().optional().default(true),
    clear_active_routes: boolParam().optional().default(true),
  },
  handler: async (request, response, context) => {
    const internal = asInternalContext(context);
    const cleared: Record<string, unknown> = {};
    if (request.params.clear_network_capture)
      cleared.network = context.clearNetworkRequests();
    if (request.params.clear_cookies)
      await context.getSelectedPage().context().clearCookies();
    if (request.params.clear_storage)
      await context.getSelectedPage().evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      });
    if (request.params.clear_persistent_hooks) {
      cleared.persistent_hooks = {
        registered: persistentHookIds.get(internal)?.size ?? 0,
        cleared: false,
        note: 'Persistent init scripts require a new browser context or MCP restart to clear.',
      };
    }
    if (request.params.clear_active_routes) {
      const routes = routeMap(internal);
      for (const pattern of routes.keys())
        await context
          .getSelectedPage()
          .unroute(pattern)
          .catch(() => undefined);
      cleared.routes = routes.size;
      routes.clear();
    }
    appendJson(response, {status: 'reset', cleared});
  },
});

export const networkCapture = defineTool({
  name: 'network_capture',
  description:
    'Start/stop/clear/status network capture. js-reverse-mcp captures continuously; start/stop are compatibility toggles.',
  annotations: {category: ToolCategory.NETWORK, readOnlyHint: false},
  schema: {
    action: zod.enum(['start', 'stop', 'clear', 'status']),
    url_pattern: zod.string().optional().default('**/*'),
    capture_body: boolParam().optional().default(false),
  },
  handler: async (request, response, context) => {
    if (request.params.action === 'clear') {
      appendJson(response, {
        action: 'clear',
        ...context.clearNetworkRequests(),
      });
      return;
    }
    appendJson(response, {
      action: request.params.action,
      capturing: request.params.action !== 'stop',
      note: 'Network collection is always active after collectors initialize; use list_network_requests filters for url/method/resource filtering.',
    });
  },
});

export const getNetworkRequest = defineTool({
  name: 'get_network_request',
  description: 'Get full details of a captured network request.',
  annotations: {category: ToolCategory.NETWORK, readOnlyHint: true},
  schema: {
    request_id: zod.number().int(),
    include_body: boolParam().optional().default(false),
    include_headers: boolParam().optional().default(true),
    max_body_size: zod.number().int().optional().default(5000),
  },
  handler: async (request, response, context) => {
    const req = context.getNetworkRequestById(request.params.request_id);
    const exported = await exportNetworkRequestPart(req, 'all');
    const snapshot = JSON.parse(
      Buffer.from(exported.data).toString('utf8'),
    ) as Record<string, unknown>;
    if (!request.params.include_body) {
      delete snapshot.requestBody;
      delete snapshot.responseBody;
    } else if (request.params.max_body_size >= 0) {
      for (const key of ['requestBody', 'responseBody']) {
        const body = snapshot[key] as
          | {text?: string; base64?: string}
          | undefined;
        if (body?.text && body.text.length > request.params.max_body_size)
          body.text = `${body.text.slice(0, request.params.max_body_size)}...`;
        if (body?.base64 && body.base64.length > request.params.max_body_size)
          body.base64 = `${body.base64.slice(0, request.params.max_body_size)}...`;
      }
    }
    if (!request.params.include_headers) {
      delete snapshot.requestHeaders;
      delete snapshot.requestHeadersArray;
      delete snapshot.responseHeaders;
      delete snapshot.responseHeadersArray;
    }
    appendJson(response, snapshot);
  },
});

export const interceptRequest = defineTool({
  name: 'intercept_request',
  description: 'Intercept network requests matching a glob pattern.',
  annotations: {category: ToolCategory.NETWORK, readOnlyHint: false},
  schema: {
    url_pattern: zod.string(),
    action: zod.enum(REQUEST_ACTIONS).optional().default('log'),
    modify_headers: zod.record(zod.unknown()).optional(),
    modify_body: zod.string().optional(),
    mock_response: zod.record(zod.unknown()).optional(),
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    const internal = asInternalContext(context);
    const routes = routeMap(internal);
    if (request.params.action === 'stop') {
      await page.unroute(request.params.url_pattern).catch(() => undefined);
      routes.delete(request.params.url_pattern);
      appendJson(response, {
        status: 'stopped',
        pattern: request.params.url_pattern,
      });
      return;
    }
    const handler = async (route: {
      request(): {url(): string; headers(): Record<string, string>};
      abort(): Promise<void>;
      continue(options?: unknown): Promise<void>;
      fulfill(options: unknown): Promise<void>;
    }) => {
      if (request.params.action === 'block') return route.abort();
      if (request.params.action === 'mock')
        return route.fulfill(
          request.params.mock_response ?? {status: 200, body: ''},
        );
      if (request.params.action === 'modify')
        return route.continue({
          headers: {
            ...route.request().headers(),
            ...(request.params.modify_headers ?? {}),
          },
          postData: request.params.modify_body,
        });
      return route.continue();
    };
    await page.route(request.params.url_pattern, handler as never);
    routes.set(request.params.url_pattern, handler);
    appendJson(response, {
      status: 'installed',
      pattern: request.params.url_pattern,
      action: request.params.action,
    });
  },
});

export const evaluateJs = defineTool({
  name: 'evaluate_js',
  description: 'Execute a JavaScript expression in the selected page.',
  annotations: {category: ToolCategory.DEBUGGING, readOnlyHint: false},
  schema: {
    expression: zod.string(),
    await_promise: boolParam().optional().default(true),
  },
  handler: async (request, response, context) => {
    try {
      await ensureConsoleBridge(context.getSelectedFrame());
      const value = await context.getSelectedFrame().evaluate(
        async ({expression, awaitPromise}) => {
          const AsyncFunction = Object.getPrototypeOf(async function marker() {
            return undefined;
          }).constructor;
          const Fn = awaitPromise ? AsyncFunction : Function;
          const result = new Fn(`return (${expression});`)();
          const finalResult = awaitPromise ? await result : result;
          if (finalResult === undefined)
            return {type: 'primitive', value: null, is_undefined: true};
          try {
            return {
              type: 'json',
              value: JSON.parse(JSON.stringify(finalResult)),
            };
          } catch {
            return {type: typeof finalResult, value: String(finalResult)};
          }
        },
        {
          expression: request.params.expression,
          awaitPromise: request.params.await_promise,
        },
      );
      appendJson(response, value);
    } catch (error) {
      appendJson(response, errorObject(error));
    }
  },
});

export const scripts = defineTool({
  name: 'scripts',
  description: 'List/get/save loaded scripts.',
  annotations: {
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {
    action: zod.enum(SCRIPT_ACTIONS),
    url: zod.string().optional(),
    save_path: zod.string().optional(),
  },
  handler: async (request, response, context) => {
    const debugger_ = context.debuggerContext;
    if (request.params.action === 'list') {
      appendJson(
        response,
        debugger_.getScripts().map(script => ({
          script_id: script.scriptId,
          url: script.url,
          source_map_url: script.sourceMapURL,
        })),
      );
      return;
    }
    const source = await getScriptSourceByUrlOrId(
      asInternalContext(context),
      request.params.url,
      undefined,
    );
    if (request.params.action === 'get') {
      appendJson(response, {
        url: source.url,
        script_id: source.scriptId,
        source: source.source,
      });
      return;
    }
    if (!request.params.save_path)
      throw new Error('save_path is required for action=save');
    const data = source.bytecode
      ? Buffer.from(source.bytecode, 'base64')
      : new TextEncoder().encode(source.source);
    const file = await context.saveFile(data, request.params.save_path);
    appendJson(response, {
      status: 'saved',
      path: file.filename,
      size: data.length,
    });
  },
});

export const searchCode = defineTool({
  name: 'search_code',
  description: 'Search keyword in loaded scripts.',
  annotations: {category: ToolCategory.REVERSE_ENGINEERING, readOnlyHint: true},
  schema: {
    keyword: zod.string(),
    script_url: zod.string().optional(),
    context_chars: zod.number().int().optional().default(200),
    context_lines: zod.number().int().optional().default(3),
    max_results: zod.number().int().optional().default(200),
  },
  handler: async (request, response, context) => {
    const matches = await context.debuggerContext.searchInScripts(
      request.params.keyword,
      {caseSensitive: true, isRegex: false},
    );
    let items = matches.matches;
    if (request.params.script_url)
      items = items.filter(item =>
        item.url.includes(request.params.script_url!),
      );
    appendJson(response, {
      total_matches: items.length,
      matches: items.slice(0, request.params.max_results),
    });
  },
});

export const hookFunction = defineTool({
  name: 'hook_function',
  description:
    'Hook or trace a function path such as JSON.stringify. ' +
    'mode=trace: logs calls automatically (args/return/stack). ' +
    'mode=intercept: runs hook_code at the specified position. ' +
    'In hook_code, available variables are: ' +
    '__args (array of call arguments), __this (the receiver), ' +
    '__result (return value, only in position=after). ' +
    'Example: hook_code="console.log(__args[0])" position="before".',
  annotations: {
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {
    function_path: zod.string(),
    mode: zod.enum(HOOK_MODES).optional().default('intercept'),
    hook_code: zod.string().optional().default(''),
    position: zod.enum(HOOK_POSITIONS).optional().default('before'),
    persistent: boolParam().optional().default(false),
    log_args: boolParam().optional().default(true),
    log_return: boolParam().optional().default(true),
    log_stack: boolParam().optional().default(false),
    max_captures: zod.number().int().optional().default(50),
    non_overridable: boolParam().optional().default(false),
  },
  handler: async (request, response, context) => {
    const source = hookFunctionSource({
      functionPath: request.params.function_path,
      mode: request.params.mode,
      hookCode: request.params.hook_code,
      position: request.params.position,
      logArgs: request.params.log_args,
      logReturn: request.params.log_return,
      logStack: request.params.log_stack,
      maxCaptures: request.params.max_captures,
      nonOverridable: request.params.non_overridable,
    });
    if (request.params.persistent)
      await addPersistentMainWorldScript(
        asInternalContext(context),
        `hook:${request.params.function_path}`,
        source,
      );
    await evaluateMainWorld(context.getSelectedPage(), source);
    appendJson(response, {
      status: request.params.mode === 'trace' ? 'tracing' : 'hooked',
      target: request.params.function_path,
      persistent: request.params.persistent,
    });
  },
});

export const injectHookPreset = defineTool({
  name: 'inject_hook_preset',
  description:
    'Inject preset hook: xhr/fetch/crypto/websocket/debugger_bypass/cookie/runtime_probe.',
  annotations: {
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {
    preset: zod.string(),
    persistent: boolParam().optional().default(true),
  },
  handler: async (request, response, context) => {
    const source = hookPresetSource(request.params.preset);
    if (request.params.persistent)
      await addPersistentMainWorldScript(
        asInternalContext(context),
        `preset:${request.params.preset}`,
        source,
      );
    await evaluateMainWorld(context.getSelectedPage(), source);
    appendJson(response, {
      status: 'injected',
      preset: request.params.preset,
      persistent: request.params.persistent,
    });
  },
});

export const removeHooks = defineTool({
  name: 'remove_hooks',
  description:
    'Restore in-page function hooks when originals are tracked. Persistent init scripts cannot be removed from an existing Playwright context.',
  annotations: {
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {keep_persistent: boolParam().optional().default(false)},
  handler: async (request, response, context) => {
    await evaluateMainWorld(
      context.getSelectedPage(),
      `(() => { if (!window.__mcp_hooks) return; for (const path of Object.keys(window.__mcp_hooks)) { const parts = path.split('.'); let parent = window; for (let i=0;i<parts.length-1;i++) parent = parent?.[parts[i]]; if (parent) parent[parts[parts.length-1]] = window.__mcp_hooks[path]; } window.__mcp_hooks = {}; })();`,
    );
    const internal = asInternalContext(context);
    const count = persistentHookIds.get(internal)?.size ?? 0;
    if (!request.params.keep_persistent && count > 0) {
      appendUnsupportedPersistentClear(response, count);
      return;
    }
    appendJson(response, {
      status: 'restored_current_page',
      persistent_hooks_registered: count,
    });
  },
});

export const compareEnv = defineTool({
  name: 'compare_env',
  description:
    'Collect browser fingerprint environment values. Returns navigator, screen, webgl, timing and custom expression results.',
  annotations: {category: ToolCategory.DEBUGGING, readOnlyHint: true},
  schema: {properties: zod.array(zod.string()).nullable().optional()},
  handler: async (request, response, context) => {
    const value = await context.getSelectedPage().evaluate(customProps => {
      type Section = Record<string, unknown>;
      const result: {
        navigator: Section;
        screen: Section;
        webgl: Section;
        timing: Section;
        misc: Section;
        custom: Section;
      } = {
        navigator: {},
        screen: {},
        webgl: {},
        timing: {},
        misc: {},
        custom: {},
      };

      const nav = navigator as unknown as Record<string, unknown>;
      for (const p of [
        'userAgent',
        'platform',
        'language',
        'languages',
        'hardwareConcurrency',
        'deviceMemory',
        'maxTouchPoints',
        'vendor',
        'cookieEnabled',
        'webdriver',
      ]) {
        try {
          result.navigator[p] = {value: nav[p], type: typeof nav[p]};
        } catch (e: unknown) {
          result.navigator[p] = {error: (e as Error).message};
        }
      }

      const scr = screen as unknown as Record<string, unknown>;
      for (const p of [
        'width',
        'height',
        'availWidth',
        'availHeight',
        'colorDepth',
        'pixelDepth',
      ]) {
        try {
          result.screen[p] = {value: scr[p], type: typeof scr[p]};
        } catch (e: unknown) {
          result.screen[p] = {error: (e as Error).message};
        }
      }
      result.screen['devicePixelRatio'] = {
        value: devicePixelRatio,
        type: 'number',
      };

      result.timing['timezone'] = {
        value: Intl.DateTimeFormat().resolvedOptions().timeZone,
        type: 'string',
      };
      result.timing['timezoneOffset'] = {
        value: new Date().getTimezoneOffset(),
        type: 'number',
      };

      try {
        const c = document.createElement('canvas');
        const gl = (c.getContext('webgl') ||
          c.getContext('experimental-webgl')) as WebGLRenderingContext | null;
        const ext =
          gl &&
          (gl.getExtension('WEBGL_debug_renderer_info') as {
            UNMASKED_VENDOR_WEBGL: number;
            UNMASKED_RENDERER_WEBGL: number;
          } | null);
        if (gl && ext) {
          result.webgl['vendor'] = {
            value: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL),
          };
          result.webgl['renderer'] = {
            value: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),
          };
        }
      } catch (e: unknown) {
        result.webgl['error'] = (e as Error).message;
      }

      for (const expr of customProps || []) {
        try {
          const v = Function('return (' + expr + ')')();
          result.custom[expr] = {
            value:
              typeof v === 'object'
                ? JSON.stringify(v).slice(0, 500)
                : String(v),
            type: typeof v,
          };
        } catch (e: unknown) {
          result.custom[expr] = {error: (e as Error).message};
        }
      }

      return result;
    }, request.params.properties ?? []);
    appendJson(response, value);
  },
});

export const checkEnvironment = defineTool({
  name: 'check_environment',
  description: 'Check MCP browser state and core runtime availability.',
  annotations: {category: ToolCategory.DEBUGGING, readOnlyHint: true},
  schema: {},
  handler: async (_request, response, context) => {
    appendJson(response, {
      overall_ok: true,
      browser_pages: context.getPages().length,
      selected_url: context.getSelectedPage().url(),
      debugger_enabled: context.debuggerContext.isEnabled(),
    });
  },
});

export const cdpStatus = defineTool({
  name: 'cdp_status',
  description: 'Show CDP debugger status.',
  annotations: {category: ToolCategory.DEBUGGING, readOnlyHint: true},
  schema: {},
  handler: async (_request, response, context) => {
    appendJson(response, {
      debugger_enabled: context.debuggerContext.isEnabled(),
      paused: context.debuggerContext.isPaused(),
      scripts: context.debuggerContext.getScripts().length,
    });
  },
});

export const cdpEnableDebugger = defineTool({
  name: 'cdp_enable_debugger',
  description: 'Enable Chromium Runtime/Debugger domains for active page.',
  annotations: {category: ToolCategory.DEBUGGING, readOnlyHint: false},
  schema: {skip_all_pauses: boolParam().optional().default(false)},
  handler: async (request, response, context) => {
    const session = await getCdpSession(asInternalContext(context));
    await context.debuggerContext.enable(session);
    if (request.params.skip_all_pauses)
      await session.send('Debugger.setSkipAllPauses', {skip: true});
    appendJson(response, {
      status: 'enabled',
      skip_all_pauses: request.params.skip_all_pauses,
    });
  },
});

export const setCdpSkipAllPauses = defineTool({
  name: 'set_cdp_skip_all_pauses',
  description:
    'Tell Chromium Debugger to ignore debugger statements and breakpoints.',
  annotations: {category: ToolCategory.DEBUGGING, readOnlyHint: false},
  schema: {
    skip: boolParam().optional().default(true),
    resume_if_paused: boolParam().optional().default(true),
  },
  handler: async (request, response, context) => {
    const session = await getCdpSession(asInternalContext(context));
    await session.send('Debugger.setSkipAllPauses', {
      skip: request.params.skip,
    });
    if (request.params.resume_if_paused && context.debuggerContext.isPaused())
      await context.debuggerContext.resume().catch(() => undefined);
    appendJson(response, {status: 'ok', skip: request.params.skip});
  },
});

export const setEventListenerBreakpoint = defineTool({
  name: 'set_event_listener_breakpoint',
  description: 'Pause on a DOM event listener through CDP DOMDebugger.',
  annotations: {
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {
    event_name: zod.string(),
    target_name: zod.string().optional().default('*'),
  },
  handler: async (request, response, context) => {
    const session = await getCdpSession(asInternalContext(context));
    await session.send('DOMDebugger.setEventListenerBreakpoint', {
      eventName: request.params.event_name,
    });
    let set = eventListenerBreakpoints.get(asInternalContext(context));
    if (!set)
      eventListenerBreakpoints.set(
        asInternalContext(context),
        (set = new Set<string>()),
      );
    set.add(request.params.event_name);
    appendJson(response, {
      status: 'set',
      event_name: request.params.event_name,
      target_name: request.params.target_name,
    });
  },
});

export const removeEventListenerBreakpoint = defineTool({
  name: 'remove_event_listener_breakpoint',
  description: 'Remove a DOM event listener breakpoint.',
  annotations: {
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {
    event_name: zod.string(),
    target_name: zod.string().optional().default('*'),
  },
  handler: async (request, response, context) => {
    const session = await getCdpSession(asInternalContext(context));
    await session.send('DOMDebugger.removeEventListenerBreakpoint', {
      eventName: request.params.event_name,
    });
    eventListenerBreakpoints
      .get(asInternalContext(context))
      ?.delete(request.params.event_name);
    appendJson(response, {
      status: 'removed',
      event_name: request.params.event_name,
    });
  },
});

export const removeXhrBreakpoint = defineTool({
  name: 'remove_xhr_breakpoint',
  description: 'Remove an XHR/fetch URL breakpoint.',
  annotations: {
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {url: zod.string()},
  handler: async (request, response, context) => {
    await context.debuggerContext.removeXHRBreakpoint(request.params.url);
    appendJson(response, {status: 'removed', url: request.params.url});
  },
});

export const listCdpScripts = defineTool({
  name: 'list_cdp_scripts',
  description: 'List scripts known to the CDP Debugger domain.',
  annotations: {category: ToolCategory.REVERSE_ENGINEERING, readOnlyHint: true},
  schema: {url_filter: zod.string().optional()},
  handler: async (request, response, context) => {
    let scripts = context.debuggerContext.getScripts();
    if (request.params.url_filter)
      scripts = scripts.filter(script =>
        script.url.includes(request.params.url_filter!),
      );
    appendJson(response, scripts);
  },
});

export const getCdpScriptSource = defineTool({
  name: 'get_cdp_script_source',
  description: 'Get full source for a CDP scriptId.',
  annotations: {category: ToolCategory.REVERSE_ENGINEERING, readOnlyHint: true},
  schema: {script_id: zod.string()},
  handler: async (request, response, context) => {
    const result = await context.debuggerContext.getScriptSource(
      request.params.script_id,
    );
    appendJson(response, result);
  },
});

export const getCdpSource = defineTool({
  name: 'get_cdp_source',
  description: 'Get CDP script source by scriptId or URL, optionally sliced.',
  annotations: {category: ToolCategory.REVERSE_ENGINEERING, readOnlyHint: true},
  schema: {
    script_id: zod.string().nullable().optional(),
    url: zod.string().nullable().optional(),
    start_line: zod.number().int().nullable().optional(),
    end_line: zod.number().int().nullable().optional(),
    offset: zod.number().int().nullable().optional(),
    length: zod.number().int().optional().default(1000),
  },
  handler: async (request, response, context) => {
    const source = await getScriptSourceByUrlOrId(
      asInternalContext(context),
      request.params.url ?? undefined,
      request.params.script_id ?? undefined,
    );
    appendJson(response, {
      script_id: source.scriptId,
      url: source.url,
      source: sourceSlice(
        source.source,
        request.params.start_line ?? undefined,
        request.params.end_line ?? undefined,
        request.params.offset ?? undefined,
        request.params.length,
      ),
    });
  },
});

export const saveCdpScriptSource = defineTool({
  name: 'save_cdp_script_source',
  description: 'Save a full CDP script source to disk.',
  annotations: {
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {
    script_id: zod.string().nullable().optional(),
    url: zod.string().nullable().optional(),
    save_path: zod.string(),
  },
  handler: async (request, response, context) => {
    const source = await getScriptSourceByUrlOrId(
      asInternalContext(context),
      request.params.url ?? undefined,
      request.params.script_id ?? undefined,
    );
    const data = source.bytecode
      ? Buffer.from(source.bytecode, 'base64')
      : new TextEncoder().encode(source.source);
    const file = await context.saveFile(data, request.params.save_path);
    appendJson(response, {
      status: 'saved',
      path: file.filename,
      size: data.length,
    });
  },
});

export const searchCdpSources = defineTool({
  name: 'search_cdp_sources',
  description: 'Search loaded CDP script sources by string or regex.',
  annotations: {category: ToolCategory.REVERSE_ENGINEERING, readOnlyHint: true},
  schema: {
    query: zod.string(),
    url_filter: zod.string().optional().default(''),
    is_regex: boolParam().optional().default(false),
    case_sensitive: boolParam().optional().default(false),
    exclude_minified: boolParam().optional().default(false),
    max_results: zod.number().int().optional().default(50),
    context_chars: zod.number().int().optional().default(160),
  },
  handler: async (request, response, context) => {
    const result = await context.debuggerContext.searchInScripts(
      request.params.query,
      {
        caseSensitive: request.params.case_sensitive,
        isRegex: request.params.is_regex,
      },
    );
    let matches = result.matches;
    if (request.params.url_filter)
      matches = matches.filter(match =>
        match.url.includes(request.params.url_filter),
      );
    if (request.params.exclude_minified)
      matches = matches.filter(match => match.lineContent.length < 10000);
    appendJson(response, {
      total: matches.length,
      matches: matches.slice(0, request.params.max_results),
    });
  },
});

export const setCdpBreakpoint = defineTool({
  name: 'set_cdp_breakpoint',
  description:
    'Set a breakpoint by script URL/scriptId and zero-based line/column.',
  annotations: {
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {
    script_id: zod.string().nullable().optional(),
    url: zod.string().nullable().optional(),
    line_number: zod.number().int().optional().default(0),
    column_number: zod.number().int().optional().default(0),
    condition: zod.string().optional().default(''),
  },
  handler: async (request, response, context) => {
    const script = request.params.url
      ? undefined
      : context.debuggerContext.getScriptById(request.params.script_id ?? '');
    const url = request.params.url ?? script?.url;
    if (!url) throw new Error('url is required when script_id has no URL');
    const bp = await context.debuggerContext.setBreakpoint(
      url,
      request.params.line_number,
      request.params.column_number,
      request.params.condition || undefined,
    );
    let map = cdpBreakpoints.get(asInternalContext(context));
    if (!map)
      cdpBreakpoints.set(
        asInternalContext(context),
        (map = new Map<string, unknown>()),
      );
    map.set(bp.breakpointId, bp);
    appendJson(response, bp);
  },
});

export const listCdpBreakpoints = defineTool({
  name: 'list_cdp_breakpoints',
  description: 'List CDP breakpoints set through this MCP instance.',
  annotations: {category: ToolCategory.REVERSE_ENGINEERING, readOnlyHint: true},
  schema: {},
  handler: async (_request, response, context) =>
    appendJson(response, context.debuggerContext.getBreakpoints()),
});

export const removeCdpBreakpoint = defineTool({
  name: 'remove_cdp_breakpoint',
  description: 'Remove one or all CDP breakpoints.',
  annotations: {
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {
    breakpoint_id: zod.string().nullable().optional(),
    all_breakpoints: boolParam().optional().default(false),
  },
  handler: async (request, response, context) => {
    if (request.params.all_breakpoints) {
      await context.debuggerContext.removeAllBreakpoints();
      appendJson(response, {status: 'removed_all'});
      return;
    }
    if (!request.params.breakpoint_id)
      throw new Error('breakpoint_id or all_breakpoints is required');
    await context.debuggerContext.removeBreakpoint(
      request.params.breakpoint_id,
    );
    appendJson(response, {
      status: 'removed',
      breakpoint_id: request.params.breakpoint_id,
    });
  },
});

export const resumeDebugger = defineTool({
  name: 'resume_debugger',
  description: 'Resume JavaScript execution if paused.',
  annotations: {
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {},
  handler: async (_request, response, context) => {
    if (context.debuggerContext.isPaused())
      await context.debuggerContext.resume();
    appendJson(response, {status: 'resumed'});
  },
});

export const stepDebugger = defineTool({
  name: 'step_debugger',
  description: 'Step JavaScript execution: over, into, or out.',
  annotations: {
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {direction: zod.string().optional().default('over')},
  handler: async (request, response, context) => {
    const frame =
      request.params.direction === 'into'
        ? await context.debuggerContext.stepInto()
        : request.params.direction === 'out'
          ? await context.debuggerContext.stepOut()
          : await context.debuggerContext.stepOver();
    appendJson(response, frame);
  },
});

export const evaluateOnPaused = defineTool({
  name: 'evaluate_on_paused',
  description: 'Evaluate a JS expression in a paused call frame.',
  annotations: {
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {
    expression: zod.string(),
    frame_index: zod.number().int().optional().default(0),
  },
  handler: async (request, response, context) => {
    const frame =
      context.debuggerContext.getPausedState().callFrames[
        request.params.frame_index
      ];
    if (!frame)
      throw new Error('frame_index out of range or execution is not paused');
    appendJson(
      response,
      await context.debuggerContext.evaluateOnCallFrame(
        frame.callFrameId,
        request.params.expression,
        {returnByValue: true},
      ),
    );
  },
});

export const startCpuProfile = defineTool({
  name: 'start_cpu_profile',
  description: 'Start Chromium CDP CPU profiling.',
  annotations: {category: ToolCategory.DEBUGGING, readOnlyHint: false},
  schema: {},
  handler: async (_request, response, context) => {
    const session = await getCdpSession(asInternalContext(context));
    await session.send('Profiler.enable');
    await session.send('Profiler.start');
    cpuProfileSessions.set(asInternalContext(context), session);
    appendJson(response, {status: 'started'});
  },
});

export const stopCpuProfile = defineTool({
  name: 'stop_cpu_profile',
  description: 'Stop CDP CPU profiling and summarize hot functions.',
  annotations: {category: ToolCategory.DEBUGGING, readOnlyHint: false},
  schema: {
    limit: zod.number().int().optional().default(30),
    include_profile: boolParam().optional().default(false),
  },
  handler: async (request, response, context) => {
    const session =
      cpuProfileSessions.get(asInternalContext(context)) ??
      (await getCdpSession(asInternalContext(context)));
    const result = await session.send('Profiler.stop');
    cpuProfileSessions.delete(asInternalContext(context));
    const profile = result.profile as {
      nodes?: Array<{
        id: number;
        callFrame: {functionName: string; url: string; lineNumber: number};
        hitCount?: number;
      }>;
    };
    const hot = (profile.nodes ?? [])
      .map(node => ({
        functionName: node.callFrame.functionName || '<anonymous>',
        url: node.callFrame.url,
        lineNumber: node.callFrame.lineNumber + 1,
        hitCount: node.hitCount ?? 0,
      }))
      .sort((a, b) => b.hitCount - a.hitCount)
      .slice(0, request.params.limit);
    appendJson(response, {
      hot_functions: hot,
      profile: request.params.include_profile ? profile : undefined,
    });
  },
});

export const captureHeapSnapshot = defineTool({
  name: 'capture_heap_snapshot',
  description: 'Capture a Chrome heap snapshot to a file.',
  annotations: {category: ToolCategory.DEBUGGING, readOnlyHint: false},
  schema: {save_path: zod.string()},
  handler: async (request, response, context) => {
    const session = await getCdpSession(asInternalContext(context));
    const chunks: string[] = [];
    session.on('HeapProfiler.addHeapSnapshotChunk', (event: {chunk: string}) =>
      chunks.push(event.chunk),
    );
    await session.send('HeapProfiler.enable');
    await session.send('HeapProfiler.takeHeapSnapshot', {
      reportProgress: false,
    });
    const file = await context.saveFile(
      new TextEncoder().encode(chunks.join('')),
      request.params.save_path,
    );
    appendJson(response, {
      status: 'saved',
      path: file.filename,
      chunks: chunks.length,
    });
  },
});

export const listSourceMaps = defineTool({
  name: 'list_source_maps',
  description: 'List loaded scripts that advertise source maps.',
  annotations: {category: ToolCategory.REVERSE_ENGINEERING, readOnlyHint: true},
  schema: {url_filter: zod.string().optional().default('')},
  handler: async (request, response, context) => {
    appendJson(
      response,
      context.debuggerContext
        .getScripts()
        .filter(
          script =>
            script.sourceMapURL &&
            script.url.includes(request.params.url_filter),
        )
        .map(script => ({
          script_id: script.scriptId,
          url: script.url,
          source_map_url: script.sourceMapURL,
        })),
    );
  },
});

export const getSourceMap = defineTool({
  name: 'get_source_map',
  description: 'Fetch and summarize a script source map.',
  annotations: {category: ToolCategory.REVERSE_ENGINEERING, readOnlyHint: true},
  schema: {
    script_id: zod.string().nullable().optional(),
    url: zod.string().nullable().optional(),
    include_map: boolParam().optional().default(false),
  },
  handler: async (request, response, context) => {
    const source = await getScriptSourceByUrlOrId(
      asInternalContext(context),
      request.params.url ?? undefined,
      request.params.script_id ?? undefined,
    );
    const script = context.debuggerContext.getScriptById(source.scriptId);
    if (!script?.sourceMapURL) throw new Error('script has no sourceMapURL');
    const map = await context.getSelectedPage().evaluate(
      async ({mapUrl, scriptUrl}) => {
        const abs = new URL(mapUrl, scriptUrl || location.href).href;
        return {url: abs, map: await fetch(abs).then(r => r.json())};
      },
      {mapUrl: script.sourceMapURL, scriptUrl: script.url},
    );
    let cache = sourceMapCache.get(asInternalContext(context));
    if (!cache)
      sourceMapCache.set(
        asInternalContext(context),
        (cache = new Map<string, unknown>()),
      );
    cache.set(source.scriptId, map.map);
    const mapObj = map.map as {sources?: unknown[]; sourcesContent?: unknown[]};
    appendJson(response, {
      url: map.url,
      sources: mapObj.sources?.length ?? 0,
      sourcesContent: mapObj.sourcesContent?.length ?? 0,
      map: request.params.include_map ? map.map : undefined,
    });
  },
});

export const getSourceMapSource = defineTool({
  name: 'get_source_map_source',
  description: 'Return an original source from a source map sourcesContent.',
  annotations: {category: ToolCategory.REVERSE_ENGINEERING, readOnlyHint: true},
  schema: {
    script_id: zod.string().nullable().optional(),
    url: zod.string().nullable().optional(),
    source_index: zod.number().int().nullable().optional(),
    source_path: zod.string().nullable().optional(),
  },
  handler: async (request, response, context) => {
    const source = await getScriptSourceByUrlOrId(
      asInternalContext(context),
      request.params.url ?? undefined,
      request.params.script_id ?? undefined,
    );
    let map = sourceMapCache
      .get(asInternalContext(context))
      ?.get(source.scriptId) as
      | {sources?: string[]; sourcesContent?: string[]}
      | undefined;
    if (!map) {
      const script = context.debuggerContext.getScriptById(source.scriptId);
      if (!script?.sourceMapURL)
        throw new Error('source map not loaded and script has no sourceMapURL');
      map = await context
        .getSelectedPage()
        .evaluate(
          async ({mapUrl, scriptUrl}) =>
            fetch(new URL(mapUrl, scriptUrl || location.href).href).then(r =>
              r.json(),
            ),
          {mapUrl: script.sourceMapURL, scriptUrl: script.url},
        );
    }
    const loadedMap = map!;
    const sources = loadedMap.sources ?? [];
    const sourcesContent = loadedMap.sourcesContent ?? [];
    const index =
      request.params.source_index ??
      (request.params.source_path
        ? sources.findIndex(item => item.includes(request.params.source_path!))
        : 0);
    if (index === undefined || index < 0) throw new Error('source not found');
    appendJson(response, {
      source_index: index,
      source_path: sources[index],
      source: sourcesContent[index] ?? null,
    });
  },
});

export const verifySignerOffline = defineTool({
  name: 'verify_signer_offline',
  description: 'Run a candidate JS signer against samples in the page context.',
  annotations: {
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {
    signer_code: zod.string(),
    samples: zod.array(zod.record(zod.unknown())),
    compare_params: zod.array(zod.string()).nullable().optional(),
  },
  handler: async (request, response, context) => {
    const result = await context.getSelectedPage().evaluate(
      ({code, samples, compareParams}) => {
        const signer = (0, eval)(`(${code})`);
        type Sample = {
          id?: unknown;
          expected?: Record<string, unknown>;
        } & Record<string, unknown>;
        const details = (samples as Sample[]).map(sample => {
          const computed = signer(sample) as
            | Record<string, unknown>
            | undefined;
          const expected = sample.expected || {};
          const keys = compareParams || Object.keys(expected);
          const passed = keys.every(
            key => String(computed?.[key]) === String(expected?.[key]),
          );
          return {id: sample.id, passed, computed, expected};
        });
        const passed = details.filter(item => item.passed).length;
        return {
          total_samples: samples.length,
          passed,
          failed: samples.length - passed,
          pass_rate: samples.length ? passed / samples.length : 0,
          details,
          first_divergence: details.find(item => !item.passed) || null,
        };
      },
      {
        code: request.params.signer_code,
        samples: request.params.samples,
        compareParams: request.params.compare_params ?? null,
      },
    );
    appendJson(response, result);
  },
});

export const websocketCapture = defineTool({
  name: 'websocket_capture',
  description:
    'Enable, clear, or inspect CDP WebSocket capture. Capture is initialized lazily by existing collectors.',
  annotations: {category: ToolCategory.NETWORK, readOnlyHint: false},
  schema: {
    action: zod.enum(['start', 'clear', 'status']).optional().default('start'),
  },
  handler: async (request, response, context) => {
    if (request.params.action === 'clear') {
      appendJson(response, {
        status: 'clear_requested',
        note: 'Existing WebSocket collector does not expose selective clear; preserved data expires with page/context.',
      });
      return;
    }
    appendJson(response, {
      status: 'active',
      connections: context.getWebSocketConnections(true).length,
    });
  },
});

export const listWebsockets = defineTool({
  name: 'list_websockets',
  description: 'List captured WebSocket connections.',
  annotations: {category: ToolCategory.NETWORK, readOnlyHint: true},
  schema: {
    url_filter: zod.string().optional().default(''),
    include_closed: boolParam().optional().default(true),
  },
  handler: async (request, response, context) => {
    let connections = context.getWebSocketConnections(true);
    if (request.params.url_filter)
      connections = connections.filter(ws =>
        ws.connection.url.includes(request.params.url_filter),
      );
    appendJson(
      response,
      connections.map(ws => ({
        wsid: context.getWebSocketStableId(ws),
        url: ws.connection.url,
        frame_count: ws.frames.length,
      })),
    );
  },
});

export const getWebsocketConnection = defineTool({
  name: 'get_websocket_connection',
  description: 'Get one WebSocket connection with optional recent messages.',
  annotations: {category: ToolCategory.NETWORK, readOnlyHint: true},
  schema: {
    wsid: zod.number().int(),
    include_messages: boolParam().optional().default(false),
    max_messages: zod.number().int().optional().default(50),
  },
  handler: async (request, response, context) => {
    const ws = context.getWebSocketById(request.params.wsid);
    appendJson(response, {
      wsid: request.params.wsid,
      url: ws.connection.url,
      frame_count: ws.frames.length,
      messages: request.params.include_messages
        ? ws.frames.slice(-request.params.max_messages)
        : undefined,
    });
  },
});

export const browserBinaryInfo = defineTool({
  name: 'browser_binary_info',
  description: 'Show browser binary info available to this TypeScript MCP.',
  requiresBrowserContext: false,
  annotations: {category: ToolCategory.DEBUGGING, readOnlyHint: true},
  schema: {},
  handler: async (_request, response, context) => {
    // Priority: runtime override > CLI arg > browser-connection/config.json file.
    const overrides = getRuntimeLaunchOverrides();
    const saved = loadBrowserConnectionConfig();
    const activeBrowser = overrides?.browser ?? _configuredBrowser;
    const configuredPathForActiveBrowser =
      activeBrowser === _configuredBrowser
        ? _configuredBrowserBinaryPath
        : undefined;
    const activeBinaryPath =
      overrides?.binaryPath ?? configuredPathForActiveBrowser;
    let cloakBinaryPath =
      activeBrowser === 'cloak'
        ? activeBinaryPath
        : _configuredBrowser === 'cloak'
          ? _configuredBrowserBinaryPath
          : undefined;
    const edgeBinaryPath =
      activeBrowser === 'edge'
        ? activeBinaryPath
        : _configuredBrowser === 'edge'
          ? _configuredBrowserBinaryPath
          : saved.edgeBinaryPath;

    // Fallback: read from browser-connection/config.json when no CLI/runtime path.
    // Skills write this file on first use to persist the path across sessions.
    cloakBinaryPath ??= saved.cloakBinaryPath;

    appendJson(response, {
      mode: 'patchright',
      browser: activeBrowser,
      chrome_active: activeBrowser === 'chrome',
      edge_active: activeBrowser === 'edge',
      edge_binary_path: edgeBinaryPath ?? null,
      cloak_active: activeBrowser === 'cloak',
      cloak_binary_path: cloakBinaryPath ?? null,
      config_file: BROWSER_CONFIG_FILE,
      selected_url: context.getSelectedPage().url(),
      note:
        'browser identifies the currently managed Chrome, Edge, or CloakBrowser instance. ' +
        'edge_binary_path is null when Edge is resolved through the installed msedge channel. ' +
        'cloak_binary_path: resolved CloakBrowser executable path (CLI > saved config > null). ' +
        'config_file: write {"browser":"cloak","cloakBinaryPath":"<path>"} here to persist the path and default browser across sessions. ' +
        'Switch at runtime via launch_browser({browser: "chrome" | "edge" | "cloak"}).',
    });
  },
});

export const checkBrowserUpdate = defineTool({
  name: 'check_browser_update',
  description:
    'Compatibility placeholder for CloakBrowser binary update checks.',
  requiresBrowserContext: false,
  annotations: {category: ToolCategory.DEBUGGING, readOnlyHint: true},
  schema: {},
  handler: async (_request, response) =>
    appendJson(response, {
      update_available: false,
      supported: false,
      note: 'This MCP does not manage CloakBrowser binaries; configure --cloakBinaryPath or use cloakbrowser-reverse-mcp update tools.',
    }),
});

export const updateBrowserBinary = defineTool({
  name: 'update_browser_binary',
  description: 'Compatibility placeholder for CloakBrowser binary updates.',
  requiresBrowserContext: false,
  annotations: {category: ToolCategory.DEBUGGING, readOnlyHint: false},
  schema: {
    version: zod.string().nullable().optional(),
    force: boolParam().optional().default(false),
    close_running_browser: boolParam().optional().default(false),
  },
  handler: async (_request, response) =>
    appendJson(response, {
      status: 'unsupported',
      note: 'This MCP does not update browser binaries in-place; use the Python cloakbrowser-reverse-mcp update_browser_binary tool.',
    }),
});

export const tracePropertyAccess = defineTool({
  name: 'trace_property_access',
  description:
    'Engine-level DOM property tracing is not available in Chromium/Patchright. Returns environment snapshot fallback.',
  annotations: {category: ToolCategory.DEBUGGING, readOnlyHint: true},
  schema: {
    duration: zod.number().int().optional().default(10),
    mode: zod.string().optional().default('summary'),
    collect_values: boolParam().optional().default(false),
  },
  handler: async (_request, response, context) => {
    const env = await context.getSelectedPage().evaluate(() => ({
      navigator: {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        webdriver: navigator.webdriver,
      },
      screen: {width: screen.width, height: screen.height},
    }));
    appendJson(response, {
      mode: 'fallback',
      total_events: 0,
      unsupported: true,
      values: env,
    });
  },
});

export const launchBrowser = defineTool({
  name: 'launch_browser',
  description:
    'Launch (or switch) the browser for JS reverse engineering. ' +
    'Set browser to chrome, edge, or cloak to close the current browser and switch on the next tool call. ' +
    'Omit browser and binary paths to report current state. ' +
    'The legacy cloakBinaryPath switch remains supported.',
  requiresBrowserContext: false,
  annotations: {category: ToolCategory.NAVIGATION, readOnlyHint: false},
  schema: {
    browser: zod
      .enum(MANAGED_BROWSERS)
      .optional()
      .describe(
        'Managed browser to use: chrome (Google Chrome), edge (Microsoft Edge), or cloak (CloakBrowser).',
      ),
    headless: boolParam().optional(),
    locale: zod.string().optional(),
    proxy: zod.string().nullable().optional(),
    humanize: boolParam().optional(),
    geoip: boolParam().optional(),
    block_images: boolParam().optional(),
    block_webrtc: boolParam().optional(),
    fingerprint_seed: zod.number().int().nullable().optional(),
    window_width: zod.number().int().optional(),
    window_height: zod.number().int().optional(),
    persistent_profile: boolParam().optional(),
    remote_debugging_port: zod.number().int().nullable().optional(),
    auto_update: boolParam().optional(),
    args: zod.array(zod.string()).nullable().optional(),
    cloakBinaryPath: zod
      .string()
      .optional()
      .describe(
        'Optional CloakBrowser executable path. For backward compatibility, a non-empty value selects CloakBrowser and an empty value selects Chrome when browser is omitted.',
      ),
    edgeBinaryPath: zod
      .string()
      .optional()
      .describe(
        'Optional Microsoft Edge executable path. Omit or pass an empty string to use the installed stable Edge channel.',
      ),
  },
  handler: async (request, response, context) => {
    // Toggle humanize at runtime without restarting browser
    if (request.params.humanize !== undefined) {
      _humanizeEnabled = request.params.humanize;
    }
    const switchRequested =
      request.params.browser !== undefined ||
      request.params.cloakBinaryPath !== undefined ||
      request.params.edgeBinaryPath !== undefined;
    if (switchRequested) {
      const hasCloakPath = !!request.params.cloakBinaryPath;
      const hasEdgePath = !!request.params.edgeBinaryPath;
      if (hasCloakPath && hasEdgePath) {
        throw new Error(
          'cloakBinaryPath and edgeBinaryPath cannot both be provided.',
        );
      }

      const targetBrowser: ManagedBrowser = request.params.browser
        ? request.params.browser
        : request.params.edgeBinaryPath !== undefined
          ? 'edge'
          : request.params.cloakBinaryPath === ''
            ? 'chrome'
            : 'cloak';

      if (targetBrowser === 'chrome' && (hasCloakPath || hasEdgePath)) {
        throw new Error(
          'Chrome does not accept cloakBinaryPath or edgeBinaryPath.',
        );
      }
      if (targetBrowser === 'edge' && hasCloakPath) {
        throw new Error('Edge does not accept cloakBinaryPath.');
      }
      if (targetBrowser === 'cloak' && hasEdgePath) {
        throw new Error('CloakBrowser does not accept edgeBinaryPath.');
      }

      const binaryPath =
        targetBrowser === 'edge'
          ? request.params.edgeBinaryPath || undefined
          : targetBrowser === 'cloak'
            ? request.params.cloakBinaryPath || undefined
            : undefined;
      setRuntimeLaunchOverrides({
        browser: targetBrowser,
        binaryPath,
      });
      await closeBrowser(`manual switch via launch_browser (${targetBrowser})`);
      const targetLabel =
        targetBrowser === 'chrome'
          ? 'Google Chrome'
          : targetBrowser === 'edge'
            ? 'Microsoft Edge'
            : 'CloakBrowser';
      appendJson(response, {
        status: 'switching',
        target: targetLabel,
        browser: targetBrowser,
        path: binaryPath ?? null,
        note: `Browser closed. Next tool call will automatically relaunch with ${targetLabel}.`,
      });
      response.setContextDetached(true);
      return;
    }

    const activeBrowser =
      getRuntimeLaunchOverrides()?.browser ?? _configuredBrowser;
    const pages = context
      .getPages()
      .map((page, index) => ({index, url: page.url()}));
    appendJson(response, {
      status: pages.length ? 'already_running' : 'configured',
      browser: activeBrowser,
      note: pages.length
        ? 'Browser context is available. Pass browser="chrome", "edge", or "cloak" to switch at runtime.'
        : 'Browser context is not running yet. The next browser-dependent tool call will launch the configured browser.',
      cli_flag_mapping: {
        browser_edge: '--edge',
        headless: '--headless',
        locale: '--locale zh-CN',
        proxy: '--proxy http://user:pass@host:port',
        block_images: '--blockImages',
        block_webrtc: '--blockWebRtc',
        fingerprint_seed: '--fingerprintSeed 12345  (requires --cloak)',
        cloak_binary: '--cloakBinaryPath "D:\\\\path\\\\to\\\\chrome.exe"',
        edge_binary:
          '--edgeBinaryPath "C:\\\\Program Files (x86)\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe"',
        isolated_profile: '--isolated',
        connect_existing: '--browserUrl http://127.0.0.1:9222',
        humanize: '--humanize --humanPreset default|careful',
        geoip: '--geoip  (uses --proxy when provided)',
      },
      pages,
      selected_url: context.getSelectedPage().url(),
      humanize: _humanizeEnabled,
    });
  },
});

export const closeBrowserTool = defineTool({
  name: 'close_browser',
  description:
    'Close the managed browser and release all resources, clearing any runtime browser override. The next tool call relaunches the browser selected by the MCP CLI configuration.',
  requiresBrowserContext: false,
  annotations: {category: ToolCategory.NAVIGATION, readOnlyHint: false},
  schema: {},
  handler: async (_request, response) => {
    setRuntimeLaunchOverrides(undefined);
    await closeBrowser('manual close via close_browser tool');
    appendJson(response, {
      status: 'closed',
      note: 'Browser closed and runtime overrides cleared. Next tool call will launch the browser selected by the MCP CLI configuration.',
    });
    response.setContextDetached(true);
  },
});

export const captureScreenshotCdp = defineTool({
  name: 'capture_screenshot_cdp',
  description: 'Capture screenshot through CDP Page.captureScreenshot.',
  annotations: {category: ToolCategory.DEBUGGING, readOnlyHint: true},
  schema: {
    format: zod.enum(['png', 'jpeg', 'webp']).optional().default('png'),
    quality: zod.number().int().nullable().optional(),
  },
  handler: async (request, response, context) => {
    const session = await getCdpSession(asInternalContext(context));
    const result = await session.send('Page.captureScreenshot', {
      format: request.params.format,
      quality: request.params.quality ?? undefined,
    });
    appendJson(response, {format: request.params.format, data: result.data});
  },
});

export const listCdpNetworkRequests = defineTool({
  name: 'list_cdp_network_requests',
  description:
    'List network requests with CDP-compatible naming, backed by the existing js-reverse-mcp network queue.',
  annotations: {category: ToolCategory.NETWORK, readOnlyHint: true},
  schema: {
    url_filter: zod.string().nullable().optional(),
    method: zod.string().nullable().optional(),
    resource_type: zod.string().nullable().optional(),
    has_initiator: boolParam().nullable().optional(),
    limit: zod.number().int().optional().default(100),
  },
  handler: async (request, response, context) => {
    const internal = asInternalContext(context);
    let requests = internal.getNetworkRequests();
    // Automatically filter out Patchright addInitScript requests
    requests = requests.filter(
      r => !r.url().includes('patchright-init-script-inject.internal'),
    );
    if (request.params.url_filter) {
      requests = requests.filter(item =>
        item.url().includes(request.params.url_filter!),
      );
    }
    if (request.params.method) {
      requests = requests.filter(
        item =>
          item.method().toUpperCase() === request.params.method!.toUpperCase(),
      );
    }
    if (request.params.resource_type) {
      requests = requests.filter(
        item => item.resourceType() === request.params.resource_type,
      );
    }
    if (
      request.params.has_initiator !== undefined &&
      request.params.has_initiator !== null
    ) {
      requests = requests.filter(
        item =>
          Boolean(context.getRequestInitiator(item)) ===
          request.params.has_initiator,
      );
    }
    const rows = await Promise.all(
      requests.slice(-request.params.limit).map(async item => {
        const response = await item.response().catch(() => null);
        const requestId = internal.getNetworkRequestStableId(item);
        return {
          cdp_request_id: String(requestId),
          request_id: requestId,
          url: item.url(),
          method: item.method(),
          resource_type: item.resourceType(),
          status: response?.status() ?? null,
          has_initiator: Boolean(context.getRequestInitiator(item)),
        };
      }),
    );
    appendJson(response, rows);
  },
});

function getRequestByCdpCompatId(
  context: InternalContext,
  cdpRequestId: string,
): HTTPRequestCompat {
  const numeric = Number(cdpRequestId);
  if (!Number.isInteger(numeric)) {
    throw new Error(
      'This compatibility layer uses js-reverse request ids as cdp_request_id values. Pass the cdp_request_id returned by list_cdp_network_requests.',
    );
  }
  return context.getNetworkRequestById(numeric) as HTTPRequestCompat;
}

type HTTPRequestCompat = ReturnType<InternalContext['getNetworkRequestById']>;

export const getCdpNetworkRequest = defineTool({
  name: 'get_cdp_network_request',
  description: 'Get a CDP-compatible network request snapshot.',
  annotations: {category: ToolCategory.NETWORK, readOnlyHint: true},
  schema: {
    cdp_request_id: zod.string(),
    include_body: boolParam().optional().default(false),
    max_body_size: zod.number().int().optional().default(5000),
  },
  handler: async (request, response, context) => {
    const req = getRequestByCdpCompatId(
      asInternalContext(context),
      request.params.cdp_request_id,
    );
    const exported = await exportNetworkRequestPart(req, 'all');
    const snapshot = JSON.parse(
      Buffer.from(exported.data).toString('utf8'),
    ) as Record<string, unknown>;
    if (!request.params.include_body) {
      delete snapshot.requestBody;
      delete snapshot.responseBody;
    }
    appendJson(response, snapshot);
  },
});

export const getCdpRequestPostData = defineTool({
  name: 'get_cdp_request_post_data',
  description: 'Get request POST data for a captured request.',
  annotations: {category: ToolCategory.NETWORK, readOnlyHint: true},
  schema: {
    cdp_request_id: zod.string(),
    max_size: zod.number().int().optional().default(20000),
  },
  handler: async (request, response, context) => {
    const req = getRequestByCdpCompatId(
      asInternalContext(context),
      request.params.cdp_request_id,
    );
    const postData = req.postData() ?? '';
    appendJson(response, {
      cdp_request_id: request.params.cdp_request_id,
      size: postData.length,
      post_data:
        postData.length > request.params.max_size
          ? `${postData.slice(0, request.params.max_size)}...`
          : postData,
      truncated: postData.length > request.params.max_size,
    });
  },
});

export const getCdpRequestInitiator = defineTool({
  name: 'get_cdp_request_initiator',
  description: 'Return request initiator for a CDP-compatible request id.',
  annotations: {category: ToolCategory.NETWORK, readOnlyHint: true},
  schema: {cdp_request_id: zod.string()},
  handler: async (request, response, context) => {
    const req = getRequestByCdpCompatId(
      asInternalContext(context),
      request.params.cdp_request_id,
    );
    appendJson(response, {
      cdp_request_id: request.params.cdp_request_id,
      url: req.url(),
      initiator: context.getRequestInitiator(req) ?? null,
    });
  },
});

export const hookJsvmpInterpreter = defineTool({
  name: 'hook_jsvmp_interpreter',
  description:
    'Install a page-level JSVMP runtime probe. ' +
    'mode=proxy wraps target window objects with Proxy (detectable, captures get/apply). ' +
    'mode=transparent overrides Reflect.get (less detectable, captures all property reads). ' +
    'Results are stored in window.__mcp_jsvmp_log.',
  annotations: {
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {
    script_url: zod.string().optional().default(''),
    persistent: boolParam().optional().default(true),
    mode: zod.enum(['proxy', 'transparent']).optional().default('transparent'),
    track_calls: boolParam().optional().default(true),
    track_props: boolParam().optional().default(true),
    track_reflect: boolParam().optional().default(true),
    proxy_objects: zod.array(zod.string()).nullable().optional(),
    max_entries: zod.number().int().optional().default(10000),
  },
  handler: async (request, response, context) => {
    const defaultProxyObjects = [
      'navigator',
      'screen',
      'history',
      'localStorage',
      'sessionStorage',
      'performance',
    ];
    const proxyObjects = request.params.proxy_objects ?? defaultProxyObjects;
    const maxEntries = request.params.max_entries;
    const mode = request.params.mode;

    const source =
      mode === 'proxy'
        ? jsvmpProxyHookSource({maxEntries, proxyObjects})
        : jsvmpTransparentHookSource(maxEntries);

    const hookKey = `jsvmp:${mode}:${request.params.script_url || 'all'}`;
    if (request.params.persistent) {
      await addPersistentMainWorldScript(
        asInternalContext(context),
        hookKey,
        source,
      );
    }
    await evaluateMainWorld(context.getSelectedPage(), source);

    const warnings: string[] = [];
    if (context.getSelectedPage().url() !== 'about:blank')
      warnings.push(
        'Hook installed on an already-loaded page; reload for best coverage.',
      );
    if (mode === 'proxy')
      warnings.push('proxy mode is detectable by anti-bot scripts.');

    appendJson(response, {
      status: 'installed',
      mode,
      persistent: request.params.persistent,
      data_location: 'window.__mcp_jsvmp_log',
      ...(warnings.length ? {warnings} : {}),
    });
  },
});

export const instrumentation = defineTool({
  name: 'instrumentation',
  description:
    'Source-level script instrumentation via route-based AST rewriting. ' +
    'install: intercepts JS responses matching url_pattern and rewrites safe member reads to log calls. ' +
    'log: read the runtime log. stop: remove route. reload: reload the page. status: show active routes.',
  annotations: {
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {
    action: zod.enum(['install', 'log', 'stop', 'reload', 'status']),
    url_pattern: zod.string().optional().default(''),
    mode: zod.enum(['ast', 'regex']).optional().default('ast'),
    tag: zod.string().optional().default('vmp'),
    rewrite_member_access: boolParam().optional().default(true),
    fallback_on_error: boolParam().optional().default(true),
    max_rewrites: zod.number().int().optional().default(20000),
    filter_property_names: zod.array(zod.string()).nullable().optional(),
    filter_object_names: zod.array(zod.string()).nullable().optional(),
    max_file_size: zod.number().int().optional().default(200000),
    on_oversized: zod
      .enum(['selective', 'skip', 'force'])
      .optional()
      .default('selective'),
    clear_log: boolParam().optional().default(true),
    wait_until: zod.enum(WAIT_UNTIL).optional().default('load'),
    tag_filter: zod.string().nullable().optional(),
    type_filter: zod.string().nullable().optional(),
    key_filter: zod.string().nullable().optional(),
    limit: zod.number().int().optional().default(500),
    clear: boolParam().optional().default(false),
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    const internal = asInternalContext(context);

    // --- install ---
    if (request.params.action === 'install') {
      const pattern = request.params.url_pattern;
      if (!pattern)
        return appendJson(response, {
          type: 'error',
          error: 'url_pattern is required for action=install',
        });

      const tag = request.params.tag;
      const rewriteMode = request.params.mode;
      const rewriteMemberAccess = request.params.rewrite_member_access;
      const fallbackOnError = request.params.fallback_on_error;
      const maxRewrites = request.params.max_rewrites;
      const filterProps = request.params.filter_property_names ?? undefined;
      const filterObjs = request.params.filter_object_names ?? undefined;
      const maxFileSize = request.params.max_file_size;
      const onOversized = request.params.on_oversized;
      const stats: Record<string, unknown> = {
        files_rewritten: 0,
        files_skipped_oversized: 0,
        ast_fallbacks: 0,
        total_edits: 0,
        mode: rewriteMode,
        last_mode: null,
        last_fallback_reason: null,
        last_url: null,
      };
      const cache = new Map<string, string>();

      const routeHandler = async (route: {
        request(): {url(): string; resourceType(): string};
        fetch(): Promise<{
          headers(): Record<string, string>;
          body(): Promise<Buffer>;
          status(): number;
        }>;
        fulfill(opts: unknown): Promise<void>;
        continue(opts?: unknown): Promise<void>;
        fallback(opts?: unknown): Promise<void>;
      }) => {
        const reqUrl = route.request().url();
        // Only rewrite JavaScript resources; pass everything else down the
        // route chain via fallback() so intercept_request handlers registered
        // after instrumentation still fire.
        const rt = route.request().resourceType();
        if (rt !== 'script' && !reqUrl.includes('.js')) {
          await route.fallback();
          return;
        }
        if (cache.has(reqUrl)) {
          await route.fulfill({
            status: 200,
            headers: {'content-type': 'application/javascript; charset=utf-8'},
            body: cache.get(reqUrl)!,
          });
          return;
        }
        const resp = await route.fetch();
        const rawBody = await resp.body();
        const bodyStr = rawBody.toString('utf8');

        const oversized = bodyStr.length > maxFileSize;
        const selectiveOversizedSkip =
          oversized &&
          onOversized === 'selective' &&
          !filterProps?.length &&
          !filterObjs?.length;
        if (oversized && (onOversized === 'skip' || selectiveOversizedSkip)) {
          stats.files_skipped_oversized =
            (stats.files_skipped_oversized as number) + 1;
          const headers = Object.fromEntries(
            Object.entries(resp.headers()).filter(
              ([k]) => !STRIP_HEADERS.has(k.toLowerCase()),
            ),
          );
          await route.fulfill({status: resp.status(), headers, body: rawBody});
          return;
        }

        const rewritten = rewriteInstrumentedSource(bodyStr, {
          tag,
          mode: rewriteMode,
          rewriteMemberAccess,
          maxRewrites,
          filterPropertyNames: filterProps as string[] | undefined,
          filterObjectNames: filterObjs as string[] | undefined,
          fallbackOnError,
        });

        cache.set(reqUrl, rewritten.source);
        stats.files_rewritten = (stats.files_rewritten as number) + 1;
        stats.total_edits = (stats.total_edits as number) + rewritten.edits;
        stats.last_mode = rewritten.mode;
        if (rewritten.fallbackReason) {
          stats.ast_fallbacks = (stats.ast_fallbacks as number) + 1;
          stats.last_fallback_reason = rewritten.fallbackReason;
        }
        stats.last_url = reqUrl;

        const outHeaders = Object.fromEntries(
          Object.entries(resp.headers()).filter(
            ([k]) => !STRIP_HEADERS.has(k.toLowerCase()),
          ),
        );
        outHeaders['content-type'] = 'application/javascript; charset=utf-8';
        await route.fulfill({
          status: resp.status(),
          headers: outHeaders,
          body: rewritten.source,
        });
      };

      await asInternalContext(context).browserContext.route(
        pattern,
        routeHandler as never,
      );

      let routes = instrumentationRoutes.get(internal);
      if (!routes) {
        routes = new Map();
        instrumentationRoutes.set(internal, routes);
      }
      routes.set(pattern, {tag, stats, handler: routeHandler});

      return appendJson(response, {
        status: 'installed',
        pattern,
        tag,
        mode: rewriteMode,
      });
    }

    // --- log ---
    if (request.params.action === 'log') {
      let logs = (await page.evaluate(lim => {
        const t = window as typeof window & {__mcp_instrument_log?: unknown[]};
        return (t.__mcp_instrument_log || []).slice(-lim);
      }, request.params.limit)) as Array<Record<string, unknown>>;
      if (request.params.tag_filter)
        logs = logs.filter(x => x['tag'] === request.params.tag_filter);
      if (request.params.type_filter)
        logs = logs.filter(x => x['type'] === request.params.type_filter);
      if (request.params.key_filter)
        logs = logs.filter(x =>
          String(x['key'] ?? '').includes(request.params.key_filter!),
        );
      if (request.params.clear)
        await page.evaluate(() => {
          const t = window as typeof window & {
            __mcp_instrument_log?: unknown[];
          };
          t.__mcp_instrument_log = [];
        });
      return appendJson(response, {
        total: logs.length,
        returned: logs.length,
        entries: logs,
      });
    }

    // --- stop ---
    if (request.params.action === 'stop') {
      const routes = instrumentationRoutes.get(internal);
      if (!routes) return appendJson(response, {status: 'stopped', count: 0});
      const targets = request.params.url_pattern
        ? [request.params.url_pattern]
        : Array.from(routes.keys());
      let stopped = 0;
      for (const pat of targets) {
        const entry = routes.get(pat);
        if (!entry) continue; // skip patterns not registered by us
        // Pass the saved handler so we only remove our own route and leave
        // other handlers on the same pattern (e.g. blockImages on '**/*') intact.
        await asInternalContext(context)
          .browserContext.unroute(pat, entry.handler as never)
          .catch(() => undefined);
        routes.delete(pat);
        stopped++;
      }
      return appendJson(response, {status: 'stopped', count: stopped});
    }

    // --- reload ---
    if (request.params.action === 'reload') {
      if (request.params.clear_log)
        await page
          .evaluate(() => {
            const t = window as typeof window & {
              __mcp_instrument_log?: unknown[];
            };
            t.__mcp_instrument_log = [];
          })
          .catch(() => undefined);
      const resp = await page.reload({waitUntil: request.params.wait_until});
      return appendJson(response, {
        status: 'reloaded',
        url: page.url(),
        http_status: resp?.status() ?? null,
      });
    }

    // --- status ---
    const routes = instrumentationRoutes.get(internal);
    appendJson(response, {
      total_patterns: routes?.size ?? 0,
      active_patterns: Array.from(routes?.entries() ?? []).map(([p, v]) => ({
        pattern: p,
        tag: v.tag,
        stats: v.stats,
      })),
    });
  },
});

export const listTraceFiles = defineTool({
  name: 'list_trace_files',
  description:
    'List trace files. Engine-level trace files are not produced by this MCP.',
  requiresBrowserContext: false,
  annotations: {category: ToolCategory.DEBUGGING, readOnlyHint: true},
  schema: {limit: zod.number().int().optional().default(20)},
  handler: async (_request, response) =>
    appendJson(response, {traces_dir: null, total: 0, files: []}),
});

export const queryTraceFile = defineTool({
  name: 'query_trace_file',
  description:
    'Query a trace file. Engine-level trace files are not produced by this MCP.',
  requiresBrowserContext: false,
  annotations: {category: ToolCategory.DEBUGGING, readOnlyHint: true},
  schema: {
    file_path: zod.string(),
    mode: zod.string().optional().default('summary'),
  },
  handler: async (_request, response) =>
    appendJson(response, {unsupported: true, entries: []}),
});
