/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import './polyfill.js';

import {ensureBrowserConnected, ensureBrowserLaunched} from './browser.js';
import type {BrowserResult} from './browser.js';
import {parseArguments} from './cli.js';
import {features} from './features.js';
import {loadIssueDescriptions} from './issue-descriptions.js';
import {logger, saveLogsToFile} from './logger.js';
import {McpContext} from './McpContext.js';
import {McpResponse} from './McpResponse.js';
import {Mutex} from './Mutex.js';
import {
  McpServer,
  StdioServerTransport,
  type CallToolResult,
  SetLevelRequestSchema,
} from './third_party/index.js';
import {ToolCategory} from './tools/categories.js';
import * as consoleTools from './tools/console.js';
import * as debuggerTools from './tools/debugger.js';
import * as frameTools from './tools/frames.js';
import * as networkTools from './tools/network.js';
import * as pagesTools from './tools/pages.js';
import * as screenshotTools from './tools/screenshot.js';
import * as scriptTools from './tools/script.js';
import * as siteDataTools from './tools/siteData.js';
import type {ToolDefinition} from './tools/ToolDefinition.js';
import * as websocketTools from './tools/websocket.js';

// If moved update release-please config
// x-release-please-start-version
const VERSION = '0.10.2';
// x-release-please-end

export const args = parseArguments(VERSION);

const logFile = args.logFile ? saveLogsToFile(args.logFile) : undefined;

logger(`Starting Chrome DevTools MCP Server v${VERSION}`);
const server = new McpServer(
  {
    name: 'js-reverse',
    title: 'JS Reverse Engineering MCP Server',
    description:
      'JavaScript reverse engineering and debugging via Chrome DevTools. Built on Patchright anti-detection engine — passes mainstream browser fingerprint checks (Zhihu, Google, etc.) out of the box.',
    version: VERSION,
  },
  {capabilities: {logging: {}}},
);
server.server.setRequestHandler(SetLevelRequestSchema, () => {
  return {};
});

let context: McpContext;

// No JS-level init scripts — Patchright's protocol-layer stealth handles
// automation signal suppression. JS patches (Error.prepareStackTrace, screen
// property overrides, fake chrome.runtime) actually CAUSE detection because
// anti-bot systems check for Object.defineProperty tampering. Source-level
// fingerprint patches (canvas/WebGL/GPU) are opt-in via --cloak.

async function getContext(): Promise<McpContext> {
  let result: BrowserResult;
  if (args.browserUrl) {
    result = await ensureBrowserConnected({
      browserURL: args.browserUrl,
    });
  } else {
    result = await ensureBrowserLaunched({
      isolated: args.isolated,
      logFile,
      cloak: args.cloak,
    });
  }

  if (!context || context.browserContext !== result.context) {
    context = await McpContext.from(result.context, logger);
  }
  return context;
}

const logDisclaimers = () => {
  console.error(
    `js-reverse-mcp exposes content of the browser instance to the MCP clients allowing them to inspect,
debug, and modify any data in the browser or DevTools.
Avoid sharing sensitive or personal information that you do not want to share with MCP clients.`,
  );
};

const toolMutex = new Mutex();

function registerTool(tool: ToolDefinition): void {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.schema,
      annotations: tool.annotations,
    },
    async (params): Promise<CallToolResult> => {
      const guard = await toolMutex.acquire();
      try {
        logger(`${tool.name} request: ${JSON.stringify(params, null, '  ')}`);
        const context = await getContext();
        logger(`${tool.name} context: resolved`);
        // Navigation and browser-state tools must operate in CDP silence except
        // for their own explicit protocol calls.
        // Anti-bot systems detect ANY CDP activity during page load,
        // including session creation from detectOpenDevToolsWindows().
        if (
          tool.annotations.category !== ToolCategory.NAVIGATION &&
          tool.annotations.category !== ToolCategory.BROWSER_STATE
        ) {
          await context.ensureCollectorsInitialized();
          await context.detectOpenDevToolsWindows();
        }
        const response = new McpResponse();
        await tool.handler(
          {
            params,
          },
          response,
          context,
        );
        try {
          const content = await response.handle(tool.name, context);
          return {
            content,
          };
        } catch (error) {
          const errorText =
            error instanceof Error ? error.message : String(error);

          return {
            content: [
              {
                type: 'text',
                text: errorText,
              },
            ],
            isError: true,
          };
        }
      } catch (err) {
        logger(`${tool.name} error: ${err.message}`);
        throw err;
      } finally {
        guard.dispose();
      }
    },
  );
}

const tools = [
  ...Object.values(consoleTools),
  ...Object.values(debuggerTools),
  ...Object.values(frameTools),
  ...Object.values(networkTools),
  ...Object.values(pagesTools),
  ...Object.values(screenshotTools),
  ...Object.values(scriptTools),
  ...Object.values(siteDataTools),

  ...Object.values(websocketTools),
] as ToolDefinition[];

tools.sort((a, b) => {
  return a.name.localeCompare(b.name);
});

for (const tool of tools) {
  registerTool(tool);
}

if (features.issues) {
  await loadIssueDescriptions();
}
const transport = new StdioServerTransport();
await server.connect(transport);
logger('Chrome DevTools MCP Server connected');
logDisclaimers();
