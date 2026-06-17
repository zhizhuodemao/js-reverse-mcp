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

const NETWORK_EXPORT_PARTS = [
  'all',
  'responseHeaders',
  'responseBody',
  'requestBody',
  'queryParams',
] as const;

export const listNetworkRequests = defineTool({
  name: 'list_network_requests',
  description: `List network requests for the currently selected page since the last navigation. Results are sorted newest-first. By default returns the 20 most recent requests; use pageSize/pageIdx to paginate. List output marks responses that set cookies with [set-cookie]. Pass reqid to get a single request's full details, including request headers, response headers, and a dedicated Set-Cookie section when present. When exact bytes, full bodies, replay inputs, signature inputs, large request bodies, long GET query payloads, binary responses, or data for external decoding are needed, pass reqid with outputFile to export the selected data. For GET requests, payload-like data means parsed URL query parameters.`,
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
    resourceTypes: zod
      .array(zod.enum(FILTERABLE_RESOURCE_TYPES))
      .optional()
      .describe(
        'Filter requests to only return requests of the specified resource types. When omitted or empty, returns all requests.',
      ),
    urlFilter: zod
      .string()
      .optional()
      .describe(
        'Filter requests by URL. Only requests containing this substring will be returned.',
      ),
    includePreservedRequests: zod
      .boolean()
      .default(false)
      .optional()
      .describe(
        'Set to true to return the preserved requests over the last 3 navigations.',
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
      .optional()
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
      resourceTypes: request.params.resourceTypes,
      urlFilter: request.params.urlFilter,
      includePreservedRequests: request.params.includePreservedRequests,
      networkRequestIdInDevToolsUI: reqid,
    });
  },
});
