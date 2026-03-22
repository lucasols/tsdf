import { describe, expect, test } from 'vitest';
import type { AsyncStorageNamespaceScope } from '../../../src/persistentStorage/types';
import { createOpfsPersistentStorageTestStore } from '../../utils/opfsPersistentStorageTestStore';
import { startOpfsPersistentStorageOperationCapture } from '../../utils/persistentStorageOptimizationTestUtils';
import {
  createDocumentEnv,
  documentStorageKey,
  registerAsyncNamespace,
  setCachedDocumentData,
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
    const expiredKey = documentStorageKey('expired-doc', 'sess1');
    const freshKey = documentStorageKey('fresh-doc', 'sess1');
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName: 'fresh-doc',
      sessionKey: 'sess1',
    });

    // Seed one expired entry and one fresh entry so the cleanup pass has work to do.
    mockAdapter.setValue(expiredKey, {
      data: { d: { value: { name: 'old', value: 1 } } },
      timestamp: oneWeekAgo,
      version: 1,
    });
    setCachedDocumentData(mockAdapter, 'fresh-doc', 'sess1', {
      name: 'fresh',
      value: 2,
    });
    registerAsyncNamespace(mockAdapter, {
      sessionKey: 'sess1',
      storeName: 'expired-doc',
      kind: 'document',
    });
    registerAsyncNamespace(mockAdapter, {
      sessionKey: 'sess1',
      storeName: 'fresh-doc',
      kind: 'document',
    });

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
      maintenanceState: mockAdapter.rawNamespace.get(
        INTERNAL_ASYNC_SCOPE,
        'maintenance',
      ),
    }).toMatchInlineSnapshot(`
      expiredEntryExists: '❌'
      freshEntryExists: '✅'
      maintenanceState: { lastSuccessfulCleanupAt: 1735689602000, startupCleanupLease: null }
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time |
      2s   | 📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      .    | 📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      .    | 📁 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 ensure 🆕 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      .    | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      .    | 📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)
      .    | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)
      .    | 📂 open ✅ tsdf/sess1/expired-doc/document (scope directory)
      .    | 🗂️ tsdf/sess1/expired-doc/document (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      .    | 📂 open ✅ tsdf/sess1/expired-doc/document (scope directory)
      .    | 📄 open ✅ tsdf/sess1/expired-doc/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.expired-doc (metadata))
      .    | 📖 tsdf/sess1/expired-doc/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.expired-doc (metadata))
      .    | 📂 open ✅ tsdf/sess1/expired-doc/document (scope directory)
      .    | 🗑️ ✅ tsdf/sess1/expired-doc/document/__tsdf_payload__%3Adocument.json (tsdf.sess1.expired-doc (payload))
      .    | 🗑️ ✅ tsdf/sess1/expired-doc/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.expired-doc (metadata))
      .    | 📂 open ✅ tsdf/sess1/expired-doc/document (scope directory)
      .    | 🗂️ tsdf/sess1/expired-doc/document (scope directory) entries=[]
      .    | 📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)
      .    | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)
      .    | 📁 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)
      .    | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)
      .    | 📂 open ✅ tsdf/sess1/fresh-doc/document (scope directory)
      .    | 🗂️ tsdf/sess1/fresh-doc/document (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      .    | 📂 open ✅ tsdf/sess1/fresh-doc/document (scope directory)
      .    | 📄 open ✅ tsdf/sess1/fresh-doc/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.fresh-doc (metadata))
      .    | 📖 tsdf/sess1/fresh-doc/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.fresh-doc (metadata))
      .    | 📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      .    | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      .    | 📁 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      .    | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      "
    `);
  });

  test('malformed persisted records are tolerated and handled predictably', async () => {
    const corruptedKey = documentStorageKey('corrupted', 'sess1');
    const triggerKey = documentStorageKey('trigger', 'sess1');
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName: 'trigger',
      sessionKey: 'sess1',
    });

    // Seed malformed metadata plus a valid trigger entry so cleanup can see the namespace.
    mockAdapter.setPayload(corruptedKey, {
      d: { value: { name: 'bad', value: 1 } },
    });
    mockAdapter.setMetadata(corruptedKey, '{invalid');
    setCachedDocumentData(mockAdapter, 'trigger', 'sess1', {
      name: 'ok',
      value: 1,
    });
    registerAsyncNamespace(mockAdapter, {
      sessionKey: 'sess1',
      storeName: 'corrupted',
      kind: 'document',
    });
    registerAsyncNamespace(mockAdapter, {
      sessionKey: 'sess1',
      storeName: 'trigger',
      kind: 'document',
    });

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
      time |
      2s   | 📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      .    | 📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      .    | 📁 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 ensure 🆕 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      .    | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      .    | 📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)
      .    | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)
      .    | 📂 open ✅ tsdf/sess1/corrupted/document (scope directory)
      .    | 🗂️ tsdf/sess1/corrupted/document (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      .    | 📂 open ✅ tsdf/sess1/corrupted/document (scope directory)
      .    | 📄 open ✅ tsdf/sess1/corrupted/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.corrupted (metadata))
      .    | 📖 tsdf/sess1/corrupted/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.corrupted (metadata))
      .    | 📂 open ✅ tsdf/sess1/corrupted/document (scope directory)
      .    | 🗑️ ✅ tsdf/sess1/corrupted/document/__tsdf_payload__%3Adocument.json (tsdf.sess1.corrupted (payload))
      .    | 🗑️ ✅ tsdf/sess1/corrupted/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.corrupted (metadata))
      .    | 📂 open ✅ tsdf/sess1/corrupted/document (scope directory)
      .    | 🗂️ tsdf/sess1/corrupted/document (scope directory) entries=[]
      .    | 📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)
      .    | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)
      .    | 📁 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)
      .    | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)
      .    | 📂 open ✅ tsdf/sess1/trigger/document (scope directory)
      .    | 🗂️ tsdf/sess1/trigger/document (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      .    | 📂 open ✅ tsdf/sess1/trigger/document (scope directory)
      .    | 📄 open ✅ tsdf/sess1/trigger/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.trigger (metadata))
      .    | 📖 tsdf/sess1/trigger/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.trigger (metadata))
      .    | 📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      .    | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      .    | 📁 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      .    | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      "
    `);
  });

  test('cleanup removes invalid or orphaned async-managed records while preserving valid entries', async () => {
    const validKey = documentStorageKey('valid-doc', 'sess1');
    const invalidMetadataKey = documentStorageKey('invalid-metadata', 'sess1');
    const missingPayloadKey = documentStorageKey('missing-payload', 'sess1');
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName: 'valid-doc',
      sessionKey: 'sess1',
    });

    setCachedDocumentData(mockAdapter, 'valid-doc', 'sess1', {
      name: 'valid',
      value: 1,
    });
    mockAdapter.setPayload(invalidMetadataKey, {
      d: { value: { name: 'invalid', value: 2 } },
    });
    mockAdapter.setMetadata(invalidMetadataKey, { bad: true });
    mockAdapter.setMetadata(missingPayloadKey, {
      key: 'document',
      writtenAt: Date.now() - 15 * 24 * 60 * 60 * 1000,
      lastAccessAt: Date.now() - 15 * 24 * 60 * 60 * 1000,
      version: 1,
      customMetadata: {},
    });
    registerAsyncNamespace(mockAdapter, {
      sessionKey: 'sess1',
      storeName: 'valid-doc',
      kind: 'document',
    });
    registerAsyncNamespace(mockAdapter, {
      sessionKey: 'sess1',
      storeName: 'invalid-metadata',
      kind: 'document',
    });
    registerAsyncNamespace(mockAdapter, {
      sessionKey: 'sess1',
      storeName: 'missing-payload',
      kind: 'document',
    });

    createDocumentEnv({ storeName: 'valid-doc', sessionKey: 'sess1' });

    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      invalidMetadataExists: mockAdapter.has(invalidMetadataKey),
      missingPayloadExists: mockAdapter.has(missingPayloadKey),
      validEntryExists: mockAdapter.has(validKey),
      maintenanceState: mockAdapter.rawNamespace.get(
        INTERNAL_ASYNC_SCOPE,
        'maintenance',
      ),
    }).toMatchInlineSnapshot(`
      invalidMetadataExists: '❌'
      maintenanceState: { lastSuccessfulCleanupAt: 1735689602000, startupCleanupLease: null }
      missingPayloadExists: '❌'
      validEntryExists: '✅'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time |
      2s   | 📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      .    | 📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      .    | 📁 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 ensure 🆕 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      .    | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      .    | 📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)
      .    | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)
      .    | 📂 open ✅ tsdf/sess1/valid-doc/document (scope directory)
      .    | 🗂️ tsdf/sess1/valid-doc/document (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      .    | 📂 open ✅ tsdf/sess1/valid-doc/document (scope directory)
      .    | 📄 open ✅ tsdf/sess1/valid-doc/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.valid-doc (metadata))
      .    | 📖 tsdf/sess1/valid-doc/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.valid-doc (metadata))
      .    | 📂 open ✅ tsdf/sess1/invalid-metadata/document (scope directory)
      .    | 🗂️ tsdf/sess1/invalid-metadata/document (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      .    | 📂 open ✅ tsdf/sess1/invalid-metadata/document (scope directory)
      .    | 📄 open ✅ tsdf/sess1/invalid-metadata/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.invalid-metadata (metadata))
      .    | 📖 tsdf/sess1/invalid-metadata/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.invalid-metadata (metadata))
      .    | 📂 open ✅ tsdf/sess1/invalid-metadata/document (scope directory)
      .    | 🗑️ ✅ tsdf/sess1/invalid-metadata/document/__tsdf_payload__%3Adocument.json (tsdf.sess1.invalid-metadata (payload))
      .    | 🗑️ ✅ tsdf/sess1/invalid-metadata/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.invalid-metadata (metadata))
      .    | 📂 open ✅ tsdf/sess1/invalid-metadata/document (scope directory)
      .    | 🗂️ tsdf/sess1/invalid-metadata/document (scope directory) entries=[]
      .    | 📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)
      .    | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)
      .    | 📁 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)
      .    | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)
      .    | 📂 open ✅ tsdf/sess1/missing-payload/document (scope directory)
      .    | 🗂️ tsdf/sess1/missing-payload/document (scope directory) entries=["file:__tsdf_meta__%3Adocument.json"]
      .    | 📂 open ✅ tsdf/sess1/missing-payload/document (scope directory)
      .    | 📄 open ✅ tsdf/sess1/missing-payload/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.missing-payload (metadata))
      .    | 📖 tsdf/sess1/missing-payload/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.missing-payload (metadata))
      .    | 📂 open ✅ tsdf/sess1/missing-payload/document (scope directory)
      .    | 🗑️ ✅ tsdf/sess1/missing-payload/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.missing-payload (metadata))
      .    | 📂 open ✅ tsdf/sess1/missing-payload/document (scope directory)
      .    | 🗂️ tsdf/sess1/missing-payload/document (scope directory) entries=[]
      .    | 📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)
      .    | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)
      .    | 📁 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)
      .    | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)
      .    | 📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      .    | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      .    | 📁 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      .    | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      "
    `);
  });

  test('protected dotted-session cleanup keeps the protected entry and snapshots the full metadata scan history', async () => {
    const staleDurationMs = 15 * 24 * 60 * 60 * 1000;
    const dottedSessionKey = 'user@example.com';
    const protectedDocStorageKey = documentStorageKey(
      'protected-doc',
      dottedSessionKey,
    );
    const unprotectedDocStorageKey = documentStorageKey(
      'unprotected-doc',
      dottedSessionKey,
    );
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName: 'trigger-doc',
      sessionKey: 'sess-trigger',
    });

    // Seed two cached dotted-session entries and move far enough forward that both are stale.
    mockAdapter.setValue(protectedDocStorageKey, {
      data: { d: { value: { name: 'protected', value: 1 } } },
      timestamp: Date.now() - staleDurationMs,
      version: 1,
    });
    mockAdapter.setValue(unprotectedDocStorageKey, {
      data: { d: { value: { name: 'unprotected', value: 2 } } },
      timestamp: Date.now() - staleDurationMs,
      version: 1,
    });
    registerAsyncNamespace(mockAdapter, {
      sessionKey: dottedSessionKey,
      storeName: 'protected-doc',
      kind: 'document',
    });
    registerAsyncNamespace(mockAdapter, {
      sessionKey: dottedSessionKey,
      storeName: 'unprotected-doc',
      kind: 'document',
    });

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
      time |
      2s   | 📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      .    | 📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      .    | 📁 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 ensure 🆕 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      .    | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      .    | 📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)
      .    | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)
      .    | 📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      .    | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      .    | 📁 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .    | 📄 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      .    | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)
      "
    `);
  });
});
