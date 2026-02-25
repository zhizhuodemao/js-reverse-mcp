/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {DebuggerContext} from '../DebuggerContext.js';
import type {TrafficSummary} from '../formatters/websocketFormatter.js';
import type {RequestInitiator} from '../PageCollector.js';
import {zod} from '../third_party/index.js';
import type {Dialog, Frame, HTTPRequest, Page} from '../third_party/index.js';
import type {TraceResult} from '../trace-processing/parse.js';
import type {PaginationOptions} from '../utils/types.js';
import type {WebSocketData} from '../WebSocketCollector.js';

import type {ToolCategory} from './categories.js';

export interface ToolDefinition<
  Schema extends zod.ZodRawShape = zod.ZodRawShape,
> {
  name: string;
  description: string;
  annotations: {
    title?: string;
    category: ToolCategory;
    /**
     * If true, the tool does not modify its environment.
     */
    readOnlyHint: boolean;
  };
  schema: Schema;
  handler: (
    request: Request<Schema>,
    response: Response,
    context: Context,
  ) => Promise<void>;
}

export interface Request<Schema extends zod.ZodRawShape> {
  params: zod.objectOutputType<Schema, zod.ZodTypeAny>;
}

export interface ImageContentData {
  data: string;
  mimeType: string;
}

export interface DevToolsData {
  cdpRequestId?: string;
  cdpBackendNodeId?: number;
}

export interface Response {
  appendResponseLine(value: string): void;
  setIncludePages(value: boolean): void;
  setIncludeNetworkRequests(
    value: boolean,
    options?: PaginationOptions & {
      resourceTypes?: string[];
      includePreservedRequests?: boolean;
      networkRequestIdInDevToolsUI?: number;
    },
  ): void;
  setIncludeConsoleData(
    value: boolean,
    options?: PaginationOptions & {
      types?: string[];
      includePreservedMessages?: boolean;
    },
  ): void;
  attachImage(value: ImageContentData): void;
  attachNetworkRequest(reqid: number): void;
  attachConsoleMessage(msgid: number): void;
  // WebSocket methods
  setIncludeWebSocketConnections(
    value: boolean,
    options?: PaginationOptions & {
      urlFilter?: string;
      includePreservedConnections?: boolean;
    },
  ): void;
  attachWebSocket(wsid: number): void;
}

/**
 * Only add methods required by tools/*.
 */
export type Context = Readonly<{
  isRunningPerformanceTrace(): boolean;
  setIsRunningPerformanceTrace(x: boolean): void;
  recordedTraces(): TraceResult[];
  storeTraceRecording(result: TraceResult): void;
  getSelectedPage(): Page;
  getDialog(): Dialog | undefined;
  clearDialog(): void;
  getPageByIdx(idx: number): Page;
  isPageSelected(page: Page): boolean;
  newPage(): Promise<Page>;
  closePage(pageIdx: number): Promise<void>;
  selectPage(page: Page): void;
  setNetworkConditions(conditions: string | null): void;
  setCpuThrottlingRate(rate: number): void;
  saveTemporaryFile(
    data: Uint8Array<ArrayBufferLike>,
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp',
  ): Promise<{filename: string}>;
  saveFile(
    data: Uint8Array<ArrayBufferLike>,
    filename: string,
  ): Promise<{filename: string}>;
  waitForEventsAfterAction(action: () => Promise<unknown>): Promise<void>;
  waitForTextOnPage(params: {
    text: string;
    timeout?: number | undefined;
  }): Promise<Element>;
  getDevToolsData(): Promise<DevToolsData>;
  /**
   * Returns a reqid for a cdpRequestId.
   */
  resolveCdpRequestId(cdpRequestId: string): number | undefined;
  /**
   * Get the debugger context for script/breakpoint management.
   */
  debuggerContext: DebuggerContext;
  /**
   * Get the initiator (call stack) for a network request.
   */
  getRequestInitiator(request: HTTPRequest): RequestInitiator | undefined;
  /**
   * Get the initiator by request ID.
   */
  getRequestInitiatorById(requestId: number): RequestInitiator | undefined;
  /**
   * Get network request by ID.
   */
  getNetworkRequestById(reqid: number): HTTPRequest;
  /**
   * Get all WebSocket connections for the selected page.
   */
  getWebSocketConnections(includePreservedData?: boolean): WebSocketData[];
  /**
   * Get a WebSocket connection by stable ID.
   */
  getWebSocketById(wsid: number): WebSocketData;
  /**
   * Get stable ID for a WebSocket connection.
   */
  getWebSocketStableId(ws: WebSocketData): number;
  /**
   * Cache traffic summary for a WebSocket connection.
   */
  cacheTrafficSummary(wsid: number, summary: TrafficSummary): void;
  /**
   * Get cached traffic summary for a WebSocket connection.
   */
  getCachedTrafficSummary(wsid: number): TrafficSummary | undefined;
  /**
   * Get the currently selected frame (or main frame if none selected).
   */
  getSelectedFrame(): Frame;
  /**
   * Select a specific frame for code execution.
   */
  selectFrame(frame: Frame): void;
  /**
   * Reset frame selection back to the main frame.
   */
  resetSelectedFrame(): void;
}>;

export function defineTool<Schema extends zod.ZodRawShape>(
  definition: ToolDefinition<Schema>,
) {
  return definition;
}

export const CLOSE_PAGE_ERROR =
  'The last open page cannot be closed. It is fine to keep it open.';

export const timeoutSchema = {
  timeout: zod
    .number()
    .int()
    .optional()
    .describe(
      `Maximum wait time in milliseconds. If set to 0, the default timeout will be used.`,
    )
    .transform(value => {
      return value && value <= 0 ? undefined : value;
    }),
};
