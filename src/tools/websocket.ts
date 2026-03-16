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

export const getWebSocketMessages = defineTool({
  name: 'get_websocket_messages',
  description: `Lists WebSocket connections or gets messages for a specific connection. Without wsid, lists all connections. With wsid, gets messages. Set analyze=true to group messages by pattern. Use groupId to filter by group. Use frameIndex to get a single message's full detail.`,
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: true,
  },
  schema: {
    wsid: zod
      .number()
      .optional()
      .describe(
        'The wsid of the WebSocket connection. If omitted, lists all connections.',
      ),
    analyze: zod
      .boolean()
      .optional()
      .default(false)
      .describe(
        'Set to true to analyze and group messages by pattern/fingerprint. Returns statistics and sample indices for each message type.',
      ),
    frameIndex: zod
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Get a single message by its frame index (0-based). Returns full detail for that message.',
      ),
    direction: zod
      .enum(DIRECTION_OPTIONS)
      .optional()
      .describe('Filter by direction: "sent" or "received".'),
    groupId: zod
      .string()
      .optional()
      .describe(
        'Filter by group ID (A, B, C, ...). Run with analyze=true first to get group IDs.',
      ),
    pageSize: zod
      .number()
      .int()
      .positive()
      .default(10)
      .optional()
      .describe('Messages per page (for messages mode) or connections per page (for list mode). Defaults to 10.'),
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
    urlFilter: zod
      .string()
      .optional()
      .describe(
        'Filter connections by URL (only for listing connections without wsid).',
      ),
    includePreservedConnections: zod
      .boolean()
      .default(false)
      .optional()
      .describe(
        'Set to true to return the preserved connections over the last 3 navigations (only for listing connections without wsid).',
      ),
  },
  handler: async (request, response, context) => {
    // Mode: List connections (no wsid)
    if (request.params.wsid === undefined) {
      response.setIncludeWebSocketConnections(true, {
        pageSize: request.params.pageSize,
        pageIdx: request.params.pageIdx,
        urlFilter: request.params.urlFilter,
        includePreservedConnections: request.params.includePreservedConnections,
      });
      return;
    }

    const ws = context.getWebSocketById(request.params.wsid);

    // Mode: Single frame detail
    if (request.params.frameIndex !== undefined) {
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
      return;
    }

    // Mode: Analyze / group by pattern
    if (request.params.analyze) {
      let frames = ws.frames;
      if (request.params.direction) {
        frames = frames.filter(f => f.direction === request.params.direction);
      }

      const summary = analyzeWebSocketFramesV2(
        frames,
        request.params.wsid,
        ws.connection.url,
      );
      context.cacheTrafficSummary(request.params.wsid, summary);

      const lines = formatTrafficSummary(summary);
      for (const line of lines) {
        response.appendResponseLine(line);
      }

      response.appendResponseLine(``);
      response.appendResponseLine(`### Usage`);
      response.appendResponseLine(
        `- View group: \`get_websocket_messages(wsid=${request.params.wsid}, groupId="A")\``,
      );
      response.appendResponseLine(
        `- View single: \`get_websocket_messages(wsid=${request.params.wsid}, frameIndex=0)\``,
      );
      return;
    }

    let frames = ws.frames;

    // Apply direction filter
    if (request.params.direction) {
      frames = frames.filter(f => f.direction === request.params.direction);
    }

    const pageSize = request.params.pageSize ?? 10;
    const pageIdx = request.params.pageIdx ?? 0;

    // Mode: With groupId - show group-specific messages
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

    // Mode: Default - show recent messages
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
