/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {CDPConnection as devtools} from '../node_modules/chrome-devtools-frontend/mcp/mcp.js';

import {addCdpEventListener} from './CdpEvents.js';
import type {CDPSession} from './third_party/index.js';

type CdpSend = (method: string, params: unknown) => Promise<unknown>;

/**
 * Adapts a Playwright CDPSession to the DevTools CDPConnection interface.
 *
 * In Playwright, CDPSession doesn't expose connection(), id(), or wildcard event listeners.
 * Instead we use CDP Target.attachToTarget to manage sub-sessions, and register
 * specific event handlers for forwarding.
 *
 * For now, this is a simplified implementation that only supports the root session.
 * Child session management (for OOPIFs) can be added later via Target.attachedToTarget events.
 */
export class PuppeteerDevToolsConnection implements devtools.CDPConnection {
  readonly #session: CDPSession;
  readonly #observers = new Set<devtools.CDPConnectionObserver>();
  readonly #sessionId: string;
  readonly #childSessions = new Map<string, CDPSession>();
  readonly #eventHandlers = new Map<string, (payload: unknown) => void>();

  constructor(session: CDPSession, sessionId?: string) {
    this.#session = session;
    this.#sessionId = sessionId ?? 'root';

    // Register CDP event forwarding for the main session
    this.#startForwardingCdpEvents(session, this.#sessionId);

    // Listen for child session attachment
    this.#session.on('Target.attachedToTarget', event => {
      const childSessionId = event.sessionId;
      // We can't create separate CDPSession objects from Playwright for auto-attached targets,
      // but we can track their session IDs for routing
      this.#childSessions.set(childSessionId, session);
    });

    this.#session.on('Target.detachedFromTarget', event => {
      this.#childSessions.delete(event.sessionId);
    });
  }

  send<T extends devtools.Command>(
    method: T,
    params: devtools.CommandParams<T>,
    sessionId: string | undefined,
  ): Promise<{result: devtools.CommandResult<T>} | {error: devtools.CDPError}> {
    if (sessionId === undefined) {
      throw new Error(
        'Attempting to send on the root session. This must not happen',
      );
    }

    // For the main session or child sessions, route through our CDP session
    const send = this.#session.send.bind(this.#session) as unknown as CdpSend;
    return send(method, params)
      .then(result => ({result: result as devtools.CommandResult<T>}))
      .catch((error: unknown) => ({error: error as devtools.CDPError}));
  }

  observe(observer: devtools.CDPConnectionObserver): void {
    this.#observers.add(observer);
  }

  unobserve(observer: devtools.CDPConnectionObserver): void {
    this.#observers.delete(observer);
  }

  #startForwardingCdpEvents(session: CDPSession, sessionId: string): void {
    // In Playwright, we can't use wildcard listeners like session.on('*', handler).
    // Instead, register handlers for commonly used CDP event domains.
    const cdpDomains: devtools.Event[] = [
      'Debugger.scriptParsed',
      'Debugger.paused',
      'Debugger.resumed',
      'Network.requestWillBeSent',
      'Network.responseReceived',
      'Network.loadingFinished',
      'Network.loadingFailed',
      'Network.webSocketCreated',
      'Network.webSocketClosed',
      'Network.webSocketFrameSent',
      'Network.webSocketFrameReceived',
      'Runtime.consoleAPICalled',
      'Runtime.exceptionThrown',
      'Page.frameNavigated',
      'Page.frameStartedNavigating',
      'Page.loadEventFired',
      'Page.domContentEventFired',
      'Audits.issueAdded',
      'Target.attachedToTarget',
      'Target.detachedFromTarget',
      'Target.receivedMessageFromTarget',
    ];

    for (const eventName of cdpDomains) {
      const handler = (event: unknown) => {
        this.#observers.forEach(observer =>
          observer.onEvent({
            method: eventName,
            sessionId,
            params: event as devtools.EventParams<typeof eventName>,
          }),
        );
      };
      this.#eventHandlers.set(`${sessionId}:${eventName}`, handler);
      addCdpEventListener(session, eventName, handler);
    }
  }
}
