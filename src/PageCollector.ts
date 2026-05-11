/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Protocol} from 'devtools-protocol';

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

import type {CdpSessionProvider} from './CdpSessionProvider.js';
import {FakeIssuesManager} from './DevtoolsUtils.js';
import {features} from './features.js';
import {logger} from './logger.js';
import type {
  BrowserContext,
  CDPSession,
  ConsoleMessage,
  Frame,
  HTTPRequest,
  Page,
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

// Playwright page events relevant for collection
interface PageEvents {
  console: ConsoleMessage;
  pageerror: Error;
  request: HTTPRequest;
  requestfailed: HTTPRequest;
  requestfinished: HTTPRequest;
  response: import('./third_party/index.js').Response;
  framenavigated: Frame;
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
  #context: BrowserContext;
  #listenersInitializer: (
    collector: (item: T) => void,
  ) => ListenerMap<PageEvents>;
  #listeners = new WeakMap<Page, ListenerMap>();
  #maxNavigationSaved = 3;
  #maxItemsPerNavigation = 1000;

  /**
   * This maps a Page to a list of navigations with a sub-list
   * of all collected resources.
   * The newer navigations come first.
   */
  protected storage = new WeakMap<Page, Array<Array<WithSymbolId<T>>>>();

  constructor(
    context: BrowserContext,
    listeners: (collector: (item: T) => void) => ListenerMap<PageEvents>,
  ) {
    this.#context = context;
    this.#listenersInitializer = listeners;
  }

  protected get context(): BrowserContext {
    return this.#context;
  }

  async init() {
    const pages = this.#context.pages();
    for (const page of pages) {
      this.addPage(page);
    }

    this.#context.on('page', this.#onPageCreated);
  }

  dispose() {
    this.#context.off('page', this.#onPageCreated);
  }

  #onPageCreated = (page: Page) => {
    this.addPage(page);
    page.on('close', () => {
      this.cleanupPageDestroyed(page);
    });
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
      if (navigations[0].length > this.#maxItemsPerNavigation) {
        navigations[0].shift();
      }
    });

    listeners['framenavigated'] = (frame: Frame) => {
      // Only split the storage on main frame navigation
      if (frame !== page.mainFrame()) {
        return;
      }
      this.splitAfterNavigation(page);
    };

    for (const [name, listener] of Object.entries(listeners)) {
      page.on(name as any, listener as any);
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
        page.off(name as any, listener as any);
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
  #sessionProvider: CdpSessionProvider;
  // Per-page issue collectors that feed into the PageCollector's storage
  #pageIssueCollectors = new WeakMap<Page, (issue: AggregatedIssue) => void>();
  #cdpReady = false;

  constructor(
    context: BrowserContext,
    sessionProvider: CdpSessionProvider,
    listeners: (
      collector: (item: ConsoleMessage | Error | AggregatedIssue) => void,
    ) => ListenerMap<PageEvents>,
  ) {
    // Wrap the original listener initializer to capture per-page collectors
    const wrappedListeners = (collector: (item: ConsoleMessage | Error | AggregatedIssue) => void) => {
      // Call the original to get the base listeners
      const baseListeners = listeners(collector);
      // The 'issue' key in baseListeners calls collector(event)
      // We'll also use this collector reference for PageIssueSubscriber
      return baseListeners;
    };
    super(context, wrappedListeners);
    this.#sessionProvider = sessionProvider;
  }

  override addPage(page: Page): void {
    super.addPage(page);
    // Only set up CDP issue subscriber if CDP has been initialized
    if (this.#cdpReady) {
      this.#setupIssueSubscriber(page);
    }
  }

  /**
   * Initialize CDP-dependent features (Audits.enable for issue collection).
   * Called lazily to avoid leaking CDP signals during navigation.
   */
  async initCdp(): Promise<void> {
    if (this.#cdpReady) return;
    this.#cdpReady = true;
    // Set up issue subscribers for all already-tracked pages
    for (const page of this.context.pages()) {
      if (this.storage.has(page)) {
        this.#setupIssueSubscriber(page);
      }
    }
  }

  #setupIssueSubscriber(page: Page): void {
    if (!features.issues) {
      return;
    }
    if (!this.#subscribedPages.has(page)) {
      // Create a direct collector that adds issues to this page's storage with stable IDs
      const idGen = createIdGenerator();
      const issueCollector = (issue: AggregatedIssue) => {
        const navigations = this.storage.get(page);
        if (navigations && navigations[0]) {
          const withId = issue as ConsoleMessage | Error | AggregatedIssue & {[stableIdSymbol]?: number};
          (withId as any)[stableIdSymbol] = idGen();
          navigations[0].push(withId as any);
        }
      };
      this.#pageIssueCollectors.set(page, issueCollector);
      const subscriber = new PageIssueSubscriber(page, this.#sessionProvider, issueCollector);
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
  #sessionProvider: CdpSessionProvider;
  #session: CDPSession | null = null;
  #onIssueCallback: (issue: AggregatedIssue) => void;

  constructor(page: Page, sessionProvider: CdpSessionProvider, onIssue: (issue: AggregatedIssue) => void) {
    this.#page = page;
    this.#sessionProvider = sessionProvider;
    this.#onIssueCallback = onIssue;
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
    try {
      this.#session = await this.#sessionProvider.getSession(this.#page);
      this.#session.on('Audits.issueAdded' as any, this.#onIssueAdded);
      await this.#session.send('Audits.enable');
    } catch (error) {
      logger('Error subscribing to issues', error);
    }
  }

  unsubscribe() {
    this.#seenKeys.clear();
    this.#seenIssues.clear();
    this.#page.off('framenavigated', this.#onFrameNavigated);
    if (this.#session) {
      this.#session.off('Audits.issueAdded' as any, this.#onIssueAdded);
    }
    if (this.#issueAggregator) {
      this.#issueAggregator.removeEventListener(
        IssueAggregatorEvents.AGGREGATED_ISSUE_UPDATED,
        this.#onAggregatedissue,
      );
    }
    if (this.#session) {
      void this.#session.send('Audits.disable').catch(() => {
        // might fail.
      });
    }
  }

  #onAggregatedissue = (
    event: Common.EventTarget.EventTargetEvent<AggregatedIssue>,
  ) => {
    if (this.#seenIssues.has(event.data)) {
      return;
    }
    this.#seenIssues.add(event.data);
    this.#onIssueCallback(event.data);
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
      // @ts-expect-error Types of protocol from Playwright and CDP are
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

const cdpRequestIdSymbol = Symbol('cdpRequestId');
type RequestWithCdpId = HTTPRequest & {
  [cdpRequestIdSymbol]?: string;
};

export class NetworkCollector extends PageCollector<HTTPRequest> {
  #initiators = new WeakMap<Page, Map<string, RequestInitiator>>();
  #cdpListeners = new WeakMap<Page, () => void>();
  #sessionProvider: CdpSessionProvider;
  #cdpReady = false;

  constructor(
    context: BrowserContext,
    sessionProvider: CdpSessionProvider,
    listeners?: (
      collector: (item: HTTPRequest) => void,
    ) => ListenerMap<PageEvents>,
  ) {
    super(
      context,
      listeners ??
        (collect => {
          return {
            request: req => {
              collect(req);
            },
          } as ListenerMap;
        }),
    );
    this.#sessionProvider = sessionProvider;
  }

  override addPage(page: Page): void {
    super.addPage(page);
    // Only set up CDP initiator collection if CDP has been initialized
    if (this.#cdpReady) {
      void this.#setupInitiatorCollection(page);
    }
  }

  /**
   * Initialize CDP-dependent features (initiator collection).
   * Called lazily to avoid leaking CDP signals during navigation.
   */
  async initCdp(): Promise<void> {
    if (this.#cdpReady) return;
    this.#cdpReady = true;
    // Set up CDP initiator collection for all already-tracked pages
    for (const page of this.context.pages()) {
      if (this.storage.has(page)) {
        void this.#setupInitiatorCollection(page);
      }
    }
  }

  async #setupInitiatorCollection(page: Page): Promise<void> {
    if (this.#initiators.has(page)) {
      return;
    }

    const initiatorMap = new Map<string, RequestInitiator>();
    this.#initiators.set(page, initiatorMap);

    try {
      const client = await this.#sessionProvider.getSession(page);
      await client.send('Network.enable');

      // Listen to CDP events for initiator info and request ID mapping
      const onRequestWillBeSent = (
        event: Protocol.Network.RequestWillBeSentEvent,
      ): void => {
        if (event.initiator) {
          initiatorMap.set(event.requestId, event.initiator as RequestInitiator);
        }

        // Map CDP request ID to Playwright Request via URL+method matching
        // This allows us to correlate Playwright Request objects with CDP request IDs
        const navigations = this.storage.get(page);
        if (navigations) {
          for (const navigation of navigations) {
            for (const request of navigation) {
              const req = request as RequestWithCdpId;
              if (
                !req[cdpRequestIdSymbol] &&
                req.url() === event.request.url &&
                req.method() === event.request.method
              ) {
                req[cdpRequestIdSymbol] = event.requestId;
                break;
              }
            }
          }
        }
      };

      client.on('Network.requestWillBeSent' as any, onRequestWillBeSent);

      const cleanup = () => {
        client.off('Network.requestWillBeSent' as any, onRequestWillBeSent);
      };
      this.#cdpListeners.set(page, cleanup);
    } catch {
      // Page might already be closed
    }
  }

  protected override cleanupPageDestroyed(page: Page): void {
    super.cleanupPageDestroyed(page);

    const cleanup = this.#cdpListeners.get(page);
    if (cleanup) {
      try {
        cleanup();
      } catch {
        // Page might already be closed
      }
    }
    this.#cdpListeners.delete(page);
    this.#initiators.delete(page);
  }

  /**
   * Get the CDP request ID for a request.
   */
  getCdpRequestId(request: HTTPRequest): string | undefined {
    return (request as RequestWithCdpId)[cdpRequestIdSymbol];
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
    const requestId = this.getCdpRequestId(request);
    if (!requestId) {
      return undefined;
    }
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
      try {
        return request.frame() === page.mainFrame()
          ? request.isNavigationRequest()
          : false;
      } catch {
        // frame() can throw for service worker requests
        return false;
      }
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
