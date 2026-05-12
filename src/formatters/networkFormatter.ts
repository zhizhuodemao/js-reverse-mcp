/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isUtf8} from 'node:buffer';

import type {HTTPRequest, HTTPResponse} from '../third_party/index.js';

const BODY_CONTEXT_SIZE_LIMIT = 10000;
const BODY_FETCH_TIMEOUT_MS = 5000;

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

export async function getStatusFromRequestAsync(request: HTTPRequest): Promise<string> {
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
    const responseBuffer = await withTimeout(httpResponse.body(), BODY_FETCH_TIMEOUT_MS);

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

function getSizeLimitedString(text: string, sizeLimit: number) {
  if (text.length > sizeLimit) {
    return `${text.substring(0, sizeLimit) + '... <truncated>'}`;
  }

  return `${text}`;
}
