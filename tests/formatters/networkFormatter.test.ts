/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  exportNetworkRequestPart,
  getFormattedHeaderEntries,
  getFormattedResponseBody,
  getFormattedSetCookieEntries,
  getSetCookieFlowValues,
  getShortDescriptionForRequestAsync,
  getStatusFromRequestAsync,
  headersContainSensitiveValues,
} from '../../src/formatters/networkFormatter.js';
import {responseBodyCacheSymbol} from '../../src/PageCollector.js';
import type {CachedResponseBody} from '../../src/PageCollector.js';
import type {
  HTTPRequest,
  Response as HTTPResponse,
} from '../../src/third_party/index.js';

test('redacts sensitive inline header values', () => {
  const lines = getFormattedHeaderEntries([
    {name: 'Accept', value: 'application/json'},
    {name: 'Cookie', value: 'sid=abc; theme=light'},
    {name: 'Authorization', value: 'Bearer abc.def'},
    {name: 'X-CSRF-Token', value: 'secret'},
  ]);

  assert.deepEqual(lines, [
    '- Accept:application/json',
    '- Cookie:<redacted cookie header; names: sid, theme; 20 chars>',
    '- Authorization:<redacted authorization; scheme: Bearer; 14 chars>',
    '- X-CSRF-Token:<redacted sensitive header; 6 chars>',
  ]);
});

test('keeps exact header values when redaction is disabled', () => {
  const lines = getFormattedHeaderEntries(
    [{name: 'Authorization', value: 'Bearer abc.def'}],
    {redactSensitiveValues: false},
  );

  assert.deepEqual(lines, ['- Authorization:Bearer abc.def']);
});

test('does not treat Set-Cookie as a redacted generic header', () => {
  assert.equal(
    headersContainSensitiveValues([{name: 'Set-Cookie', value: 'sid=abc'}]),
    false,
  );
});

test('formats Set-Cookie entries as name=value and omits long values', () => {
  const longValue = 'x'.repeat(513);

  assert.deepEqual(
    getFormattedSetCookieEntries([
      'sid=abc123; Path=/; HttpOnly',
      `risk=${longValue}; Path=/; Secure`,
    ]),
    ['2 entries', '- sid=abc123', '- risk=<omitted; value length 513 chars>'],
  );
});

test('extracts target Set-Cookie flow values from response headers only', async () => {
  const longValue = 'x'.repeat(513);
  const request = createCookieRequest({
    requestCookie: '_abck=request-value; theme=light',
    setCookieHeaders: [
      '_abck=first; Path=/',
      'sid=def; Path=/',
      `_abck=${longValue}; Path=/; Secure`,
    ],
  });

  assert.deepEqual(await getSetCookieFlowValues(request, '_abck'), [
    '_abck=first',
    '_abck=<omitted; value length 513 chars>',
  ]);
  assert.deepEqual(await getSetCookieFlowValues(request, 'theme'), []);
});

test('formats pending request list entries without waiting for a response', async () => {
  const request = createPendingRequest();

  assert.equal(
    await getShortDescriptionForRequestAsync(request, 7, false, true),
    'reqid=7 [time unavailable, pending] [xhr] POST https://example.test/api?a=1 [pending: resume execution before reading response data]',
  );
});

test('formats pending request status without waiting for a response', async () => {
  const request = createPendingRequest();

  assert.equal(
    await getStatusFromRequestAsync(request),
    '[pending: resume execution before reading response data]',
  );
});

test('rejects pending response exports without waiting for a response', async () => {
  const request = createPendingRequest();

  await assert.rejects(
    () => exportNetworkRequestPart(request, 'responseHeaders'),
    /Request is pending/,
  );
  await assert.rejects(
    () => exportNetworkRequestPart(request, 'responseBody'),
    /Request is pending/,
  );
  await assert.rejects(
    () => exportNetworkRequestPart(request, 'all'),
    /Request is pending/,
  );
});

test('rejects an unknown outputPart instead of returning undefined', async () => {
  // Guards against the "Cannot read properties of undefined (reading 'data')"
  // failure when outputPart arrives undefined and the switch falls through.
  const request = createPendingRequest();

  await assert.rejects(
    () =>
      exportNetworkRequestPart(
        request,
        'bogus' as Parameters<typeof exportNetworkRequestPart>[1],
      ),
    /Unknown outputPart/,
  );
});

test('allows pending request-side exports', async () => {
  const request = createPendingRequest();

  const requestBody = await exportNetworkRequestPart(request, 'requestBody');
  assert.equal(Buffer.from(requestBody.data).toString('utf8'), 'hello=world');

  const queryParams = await exportNetworkRequestPart(request, 'queryParams');
  assert.match(Buffer.from(queryParams.data).toString('utf8'), /"a": "1"/);
});

test('reads the eagerly cached body after the live body was evicted', async () => {
  // body() throws to simulate the browser evicting the body after navigation;
  // the cache captured at requestfinished time must still serve it.
  const response = createFinishedResponse({
    bodyThrows: true,
    contentType: 'application/json',
    cache: {ok: true, buffer: Buffer.from('{"token":"abc"}')},
  });

  const out = await getFormattedResponseBody(response);
  assert.ok(out);
  assert.match(out, /"token":"abc"/);
});

test('reports body eviction when neither cache nor live body is available', async () => {
  const response = createFinishedResponse({bodyThrows: true});

  assert.equal(
    await getFormattedResponseBody(response),
    '<not available anymore — body evicted after navigation>',
  );
});

test('explains skipped-cache fallback when the body was too large to cache', async () => {
  const response = createFinishedResponse({
    bodyThrows: true,
    cache: {ok: 'skipped', reason: 'body 9000000 bytes exceeds cache limit'},
  });

  const out = await getFormattedResponseBody(response);
  assert.ok(out);
  assert.match(out, /not cached/);
  assert.match(out, /export with outputFile/);
});

test('falls back to a live body fetch when nothing was cached', async () => {
  const response = createFinishedResponse({
    bodyBuffer: Buffer.from('hello world'),
    contentType: 'text/plain',
  });

  const out = await getFormattedResponseBody(response);
  assert.ok(out);
  assert.match(out, /hello world/);
});

function createFinishedResponse(opts: {
  bodyBuffer?: Buffer;
  bodyThrows?: boolean;
  contentType?: string;
  cache?: CachedResponseBody;
}): HTTPResponse {
  const request = {
    failure: () => null,
  } as unknown as HTTPRequest & {
    response: () => Promise<HTTPResponse>;
    [responseBodyCacheSymbol]?: Promise<CachedResponseBody>;
  };

  const response = {
    request: () => request,
    status: () => 200,
    headers: () => ({
      'content-type': opts.contentType ?? 'application/json',
    }),
    body: async () => {
      if (opts.bodyThrows) {
        throw new Error('No resource with given identifier found');
      }
      return opts.bodyBuffer ?? Buffer.from('');
    },
  } as unknown as HTTPResponse;

  request.response = async () => response;
  if (opts.cache) {
    request[responseBodyCacheSymbol] = Promise.resolve(opts.cache);
  }

  return response;
}

function createPendingRequest(): HTTPRequest {
  return {
    failure: () => null,
    method: () => 'POST',
    postData: () => 'hello=world',
    postDataBuffer: () => Buffer.from('hello=world'),
    resourceType: () => 'xhr',
    response: () => {
      throw new Error('response() should not be called for pending requests');
    },
    timing: () => ({
      startTime: -1,
      domainLookupStart: -1,
      domainLookupEnd: -1,
      connectStart: -1,
      secureConnectionStart: -1,
      connectEnd: -1,
      requestStart: -1,
      responseStart: -1,
      responseEnd: -1,
    }),
    url: () => 'https://example.test/api?a=1',
  } as unknown as HTTPRequest;
}

function createCookieRequest(opts: {
  requestCookie?: string;
  setCookieHeaders?: string[];
}): HTTPRequest {
  const requestHeaders = opts.requestCookie
    ? [{name: 'Cookie', value: opts.requestCookie}]
    : [];
  const responseHeaders = (opts.setCookieHeaders ?? []).map(value => ({
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
    headers: () => (opts.requestCookie ? {cookie: opts.requestCookie} : {}),
    headersArray: async () => requestHeaders,
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
    url: () => 'https://example.test/api',
  } as unknown as HTTPRequest;
}
