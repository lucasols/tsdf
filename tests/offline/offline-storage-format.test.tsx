import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { createOfflineSession } from '../../src/main';
import { __resetSessionOfflineCoordinatorRegistryForTests } from '../../src/persistentStorage/offline/sessionCoordinator';
import { opfsPersistentStorage } from '../../src/persistentStorage/storageAdapter';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { resetMockBrowserOpfsForTests } from '../mocks/mockBrowserOpfs';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import {
  flushAllTimers,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { createOpfsPersistentStorageTestStore } from '../utils/opfsPersistentStorageTestStore';
import {
  getLocalStorageTree,
  getOpfsDirTree,
  getParsedLocalStorageValue,
  getParsedOpfsFileData,
} from '../utils/persistentStorageOptimizationTestUtils';
import { type UpdateValueOperations } from './offlineReplayTestShared';
import { docMutationInputSchema, docSchema } from './offlineTestShared';

let network = createOfflineNetworkMock();

beforeEach(() => {
  __resetSessionOfflineCoordinatorRegistryForTests();
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
  network = createOfflineNetworkMock();
  network.install();
  localStorage.clear();
  resetMockBrowserOpfsForTests();
  opfsPersistentStorage.resetForTests?.();
});

afterEach(() => {
  __resetSessionOfflineCoordinatorRegistryForTests();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  localStorage.clear();
  resetMockBrowserOpfsForTests();
  opfsPersistentStorage.resetForTests?.();
});

test('local-sync offline persistence keeps the raw localStorage keys and JSON payloads transparent', async () => {
  const sessionKey = 'offline-sync-format-session';
  const storeName = 'offline-sync-format-doc';
  const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.123456789);

  try {
    // Start fully offline so both the session status snapshot and the queued
    // mutation are persisted through the real offline flow.
    network.setOffline();

    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      id: storeName,
      getSessionKey: () => sessionKey,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => sessionKey,
            config: { network: network.config },
          }),
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
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

    await Promise.resolve();

    // Queue one optimistic mutation so the document entry, the queue entry, the
    // offline entity summary, and the session status all have to be stored.
    await resolveAfterAllTimers(
      env.apiStore.performMutation({
        optimisticUpdate: () => {
          env.apiStore.updateState((draft) => {
            draft.value = 2;
          });
        },
        mutation: async () => {
          await env.serverMock.delayedSetData(2);
          return 2;
        },
        offline: { operation: 'updateValue', input: { value: 2 } },
      }),
    );
    await flushAllTimers();

    expect(getLocalStorageTree()).toMatchInlineSnapshot(`
      "tsdf (1.44 kb)
      ├ _m (0.64 kb)
      │ ├ g (0.04 kb)
      │ └ r (0.59 kb)
      │   ├ n:offline-sync-format-session.offline-sync-format-doc (0.35 kb)
      │   │ ├ oe.m (0.09 kb)
      │   │ └ oq.m (0.16 kb)
      │   └ s:offline-sync-format-session (0.24 kb)
      │     ├ _o_.s.m (0.06 kb)
      │     └ offline-sync-format-doc.m (0.12 kb)
      └ offline-sync-format-session (0.79 kb)
        ├ _o_.s (0.09 kb)
        └ offline-sync-format-doc (0.65 kb)
          ├ oe.document (0.16 kb)
          └ oq.offline-sync-format-doc:1735689600000:4fzzzxjy (0.40 kb)"
    `);

    expect(
      getParsedLocalStorageValue(
        'tsdf._m.r.s:offline-sync-format-session._o_.s.m',
      ),
    ).toMatchInlineSnapshot(`
      e:
        - a: 1735689600000
    `);
    expect(
      getParsedLocalStorageValue(
        'tsdf._m.r.s:offline-sync-format-session.offline-sync-format-doc.m',
      ),
    ).toMatchInlineSnapshot(`
      e:
        - { a: 1735689601000, o: '✅' }
    `);
    expect(
      getParsedLocalStorageValue(
        'tsdf._m.r.n:offline-sync-format-session.offline-sync-format-doc.oe.m',
      ),
    ).toMatchInlineSnapshot(`
      e:
        - { a: 1735689600000, k: 'document' }
    `);
    expect(
      getParsedLocalStorageValue(
        'tsdf._m.r.n:offline-sync-format-session.offline-sync-format-doc.oq.m',
      ),
    ).toMatchInlineSnapshot(`
      e:
        - { a: 1735689600000, k: 'offline-sync-format-doc:1735689600000:4fzzzxjy' }
    `);
    expect(getParsedLocalStorageValue('tsdf.offline-sync-format-session._o_.s'))
      .toMatchInlineSnapshot(`
        d:
          n: { a: 1, e: 1 }
          u: 1735689600000
      `);
    expect(
      getParsedLocalStorageValue(
        'tsdf.offline-sync-format-session.offline-sync-format-doc',
      ),
    ).toMatchInlineSnapshot(`
      d: { value: 2 }
    `);
    expect(
      getParsedLocalStorageValue(
        'tsdf.offline-sync-format-session.offline-sync-format-doc.oe.document',
      ),
    ).toMatchInlineSnapshot(`
      a: 1735689600000
      g: 'd'
      k: 'document'
      p: 1
      s: 'p'
      u: 1735689600000
    `);
    expect(
      getParsedLocalStorageValue(
        'tsdf.offline-sync-format-session.offline-sync-format-doc.oq.offline-sync-format-doc:1735689600000:4fzzzxjy',
      ),
    ).toMatchInlineSnapshot(`
      a: 1735689600000
      d: 'offline-sync-format-doc:1735689600000:4fzzzxjy'
      e: ['d:document']
      i: { value: 2 }
      o: 'updateValue'
      s: 'p'
      u: 1735689600000
      w: 'd'
    `);
  } finally {
    randomSpy.mockRestore();
  }
});

test('the default OPFS offline persistence keeps the raw file paths and JSON payloads transparent', async () => {
  const sessionKey = 'offline-opfs-format-session';
  const storeName = 'offline-opfs-format-doc';
  const mockAdapter = createOpfsPersistentStorageTestStore();
  const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.123456789);

  try {
    // Start fully offline so the OPFS-backed adapter has to persist the same
    // offline queue and session metadata that local-sync stores in localStorage.
    network.setOffline();

    const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
      id: storeName,
      getSessionKey: () => sessionKey,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: opfsPersistentStorage,
        schema: docSchema,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => sessionKey,
            config: { network: network.config },
          }),
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
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

    await Promise.resolve();

    // Queue one optimistic mutation so the snapshot captures the persisted
    // document, the queue entry, the entity metadata, and the session status.
    await resolveAfterAllTimers(
      env.apiStore.performMutation({
        optimisticUpdate: () => {
          env.apiStore.updateState((draft) => {
            draft.value = 2;
          });
        },
        mutation: async () => {
          await env.serverMock.delayedSetData(2);
          return 2;
        },
        offline: { operation: 'updateValue', input: { value: 2 } },
      }),
    );
    await flushAllTimers();

    expect(getOpfsDirTree(mockAdapter)).toMatchInlineSnapshot(`
      "tsdf (1.21 kb)
      ├ offline-opfs-format-session (1.14 kb)
      │ └ offline-opfs-format-doc (1.09 kb)
      │   ├ d._i.r.json (0.11 kb)
      │   ├ d.e.p.json (0.05 kb)
      │   ├ oe._i.r.json (0.10 kb)
      │   ├ oe.document.p.json (0.18 kb)
      │   ├ oq._i.r.json (0.17 kb)
      │   └ oq.offline-opfs-format-doc%3A1735689600003%3A4fzzzxjy.p.json (0.43 kb)
      └ tsdf._am.g* (0.06 kb)"
    `);
    expect(getLocalStorageTree()).toMatchInlineSnapshot(`
      "tsdf (0.33 kb)
      ├ _am.g (0.05 kb)
      ├ _m.r.s:offline-opfs-format-session._o_.s.m (0.13 kb)
      └ offline-opfs-format-session._o_.s (0.14 kb)"
    `);

    expect(getParsedLocalStorageValue('tsdf.offline-opfs-format-session._o_.s'))
      .toMatchInlineSnapshot(`
        d:
          n: { a: 1, e: 1 }
          u: 1735689600003
      `);
    expect(
      getParsedOpfsFileData(
        'tsdf/offline-opfs-format-session/offline-opfs-format-doc/d._i.r.json',
      ),
    ).toMatchInlineSnapshot(`
      e:
        - { a: 1735689601041, o: '✅' }
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/offline-opfs-format-session/offline-opfs-format-doc/d.e.p.json',
      ),
    ).toMatchInlineSnapshot(`
      d: { value: 2 }
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/offline-opfs-format-session/offline-opfs-format-doc/oe._i.r.json',
      ),
    ).toMatchInlineSnapshot(`
      e:
        document: { a: 1735689600098 }
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/offline-opfs-format-session/offline-opfs-format-doc/oe.document.p.json',
      ),
    ).toMatchInlineSnapshot(`
      a: 1735689600003
      g: 'd'
      k: 'document'
      p: 1
      s: 'p'
      u: 1735689600003
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/offline-opfs-format-session/offline-opfs-format-doc/oq._i.r.json',
      ),
    ).toMatchInlineSnapshot(`
      e:
        offline-opfs-format-doc:1735689600003:4fzzzxjy: { a: 1735689600044 }
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/offline-opfs-format-session/offline-opfs-format-doc/oq.offline-opfs-format-doc%3A1735689600003%3A4fzzzxjy.p.json',
      ),
    ).toMatchInlineSnapshot(`
      a: 1735689600003
      d: 'offline-opfs-format-doc:1735689600003:4fzzzxjy'
      e: ['d:document']
      i: { value: 2 }
      o: 'updateValue'
      s: 'p'
      u: 1735689600003
      w: 'd'
    `);
  } finally {
    randomSpy.mockRestore();
  }
}, 10_000);
