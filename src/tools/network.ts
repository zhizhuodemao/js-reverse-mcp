/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type NetworkExportPart,
  exportNetworkRequestPart,
} from '../formatters/networkFormatter.js';
import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './ToolDefinition.js';

// Resource types as string literals (Playwright returns string from resourceType())
const FILTERABLE_RESOURCE_TYPES = [
  'document',
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'texttrack',
  'xhr',
  'fetch',
  'prefetch',
  'eventsource',
  'websocket',
  'manifest',
  'signedexchange',
  'ping',
  'cspviolationreport',
  'preflight',
  'other',
] as const;

// HTTP request methods for filtering (matched case-insensitively against
// request.method()).
const HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
] as const;

const NETWORK_EXPORT_PARTS = [
  'all',
  'responseHeaders',
  'responseBody',
  'requestBody',
  'queryParams',
] as const;

export const listNetworkRequests = defineTool({
  name: 'list_network_requests',
  description: `List network requests for the currently selected page. Requests are held in a flat FIFO queue that is not cleared on navigation, so a request that already fired (e.g. a login POST that caused a redirect, or a pre-redirect beacon) stays inspectable after the page moves on; the queue keeps the most recent 5000 requests and the oldest roll off. To establish a clean baseline before the action you want to study (the DevTools "clear, then act" workflow), call clear_network_requests first. Results are sorted newest-first and include request start time plus duration. By default returns the 20 most recent requests; use pageSize/pageIdx to paginate. Narrow the list with filters: methods (HTTP verb, e.g. ["POST"] to find form/credential/signature submissions), resourceTypes (resource category such as xhr/fetch/document — NOT the HTTP verb), and urlFilter (URL substring). Filters combine with AND; multiple values within one filter combine with OR. List output is an index: it shows status, summarized long URLs, and Set-Cookie names, not header/body contents. Pass reqid to inspect one request with timing, bounded inline headers where sensitive values such as Cookie, Authorization, and token-like headers are redacted, content-type-aware body previews, and a dedicated Set-Cookie section that shows raw values up to 1KB total. When exact bytes, full bodies, replay inputs, signature inputs, large request bodies, long GET query payloads, binary responses, full headers, full Set-Cookie values, or data for external decoding are needed, pass reqid with outputFile to export the selected data. For GET requests, payload-like data means parsed URL query parameters.`,
  annotations: {
    category: ToolCategory.NETWORK,
    // Not read-only due to outputFile export support.
    readOnlyHint: false,
  },
  schema: {
    reqid: zod
      .number()
      .optional()
      .describe(
        'The reqid of a specific network request to get full details for. If omitted, lists all requests.',
      ),
    pageSize: zod
      .number()
      .int()
      .positive()
      .optional()
      .describe('Maximum number of requests to return. Defaults to 20.'),
    pageIdx: zod
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Page number to return (0-based). When omitted, returns the first page.',
      ),
    methods: zod
      .array(zod.enum(HTTP_METHODS))
      .optional()
      .describe(
        'Filter requests by HTTP method (the request verb). Matched case-insensitively. Pass one or more of GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS; multiple values are OR-ed (e.g. ["POST"] shows only POSTs, ["GET","POST"] shows both). Use this to hunt for submissions (POST/PUT/PATCH) versus reads (GET). This is the HTTP verb, distinct from resourceTypes which filters by resource category (xhr, document, ...). When omitted or empty, methods are not filtered.',
      ),
    resourceTypes: zod
      .array(zod.enum(FILTERABLE_RESOURCE_TYPES))
      .optional()
      .describe(
        'Filter requests to only return requests of the specified resource types (xhr, fetch, document, script, ...). This is the resource category, NOT the HTTP verb — use methods for GET/POST filtering. When omitted or empty, returns all requests.',
      ),
    urlFilter: zod
      .string()
      .optional()
      .describe(
        'Filter requests by URL. Only requests containing this substring will be returned.',
      ),
    outputFile: zod
      .string()
      .optional()
      .describe(
        'When reqid is provided, save network data to this local file instead of returning only inline text. Use this for exact bytes, large bodies, long GET query payloads, binary responses, replay/signature inputs, or data that will be decoded with external tools. Absolute paths and paths relative to the current working directory are supported. The response reports the resolved absolute path; use that path with evaluate_script localFilePath when browser-side processing is needed.',
      ),
    outputPart: zod
      .enum(NETWORK_EXPORT_PARTS)
      .default('all')
      .describe(
        'Which part to export when outputFile is provided. "responseHeaders" saves response headers as JSON while preserving repeated headers such as Set-Cookie, "responseBody" saves raw response bytes, "requestBody" saves captured request body bytes, "queryParams" saves parsed URL query parameters as JSON, and "all" saves a JSON bundle with metadata, headers, query params, and body content/metadata. Defaults to "all".',
      ),
  },
  handler: async (request, response, context) => {
    if (request.params.outputFile && request.params.reqid === undefined) {
      response.appendResponseLine(
        'outputFile requires reqid. First call list_network_requests without outputFile to find the request id, then re-run with reqid and outputFile.',
      );
      return;
    }

    if (request.params.reqid !== undefined) {
      if (request.params.outputFile) {
        const networkRequest = context.getNetworkRequestById(
          request.params.reqid,
        );
        const outputPart = request.params.outputPart as NetworkExportPart;
        const exported = await exportNetworkRequestPart(
          networkRequest,
          outputPart,
        );
        const file = await context.saveFile(
          exported.data,
          request.params.outputFile,
        );
        response.appendResponseLine(
          `${exported.summary} Saved ${outputPart} to ${file.filename}.`,
        );
        return;
      }

      response.attachNetworkRequest(request.params.reqid);
      return;
    }
    const data = await context.getDevToolsData();
    const reqid = data?.cdpRequestId
      ? context.resolveCdpRequestId(data.cdpRequestId)
      : undefined;
    response.setIncludeNetworkRequests(true, {
      pageSize: request.params.pageSize,
      pageIdx: request.params.pageIdx,
      methods: request.params.methods,
      resourceTypes: request.params.resourceTypes,
      urlFilter: request.params.urlFilter,
      networkRequestIdInDevToolsUI: reqid,
    });
  },
});

export const clearNetworkRequests = defineTool({
  name: 'clear_network_requests',
  description: `Clear all collected network requests for the currently selected page, to establish a clean baseline before the action you want to study (the DevTools "clear, then act" workflow). This drops the in-memory request queue, releases the cached response-body byte budget, and clears the request initiator (call stack) maps for the page. It does not touch the browser, cookies, HTTP cache, storage, console, WebSocket messages, or any other page — use clear_site_data for browser state. reqids are not reused after clearing; newly collected requests continue from the previous high-water mark.`,
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: false,
  },
  schema: {},
  handler: async (_request, response, context) => {
    const {requestCount, reclaimedBytes} = context.clearNetworkRequests();
    response.appendResponseLine(
      `Cleared ${requestCount} network request${
        requestCount === 1 ? '' : 's'
      } for the selected page.`,
    );
    response.appendResponseLine(
      `Released ${reclaimedBytes} bytes of cached response bodies.`,
    );
    response.appendResponseLine('Request initiator data cleared.');
    response.appendResponseLine(
      'reqids are not reused — newly collected requests continue from the previous high-water mark.',
    );
  },
});
