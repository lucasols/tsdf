import { rc_number, rc_object } from 'runcheck';
import { describe, expect, test, vi } from 'vitest';
import type { DocumentOfflineOperationDefinition } from '../../../src/main';
import { upsertManagedLocalStorageSingleEntry } from '../../../src/persistentStorage/localStorageMetadata';
import { resetExpirationScanTracking } from '../../../src/persistentStorage/persistentStorageManager';
import { createDocumentStoreTestEnv } from '../../mocks/documentStoreTestEnv';
import { advanceTime } from '../../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../../utils/networkMock';
import {
  getParsedLocalStorageValue,
  startPersistentStorageOperationCapture,
} from '../../utils/persistentStorageOptimizationTestUtils';
import {
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
      2s   | 📖 ❌ tsdf._m.g (global maintenance)
      .    | 🔑[0] ✅ tsdf.sess1.expired-doc (entry)
      .    | 🔑[1] ✅ tsdf._m.r.s:sess1.expired-doc.m (root, single, manifest)
      .    | 🔑[2] ✅ tsdf.sess1.fresh-doc (entry)
      .    | 🔑[3] ✅ tsdf._m.r.s:sess1.fresh-doc.m (root, single, manifest)
      .    | 🔑[4] ✅ external-cache
      .    | 🔑[5] ✅ feature-flag
      .    | 📖 ✅ tsdf._m.r.s:sess1.expired-doc.m (root, single, manifest) | 0.06 kb
      .    | 🗑️ ✅->❌ tsdf.sess1.expired-doc (entry)
      .    | 🗑️ ✅->❌ tsdf._m.r.s:sess1.expired-doc.m (root, single, manifest)
      .    | 📖 ✅ tsdf._m.r.s:sess1.fresh-doc.m (root, single, manifest) | 0.06 kb
      .    | ✍️ ❌->✅ tsdf._m.g (global maintenance) | ❌ -> 0.05 kb
      "
    `);

    expect(getParsedLocalStorageValue('tsdf._m.g')).toMatchInlineSnapshot(`
      lca: 1735689602000
      v: 1
    `);
  });

  test('expiration cleanup leaves malformed payload blobs untouched and still snapshots the full manifest scan history', async () => {
    const triggerDoc = persistentStore.scope('trigger', 'sess1');

    // Seed malformed payload data plus managed metadata so cleanup can see the entry without parsing the blob.
    localStorage.setItem(
      'tsdf.sess1.corrupted',
      JSON.stringify({ data: 'bad', version: 1 }),
    );
    upsertManagedLocalStorageSingleEntry({
      storageKey: 'tsdf.sess1.corrupted',
    });
    triggerDoc.document.seed({ value: { name: 'ok', value: 1 } });

    createDocumentEnv({ storeName: 'trigger', sessionKey: 'sess1' });

    const readCapture = startPersistentStorageOperationCapture();
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(localStorage.getItem('tsdf.sess1.corrupted')).not.toBeNull();
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time |
      2s   | 📖 ❌ tsdf._m.g (global maintenance)
      .    | 🔑[0] ✅ tsdf.sess1.corrupted (entry)
      .    | 🔑[1] ✅ tsdf._m.r.s:sess1.corrupted.m (root, single, manifest)
      .    | 🔑[2] ✅ tsdf.sess1.trigger (entry)
      .    | 🔑[3] ✅ tsdf._m.r.s:sess1.trigger.m (root, single, manifest)
      .    | 📖 ✅ tsdf._m.r.s:sess1.corrupted.m (root, single, manifest) | 0.06 kb
      .    | 📖 ✅ tsdf._m.r.s:sess1.trigger.m (root, single, manifest) | 0.06 kb
      .    | ✍️ ❌->✅ tsdf._m.g (global maintenance) | ❌ -> 0.05 kb
      "
    `);
  });

  test('protected dotted-session cleanup keeps the protected entry and snapshots the full manifest scan history', async () => {
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
        getSessionKey: () => dottedSessionKey,
        testScenario: 'loaded',
        __DANGEROUS_IGNORE_INITIAL_TIME_CHECK__: true,
        persistentStorage: {
          storeName: 'protected-doc',
          adapter: 'local-sync',
          schema: wrappedDocumentSchema,
          offlineMode: {
            network: offlineNetwork.config,
            operations: {
              markProtected: {
                inputSchema: rc_object({ value: rc_number }),
                execute: ({ input }) => input,
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

    expect(protectMutationResult.ok).toBe(true);

    // Reset the one-off scheduling state so the fresh trigger store schedules the cleanup we want to capture.
    resetExpirationScanTracking();

    // A fresh entry in another session triggers the scheduled global maintenance pass.
    const triggerDocEnv = createDocumentStoreTestEnv(
      { name: 'trigger', value: 3 },
      {
        getSessionKey: () => 'sess-trigger',
        __DANGEROUS_IGNORE_INITIAL_TIME_CHECK__: true,
        persistentStorage: {
          storeName: 'trigger-doc',
          adapter: 'local-sync',
          schema: wrappedDocumentSchema,
        },
      },
    );
    triggerDocEnv.scheduleFetch('highPriority');
    await advanceTime(1810);

    // Capture the full sweep so the snapshot shows the manifest-only scan and stale-entry removal.
    const readCapture = startPersistentStorageOperationCapture();
    await waitForScheduledCleanup(190);
    const operationsBreakdown = readCapture.finish().timelineString;

    // The protected dotted-session entry should survive, while the unprotected stale entry is discarded.
    expect({
      protectedEntryExists:
        localStorage.getItem(protectedDocStorageKey) !== null,
      unprotectedEntryExists:
        localStorage.getItem(unprotectedDocStorageKey) !== null,
    }).toMatchInlineSnapshot(`
      protectedEntryExists: '✅'
      unprotectedEntryExists: '❌'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time  |
      190ms | 📖 ✅ tsdf._m.g (global maintenance) | 0.05 kb
      .     | 🔑[0] ✅ tsdf.user@example.com.protected-doc (entry)
      .     | 🔑[1] ✅ tsdf._m.r.s:user@example.com.protected-doc.m (root, single, manifest)
      .     | 🔑[2] ✅ tsdf._m.g (global maintenance)
      .     | 🔑[3] ✅ tsdf.user@example.com.unprotected-doc (entry)
      .     | 🔑[4] ✅ tsdf._m.r.s:user@example.com.unprotected-doc.m (root, single, manifest)
      .     | 🔑[5] ✅ tsdf.user@example.com._o_.s (entry, offline session status)
      .     | 🔑[6] ✅ tsdf._m.r.s:user@example.com._o_.s.m (root, single, manifest, offline session status)
      .     | 🔑[7] ✅ tsdf.user@example.com.protected-doc.oq.protected-doc:1736380803620:4fzzzxjy (entry, offline queue)
      .     | 🔑[8] ✅ tsdf._m.r.n:user@example.com.protected-doc.oq.m (root, namespace, manifest, offline queue)
      .     | 🔑[9] ✅ tsdf.user@example.com.protected-doc.oe.document (entry, offline entity)
      .     | 🔑[10] ✅ tsdf._m.r.n:user@example.com.protected-doc.oe.m (root, namespace, manifest, offline entity)
      .     | 🔑[11] ✅ tsdf.sess-trigger.trigger-doc (entry)
      .     | 🔑[12] ✅ tsdf._m.r.s:sess-trigger.trigger-doc.m (root, single, manifest)
      .     | 📖 ✅ tsdf._m.r.s:user@example.com.protected-doc.m (root, single, manifest) | 0.09 kb
      .     | 📖 ✅ tsdf._m.r.s:user@example.com.unprotected-doc.m (root, single, manifest) | 0.06 kb
      .     | 🗑️ ✅->❌ tsdf.user@example.com.unprotected-doc (entry)
      .     | 🗑️ ✅->❌ tsdf._m.r.s:user@example.com.unprotected-doc.m (root, single, manifest)
      .     | 📖 ✅ tsdf._m.r.s:user@example.com._o_.s.m (root, single, manifest, offline session status) | 0.06 kb
      .     | 📖 ✅ tsdf._m.r.n:user@example.com.protected-doc.oq.m (root, namespace, manifest, offline queue) | 0.15 kb
      .     | 📖 ✅ tsdf._m.r.n:user@example.com.protected-doc.oe.m (root, namespace, manifest, offline entity) | 0.09 kb
      .     | 📖 ✅ tsdf._m.r.s:sess-trigger.trigger-doc.m (root, single, manifest) | 0.06 kb
      .     | ✍️ ✅->✅ tsdf._m.g (global maintenance) | 0.05 kb -> 0.05 kb
      "
    `);
    expect(
      getParsedLocalStorageValue(
        'tsdf._m.r.s:user@example.com.protected-doc.m',
      ),
    ).toMatchInlineSnapshot(`
      e:
        - a: 1735689601810
          m: { o: '✅' }
      v: 1
    `);
  });
});
