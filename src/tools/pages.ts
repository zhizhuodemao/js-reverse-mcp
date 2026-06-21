/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {defineTool, timeoutSchema} from './ToolDefinition.js';

// Default navigation timeout in milliseconds (10 seconds)
const DEFAULT_NAV_TIMEOUT = 10000;
const PAUSE_POLL_INTERVAL_MS = 50;

export type NavigationWaitResult =
  | {status: 'completed'}
  | {status: 'paused'}
  | {status: 'error'; error: unknown};

interface PauseStateReader {
  isEnabled(): boolean;
  isPaused(): boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitForNavigationOrPause(
  navigation: Promise<unknown>,
  debugger_: PauseStateReader,
): Promise<NavigationWaitResult> {
  const navigationResult = navigation.then(
    () => ({status: 'completed'}) as const,
    error => ({status: 'error', error}) as const,
  );

  if (!debugger_.isEnabled()) {
    return navigationResult;
  }

  let stopped = false;
  const pauseResult = (async (): Promise<NavigationWaitResult> => {
    while (!stopped) {
      if (debugger_.isPaused()) {
        return {status: 'paused'};
      }
      await delay(PAUSE_POLL_INTERVAL_MS);
    }
    return {status: 'completed'};
  })();

  const result = await Promise.race([navigationResult, pauseResult]);
  stopped = true;
  return result;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const selectPage = defineTool({
  name: 'select_page',
  description: `Lists all open pages in the browser. Pass pageIdx to select a page as context for future tool calls.`,
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: false,
  },
  schema: {
    pageIdx: zod
      .number()
      .optional()
      .describe(
        'The index of the page to select. If omitted, lists all pages without changing selection.',
      ),
  },
  handler: async (request, response, context) => {
    if (request.params.pageIdx === undefined) {
      // List mode
      response.setIncludePages(true);
      return;
    }

    // Select mode
    const page = context.getPageByIdx(request.params.pageIdx);
    await page.bringToFront();
    context.selectPage(page);
    response.setIncludePages(true);
  },
});

// Default referer for anti-detection (matches Scrapling's google_search=True behavior)
const DEFAULT_REFERER = 'https://www.google.com/';

export const newPage = defineTool({
  name: 'new_page',
  description: `Opens a browser page and navigates to the specified URL. If an existing about:blank startup tab is still available, it is reused instead of opening an extra tab. Waits for DOMContentLoaded event (not full page load). Default timeout is 10 seconds.`,
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: false,
  },
  schema: {
    url: zod.string().describe('URL to load in the opened browser page.'),
    ...timeoutSchema,
  },
  handler: async (request, response, context) => {
    // launchPersistentContext opens an initial about:blank tab on startup.
    // If a blank tab is still around (either the startup one or an explicitly
    // requested one), navigate it in place instead of opening another tab —
    // avoids the "two about:blank" UX on first MCP tool call.
    const existingBlank = context
      .getPages()
      .find(p => p.url() === 'about:blank');
    const page = existingBlank ?? (await context.newPage());
    if (existingBlank) {
      context.selectPage(existingBlank);
    }

    // Use plain goto without waitForEventsAfterAction to avoid creating
    // a CDP session during navigation. Anti-bot systems detect the extra
    // CDP session that WaitForHelper creates (Page.frameStartedNavigating listener).
    await page.goto(request.params.url, {
      timeout: request.params.timeout ?? DEFAULT_NAV_TIMEOUT,
      waitUntil: 'domcontentloaded',
      referer: DEFAULT_REFERER,
    });

    response.setIncludePages(true);
  },
});

export const navigatePage = defineTool({
  name: 'navigate_page',
  description: `Navigates the currently selected page to a URL, or performs back/forward/reload navigation. This tool only navigates; it does not clear cookies, storage, cache, or site data. Waits for DOMContentLoaded event (not full page load). Default timeout is 10 seconds. After navigation, stale script IDs are cleared and fresh ones are captured automatically when the debugger is enabled. Tracked code URL breakpoints and XHR/Fetch breakpoints are restored across navigation when possible.`,
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: false,
  },
  schema: {
    type: zod
      .enum(['url', 'back', 'forward', 'reload'])
      .optional()
      .describe(
        'Navigate the page by URL, back or forward in history, or reload.',
      ),
    url: zod.string().optional().describe('Target URL (only type=url)'),
    ...timeoutSchema,
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    const options = {
      timeout: request.params.timeout ?? DEFAULT_NAV_TIMEOUT,
    };

    if (!request.params.type && !request.params.url) {
      throw new Error('Either URL or a type is required.');
    }

    if (!request.params.type) {
      request.params.type = 'url';
    }

    const debugger_ = context.debuggerContext;

    // Clear stale script IDs BEFORE navigation. The scriptParsed listener
    // remains active and will capture new scripts as the page loads.
    // We intentionally do NOT call reinitDebugger() here — that would send
    // Debugger.disable which wipes ALL breakpoints (URL, XHR, DOM) and
    // implicitly resumes paused state. clearScripts() only clears cached
    // script IDs without touching the debugger or breakpoints.
    //
    // Note: Debugger.setBreakpointByUrl breakpoints survive navigation, but
    // DOMDebugger XHR breakpoints are reset by Chrome on navigation — we
    // restore them after navigation completes.
    if (debugger_.isEnabled()) {
      debugger_.clearScripts();
    }

    // Use plain navigation without waitForEventsAfterAction to avoid creating
    // a CDP session during navigation. Anti-bot systems detect the extra
    // CDP session that WaitForHelper creates (Page.frameStartedNavigating listener).
    let navigationCompleted = false;

    switch (request.params.type) {
      case 'url':
        if (!request.params.url) {
          throw new Error('A URL is required for navigation of type=url.');
        }
        {
          const result = await waitForNavigationOrPause(
            page.goto(request.params.url, {
              ...options,
              waitUntil: 'domcontentloaded',
              referer: DEFAULT_REFERER,
            }),
            debugger_,
          );
          if (result.status === 'completed') {
            navigationCompleted = true;
            response.appendResponseLine(
              `Successfully navigated to ${request.params.url}.`,
            );
            response.appendResponseLine(
              'Note: Any previously obtained script IDs are now invalid. Use script URLs instead.',
            );
          } else if (result.status === 'paused' || debugger_.isPaused()) {
            response.appendResponseLine(
              `Navigation to ${request.params.url} started but execution is paused at a breakpoint. Use get_paused_info to inspect, then resume to continue loading.`,
            );
          } else {
            response.appendResponseLine(
              `Unable to navigate in the selected page: ${getErrorMessage(result.error)}.`,
            );
          }
        }
        break;
      case 'back':
        {
          const result = await waitForNavigationOrPause(
            page.goBack({
              ...options,
              waitUntil: 'domcontentloaded',
            }),
            debugger_,
          );
          if (result.status === 'completed') {
            navigationCompleted = true;
            response.appendResponseLine(
              `Successfully navigated back to ${page.url()}.`,
            );
            response.appendResponseLine(
              'Note: Any previously obtained script IDs are now invalid. Use script URLs instead.',
            );
          } else if (result.status === 'paused' || debugger_.isPaused()) {
            response.appendResponseLine(
              `Navigation back started but execution is paused at a breakpoint. Use get_paused_info to inspect, then resume to continue loading.`,
            );
          } else {
            response.appendResponseLine(
              `Unable to navigate back in the selected page: ${getErrorMessage(result.error)}.`,
            );
          }
        }
        break;
      case 'forward':
        {
          const result = await waitForNavigationOrPause(
            page.goForward({
              ...options,
              waitUntil: 'domcontentloaded',
            }),
            debugger_,
          );
          if (result.status === 'completed') {
            navigationCompleted = true;
            response.appendResponseLine(
              `Successfully navigated forward to ${page.url()}.`,
            );
            response.appendResponseLine(
              'Note: Any previously obtained script IDs are now invalid. Use script URLs instead.',
            );
          } else if (result.status === 'paused' || debugger_.isPaused()) {
            response.appendResponseLine(
              `Navigation forward started but execution is paused at a breakpoint. Use get_paused_info to inspect, then resume to continue loading.`,
            );
          } else {
            response.appendResponseLine(
              `Unable to navigate forward in the selected page: ${getErrorMessage(result.error)}.`,
            );
          }
        }
        break;
      case 'reload':
        {
          const result = await waitForNavigationOrPause(
            page.reload({
              ...options,
              waitUntil: 'domcontentloaded',
            }),
            debugger_,
          );
          if (result.status === 'completed') {
            navigationCompleted = true;
            response.appendResponseLine(`Successfully reloaded the page.`);
            response.appendResponseLine(
              'Note: Any previously obtained script IDs are now invalid. Use script URLs instead.',
            );
          } else if (result.status === 'paused' || debugger_.isPaused()) {
            response.appendResponseLine(
              `Page reload started but execution is paused at a breakpoint. Use get_paused_info to inspect, then resume to continue loading.`,
            );
          } else {
            response.appendResponseLine(
              `Unable to reload the selected page: ${getErrorMessage(result.error)}.`,
            );
          }
        }
        break;
    }

    // Restore XHR breakpoints after navigation — Chrome resets
    // DOMDebugger state on page navigation.
    if (navigationCompleted && debugger_.isEnabled()) {
      await debugger_.restoreXHRBreakpoints();
    }

    response.setIncludePages(true);
  },
});
