import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, test } from 'vitest';
import { createOpfsPersistentStorageTestStore } from '../../utils/opfsPersistentStorageTestStore';
import {
  getParsedOpfsEntryFiles,
  startOpfsPersistentStorageOperationCapture,
} from '../../utils/persistentStorageOptimizationTestUtils';
import {
  captureHookRemount,
  createCollectionEnv,
  flushInvalidationPersistence,
  markEntryOfflineProtected,
  readEntryMetadata,
  setProtectedKeysSnapshot,
  settleStartupBackgroundScan,
  setupAsyncStorageEfficiencyTestSuite,
  waitForScheduledCleanup,
} from './shared';
import { advanceTime, flushAllTimers } from '../../utils/genericTestUtils';

setupAsyncStorageEfficiencyTestSuite();

describe('async storage efficiency: collection', () => {
  test('expiration cleanup removes expired items through namespace manifests only', async () => {
    const expiredTimestamp = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const storeName = 'collection-expiration';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    // Seed one expired item and one fresh item so cleanup has a meaningful choice.
    const expiredItemKey = collectionScope.collection.seedItem(
      'expired-user',
      { value: { id: 'expired-user', name: 'Expired User' } },
      { timestamp: expiredTimestamp },
    );
    const expiredItemKey2 = collectionScope.collection.seedItem(
      'expired-user-2',
      { value: { id: 'expired-user-2', name: 'Expired User 2' } },
      { timestamp: expiredTimestamp },
    );
    const freshItemKey = collectionScope.collection.seedItem('fresh-user', {
      value: { id: 'fresh-user', name: 'Fresh User' },
    });
    // Startup should only queue the background scan.
    const startupOperationCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    createCollectionEnv({ storeName, sessionKey });
    const startupOperationBreakdown =
      startupOperationCapture.finish().timelineString;

    expect(startupOperationBreakdown).toMatchInlineSnapshot(`"empty"`);

    // Once the scan runs, capture the full metadata cleanup history.
    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      expiredItemExists: mockAdapter.has(expiredItemKey),
      expiredItem2Exists: mockAdapter.has(expiredItemKey2),
      freshItemExists: mockAdapter.has(freshItemKey),
    }).toMatchInlineSnapshot(`
      expiredItem2Exists: '❌'
      expiredItemExists: '❌'
      freshItemExists: '✅'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      simplified
      time   |
      2.002s | 🗂️ list-dir tsdf (root directory) entries=["dir:sess1"]
      .      | 🗂️ list-dir tsdf/sess1
             |    └ (session directory) entries=["dir:collection-expiration"]
      2.003s | 🗂️ list-dir tsdf/sess1
             |    └ (session directory) entries=["dir:collection-expiration"]
      2.004s | 🗑️ ✅ tsdf/sess1/collection-expiration/ci.%22expired-user.p.json
             |    └ (tsdf.sess1.collection-expiration.ci."expired-user (payload))
      .      | 🗑️ ✅ tsdf/sess1/collection-expiration/ci.%22expired-user.m.json
             |    └ (tsdf.sess1.collection-expiration.ci."expired-user (metadata))
      .      | 🗑️ ✅ tsdf/sess1/collection-expiration/ci.%22expired-user-2.p.json
             |    └ (tsdf.sess1.collection-expiration.ci."expired-user-2 (payload))
      .      | 🗑️ ✅ tsdf/sess1/collection-expiration/ci.%22expired-user-2.m.json
             |    └ (tsdf.sess1.collection-expiration.ci."expired-user-2 (metadata))
      .      | 🗂️ list-dir tsdf/sess1/collection-expiration
             |    └ (store directory) entries=["file:ci.%22fresh-user.m.json","file:ci.%22fresh-user.p.json"]
      2.006s | 📖 tsdf/sess1/collection-expiration/ci.%22expired-user-2.m.json
             |    └ (tsdf.sess1.collection-expiration.ci."expired-user-2 (metadata)) | 0.29 kb
      .      | 📖 tsdf/sess1/collection-expiration/ci.%22expired-user.m.json
             |    └ (tsdf.sess1.collection-expiration.ci."expired-user (metadata)) | 0.28 kb
      .      | 📖 tsdf/sess1/collection-expiration/ci.%22fresh-user.m.json
             |    └ (tsdf.sess1.collection-expiration.ci."fresh-user (metadata)) | 0.27 kb

      verbose
      time   |
      2.002s | 📁 dir-open-or-create ✅ tsdf (root directory)
      .      | 🗂️ list-dir tsdf (root directory) entries=["dir:sess1"]
      .      | 🗂️ list-dir tsdf/sess1
             |    └ (session directory) entries=["dir:collection-expiration"]
      2.003s | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      .      | 📄 file-open ✅ tsdf/sess1/collection-expiration/ci.%22expired-user-2.m.json
             |    └ (tsdf.sess1.collection-expiration.ci."expired-user-2 (metadata))
      .      | 📄 file-open ✅ tsdf/sess1/collection-expiration/ci.%22expired-user.m.json
             |    └ (tsdf.sess1.collection-expiration.ci."expired-user (metadata))
      .      | 📄 file-open ✅ tsdf/sess1/collection-expiration/ci.%22fresh-user.m.json
             |    └ (tsdf.sess1.collection-expiration.ci."fresh-user (metadata))
      .      | 🗂️ list-dir tsdf/sess1
             |    └ (session directory) entries=["dir:collection-expiration"]
      2.004s | 🗑️ ✅ tsdf/sess1/collection-expiration/ci.%22expired-user.p.json
             |    └ (tsdf.sess1.collection-expiration.ci."expired-user (payload))
      .      | 🗑️ ✅ tsdf/sess1/collection-expiration/ci.%22expired-user.m.json
             |    └ (tsdf.sess1.collection-expiration.ci."expired-user (metadata))
      .      | 🗑️ ✅ tsdf/sess1/collection-expiration/ci.%22expired-user-2.p.json
             |    └ (tsdf.sess1.collection-expiration.ci."expired-user-2 (payload))
      .      | 🗑️ ✅ tsdf/sess1/collection-expiration/ci.%22expired-user-2.m.json
             |    └ (tsdf.sess1.collection-expiration.ci."expired-user-2 (metadata))
      .      | 🗂️ list-dir tsdf/sess1/collection-expiration
             |    └ (store directory) entries=["file:ci.%22fresh-user.m.json","file:ci.%22fresh-user.p.json"]
      2.006s | 📖 tsdf/sess1/collection-expiration/ci.%22expired-user-2.m.json
             |    └ (tsdf.sess1.collection-expiration.ci."expired-user-2 (metadata)) | 0.29 kb
      .      | 📖 tsdf/sess1/collection-expiration/ci.%22expired-user.m.json
             |    └ (tsdf.sess1.collection-expiration.ci."expired-user (metadata)) | 0.28 kb
      .      | 📖 tsdf/sess1/collection-expiration/ci.%22fresh-user.m.json
             |    └ (tsdf.sess1.collection-expiration.ci."fresh-user (metadata)) | 0.27 kb
      "
    `);
    expect(getParsedOpfsEntryFiles(mockAdapter, freshItemKey))
      .toMatchInlineSnapshot(`
        metadata:
          customMetadata: { p: 'fresh-user' }
          key: '"fresh-user'
          lastAccessAt: 1735689600000
          sizeBytes: 72
          version: 1
          writtenAt: 1735689600000

        payload:
          d:
            value: { id: 'fresh-user', name: 'Fresh User' }
          p: 'fresh-user'
      `);
  });

  test('maxItems cleanup snapshots the full manifest history', async () => {
    const storeName = 'col-max-items-metadata';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('a', {
      value: { id: 'a', name: 'Oldest cached' },
    });
    await advanceTime(100);
    collectionScope.collection.seedItem('b', {
      value: { id: 'b', name: 'Newer cached' },
    });

    // Startup should only queue the background scan.
    const startupOperationCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    const env = createCollectionEnv({ storeName, sessionKey, maxItems: 2 });
    const startupOperationBreakdown =
      startupOperationCapture.finish().timelineString;

    expect(startupOperationBreakdown).toMatchInlineSnapshot(`"empty"`);

    // Drain the startup-scheduled cleanup before capturing the maxItems flush.
    await settleStartupBackgroundScan(mockAdapter);

    // Adding a third item should capture the write path plus the cleanup sequence.
    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    env.apiStore.addItemToState('c', { value: { id: 'c', name: 'Fresh' } });
    await advanceTime(1100);
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      collectionScope.collection.listStoredPayloads().sort(),
    ).toMatchInlineSnapshot(`['b', 'c']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      simplified
      time   |
      4.102s | 🗂️ list-dir tsdf/sess1/col-max-items-metadata
             |    └ (store directory) entries=["file:ci.%22a.m.json","file:ci.%22a.p.json","file:ci.%22b.m.json","file:ci.%22b.p.json"]
      4.147s | ✍️ tsdf/sess1/col-max-items-metadata/ci.%22c.p.json
             |    └ (tsdf.sess1.col-max-items-metadata.ci."c (payload)) | 0.00 kb -> 0.10 kb
      .      | ✍️ tsdf/sess1/col-max-items-metadata/ci.%22c.m.json
             |    └ (tsdf.sess1.col-max-items-metadata.ci."c (metadata)) | 0.00 kb -> 0.24 kb
      6.14s  | 🗂️ list-dir tsdf/sess1/col-max-items-metadata
             |    └ (store directory) entries=["file:ci.%22a.m.json","file:ci.%22a.p.json","file:ci.%22b.m.json","file:ci.%22b.p.json","file:ci.%22c.m.json","file:ci.%22c.p.json"]
      6.143s | 📖 tsdf/sess1/col-max-items-metadata/ci.%22a.m.json
             |    └ (tsdf.sess1.col-max-items-metadata.ci."a (metadata)) | 0.24 kb
      .      | 📖 tsdf/sess1/col-max-items-metadata/ci.%22b.m.json
             |    └ (tsdf.sess1.col-max-items-metadata.ci."b (metadata)) | 0.24 kb
      .      | 📖 tsdf/sess1/col-max-items-metadata/ci.%22c.m.json
             |    └ (tsdf.sess1.col-max-items-metadata.ci."c (metadata)) | 0.24 kb
      6.18s  | 🗂️ list-dir tsdf/sess1
             |    └ (session directory) entries=["dir:col-max-items-metadata"]
      6.181s | 🗑️ ✅ tsdf/sess1/col-max-items-metadata/ci.%22a.p.json
             |    └ (tsdf.sess1.col-max-items-metadata.ci."a (payload))
      .      | 🗑️ ✅ tsdf/sess1/col-max-items-metadata/ci.%22a.m.json
             |    └ (tsdf.sess1.col-max-items-metadata.ci."a (metadata))
      .      | 🗂️ list-dir tsdf/sess1/col-max-items-metadata
             |    └ (store directory) entries=["file:ci.%22b.m.json","file:ci.%22b.p.json","file:ci.%22c.m.json","file:ci.%22c.p.json"]

      verbose
      time   |
      4.101s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      4.102s | 📂 dir-open ✅ tsdf/sess1/col-max-items-metadata (store directory)
      .      | 🗂️ list-dir tsdf/sess1/col-max-items-metadata
             |    └ (store directory) entries=["file:ci.%22a.m.json","file:ci.%22a.p.json","file:ci.%22b.m.json","file:ci.%22b.p.json"]
      4.103s | 📄 file-open ✅ tsdf/sess1/col-max-items-metadata/ci.%22a.m.json
             |    └ (tsdf.sess1.col-max-items-metadata.ci."a (metadata))
      4.104s | 📄 file-open ✅ tsdf/sess1/col-max-items-metadata/ci.%22a.p.json
             |    └ (tsdf.sess1.col-max-items-metadata.ci."a (payload))
      4.105s | 📄 file-open ✅ tsdf/sess1/col-max-items-metadata/ci.%22b.m.json
             |    └ (tsdf.sess1.col-max-items-metadata.ci."b (metadata))
      4.106s | 📄 file-open ✅ tsdf/sess1/col-max-items-metadata/ci.%22b.p.json
             |    └ (tsdf.sess1.col-max-items-metadata.ci."b (payload))
      4.141s | 📄 file-open ❌ tsdf/sess1/col-max-items-metadata/ci.%22c.m.json
             |    └ (tsdf.sess1.col-max-items-metadata.ci."c (metadata))
      .      | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      4.142s | 📁 dir-open-or-create ✅ tsdf/sess1/col-max-items-metadata (store directory)
      4.143s | 📄 file-open-or-create 🆕 tsdf/sess1/col-max-items-metadata/ci.%22c.p.json
             |    └ (tsdf.sess1.col-max-items-metadata.ci."c (payload))
      .      | 📄 file-open-or-create 🆕 tsdf/sess1/col-max-items-metadata/ci.%22c.m.json
             |    └ (tsdf.sess1.col-max-items-metadata.ci."c (metadata))
      4.147s | ✍️ tsdf/sess1/col-max-items-metadata/ci.%22c.p.json
             |    └ (tsdf.sess1.col-max-items-metadata.ci."c (payload)) | 0.00 kb -> 0.10 kb
      .      | ✍️ tsdf/sess1/col-max-items-metadata/ci.%22c.m.json
             |    └ (tsdf.sess1.col-max-items-metadata.ci."c (metadata)) | 0.00 kb -> 0.24 kb
      6.14s  | 🗂️ list-dir tsdf/sess1/col-max-items-metadata
             |    └ (store directory) entries=["file:ci.%22a.m.json","file:ci.%22a.p.json","file:ci.%22b.m.json","file:ci.%22b.p.json","file:ci.%22c.m.json","file:ci.%22c.p.json"]
      6.141s | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      6.143s | 📖 tsdf/sess1/col-max-items-metadata/ci.%22a.m.json
             |    └ (tsdf.sess1.col-max-items-metadata.ci."a (metadata)) | 0.24 kb
      .      | 📖 tsdf/sess1/col-max-items-metadata/ci.%22b.m.json
             |    └ (tsdf.sess1.col-max-items-metadata.ci."b (metadata)) | 0.24 kb
      .      | 📖 tsdf/sess1/col-max-items-metadata/ci.%22c.m.json
             |    └ (tsdf.sess1.col-max-items-metadata.ci."c (metadata)) | 0.24 kb
      6.18s  | 🗂️ list-dir tsdf/sess1
             |    └ (session directory) entries=["dir:col-max-items-metadata"]
      6.181s | 🗑️ ✅ tsdf/sess1/col-max-items-metadata/ci.%22a.p.json
             |    └ (tsdf.sess1.col-max-items-metadata.ci."a (payload))
      .      | 🗑️ ✅ tsdf/sess1/col-max-items-metadata/ci.%22a.m.json
             |    └ (tsdf.sess1.col-max-items-metadata.ci."a (metadata))
      .      | 🗂️ list-dir tsdf/sess1/col-max-items-metadata
             |    └ (store directory) entries=["file:ci.%22b.m.json","file:ci.%22b.p.json","file:ci.%22c.m.json","file:ci.%22c.p.json"]
      "
    `);
  });

  test('multiple overflowing collection updates before idle maintenance trigger a single cleanup pass', async () => {
    const storeName = 'col-coalesced-maintenance';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('a', {
      value: { id: 'a', name: 'Oldest cached' },
    });
    await advanceTime(100);
    collectionScope.collection.seedItem('b', {
      value: { id: 'b', name: 'Newer cached' },
    });

    const env = createCollectionEnv({ storeName, sessionKey, maxItems: 2 });

    // Drain the startup maintenance so the capture only covers the coalesced overflow path.
    await settleStartupBackgroundScan(mockAdapter);

    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );

    // First overflow schedules maintenance, but does not run it yet.
    env.apiStore.addItemToState('c', { value: { id: 'c', name: 'Third' } });
    await advanceTime(1100);

    // A second overflow lands before cleanup fires and should reuse that same pass.
    env.apiStore.addItemToState('d', { value: { id: 'd', name: 'Fourth' } });
    await advanceTime(1100);
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      collectionScope.collection.listStoredPayloads().sort(),
    ).toMatchInlineSnapshot(`['c', 'd']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      simplified
      time   |
      4.102s | 🗂️ list-dir tsdf/sess1/col-coalesced-maintenance
             |    └ (store directory) entries=["file:ci.%22a.m.json","file:ci.%22a.p.json","file:ci.%22b.m.json","file:ci.%22b.p.json"]
      4.147s | ✍️ tsdf/sess1/col-coalesced-maintenance/ci.%22c.p.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."c (payload)) | 0.00 kb -> 0.10 kb
      .      | ✍️ tsdf/sess1/col-coalesced-maintenance/ci.%22c.m.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."c (metadata)) | 0.00 kb -> 0.24 kb
      5.247s | ✍️ tsdf/sess1/col-coalesced-maintenance/ci.%22d.p.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."d (payload)) | 0.00 kb -> 0.10 kb
      .      | ✍️ tsdf/sess1/col-coalesced-maintenance/ci.%22d.m.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."d (metadata)) | 0.00 kb -> 0.24 kb
      6.14s  | 🗂️ list-dir tsdf/sess1/col-coalesced-maintenance
             |    └ (store directory) entries=["file:ci.%22a.m.json","file:ci.%22a.p.json","file:ci.%22b.m.json","file:ci.%22b.p.json","file:ci.%22c.m.json","file:ci.%22c.p.json","file:ci.%22d.m.json","file:ci.%22d.p.json"]
      6.143s | 📖 tsdf/sess1/col-coalesced-maintenance/ci.%22a.m.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."a (metadata)) | 0.24 kb
      .      | 📖 tsdf/sess1/col-coalesced-maintenance/ci.%22b.m.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."b (metadata)) | 0.24 kb
      .      | 📖 tsdf/sess1/col-coalesced-maintenance/ci.%22c.m.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."c (metadata)) | 0.24 kb
      .      | 📖 tsdf/sess1/col-coalesced-maintenance/ci.%22d.m.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."d (metadata)) | 0.24 kb
      6.18s  | 🗂️ list-dir tsdf/sess1
             |    └ (session directory) entries=["dir:col-coalesced-maintenance"]
      6.181s | 🗑️ ✅ tsdf/sess1/col-coalesced-maintenance/ci.%22b.p.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."b (payload))
      .      | 🗑️ ✅ tsdf/sess1/col-coalesced-maintenance/ci.%22b.m.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."b (metadata))
      .      | 🗑️ ✅ tsdf/sess1/col-coalesced-maintenance/ci.%22a.p.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."a (payload))
      .      | 🗑️ ✅ tsdf/sess1/col-coalesced-maintenance/ci.%22a.m.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."a (metadata))
      .      | 🗂️ list-dir tsdf/sess1/col-coalesced-maintenance
             |    └ (store directory) entries=["file:ci.%22c.m.json","file:ci.%22c.p.json","file:ci.%22d.m.json","file:ci.%22d.p.json"]

      verbose
      time   |
      4.101s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      4.102s | 📂 dir-open ✅ tsdf/sess1/col-coalesced-maintenance (store directory)
      .      | 🗂️ list-dir tsdf/sess1/col-coalesced-maintenance
             |    └ (store directory) entries=["file:ci.%22a.m.json","file:ci.%22a.p.json","file:ci.%22b.m.json","file:ci.%22b.p.json"]
      4.103s | 📄 file-open ✅ tsdf/sess1/col-coalesced-maintenance/ci.%22a.m.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."a (metadata))
      4.104s | 📄 file-open ✅ tsdf/sess1/col-coalesced-maintenance/ci.%22a.p.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."a (payload))
      4.105s | 📄 file-open ✅ tsdf/sess1/col-coalesced-maintenance/ci.%22b.m.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."b (metadata))
      4.106s | 📄 file-open ✅ tsdf/sess1/col-coalesced-maintenance/ci.%22b.p.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."b (payload))
      4.141s | 📄 file-open ❌ tsdf/sess1/col-coalesced-maintenance/ci.%22c.m.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."c (metadata))
      .      | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      4.142s | 📁 dir-open-or-create ✅ tsdf/sess1/col-coalesced-maintenance (store directory)
      4.143s | 📄 file-open-or-create 🆕 tsdf/sess1/col-coalesced-maintenance/ci.%22c.p.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."c (payload))
      .      | 📄 file-open-or-create 🆕 tsdf/sess1/col-coalesced-maintenance/ci.%22c.m.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."c (metadata))
      4.147s | ✍️ tsdf/sess1/col-coalesced-maintenance/ci.%22c.p.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."c (payload)) | 0.00 kb -> 0.10 kb
      .      | ✍️ tsdf/sess1/col-coalesced-maintenance/ci.%22c.m.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."c (metadata)) | 0.00 kb -> 0.24 kb
      5.241s | 📄 file-open ❌ tsdf/sess1/col-coalesced-maintenance/ci.%22d.m.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."d (metadata))
      .      | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      5.242s | 📁 dir-open-or-create ✅ tsdf/sess1/col-coalesced-maintenance (store directory)
      5.243s | 📄 file-open-or-create 🆕 tsdf/sess1/col-coalesced-maintenance/ci.%22d.p.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."d (payload))
      .      | 📄 file-open-or-create 🆕 tsdf/sess1/col-coalesced-maintenance/ci.%22d.m.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."d (metadata))
      5.247s | ✍️ tsdf/sess1/col-coalesced-maintenance/ci.%22d.p.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."d (payload)) | 0.00 kb -> 0.10 kb
      .      | ✍️ tsdf/sess1/col-coalesced-maintenance/ci.%22d.m.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."d (metadata)) | 0.00 kb -> 0.24 kb
      6.14s  | 🗂️ list-dir tsdf/sess1/col-coalesced-maintenance
             |    └ (store directory) entries=["file:ci.%22a.m.json","file:ci.%22a.p.json","file:ci.%22b.m.json","file:ci.%22b.p.json","file:ci.%22c.m.json","file:ci.%22c.p.json","file:ci.%22d.m.json","file:ci.%22d.p.json"]
      6.141s | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      6.143s | 📖 tsdf/sess1/col-coalesced-maintenance/ci.%22a.m.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."a (metadata)) | 0.24 kb
      .      | 📖 tsdf/sess1/col-coalesced-maintenance/ci.%22b.m.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."b (metadata)) | 0.24 kb
      .      | 📖 tsdf/sess1/col-coalesced-maintenance/ci.%22c.m.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."c (metadata)) | 0.24 kb
      .      | 📖 tsdf/sess1/col-coalesced-maintenance/ci.%22d.m.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."d (metadata)) | 0.24 kb
      6.18s  | 🗂️ list-dir tsdf/sess1
             |    └ (session directory) entries=["dir:col-coalesced-maintenance"]
      6.181s | 🗑️ ✅ tsdf/sess1/col-coalesced-maintenance/ci.%22b.p.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."b (payload))
      .      | 🗑️ ✅ tsdf/sess1/col-coalesced-maintenance/ci.%22b.m.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."b (metadata))
      .      | 🗑️ ✅ tsdf/sess1/col-coalesced-maintenance/ci.%22a.p.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."a (payload))
      .      | 🗑️ ✅ tsdf/sess1/col-coalesced-maintenance/ci.%22a.m.json
             |    └ (tsdf.sess1.col-coalesced-maintenance.ci."a (metadata))
      .      | 🗂️ list-dir tsdf/sess1/col-coalesced-maintenance
             |    └ (store directory) entries=["file:ci.%22c.m.json","file:ci.%22c.p.json","file:ci.%22d.m.json","file:ci.%22d.p.json"]
      "
    `);
  });

  test('direct getItemState reads the cached collection item multiple times with short gaps and promotes it once', async () => {
    const storeName = 'col-direct-get-item-state';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    // Drain the startup scan so this capture only measures the direct read path.
    await settleStartupBackgroundScan(mockAdapter);

    // Repeated direct reads with short gaps should hydrate once, then reuse in-memory state.
    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `undefined`,
    );
    await advanceTime(100);
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `undefined`,
    );
    await advanceTime(100);
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `undefined`,
    );
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(env.store.state).toMatchInlineSnapshot(`{}`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`"empty"`);
  });

  test('direct getItemState touch preserves an offline marker added by another tab before the batched manifest update', async () => {
    const storeName = 'col-direct-touch-offline-marker';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
    const collectionScope = mockAdapter.scope(storeName, sessionKey);
    const storageKey = collectionScope.collection.itemStorageKey('1');

    collectionScope.collection.seedItem(
      '1',
      { value: { id: '1', name: 'Cached user' } },
      { timestamp: Date.now() - 7 * 60 * 60 * 1000 },
    );

    const env = createCollectionEnv({ storeName, sessionKey });

    // Drain the startup scan so the later touch only comes from the direct read path.
    await settleStartupBackgroundScan(mockAdapter);

    // The direct read schedules a timestamp touch for the cached item.
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `undefined`,
    );

    // Simulate another tab marking the item as offline-protected before the touch runs.
    markEntryOfflineProtected(mockAdapter, storageKey);
    await advanceTime(40);
    await flushAllTimers();

    expect(readEntryMetadata(mockAdapter, storageKey)).toMatchInlineSnapshot(`
      customMetadata: { o: '✅', p: '1' }
      key: '"1'
      lastAccessAt: 1735664400000
      payloadRef: '__tsdf_payload__:"1'
      sizeBytes: 55
      version: 1
      writtenAt: 1735664400000
    `);
    expect(getParsedOpfsEntryFiles(mockAdapter, storageKey))
      .toMatchInlineSnapshot(`
        metadata:
          customMetadata: { o: '✅', p: '1' }
          key: '"1'
          lastAccessAt: 1735664400000
          sizeBytes: 55
          version: 1
          writtenAt: 1735664400000

        payload:
          d:
            value: { id: '1', name: 'Cached user' }
          p: '1'
      `);
  });

  test('updating a hydrated collection item writes the mutation without rereading cached entries', async () => {
    const storeName = 'col-mutation-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
    const collectionScope = mockAdapter.scope(storeName, sessionKey);
    const storageKey = collectionScope.collection.itemStorageKey('1');

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    // Hydrate the cached item through a normal mounted hook first.
    await settleStartupBackgroundScan(mockAdapter);
    renderHook(() =>
      env.apiStore.useItem('1', { disableRefetchOnMount: true }),
    );
    await flushInvalidationPersistence(0);

    // Mutating the already-hydrated item should only need writes.
    const mutationCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    act(() => {
      env.apiStore.updateItemState('1', (draft) => {
        draft.value.name = 'Edited user';
      });
    });
    await flushInvalidationPersistence();
    const mutationOperations = mutationCapture.finish().timelineString;

    expect(collectionScope.collection.readItemData('1')).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Edited user' }`,
    );
    expect(readEntryMetadata(mockAdapter, storageKey)).toMatchInlineSnapshot(`
      customMetadata: { p: '1' }
      key: '"1'
      lastAccessAt: 1735689600000
      payloadRef: '__tsdf_payload__:"1'
      sizeBytes: 55
      version: 1
      writtenAt: 1735689604140
    `);
    expect(mutationOperations).toMatchInlineSnapshot(`
      "
      simplified
      time   |
      4.05s  | 🗂️ list-dir tsdf/sess1/col-mutation-flow
             |    └ (store directory) entries=["file:ci.%221.m.json","file:ci.%221.p.json"]
      4.143s | 📖 tsdf/sess1/col-mutation-flow/ci.%221.m.json
             |    └ (tsdf.sess1.col-mutation-flow.ci."1 (metadata)) | 0.24 kb
      4.147s | ✍️ tsdf/sess1/col-mutation-flow/ci.%221.p.json
             |    └ (tsdf.sess1.col-mutation-flow.ci."1 (payload)) | 0.11 kb -> 0.11 kb
      .      | ✍️ tsdf/sess1/col-mutation-flow/ci.%221.m.json
             |    └ (tsdf.sess1.col-mutation-flow.ci."1 (metadata)) | 0.24 kb -> 0.24 kb
      6.14s  | 🗂️ list-dir tsdf/sess1/col-mutation-flow
             |    └ (store directory) entries=["file:ci.%221.m.json","file:ci.%221.p.json"]
      6.193s | 📖 tsdf/sess1/col-mutation-flow/ci.%221.m.json
             |    └ (tsdf.sess1.col-mutation-flow.ci."1 (metadata)) | 0.24 kb

      verbose
      time   |
      4.05s  | 🗂️ list-dir tsdf/sess1/col-mutation-flow
             |    └ (store directory) entries=["file:ci.%221.m.json","file:ci.%221.p.json"]
      4.141s | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      4.142s | 📁 dir-open-or-create ✅ tsdf/sess1/col-mutation-flow (store directory)
      4.143s | 📖 tsdf/sess1/col-mutation-flow/ci.%221.m.json
             |    └ (tsdf.sess1.col-mutation-flow.ci."1 (metadata)) | 0.24 kb
      .      | 📄 file-open-or-create ✅ tsdf/sess1/col-mutation-flow/ci.%221.p.json
             |    └ (tsdf.sess1.col-mutation-flow.ci."1 (payload))
      .      | 📄 file-open-or-create ✅ tsdf/sess1/col-mutation-flow/ci.%221.m.json
             |    └ (tsdf.sess1.col-mutation-flow.ci."1 (metadata))
      4.147s | ✍️ tsdf/sess1/col-mutation-flow/ci.%221.p.json
             |    └ (tsdf.sess1.col-mutation-flow.ci."1 (payload)) | 0.11 kb -> 0.11 kb
      .      | ✍️ tsdf/sess1/col-mutation-flow/ci.%221.m.json
             |    └ (tsdf.sess1.col-mutation-flow.ci."1 (metadata)) | 0.24 kb -> 0.24 kb
      6.14s  | 🗂️ list-dir tsdf/sess1/col-mutation-flow
             |    └ (store directory) entries=["file:ci.%221.m.json","file:ci.%221.p.json"]
      6.193s | 📖 tsdf/sess1/col-mutation-flow/ci.%221.m.json
             |    └ (tsdf.sess1.col-mutation-flow.ci."1 (metadata)) | 0.24 kb
      "
    `);
  });

  test('deleteItemState removes the persisted collection entry through the namespace manifest only', async () => {
    const storeName = 'col-delete-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);
    const deletedItemStorageKey =
      collectionScope.collection.itemStorageKey('1');

    const env = createCollectionEnv({ storeName, sessionKey });

    env.apiStore.addItemToState('1', { value: { id: '1', name: 'Alice' } });
    env.apiStore.addItemToState('2', { value: { id: '2', name: 'Bob' } });
    await advanceTime(1100);
    await flushAllTimers();

    // The delete capture should only include the debounced storage cleanup path.
    const deleteCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    env.apiStore.deleteItemState('1');
    await advanceTime(1100);
    await flushAllTimers();
    const deleteOperations = deleteCapture.finish().timelineString;

    expect(mockAdapter.has(deletedItemStorageKey)).toBe(false);
    expect(
      collectionScope.collection.listStoredPayloads().sort(),
    ).toMatchInlineSnapshot(`['2']`);
    expect(deleteOperations).toMatchInlineSnapshot(`
      "
      simplified
      time   |
      4.08s  | 🗂️ list-dir tsdf/sess1 (session directory) entries=["dir:col-delete-flow"]
      4.081s | 🗑️ ✅ tsdf/sess1/col-delete-flow/ci.%221.p.json
             |    └ (tsdf.sess1.col-delete-flow.ci."1 (payload))
      .      | 🗑️ ✅ tsdf/sess1/col-delete-flow/ci.%221.m.json
             |    └ (tsdf.sess1.col-delete-flow.ci."1 (metadata))
      .      | 🗂️ list-dir tsdf/sess1/col-delete-flow
             |    └ (store directory) entries=["file:ci.%222.m.json","file:ci.%222.p.json"]
      6.08s  | 🗂️ list-dir tsdf/sess1/col-delete-flow
             |    └ (store directory) entries=["file:ci.%222.m.json","file:ci.%222.p.json"]
      6.083s | 📖 tsdf/sess1/col-delete-flow/ci.%222.m.json
             |    └ (tsdf.sess1.col-delete-flow.ci."2 (metadata)) | 0.24 kb

      verbose
      time   |
      4.08s  | 🗂️ list-dir tsdf/sess1 (session directory) entries=["dir:col-delete-flow"]
      4.081s | 🗑️ ✅ tsdf/sess1/col-delete-flow/ci.%221.p.json
             |    └ (tsdf.sess1.col-delete-flow.ci."1 (payload))
      .      | 🗑️ ✅ tsdf/sess1/col-delete-flow/ci.%221.m.json
             |    └ (tsdf.sess1.col-delete-flow.ci."1 (metadata))
      .      | 🗂️ list-dir tsdf/sess1/col-delete-flow
             |    └ (store directory) entries=["file:ci.%222.m.json","file:ci.%222.p.json"]
      6.08s  | 🗂️ list-dir tsdf/sess1/col-delete-flow
             |    └ (store directory) entries=["file:ci.%222.m.json","file:ci.%222.p.json"]
      6.083s | 📖 tsdf/sess1/col-delete-flow/ci.%222.m.json
             |    └ (tsdf.sess1.col-delete-flow.ci."2 (metadata)) | 0.24 kb
      "
    `);
  });

  test('useItem invalidation snapshots the full persistence timeline through the refetch save', async () => {
    const storeName = 'col-invalidation-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({
      storeName,
      sessionKey,
      serverData: { '1': { id: '1', name: 'Fresh user' } },
    });

    // Hydrate cached data first without a mount refetch so the invalidation path stays isolated.
    await settleStartupBackgroundScan(mockAdapter);
    const hook = renderHook(() =>
      env.apiStore.useItem('1', {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);

    // Update the server copy, invalidate the mounted hook, then capture fetch completion plus the debounced save.
    const invalidationCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    act(() => {
      env.serverTable.setItem('1', { id: '1', name: 'Fresh user' });
      env.apiStore.invalidateItem('1');
    });
    await flushInvalidationPersistence();
    const invalidationOperations = invalidationCapture.finish().timelineString;

    expect(hook.result.current.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Fresh user' }`,
    );
    expect(collectionScope.collection.readItemData('1')).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Fresh user' }`,
    );
    expect(invalidationOperations).toMatchInlineSnapshot(`
      "
      simplified
      time   |
      4.86s  | 🗂️ list-dir tsdf/sess1/col-invalidation-flow
             |    └ (store directory) entries=["file:ci.%221.m.json","file:ci.%221.p.json"]
      4.953s | 📖 tsdf/sess1/col-invalidation-flow/ci.%221.m.json
             |    └ (tsdf.sess1.col-invalidation-flow.ci."1 (metadata)) | 0.24 kb
      4.957s | ✍️ tsdf/sess1/col-invalidation-flow/ci.%221.p.json
             |    └ (tsdf.sess1.col-invalidation-flow.ci."1 (payload)) | 0.11 kb -> 0.11 kb
      .      | ✍️ tsdf/sess1/col-invalidation-flow/ci.%221.m.json
             |    └ (tsdf.sess1.col-invalidation-flow.ci."1 (metadata)) | 0.24 kb -> 0.24 kb
      6.95s  | 🗂️ list-dir tsdf/sess1/col-invalidation-flow
             |    └ (store directory) entries=["file:ci.%221.m.json","file:ci.%221.p.json"]
      7.003s | 📖 tsdf/sess1/col-invalidation-flow/ci.%221.m.json
             |    └ (tsdf.sess1.col-invalidation-flow.ci."1 (metadata)) | 0.24 kb

      verbose
      time   |
      4.86s  | 🗂️ list-dir tsdf/sess1/col-invalidation-flow
             |    └ (store directory) entries=["file:ci.%221.m.json","file:ci.%221.p.json"]
      4.951s | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      4.952s | 📁 dir-open-or-create ✅ tsdf/sess1/col-invalidation-flow (store directory)
      4.953s | 📖 tsdf/sess1/col-invalidation-flow/ci.%221.m.json
             |    └ (tsdf.sess1.col-invalidation-flow.ci."1 (metadata)) | 0.24 kb
      .      | 📄 file-open-or-create ✅ tsdf/sess1/col-invalidation-flow/ci.%221.p.json
             |    └ (tsdf.sess1.col-invalidation-flow.ci."1 (payload))
      .      | 📄 file-open-or-create ✅ tsdf/sess1/col-invalidation-flow/ci.%221.m.json
             |    └ (tsdf.sess1.col-invalidation-flow.ci."1 (metadata))
      4.957s | ✍️ tsdf/sess1/col-invalidation-flow/ci.%221.p.json
             |    └ (tsdf.sess1.col-invalidation-flow.ci."1 (payload)) | 0.11 kb -> 0.11 kb
      .      | ✍️ tsdf/sess1/col-invalidation-flow/ci.%221.m.json
             |    └ (tsdf.sess1.col-invalidation-flow.ci."1 (metadata)) | 0.24 kb -> 0.24 kb
      6.95s  | 🗂️ list-dir tsdf/sess1/col-invalidation-flow
             |    └ (store directory) entries=["file:ci.%221.m.json","file:ci.%221.p.json"]
      6.951s | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      7.003s | 📖 tsdf/sess1/col-invalidation-flow/ci.%221.m.json
             |    └ (tsdf.sess1.col-invalidation-flow.ci."1 (metadata)) | 0.24 kb
      "
    `);
  });

  test('collection invalidation preserves an offline marker added by another tab before the manifest update', async () => {
    const storeName = 'col-offline-marker-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
    const collectionScope = mockAdapter.scope(storeName, sessionKey);
    const storageKey = collectionScope.collection.itemStorageKey('1');

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({
      storeName,
      sessionKey,
      serverData: { '1': { id: '1', name: 'Fresh user' } },
    });

    // Hydrate cached data first so the later save is a normal invalidation write.
    await settleStartupBackgroundScan(mockAdapter);
    const hook = renderHook(() =>
      env.apiStore.useItem('1', {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);

    // Simulate another tab marking this cached item as offline-protected.
    markEntryOfflineProtected(mockAdapter, storageKey);

    // A normal invalidation save should keep the externally-added offline marker.
    act(() => {
      env.serverTable.setItem('1', { id: '1', name: 'Fresh user' });
      env.apiStore.invalidateItem('1');
    });
    await flushInvalidationPersistence();

    expect(hook.result.current.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Fresh user' }`,
    );
    expect(readEntryMetadata(mockAdapter, storageKey)).toMatchInlineSnapshot(`
      customMetadata: { p: '1' }
      key: '"1'
      lastAccessAt: 1735689600000
      payloadRef: '__tsdf_payload__:"1'
      sizeBytes: 54
      version: 1
      writtenAt: 1735689604950
    `);
    expect(getParsedOpfsEntryFiles(mockAdapter, storageKey))
      .toMatchInlineSnapshot(`
        metadata:
          customMetadata: { p: '1' }
          key: '"1'
          lastAccessAt: 1735689600000
          sizeBytes: 54
          version: 1
          writtenAt: 1735689604950

        payload:
          d:
            value: { id: '1', name: 'Fresh user' }
          p: '1'
      `);
  });

  test('repeated invalidations within the debounce window coalesce collection persistence writes', async () => {
    const storeName = 'col-coalesced-invalidations';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({
      storeName,
      sessionKey,
      serverData: { '1': { id: '1', name: 'Fresh user 1' } },
    });

    // Hydrate cached data first so only the invalidation writes are counted below.
    await settleStartupBackgroundScan(mockAdapter);
    const hook = renderHook(() =>
      env.apiStore.useItem('1', {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);

    // Let the first refetch finish, but stay inside the debounced persistence window.
    const firstInvalidationCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    act(() => {
      env.serverTable.setItem('1', { id: '1', name: 'Fresh user 1' });
      env.apiStore.invalidateItem('1');
    });
    await advanceTime(900);
    const firstInvalidationOperations =
      firstInvalidationCapture.finish().timelineString;

    expect(hook.result.current.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Fresh user 1' }`,
    );
    expect(firstInvalidationOperations).toMatchInlineSnapshot(`"empty"`);

    // A second invalidation before the first debounce flush should replace the pending save.
    const secondInvalidationCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter, {
        storeName,
        sessionKey,
      });
    act(() => {
      env.serverTable.setItem('1', { id: '1', name: 'Fresh user 2' });
      env.apiStore.invalidateItem('1');
    });
    await advanceTime(1900);
    await flushAllTimers();
    const secondInvalidationOperations =
      secondInvalidationCapture.finish().timelineString;

    expect(hook.result.current.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Fresh user 2' }`,
    );
    expect(collectionScope.collection.readItemData('1')).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Fresh user 2' }`,
    );
    expect(secondInvalidationOperations).toMatchInlineSnapshot(`
      "
      simplified
      time   |
      5.76s  | 🗂️ list-dir tsdf/sess1/col-coalesced-invalidations
             |    └ (store directory) entries=["file:ci.%221.m.json","file:ci.%221.p.json"]
      5.853s | 📖 tsdf/sess1/col-coalesced-invalidations/ci.%221.m.json
             |    └ (tsdf.sess1.col-coalesced-invalidations.ci."1 (metadata)) | 0.24 kb
      5.857s | ✍️ tsdf/sess1/col-coalesced-invalidations/ci.%221.p.json
             |    └ (tsdf.sess1.col-coalesced-invalidations.ci."1 (payload)) | 0.11 kb -> 0.11 kb
      .      | ✍️ tsdf/sess1/col-coalesced-invalidations/ci.%221.m.json
             |    └ (tsdf.sess1.col-coalesced-invalidations.ci."1 (metadata)) | 0.24 kb -> 0.24 kb
      7.85s  | 🗂️ list-dir tsdf/sess1/col-coalesced-invalidations
             |    └ (store directory) entries=["file:ci.%221.m.json","file:ci.%221.p.json"]
      7.903s | 📖 tsdf/sess1/col-coalesced-invalidations/ci.%221.m.json
             |    └ (tsdf.sess1.col-coalesced-invalidations.ci."1 (metadata)) | 0.24 kb

      verbose
      time   |
      5.76s  | 🗂️ list-dir tsdf/sess1/col-coalesced-invalidations
             |    └ (store directory) entries=["file:ci.%221.m.json","file:ci.%221.p.json"]
      5.851s | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      5.852s | 📁 dir-open-or-create ✅ tsdf/sess1/col-coalesced-invalidations (store directory)
      5.853s | 📖 tsdf/sess1/col-coalesced-invalidations/ci.%221.m.json
             |    └ (tsdf.sess1.col-coalesced-invalidations.ci."1 (metadata)) | 0.24 kb
      .      | 📄 file-open-or-create ✅ tsdf/sess1/col-coalesced-invalidations/ci.%221.p.json
             |    └ (tsdf.sess1.col-coalesced-invalidations.ci."1 (payload))
      .      | 📄 file-open-or-create ✅ tsdf/sess1/col-coalesced-invalidations/ci.%221.m.json
             |    └ (tsdf.sess1.col-coalesced-invalidations.ci."1 (metadata))
      5.857s | ✍️ tsdf/sess1/col-coalesced-invalidations/ci.%221.p.json
             |    └ (tsdf.sess1.col-coalesced-invalidations.ci."1 (payload)) | 0.11 kb -> 0.11 kb
      .      | ✍️ tsdf/sess1/col-coalesced-invalidations/ci.%221.m.json
             |    └ (tsdf.sess1.col-coalesced-invalidations.ci."1 (metadata)) | 0.24 kb -> 0.24 kb
      7.85s  | 🗂️ list-dir tsdf/sess1/col-coalesced-invalidations
             |    └ (store directory) entries=["file:ci.%221.m.json","file:ci.%221.p.json"]
      7.851s | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      7.903s | 📖 tsdf/sess1/col-coalesced-invalidations/ci.%221.m.json
             |    └ (tsdf.sess1.col-coalesced-invalidations.ci."1 (metadata)) | 0.24 kb
      "
    `);
  });

  test('hook remount reuses hydrated collection state without touching localStorage again', async () => {
    const storeName = 'col-remount-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    // Drain the startup scan so the capture focuses on the UI mount path only.
    await settleStartupBackgroundScan(mockAdapter);

    // The first mount must hydrate the cold cached item from persistence.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount({
        mockAdapter,
        render: () =>
          env.apiStore.useItem('1', {
            disableRefetchOnMount: true,
            returnRefetchingStatus: true,
          }),
        sessionKey,
        storeName,
      });

    expect(secondHook.result.current.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Cached user' }`,
    );
    expect(firstMountOperations).toMatchInlineSnapshot(`
      "
      simplified
      time   |
      3.056s | 📖 tsdf/sess1/col-remount-flow/ci.%221.p.json
             |    └ (tsdf.sess1.col-remount-flow.ci."1 (payload)) | 0.11 kb
      .      | 📖 tsdf/sess1/col-remount-flow/ci.%221.m.json
             |    └ (tsdf.sess1.col-remount-flow.ci."1 (metadata)) | 0.24 kb

      verbose
      time   |
      3.001s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      3.002s | 📂 dir-open ✅ tsdf/sess1/col-remount-flow (store directory)
      3.003s | 📄 file-open ✅ tsdf/sess1/col-remount-flow/ci.%221.p.json
             |    └ (tsdf.sess1.col-remount-flow.ci."1 (payload))
      .      | 📄 file-open ✅ tsdf/sess1/col-remount-flow/ci.%221.m.json
             |    └ (tsdf.sess1.col-remount-flow.ci."1 (metadata))
      3.056s | 📖 tsdf/sess1/col-remount-flow/ci.%221.p.json
             |    └ (tsdf.sess1.col-remount-flow.ci."1 (payload)) | 0.11 kb
      .      | 📖 tsdf/sess1/col-remount-flow/ci.%221.m.json
             |    └ (tsdf.sess1.col-remount-flow.ci."1 (metadata)) | 0.24 kb
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('useMultipleItems remount reuses hydrated collection items without touching localStorage again', async () => {
    const storeName = 'col-multi-remount-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user 1' },
    });
    collectionScope.collection.seedItem('2', {
      value: { id: '2', name: 'Cached user 2' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    // Drain the startup scan so the capture focuses on the hook mount path only.
    await settleStartupBackgroundScan(mockAdapter);

    // The first mount must hydrate both cold cached items from persistence.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount({
        mockAdapter,
        render: () =>
          env.apiStore.useMultipleItems([{ payload: '1' }, { payload: '2' }], {
            disableRefetchOnMount: true,
            returnRefetchingStatus: true,
          }),
        sessionKey,
        storeName,
      });

    expect(secondHook.result.current.map((item) => item.data?.value))
      .toMatchInlineSnapshot(`
        - { id: '1', name: 'Cached user 1' }
        - { id: '2', name: 'Cached user 2' }
      `);
    expect(firstMountOperations).toMatchInlineSnapshot(`
      "
      simplified
      time   |
      3.056s | 📖 tsdf/sess1/col-multi-remount-flow/ci.%221.p.json
             |    └ (tsdf.sess1.col-multi-remount-flow.ci."1 (payload)) | 0.11 kb
      .      | 📖 tsdf/sess1/col-multi-remount-flow/ci.%221.m.json
             |    └ (tsdf.sess1.col-multi-remount-flow.ci."1 (metadata)) | 0.24 kb
      .      | 📖 tsdf/sess1/col-multi-remount-flow/ci.%222.p.json
             |    └ (tsdf.sess1.col-multi-remount-flow.ci."2 (payload)) | 0.11 kb
      .      | 📖 tsdf/sess1/col-multi-remount-flow/ci.%222.m.json
             |    └ (tsdf.sess1.col-multi-remount-flow.ci."2 (metadata)) | 0.24 kb

      verbose
      time   |
      3.001s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      3.002s | 📂 dir-open ✅ tsdf/sess1/col-multi-remount-flow (store directory)
      3.003s | 📄 file-open ✅ tsdf/sess1/col-multi-remount-flow/ci.%221.p.json
             |    └ (tsdf.sess1.col-multi-remount-flow.ci."1 (payload))
      .      | 📄 file-open ✅ tsdf/sess1/col-multi-remount-flow/ci.%221.m.json
             |    └ (tsdf.sess1.col-multi-remount-flow.ci."1 (metadata))
      .      | 📄 file-open ✅ tsdf/sess1/col-multi-remount-flow/ci.%222.p.json
             |    └ (tsdf.sess1.col-multi-remount-flow.ci."2 (payload))
      .      | 📄 file-open ✅ tsdf/sess1/col-multi-remount-flow/ci.%222.m.json
             |    └ (tsdf.sess1.col-multi-remount-flow.ci."2 (metadata))
      3.056s | 📖 tsdf/sess1/col-multi-remount-flow/ci.%221.p.json
             |    └ (tsdf.sess1.col-multi-remount-flow.ci."1 (payload)) | 0.11 kb
      .      | 📖 tsdf/sess1/col-multi-remount-flow/ci.%221.m.json
             |    └ (tsdf.sess1.col-multi-remount-flow.ci."1 (metadata)) | 0.24 kb
      .      | 📖 tsdf/sess1/col-multi-remount-flow/ci.%222.p.json
             |    └ (tsdf.sess1.col-multi-remount-flow.ci."2 (payload)) | 0.11 kb
      .      | 📖 tsdf/sess1/col-multi-remount-flow/ci.%222.m.json
             |    └ (tsdf.sess1.col-multi-remount-flow.ci."2 (metadata)) | 0.24 kb
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('getItemState stays in memory after a hook has already hydrated the collection item', async () => {
    const storeName = 'col-get-item-state-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    // Hydrate the item through a realistic UI mount first.
    await settleStartupBackgroundScan(mockAdapter);
    const hook = renderHook(() =>
      env.apiStore.useItem('1', { disableRefetchOnMount: true }),
    );
    await flushAllTimers();
    hook.unmount();

    // Direct imperative reads should now hit the materialized store state only.
    const getItemStateCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Cached user' }`,
    );
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Cached user' }`,
    );
    const getItemStateOperations = getItemStateCapture.finish().timelineString;

    expect(getItemStateOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('collection preload reads only the requested item payload', async () => {
    const storeName = 'collection-opfs-efficiency';
    const sessionKey = 'sess1';
    const hotPayload = '1';
    const coldPayload = '2';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
      initialState: {
        storeName,
        sessionKey,
        collection: [
          {
            payload: hotPayload,
            data: { value: { id: hotPayload, name: 'Hot' } },
          },
          {
            payload: coldPayload,
            data: { value: { id: coldPayload, name: 'Cold' } },
          },
        ],
      },
    });
    const collectionScope = mockAdapter.scope(storeName, sessionKey);
    const hotKey = collectionScope.collection.itemStorageKey(hotPayload);
    const coldKey = collectionScope.collection.itemStorageKey(coldPayload);
    const env = createCollectionEnv({ storeName, sessionKey });

    await settleStartupBackgroundScan(mockAdapter);
    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );

    const preloadPromise = env.apiStore.preloadItemFromStorage(hotPayload);
    await advanceTime(50);
    await preloadPromise;

    expect(readCapture.finish().timelineString).toMatchInlineSnapshot(`
      "
      simplified
      time   |
      3.056s | 📖 tsdf/sess1/collection-opfs-efficiency/ci.%221.p.json
             |    └ (tsdf.sess1.collection-opfs-efficiency.ci."1 (payload)) | 0.09 kb
      .      | 📖 tsdf/sess1/collection-opfs-efficiency/ci.%221.m.json
             |    └ (tsdf.sess1.collection-opfs-efficiency.ci."1 (metadata)) | 0.24 kb

      verbose
      time   |
      3.001s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      3.002s | 📂 dir-open ✅ tsdf/sess1/collection-opfs-efficiency (store directory)
      3.003s | 📄 file-open ✅ tsdf/sess1/collection-opfs-efficiency/ci.%221.p.json
             |    └ (tsdf.sess1.collection-opfs-efficiency.ci."1 (payload))
      .      | 📄 file-open ✅ tsdf/sess1/collection-opfs-efficiency/ci.%221.m.json
             |    └ (tsdf.sess1.collection-opfs-efficiency.ci."1 (metadata))
      3.056s | 📖 tsdf/sess1/collection-opfs-efficiency/ci.%221.p.json
             |    └ (tsdf.sess1.collection-opfs-efficiency.ci."1 (payload)) | 0.09 kb
      .      | 📖 tsdf/sess1/collection-opfs-efficiency/ci.%221.m.json
             |    └ (tsdf.sess1.collection-opfs-efficiency.ci."1 (metadata)) | 0.24 kb
      "
    `);

    expect(mockAdapter.payloadGetManyRequests.flat()).toContain(hotKey);
    expect(mockAdapter.payloadGetManyRequests.flat()).not.toContain(coldKey);
  });

  test('protected snapshot reuse avoids rereading the async protected registry during eviction', async () => {
    const storeName = 'collection-opfs-protected-snapshot';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);
    const env = createCollectionEnv({ storeName, sessionKey, maxItems: 2 });

    await settleStartupBackgroundScan(mockAdapter);
    setProtectedKeysSnapshot(sessionKey, [
      collectionScope.collection.itemStorageKey('1'),
    ]);

    env.apiStore.addItemToState('1', { value: { id: '1', name: 'One' } });
    env.apiStore.addItemToState('2', { value: { id: '2', name: 'Two' } });
    await advanceTime(1100);
    await flushAllTimers();
    mockAdapter.clearInstrumentation();

    env.apiStore.addItemToState('3', { value: { id: '3', name: 'Three' } });
    await advanceTime(1100);
    await flushAllTimers();

    expect(mockAdapter.payloadGetRequests).toMatchInlineSnapshot(`[]`);
    expect(mockAdapter.listKeysRequests).toMatchInlineSnapshot(`
      - kind: 'collection.item'
        sessionKey: 'sess1'
        storeName: 'collection-opfs-protected-snapshot'
    `);
  });
});
