/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import type {CdpSessionProvider} from '../src/CdpSessionProvider.js';
import {NetworkCollector} from '../src/PageCollector.js';
import type {
  BrowserContext,
  HTTPRequest,
  Page,
} from '../src/third_party/index.js';

function createFakePage(): {page: Page; mainFrame: object} {
  const listeners = new Map<string, Array<(arg: unknown) => void>>();
  const mainFrame = {id: 'main'};
  const page = {
    on(event: string, cb: (arg: unknown) => void) {
      const arr = listeners.get(event) ?? [];
      arr.push(cb);
      listeners.set(event, arr);
      return page;
    },
    off() {
      return page;
    },
    mainFrame: () => mainFrame,
    emit(event: string, arg: unknown) {
      for (const cb of listeners.get(event) ?? []) {
        cb(arg);
      }
    },
  };
  return {page: page as unknown as Page, mainFrame};
}

function createFakeRequest(url: string, frame: object): HTTPRequest {
  return {
    url: () => url,
    method: () => 'POST',
    isNavigationRequest: () => false,
    frame: () => frame,
  } as unknown as HTTPRequest;
}

function createCollector(): NetworkCollector {
  return new NetworkCollector(
    {} as unknown as BrowserContext,
    {} as unknown as CdpSessionProvider,
  );
}

function createFakeCdpSession() {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const session = {
    on(event: string, cb: (payload: unknown) => void) {
      const arr = handlers.get(event) ?? [];
      arr.push(cb);
      handlers.set(event, arr);
      return session;
    },
    off() {
      return session;
    },
    send: async () => undefined,
    emit(event: string, payload: unknown) {
      for (const cb of handlers.get(event) ?? []) {
        cb(payload);
      }
    },
  };
  return session;
}

const flushMicrotasks = () => new Promise(resolve => setTimeout(resolve, 0));

test('preserved requests survive more than the old navigation window', () => {
  const collector = createCollector();
  const {page, mainFrame} = createFakePage();
  collector.addPage(page);

  // A request that belongs to the current navigation (e.g. the POST that
  // triggers a redirect). Its frame is not the main frame, so it is never
  // treated as a navigation request.
  const subframe = {id: 'sub'};
  const bundle = createFakeRequest('https://x/assets/js/bundle', subframe);
  (page as unknown as {emit(e: string, a: unknown): void}).emit(
    'request',
    bundle,
  );

  // Five subsequent main-frame navigations with no captured navigation request
  // — each pushes an empty bucket, which under the old fixed 4-bucket read
  // window would evict the bundle request entirely.
  for (let i = 0; i < 5; i++) {
    (page as unknown as {emit(e: string, a: unknown): void}).emit(
      'framenavigated',
      mainFrame,
    );
  }

  const preserved = collector.getData(page, true);
  assert.ok(
    preserved.includes(bundle),
    'preserved view should still reach the bundle request after 5 navigations',
  );

  const currentOnly = collector.getData(page, false);
  assert.ok(
    !currentOnly.includes(bundle),
    'default view should only show the current navigation',
  );
});

test('evicts the oldest requests once past the retention cap', () => {
  const collector = createCollector();
  const {page, mainFrame} = createFakePage();
  collector.addPage(page);
  const emit = (event: string, arg: unknown) =>
    (page as unknown as {emit(e: string, a: unknown): void}).emit(event, arg);
  const subframe = {id: 'sub'};

  let firstRoundReq: HTTPRequest | undefined;
  let lastRoundReq: HTTPRequest | undefined;

  // Six navigations of 1000 requests each = 6000 retained records; the cap is
  // 5000, so the oldest navigation bucket must be evicted.
  for (let round = 0; round < 6; round++) {
    for (let i = 0; i < 1000; i++) {
      const req = createFakeRequest(`https://x/r${round}-${i}`, subframe);
      if (round === 0 && i === 0) {
        firstRoundReq = req;
      }
      if (round === 5 && i === 0) {
        lastRoundReq = req;
      }
      emit('request', req);
    }
    emit('framenavigated', mainFrame);
  }

  const all = collector.getData(page, true);
  assert.equal(all.length, 5000, 'retained records should be capped at 5000');
  assert.ok(
    !all.includes(firstRoundReq as HTTPRequest),
    'the oldest navigation bucket should be evicted',
  );
  assert.ok(
    all.includes(lastRoundReq as HTTPRequest),
    'the newest navigations should be retained',
  );
});

test('getInitiator recovers via URL+method when the requestId mapping lost the race', async () => {
  const {page} = createFakePage();
  const cdp = createFakeCdpSession();
  const collector = new NetworkCollector(
    {pages: () => [page]} as unknown as BrowserContext,
    {getSession: async () => cdp} as unknown as CdpSessionProvider,
  );
  collector.addPage(page);
  await collector.initCdp();
  await flushMicrotasks(); // let the fire-and-forget CDP setup finish

  // The CDP requestWillBeSent event arrives before the Playwright request is in
  // storage, so the requestId mapping never tags the request object.
  cdp.emit('Network.requestWillBeSent', {
    requestId: 'req-1',
    request: {url: 'https://x/api', method: 'POST'},
    initiator: {
      type: 'script',
      stack: {
        callFrames: [
          {
            functionName: 'doFetch',
            scriptId: '1',
            url: 'https://x/page1.html',
            lineNumber: 1,
            columnNumber: 1,
          },
        ],
      },
    },
  });

  // createFakeRequest uses method POST; cdpRequestIdSymbol was never set, so the
  // requestId path yields nothing and the URL+method fallback must recover it.
  const request = createFakeRequest('https://x/api', {id: 'sub'});
  const initiator = collector.getInitiator(page, request);

  assert.ok(
    initiator,
    'initiator should be recovered via the URL+method fallback',
  );
  assert.equal(initiator?.type, 'script');
  assert.equal(initiator?.stack?.callFrames[0].functionName, 'doFetch');
});
