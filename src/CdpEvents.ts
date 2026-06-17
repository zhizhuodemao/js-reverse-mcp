/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {CDPSession} from './third_party/index.js';

type CdpEventListener = (payload: unknown) => void;
type CdpEventRegistrar = (
  eventName: string,
  listener: CdpEventListener,
) => CDPSession;

export function addCdpEventListener(
  session: CDPSession,
  eventName: string,
  listener: unknown,
): void {
  const onCdpEvent = session.on.bind(session) as unknown as CdpEventRegistrar;
  onCdpEvent(eventName, listener as CdpEventListener);
}

export function removeCdpEventListener(
  session: CDPSession,
  eventName: string,
  listener: unknown,
): void {
  const offCdpEvent = session.off.bind(session) as unknown as CdpEventRegistrar;
  offCdpEvent(eventName, listener as CdpEventListener);
}
