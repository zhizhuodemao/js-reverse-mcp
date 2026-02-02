/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  analyzeWebSocketFramesV2,
  formatGroupMessages,
  formatRecentMessages,
  formatTrafficSummary,
  formatWebSocketFrameDetail,
} from '../formatters/websocketFormatter.js';
import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './ToolDefinition.js';

const DIRECTION_OPTIONS: readonly ['sent', 'received'] = ['sent', 'received'];

export const listWebSocketConnections = defineTool({
  name: 'list_websocket_connections',
  description: `List all WebSocket connections. After getting wsid, use analyze_websocket_messages(wsid) FIRST to understand message patterns before viewing individual messages.`,
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: true,
  },
  schema: {
    pageSize: zod
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Maximum number of connections to return. When omitted, returns all connections.',
      ),
    pageIdx: zod
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Page number to return (0-based). When omitted, returns the first page.',
      ),
    urlFilter: zod
      .string()
      .optional()
      .describe(
        'Filter connections by URL. Only connections containing this substring will be returned.',
      ),
    includePreservedConnections: zod
      .boolean()
      .default(false)
      .optional()
      .describe(
        'Set to true to return the preserved connections over the last 3 navigations.',
      ),
  },
  handler: async (request, response) => {
    response.setIncludeWebSocketConnections(true, {
      pageSize: request.params.pageSize,
      pageIdx: request.params.pageIdx,
      urlFilter: request.params.urlFilter,
      includePreservedConnections: request.params.includePreservedConnections,
    });
  },
});

export const getWebSocketMessages = defineTool({
  name: 'get_websocket_messages',
  description: `Gets messages for a WebSocket connection. IMPORTANT: For binary/protobuf messages (like live streaming), use analyze_websocket_messages FIRST to understand message types, then use groupId parameter to filter specific types. Default mode shows summary only.`,
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: true,
  },
  schema: {
    wsid: zod.number().describe('The wsid of the WebSocket connection.'),
    direction: zod
      .enum(DIRECTION_OPTIONS)
      .optional()
      .describe('Filter by direction: "sent" or "received".'),
    groupId: zod
      .string()
      .optional()
      .describe(
        'Filter by group ID (A, B, C, ...). Get group IDs from analyze_websocket_messages first.',
      ),
    pageSize: zod
      .number()
      .int()
      .positive()
      .default(10)
      .optional()
      .describe('Messages per page. Defaults to 10.'),
    pageIdx: zod
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Page number (0-based).'),
    show_content: zod
      .boolean()
      .default(false)
      .optional()
      .describe(
        'Set to true to show full message payload. Default false (summary only) to avoid large binary output.',
      ),
  },
  handler: async (request, response, context) => {
    const ws = context.getWebSocketById(request.params.wsid);
    let frames = ws.frames;

    // Apply direction filter
    if (request.params.direction) {
      frames = frames.filter(f => f.direction === request.params.direction);
    }

    const pageSize = request.params.pageSize ?? 10;
    const pageIdx = request.params.pageIdx ?? 0;

    // Mode A: With groupId - show group-specific messages
    if (request.params.groupId) {
      const groupId = request.params.groupId.toUpperCase();

      // Try to get cached summary
      let summary = context.getCachedTrafficSummary(request.params.wsid);

      // If not cached, analyze and cache
      if (!summary) {
        summary = analyzeWebSocketFramesV2(
          ws.frames,
          request.params.wsid,
          ws.connection.url,
        );
        context.cacheTrafficSummary(request.params.wsid, summary);
      }

      const indices = summary.groupToIndices.get(groupId);
      if (!indices || indices.length === 0) {
        response.appendResponseLine(`## Group ${groupId} Messages`);
        response.appendResponseLine(`<group not found or empty>`);
        response.appendResponseLine(``);
        response.appendResponseLine(
          `Available groups: ${summary.groups.map(g => g.id).join(', ')}`,
        );
        return;
      }

      // Apply direction filter to indices
      let filteredIndices = indices;
      if (request.params.direction) {
        filteredIndices = indices.filter(idx => {
          const frame = ws.frames[idx];
          return frame && frame.direction === request.params.direction;
        });
      }

      const lines = formatGroupMessages(ws.frames, filteredIndices, groupId, {
        pageSize,
        pageIdx,
      });
      for (const line of lines) {
        response.appendResponseLine(line);
      }
      return;
    }

    // Mode B: Without groupId - show recent messages
    response.appendResponseLine(
      `## Recent Messages (wsid=${request.params.wsid})`,
    );

    const lines = formatRecentMessages(frames, {
      pageSize,
      pageIdx,
    });
    for (const line of lines) {
      response.appendResponseLine(line);
    }
  },
});

export const getWebSocketMessage = defineTool({
  name: 'get_websocket_message',
  description: `Gets a single WebSocket message by its frame index. Use get_websocket_messages or analyze_websocket_messages first to find the frame index.`,
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: true,
  },
  schema: {
    wsid: zod.number().describe('The wsid of the WebSocket connection.'),
    frameIndex: zod
      .number()
      .int()
      .min(0)
      .describe('The frame index (0-based) to retrieve.'),
  },
  handler: async (request, response, context) => {
    const ws = context.getWebSocketById(request.params.wsid);
    const frameIndex = request.params.frameIndex;

    if (frameIndex >= ws.frames.length) {
      throw new Error(
        `Frame index ${frameIndex} out of range. Total frames: ${ws.frames.length}`,
      );
    }

    const frame = ws.frames[frameIndex];
    const lines = formatWebSocketFrameDetail(frame, frameIndex);

    for (const line of lines) {
      response.appendResponseLine(line);
    }
  },
});

export const analyzeWebSocketMessages = defineTool({
  name: 'analyze_websocket_messages',
  description: `Analyzes WebSocket messages and groups them by pattern/fingerprint. Essential for understanding binary/protobuf message types in live streaming scenarios. Returns statistics and sample indices for each message type.`,
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: true,
  },
  schema: {
    wsid: zod
      .number()
      .describe('The wsid of the WebSocket connection to analyze.'),
    direction: zod
      .enum(DIRECTION_OPTIONS)
      .optional()
      .describe('Only analyze messages in this direction.'),
  },
  handler: async (request, response, context) => {
    const ws = context.getWebSocketById(request.params.wsid);
    let frames = ws.frames;

    // Apply direction filter
    if (request.params.direction) {
      frames = frames.filter(f => f.direction === request.params.direction);
    }

    // Analyze and cache the results
    const summary = analyzeWebSocketFramesV2(
      frames,
      request.params.wsid,
      ws.connection.url,
    );
    context.cacheTrafficSummary(request.params.wsid, summary);

    // Format and output the summary
    const lines = formatTrafficSummary(summary);
    for (const line of lines) {
      response.appendResponseLine(line);
    }

    // Add usage hints
    response.appendResponseLine(``);
    response.appendResponseLine(`### Usage`);
    response.appendResponseLine(
      `- View group: \`get_websocket_messages(wsid=${request.params.wsid}, groupId="A")\``,
    );
    response.appendResponseLine(
      `- View single: \`get_websocket_message(wsid=${request.params.wsid}, frameIndex=0)\``,
    );
  },
});
