import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type {
  GlobalOfflineStatus,
  OfflineSessionConfig,
} from '../../src/persistentStorage/offline/types';
import { createStoreManager, type StoreManager } from '../../src/storeManager';
import { createOfflineNetworkMock } from '../../src/testing';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { normalizeError, TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import {
  advanceTime,
  flushAllTimers,
  pick,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import { resetSessionForTests } from '../utils/resetSessionForTests';
import {
  type UpdateValueOperations,
  userRowSchema,
} from './offlineReplayTestShared';
import {
  collectionSchema,
  docMutationInputSchema,
  docSchema,
  listQueryQueryPayloadSchema,
} from './offlineTestShared';

// The "real" network. It stays online in most tests: forced offline mode must
// work without cutting the connection.
let network = createOfflineNetworkMock();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
  network = createOfflineNetworkMock();
  network.install();
  resetSessionForTests({ clearStorage: true });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  resetSessionForTests({ clearStorage: true });
});

/**
 * One "page load" of an app with an offline-enabled document store. Calling it
 * again after `resetSessionForTests()` simulates a reload over the same
 * storage.
 */
function createOfflineDocumentPage({
  sessionKey,
  storeName,
  testScenario = 'idle',
  networkConfig,
}: {
  sessionKey: string;
  storeName: string;
  testScenario?: 'idle' | 'loaded';
  networkConfig?: OfflineSessionConfig['network'];
}) {
  const storeManager = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: { network: networkConfig ?? network.config },
  });

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    id: storeName,
    getSessionKey: () => sessionKey,
    storeManager,
    testScenario,
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        operations: {
          updateValue: {
            inputSchema: docMutationInputSchema,
            kind: 'update',
            execute: async ({ input }) => {
              await env.serverMock.delayedSetData(input.value);
              return input;
            },
            onSuccessExecute: ({ input }) => {
              env.apiStore.updateState((draft) => {
                draft.value = input.value;
              });
            },
          },
        },
      },
    },
  });

  function setValue(value: number) {
    return env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value = value;
        });
      },
      mutation: async () => {
        await env.serverMock.delayedSetData(value);
        return value;
      },
      offline: { operation: 'updateValue', input: { value } },
    });
  }

  /** Mounts the document plus the offline status the way an app screen would. */
  function renderScreen() {
    return renderHook(() => {
      const doc = env.apiStore.useDocument({ returnRefetchingStatus: true });
      const status = storeManager.useOfflineStatus();

      env.trackUIChanges(
        `value:${doc.data?.value ?? 'none'} ${doc.status}${doc.pendingSync ? ' pendingSync' : ''} | offline:${status.isOfflineMode ? 'on' : 'off'} forced:${status.isForcedOffline ? 'on' : 'off'}`,
      );

      return { doc, status };
    });
  }

  return { env, storeManager, setValue, renderScreen };
}

function summarizeStatus(status: GlobalOfflineStatus) {
  return pick(status, ['isForcedOffline', 'isOfflineMode', 'network']);
}

function getStatusSummary(storeManager: StoreManager) {
  return summarizeStatus(storeManager.getOfflineStatus());
}

test('forced offline mode keeps a reloaded app offline from boot and turning it off replays the queued work', async () => {
  const sessionKey = 'forced-offline-reload-session';
  const storeName = 'forced-offline-reload-doc';

  // First page load: the app is online and has the document cached.
  const firstPage = createOfflineDocumentPage({
    sessionKey,
    storeName,
    testScenario: 'loaded',
  });
  await flushAllTimers();

  expect(getStatusSummary(firstPage.storeManager)).toMatchInlineSnapshot(`
    isForcedOffline: '❌'
    isOfflineMode: '❌'
    network: { active: '❌', enabled: '✅' }
  `);

  // A developer / e2e test forces offline mode. The real network stays up.
  (await firstPage.storeManager.setForcedOfflineMode(true)).unwrap();

  expect(network.isOnline()).toBe(true);
  expect(getStatusSummary(firstPage.storeManager)).toMatchInlineSnapshot(`
    isForcedOffline: '✅'
    isOfflineMode: '✅'
    network: { active: '✅', enabled: '✅' }
  `);

  // Reload: a new runtime boots over the same storage.
  resetSessionForTests();
  const reloadedPage = createOfflineDocumentPage({ sessionKey, storeName });

  // The flag is read synchronously, so the session is already offline before
  // any timer or microtask had a chance to run (i.e. before the first fetch).
  expect(getStatusSummary(reloadedPage.storeManager)).toMatchInlineSnapshot(`
    isForcedOffline: '✅'
    isOfflineMode: '✅'
    network: { active: '✅', enabled: '✅' }
  `);

  const { env } = reloadedPage;
  const screen = reloadedPage.renderScreen();
  await flushAllTimers();

  // Queue a mutation while forced offline.
  env.addTimelineComments('beforeNextAction', [
    'the user edits the document while forced offline',
  ]);
  const mutationResult = await act(() => reloadedPage.setValue(2));

  // The mutation was durably queued instead of being sent.
  expect({
    ok: mutationResult.ok,
    value: mutationResult.ok ? mutationResult.value : null,
  }).toMatchInlineSnapshot(`
    ok: '✅'
    value: { kind: 'queued' }
  `);

  // Browser "online" events and the passage of time must not end forced mode
  // or start replaying: the server never hears about the queued edit.
  env.addTimelineComments('beforeNextAction', [
    'the browser fires an "online" event and a minute passes',
  ]);
  act(() => {
    network.goOnline();
  });
  await advanceTime(60_000);

  expect(env.serverMock.fetchHistory).toMatchInlineSnapshot(`[]`);
  expect(env.serverMock.current).toBe(1);
  expect(summarizeStatus(screen.result.current.status)).toMatchInlineSnapshot(`
    isForcedOffline: '✅'
    isOfflineMode: '✅'
    network: { active: '✅', enabled: '✅' }
  `);

  // Turning forced mode off behaves like a normal reconnect.
  env.addTimelineComments('beforeNextAction', ['forced offline is turned off']);
  await act(async () => {
    (await reloadedPage.storeManager.setForcedOfflineMode(false)).unwrap();
  });
  await flushAllTimers();

  // The queued edit reached the server and nothing is pending anymore.
  expect(env.serverMock.current).toBe(2);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(summarizeStatus(screen.result.current.status)).toMatchInlineSnapshot(`
    isForcedOffline: '❌'
    isOfflineMode: '❌'
    network: { active: '❌', enabled: '✅' }
  `);

  // - while forced: cached value is shown as success and no fetch is started
  // - after turning it off: the pending sync clears and the document
  //   revalidates against the server
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui                                                     |
    0     | "value:1 success | offline:on forced:on"               | ui-initialized
    10ms  | "value:1 refetching | offline:on forced:on"            | ui-changed
    .     | "value:1 success | offline:on forced:on"               | ui-changed
    12s   | "value:1 success | offline:on forced:on"               | -- the user edits the document while forced offline
    .     | "value:2 success | offline:on forced:on"               | ui-changed
    .     | "value:2 success pendingSync | offline:on forced:on"   | ui-changed
    .     | "value:2 success pendingSync | offline:on forced:on"   | offline:updateValue queued
    72s   | "value:2 success pendingSync | offline:on forced:on"   | -- the browser fires an "online" event and a minute passes
    .     | "value:2 success pendingSync | offline:on forced:on"   | -- forced offline is turned off
    .     | "value:2 success pendingSync | offline:off forced:off" | ui-changed
    .     | "value:2 success pendingSync | offline:off forced:off" | offline:updateValue replay-started
    73.2s | "value:2 success pendingSync | offline:off forced:off" | server-data-changed (value: 2)
    .     | "value:2 success pendingSync | offline:off forced:off" | offline:updateValue replay-finished
    .     | "value:2 success | offline:off forced:off"             | ui-changed
    "
  `);

  screen.unmount();

  // The flag is gone from storage too: the next reload boots online.
  resetSessionForTests();
  const onlineAgainPage = createOfflineDocumentPage({ sessionKey, storeName });

  expect(getStatusSummary(onlineAgainPage.storeManager)).toMatchInlineSnapshot(`
    isForcedOffline: '❌'
    isOfflineMode: '❌'
    network: { active: '❌', enabled: '✅' }
  `);
});

test('forced offline mode works with the default browser network detection', async () => {
  const sessionKey = 'forced-offline-default-detection-session';
  const storeName = 'forced-offline-default-detection-doc';

  // The app relies on `navigator.onLine` + browser events (no `getIsOffline`).
  const page = createOfflineDocumentPage({
    sessionKey,
    storeName,
    testScenario: 'loaded',
    networkConfig: { enabled: true },
  });
  await flushAllTimers();

  (await page.storeManager.setForcedOfflineMode(true)).unwrap();

  expect(navigator.onLine).toBe(true);
  expect(getStatusSummary(page.storeManager)).toMatchInlineSnapshot(`
    isForcedOffline: '✅'
    isOfflineMode: '✅'
    network: { active: '✅', enabled: '✅' }
  `);

  // Fetches are answered from the cache without reaching the server.
  page.env.scheduleFetch('highPriority');
  await flushAllTimers();

  expect(page.env.serverMock.fetchHistory).toMatchInlineSnapshot(`[]`);
  expect(pick(page.env.store.state, ['data', 'error', 'status']))
    .toMatchInlineSnapshot(`
      data: { value: 1 }
      error: null
      status: 'success'
    `);
});

test('forced offline mode applies to every store type attached to the session', async () => {
  const sessionKey = 'forced-offline-all-stores-session';
  const usersQuery = { tableId: 'users' } as const;

  function createPage(testScenario: 'idle' | 'loaded') {
    const storeManager = createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: { network: network.config },
    });

    const collectionEnv = createCollectionStoreTestEnv(
      { 'users||1': { name: 'Ada' } },
      {
        id: 'forced-offline-collection',
        getSessionKey: () => sessionKey,
        storeManager,
        testScenario,
        persistentStorage: {
          adapter: 'local-sync',
          schema: collectionSchema,
          payloadSchema: rc_string,
          offline: { operations: {} },
        },
      },
    );

    const listQueryEnv = createListQueryStoreTestEnv(
      { users: [{ id: 1, name: 'Ada' }] },
      {
        id: 'forced-offline-list-query',
        getSessionKey: () => sessionKey,
        storeManager,
        testScenario:
          testScenario === 'loaded'
            ? { loaded: { queries: [usersQuery] } }
            : 'idle',
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: { operations: {} },
        },
      },
    );

    return { storeManager, collectionEnv, listQueryEnv };
  }

  // First page load caches the data, then offline mode is forced.
  const firstPage = createPage('loaded');
  await flushAllTimers();
  (await firstPage.storeManager.setForcedOfflineMode(true)).unwrap();

  // Reload with forced offline still on.
  resetSessionForTests();
  const { collectionEnv, listQueryEnv } = createPage('idle');

  const itemHook = renderHook(() =>
    collectionEnv.apiStore.useItem('users||1', {
      selector: (item) => item?.value.name ?? null,
    }),
  );
  const queryHook = renderHook(() =>
    listQueryEnv.apiStore.useListQuery(usersQuery, {
      itemSelector: (item) => item.name,
    }),
  );
  await flushAllTimers();

  // Both stores render from their cache...
  expect(pick(itemHook.result.current, ['data', 'error', 'status']))
    .toMatchInlineSnapshot(`
      data: 'Ada'
      error: null
      status: 'success'
    `);
  expect(pick(queryHook.result.current, ['error', 'items', 'status']))
    .toMatchInlineSnapshot(`
      error: null
      items: ['Ada']
      status: 'success'
    `);

  // ...and explicit refetches are treated as offline too.
  collectionEnv.scheduleFetch('highPriority', 'users||1');
  listQueryEnv.scheduleFetch('highPriority', usersQuery);
  await flushAllTimers();

  // No request reached the server from the reloaded page.
  expect(
    collectionEnv.serverTable.getRequestHistory('all'),
  ).toMatchInlineSnapshot(`[]`);
  expect(
    listQueryEnv.serverTable.getRequestHistory('all'),
  ).toMatchInlineSnapshot(`[]`);

  itemHook.unmount();
  queryHook.unmount();
});

test('a request that was already in flight cannot end forced offline mode when it succeeds', async () => {
  const sessionKey = 'forced-offline-in-flight-session';
  const page = createOfflineDocumentPage({
    sessionKey,
    storeName: 'forced-offline-in-flight-doc',
  });
  const { env } = page;
  const screen = page.renderScreen();

  // Let the mount fetch start, then force offline before it resolves.
  await advanceTime(100);
  expect(env.serverMock.numOfStartedFetches).toBe(1);
  expect(env.serverMock.numOfFinishedFetches).toBe(0);

  env.addTimelineComments('beforeNextAction', [
    'offline mode is forced while the fetch is in flight',
  ]);
  await act(async () => {
    (await page.storeManager.setForcedOfflineMode(true)).unwrap();
  });
  await flushAllTimers();

  // The in-flight response is still applied, but a successful request is not
  // treated as a recovery signal while forced.
  expect(env.serverMock.numOfFinishedFetches).toBe(1);
  expect(summarizeStatus(screen.result.current.status)).toMatchInlineSnapshot(`
    isForcedOffline: '✅'
    isOfflineMode: '✅'
    network: { active: '✅', enabled: '✅' }
  `);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui                                            |
    0     | "value:none loading | offline:off forced:off" | ui-initialized
    10ms  | "value:none loading | offline:off forced:off" | 🔴 >fetch-started
    100ms | "value:none loading | offline:off forced:off" | -- offline mode is forced while the fetch is in flight
    .     | "value:none loading | offline:on forced:on"   | ui-changed
    810ms | "value:none loading | offline:on forced:on"   | 🔴 <fetch-finished (value: 1)
    .     | "value:1 success | offline:on forced:on"      | ui-changed
    "
  `);

  screen.unmount();
});

test('network recovery checks do not run and cannot end forced offline mode', async () => {
  const sessionKey = 'forced-offline-recovery-check-session';
  const storeName = 'forced-offline-recovery-check-doc';
  // The app pings its server to confirm recovery. The server is reachable the
  // whole time, so every check would report "recovered".
  const recoveryCheck = vi.fn(() => true);
  const networkConfig: OfflineSessionConfig['network'] = {
    ...network.config,
    recoveryCheck,
    recoveryProbe: {
      initialIntervalMs: 1_000,
      maxIntervalMs: 1_000,
      backoffMultiplier: 1,
      jitterRatio: 0,
    },
  };

  const firstPage = createOfflineDocumentPage({
    sessionKey,
    storeName,
    testScenario: 'loaded',
    networkConfig,
  });
  await flushAllTimers();
  (await firstPage.storeManager.setForcedOfflineMode(true)).unwrap();
  await advanceTime(30_000);

  // Reload: the persisted offline status plus an online browser is exactly
  // what a classified network failure looks like, which normally starts
  // recovery probing.
  resetSessionForTests();
  const reloadedPage = createOfflineDocumentPage({
    sessionKey,
    storeName,
    networkConfig,
  });
  const screen = reloadedPage.renderScreen();
  await advanceTime(30_000);

  expect(recoveryCheck).toHaveBeenCalledTimes(0);
  expect(summarizeStatus(screen.result.current.status)).toMatchInlineSnapshot(`
    isForcedOffline: '✅'
    isOfflineMode: '✅'
    network: { active: '✅', enabled: '✅' }
  `);
  expect(reloadedPage.env.serverMock.fetchHistory).toMatchInlineSnapshot(`[]`);

  screen.unmount();
});

test('turning forced offline mode off while the network is really down keeps the session offline until it returns', async () => {
  const sessionKey = 'forced-offline-real-outage-session';
  const page = createOfflineDocumentPage({
    sessionKey,
    storeName: 'forced-offline-real-outage-doc',
    testScenario: 'loaded',
  });
  const { env } = page;
  await flushAllTimers();

  (await page.storeManager.setForcedOfflineMode(true)).unwrap();
  await resolveAfterAllTimers(page.setValue(2));

  // The connection really drops while forced mode is on.
  act(() => {
    network.goOffline();
  });
  await flushAllTimers();

  // Leaving forced mode hands control back to the real network detection,
  // which still reports offline: nothing is replayed yet.
  (await page.storeManager.setForcedOfflineMode(false)).unwrap();
  await flushAllTimers();

  expect(getStatusSummary(page.storeManager)).toMatchInlineSnapshot(`
    isForcedOffline: '❌'
    isOfflineMode: '✅'
    network: { active: '✅', enabled: '✅' }
  `);
  expect(env.serverMock.current).toBe(1);

  // The real reconnect then recovers and replays as usual.
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(getStatusSummary(page.storeManager)).toMatchInlineSnapshot(`
    isForcedOffline: '❌'
    isOfflineMode: '❌'
    network: { active: '❌', enabled: '✅' }
  `);
  expect(env.serverMock.current).toBe(2);
});

test('forced offline mode only takes effect while network mode is enabled', async () => {
  const sessionKey = 'forced-offline-disabled-network-session';
  const page = createOfflineDocumentPage({
    sessionKey,
    storeName: 'forced-offline-disabled-network-doc',
    testScenario: 'loaded',
    // Network mode is configured but starts disabled.
    networkConfig: { ...network.config, enabled: false },
  });
  await flushAllTimers();

  // Forced mode simulates a network loss, so it follows the same admission
  // rule as a real one: it is recorded, but ignored while the mode is off.
  (await page.storeManager.setForcedOfflineMode(true)).unwrap();

  expect(getStatusSummary(page.storeManager)).toMatchInlineSnapshot(`
    isForcedOffline: '✅'
    isOfflineMode: '❌'
    network: { active: '❌', enabled: '❌' }
  `);

  // Enabling network mode at runtime makes the forced flag effective.
  page.storeManager
    .setOfflineRuntimeConfig({ network: { enabled: true } })
    .unwrap();

  expect(getStatusSummary(page.storeManager)).toMatchInlineSnapshot(`
    isForcedOffline: '✅'
    isOfflineMode: '✅'
    network: { active: '✅', enabled: '✅' }
  `);
});

test('forced offline mode is scoped to the session key that was active when it was set', async () => {
  let sessionKey: string | false = 'forced-offline-tenant-a';
  const storeManager = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: { network: network.config },
  });

  (await storeManager.setForcedOfflineMode(true)).unwrap();

  expect(getStatusSummary(storeManager)).toMatchInlineSnapshot(`
    isForcedOffline: '✅'
    isOfflineMode: '✅'
    network: { active: '✅', enabled: '✅' }
  `);

  // Switching to another tenant/account starts from that session's own flag.
  sessionKey = 'forced-offline-tenant-b';

  expect(getStatusSummary(storeManager)).toMatchInlineSnapshot(`
    isForcedOffline: '❌'
    isOfflineMode: '❌'
    network: { active: '❌', enabled: '✅' }
  `);

  // Going back finds the first session still forced offline.
  sessionKey = 'forced-offline-tenant-a';

  expect(getStatusSummary(storeManager)).toMatchInlineSnapshot(`
    isForcedOffline: '✅'
    isOfflineMode: '✅'
    network: { active: '✅', enabled: '✅' }
  `);
});

test('forcing offline mode reports an error when the session cannot go offline', async () => {
  // No `offlineSession` at all.
  const managerWithoutOffline = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => 'forced-offline-unavailable-session',
  });
  // `offlineSession` without the `network` mode forced offline builds on.
  const managerWithoutNetworkMode = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => 'forced-offline-unavailable-session',
    offlineSession: {},
  });
  // No active session (e.g. signed out).
  const managerWithoutSession = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => false,
    offlineSession: { network: network.config },
  });

  const results = {
    withoutOffline: await managerWithoutOffline.setForcedOfflineMode(true),
    withoutNetworkMode:
      await managerWithoutNetworkMode.setForcedOfflineMode(true),
    withoutSession: await managerWithoutSession.setForcedOfflineMode(true),
  };

  expect(
    Object.fromEntries(
      Object.entries(results).map(([name, result]) => [
        name,
        result.ok ? 'ok' : result.error.message,
      ]),
    ),
  ).toMatchInlineSnapshot(`
    withoutNetworkMode: '[tsdf] Forced offline mode requires an active session key and \`offlineSession.network\` to be configured'
    withoutOffline: '[tsdf] Forced offline mode requires an active session key and \`offlineSession.network\` to be configured'
    withoutSession: '[tsdf] Forced offline mode requires an active session key and \`offlineSession.network\` to be configured'
  `);
  expect(getStatusSummary(managerWithoutNetworkMode)).toMatchInlineSnapshot(`
    isForcedOffline: '❌'
    isOfflineMode: '❌'
    network: { active: '❌', enabled: '❌' }
  `);
});
