import { rc_number, rc_object } from 'runcheck';
import { describe, expect, test, vi } from 'vitest';

import type { DocumentOfflineOperationDefinition } from '../../../src/main';
import { createOfflineSession } from '../../../src/main';
import { ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY } from '../../../src/persistentStorage/asyncStorageAdapter';
import { createCompactListQueryLocalStorageEntry } from '../../../src/persistentStorage/compactListQueryLocalStorageEntry';
import {
  getManagedLocalStorageManifestKeyForPrefix,
  getManagedLocalStorageManifestKeyForSingle,
} from '../../../src/persistentStorage/localStorageMetadata';
import { resetExpirationScanTracking } from '../../../src/persistentStorage/persistentStorageManager';
import { createDocumentStoreTestEnv } from '../../mocks/documentStoreTestEnv';
import { advanceTime, flushAllTimers } from '../../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../../utils/networkMock';
import {
  getParsedLocalStorageValue,
  startPersistentStorageOperationCapture,
} from '../../utils/persistentStorageOptimizationTestUtils';
import {
  createCollectionEnv,
  createDocumentEnv,
  persistentStore,
  setupSyncStorageEfficiencyTestSuite,
  waitForScheduledCleanup,
  wrappedDocumentSchema,
} from './shared';

setupSyncStorageEfficiencyTestSuite();

type ProtectedDocumentOfflineOperations = {
  markProtected: DocumentOfflineOperationDefinition<
    { value: { name: string; value: number } },
    { input: { value: number } }
  >;
};

describe('sync storage efficiency: maintenance', () => {
  test('expiration cleanup removes expired entries and snapshots the full manifest scan history', async () => {
    const oneWeekAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const expiredDoc = persistentStore.scope('expired-doc', 'sess1');
    const freshDoc = persistentStore.scope('fresh-doc', 'sess1');

    // Seed one expired entry and one fresh entry so the cleanup pass has work to do.
    expiredDoc.document.seed(
      { value: { name: 'old', value: 1 } },
      { timestamp: oneWeekAgo },
    );
    freshDoc.document.seed({ value: { name: 'fresh', value: 2 } });
    localStorage.setItem('external-cache', JSON.stringify({ keep: true }));
    localStorage.setItem('feature-flag', 'enabled');

    // Startup should only schedule the sweep; it should not perform storage I/O yet.
    const startupReadCapture = startPersistentStorageOperationCapture();
    createDocumentEnv({ storeName: 'fresh-doc', sessionKey: 'sess1' });
    const startupOperations = startupReadCapture.finish().timelineString;

    expect(startupOperations).toMatchInlineSnapshot(`"empty"`);

    // Once the scheduled sweep runs, snapshot the complete maintenance history.
    const readCapture = startPersistentStorageOperationCapture();
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(localStorage.getItem(expiredDoc.document.storageKey())).toBeNull();
    expect(localStorage.getItem(freshDoc.document.storageKey())).not.toBeNull();
    expect({
      externalCache: localStorage.getItem('external-cache'),
      featureFlag: localStorage.getItem('feature-flag'),
    }).toMatchInlineSnapshot(`
      externalCache: '{"keep":true}'
      featureFlag: 'enabled'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time |
      2s   | 📖 #1 ❌ tsdf._m.g (global maintenance)
      .    | 🔑[0] #2 ✅ tsdf.sess1.expired-doc (entry data)
      .    | 🔑[1] #3 ✅ tsdf._m.r.s:sess1.expired-doc.m (namespace index)
      .    | 🔑[2] #4 ✅ tsdf.sess1.fresh-doc (entry data)
      .    | 🔑[3] #5 ✅ tsdf._m.r.s:sess1.fresh-doc.m (namespace index)
      .    | 🔑[4] #6 ✅ external-cache
      .    | 🔑[5] #7 ✅ feature-flag
      .    | 📖 #3 ✅ tsdf._m.r.s:sess1.expired-doc.m (namespace index) | 0.05 kb
      .    | 📖 #5 ✅ tsdf._m.r.s:sess1.fresh-doc.m (namespace index) | 0.05 kb
      .    | 🗑️ #2 ✅->❌ tsdf.sess1.expired-doc (entry data)
      .    | ✍️ #1 ❌->✅ tsdf._m.g (global maintenance) | ❌ -> 0.04 kb
      .    | 🗑️ #3 ✅->❌ tsdf._m.r.s:sess1.expired-doc.m (namespace index)
      "
    `);

    expect(getParsedLocalStorageValue('tsdf._m.g')).toMatchInlineSnapshot(
      `lca: 1735689602000`,
    );
  });

  test('startup cleanup removes malformed manifest entries together with their payload keys', async () => {
    const triggerDoc = persistentStore.scope('trigger', 'sess1');
    const corruptedKey = 'tsdf.sess1.corrupted';
    const corruptedManifestKey =
      getManagedLocalStorageManifestKeyForSingle(corruptedKey);

    // Seed a broken manifest together with its payload. Startup cleanup should
    // drop both keys once the manifest fails to parse.
    localStorage.setItem(
      corruptedKey,
      JSON.stringify({ data: 'bad', version: 1 }),
    );
    localStorage.setItem(corruptedManifestKey, '{invalid');

    // Seed a valid store in the same session so cleanup discovers the session
    // and we can verify healthy manifest-backed entries are preserved.
    triggerDoc.document.seed({ value: { name: 'ok', value: 1 } });

    createDocumentEnv({ storeName: 'trigger', sessionKey: 'sess1' });

    const readCapture = startPersistentStorageOperationCapture();
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      corruptedPayloadExists: localStorage.getItem(corruptedKey) !== null,
      corruptedManifestExists:
        localStorage.getItem(corruptedManifestKey) !== null,
      triggerExists:
        localStorage.getItem(triggerDoc.document.storageKey()) !== null,
    }).toMatchInlineSnapshot(`
      corruptedManifestExists: '❌'
      corruptedPayloadExists: '❌'
      triggerExists: '✅'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time |
      2s   | 📖 #1 ❌ tsdf._m.g (global maintenance)
      .    | 🔑[0] #2 ✅ tsdf.sess1.corrupted (entry data)
      .    | 🔑[1] #3 ✅ tsdf._m.r.s:sess1.corrupted.m (namespace index)
      .    | 🔑[2] #4 ✅ tsdf.sess1.trigger (entry data)
      .    | 🔑[3] #5 ✅ tsdf._m.r.s:sess1.trigger.m (namespace index)
      .    | 📖 #3 ✅ tsdf._m.r.s:sess1.corrupted.m (namespace index) | 0.02 kb
      .    | 🗑️ #3 ✅->❌ tsdf._m.r.s:sess1.corrupted.m (namespace index)
      .    | 📖 #5 ✅ tsdf._m.r.s:sess1.trigger.m (namespace index) | 0.05 kb
      .    | 🗑️ #2 ✅->❌ tsdf.sess1.corrupted (entry data)
      .    | ✍️ #1 ❌->✅ tsdf._m.g (global maintenance) | ❌ -> 0.04 kb
      "
    `);
  });

  test('startup cleanup checks expiration across multiple sessions', async () => {
    const staleTimestamp = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const sess1ExpiredDoc = persistentStore.scope('expired-doc', 'sess1');
    const sess2ExpiredDoc = persistentStore.scope('expired-doc', 'sess2');
    const sess2FreshDoc = persistentStore.scope('fresh-doc', 'sess2');
    const sess1ExpiredKey = sess1ExpiredDoc.document.storageKey();
    const sess2ExpiredKey = sess2ExpiredDoc.document.storageKey();
    const sess2FreshKey = sess2FreshDoc.document.storageKey();

    // Seed stale entries in two sessions so startup cleanup has to sweep both namespaces.
    sess1ExpiredDoc.document.seed(
      { value: { name: 'sess1-stale', value: 1 } },
      { timestamp: staleTimestamp },
    );
    sess2ExpiredDoc.document.seed(
      { value: { name: 'sess2-stale', value: 2 } },
      { timestamp: staleTimestamp },
    );
    sess2FreshDoc.document.seed({ value: { name: 'sess2-fresh', value: 3 } });

    // A fresh store mount in a third session should still trigger the global cleanup pass.
    createDocumentEnv({ storeName: 'trigger-doc', sessionKey: 'sess-trigger' });

    const readCapture = startPersistentStorageOperationCapture();
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      sess1ExpiredEntryExists: localStorage.getItem(sess1ExpiredKey) !== null,
      sess1ExpiredManifestExists:
        localStorage.getItem(
          getManagedLocalStorageManifestKeyForSingle(sess1ExpiredKey),
        ) !== null,
      sess2ExpiredEntryExists: localStorage.getItem(sess2ExpiredKey) !== null,
      sess2ExpiredManifestExists:
        localStorage.getItem(
          getManagedLocalStorageManifestKeyForSingle(sess2ExpiredKey),
        ) !== null,
      sess2FreshEntryExists: localStorage.getItem(sess2FreshKey) !== null,
      sess2FreshManifestExists:
        localStorage.getItem(
          getManagedLocalStorageManifestKeyForSingle(sess2FreshKey),
        ) !== null,
    }).toMatchInlineSnapshot(`
      sess1ExpiredEntryExists: '❌'
      sess1ExpiredManifestExists: '❌'
      sess2ExpiredEntryExists: '❌'
      sess2ExpiredManifestExists: '❌'
      sess2FreshEntryExists: '✅'
      sess2FreshManifestExists: '✅'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time |
      2s   | 📖 #1 ❌ tsdf._m.g (global maintenance)
      .    | 🔑[0] #2 ✅ tsdf.sess1.expired-doc (entry data)
      .    | 🔑[1] #3 ✅ tsdf._m.r.s:sess1.expired-doc.m (namespace index)
      .    | 🔑[2] #4 ✅ tsdf.sess2.expired-doc (entry data)
      .    | 🔑[3] #5 ✅ tsdf._m.r.s:sess2.expired-doc.m (namespace index)
      .    | 🔑[4] #6 ✅ tsdf.sess2.fresh-doc (entry data)
      .    | 🔑[5] #7 ✅ tsdf._m.r.s:sess2.fresh-doc.m (namespace index)
      .    | 📖 #3 ✅ tsdf._m.r.s:sess1.expired-doc.m (namespace index) | 0.05 kb
      .    | 📖 #5 ✅ tsdf._m.r.s:sess2.expired-doc.m (namespace index) | 0.05 kb
      .    | 📖 #7 ✅ tsdf._m.r.s:sess2.fresh-doc.m (namespace index) | 0.05 kb
      .    | 🗑️ #2 ✅->❌ tsdf.sess1.expired-doc (entry data)
      .    | 🗑️ #4 ✅->❌ tsdf.sess2.expired-doc (entry data)
      .    | ✍️ #1 ❌->✅ tsdf._m.g (global maintenance) | ❌ -> 0.04 kb
      .    | 🗑️ #3 ✅->❌ tsdf._m.r.s:sess1.expired-doc.m (namespace index)
      .    | 🗑️ #5 ✅->❌ tsdf._m.r.s:sess2.expired-doc.m (namespace index)
      "
    `);
  });

  test('global cleanup removes invalid tsdf keys while preserving valid managed entries and compact queries', async () => {
    const validDoc = persistentStore.scope('valid-doc', 'sess1');
    const validSingleKey = validDoc.document.seed({
      value: { name: 'valid', value: 1 },
    });
    const straySingleKey = 'tsdf.sess1.stray-doc';
    const strayNamespaceKey = 'tsdf.sess1.stray-store.li."users||99';
    const malformedManifestKey = 'tsdf._m.r.s:sess1.bad-manifest.m';
    const malformedCompactQueryKey =
      'tsdf.sess1.bad-query.lq.{tableId:"users"}';
    const validCompactQueryKey = 'tsdf.sess1.valid-query.lq.{tableId:"users"}';

    localStorage.setItem(straySingleKey, JSON.stringify({ timestamp: 1 }));
    localStorage.setItem(strayNamespaceKey, JSON.stringify({ timestamp: 1 }));
    localStorage.setItem('tsdf._m.g', '{invalid');
    localStorage.setItem(
      ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY,
      JSON.stringify({ lca: 123 }),
    );
    localStorage.setItem(malformedManifestKey, '{invalid');
    localStorage.setItem(malformedCompactQueryKey, '{invalid');
    localStorage.setItem(
      validCompactQueryKey,
      JSON.stringify(
        createCompactListQueryLocalStorageEntry({
          lastAccessAt: Date.now(),
          items: ['users||1'],
          hasMore: false,
          offlineProtected: false,
          payload: { tableId: 'users' },
        }),
      ),
    );
    localStorage.setItem('external-cache', JSON.stringify({ keep: true }));

    createDocumentEnv({ storeName: 'valid-doc', sessionKey: 'sess1' });

    const readCapture = startPersistentStorageOperationCapture();
    await waitForScheduledCleanup();
    const removedKeys = readCapture
      .finish()
      .operations.filter((operation) => operation.type === 'removeItem')
      .map((operation) => operation.key);

    expect(removedKeys).toMatchInlineSnapshot(`
      - 'tsdf._m.g'
      - 'tsdf._m.r.s:sess1.bad-manifest.m'
      - 'tsdf.sess1.bad-query.lq.{tableId:"users"}'
      - 'tsdf.sess1.stray-doc'
      - 'tsdf.sess1.stray-store.li."users||99'
    `);

    expect({
      validSinglePayloadExists: localStorage.getItem(validSingleKey) !== null,
      straySinglePayloadExists: localStorage.getItem(straySingleKey) !== null,
      strayNamespacePayloadExists:
        localStorage.getItem(strayNamespaceKey) !== null,
      malformedManifestExists:
        localStorage.getItem(malformedManifestKey) !== null,
      malformedCompactQueryExists:
        localStorage.getItem(malformedCompactQueryKey) !== null,
      validCompactQueryExists:
        localStorage.getItem(validCompactQueryKey) !== null,
      asyncGlobalMaintenance: getParsedLocalStorageValue(
        ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY,
      ),
      externalCache: localStorage.getItem('external-cache'),
      globalMaintenance: getParsedLocalStorageValue('tsdf._m.g'),
    }).toMatchInlineSnapshot(`
      asyncGlobalMaintenance: { lca: 123 }
      externalCache: '{"keep":true}'
      globalMaintenance: { lca: 1735689602000 }
      malformedCompactQueryExists: '❌'
      malformedManifestExists: '❌'
      strayNamespacePayloadExists: '❌'
      straySinglePayloadExists: '❌'
      validCompactQueryExists: '✅'
      validSinglePayloadExists: '✅'
    `);
  });

  test('global cleanup removes collection payload keys that are no longer referenced by their manifest', async () => {
    const collectionScope = persistentStore.scope('orphan-collection', 'sess1');
    const keptItemKey = collectionScope.collection.seedItem('kept-user', {
      value: { id: 'kept-user', name: 'Kept User' },
    });
    const orphanedItemKey = collectionScope.collection.seedItem('orphan-user', {
      value: { id: 'orphan-user', name: 'Orphan User' },
    });
    const manifestKey = getManagedLocalStorageManifestKeyForPrefix(
      'tsdf.sess1.orphan-collection.ci.',
    );

    // Rewrite the manifest so only the kept payload is still owned by the
    // collection namespace. The orphaned payload key should be pruned by the
    // strict global sweep before manifest cleanup runs.
    localStorage.setItem(
      manifestKey,
      JSON.stringify({
        e: [
          {
            a: Date.now(),
            k: collectionScope.collection.itemKey('kept-user'),
            p: 'kept-user',
          },
        ],
      }),
    );

    createCollectionEnv({
      storeName: 'orphan-collection',
      sessionKey: 'sess1',
    });

    const readCapture = startPersistentStorageOperationCapture();
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      keptItemExists: localStorage.getItem(keptItemKey) !== null,
      manifest: getParsedLocalStorageValue(manifestKey),
      orphanedItemExists: localStorage.getItem(orphanedItemKey) !== null,
    }).toMatchInlineSnapshot(`
      keptItemExists: '✅'

      manifest:
        e:
          - a: 1735689600000
            k: '"kept-user'
            p: 'kept-user'

      orphanedItemExists: '❌'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time |
      2s   | 📖 #1 ❌ tsdf._m.g (global maintenance)
      .    | 🔑[0] #2 ✅ tsdf.sess1.orphan-collection.ci."kept-user
           |    └ (entry data, <"kept-user>)
      .    | 🔑[1] #3 ✅ tsdf._m.r.n:sess1.orphan-collection.ci.m
           |    └ (namespace index)
      .    | 🔑[2] #4 ✅ tsdf.sess1.orphan-collection.ci."orphan-user
           |    └ (entry data, <"orphan-user>)
      .    | 📖 #3 ✅ tsdf._m.r.n:sess1.orphan-collection.ci.m
           |    └ (namespace index) | 0.12 kb
      .    | 🗑️ #4 ✅->❌ tsdf.sess1.orphan-collection.ci."orphan-user
           |    └ (entry data, <"orphan-user>)
      .    | ✍️ #1 ❌->✅ tsdf._m.g (global maintenance) | ❌ -> 0.04 kb
      "
    `);
  });

  test('offline dotted-session startup cleanup keeps stale cached entries while pruning invalid stray keys', async () => {
    const staleDurationMs = 8 * 24 * 60 * 60 * 1000;
    const dottedSessionKey = 'user@example.com';
    const offlineNetwork = createOfflineNetworkMock();
    const protectedDocStorageKey = `tsdf.${dottedSessionKey}.protected-doc`;
    const unprotectedDocStorageKey = `tsdf.${dottedSessionKey}.unprotected-doc`;

    // Seed two cached dotted-session entries through normal store fetch/persist flows.
    const protectedSeedEnv = createDocumentEnv({
      storeName: 'protected-doc',
      sessionKey: dottedSessionKey,
      serverData: { name: 'protected', value: 1 },
    });
    protectedSeedEnv.scheduleFetch('highPriority');
    await advanceTime(1810);

    const unprotectedSeedEnv = createDocumentEnv({
      storeName: 'unprotected-doc',
      sessionKey: dottedSessionKey,
      serverData: { name: 'unprotected', value: 2 },
    });
    unprotectedSeedEnv.scheduleFetch('highPriority');
    await advanceTime(1810);

    // Move far enough forward that both cached entries are stale before the real cleanup pass.
    await advanceTime(staleDurationMs);

    // Let a real offline-enabled store register the protected document key for this session.
    offlineNetwork.install();
    offlineNetwork.setOffline();

    const protectedDocEnv = createDocumentStoreTestEnv<
      { name: string; value: number },
      ProtectedDocumentOfflineOperations
    >(
      { name: 'protected', value: 1 },
      {
        id: 'protected-doc',
        getSessionKey: () => dottedSessionKey,
        testScenario: 'loaded',
        __DANGEROUS_IGNORE_INITIAL_TIME_CHECK__: true,
        persistentStorage: {
          adapter: 'local-sync',
          schema: wrappedDocumentSchema,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => dottedSessionKey,
              config: { network: offlineNetwork.config },
            }),
            operations: {
              markProtected: {
                inputSchema: rc_object({ value: rc_number }),
                execute: ({ input }) => input,
                onSuccessExecute: ({ input }) => {
                  protectedDocEnv.apiStore.updateState((draft) => {
                    draft.value.value = input.value;
                  });
                },
              },
            },
          },
        },
      },
    );

    await Promise.resolve();
    offlineNetwork.goOffline();
    await Promise.resolve();

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
    const protectMutationResult =
      await protectedDocEnv.apiStore.performMutation({
        mutation: () => Promise.resolve({ name: 'protected', value: 1 }),
        offline: { operation: 'markProtected', input: { value: 1 } },
      });
    randomSpy.mockRestore();
    localStorage.setItem('tsdf.user@example.com.invalid-stray', '{invalid');

    expect(protectMutationResult.ok).toBe(true);

    // Reset the one-off scheduling state so the fresh trigger store schedules the cleanup we want to capture.
    resetExpirationScanTracking();

    // A fresh entry in another session triggers the scheduled global maintenance pass.
    const triggerDocEnv = createDocumentStoreTestEnv(
      { name: 'trigger', value: 3 },
      {
        id: 'trigger-doc',
        getSessionKey: () => 'sess-trigger',
        __DANGEROUS_IGNORE_INITIAL_TIME_CHECK__: true,
        persistentStorage: {
          adapter: 'local-sync',
          schema: wrappedDocumentSchema,
        },
      },
    );
    triggerDocEnv.scheduleFetch('highPriority');
    await advanceTime(1810);

    // Capture the full sweep so the snapshot shows the manifest-only scan and
    // confirms offline startup preserves the stale cached entries.
    const readCapture = startPersistentStorageOperationCapture();
    await waitForScheduledCleanup(190);
    const operationsBreakdown = readCapture.finish().timelineString;

    // Offline startup should preserve both stale cached documents, while still
    // pruning the unrelated invalid stray key discovered during the sweep.
    expect({
      invalidStrayExists:
        localStorage.getItem('tsdf.user@example.com.invalid-stray') !== null,
      protectedEntryExists:
        localStorage.getItem(protectedDocStorageKey) !== null,
      unprotectedEntryExists:
        localStorage.getItem(unprotectedDocStorageKey) !== null,
    }).toMatchInlineSnapshot(`
      invalidStrayExists: '❌'
      protectedEntryExists: '✅'
      unprotectedEntryExists: '✅'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time  |
      190ms | 📖 #1 ✅ tsdf._m.g (global maintenance) | 0.04 kb
      .     | 🔑[0] #2 ✅ tsdf.user@example.com.protected-doc (entry data)
      .     | 🔑[1] #3 ✅ tsdf._m.r.s:user@example.com.protected-doc.m
            |    └ (namespace index)
      .     | 🔑[2] #1 ✅ tsdf._m.g (global maintenance)
      .     | 🔑[3] #4 ✅ tsdf.user@example.com.unprotected-doc (entry data)
      .     | 🔑[4] #5 ✅ tsdf._m.r.s:user@example.com.unprotected-doc.m
            |    └ (namespace index)
      .     | 🔑[5] #6 ✅ tsdf.user@example.com._o_.s (entry data)
      .     | 🔑[6] #7 ✅ tsdf._m.r.s:user@example.com._o_.s.m (namespace index)
      .     | 🔑[7] #8 ✅ tsdf.user@example.com.protected-doc.oq.protected-doc:1736380803620:4fzzzxjy
            |    └ (entry data, <protected-doc:1736380803620:4fzzzxjy>)
      .     | 🔑[8] #9 ✅ tsdf._m.r.n:user@example.com.protected-doc.oq.m
            |    └ (namespace index)
      .     | 🔑[9] #10 ✅ tsdf.user@example.com.protected-doc.oe.document
            |    └ (entry data, <document>)
      .     | 🔑[10] #11 ✅ tsdf._m.r.n:user@example.com.protected-doc.oe.m
            |    └ (namespace index)
      .     | 🔑[11] #12 ✅ tsdf.user@example.com.invalid-stray (entry data)
      .     | 🔑[12] #13 ✅ tsdf.sess-trigger.trigger-doc (entry data)
      .     | 🔑[13] #14 ✅ tsdf._m.r.s:sess-trigger.trigger-doc.m
            |    └ (namespace index)
      .     | 📖 #3 ✅ tsdf._m.r.s:user@example.com.protected-doc.m
            |    └ (namespace index) | 0.07 kb
      .     | 📖 #5 ✅ tsdf._m.r.s:user@example.com.unprotected-doc.m
            |    └ (namespace index) | 0.05 kb
      .     | 📖 #7 ✅ tsdf._m.r.s:user@example.com._o_.s.m
            |    └ (namespace index) | 0.05 kb
      .     | 📖 #9 ✅ tsdf._m.r.n:user@example.com.protected-doc.oq.m
            |    └ (namespace index) | 0.14 kb
      .     | 📖 #11 ✅ tsdf._m.r.n:user@example.com.protected-doc.oe.m
            |    └ (namespace index) | 0.08 kb
      .     | 📖 #14 ✅ tsdf._m.r.s:sess-trigger.trigger-doc.m
            |    └ (namespace index) | 0.05 kb
      .     | 🗑️ #12 ✅->❌ tsdf.user@example.com.invalid-stray (entry data)
      .     | 📖 #6 ✅ tsdf.user@example.com._o_.s (entry data) | 0.08 kb
      .     | ✍️ #1 ✅->✅ tsdf._m.g (global maintenance) | 0.04 kb -> 0.04 kb
      "
    `);
    expect(
      getParsedLocalStorageValue(
        'tsdf._m.r.s:user@example.com.protected-doc.m',
      ),
    ).toMatchInlineSnapshot(`
      e:
        - { a: 1735689601810, o: '✅' }
    `);
  });

  test('aggregate-only offline updates do not rewrite the shared status snapshot', async () => {
    const sessionKey = 'offline-session-write-skip';
    const offlineNetwork = createOfflineNetworkMock();

    offlineNetwork.install();
    offlineNetwork.setOffline();

    const env = createDocumentStoreTestEnv<
      { name: string; value: number },
      ProtectedDocumentOfflineOperations
    >(
      { name: 'protected', value: 1 },
      {
        id: 'protected-doc',
        getSessionKey: () => sessionKey,
        testScenario: 'loaded',
        persistentStorage: {
          adapter: 'local-sync',
          schema: wrappedDocumentSchema,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => sessionKey,
              config: { network: offlineNetwork.config },
            }),
            operations: {
              markProtected: {
                inputSchema: rc_object({ value: rc_number }),
                execute: ({ input }) => input,
                onSuccessExecute: ({ input }) => {
                  env.apiStore.updateState((draft) => {
                    draft.value.value = input.value;
                  });
                },
              },
            },
          },
        },
      },
    );

    await Promise.resolve();
    offlineNetwork.goOffline();
    await Promise.resolve();

    // Drain the one-off startup cleanup so this capture only sees the offline mutation path.
    await waitForScheduledCleanup();

    // The first queued mutation establishes the shared offline status snapshot.
    const firstMutationRandomSpy = vi
      .spyOn(Math, 'random')
      .mockReturnValue(0.123456789);
    await env.apiStore.performMutation({
      mutation: () => Promise.resolve({ name: 'protected', value: 1 }),
      offline: { operation: 'markProtected', input: { value: 1 } },
    });
    firstMutationRandomSpy.mockRestore();
    await flushAllTimers();

    const statusKey = `tsdf.${sessionKey}._o_.s`;
    expect(localStorage.getItem(statusKey)).not.toBeNull();

    // A second queued mutation changes the aggregate state, but the persisted
    // session status itself is unchanged, so `_o_.s` should not be rewritten.
    const mutationCapture = startPersistentStorageOperationCapture();
    const secondMutationRandomSpy = vi
      .spyOn(Math, 'random')
      .mockReturnValue(0.987654321);
    await env.apiStore.performMutation({
      mutation: () => Promise.resolve({ name: 'protected', value: 2 }),
      offline: { operation: 'markProtected', input: { value: 2 } },
    });
    secondMutationRandomSpy.mockRestore();
    await flushAllTimers();
    const statusSnapshotOperations = mutationCapture.finish();

    expect(
      statusSnapshotOperations.operations.filter((operation) => {
        return 'key' in operation && operation.key?.includes('._o_.s');
      }),
    ).toMatchInlineSnapshot(`[]`);
    expect(statusSnapshotOperations.timelineString).toMatchInlineSnapshot(`
      "
      time |
      0    | ✍️ #1 ❌->✅ tsdf.offline-session-write-skip.protected-doc.oq.protected-doc:1735689602100:zk00000y
           |    └ (entry data, <protected-doc:1735689602100:zk00000y>) | ❌ -> 0.33 kb
      .    | 📖 #2 ✅ tsdf._m.r.n:offline-session-write-skip.protected-doc.oq.m
           |    └ (namespace index) | 0.14 kb
      .    | ✍️ #2 ✅->✅ tsdf._m.r.n:offline-session-write-skip.protected-doc.oq.m
           |    └ (namespace index) | 0.14 kb -> 0.26 kb
      .    | 📖 #3 ✅ tsdf._m.r.n:offline-session-write-skip.protected-doc.oe.m
           |    └ (namespace index) | 0.08 kb
      .    | ✍️ #4 ✅->✅ tsdf.offline-session-write-skip.protected-doc.oe.document
           |    └ (entry data, <document>) | 0.14 kb -> 0.14 kb
      .    | 📖 #3 ✅ tsdf._m.r.n:offline-session-write-skip.protected-doc.oe.m
           |    └ (namespace index) | 0.08 kb ⚠️ REPEATED READ <10ms UNCHANGED
      .    | ✍️ #3 ✅->✅ tsdf._m.r.n:offline-session-write-skip.protected-doc.oe.m
           |    └ (namespace index) | 0.08 kb -> 0.08 kb ⚠️ UNCHANGED
      "
    `);
  });
});
