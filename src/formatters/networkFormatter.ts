/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isUtf8} from 'node:buffer';

import type {HTTPRequest, HTTPResponse} from '../third_party/index.js';

const BODY_CONTEXT_SIZE_LIMIT = 10000;
const BODY_FETCH_TIMEOUT_MS = 5000;
const LONG_URL_LIMIT = 2000;
const LONG_QUERY_LIMIT = 1000;
const LARGE_REQUEST_BODY_LIMIT = 8192;

export type NetworkExportPart =
  | 'all'
  | 'responseBody'
  | 'requestBody'
  | 'queryParams';

interface QueryPayload {
  queryString: string;
  params: Record<string, string | string[]>;
  entries: Array<{name: string; value: string}>;
}

type BodySnapshot =
  | {
      available: true;
      size: number;
      encoding: 'utf8';
      text: string;
    }
  | {
      available: true;
      size: number;
      encoding: 'base64';
      base64: string;
    }
  | {
      available: false;
      size: 0;
      reason: string;
    };

type ResponseBodyRead =
  | {
      ok: true;
      buffer: Buffer;
    }
  | {
      ok: false;
      error: string;
    };

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Timed out fetching body')), ms),
    ),
  ]);
}

export function getShortDescriptionForRequest(
  request: HTTPRequest,
  id: number,
  selectedInDevToolsUI = false,
): string {
  return `reqid=${id} [${request.resourceType()}] ${request.method()} ${request.url()} ${getStatusFromRequest(request)}${selectedInDevToolsUI ? ` [selected in the DevTools Network panel]` : ''}`;
}

export async function getShortDescriptionForRequestAsync(
  request: HTTPRequest,
  id: number,
  selectedInDevToolsUI = false,
): Promise<string> {
  const status = await getStatusFromRequestAsync(request);
  return `reqid=${id} [${request.resourceType()}] ${request.method()} ${request.url()} ${status}${selectedInDevToolsUI ? ` [selected in the DevTools Network panel]` : ''}`;
}

export function getStatusFromRequest(request: HTTPRequest): string {
  // In Playwright, request.response() is async, but we cache the failure info
  const failure = request.failure();
  if (failure) {
    return `[failed - ${failure.errorText}]`;
  }
  // We can't synchronously get the response in Playwright.
  // Return pending for now - the detailed view will show the response.
  return '[pending]';
}

export async function getStatusFromRequestAsync(
  request: HTTPRequest,
): Promise<string> {
  const httpResponse = await request.response();
  const failure = request.failure();
  let status: string;
  if (httpResponse) {
    const responseStatus = httpResponse.status();
    status =
      responseStatus >= 200 && responseStatus <= 299
        ? `[success - ${responseStatus}]`
        : `[failed - ${responseStatus}]`;
  } else if (failure) {
    status = `[failed - ${failure.errorText}]`;
  } else {
    status = '[pending]';
  }
  return status;
}

export function getFormattedHeaderValue(
  headers: Record<string, string>,
): string[] {
  const response: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    response.push(`- ${name}:${value}`);
  }
  return response;
}

export async function getFormattedResponseBody(
  httpResponse: HTTPResponse,
  sizeLimit = BODY_CONTEXT_SIZE_LIMIT,
): Promise<string | undefined> {
  try {
    const responseBuffer = await withTimeout(
      httpResponse.body(),
      BODY_FETCH_TIMEOUT_MS,
    );

    if (isUtf8(responseBuffer)) {
      const responseAsTest = responseBuffer.toString('utf-8');

      if (responseAsTest.length === 0) {
        return `<empty response>`;
      }

      return `${getSizeLimitedString(responseAsTest, sizeLimit)}`;
    }

    return `<binary data>`;
  } catch {
    return `<not available anymore>`;
  }
}

export async function getFormattedRequestBody(
  httpRequest: HTTPRequest,
  sizeLimit: number = BODY_CONTEXT_SIZE_LIMIT,
): Promise<string | undefined> {
  // In Playwright, postData() returns null|string synchronously
  const data = httpRequest.postData();

  if (data) {
    return `${getSizeLimitedString(data, sizeLimit)}`;
  }

  return;
}

export async function exportNetworkRequestPart(
  httpRequest: HTTPRequest,
  part: NetworkExportPart,
): Promise<{data: Uint8Array; summary: string}> {
  switch (part) {
    case 'responseBody': {
      const httpResponse = await httpRequest.response();
      if (!httpResponse) {
        throw new Error('No response is available for this request.');
      }
      const body = await readResponseBody(httpResponse);
      if (!body.ok) {
        throw new Error(`Response body is not available: ${body.error}`);
      }
      return {
        data: body.buffer,
        summary: `Exported response body (${body.buffer.length} bytes).`,
      };
    }
    case 'requestBody': {
      const body = getRequestBodyBuffer(httpRequest);
      const method = httpRequest.method();
      if (!body || body.length === 0) {
        return {
          data: new Uint8Array(),
          summary: `Request ${method} has no captured request body; wrote an empty file.`,
        };
      }
      return {
        data: body,
        summary: `Exported request body (${body.length} bytes).`,
      };
    }
    case 'queryParams': {
      const query = parseQueryPayload(httpRequest.url());
      const data = jsonBytes({
        url: httpRequest.url(),
        queryString: query.queryString,
        params: query.params,
        entries: query.entries,
      });
      return {
        data,
        summary: `Exported ${query.entries.length} query parameter entr${
          query.entries.length === 1 ? 'y' : 'ies'
        } (${data.length} bytes).`,
      };
    }
    case 'all': {
      const snapshot = await getNetworkRequestSnapshot(httpRequest);
      const data = jsonBytes(snapshot);
      return {
        data,
        summary: `Exported full network request snapshot (${data.length} bytes).`,
      };
    }
  }
}

export async function getNetworkRequestExportHints(
  httpRequest: HTTPRequest,
  reqid: number,
): Promise<string[]> {
  const hints: string[] = [];
  const url = httpRequest.url();
  const query = parseQueryPayload(url);
  const requestBody = getRequestBodyBuffer(httpRequest);

  if (
    url.length > LONG_URL_LIMIT ||
    query.queryString.length > LONG_QUERY_LIMIT
  ) {
    hints.push(
      `URL/query payload is large. For parsed GET-style payload data, re-run with outputPart="queryParams" and outputFile="network-req-${reqid}-query.json".`,
    );
  }

  if (requestBody && requestBody.length > LARGE_REQUEST_BODY_LIMIT) {
    hints.push(
      `Request body is ${requestBody.length} bytes. For exact request bytes, re-run with outputPart="requestBody" and outputFile="network-req-${reqid}-request-body.bin".`,
    );
  }

  const httpResponse = await httpRequest.response();
  if (httpResponse) {
    const headers = httpResponse.headers();
    const contentType = getHeaderValue(headers, 'content-type');
    const sizes = await httpRequest.sizes().catch(() => undefined);
    const responseBodySize = sizes?.responseBodySize ?? 0;

    if (isLikelyBinaryContentType(contentType)) {
      hints.push(
        `Response content-type "${contentType}" looks binary. For exact response bytes, re-run with outputPart="responseBody" and outputFile="network-req-${reqid}-response.bin".`,
      );
    } else if (responseBodySize > BODY_CONTEXT_SIZE_LIMIT) {
      hints.push(
        `Response body is ${responseBodySize} bytes. Inline output is only a preview; re-run with outputPart="responseBody" and outputFile="network-req-${reqid}-response.bin" for the full body.`,
      );
    }
  }

  return [...new Set(hints)];
}

function getSizeLimitedString(text: string, sizeLimit: number) {
  if (text.length > sizeLimit) {
    return `${text.substring(0, sizeLimit) + '... <truncated>'}`;
  }

  return `${text}`;
}

async function getNetworkRequestSnapshot(httpRequest: HTTPRequest) {
  const httpResponse = await httpRequest.response();
  const query = parseQueryPayload(httpRequest.url());
  const requestBody = bodySnapshotFromBuffer(getRequestBodyBuffer(httpRequest));
  const responseBody = httpResponse
    ? bodySnapshotFromRead(await readResponseBody(httpResponse))
    : unavailableBodySnapshot('No response is available for this request.');
  const sizes = await httpRequest.sizes().catch(() => undefined);
  const requestHeaders = await httpRequest
    .allHeaders()
    .catch(() => httpRequest.headers());
  const responseHeaders = httpResponse
    ? await httpResponse.allHeaders().catch(() => httpResponse.headers())
    : undefined;

  return {
    url: httpRequest.url(),
    method: httpRequest.method(),
    resourceType: httpRequest.resourceType(),
    status: httpResponse?.status(),
    statusText: httpResponse?.statusText(),
    failure: httpRequest.failure(),
    requestHeaders,
    responseHeaders,
    query,
    requestBody,
    responseBody,
    sizes,
    timing: httpRequest.timing(),
  };
}

async function readResponseBody(
  httpResponse: HTTPResponse,
): Promise<ResponseBodyRead> {
  try {
    return {
      ok: true,
      buffer: await withTimeout(httpResponse.body(), BODY_FETCH_TIMEOUT_MS),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function getRequestBodyBuffer(httpRequest: HTTPRequest): Buffer | undefined {
  const buffer = httpRequest.postDataBuffer();
  if (buffer) {
    return buffer;
  }

  const text = httpRequest.postData();
  if (text) {
    return Buffer.from(text, 'utf8');
  }

  return;
}

function bodySnapshotFromRead(read: ResponseBodyRead): BodySnapshot {
  if (!read.ok) {
    return unavailableBodySnapshot(read.error);
  }
  return bodySnapshotFromBuffer(read.buffer);
}

function bodySnapshotFromBuffer(buffer?: Buffer): BodySnapshot {
  if (!buffer) {
    return unavailableBodySnapshot('No body was captured.');
  }

  if (isUtf8(buffer)) {
    return {
      available: true,
      size: buffer.length,
      encoding: 'utf8',
      text: buffer.toString('utf8'),
    };
  }

  return {
    available: true,
    size: buffer.length,
    encoding: 'base64',
    base64: buffer.toString('base64'),
  };
}

function unavailableBodySnapshot(reason: string): BodySnapshot {
  return {
    available: false,
    size: 0,
    reason,
  };
}

function parseQueryPayload(urlString: string): QueryPayload {
  try {
    const url = new URL(urlString);
    const params: Record<string, string | string[]> = {};
    const entries: Array<{name: string; value: string}> = [];

    for (const [name, value] of url.searchParams) {
      entries.push({name, value});
      const existing = params[name];
      if (existing === undefined) {
        params[name] = value;
      } else if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        params[name] = [existing, value];
      }
    }

    return {
      queryString: url.search.length ? url.search.slice(1) : '',
      params,
      entries,
    };
  } catch {
    return {
      queryString: '',
      params: {},
      entries: [],
    };
  }
}

function getHeaderValue(
  headers: Record<string, string> | undefined,
  name: string,
): string {
  if (!headers) {
    return '';
  }
  const normalizedName = name.toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() === normalizedName) {
      return value;
    }
  }
  return '';
}

function isLikelyBinaryContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized.includes('application/octet-stream') ||
    normalized.includes('application/protobuf') ||
    normalized.includes('application/x-protobuf') ||
    normalized.includes('application/wasm') ||
    normalized.includes('application/zip') ||
    normalized.includes('application/gzip') ||
    normalized.includes('application/x-brotli') ||
    normalized.startsWith('image/') ||
    normalized.startsWith('audio/') ||
    normalized.startsWith('video/') ||
    normalized.startsWith('font/')
  );
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}
