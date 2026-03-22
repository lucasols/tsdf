import { describe, expect, test } from 'vitest';
import type { AsyncStorageNamespaceScope } from '../../../src/persistentStorage/types';
import { createOpfsPersistentStorageTestStore } from '../../utils/opfsPersistentStorageTestStore';
import {
  getParsedOpfsEntryFiles,
  getParsedOpfsNamespaceValue,
  startOpfsPersistentStorageOperationCapture,
} from '../../utils/persistentStorageOptimizationTestUtils';
import {
  createDocumentEnv,
  setProtectedKeysSnapshot,
  setupAsyncStorageEfficiencyTestSuite,
  waitForScheduledCleanup,
} from './shared';

setupAsyncStorageEfficiencyTestSuite();

const INTERNAL_ASYNC_SCOPE: AsyncStorageNamespaceScope = {
  sessionKey: '__tsdf_async__',
  storeName: '__tsdf_async__',
  kind: '__internal.protected',
};

describe('async storage efficiency: maintenance', () => {
  test('startup cleanup removes expired entries and snapshots the full metadata scan history', async () => {
    const oneWeekAgo = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const expiredDoc = mockAdapter.scope('expired-doc', 'sess1');
    const freshDoc = mockAdapter.scope('fresh-doc', 'sess1');
    const expiredKey = expiredDoc.document.storageKey();
    const freshKey = freshDoc.document.storageKey();

    // Seed one expired entry and one fresh entry so the cleanup pass has work to do.
    expiredDoc.document.seed(
      { value: { name: 'old', value: 1 } },
      { timestamp: oneWeekAgo },
    );
    freshDoc.document.seed({ value: { name: 'fresh', value: 2 } });
    expiredDoc.document.registerNamespace();
    freshDoc.document.registerNamespace();

    // Startup should only schedule the sweep; it should not perform storage I/O yet.
    const startupReadCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    createDocumentEnv({ storeName: 'fresh-doc', sessionKey: 'sess1' });
    const startupOperations = startupReadCapture.finish().timelineString;

    expect(startupOperations).toMatchInlineSnapshot(`"empty"`);

    // Once the scheduled sweep runs, snapshot the complete maintenance history.
    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      expiredEntryExists: mockAdapter.has(expiredKey),
      freshEntryExists: mockAdapter.has(freshKey),
    }).toMatchInlineSnapshot(`
      expiredEntryExists: '❌'
      freshEntryExists: '✅'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      simplified
      time   |
      2.01s  | 🗂️ tsdf/sess1/expired-doc/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      2.012s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.00 kb -> 0.23 kb
      .      | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.29 kb
      2.013s | 🗑️ ✅ tsdf/sess1/expired-doc/document/__tsdf_payload__%3Adocument.json
             |    └ (tsdf.sess1.expired-doc (payload))
      .      | 🗑️ ✅ tsdf/sess1/expired-doc/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.expired-doc (metadata))
      .      | 🗂️ tsdf/sess1/expired-doc/document (scope directory) entries=[]
      2.015s | 📖 tsdf/sess1/expired-doc/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.expired-doc (metadata)) | 0.23 kb
      2.016s | 🗂️ tsdf/sess1/fresh-doc/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      2.018s | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.29 kb
      2.02s  | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.29 kb -> 0.16 kb
      2.021s | 📖 tsdf/sess1/fresh-doc/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.fresh-doc (metadata)) | 0.23 kb
      2.022s | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.23 kb
      2.024s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.23 kb -> 0.13 kb

      verbose
      time   |
      2.002s | 📁 dir-open-or-create ✅ tsdf (root directory)
      2.003s | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      2.004s | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      2.005s | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__ (session directory)
      2.006s | 📄 file-open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      2.007s | 📄 file-open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.008s | 📄 file-open-or-create 🆕 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.009s | 📄 file-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📂 dir-open ✅ tsdf/sess1/expired-doc (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.01s  | 📂 dir-open ✅ tsdf/sess1/expired-doc/document (scope directory)
      .      | 🗂️ tsdf/sess1/expired-doc/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/expired-doc (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.011s | 📂 dir-open ✅ tsdf/sess1/expired-doc/document (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/expired-doc (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.012s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.00 kb -> 0.23 kb
      .      | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.29 kb
      .      | 📄 file-open ✅ tsdf/sess1/expired-doc/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.expired-doc (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/expired-doc/document (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/expired-doc (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      2.013s | 🗑️ ✅ tsdf/sess1/expired-doc/document/__tsdf_payload__%3Adocument.json
             |    └ (tsdf.sess1.expired-doc (payload))
      .      | 🗑️ ✅ tsdf/sess1/expired-doc/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.expired-doc (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/expired-doc/document (scope directory)
      .      | 🗂️ tsdf/sess1/expired-doc/document (scope directory) entries=[]
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__ (session directory)
      2.014s | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.015s | 📖 tsdf/sess1/expired-doc/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.expired-doc (metadata)) | 0.23 kb
      .      | 📄 file-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/fresh-doc (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.016s | 📄 file-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📂 dir-open ✅ tsdf/sess1/fresh-doc/document (scope directory)
      .      | 🗂️ tsdf/sess1/fresh-doc/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/fresh-doc (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      2.017s | 📂 dir-open ✅ tsdf/sess1/fresh-doc/document (scope directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__ (session directory)
      2.018s | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.29 kb
      .      | 📄 file-open ✅ tsdf/sess1/fresh-doc/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.fresh-doc (metadata))
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      2.019s | 📄 file-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      2.02s  | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.29 kb -> 0.16 kb
      .      | 📄 file-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance)
      2.021s | 📖 tsdf/sess1/fresh-doc/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.fresh-doc (metadata)) | 0.23 kb
      2.022s | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.23 kb
      2.024s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.23 kb -> 0.13 kb
      "
    `);
    expect(
      getParsedOpfsNamespaceValue(
        mockAdapter,
        INTERNAL_ASYNC_SCOPE,
        'maintenance',
      ),
    ).toMatchInlineSnapshot(`
      lastSuccessfulCleanupAt: 1735689602000
      startupCleanupLease: null
    `);
  });

  test('malformed persisted records are tolerated and handled predictably', async () => {
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const corruptedDoc = mockAdapter.scope('corrupted', 'sess1');
    const triggerDoc = mockAdapter.scope('trigger', 'sess1');
    const corruptedKey = corruptedDoc.document.storageKey();
    const triggerKey = triggerDoc.document.storageKey();

    // Seed malformed metadata plus a valid trigger entry so cleanup can see the namespace.
    corruptedDoc.document.setPayload({
      d: { value: { name: 'bad', value: 1 } },
    });
    corruptedDoc.document.setMetadata('{invalid');
    triggerDoc.document.seed({ value: { name: 'ok', value: 1 } });
    corruptedDoc.document.registerNamespace();
    triggerDoc.document.registerNamespace();

    createDocumentEnv({ storeName: 'trigger', sessionKey: 'sess1' });

    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      corruptedExists: mockAdapter.has(corruptedKey),
      corruptedPayload:
        mockAdapter.getRaw(corruptedKey) ??
        mockAdapter.readMetadata(corruptedKey),
      triggerExists: mockAdapter.has(triggerKey),
    }).toMatchInlineSnapshot(`
      corruptedExists: '❌'
      corruptedPayload: null
      triggerExists: '✅'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      simplified
      time   |
      2.01s  | 🗂️ tsdf/sess1/corrupted/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      2.012s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.00 kb -> 0.23 kb
      .      | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.28 kb
      2.013s | 🗑️ ✅ tsdf/sess1/corrupted/document/__tsdf_payload__%3Adocument.json
             |    └ (tsdf.sess1.corrupted (payload))
      .      | 🗑️ ✅ tsdf/sess1/corrupted/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.corrupted (metadata))
      .      | 🗂️ tsdf/sess1/corrupted/document (scope directory) entries=[]
      2.015s | 📖 tsdf/sess1/corrupted/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.corrupted (metadata)) | 0.02 kb
      2.016s | 🗂️ tsdf/sess1/trigger/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      2.018s | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.28 kb
      2.02s  | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.28 kb -> 0.15 kb
      2.021s | 📖 tsdf/sess1/trigger/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.trigger (metadata)) | 0.23 kb
      2.022s | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.23 kb
      2.024s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.23 kb -> 0.13 kb

      verbose
      time   |
      2.002s | 📁 dir-open-or-create ✅ tsdf (root directory)
      2.003s | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      2.004s | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      2.005s | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__ (session directory)
      2.006s | 📄 file-open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      2.007s | 📄 file-open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.008s | 📄 file-open-or-create 🆕 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.009s | 📄 file-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📂 dir-open ✅ tsdf/sess1/corrupted (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.01s  | 📂 dir-open ✅ tsdf/sess1/corrupted/document (scope directory)
      .      | 🗂️ tsdf/sess1/corrupted/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/corrupted (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.011s | 📂 dir-open ✅ tsdf/sess1/corrupted/document (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/corrupted (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.012s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.00 kb -> 0.23 kb
      .      | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.28 kb
      .      | 📄 file-open ✅ tsdf/sess1/corrupted/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.corrupted (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/corrupted/document (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/corrupted (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      2.013s | 🗑️ ✅ tsdf/sess1/corrupted/document/__tsdf_payload__%3Adocument.json
             |    └ (tsdf.sess1.corrupted (payload))
      .      | 🗑️ ✅ tsdf/sess1/corrupted/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.corrupted (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/corrupted/document (scope directory)
      .      | 🗂️ tsdf/sess1/corrupted/document (scope directory) entries=[]
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__ (session directory)
      2.014s | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.015s | 📖 tsdf/sess1/corrupted/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.corrupted (metadata)) | 0.02 kb
      .      | 📄 file-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/trigger (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.016s | 📄 file-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📂 dir-open ✅ tsdf/sess1/trigger/document (scope directory)
      .      | 🗂️ tsdf/sess1/trigger/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/trigger (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      2.017s | 📂 dir-open ✅ tsdf/sess1/trigger/document (scope directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__ (session directory)
      2.018s | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.28 kb
      .      | 📄 file-open ✅ tsdf/sess1/trigger/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.trigger (metadata))
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      2.019s | 📄 file-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      2.02s  | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.28 kb -> 0.15 kb
      .      | 📄 file-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance)
      2.021s | 📖 tsdf/sess1/trigger/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.trigger (metadata)) | 0.23 kb
      2.022s | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.23 kb
      2.024s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.23 kb -> 0.13 kb
      "
    `);
  });

  test('cleanup removes invalid or orphaned async-managed records while preserving valid entries', async () => {
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const validDoc = mockAdapter.scope('valid-doc', 'sess1');
    const invalidMetadataDoc = mockAdapter.scope('invalid-metadata', 'sess1');
    const missingPayloadDoc = mockAdapter.scope('missing-payload', 'sess1');
    const validKey = validDoc.document.storageKey();
    const invalidMetadataKey = invalidMetadataDoc.document.storageKey();
    const missingPayloadKey = missingPayloadDoc.document.storageKey();

    validDoc.document.seed({ value: { name: 'valid', value: 1 } });
    invalidMetadataDoc.document.setPayload({
      d: { value: { name: 'invalid', value: 2 } },
    });
    invalidMetadataDoc.document.setMetadata({ bad: true });
    missingPayloadDoc.document.setMetadata({
      key: 'document',
      writtenAt: Date.now() - 15 * 24 * 60 * 60 * 1000,
      lastAccessAt: Date.now() - 15 * 24 * 60 * 60 * 1000,
      version: 1,
      customMetadata: {},
    });
    validDoc.document.registerNamespace();
    invalidMetadataDoc.document.registerNamespace();
    missingPayloadDoc.document.registerNamespace();

    createDocumentEnv({ storeName: 'valid-doc', sessionKey: 'sess1' });

    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      invalidMetadataExists: mockAdapter.has(invalidMetadataKey),
      missingPayloadExists: mockAdapter.has(missingPayloadKey),
      validEntryExists: mockAdapter.has(validKey),
    }).toMatchInlineSnapshot(`
      invalidMetadataExists: '❌'
      missingPayloadExists: '❌'
      validEntryExists: '✅'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      simplified
      time   |
      2.01s  | 🗂️ tsdf/sess1/valid-doc/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      2.012s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.00 kb -> 0.23 kb
      .      | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.44 kb
      .      | 🗂️ tsdf/sess1/invalid-metadata/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      2.015s | 📖 tsdf/sess1/valid-doc/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.valid-doc (metadata)) | 0.23 kb
      .      | 🗑️ ✅ tsdf/sess1/invalid-metadata/document/__tsdf_payload__%3Adocument.json
             |    └ (tsdf.sess1.invalid-metadata (payload))
      .      | 🗑️ ✅ tsdf/sess1/invalid-metadata/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.invalid-metadata (metadata))
      .      | 🗂️ tsdf/sess1/invalid-metadata/document (scope directory) entries=[]
      2.017s | 📖 tsdf/sess1/invalid-metadata/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.invalid-metadata (metadata)) | 0.02 kb
      2.018s | 🗂️ tsdf/sess1/missing-payload/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json"]
      2.02s  | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.44 kb
      2.021s | 🗑️ ✅ tsdf/sess1/missing-payload/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.missing-payload (metadata))
      .      | 🗂️ tsdf/sess1/missing-payload/document (scope directory) entries=[]
      2.022s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.44 kb -> 0.30 kb
      2.023s | 📖 tsdf/sess1/missing-payload/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.missing-payload (metadata)) | 0.21 kb
      2.026s | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.30 kb
      2.028s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.30 kb -> 0.16 kb
      .      | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.23 kb
      2.03s  | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.23 kb -> 0.13 kb

      verbose
      time   |
      2.002s | 📁 dir-open-or-create ✅ tsdf (root directory)
      2.003s | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      2.004s | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      2.005s | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__ (session directory)
      2.006s | 📄 file-open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      2.007s | 📄 file-open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.008s | 📄 file-open-or-create 🆕 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.009s | 📄 file-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📂 dir-open ✅ tsdf/sess1/valid-doc (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.01s  | 📂 dir-open ✅ tsdf/sess1/valid-doc/document (scope directory)
      .      | 🗂️ tsdf/sess1/valid-doc/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/valid-doc (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.011s | 📂 dir-open ✅ tsdf/sess1/valid-doc/document (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/invalid-metadata (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.012s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.00 kb -> 0.23 kb
      .      | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.44 kb
      .      | 📄 file-open ✅ tsdf/sess1/valid-doc/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.valid-doc (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/invalid-metadata/document (scope directory)
      .      | 🗂️ tsdf/sess1/invalid-metadata/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/invalid-metadata (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.013s | 📂 dir-open ✅ tsdf/sess1/invalid-metadata/document (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/invalid-metadata (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.014s | 📄 file-open ✅ tsdf/sess1/invalid-metadata/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.invalid-metadata (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/invalid-metadata/document (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/invalid-metadata (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      2.015s | 📖 tsdf/sess1/valid-doc/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.valid-doc (metadata)) | 0.23 kb
      .      | 🗑️ ✅ tsdf/sess1/invalid-metadata/document/__tsdf_payload__%3Adocument.json
             |    └ (tsdf.sess1.invalid-metadata (payload))
      .      | 🗑️ ✅ tsdf/sess1/invalid-metadata/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.invalid-metadata (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/invalid-metadata/document (scope directory)
      .      | 🗂️ tsdf/sess1/invalid-metadata/document (scope directory) entries=[]
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__ (session directory)
      2.016s | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.017s | 📖 tsdf/sess1/invalid-metadata/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.invalid-metadata (metadata)) | 0.02 kb
      .      | 📄 file-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/missing-payload (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.018s | 📄 file-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📂 dir-open ✅ tsdf/sess1/missing-payload/document (scope directory)
      .      | 🗂️ tsdf/sess1/missing-payload/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/missing-payload (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.019s | 📂 dir-open ✅ tsdf/sess1/missing-payload/document (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/missing-payload (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.02s  | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.44 kb
      .      | 📄 file-open ✅ tsdf/sess1/missing-payload/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.missing-payload (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/missing-payload/document (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/missing-payload (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      2.021s | 🧹 ❌ tsdf/sess1/missing-payload/document/__tsdf_payload__%3Adocument.json (scope directory)
      .      | 🗑️ ✅ tsdf/sess1/missing-payload/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.missing-payload (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/missing-payload/document (scope directory)
      .      | 🗂️ tsdf/sess1/missing-payload/document (scope directory) entries=[]
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__ (session directory)
      2.022s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.44 kb -> 0.30 kb
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      2.023s | 📖 tsdf/sess1/missing-payload/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.missing-payload (metadata)) | 0.21 kb
      .      | 📄 file-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__ (session directory)
      2.024s | 📄 file-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      2.025s | 📄 file-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      2.026s | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.30 kb
      .      | 📄 file-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance)
      2.028s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.30 kb -> 0.16 kb
      .      | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.23 kb
      2.03s  | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.23 kb -> 0.13 kb
      "
    `);
    expect({
      globalMaintenance: getParsedOpfsNamespaceValue(
        mockAdapter,
        INTERNAL_ASYNC_SCOPE,
        'maintenance',
      ),
    }).toMatchInlineSnapshot(
      `globalMaintenance: { lastSuccessfulCleanupAt: 1735689602000, startupCleanupLease: null }`,
    );
  });

  test('protected dotted-session cleanup keeps the protected entry and snapshots the full metadata scan history', async () => {
    const staleDurationMs = 15 * 24 * 60 * 60 * 1000;
    const dottedSessionKey = 'user@example.com';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const protectedDoc = mockAdapter.scope('protected-doc', dottedSessionKey);
    const unprotectedDoc = mockAdapter.scope(
      'unprotected-doc',
      dottedSessionKey,
    );
    const protectedDocStorageKey = protectedDoc.document.storageKey();
    const unprotectedDocStorageKey = unprotectedDoc.document.storageKey();

    // Seed two cached dotted-session entries and move far enough forward that both are stale.
    protectedDoc.document.seed(
      { value: { name: 'protected', value: 1 } },
      { timestamp: Date.now() - staleDurationMs },
    );
    unprotectedDoc.document.seed(
      { value: { name: 'unprotected', value: 2 } },
      { timestamp: Date.now() - staleDurationMs },
    );
    protectedDoc.document.registerNamespace();
    unprotectedDoc.document.registerNamespace();

    // Mark one dotted-session entry as protected before the real cleanup pass.
    setProtectedKeysSnapshot(dottedSessionKey, [protectedDocStorageKey]);

    // A fresh entry in another session triggers the scheduled global cleanup pass.
    createDocumentEnv({ storeName: 'trigger-doc', sessionKey: 'sess-trigger' });

    // Capture the full sweep so the snapshot shows stale-entry removal.
    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      protectedEntryExists: mockAdapter.has(protectedDocStorageKey),
      unprotectedEntryExists: mockAdapter.has(unprotectedDocStorageKey),
      maintenanceState: mockAdapter.rawNamespace.get(
        INTERNAL_ASYNC_SCOPE,
        'maintenance',
      ),
    }).toMatchInlineSnapshot(`
      maintenanceState: { lastSuccessfulCleanupAt: 1735689602000, startupCleanupLease: null }
      protectedEntryExists: '✅'
      unprotectedEntryExists: '✅'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      simplified
      time   |
      2.012s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.00 kb -> 0.23 kb
      .      | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.35 kb
      2.015s | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.23 kb
      2.017s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.23 kb -> 0.13 kb

      verbose
      time   |
      2.002s | 📁 dir-open-or-create ✅ tsdf (root directory)
      2.003s | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      2.004s | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      2.005s | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__ (session directory)
      2.006s | 📄 file-open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      2.007s | 📄 file-open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📂 dir-open ❌ tsdf/user%40example.com (session directory)
      2.008s | 📄 file-open-or-create 🆕 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📂 dir-open ❌ tsdf/user%40example.com (session directory)
      2.009s | 📄 file-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      2.01s  | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__ (session directory)
      2.011s | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      2.012s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.00 kb -> 0.23 kb
      .      | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.35 kb
      .      | 📄 file-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      2.013s | 📄 file-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance)
      2.015s | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.23 kb
      2.017s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.23 kb -> 0.13 kb
      "
    `);
    expect(getParsedOpfsEntryFiles(mockAdapter, protectedDocStorageKey))
      .toMatchInlineSnapshot(`
        metadata:
          customMetadata: {}
          key: 'document'
          lastAccessAt: 1734393600000
          sizeBytes: 46
          version: 1
          writtenAt: 1734393600000

        payload:
          d:
            value: { name: 'protected', value: 1 }
      `);
  });
});
