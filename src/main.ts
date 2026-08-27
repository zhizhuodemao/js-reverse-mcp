/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import './polyfill.js';

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  closeBrowser,
  ensureBrowserConnected,
  ensureBrowserLaunched,
  getRuntimeLaunchOverrides,
} from './browser.js';
import type {BrowserResult, ManagedBrowser} from './browser.js';
import {loadBrowserConnectionConfig} from './browserConfig.js';
import {parseArguments} from './cli.js';
import {features} from './features.js';
import {resolveProxyGeo, resolveLocalGeo} from './geoip.js';
import {resolveHumanConfig} from './human.js';
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
import * as batchTools from './tools/batch.js';
import * as cloakCompatTools from './tools/cloakCompat.js';
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

// Read the version from package.json at runtime so it never drifts from the
// published package. Releases here are driven by `npm version` + a git tag, not
// release-please, so a hardcoded constant would go stale.
const VERSION = (
  JSON.parse(
    fs.readFileSync(
      path.join(import.meta.dirname, '../../package.json'),
      'utf8',
    ),
  ) as {version: string}
).version;

export const args = parseArguments(VERSION);

const savedBrowserConfig = loadBrowserConnectionConfig();
const cliConfiguredBrowser: ManagedBrowser | undefined = args.edge
  ? 'edge'
  : args.cloak
    ? 'cloak'
    : undefined;
const configuredBrowser: ManagedBrowser =
  cliConfiguredBrowser ?? savedBrowserConfig.browser ?? 'chrome';
const configuredBrowserBinaryPath =
  configuredBrowser === 'edge'
    ? (args.edgeBinaryPath ?? savedBrowserConfig.edgeBinaryPath)
    : configuredBrowser === 'cloak'
      ? (args.cloakBinaryPath ?? savedBrowserConfig.cloakBinaryPath)
      : undefined;
cloakCompatTools.setBrowserConfig(configuredBrowser, configuredBrowserBinaryPath);

const logFile = args.logFile ? saveLogsToFile(args.logFile) : undefined;

logger(`Starting Chrome DevTools MCP Server v${VERSION}`);
const server = new McpServer(
  {
    name: 'js-reverse',
    title: 'JS Reverse Engineering MCP Server',
    description: `JavaScript reverse engineering and debugging via Chrome DevTools (v${VERSION}). Built on Patchright anti-detection engine — passes mainstream browser fingerprint checks (Zhihu, Google, etc.) out of the box.`,
    version: VERSION,
  },
  {capabilities: {logging: {}}},
);
server.server.setRequestHandler(SetLevelRequestSchema, () => {
  return {};
});

let context: McpContext | undefined;

const NO_BROWSER_CONTEXT = createNoBrowserContext();

function createNoBrowserContext(): McpContext {
  const frame = {
    url: () => 'about:blank',
    name: () => '',
  };
  const page = {
    url: () => 'about:blank',
    mainFrame: () => frame,
  };
  return {
    createPagesSnapshot: () => Promise.resolve(),
    getNetworkConditions: () => '',
    getNavigationTimeout: () => 0,
    getCpuThrottlingRate: () => 1,
    getPages: () => [],
    getSelectedPage: () => page,
    getSelectedFrame: () => frame,
    isPageSelected: () => false,
  } as unknown as McpContext;
}

// No JS-level init scripts — Patchright's protocol-layer stealth handles
// automation signal suppression. JS patches (Error.prepareStackTrace, screen
// property overrides, fake chrome.runtime) actually CAUSE detection because
// anti-bot systems check for Object.defineProperty tampering. Source-level
// fingerprint patches (canvas/WebGL/GPU) are opt-in via --cloak.

async function getContext(): Promise<McpContext> {
  let result: BrowserResult;
  if (args.browserUrl) {
    result = await ensureBrowserConnected({browserURL: args.browserUrl});
  } else {
    const runtimeOverrides = getRuntimeLaunchOverrides();
    const managedBrowser = runtimeOverrides?.browser ?? configuredBrowser;
    const browserBinaryPath =
      runtimeOverrides?.binaryPath ??
      (managedBrowser === 'edge'
        ? (args.edgeBinaryPath ?? savedBrowserConfig.edgeBinaryPath)
        : managedBrowser === 'cloak'
          ? (args.cloakBinaryPath ?? savedBrowserConfig.cloakBinaryPath)
          : undefined);

    // --geoip: resolve timezone/locale from the proxy's exit IP before launch.
    let locale = args.locale;
    let timezone = args.timezone;
    if (args.geoip) {
      try {
        const geo = args.proxy
          ? await resolveProxyGeo(args.proxy)
          : await resolveLocalGeo();
        if (geo.timezone && !args.timezone) timezone = geo.timezone;
        if (geo.locale && !args.locale) locale = geo.locale;
        logger(
          `GeoIP resolved: ip=${geo.ip} country=${geo.country} locale=${locale} timezone=${timezone}`,
        );
      } catch (e) {
        logger('GeoIP lookup failed (proceeding without geo settings):', e);
      }
    }
    result = await ensureBrowserLaunched({
      isolated: args.isolated,
      logFile,
      browser: managedBrowser,
      browserBinaryPath,
      fingerprintSeed: args.fingerprintSeed,
      proxy: args.proxy,
      locale,
      timezone,
      headless: args.headless,
      blockWebRtc: args.blockWebRtc,
      blockImages: args.blockImages,
      windowWidth: args.windowWidth,
      windowHeight: args.windowHeight,
    });
  }

  if (!context || context.browserContext !== result.context) {
    context?.dispose();
    context = await McpContext.from(result.context, logger);
  }
  // Propagate humanize settings to compatibility tools layer.
  cloakCompatTools.setHumanizeConfig(
    args.humanize ?? false,
    resolveHumanConfig(
      (args.humanPreset ?? 'default') as 'default' | 'careful',
    ),
  );
  // Propagate startup settings so browser_binary_info can report effective
  // browser state without importing main.ts.
  cloakCompatTools.setBrowserConfig(
    configuredBrowser,
    configuredBrowserBinaryPath,
  );
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
const DEFAULT_TOOL_TIMEOUT_MS = 35_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

function getErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorResult(text: string): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
    isError: true,
  };
}

function withToolTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  toolName: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new Error(
          `Tool "${toolName}" timed out after ${timeoutMs}ms. If execution is paused at a breakpoint, call pause_or_resume and retry.`,
        ),
      );
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

function registerTool(tool: ToolDefinition): void {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.schema,
      annotations: tool.annotations,
    },
    async (params): Promise<CallToolResult> => {
      let guard: InstanceType<typeof Mutex.Guard>;
      try {
        guard = await toolMutex.acquire({timeoutMs: DEFAULT_TOOL_TIMEOUT_MS});
      } catch (error) {
        return errorResult(getErrorText(error));
      }

      try {
        return await withToolTimeout(
          (async () => {
            logger(
              `${tool.name} request: ${JSON.stringify(params, null, '  ')}`,
            );
            const requiresBrowserContext =
              tool.requiresBrowserContext ?? true;
            const toolContext = requiresBrowserContext
              ? await getContext()
              : context;
            logger(
              `${tool.name} context: ${toolContext ? 'resolved' : 'not required'}`,
            );

            // Navigation and browser-state tools must operate in CDP silence
            // except for their own explicit protocol calls.
            // Anti-bot systems detect ANY CDP activity during page load,
            // including session creation from detectOpenDevToolsWindows().
            if (
              requiresBrowserContext &&
              toolContext &&
              tool.annotations.category !== ToolCategory.NAVIGATION &&
              tool.annotations.category !== ToolCategory.BROWSER_STATE
            ) {
              await toolContext.ensureCollectorsInitialized();
              await toolContext.detectOpenDevToolsWindows();
            }
            const response = new McpResponse();
            await tool.handler(
              {
                params,
              },
              response,
              toolContext ?? NO_BROWSER_CONTEXT,
            );

            if (response.contextDetached) {
              context?.dispose();
              context = undefined;
            }

            return {
              content: await response.handle(
                tool.name,
                toolContext ?? NO_BROWSER_CONTEXT,
              ),
            };
          })(),
          DEFAULT_TOOL_TIMEOUT_MS,
          tool.name,
        );
      } catch (err) {
        const errorText = getErrorText(err);
        logger(`${tool.name} error: ${errorText}`);
        return errorResult(errorText);
      } finally {
        guard.dispose();
      }
    },
  );
}

const tools = [
  ...Object.values(batchTools),
  ...Object.values(cloakCompatTools),
  ...Object.values(consoleTools),
  ...Object.values(debuggerTools),
  ...Object.values(frameTools),
  ...Object.values(networkTools),
  ...Object.values(pagesTools),
  ...Object.values(screenshotTools),
  ...Object.values(scriptTools),
  ...Object.values(siteDataTools),

  ...Object.values(websocketTools),
].filter((tool): tool is ToolDefinition => {
  return (
    typeof tool === 'object' &&
    tool !== null &&
    'name' in tool &&
    'handler' in tool &&
    'schema' in tool &&
    'annotations' in tool
  );
});

tools.sort((a, b) => {
  return a.name.localeCompare(b.name);
});

let shuttingDown = false;

function requestShutdown(reason: string, exitCode: number): void {
  void shutdown(reason, exitCode);
}

async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger(`Shutdown requested: ${reason}`);

  await withShutdownTimeout(
    (async () => {
      context?.dispose();
      context = undefined;

      await closeBrowser(reason);

      await server.close().catch(error => {
        logger('Failed to close MCP server during shutdown', error);
      });

      await closeLogFile();
    })(),
    reason,
  );

  process.exit(exitCode);
}

async function withShutdownTimeout(
  promise: Promise<void>,
  reason: string,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>(resolve => {
    timeoutId = setTimeout(() => {
      logger(
        `Shutdown cleanup timed out after ${SHUTDOWN_TIMEOUT_MS}ms: ${reason}`,
      );
      resolve();
    }, SHUTDOWN_TIMEOUT_MS);
  });

  await Promise.race([promise, timeout]);
  if (timeoutId) {
    clearTimeout(timeoutId);
  }
}

function closeLogFile(): Promise<void> {
  if (!logFile || logFile.destroyed || logFile.writableEnded) {
    return Promise.resolve();
  }

  return new Promise(resolve => {
    logFile.end(resolve);
  });
}

function getStreamErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

process.on('SIGINT', () => requestShutdown('SIGINT', 130));
process.on('SIGTERM', () => requestShutdown('SIGTERM', 143));
process.on('SIGHUP', () => requestShutdown('SIGHUP', 129));
process.on('disconnect', () => requestShutdown('process disconnect', 0));

process.stdin.on('end', () => requestShutdown('stdin end', 0));
process.stdin.on('close', () => requestShutdown('stdin close', 0));
process.stdin.on('error', error => {
  requestShutdown(`stdin error: ${getErrorText(error)}`, 1);
});

process.stdout.on('error', error => {
  const code = getStreamErrorCode(error);
  requestShutdown(
    code === 'EPIPE' || code === 'ECONNRESET'
      ? `stdout ${code}`
      : `stdout error: ${getErrorText(error)}`,
    code === 'EPIPE' || code === 'ECONNRESET' ? 0 : 1,
  );
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
