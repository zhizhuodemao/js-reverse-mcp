/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AggregatedIssue,
  Common,
} from '../node_modules/chrome-devtools-frontend/mcp/mcp.js';
import {
  IssueAggregatorEvents,
  IssuesManagerEvents,
  createIssuesFromProtocolIssue,
  IssueAggregator,
} from '../node_modules/chrome-devtools-frontend/mcp/mcp.js';

import {FakeIssuesManager} from './DevtoolsUtils.js';
import {features} from './features.js';
import {logger} from './logger.js';
import type {
  CDPSession,
  ConsoleMessage,
  Protocol,
  Target,
} from './third_party/index.js';
import {
  type Browser,
  type Frame,
  type Handler,
  type HTTPRequest,
  type Page,
  type PageEvents as PuppeteerPageEvents,
} from './third_party/index.js';

/**
 * Initiator information for a network request.
 * Contains the call stack when the request was initiated.
 */
export interface RequestInitiator {
  type:
    | 'parser'
    | 'script'
    | 'preload'
    | 'SignedExchange'
    | 'preflight'
    | 'other';
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  stack?: {
    callFrames: Array<{
      functionName: string;
      scriptId: string;
      url: string;
      lineNumber: number;
      columnNumber: number;
    }>;
    parent?: {
      callFrames: Array<{
        functionName: string;
        scriptId: string;
        url: string;
        lineNumber: number;
        columnNumber: number;
      }>;
    };
  };
}

interface PageEvents extends PuppeteerPageEvents {
  issue: AggregatedIssue;
}

export type ListenerMap<EventMap extends PageEvents = PageEvents> = {
  [K in keyof EventMap]?: (event: EventMap[K]) => void;
};

function createIdGenerator() {
  let i = 1;
  return () => {
    if (i === Number.MAX_SAFE_INTEGER) {
      i = 0;
    }
    return i++;
  };
}

export const stableIdSymbol = Symbol('stableIdSymbol');
type WithSymbolId<T> = T & {
  [stableIdSymbol]?: number;
};

export class PageCollector<T> {
  #browser: Browser;
  #listenersInitializer: (
    collector: (item: T) => void,
  ) => ListenerMap<PageEvents>;
  #listeners = new WeakMap<Page, ListenerMap>();
  #maxNavigationSaved = 3;
  #includeAllPages?: boolean;

  /**
   * This maps a Page to a list of navigations with a sub-list
   * of all collected resources.
   * The newer navigations come first.
   */
  protected storage = new WeakMap<Page, Array<Array<WithSymbolId<T>>>>();

  constructor(
    browser: Browser,
    listeners: (collector: (item: T) => void) => ListenerMap<PageEvents>,
    includeAllPages?: boolean,
  ) {
    this.#browser = browser;
    this.#listenersInitializer = listeners;
    this.#includeAllPages = includeAllPages;
  }

  async init() {
    // @ts-expect-error includeAllPages param may not exist in older puppeteer-core
    const pages = await this.#browser.pages(this.#includeAllPages);
    for (const page of pages) {
      this.addPage(page);
    }

    this.#browser.on('targetcreated', this.#onTargetCreated);
    this.#browser.on('targetdestroyed', this.#onTargetDestroyed);
  }

  dispose() {
    this.#browser.off('targetcreated', this.#onTargetCreated);
    this.#browser.off('targetdestroyed', this.#onTargetDestroyed);
  }

  #onTargetCreated = async (target: Target) => {
    const page = await target.page();
    if (!page) {
      return;
    }
    this.addPage(page);
  };

  #onTargetDestroyed = async (target: Target) => {
    const page = await target.page();
    if (!page) {
      return;
    }
    this.cleanupPageDestroyed(page);
  };

  public addPage(page: Page) {
    this.#initializePage(page);
  }

  #initializePage(page: Page) {
    if (this.storage.has(page)) {
      return;
    }
    const idGenerator = createIdGenerator();
    const storedLists: Array<Array<WithSymbolId<T>>> = [[]];
    this.storage.set(page, storedLists);

    const listeners = this.#listenersInitializer(value => {
      const withId = value as WithSymbolId<T>;
      withId[stableIdSymbol] = idGenerator();

      const navigations = this.storage.get(page) ?? [[]];
      navigations[0].push(withId);
    });

    listeners['framenavigated'] = (frame: Frame) => {
      // Only split the storage on main frame navigation
      if (frame !== page.mainFrame()) {
        return;
      }
      this.splitAfterNavigation(page);
    };

    for (const [name, listener] of Object.entries(listeners)) {
      page.on(name, listener as Handler<unknown>);
    }

    this.#listeners.set(page, listeners);
  }

  protected splitAfterNavigation(page: Page) {
    const navigations = this.storage.get(page);
    if (!navigations) {
      return;
    }
    // Add the latest navigation first
    navigations.unshift([]);
    navigations.splice(this.#maxNavigationSaved);
  }

  protected cleanupPageDestroyed(page: Page) {
    const listeners = this.#listeners.get(page);
    if (listeners) {
      for (const [name, listener] of Object.entries(listeners)) {
        page.off(name, listener as Handler<unknown>);
      }
    }
    this.storage.delete(page);
  }

  getData(page: Page, includePreservedData?: boolean): T[] {
    const navigations = this.storage.get(page);
    if (!navigations) {
      return [];
    }

    if (!includePreservedData) {
      return navigations[0];
    }

    const data: T[] = [];
    for (let index = this.#maxNavigationSaved; index >= 0; index--) {
      if (navigations[index]) {
        data.push(...navigations[index]);
      }
    }
    return data;
  }

  getIdForResource(resource: WithSymbolId<T>): number {
    return resource[stableIdSymbol] ?? -1;
  }

  getById(page: Page, stableId: number): T {
    const navigations = this.storage.get(page);
    if (!navigations) {
      throw new Error('No requests found for selected page');
    }

    const item = this.find(page, item => item[stableIdSymbol] === stableId);

    if (item) {
      return item;
    }

    throw new Error('Request not found for selected page');
  }

  find(
    page: Page,
    filter: (item: WithSymbolId<T>) => boolean,
  ): WithSymbolId<T> | undefined {
    const navigations = this.storage.get(page);
    if (!navigations) {
      return;
    }

    for (const navigation of navigations) {
      const item = navigation.find(filter);
      if (item) {
        return item;
      }
    }
    return;
  }
}

export class ConsoleCollector extends PageCollector<
  ConsoleMessage | Error | AggregatedIssue
> {
  #subscribedPages = new WeakMap<Page, PageIssueSubscriber>();

  override addPage(page: Page): void {
    super.addPage(page);
    if (!features.issues) {
      return;
    }
    if (!this.#subscribedPages.has(page)) {
      const subscriber = new PageIssueSubscriber(page);
      this.#subscribedPages.set(page, subscriber);
      void subscriber.subscribe();
    }
  }

  protected override cleanupPageDestroyed(page: Page): void {
    super.cleanupPageDestroyed(page);
    this.#subscribedPages.get(page)?.unsubscribe();
    this.#subscribedPages.delete(page);
  }
}

class PageIssueSubscriber {
  #issueManager = new FakeIssuesManager();
  #issueAggregator = new IssueAggregator(this.#issueManager);
  #seenKeys = new Set<string>();
  #seenIssues = new Set<AggregatedIssue>();
  #page: Page;
  #session: CDPSession;

  constructor(page: Page) {
    this.#page = page;
    // @ts-expect-error use existing CDP client (internal Puppeteer API).
    this.#session = this.#page._client() as CDPSession;
  }

  #resetIssueAggregator() {
    this.#issueManager = new FakeIssuesManager();
    if (this.#issueAggregator) {
      this.#issueAggregator.removeEventListener(
        IssueAggregatorEvents.AGGREGATED_ISSUE_UPDATED,
        this.#onAggregatedissue,
      );
    }
    this.#issueAggregator = new IssueAggregator(this.#issueManager);

    this.#issueAggregator.addEventListener(
      IssueAggregatorEvents.AGGREGATED_ISSUE_UPDATED,
      this.#onAggregatedissue,
    );
  }

  async subscribe() {
    this.#resetIssueAggregator();
    this.#page.on('framenavigated', this.#onFrameNavigated);
    this.#session.on('Audits.issueAdded', this.#onIssueAdded);
    try {
      await this.#session.send('Audits.enable');
    } catch (error) {
      logger('Error subscribing to issues', error);
    }
  }

  unsubscribe() {
    this.#seenKeys.clear();
    this.#seenIssues.clear();
    this.#page.off('framenavigated', this.#onFrameNavigated);
    this.#session.off('Audits.issueAdded', this.#onIssueAdded);
    if (this.#issueAggregator) {
      this.#issueAggregator.removeEventListener(
        IssueAggregatorEvents.AGGREGATED_ISSUE_UPDATED,
        this.#onAggregatedissue,
      );
    }
    void this.#session.send('Audits.disable').catch(() => {
      // might fail.
    });
  }

  #onAggregatedissue = (
    event: Common.EventTarget.EventTargetEvent<AggregatedIssue>,
  ) => {
    if (this.#seenIssues.has(event.data)) {
      return;
    }
    this.#seenIssues.add(event.data);
    this.#page.emit('issue', event.data);
  };

  // On navigation, we reset issue aggregation.
  #onFrameNavigated = (frame: Frame) => {
    // Only split the storage on main frame navigation
    if (frame !== frame.page().mainFrame()) {
      return;
    }
    this.#seenKeys.clear();
    this.#seenIssues.clear();
    this.#resetIssueAggregator();
  };

  #onIssueAdded = (data: Protocol.Audits.IssueAddedEvent) => {
    try {
      const inspectorIssue = data.issue;
      // @ts-expect-error Types of protocol from Puppeteer and CDP are
      // incomparable for InspectorIssueCode, one is union, other is enum.
      const issue = createIssuesFromProtocolIssue(null, inspectorIssue)[0];
      if (!issue) {
        logger('No issue mapping for for the issue: ', inspectorIssue.code);
        return;
      }

      const primaryKey = issue.primaryKey();
      if (this.#seenKeys.has(primaryKey)) {
        return;
      }
      this.#seenKeys.add(primaryKey);
      this.#issueManager.dispatchEventToListeners(
        IssuesManagerEvents.ISSUE_ADDED,
        {
          issue,
          // @ts-expect-error We don't care that issues model is null
          issuesModel: null,
        },
      );
    } catch (error) {
      logger('Error creating a new issue', error);
    }
  };
}

export class NetworkCollector extends PageCollector<HTTPRequest> {
  #initiators = new WeakMap<Page, Map<string, RequestInitiator>>();
  #cdpListeners = new WeakMap<
    Page,
    (event: Protocol.Network.RequestWillBeSentEvent) => void
  >();

  constructor(
    browser: Browser,
    listeners: (
      collector: (item: HTTPRequest) => void,
    ) => ListenerMap<PageEvents> = collect => {
      return {
        request: req => {
          collect(req);
        },
      } as ListenerMap;
    },
    includeAllPages?: boolean,
  ) {
    super(browser, listeners, includeAllPages);
  }

  override addPage(page: Page): void {
    super.addPage(page);
    this.#setupInitiatorCollection(page);
  }

  #setupInitiatorCollection(page: Page): void {
    if (this.#initiators.has(page)) {
      return;
    }

    const initiatorMap = new Map<string, RequestInitiator>();
    this.#initiators.set(page, initiatorMap);

    // Listen to CDP events for initiator info
    const onRequestWillBeSent = (
      event: Protocol.Network.RequestWillBeSentEvent,
    ): void => {
      if (event.initiator) {
        initiatorMap.set(event.requestId, event.initiator as RequestInitiator);
      }
    };

    this.#cdpListeners.set(page, onRequestWillBeSent);

    // @ts-expect-error _client is internal Puppeteer API
    const client = page._client() as CDPSession;
    client.on('Network.requestWillBeSent', onRequestWillBeSent);
  }

  protected override cleanupPageDestroyed(page: Page): void {
    super.cleanupPageDestroyed(page);

    const listener = this.#cdpListeners.get(page);
    if (listener) {
      try {
        // @ts-expect-error _client is internal Puppeteer API
        const client = page._client() as CDPSession;
        client.off('Network.requestWillBeSent', listener);
      } catch {
        // Page might already be closed
      }
    }
    this.#cdpListeners.delete(page);
    this.#initiators.delete(page);
  }

  /**
   * Get the initiator info for a request.
   * @param page The page the request belongs to
   * @param request The HTTP request
   * @returns The initiator info or undefined if not found
   */
  getInitiator(page: Page, request: HTTPRequest): RequestInitiator | undefined {
    const initiatorMap = this.#initiators.get(page);
    if (!initiatorMap) {
      return undefined;
    }
    // @ts-expect-error id is internal Puppeteer API
    const requestId = request.id as string;
    return initiatorMap.get(requestId);
  }

  /**
   * Get initiator by CDP request ID.
   */
  getInitiatorByRequestId(
    page: Page,
    requestId: string,
  ): RequestInitiator | undefined {
    const initiatorMap = this.#initiators.get(page);
    return initiatorMap?.get(requestId);
  }

  override splitAfterNavigation(page: Page) {
    const navigations = this.storage.get(page) ?? [];
    if (!navigations) {
      return;
    }

    const requests = navigations[0];

    const lastRequestIdx = requests.findLastIndex(request => {
      return request.frame() === page.mainFrame()
        ? request.isNavigationRequest()
        : false;
    });

    // Keep all requests since the last navigation request including that
    // navigation request itself.
    // Keep the reference
    if (lastRequestIdx !== -1) {
      const fromCurrentNavigation = requests.splice(lastRequestIdx);
      navigations.unshift(fromCurrentNavigation);
    } else {
      navigations.unshift([]);
    }

    // Clear old initiator data on navigation
    const initiatorMap = this.#initiators.get(page);
    if (initiatorMap) {
      initiatorMap.clear();
    }
  }
}
