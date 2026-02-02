/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  WebSocketConnection,
  WebSocketData,
  WebSocketFrame,
} from '../WebSocketCollector.js';

const PAYLOAD_SIZE_LIMIT = 5000;

/**
 * Size category for message grouping
 */
export type SizeCategory = 'tiny' | 'small' | 'medium' | 'large' | 'xlarge';

/**
 * Message group with simplified grouping key: Direction + Head4B + SizeCategory
 */
export interface MessageGroupV2 {
  id: string; // A, B, C, ...
  direction: 'sent' | 'received';
  head4B: string; // First 4 bytes as hex
  sizeCategory: SizeCategory;
  count: number;
  minSize: number;
  maxSize: number;
  hint: string; // Guessed type based on head4B
  sampleIndices: number[]; // Sample frame indices
}

/**
 * Traffic summary for a WebSocket connection
 */
export interface TrafficSummary {
  wsid: number;
  url: string;
  durationMs: number;
  totalFrames: number;
  sentCount: number;
  receivedCount: number;
  groups: MessageGroupV2[];
  // Map from group ID to frame indices for quick lookup
  groupToIndices: Map<string, number[]>;
}

/**
 * Format a WebSocket connection for short list display.
 */
export function formatWebSocketConnectionShort(
  ws: WebSocketData,
  id: number,
): string {
  const statusBadge = getStatusBadge(ws.connection.status);
  const frameCount = ws.frames.length;
  const sentCount = ws.frames.filter(f => f.direction === 'sent').length;
  const receivedCount = ws.frames.filter(
    f => f.direction === 'received',
  ).length;

  // 检测是否有二进制消息
  const hasBinary = ws.frames.some(f => f.opcode === 2);
  const binaryHint = hasBinary ? ' [binary]' : '';

  return `wsid=${id} ${ws.connection.url} ${statusBadge} (${frameCount} frames: ↑${sentCount} ↓${receivedCount})${binaryHint}`;
}

/**
 * Format a WebSocket connection with verbose details.
 */
export function formatWebSocketConnectionVerbose(
  ws: WebSocketData,
  id: number,
): string[] {
  const lines: string[] = [];

  lines.push(`## WebSocket Connection (wsid=${id})`);
  lines.push(`URL: ${ws.connection.url}`);
  lines.push(`Status: ${getStatusBadge(ws.connection.status)}`);
  lines.push(`Created: ${formatTimestamp(ws.connection.createdAt)}`);

  if (ws.connection.closedAt) {
    lines.push(`Closed: ${formatTimestamp(ws.connection.closedAt)}`);
  }

  if (ws.connection.initiator) {
    lines.push(`### Initiator`);
    lines.push(`Type: ${ws.connection.initiator.type}`);
    if (ws.connection.initiator.url) {
      lines.push(`URL: ${ws.connection.initiator.url}`);
    }
    if (ws.connection.initiator.stack?.callFrames.length) {
      lines.push(`Call Stack:`);
      for (const frame of ws.connection.initiator.stack.callFrames.slice(
        0,
        5,
      )) {
        lines.push(
          `  - ${frame.functionName || '(anonymous)'} at ${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`,
        );
      }
    }
  }

  lines.push(`### Statistics`);
  const frameCount = ws.frames.length;
  const sentCount = ws.frames.filter(f => f.direction === 'sent').length;
  const receivedCount = ws.frames.filter(
    f => f.direction === 'received',
  ).length;
  lines.push(`Total frames: ${frameCount}`);
  lines.push(`Sent: ${sentCount}`);
  lines.push(`Received: ${receivedCount}`);

  return lines;
}

/**
 * Format a single frame in detail.
 */
export function formatWebSocketFrameDetail(
  frame: WebSocketFrame,
  index: number,
): string[] {
  const lines: string[] = [];

  const directionIcon = frame.direction === 'sent' ? '↑' : '↓';
  const directionLabel = frame.direction === 'sent' ? 'SENT' : 'RECEIVED';

  lines.push(`## Frame ${index} (${directionIcon} ${directionLabel})`);
  lines.push(`Direction: ${frame.direction}`);
  lines.push(`Timestamp: ${formatTimestamp(frame.timestamp)}`);
  lines.push(`Opcode: ${frame.opcode} (${getOpcodeLabel(frame.opcode)})`);
  lines.push(`### Payload`);
  lines.push(
    formatPayload(frame.payloadData, frame.opcode, PAYLOAD_SIZE_LIMIT * 2),
  );

  return lines;
}

function getStatusBadge(status: WebSocketConnection['status']): string {
  switch (status) {
    case 'connecting':
      return '[connecting]';
    case 'open':
      return '[open]';
    case 'closed':
      return '[closed]';
    default:
      return '[unknown]';
  }
}

function getOpcodeLabel(opcode: number): string {
  switch (opcode) {
    case 1:
      return 'text';
    case 2:
      return 'binary';
    case 8:
      return 'close';
    case 9:
      return 'ping';
    case 10:
      return 'pong';
    default:
      return `opcode:${opcode}`;
  }
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toISOString();
}

function formatPayload(
  payload: string,
  opcode: number,
  sizeLimit: number = PAYLOAD_SIZE_LIMIT,
): string {
  if (opcode === 2) {
    // Binary data
    const truncated = payload.length > sizeLimit;
    const displayPayload = truncated ? payload.slice(0, sizeLimit) : payload;
    return `<binary: ${payload.length} bytes>${truncated ? ' (truncated)' : ''}\n${displayPayload}`;
  }

  // Text data - try to format as JSON if possible
  let formattedPayload = payload;

  try {
    const parsed = JSON.parse(payload);
    formattedPayload = JSON.stringify(parsed, null, 2);
  } catch {
    // Not JSON, use raw payload
  }

  if (formattedPayload.length > sizeLimit) {
    return formattedPayload.slice(0, sizeLimit) + '... <truncated>';
  }

  return formattedPayload;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Base64 to Hex string (first N bytes)
 */
function base64ToHex(base64: string, maxBytes = 4): string {
  try {
    const binary = atob(base64);
    let hex = '';
    for (let i = 0; i < binary.length && i < maxBytes; i++) {
      hex += binary.charCodeAt(i).toString(16).padStart(2, '0');
    }
    return hex;
  } catch {
    return '';
  }
}

/**
 * Get first 4 bytes as hex string
 */
function getHead4B(payload: string, opcode: number): string {
  if (opcode === 2 || payload.match(/^[A-Za-z0-9+/]+=*$/)) {
    // Binary or base64
    return base64ToHex(payload, 4);
  }
  // Text - convert first 4 chars to hex
  let hex = '';
  for (let i = 0; i < Math.min(payload.length, 4); i++) {
    hex += payload.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Get size category based on payload size
 */
function getSizeCategory(size: number): SizeCategory {
  if (size < 32) return 'tiny';
  if (size < 128) return 'small';
  if (size < 512) return 'medium';
  if (size < 2048) return 'large';
  return 'xlarge';
}

/**
 * Guess message type hint based on head 4 bytes
 */
function guessHintFromHead(head4B: string): string {
  if (!head4B) return '-';

  // Gzip magic number: 1f 8b
  if (head4B.startsWith('1f8b')) return 'Gzip';

  // Protobuf field markers (common patterns)
  // Field 1 varint: 08, Field 1 length-delimited: 0a
  // Field 2 varint: 10, Field 2 length-delimited: 12
  if (
    head4B.startsWith('08') ||
    head4B.startsWith('0a') ||
    head4B.startsWith('10') ||
    head4B.startsWith('12') ||
    head4B.startsWith('18') ||
    head4B.startsWith('1a') ||
    head4B.startsWith('20') ||
    head4B.startsWith('22')
  ) {
    return 'Protobuf';
  }

  // JSON: starts with { (0x7b) or [ (0x5b)
  if (head4B.startsWith('7b') || head4B.startsWith('5b')) return 'JSON';

  // MessagePack: fixmap (0x80-0x8f), fixarray (0x90-0x9f), fixstr (0xa0-0xbf)
  const firstByte = parseInt(head4B.slice(0, 2), 16);
  if (firstByte >= 0x80 && firstByte <= 0xbf) return 'MsgPack';

  // Zstd magic: 28 b5 2f fd
  if (head4B === '28b52ffd') return 'Zstd';

  // WebSocket ping/pong (text based)
  if (head4B === '70696e67') return 'ping'; // "ping"
  if (head4B === '706f6e67') return 'pong'; // "pong"

  return '-';
}

/**
 * Format duration in human-readable format
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Format time delta relative to base time
 */
function formatTimeDelta(deltaMs: number): string {
  if (deltaMs < 1000) return `+${deltaMs}ms`;
  if (deltaMs < 60000) return `+${(deltaMs / 1000).toFixed(1)}s`;
  const minutes = Math.floor(deltaMs / 60000);
  const seconds = Math.floor((deltaMs % 60000) / 1000);
  return `+${minutes}m${seconds}s`;
}

/**
 * Format size in human-readable format
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Generate group ID (A, B, C, ... Z, AA, AB, ...)
 */
function generateGroupId(index: number): string {
  let id = '';
  let n = index;
  do {
    id = String.fromCharCode(65 + (n % 26)) + id;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return id;
}

// ============================================================================
// V2 Analysis Functions
// ============================================================================

/**
 * Analyze WebSocket frames with new grouping strategy: Direction + Head4B + SizeCategory
 */
export function analyzeWebSocketFramesV2(
  frames: WebSocketFrame[],
  wsid: number,
  url: string,
): TrafficSummary {
  const sentCount = frames.filter(f => f.direction === 'sent').length;
  const receivedCount = frames.filter(f => f.direction === 'received').length;

  // Calculate duration
  let durationMs = 0;
  if (frames.length > 1) {
    const firstTimestamp = frames[0].timestamp;
    const lastTimestamp = frames[frames.length - 1].timestamp;
    durationMs = lastTimestamp - firstTimestamp;
  }

  // Group by (direction, head4B, sizeCategory)
  const groupMap = new Map<
    string,
    {
      direction: 'sent' | 'received';
      head4B: string;
      sizeCategory: SizeCategory;
      indices: number[];
      minSize: number;
      maxSize: number;
    }
  >();

  frames.forEach((frame, index) => {
    const head4B = getHead4B(frame.payloadData, frame.opcode);
    const size = frame.payloadData.length;
    const sizeCategory = getSizeCategory(size);
    const key = `${frame.direction}:${head4B}:${sizeCategory}`;

    if (!groupMap.has(key)) {
      groupMap.set(key, {
        direction: frame.direction,
        head4B,
        sizeCategory,
        indices: [],
        minSize: size,
        maxSize: size,
      });
    }

    const group = groupMap.get(key)!;
    group.indices.push(index);
    group.minSize = Math.min(group.minSize, size);
    group.maxSize = Math.max(group.maxSize, size);
  });

  // Convert to result format and sort by count
  const groupEntries = Array.from(groupMap.entries());
  groupEntries.sort((a, b) => b[1].indices.length - a[1].indices.length);

  const groups: MessageGroupV2[] = [];
  const groupToIndices = new Map<string, number[]>();

  groupEntries.forEach(([, group], idx) => {
    const id = generateGroupId(idx);
    const hint = guessHintFromHead(group.head4B);

    // Take first 3 as samples
    const sampleIndices = group.indices.slice(0, 3);

    groups.push({
      id,
      direction: group.direction,
      head4B: group.head4B,
      sizeCategory: group.sizeCategory,
      count: group.indices.length,
      minSize: group.minSize,
      maxSize: group.maxSize,
      hint,
      sampleIndices,
    });

    groupToIndices.set(id, group.indices);
  });

  return {
    wsid,
    url,
    durationMs,
    totalFrames: frames.length,
    sentCount,
    receivedCount,
    groups,
    groupToIndices,
  };
}

/**
 * Format traffic summary as markdown table
 */
export function formatTrafficSummary(summary: TrafficSummary): string[] {
  const lines: string[] = [];

  lines.push(`## WebSocket Traffic Summary (wsid=${summary.wsid})`);
  lines.push(
    `Duration: ${formatDuration(summary.durationMs)} | Total: ${summary.totalFrames} frames (↑${summary.sentCount} sent, ↓${summary.receivedCount} received)`,
  );
  lines.push(``);

  if (summary.groups.length === 0) {
    lines.push(`<no messages>`);
    return lines;
  }

  lines.push(`| ID | Dir | Count | Head (4B) | Size Range | Hint | Samples |`);
  lines.push(`|----|-----|-------|-----------|------------|------|---------|`);

  for (const group of summary.groups) {
    const dir = group.direction === 'sent' ? '↑' : '↓';
    const head = group.head4B ? `\`${group.head4B}\`` : '-';
    const sizeRange =
      group.minSize === group.maxSize
        ? formatSize(group.minSize)
        : `${formatSize(group.minSize)}-${formatSize(group.maxSize)}`;
    const samples = `[${group.sampleIndices.join(', ')}]`;

    lines.push(
      `| ${group.id} | ${dir} | ${group.count} | ${head} | ${sizeRange} | ${group.hint} | ${samples} |`,
    );
  }

  return lines;
}

/**
 * Format messages for a specific group
 */
export function formatGroupMessages(
  frames: WebSocketFrame[],
  indices: number[],
  groupId: string,
  options?: {pageSize?: number; pageIdx?: number},
): string[] {
  const lines: string[] = [];
  const pageSize = options?.pageSize ?? 20;
  const pageIdx = options?.pageIdx ?? 0;
  const offset = pageIdx * pageSize;

  const paginatedIndices = indices.slice(offset, offset + pageSize);

  lines.push(`## Group ${groupId} Messages (${indices.length} items)`);

  if (paginatedIndices.length === 0) {
    lines.push(`<no messages in this page>`);
    return lines;
  }

  // Use first frame timestamp as base
  const baseTimestamp = frames[indices[0]]?.timestamp ?? 0;
  lines.push(
    `Base: ${new Date(baseTimestamp).toISOString().split('T')[1].slice(0, 12)}`,
  );
  lines.push(``);

  lines.push(`| Idx | +Time | Size |`);
  lines.push(`|-----|-------|------|`);

  for (const idx of paginatedIndices) {
    const frame = frames[idx];
    if (!frame) continue;

    const deltaMs = frame.timestamp - baseTimestamp;
    const timeDelta = formatTimeDelta(deltaMs);
    const size = formatSize(frame.payloadData.length);

    lines.push(`| ${idx} | ${timeDelta} | ${size} |`);
  }

  if (indices.length > offset + pageSize) {
    lines.push(``);
    lines.push(
      `Showing ${offset + 1}-${offset + paginatedIndices.length} of ${indices.length}. Use pageIdx=${pageIdx + 1} for more.`,
    );
  }

  return lines;
}

/**
 * Format recent messages (no group filter)
 */
export function formatRecentMessages(
  frames: WebSocketFrame[],
  options?: {pageSize?: number; pageIdx?: number},
): string[] {
  const lines: string[] = [];
  const pageSize = options?.pageSize ?? 20;
  const pageIdx = options?.pageIdx ?? 0;
  const offset = pageIdx * pageSize;

  const paginatedFrames = frames.slice(offset, offset + pageSize);

  lines.push(
    `Showing ${offset + 1}-${offset + paginatedFrames.length} of ${frames.length} frames`,
  );

  if (paginatedFrames.length === 0) {
    lines.push(`<no messages>`);
    return lines;
  }

  // Use first frame timestamp as base
  const baseTimestamp = frames[0]?.timestamp ?? 0;
  lines.push(``);

  lines.push(`| Idx | Dir | +Time | Size | Head (4B) |`);
  lines.push(`|-----|-----|-------|------|-----------|`);

  for (let i = 0; i < paginatedFrames.length; i++) {
    const frame = paginatedFrames[i];
    const frameIdx = offset + i;
    const dir = frame.direction === 'sent' ? '↑' : '↓';
    const deltaMs = frame.timestamp - baseTimestamp;
    const timeDelta = formatTimeDelta(deltaMs);
    const size = formatSize(frame.payloadData.length);
    const head = getHead4B(frame.payloadData, frame.opcode);
    const headStr = head ? `\`${head}\`` : '-';

    lines.push(
      `| ${frameIdx} | ${dir} | ${timeDelta} | ${size} | ${headStr} |`,
    );
  }

  if (frames.length > offset + pageSize) {
    lines.push(``);
    lines.push(`Use pageIdx=${pageIdx + 1} for more.`);
  }

  return lines;
}
