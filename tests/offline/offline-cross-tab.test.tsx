import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ValidPayload } from '../../src/main';
import { createMockBrowserOpfs } from '../mocks/mockBrowserOpfs';
import { createSharedServerMockState } from '../mocks/serverMock';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import { advanceTime } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { getOpfsDirTree } from '../utils/persistentStorageOptimizationTestUtils';
import type {
  UpdateValueConflictOperations,
  UpdateValueOperations,
} from './offlineReplayTestShared';
import {
  docConflictSchema,
  docMutationInputSchema,
  docSchema,
} from './offlineTestShared';

/**
 * In-memory `BroadcastChannel` shared by every simulated tab. Like the real
 * one, a message is cloned, never delivered back to its sender, and delivered
 * asynchronously.
 */
class TestBroadcastChannel {
  static channels = new Map<string, Set<TestBroadcastChannel>>();
  readonly listeners = new Set<(event: { data: unknown }) => void>();
  readonly name: string;

  constructor(name: string) {
    this.name = name;
    const peers = TestBroadcastChannel.channels.get(name) ?? new Set();
    peers.add(this);
    TestBroadcastChannel.channels.set(name, peers);
  }

  addEventListener(
    _type: 'message',
    listener: (event: { data: unknown }) => void,
  ) {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: 'message',
    listener: (event: { data: unknown }) => void,
  ) {
    this.listeners.delete(listener);
  }

  postMessage(data: unknown) {
    for (const peer of TestBroadcastChannel.channels.get(this.name) ?? []) {
      if (peer === this) continue;
      const copy = structuredClone(data);
      setTimeout(() => {
        for (const listener of peer.listeners) listener({ data: copy });
      }, 0);
    }
  }

  close() {
    TestBroadcastChannel.channels.get(this.name)?.delete(this);
    this.listeners.clear();
  }
}

type LockCallback<T> = (lock: { name: string } | null) => T | Promise<T>;

/**
 * `navigator.locks` shared by every simulated tab, like the browser's lock
 * manager is shared by the tabs of an origin: a lock is held by one tab at a
 * time, other requests wait for it in order, and an `ifAvailable` request gets
 * `null` while another tab holds it.
 */
function createSharedLockManager() {
  const waitingByName = new Map<string, Array<() => void>>();

  async function request<T>(
    name: string,
    optionsOrCallback: LockCallback<T> | { ifAvailable?: boolean },
    callback?: LockCallback<T>,
  ): Promise<T> {
    const run =
      typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
    if (!run) throw new Error('navigator.locks.request needs a callback');
    const ifAvailable =
      typeof optionsOrCallback !== 'function' &&
      optionsOrCallback.ifAvailable === true;

    const waiting = waitingByName.get(name);
    if (waiting) {
      if (ifAvailable) return await run(null);
      await new Promise<void>((acquire) => {
        waiting.push(acquire);
      });
    } else {
      waitingByName.set(name, []);
    }

    try {
      return await run({ name });
    } finally {
      // Hand the lock straight to the next waiting request, if any
      const next = waitingByName.get(name)?.shift();
      if (next) next();
      else waitingByName.delete(name);
    }
  }

  return { request };
}

const sessionKey = 'cross-tab-session';
let network = createOfflineNetworkMock();
let serverCalls: string[] = [];
let sharedServer = createSharedServerMockState(1);
const openTabs: Array<{ close: () => void }> = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
  vi.stubGlobal('BroadcastChannel', TestBroadcastChannel);
  // Restored to the single-tab mock by `vitest.setup.ts` after each test
  Object.defineProperty(globalThis.navigator, 'locks', {
    value: createSharedLockManager(),
    writable: true,
    configurable: true,
  });
  setDocumentHidden(false);
  network = createOfflineNetworkMock();
  network.install();
  serverCalls = [];
  sharedServer = createSharedServerMockState(1);
  localStorage.clear();
});

afterEach(() => {
  for (const tab of openTabs.splice(0)) tab.close();
  TestBroadcastChannel.channels.clear();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function setDocumentHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', {
    value: hidden,
    writable: true,
    configurable: true,
  });
}

/**
 * Opens a simulated browser tab: a fresh module graph, so the offline session
 * coordinator and every store registry belong to this tab only, like in a real
 * browser. Tabs share `localStorage`, `BroadcastChannel`, the network, and the
 * server.
 *
 * Every tab reads the same `document.hidden`, so a tab opened with
 * `focused: false` only starts in the background; focus changes after that go
 * through `blurWindow` and `closeTabAndFocusRemaining`.
 *
 * With `uploads: true` the tab stores offline file uploads in OPFS, shared by
 * every tab like in a real browser (install it with `createMockBrowserOpfs`).
 *
 * `getIsOffline` replaces the app's connectivity check in this tab only.
 */
async function openTab(
  name: string,
  options: {
    focused: boolean;
    storeIds?: string[];
    uploads?: boolean;
    getIsOffline?: () => boolean;
  },
) {
  setDocumentHidden(!options.focused);
  vi.resetModules();
  const [
    { createStoreManager },
    { createDocumentStoreTestEnv },
    sessionModule,
    { opfsOfflineUploadAdapter },
  ] = await Promise.all([
    import('../../src/storeManager'),
    import('../mocks/documentStoreTestEnv'),
    import('../../src/persistentStorage/offline/sessionCoordinator'),
    import('../../src/persistentStorage/opfsOfflineUploadAdapter'),
  ]);

  const storeManager = createStoreManager<ValidPayload>({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: {
      network: options.getIsOffline
        ? { ...network.config, getIsOffline: options.getIsOffline }
        : network.config,
      ...(options.uploads
        ? {
            uploads: {
              adapter: opfsOfflineUploadAdapter,
              upload: ({ id }) => Promise.resolve(`server:${id}`),
            },
          }
        : {}),
    },
  });

  function createDocEnv(storeId: string) {
    const env = createDocumentStoreTestEnv<
      number,
      UpdateValueConflictOperations
    >(1, {
      id: storeId,
      getSessionKey: () => sessionKey,
      storeManager,
      sharedServerState: sharedServer,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              kind: 'update',
              execute: async ({ input }) => {
                serverCalls.push(
                  `tab ${name} sent ${storeId} = ${input.value}`,
                );
                await env.serverMock.delayedSetData(input.value);
                return input;
              },
              conflictHandling: {
                schema: docConflictSchema,
                // Negative values simulate an edit the server rejects.
                detectConflict: ({ input }) =>
                  input.value < 0 ? { reason: 'server-changed' } : null,
              },
            },
          },
        },
      },
    });
    return env;
  }

  const envs = new Map(
    (options.storeIds ?? ['doc']).map((storeId) => [
      storeId,
      createDocEnv(storeId),
    ]),
  );

  function getEnv(storeId = 'doc') {
    const env = envs.get(storeId);
    if (!env) throw new Error(`Store "${storeId}" is not open in tab ${name}`);
    return env;
  }

  const tab = {
    name,
    storeManager,
    getEnv,
    /** Queues an offline edit the way a user edit in this tab would. */
    async queueEdit(value: number, storeId = 'doc') {
      await getEnv(storeId).apiStore.performMutation({
        mutation: async () => {
          await getEnv(storeId).serverMock.delayedSetData(value);
          return value;
        },
        offline: { operation: 'updateValue', input: { value } },
      });
      await advanceTime(10);
    },
    /** Queues an offline edit with an attached file, like a form with a file input. */
    async queueEditWithFile(value: number, storeId = 'doc') {
      const mutation = getEnv(storeId).apiStore.performMutation({
        mutation: async () => {
          await getEnv(storeId).serverMock.delayedSetData(value);
          return value;
        },
        offline: { operation: 'updateValue', input: { value } },
        upload: {
          avatar: new File(['avatar'], 'avatar.txt', {
            type: 'text/plain',
            lastModified: 1,
          }),
        },
      });
      // Saving the file to OPFS takes a few timer ticks
      await advanceTime(100);
      await mutation;
    },
    close() {
      for (const env of envs.values()) env.apiStore.dispose();
      sessionModule.__resetSessionOfflineCoordinatorRegistryForTests();
      const index = openTabs.indexOf(tab);
      if (index >= 0) openTabs.splice(index, 1);
    },
  };
  openTabs.push(tab);
  await advanceTime(50);
  return tab;
}

/** Moves the whole browser window to the background (every tab loses focus). */
async function blurWindow() {
  setDocumentHidden(true);
  window.dispatchEvent(new Event('blur'));
  await advanceTime(10);
}

type Tab = Awaited<ReturnType<typeof openTab>>;

/** Closes `closing`, then the user focuses the window of the remaining tab. */
async function closeTabAndFocusRemaining(closing: Tab) {
  closing.close();
  await advanceTime(10);
  setDocumentHidden(false);
  window.dispatchEvent(new Event('focus'));
  await advanceTime(10);
}

type UpdateValueV2Operations = {
  updateValueV2: UpdateValueOperations['updateValue'];
};

/**
 * Opens a tab running a newer deploy of the app, where the document store's
 * offline operation was renamed to `updateValueV2`. The app does not set
 * `getAppVersion`, so this tab shares the offline session with older tabs.
 */
async function openNewVersionTab(name: string) {
  setDocumentHidden(true);
  vi.resetModules();
  const [
    { createStoreManager },
    { createDocumentStoreTestEnv },
    sessionModule,
  ] = await Promise.all([
    import('../../src/storeManager'),
    import('../mocks/documentStoreTestEnv'),
    import('../../src/persistentStorage/offline/sessionCoordinator'),
  ]);

  const storeManager = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: { network: network.config },
  });
  const env = createDocumentStoreTestEnv<number, UpdateValueV2Operations>(1, {
    id: 'doc',
    getSessionKey: () => sessionKey,
    storeManager,
    sharedServerState: sharedServer,
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        operations: {
          updateValueV2: {
            inputSchema: docMutationInputSchema,
            kind: 'update',
            execute: async ({ input }) => {
              serverCalls.push(`tab ${name} sent doc = ${input.value} (v2)`);
              await env.serverMock.delayedSetData(input.value);
              return input;
            },
          },
        },
      },
    },
  });

  const tab = {
    name,
    storeManager,
    async queueEdit(value: number) {
      await env.apiStore.performMutation({
        mutation: async () => {
          await env.serverMock.delayedSetData(value);
          return value;
        },
        offline: { operation: 'updateValueV2', input: { value } },
      });
      await advanceTime(10);
    },
    close() {
      env.apiStore.dispose();
      sessionModule.__resetSessionOfflineCoordinatorRegistryForTests();
      const index = openTabs.indexOf(tab);
      if (index >= 0) openTabs.splice(index, 1);
    },
  };
  openTabs.push(tab);
  await advanceTime(50);
  return tab;
}

/**
 * What each tab shows: whether it leads offline replay, and the session-wide
 * resolution and entity lists an app-wide offline panel renders.
 */
function describeTabs(...tabs: Array<Pick<Tab, 'name' | 'storeManager'>>) {
  return Object.fromEntries(
    tabs.map((tab) => [
      `tab ${tab.name}`,
      {
        leader: tab.storeManager.getOfflineStatus().isLeader,
        resolutions: tab.storeManager
          .getOfflineResolutions()
          .map((resolution) => `${resolution.storeName}: ${resolution.kind}`),
        entities: tab.storeManager
          .getOfflineEntities()
          .map((entity) => `${entity.storeName}: ${entity.syncState}`),
      },
    ]),
  );
}

test('a conflict created by another tab can be discarded after switching to this tab', async () => {
  network.setOffline();
  const tabA = await openTab('A', { focused: true });
  const tabB = await openTab('B', { focused: false });
  await blurWindow();

  // The user edits in tab A while offline. On reconnect tab A (the leader)
  // replays the edit and the server rejects it with a conflict.
  await tabA.queueEdit(-1);
  network.goOnline();
  await advanceTime(3_000);

  // Both tabs list the conflict, including the leader that created it: the
  // background tab's broadcasts must not wipe the leader's own list.
  expect(describeTabs(tabA, tabB)).toMatchInlineSnapshot(`
    tab A:
      entities: ['doc: resolution-required']
      leader: '✅'
      resolutions: ['doc: conflict']

    tab B:
      entities: ['doc: resolution-required']
      leader: '❌'
      resolutions: ['doc: conflict']
  `);

  // The user closes tab A and handles the conflict from tab B's offline panel.
  await closeTabAndFocusRemaining(tabA);
  expect(describeTabs(tabB)).toMatchInlineSnapshot(`
    tab B:
      entities: ['doc: resolution-required']
      leader: '✅'
      resolutions: ['doc: conflict']
  `);

  const [conflict] = tabB.storeManager.getOfflineResolutions();
  const result = await tabB.storeManager.resolveOfflineResolution(
    conflict?.id ?? 'missing',
    'discard',
  );
  await advanceTime(10);

  expect(result.ok).toBe(true);
  expect(describeTabs(tabB)).toMatchInlineSnapshot(`
    tab B:
      entities: []
      leader: '✅'
      resolutions: []
  `);
  // The conflict was detected before execute and the edit was discarded, so
  // nothing reached the server.
  expect(serverCalls).toMatchInlineSnapshot(`[]`);
});

test('an edit queued in a tab that was closed is sent by the remaining tab', async () => {
  network.setOffline();
  const tabA = await openTab('A', { focused: true });
  const tabB = await openTab('B', { focused: false });
  await blurWindow();

  // The user edits in tab A while offline, closes it, and keeps using tab B.
  await tabA.queueEdit(2);
  await closeTabAndFocusRemaining(tabA);

  // Tab B now leads, so it must send tab A's edit once the network is back.
  network.goOnline();
  await advanceTime(3_000);

  expect(serverCalls).toMatchInlineSnapshot(`['tab B sent doc = 2']`);
  expect(describeTabs(tabB)).toMatchInlineSnapshot(`
    tab B:
      entities: []
      leader: '✅'
      resolutions: []
  `);
});

test('an edit another tab already sent is not sent again after the leader tab closes', async () => {
  network.setOffline();
  const tabA = await openTab('A', { focused: true });
  await tabA.queueEdit(2);

  // Tab B opens while the edit is still queued, so it loads it from storage.
  const tabB = await openTab('B', { focused: false });
  await blurWindow();

  // Tab A leads and sends the edit on reconnect.
  network.goOnline();
  await advanceTime(3_000);
  expect(serverCalls).toMatchInlineSnapshot(`['tab A sent doc = 2']`);

  // The user closes tab A; tab B takes over. A later network drop and
  // recovery makes the new leader replay whatever it still has queued.
  await closeTabAndFocusRemaining(tabA);
  network.goOffline();
  await advanceTime(100);
  network.goOnline();
  await advanceTime(3_000);

  // The edit reached the server exactly once.
  expect(serverCalls).toMatchInlineSnapshot(`['tab A sent doc = 2']`);
  expect(describeTabs(tabB)).toMatchInlineSnapshot(`
    tab B:
      entities: []
      leader: '✅'
      resolutions: []
  `);
});

test('a tab opened in the background does not also send the queued edits', async () => {
  network.setOffline();
  const tabA = await openTab('A', { focused: true });
  await tabA.queueEdit(2);

  // A second tab opens in the background (e.g. a link opened in a new tab)
  // while tab A keeps the focus. Tab A stays the only leader.
  const tabB = await openTab('B', { focused: false });
  // Tab A still has the focus (`openTab` hid the shared document for tab B).
  setDocumentHidden(false);
  expect(describeTabs(tabA, tabB)).toMatchInlineSnapshot(`
    tab A:
      entities: ['doc: pending']
      leader: '✅'
      resolutions: []

    tab B:
      entities: ['doc: pending']
      leader: '❌'
      resolutions: []
  `);

  network.goOnline();
  await advanceTime(3_000);

  expect(serverCalls).toMatchInlineSnapshot(`['tab A sent doc = 2']`);
});

test('offline items of a store open only in another tab stay listed in every tab', async () => {
  network.setOffline();
  const tabA = await openTab('A', {
    focused: true,
    storeIds: ['doc', 'only-in-a'],
  });
  const tabB = await openTab('B', { focused: false });
  await blurWindow();

  // The user edits both stores in tab A, then edits the shared store in tab B.
  await tabA.queueEdit(2, 'only-in-a');
  await tabA.queueEdit(3);
  await tabB.queueEdit(4);

  // Tab B's broadcast only covers the store it has open, so neither tab loses
  // the edit pending on the store that is open only in tab A.
  expect(describeTabs(tabA, tabB)).toMatchInlineSnapshot(`
    tab A:
      entities: ['doc: pending', 'only-in-a: pending']
      leader: '✅'
      resolutions: []

    tab B:
      entities: ['doc: pending', 'only-in-a: pending']
      leader: '❌'
      resolutions: []
  `);

  // On reconnect the leader sends every edit, including the one queued in tab
  // B, in the order they were made.
  network.goOnline();
  await advanceTime(5_000);
  expect(serverCalls).toMatchInlineSnapshot(
    `['tab A sent only-in-a = 2', 'tab A sent doc = 3', 'tab A sent doc = 4']`,
  );
  expect(describeTabs(tabA, tabB)).toMatchInlineSnapshot(`
    tab A:
      entities: []
      leader: '✅'
      resolutions: []

    tab B:
      entities: []
      leader: '❌'
      resolutions: []
  `);
});

test('a tab opened later also lists offline items of a store open only in another tab', async () => {
  network.setOffline();
  const tabA = await openTab('A', {
    focused: true,
    storeIds: ['doc', 'only-in-a'],
  });

  // The user edits a store that only tab A has open, then opens a second tab
  // that only has the shared store.
  await tabA.queueEdit(2, 'only-in-a');
  const tabB = await openTab('B', { focused: false });

  // The new tab's offline panel also lists the pending edit of tab A's store.
  expect(describeTabs(tabB)).toMatchInlineSnapshot(`
    tab B:
      entities: ['only-in-a: pending']
      leader: '❌'
      resolutions: []
  `);
});

test('an older tab does not delete edits queued for an operation only a newer deploy knows', async () => {
  network.setOffline();
  const oldTab = await openTab('A', { focused: true });
  const newTab = await openNewVersionTab('B');
  await blurWindow();

  // A tab running the new deploy queues an edit for the renamed operation,
  // while the tab still running the old deploy leads.
  await newTab.queueEdit(5);

  // On reconnect the old leader cannot replay the unknown operation; it must
  // leave the edit in storage instead of dropping it.
  network.goOnline();
  await advanceTime(3_000);
  expect(serverCalls).toMatchInlineSnapshot(`[]`);

  // The user closes the old tab; the new tab leads and sends the edit after
  // the next network recovery.
  await closeTabAndFocusRemaining(oldTab);
  network.goOffline();
  await advanceTime(100);
  network.goOnline();
  await advanceTime(3_000);

  expect(serverCalls).toMatchInlineSnapshot(`['tab B sent doc = 5 (v2)']`);
  expect(describeTabs(newTab)).toMatchInlineSnapshot(`
    tab B:
      entities: []
      leader: '✅'
      resolutions: []
  `);
});

test('disposing a store does not bring back offline items another tab reported earlier', async () => {
  network.setOffline();
  const tabA = await openTab('A', { focused: true });
  const tabB = await openTab('B', { focused: false });
  await blurWindow();

  // The user edits in tab A while offline, closes it, and tab B sends the edit
  // once the network is back.
  await tabA.queueEdit(2);
  await closeTabAndFocusRemaining(tabA);
  network.goOnline();
  await advanceTime(3_000);
  expect(serverCalls).toMatchInlineSnapshot(`['tab B sent doc = 2']`);

  // Tab B then disposes the store (e.g. the user navigates away from the
  // screen that owns it). Tab A's old report of the pending edit must not
  // reappear in the session-wide lists.
  tabB.getEnv().apiStore.dispose();
  await advanceTime(10);

  expect(describeTabs(tabB)).toMatchInlineSnapshot(`
    tab B:
      entities: []
      leader: '✅'
      resolutions: []
  `);
});

test('the file attached to an edit queued in another tab is kept when the edit ends in a conflict', async () => {
  const opfs = createMockBrowserOpfs();
  network.setOffline();
  const tabA = await openTab('A', { focused: true, uploads: true });
  const tabB = await openTab('B', { focused: false, uploads: true });
  await blurWindow();

  // While offline the user submits an edit with an attached file in tab B,
  // then switches to tab A, which leads.
  await tabB.queueEditWithFile(-1);
  setDocumentHidden(false);
  expect(getOpfsDirTree(opfs)).toContain('binary.blob');

  // On reconnect tab A replays tab B's edit and the server rejects it with a
  // conflict, which keeps the edit and its file for the user to retry.
  network.goOnline();
  await advanceTime(3_000);
  expect(describeTabs(tabA, tabB)).toMatchInlineSnapshot(`
    tab A:
      entities: ['doc: resolution-required']
      leader: '✅'
      resolutions: ['doc: conflict']

    tab B:
      entities: ['doc: resolution-required']
      leader: '❌'
      resolutions: ['doc: conflict']
  `);

  // Tab B, which saved the file, must not delete it while it applies tab A's
  // changes one at a time: retrying the conflict needs the file.
  expect(getOpfsDirTree(opfs)).toContain('binary.blob');
});

test('the leading tab keeps its queued edits while its own connectivity check still fails', async () => {
  // The app's connectivity check also requires the tab's realtime connection,
  // which each tab opens on its own.
  const tabARealtimeConnected = false;
  network.setOffline();
  const tabA = await openTab('A', {
    focused: true,
    getIsOffline: () => !network.isOnline() || !tabARealtimeConnected,
  });
  const tabB = await openTab('B', { focused: false });
  // Tab A keeps the focus and leads
  setDocumentHidden(false);
  await tabA.queueEdit(2);

  // The browser is back online. Tab B's check passes and it tells the other
  // tabs, but tab A's realtime connection is still down.
  network.goOnline();
  await advanceTime(3_000);

  // Tab A trusts its own check over tab B's report: sending now would fail,
  // so the edit stays queued.
  expect(serverCalls).toMatchInlineSnapshot(`[]`);
  expect(describeTabs(tabA, tabB)).toMatchInlineSnapshot(`
    tab A:
      entities: ['doc: pending']
      leader: '✅'
      resolutions: []

    tab B:
      entities: ['doc: pending']
      leader: '❌'
      resolutions: []
  `);
});
