/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {readConsoleBridgeLogs} from '../consoleBridge.js';
import {features} from '../features.js';
import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {boolParam} from './paramHelpers.js';
import {defineTool} from './ToolDefinition.js';
// Playwright's ConsoleMessage.type() returns a string union directly
type ConsoleResponseType = string;

const FILTERABLE_MESSAGE_TYPES: [
  ConsoleResponseType,
  ...ConsoleResponseType[],
] = [
  'log',
  'debug',
  'info',
  'error',
  'warn',
  'dir',
  'dirxml',
  'table',
  'trace',
  'clear',
  'startGroup',
  'startGroupCollapsed',
  'endGroup',
  'assert',
  'profile',
  'profileEnd',
  'count',
  'timeEnd',
  'verbose',
  'issue',
];

if (features.issues) {
  FILTERABLE_MESSAGE_TYPES.push('issue');
}

function formatBridgeMessage(log: {
  id: number;
  level: string;
  text: string;
  args: string[];
}): string {
  const text =
    log.text.length > 1000 ? `${log.text.slice(0, 1000)}...` : log.text;
  return `msgid=${log.id} [${log.level}] ${text} (${log.args.length} args)`;
}

export const listConsoleMessages = defineTool({
  name: 'list_console_messages',
  description:
    'List all console messages for the currently selected page since the last navigation. Pass msgid to get a single message by its ID.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {
    msgid: zod
      .preprocess(
        value => (value === 0 ? undefined : value),
        zod.number().int().positive().optional(),
      )
      .optional()
      .describe(
        'The msgid of a console message on the page from the listed console messages',
      ),
    pageSize: zod
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Maximum number of messages to return. When omitted, returns all messages.',
      ),
    pageIdx: zod
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Page number to return (0-based). When omitted, returns the first page.',
      ),
    types: zod
      .array(zod.enum(FILTERABLE_MESSAGE_TYPES))
      .optional()
      .describe(
        'Filter messages to only return messages of the specified console message types. When omitted or empty, returns all messages.',
      ),
    includePreservedMessages: boolParam()
      .default(false)
      .optional()
      .describe(
        'Set to true to return the preserved messages over the last 3 navigations.',
      ),
  },
  handler: async (request, response, context) => {
    if (request.params.msgid !== undefined) {
      const [bridgeLog] = await readConsoleBridgeLogs(
        context.getSelectedPage(),
        {
          id: request.params.msgid,
        },
      );
      if (bridgeLog) {
        response.appendResponseLine(`ID: ${bridgeLog.id}`);
        response.appendResponseLine(
          `Message: ${bridgeLog.level}> ${bridgeLog.text}`,
        );
        if (bridgeLog.args.length) {
          response.appendResponseLine('### Arguments');
          bridgeLog.args.forEach((arg, index) => {
            response.appendResponseLine(`Arg #${index}: ${arg}`);
          });
        }
        return;
      }
      response.attachConsoleMessage(request.params.msgid);
      return;
    }

    let bridgeLogs = await readConsoleBridgeLogs(context.getSelectedPage());
    if (request.params.types?.length) {
      const types = new Set(request.params.types);
      bridgeLogs = bridgeLogs.filter(log => types.has(log.level));
    }
    if (bridgeLogs.length) {
      const pageIdx = request.params.pageIdx ?? 0;
      const pageSize = request.params.pageSize ?? bridgeLogs.length;
      const start = pageIdx * pageSize;
      response.appendResponseLine('## Console messages');
      for (const log of bridgeLogs.slice(start, start + pageSize)) {
        response.appendResponseLine(formatBridgeMessage(log));
      }
      return;
    }

    response.setIncludeConsoleData(true, {
      pageSize: request.params.pageSize,
      pageIdx: request.params.pageIdx,
      types: request.params.types,
      includePreservedMessages: request.params.includePreservedMessages,
    });
  },
});
