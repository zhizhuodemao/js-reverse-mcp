/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import 'core-js/modules/es.promise.with-resolvers.js';
import 'core-js/proposals/iterator-helpers.js';

export type {Options as YargsOptions} from 'yargs';
export {default as yargs} from 'yargs';
export {hideBin} from 'yargs/helpers';
export {default as debug} from 'debug';
export type {Debugger} from 'debug';
export {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
export {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
export {
  type CallToolResult,
  SetLevelRequestSchema,
  type ImageContent,
  type TextContent,
} from '@modelcontextprotocol/sdk/types.js';
export {z as zod} from 'zod';

// Patchright exports
export {chromium} from 'patchright';
export type {
  Browser,
  BrowserContext,
  BrowserType,
  Page,
  Frame,
  CDPSession,
  Request,
  Response,
  ConsoleMessage,
  Dialog,
  JSHandle,
  ElementHandle,
  Locator,
  Worker,
  LaunchOptions,
} from 'patchright';

// CDP Protocol types from devtools-protocol
export type {Protocol} from 'devtools-protocol';

// Type aliases for backward compatibility in the codebase
// Puppeteer used HTTPRequest/HTTPResponse, Playwright uses Request/Response
import type {Request as _Request, Response as _Response} from 'patchright';
export type HTTPRequest = _Request;
export type HTTPResponse = _Response;
