/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  BrowserContext,
  CDPSession,
  Frame,
  Page,
} from './third_party/index.js';

/**
 * CDP Session cache layer for Playwright/Patchright.
 *
 * In Puppeteer, `page._client()` is synchronous and returns the same session.
 * In Playwright, `page.context().newCDPSession(page)` is async and creates
 * a new session each time. This provider caches sessions per Page/Frame.
 */
export class CdpSessionProvider {
  #pageSessions = new WeakMap<Page, CDPSession>();
  #frameSessions = new WeakMap<Frame, CDPSession>();
  #context: BrowserContext;

  constructor(context: BrowserContext) {
    this.#context = context;
  }

  /**
   * Get a cached CDP session for a page, creating one if needed.
   */
  async getSession(pageOrFrame: Page): Promise<CDPSession>;
  async getSession(pageOrFrame: Frame): Promise<CDPSession>;
  async getSession(pageOrFrame: Page | Frame): Promise<CDPSession> {
    // Check if it's a Page (has context() method that returns BrowserContext)
    if ('context' in pageOrFrame && typeof pageOrFrame.context === 'function') {
      // It could be either Page or Frame - check for mainFrame to distinguish
      if ('mainFrame' in pageOrFrame) {
        return this.#getPageSession(pageOrFrame as Page);
      }
    }
    return this.#getFrameSession(pageOrFrame as Frame);
  }

  async #getPageSession(page: Page): Promise<CDPSession> {
    const cached = this.#pageSessions.get(page);
    if (cached) {
      return cached;
    }
    const session = await this.#context.newCDPSession(page);
    this.#pageSessions.set(page, session);
    return session;
  }

  async #getFrameSession(frame: Frame): Promise<CDPSession> {
    const cached = this.#frameSessions.get(frame);
    if (cached) {
      return cached;
    }
    // Playwright's newCDPSession accepts Frame directly for OOPIFs
    const session = await this.#context.newCDPSession(frame);
    this.#frameSessions.set(frame, session);
    return session;
  }

  /**
   * Invalidate cached session for a page or frame.
   * Call this when the page/frame is closed or navigated.
   */
  invalidate(pageOrFrame: Page | Frame): void {
    if ('mainFrame' in pageOrFrame) {
      const session = this.#pageSessions.get(pageOrFrame as Page);
      if (session) {
        void session.detach().catch(() => undefined);
        this.#pageSessions.delete(pageOrFrame as Page);
      }
    } else {
      const session = this.#frameSessions.get(pageOrFrame as Frame);
      if (session) {
        void session.detach().catch(() => undefined);
        this.#frameSessions.delete(pageOrFrame as Frame);
      }
    }
  }
}
