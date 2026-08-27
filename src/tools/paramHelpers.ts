/**
 * @license
 * Copyright 2026
 * SPDX-License-Identifier: Apache-2.0
 */

import {zod} from '../third_party/index.js';

/**
 * Normalize boolean parameters from MCP clients.
 *
 * Some MCP clients (including OpenCode) serialize boolean tool arguments as the
 * strings "true"/"false" instead of real JSON booleans. A strict zod.boolean()
 * rejects those, so tools like evaluate_script(mainWorld) and
 * hook_function(persistent) fail with a validation error. This preprocessor
 * coerces the common string forms back to booleans before validation and leaves
 * any other value untouched so zod still rejects genuinely invalid input.
 *
 * Usage: boolParam() instead of zod.boolean()
 * Example: clear: boolParam().optional().default(false)
 */
export function boolParam() {
  return zod.preprocess(val => {
    if (typeof val === 'string') {
      const lower = val.trim().toLowerCase();
      if (lower === 'true') return true;
      if (lower === 'false') return false;
      return val;
    }
    return val;
  }, zod.boolean());
}

/**
 * Normalize integer parameters where 0 means "omitted".
 *
 * MCP clients may send optional integer ids as 0 when the user omits them.
 * This coerces 0 (and the string "0") to undefined so .optional() fields behave
 * as if the argument was not passed. It also coerces numeric strings like "12"
 * to numbers, matching how clients sometimes stringify arguments.
 *
 * Usage: intParam().optional()
 */
export function intParam() {
  return zod.preprocess(val => {
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (trimmed === '' || trimmed === '0') return undefined;
      const num = Number(trimmed);
      return Number.isFinite(num) ? num : val;
    }
    if (val === 0) return undefined;
    return val;
  }, zod.number().int().optional());
}

/**
 * Normalize string parameters where an empty/whitespace string means "omitted".
 *
 * MCP clients may send optional string params as "" when the user omits them.
 * A strict zod.string().min(1) rejects that, so this coerces empty/whitespace
 * strings to undefined for .optional() fields.
 *
 * Usage: stringParam().optional()  (optional can be chained externally;
 * the inner schema already accepts undefined, so double-optional is harmless)
 */
export function stringParam() {
  return zod.preprocess(
    val => (typeof val === 'string' && val.trim() === '' ? undefined : val),
    zod.string().optional(),
  );
}
