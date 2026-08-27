/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {zod} from '../third_party/index.js';
import type {Page} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {defineTool, timeoutSchema} from './ToolDefinition.js';

const DEFAULT_NAV_TIMEOUT = 10000;
const DEFAULT_SETTLE_MS = 1500;
const DEFAULT_PATTERN = '2\\.41\\.\\d+-r\\.[A-Za-z0-9]+\\.js';
const DEFAULT_REFERER = 'https://www.google.com/';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractMatches(urls: Iterable<string>, pattern: string): string[] {
  const regex = new RegExp(pattern, 'g');
  const matches = new Set<string>();

  for (const url of urls) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(url)) !== null) {
      matches.add(match[1] ?? match[0]);
      if (match[0].length === 0) {
        regex.lastIndex += 1;
      }
    }
  }

  return [...matches];
}

async function collectBrowserSideUrls(page: Page): Promise<string[]> {
  try {
    return await page.evaluate(() => {
      const values: string[] = [];

      for (const frame of window.frames as unknown as Window[]) {
        try {
          if (frame.location?.href) values.push(frame.location.href);
        } catch {
          // Cross-origin frame.
        }
      }

      for (const script of Array.from(document.scripts)) {
        if (script.src) values.push(script.src);
      }

      for (const entry of performance.getEntriesByType('resource')) {
        if (entry.name) values.push(entry.name);
      }

      return values;
    });
  } catch {
    return [];
  }
}

export const openPagesAndExtractScriptNames = defineTool({
  name: 'open_pages_and_extract_script_names',
  description:
    'Open multiple URLs in parallel tabs and extract script-like filename matches from each page without selecting tabs one by one. It listens to request/response URLs during navigation, then scans document scripts and performance resource entries after a short settle window.',
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: false,
  },
  schema: {
    urls: zod
      .array(zod.string())
      .min(1)
      .describe('Absolute URLs to open concurrently, one tab per URL.'),
    pattern: zod
      .string()
      .optional()
      .describe(
        `JavaScript regular expression used to extract names from URLs. Defaults to ${DEFAULT_PATTERN}. Use one capture group to return only part of the match.`,
      ),
    settleMs: zod
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Milliseconds to wait after DOMContentLoaded before scanning page-side resource lists. Defaults to 1500.',
      ),
    closePages: zod
      .boolean()
      .optional()
      .describe(
        'Close pages after extraction. Defaults to false so results can be inspected afterward.',
      ),
    ...timeoutSchema,
  },
  handler: async (request, response, context) => {
    const pattern = request.params.pattern ?? DEFAULT_PATTERN;
    try {
      new RegExp(pattern);
    } catch (error) {
      throw new Error(
        `Invalid pattern: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const timeout = request.params.timeout ?? DEFAULT_NAV_TIMEOUT;
    const settleMs = request.params.settleMs ?? DEFAULT_SETTLE_MS;
    const pages = await Promise.all(request.params.urls.map(() => context.newPage()));

    const byPage = await Promise.all(
      pages.map(async (page, index) => {
        const inputUrl = request.params.urls[index];
        const seenUrls = new Set<string>();
        const remember = (item: {url(): string} | string) => {
          try {
            const url = typeof item === 'string' ? item : item.url();
            if (url) seenUrls.add(url);
          } catch {
            // Ignore transient request/response objects.
          }
        };

        page.on('request', remember);
        page.on('response', remember);

        let error: string | null = null;
        try {
          await page.goto(inputUrl, {
            timeout,
            waitUntil: 'domcontentloaded',
            referer: DEFAULT_REFERER,
          });
          if (settleMs > 0) {
            await delay(settleMs);
          }
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }

        for (const frame of page.frames()) {
          try {
            remember(frame.url());
          } catch {
            // Ignore detached frames.
          }
        }
        for (const url of await collectBrowserSideUrls(page)) {
          remember(url);
        }

        const matchedFiles = extractMatches(seenUrls, pattern);
        page.off('request', remember);
        page.off('response', remember);

        const finalUrl = page.isClosed() ? null : page.url();
        if (request.params.closePages && !page.isClosed()) {
          await page.close({runBeforeUnload: false}).catch(() => undefined);
        }

        return {inputUrl, finalUrl, matchedFiles, error};
      }),
    );

    const unique = [...new Set(byPage.flatMap(result => result.matchedFiles))];
    const payload = {unique, byPage};

    response.appendResponseLine(
      `Extracted ${unique.length} unique script name(s) from ${byPage.length} page(s).`,
    );
    response.appendResponseLine(JSON.stringify(payload, null, 2));
    response.setIncludePages(true);
  },
});
