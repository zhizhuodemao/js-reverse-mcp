/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ToolCategory} from './categories.js';
import {defineTool} from './ToolDefinition.js';

const MAX_SUMMARY_ITEMS = 8;

function summarizeValues(values: string[]): string {
  const uniqueValues = [...new Set(values)].sort();
  if (uniqueValues.length === 0) {
    return 'none';
  }

  const visibleValues = uniqueValues.slice(0, MAX_SUMMARY_ITEMS);
  const remaining = uniqueValues.length - visibleValues.length;
  if (remaining <= 0) {
    return visibleValues.join(', ');
  }

  return `${visibleValues.join(', ')}, ... and ${remaining} more`;
}

export const clearSiteData = defineTool({
  name: 'clear_site_data',
  description: `Clear browser state to create a clean replay environment for the currently selected page. This clears all cookies for all sites and pages sharing the current browser context, clears browser HTTP cache, clears all persistent storage for the selected page's origin, and clears current page sessionStorage. This tool does not reload the page. Cookie cleanup is browser-context-wide; non-cookie storage cleanup is scoped to the selected page origin.`,
  annotations: {
    category: ToolCategory.BROWSER_STATE,
    readOnlyHint: false,
  },
  schema: {},
  handler: async (_request, response, context) => {
    const page = context.getSelectedPage();
    const pageUrl = page.url();
    const url = new URL(pageUrl);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(
        `clear_site_data requires an http(s) selected page. Current URL is ${pageUrl}. Navigate to the target site first.`,
      );
    }

    const browserContext = page.context();
    const warnings: string[] = [];
    let cookieCount: number | undefined;
    let cookieDomains: string[] = [];
    let cookieNames: string[] = [];
    let cookiesStatus = 'failed';
    let browserCacheStatus = 'failed';
    let originStorageStatus = 'failed';
    let sessionStorageStatus = 'failed';

    try {
      const cookies = await browserContext.cookies();
      cookieCount = cookies.length;
      cookieDomains = cookies.map(cookie => cookie.domain);
      cookieNames = cookies.map(cookie => cookie.name);
    } catch (error) {
      warnings.push(
        `Failed to inspect cookies before clearing: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      await browserContext.clearCookies();
      cookiesStatus =
        cookieCount === undefined ? 'yes (count unavailable)' : 'yes';
    } catch (error) {
      warnings.push(
        `Failed to clear cookies: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const session = await browserContext.newCDPSession(page).catch(error => {
      warnings.push(
        `Failed to create CDP session for cache/origin storage cleanup: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    });

    if (session) {
      try {
        await session.send('Network.clearBrowserCache');
        browserCacheStatus = 'yes';
      } catch (error) {
        warnings.push(
          `Failed to clear browser HTTP cache: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      try {
        await session.send('Storage.clearDataForOrigin', {
          origin: url.origin,
          storageTypes: 'all',
        });
        originStorageStatus = 'yes (Storage.clearDataForOrigin all)';
      } catch (error) {
        warnings.push(
          `Failed to clear origin storage for ${url.origin}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        await session.detach().catch(error => {
          warnings.push(
            `Failed to detach CDP session: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
    }

    try {
      await page.evaluate(() => {
        sessionStorage.clear();
      });
      sessionStorageStatus = 'yes';
    } catch (error) {
      warnings.push(
        `Failed to clear current page sessionStorage: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    response.appendResponseLine(
      `Browser state cleanup completed for ${url.origin}`,
    );
    response.appendResponseLine(`URL: ${pageUrl}`);
    response.appendResponseLine(`Cookies cleared: ${cookiesStatus}`);
    response.appendResponseLine(
      `Cookies found before clearing: ${cookieCount ?? 'unknown'}`,
    );
    response.appendResponseLine(
      `Cookie domains: ${summarizeValues(cookieDomains)}`,
    );
    response.appendResponseLine(
      `Cookie names: ${summarizeValues(cookieNames)}`,
    );
    response.appendResponseLine(
      `Browser HTTP cache cleared: ${browserCacheStatus}`,
    );
    response.appendResponseLine(
      `Origin storage cleared: ${originStorageStatus}`,
    );
    response.appendResponseLine(
      `Session storage cleared: ${sessionStorageStatus}`,
    );

    response.appendResponseLine(`Warnings:`);
    if (!warnings.length) {
      response.appendResponseLine(`none`);
    }
    for (const warning of warnings) {
      response.appendResponseLine(`- ${warning}`);
    }

    response.appendResponseLine(
      'The page was not reloaded. Use navigate_page({type:"reload"}) to replay cookie generation.',
    );
  },
});
