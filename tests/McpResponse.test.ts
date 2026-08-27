/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import type {McpContext} from '../src/McpContext.js';
import {McpResponse} from '../src/McpResponse.js';
import type {
  HTTPRequest,
  Response as HTTPResponse,
} from '../src/third_party/index.js';

test('formats a detached response without reading the closed browser context', async () => {
  const context = new Proxy(
    {},
    {
      get: () => {
        throw new Error('closed context must not be read');
      },
    },
  ) as McpContext;
  const response = new McpResponse();
  response.appendResponseLine('browser switched');
  response.setContextDetached(true);

  assert.equal(response.contextDetached, true);
  const result = await response.handle('launch_browser', context);

  assert.deepEqual(result, [
    {
      type: 'text',
      text: '# launch_browser response\nbrowser switched',
    },
  ]);
});

test('formats cookieName as complete Set-Cookie flow without pagination', async () => {
  const first = createCookieRequest({
    url: 'https://example.test/first',
    setCookieHeaders: ['_abck=first; Path=/'],
  });
  const unrelated = createCookieRequest({
    url: 'https://example.test/other',
    setCookieHeaders: ['sid=abc; Path=/'],
  });
  const latest = createCookieRequest({
    url: 'https://example.test/latest',
    setCookieHeaders: ['_abck=latest; Path=/'],
  });
  const ids = new Map<HTTPRequest, number>([
    [first, 23],
    [unrelated, 24],
    [latest, 88],
  ]);
  const context = {
    getCpuThrottlingRate: () => 1,
    getNetworkConditions: () => '',
    getNetworkRequests: () => [first, unrelated, latest],
    getNetworkRequestStableId: (request: HTTPRequest) => ids.get(request) ?? 0,
  } as unknown as McpContext;

  const response = new McpResponse();
  response.setIncludeNetworkRequests(true, {
    cookieName: '_abck',
    pageSize: 1,
  });

  const result = await response.format('list_network_requests', context, {
    bodies: {},
    consoleData: undefined,
    consoleListData: undefined,
  });
  assert.equal(result[0].type, 'text');
  const text = result[0].text;

  assert.match(text, /## Set-Cookie flow for _abck/);
  assert.match(text, /Matched response Set-Cookie updates, oldest first\./);
  assert.match(
    text,
    /Pagination ignored: Set-Cookie flow shows all matching updates in the current captured queue\./,
  );
  assert.doesNotMatch(text, /Showing 1-1/);
  assert.match(text, /\[23\] 200 GET https:\/\/example\.test\/first/);
  assert.match(text, /set-cookie: _abck=first/);
  assert.doesNotMatch(text, /sid=abc/);
  assert.match(text, /\[88\] 200 GET https:\/\/example\.test\/latest/);
  assert.match(text, /set-cookie: _abck=latest/);
  assert.ok(
    text.indexOf('https://example.test/first') <
      text.indexOf('https://example.test/latest'),
  );
});

function createCookieRequest(opts: {
  url: string;
  setCookieHeaders: string[];
}): HTTPRequest {
  const responseHeaders = opts.setCookieHeaders.map(value => ({
    name: 'Set-Cookie',
    value,
  }));

  const response = {
    headers: () => ({}),
    headersArray: async () => responseHeaders,
    status: () => 200,
    statusText: () => 'OK',
  } as unknown as HTTPResponse;

  return {
    failure: () => null,
    headers: () => ({}),
    headersArray: async () => [],
    method: () => 'GET',
    resourceType: () => 'xhr',
    response: async () => response,
    timing: () => ({
      startTime: 0,
      domainLookupStart: -1,
      domainLookupEnd: -1,
      connectStart: -1,
      secureConnectionStart: -1,
      connectEnd: -1,
      requestStart: 1,
      responseStart: 2,
      responseEnd: 3,
    }),
    url: () => opts.url,
  } as unknown as HTTPRequest;
}
