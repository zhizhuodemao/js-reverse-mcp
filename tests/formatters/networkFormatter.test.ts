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
  getShortDescriptionForRequestAsync,
  getStatusFromRequestAsync,
  headersContainSensitiveValues,
} from '../../src/formatters/networkFormatter.js';
import type {HTTPRequest} from '../../src/third_party/index.js';

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

test('allows pending request-side exports', async () => {
  const request = createPendingRequest();

  const requestBody = await exportNetworkRequestPart(request, 'requestBody');
  assert.equal(Buffer.from(requestBody.data).toString('utf8'), 'hello=world');

  const queryParams = await exportNetworkRequestPart(request, 'queryParams');
  assert.match(Buffer.from(queryParams.data).toString('utf8'), /"a": "1"/);
});

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
