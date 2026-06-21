/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isUtf8} from 'node:buffer';

import {networkRequestObservedAtSymbol} from '../PageCollector.js';
import type {HTTPRequest, HTTPResponse} from '../third_party/index.js';

const BODY_CONTEXT_SIZE_LIMIT = 4096;
const BODY_FETCH_TIMEOUT_MS = 5000;
const RESPONSE_LOOKUP_TIMEOUT_MS = 1000;
const FORM_FIELD_PREVIEW_LIMIT = 20;
const HEADER_CONTEXT_SIZE_LIMIT = 4096;
const LIST_SET_COOKIE_NAME_LIMIT = 5;
const LIST_URL_CONTEXT_LIMIT = 240;
const LONG_URL_LIMIT = 2000;
const LONG_QUERY_LIMIT = 1000;
const SET_COOKIE_CONTEXT_SIZE_LIMIT = 1024;
const COOKIE_HEADER_NAME_LIMIT = 10;

const SENSITIVE_HEADER_EXACT_NAMES = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-api-key',
]);

const SENSITIVE_HEADER_NAME_FRAGMENTS = [
  'token',
  'secret',
  'password',
  'api-key',
  'apikey',
  'session',
  'csrf',
  'xsrf',
];

type RequestTiming = ReturnType<HTTPRequest['timing']>;
type TimingSource = 'browser' | 'observed';

interface RequestWithObservedAt extends HTTPRequest {
  [networkRequestObservedAtSymbol]?: number;
}

interface RequestStartTiming {
  epochMs: number;
  source: TimingSource;
}

export type NetworkExportPart =
  | 'all'
  | 'responseHeaders'
  | 'responseBody'
  | 'requestBody'
  | 'queryParams';

interface QueryPayload {
  queryString: string;
  params: Record<string, string | string[]>;
  entries: Array<{name: string; value: string}>;
}

export interface HeaderEntry {
  name: string;
  value: string;
}

interface HeaderFormatOptions {
  sizeLimit?: number;
  omittedLabel?: string;
  redactSensitiveValues?: boolean;
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

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message = 'Timed out fetching body',
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms),
    ),
  ]);
}

export function isRequestPending(request: HTTPRequest): boolean {
  if (request.failure()) {
    return false;
  }

  return !isAvailableTiming(request.timing().responseEnd);
}

export function getPendingRequestStatus(): string {
  return '[pending: resume execution before reading response data]';
}

export function getPendingResponseError(part: NetworkExportPart): string {
  return `Request is pending. Resume execution with pause_or_resume, then retry outputPart="${part}".`;
}

export async function getResponseIfCompleted(
  request: HTTPRequest,
): Promise<HTTPResponse | null> {
  if (isRequestPending(request)) {
    return null;
  }

  return withTimeout(
    request.response(),
    RESPONSE_LOOKUP_TIMEOUT_MS,
    'Timed out waiting for response metadata',
  );
}

export function getShortDescriptionForRequest(
  request: HTTPRequest,
  id: number,
  selectedInDevToolsUI = false,
): string {
  return `reqid=${id} ${getFormattedRequestTimingBrief(request)} [${request.resourceType()}] ${request.method()} ${getUrlForList(request.url())} ${getStatusFromRequest(request)}${selectedInDevToolsUI ? ` [selected in the DevTools Network panel]` : ''}`;
}

export async function getShortDescriptionForRequestAsync(
  request: HTTPRequest,
  id: number,
  selectedInDevToolsUI = false,
  includeSetCookieMarker = false,
): Promise<string> {
  if (!hasFinishedOrFailed(request)) {
    return `reqid=${id} ${getFormattedRequestTimingBrief(request)} [${request.resourceType()}] ${request.method()} ${getUrlForList(request.url())} ${getPendingRequestStatus()}${selectedInDevToolsUI ? ` [selected in the DevTools Network panel]` : ''}`;
  }

  const status = await getStatusFromRequestAsync(request);
  const setCookieMarker = includeSetCookieMarker
    ? await getSetCookieListMarker(request)
    : '';
  return `reqid=${id} ${getFormattedRequestTimingBrief(request)} [${request.resourceType()}] ${request.method()} ${getUrlForList(request.url())} ${status}${setCookieMarker}${selectedInDevToolsUI ? ` [selected in the DevTools Network panel]` : ''}`;
}

function hasFinishedOrFailed(request: HTTPRequest): boolean {
  if (request.failure()) {
    return true;
  }

  return isAvailableTiming(request.timing().responseEnd);
}

export function getFormattedRequestTimingBrief(request: HTTPRequest): string {
  const timing = request.timing();
  const start = getRequestStartTiming(request, timing);
  const startText = start
    ? `${start.source === 'observed' ? 'observed ' : ''}${formatLocalTimestamp(start.epochMs)}`
    : 'time unavailable';
  const durationText = isAvailableTiming(timing.responseEnd)
    ? formatDuration(timing.responseEnd)
    : 'pending';
  return `[${startText}, ${durationText}]`;
}

export function getFormattedRequestTiming(request: HTTPRequest): string[] {
  const timing = request.timing();
  const start = getRequestStartTiming(request, timing);
  const responseEnd = isAvailableTiming(timing.responseEnd)
    ? formatDuration(timing.responseEnd)
    : 'pending';
  const lines: string[] = [];

  if (start) {
    const label = start.source === 'browser' ? 'Start' : 'Observed';
    lines.push(`- ${label}: ${formatLocalTimestamp(start.epochMs)}`);
    lines.push(`- ${label} epoch ms: ${Math.round(start.epochMs)}`);
  } else {
    lines.push('- Start: unavailable');
  }

  lines.push(`- Duration: ${responseEnd}`);
  lines.push(
    `- TTFB: ${formatTimingSpan(timing.requestStart, timing.responseStart)}`,
  );
  lines.push(
    `- DNS: ${formatTimingSpan(timing.domainLookupStart, timing.domainLookupEnd)}`,
  );
  lines.push(
    `- Connect: ${formatTimingSpan(timing.connectStart, timing.connectEnd)}`,
  );
  lines.push(
    `- SSL: ${formatTimingSpan(timing.secureConnectionStart, timing.connectEnd)}`,
  );
  lines.push(`- Request start: ${formatRelativeTiming(timing.requestStart)}`);
  lines.push(`- Response start: ${formatRelativeTiming(timing.responseStart)}`);
  lines.push(`- Response end: ${formatRelativeTiming(timing.responseEnd)}`);

  return lines;
}

export function getStatusFromRequest(request: HTTPRequest): string {
  // In Playwright, request.response() is async, but we cache the failure info
  const failure = request.failure();
  if (failure) {
    return `[failed - ${failure.errorText}]`;
  }
  // We can't synchronously get the response in Playwright.
  // Return pending for now - the detailed view will show the response.
  return getPendingRequestStatus();
}

export async function getStatusFromRequestAsync(
  request: HTTPRequest,
): Promise<string> {
  if (isRequestPending(request)) {
    return getPendingRequestStatus();
  }

  const httpResponse = await getResponseIfCompleted(request);
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

export async function requestHasSetCookie(
  request: HTTPRequest,
): Promise<boolean> {
  const httpResponse = await getResponseIfCompleted(request);
  if (!httpResponse) {
    return false;
  }

  try {
    const responseHeaders = await getResponseHeadersArray(httpResponse);
    return getSetCookieHeaders(responseHeaders).length > 0;
  } catch {
    return false;
  }
}

export function getHeadersExcludingSetCookie(
  headers: HeaderEntry[],
): HeaderEntry[] {
  return headers.filter(({name}) => name.toLowerCase() !== 'set-cookie');
}

export function getFormattedHeaderEntries(
  headers: HeaderEntry[],
  options: HeaderFormatOptions = {},
): string[] {
  const sizeLimit = options.sizeLimit ?? HEADER_CONTEXT_SIZE_LIMIT;
  const omittedLabel = options.omittedLabel ?? 'header entries';
  const redactSensitiveValues = options.redactSensitiveValues ?? true;
  return getSizeLimitedLines(
    headers.map(({name, value}) => {
      const formattedValue = redactSensitiveValues
        ? formatInlineHeaderValue(name, value)
        : value;
      return `- ${name}:${formattedValue}`;
    }),
    sizeLimit,
    omittedLabel,
  );
}

export function getFormattedSetCookieEntries(
  setCookieHeaders: string[],
): string[] {
  return getSizeLimitedLines(
    setCookieHeaders.map(value => `- ${value}`),
    SET_COOKIE_CONTEXT_SIZE_LIMIT,
    'Set-Cookie entries',
  );
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
      const contentType = getHeaderValue(
        httpResponse.headers(),
        'content-type',
      );

      if (responseAsTest.length === 0) {
        return `<empty response>`;
      }

      return getFormattedTextBody(
        responseAsTest,
        contentType,
        sizeLimit,
        'responseBody',
      );
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
    const contentType = getHeaderValue(httpRequest.headers(), 'content-type');
    return getFormattedTextBody(data, contentType, sizeLimit, 'requestBody');
  }

  return;
}

export async function exportNetworkRequestPart(
  httpRequest: HTTPRequest,
  part: NetworkExportPart,
): Promise<{data: Uint8Array; summary: string}> {
  if (
    isRequestPending(httpRequest) &&
    (part === 'responseHeaders' || part === 'responseBody' || part === 'all')
  ) {
    throw new Error(getPendingResponseError(part));
  }

  switch (part) {
    case 'responseHeaders': {
      const httpResponse = await getResponseIfCompleted(httpRequest);
      if (!httpResponse) {
        throw new Error('No response is available for this request.');
      }
      const responseHeadersArray = await getResponseHeadersArray(httpResponse);
      const setCookieHeaders = getSetCookieHeaders(responseHeadersArray);
      const data = jsonBytes({
        url: httpRequest.url(),
        status: httpResponse.status(),
        statusText: httpResponse.statusText(),
        responseHeaders: headersObjectFromArray(responseHeadersArray),
        responseHeadersArray,
        setCookieHeaders,
      });
      return {
        data,
        summary: `Exported ${responseHeadersArray.length} response header entr${
          responseHeadersArray.length === 1 ? 'y' : 'ies'
        } including ${setCookieHeaders.length} Set-Cookie entr${
          setCookieHeaders.length === 1 ? 'y' : 'ies'
        } (${data.length} bytes).`,
      };
    }
    case 'responseBody': {
      const httpResponse = await getResponseIfCompleted(httpRequest);
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

  if (requestBody && requestBody.length > BODY_CONTEXT_SIZE_LIMIT) {
    hints.push(
      `Request body is ${requestBody.length} bytes. For exact request bytes, re-run with outputPart="requestBody" and outputFile="network-req-${reqid}-request-body.bin".`,
    );
  }

  if (isRequestPending(httpRequest)) {
    hints.push(
      'Request is pending. Resume execution with pause_or_resume before exporting responseHeaders, responseBody, or all.',
    );
    return [...new Set(hints)];
  }

  const requestHeaders = await getRequestHeadersArray(httpRequest).catch(
    () => [],
  );
  if (headersContainSensitiveValues(requestHeaders)) {
    hints.push(
      `Sensitive request header values are redacted inline. For exact request headers, re-run with outputPart="all" and outputFile="network-req-${reqid}.json".`,
    );
  }
  if (headersWillBeTruncated(requestHeaders)) {
    hints.push(
      `Request headers are truncated inline. For exact request headers, re-run with outputPart="all" and outputFile="network-req-${reqid}.json".`,
    );
  }

  const httpResponse = await getResponseIfCompleted(httpRequest);
  if (httpResponse) {
    const headers = httpResponse.headers();
    const responseHeadersArray = await getResponseHeadersArray(httpResponse);
    const setCookieHeaders = getSetCookieHeaders(responseHeadersArray);
    const responseHeadersWithoutSetCookie =
      getHeadersExcludingSetCookie(responseHeadersArray);
    const contentType = getHeaderValue(headers, 'content-type');
    const sizes = await httpRequest.sizes().catch(() => undefined);
    const responseBodySize = sizes?.responseBodySize ?? 0;

    if (headersContainSensitiveValues(responseHeadersWithoutSetCookie)) {
      hints.push(
        `Sensitive response header values are redacted inline. For exact response headers, re-run with outputPart="responseHeaders" and outputFile="network-req-${reqid}-response-headers.json".`,
      );
    }

    if (
      headersWillBeTruncated(responseHeadersWithoutSetCookie) ||
      setCookiesWillBeTruncated(setCookieHeaders)
    ) {
      hints.push(
        `Response headers are truncated inline. For exact response headers and Set-Cookie values, re-run with outputPart="responseHeaders" and outputFile="network-req-${reqid}-response-headers.json".`,
      );
    }

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
    return `${text.substring(0, sizeLimit)}... <truncated ${text.length - sizeLimit} chars>`;
  }

  return `${text}`;
}

function formatInlineHeaderValue(name: string, value: string): string {
  const normalizedName = name.toLowerCase();

  if (normalizedName === 'set-cookie') {
    return value;
  }

  if (normalizedName === 'cookie') {
    const names = getCookieHeaderNames(value);
    if (!names.length) {
      return `<redacted cookie header, ${value.length} chars>`;
    }

    const shown = names.slice(0, COOKIE_HEADER_NAME_LIMIT).join(', ');
    const remaining = names.length - COOKIE_HEADER_NAME_LIMIT;
    return `<redacted cookie header; names: ${shown}${remaining > 0 ? `, +${remaining} more` : ''}; ${value.length} chars>`;
  }

  if (
    normalizedName === 'authorization' ||
    normalizedName === 'proxy-authorization'
  ) {
    const scheme = value.trim().match(/^([A-Za-z][A-Za-z0-9._~+/-]*)\s+/)?.[1];
    return `<redacted authorization${scheme ? `; scheme: ${scheme}` : ''}; ${value.length} chars>`;
  }

  if (isSensitiveHeaderName(normalizedName)) {
    return `<redacted sensitive header; ${value.length} chars>`;
  }

  return value;
}

function getCookieHeaderNames(value: string): string[] {
  return value
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const eq = part.indexOf('=');
      return (eq === -1 ? part : part.slice(0, eq)).trim();
    })
    .filter(Boolean);
}

function isSensitiveHeaderName(normalizedName: string): boolean {
  if (normalizedName === 'set-cookie') {
    return false;
  }

  if (SENSITIVE_HEADER_EXACT_NAMES.has(normalizedName)) {
    return true;
  }

  return SENSITIVE_HEADER_NAME_FRAGMENTS.some(fragment =>
    normalizedName.includes(fragment),
  );
}

export function headersContainSensitiveValues(headers: HeaderEntry[]): boolean {
  return headers.some(({name}) => isSensitiveHeaderName(name.toLowerCase()));
}

function getFormattedTextBody(
  text: string,
  contentType: string,
  sizeLimit: number,
  exactPart: 'requestBody' | 'responseBody',
): string {
  const normalizedContentType = contentType.toLowerCase();

  if (isMultipartContentType(normalizedContentType)) {
    return getMultipartBodySummary(text, contentType, exactPart);
  }

  if (isHtmlContentType(normalizedContentType)) {
    const compacted = compactMarkupForPreview(text);
    return formatPreviewWithNote(
      `HTML body compacted for inline preview; export ${exactPart} for exact bytes.`,
      compacted,
      sizeLimit,
    );
  }

  if (isXmlContentType(normalizedContentType)) {
    const compacted = compactMarkupForPreview(text);
    return formatPreviewWithNote(
      `XML body compacted for inline preview; export ${exactPart} for exact bytes.`,
      compacted,
      sizeLimit,
    );
  }

  if (isJsonContentType(normalizedContentType) || looksLikeJson(text)) {
    const compacted = compactJsonForPreview(text);
    if (compacted) {
      return formatPreviewWithNote(
        `JSON body compacted for inline preview; export ${exactPart} for exact bytes.`,
        compacted,
        sizeLimit,
      );
    }
  }

  if (isFormUrlEncodedContentType(normalizedContentType)) {
    return getFormUrlEncodedPreview(text, sizeLimit, exactPart);
  }

  return getSizeLimitedString(text, sizeLimit);
}

function formatPreviewWithNote(
  note: string,
  text: string,
  sizeLimit: number,
): string {
  const prefix = `<${note}>\n`;
  const textLimit = Math.max(0, sizeLimit - prefix.length);
  return `${prefix}${getSizeLimitedString(text, textLimit)}`;
}

function compactJsonForPreview(text: string): string | undefined {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function compactMarkupForPreview(text: string): string {
  return text
    .replace(
      /<(script|style|pre|textarea)\b([^>]*)>[\s\S]*?<\/\1>/gi,
      (block, tag: string, attrs: string) => {
        const normalizedAttrs = attrs ? attrs.replace(/\s+/g, ' ').trim() : '';
        const open = normalizedAttrs
          ? `<${tag} ${normalizedAttrs}>`
          : `<${tag}>`;
        return `${open}<${tag} content omitted: ${block.length} chars></${tag}>`;
      },
    )
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ')
    .trim();
}

function getFormUrlEncodedPreview(
  text: string,
  sizeLimit: number,
  exactPart: 'requestBody' | 'responseBody',
): string {
  const params = new URLSearchParams(text);
  const entries = [...params.entries()];
  const shown = entries
    .slice(0, FORM_FIELD_PREVIEW_LIMIT)
    .map(([name, value]) => `${name}=${value}`);
  const omitted = entries.length - shown.length;
  const preview = `${shown.join('&')}${omitted > 0 ? `&... <${omitted} more fields>` : ''}`;
  return formatPreviewWithNote(
    `Form URL-encoded body preview: ${entries.length} fields, ${text.length} chars; export ${exactPart} for exact bytes.`,
    preview,
    sizeLimit,
  );
}

function getMultipartBodySummary(
  text: string,
  contentType: string,
  exactPart: 'requestBody' | 'responseBody',
): string {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundaryValue = boundary?.[1] ?? boundary?.[2]?.trim();
  const parts = boundaryValue
    ? text
        .split(`--${boundaryValue}`)
        .filter(part => part.trim() && part.trim() !== '--')
    : [];
  const partSummaries = parts.slice(0, FORM_FIELD_PREVIEW_LIMIT).map(part => {
    const name = /name="([^"]+)"/i.exec(part)?.[1] ?? '<unnamed>';
    const filename = /filename="([^"]*)"/i.exec(part)?.[1];
    const partContentType =
      /content-type:\s*([^\r\n]+)/i.exec(part)?.[1]?.trim() ?? '';
    return `${name}${filename !== undefined ? ` file="${filename}"` : ''}${partContentType ? ` type="${partContentType}"` : ''}`;
  });

  return [
    `<multipart body hidden from inline preview; export ${exactPart} for exact bytes>`,
    `Parts: ${parts.length || 'unknown'}`,
    ...(partSummaries.length ? [`Preview: ${partSummaries.join(', ')}`] : []),
  ].join('\n');
}

function isHtmlContentType(contentType: string): boolean {
  return contentType.includes('text/html');
}

function isXmlContentType(contentType: string): boolean {
  return (
    contentType.includes('xml') ||
    contentType.includes('image/svg+xml') ||
    contentType.includes('application/xhtml+xml')
  );
}

function isJsonContentType(contentType: string): boolean {
  return (
    contentType.includes('application/json') ||
    contentType.includes('+json') ||
    contentType.includes('text/json')
  );
}

function isFormUrlEncodedContentType(contentType: string): boolean {
  return contentType.includes('application/x-www-form-urlencoded');
}

function isMultipartContentType(contentType: string): boolean {
  return contentType.includes('multipart/form-data');
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function getUrlForList(urlString: string): string {
  if (urlString.length <= LIST_URL_CONTEXT_LIMIT) {
    return urlString;
  }

  try {
    const url = new URL(urlString);
    const queryLength = url.search.length ? url.search.length - 1 : 0;
    const queryEntries = [...url.searchParams].length;
    const base = `${url.origin}${url.pathname}`;
    const suffix = queryLength
      ? `?... [query: ${queryEntries} params, ${queryLength} chars]`
      : url.hash
        ? '#...'
        : '';
    const baseLimit = Math.max(40, LIST_URL_CONTEXT_LIMIT - suffix.length);
    return `${getStartLimitedString(base, baseLimit)}${suffix}`;
  } catch {
    return getStartLimitedString(urlString, LIST_URL_CONTEXT_LIMIT);
  }
}

function getStartLimitedString(text: string, sizeLimit: number): string {
  if (text.length <= sizeLimit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, sizeLimit - 3))}...`;
}

function getSizeLimitedLines(
  lines: string[],
  sizeLimit: number,
  omittedLabel: string,
): string[] {
  const result: string[] = [];
  let used = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineSize = line.length + 1;
    if (used + lineSize <= sizeLimit) {
      result.push(line);
      used += lineSize;
      continue;
    }

    const remaining = sizeLimit - used;
    if (remaining > 40) {
      result.push(getSizeLimitedString(line, remaining));
    }
    result.push(
      `- ... <truncated ${lines.length - i} ${omittedLabel}; use outputFile for exact values>`,
    );
    break;
  }

  return result;
}

function headersWillBeTruncated(headers: HeaderEntry[]): boolean {
  return headerLinesSize(headers) > HEADER_CONTEXT_SIZE_LIMIT;
}

function setCookiesWillBeTruncated(setCookieHeaders: string[]): boolean {
  return (
    setCookieHeaders.map(value => `- ${value}`).join('\n').length >
    SET_COOKIE_CONTEXT_SIZE_LIMIT
  );
}

function headerLinesSize(headers: HeaderEntry[]): number {
  return headers.map(({name, value}) => `- ${name}:${value}`).join('\n').length;
}

async function getNetworkRequestSnapshot(httpRequest: HTTPRequest) {
  const httpResponse = await getResponseIfCompleted(httpRequest);
  const query = parseQueryPayload(httpRequest.url());
  const requestBody = bodySnapshotFromBuffer(getRequestBodyBuffer(httpRequest));
  const responseBody = httpResponse
    ? bodySnapshotFromRead(await readResponseBody(httpResponse))
    : unavailableBodySnapshot('No response is available for this request.');
  const sizes = await httpRequest.sizes().catch(() => undefined);
  const requestHeaders = await httpRequest
    .allHeaders()
    .catch(() => httpRequest.headers());
  const requestHeadersArray = await getRequestHeadersArray(httpRequest);
  const responseHeaders = httpResponse
    ? await httpResponse.allHeaders().catch(() => httpResponse.headers())
    : undefined;
  const responseHeadersArray = httpResponse
    ? await getResponseHeadersArray(httpResponse)
    : undefined;
  const setCookieHeaders = responseHeadersArray
    ? getSetCookieHeaders(responseHeadersArray)
    : undefined;

  return {
    url: httpRequest.url(),
    method: httpRequest.method(),
    resourceType: httpRequest.resourceType(),
    status: httpResponse?.status(),
    statusText: httpResponse?.statusText(),
    failure: httpRequest.failure(),
    requestHeaders,
    requestHeadersArray,
    responseHeaders,
    responseHeadersArray,
    setCookieHeaders,
    query,
    requestBody,
    responseBody,
    sizes,
    timing: httpRequest.timing(),
    observedAt: getObservedAt(httpRequest),
  };
}

function getRequestStartTiming(
  request: HTTPRequest,
  timing: RequestTiming,
): RequestStartTiming | undefined {
  if (Number.isFinite(timing.startTime) && timing.startTime > 0) {
    return {
      epochMs: timing.startTime,
      source: 'browser',
    };
  }

  const observedAt = getObservedAt(request);
  if (observedAt !== undefined) {
    return {
      epochMs: observedAt,
      source: 'observed',
    };
  }

  return undefined;
}

function getObservedAt(request: HTTPRequest): number | undefined {
  const observedAt = (request as RequestWithObservedAt)[
    networkRequestObservedAtSymbol
  ];
  return typeof observedAt === 'number' &&
    Number.isFinite(observedAt) &&
    observedAt > 0
    ? observedAt
    : undefined;
}

function isAvailableTiming(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function formatLocalTimestamp(epochMs: number): string {
  const date = new Date(epochMs);
  const timezoneOffsetMinutes = -date.getTimezoneOffset();
  const timezoneSign = timezoneOffsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(timezoneOffsetMinutes);

  return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())} ${padNumber(date.getHours())}:${padNumber(date.getMinutes())}:${padNumber(date.getSeconds())}.${padNumber(date.getMilliseconds(), 3)} ${timezoneSign}${padNumber(Math.floor(absoluteOffset / 60))}:${padNumber(absoluteOffset % 60)}`;
}

function padNumber(value: number, length = 2): string {
  return `${value}`.padStart(length, '0');
}

function formatDuration(valueMs: number): string {
  if (!Number.isFinite(valueMs) || valueMs < 0) {
    return 'unavailable';
  }
  if (valueMs < 1000) {
    return `${Math.round(valueMs)}ms`;
  }
  if (valueMs < 10000) {
    return `${(valueMs / 1000).toFixed(2)}s`;
  }
  return `${(valueMs / 1000).toFixed(1)}s`;
}

function formatTimingSpan(startMs: number, endMs: number): string {
  if (
    !isAvailableTiming(startMs) ||
    !isAvailableTiming(endMs) ||
    endMs < startMs
  ) {
    return 'unavailable';
  }
  return `${formatDuration(endMs - startMs)} (${formatRelativeTiming(startMs)} to ${formatRelativeTiming(endMs)})`;
}

function formatRelativeTiming(valueMs: number): string {
  if (!isAvailableTiming(valueMs)) {
    return 'unavailable';
  }
  return `+${formatDuration(valueMs)}`;
}

export async function getRequestHeadersArray(
  httpRequest: HTTPRequest,
): Promise<HeaderEntry[]> {
  return httpRequest
    .headersArray()
    .catch(() => objectToHeaderArray(httpRequest.headers()));
}

export async function getResponseHeadersArray(
  httpResponse: HTTPResponse,
): Promise<HeaderEntry[]> {
  return httpResponse
    .headersArray()
    .catch(() => objectToHeaderArray(httpResponse.headers()));
}

function objectToHeaderArray(headers: Record<string, string>): HeaderEntry[] {
  return Object.entries(headers).map(([name, value]) => ({name, value}));
}

function headersObjectFromArray(
  headersArray: readonly HeaderEntry[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const {name, value} of headersArray) {
    const normalizedName = name.toLowerCase();
    const existing = result[normalizedName];
    if (existing === undefined) {
      result[normalizedName] = value;
    } else {
      result[normalizedName] = `${existing}${
        normalizedName === 'set-cookie' ? '\n' : ', '
      }${value}`;
    }
  }
  return result;
}

export function getSetCookieHeaders(
  headersArray: readonly HeaderEntry[],
): string[] {
  return headersArray
    .filter(({name}) => name.toLowerCase() === 'set-cookie')
    .map(({value}) => value);
}

async function getSetCookieListMarker(request: HTTPRequest): Promise<string> {
  const httpResponse = await getResponseIfCompleted(request);
  if (!httpResponse) {
    return '';
  }

  try {
    const setCookieHeaders = getSetCookieHeaders(
      await getResponseHeadersArray(httpResponse),
    );
    if (!setCookieHeaders.length) {
      return '';
    }

    const names = setCookieHeaders.map(getSetCookieName);
    const shown = names.slice(0, LIST_SET_COOKIE_NAME_LIMIT).join(', ');
    const remaining = names.length - LIST_SET_COOKIE_NAME_LIMIT;
    return ` set-cookie: ${shown}${remaining > 0 ? `, +${remaining} more` : ''}`;
  } catch {
    return ' set-cookie';
  }
}

function getSetCookieName(setCookieHeader: string): string {
  const eq = setCookieHeader.indexOf('=');
  if (eq <= 0) {
    return '<unnamed>';
  }
  return setCookieHeader.slice(0, eq).trim() || '<unnamed>';
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
