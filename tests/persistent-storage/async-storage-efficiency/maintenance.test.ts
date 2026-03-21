import { describe, expect, test } from 'vitest';
import type { AsyncStorageNamespaceScope } from '../../../src/persistentStorage/types';
import { createMockOpfsStorageAdapter } from '../../mocks/mockOpfsStorageAdapter';
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
    const mockAdapter = createMockOpfsStorageAdapter({
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
    const startupReadCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName: 'fresh-doc', sessionKey: 'sess1' },
    );
    createDocumentEnv({
      storeName: 'fresh-doc',
      sessionKey: 'sess1',
      storageAdapter: mockAdapter.adapter,
    });
    const startupOperations = startupReadCapture.finish();

    expect(startupOperations).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: []
        metadataBatchReads: []
        metadataReads: []
        payloadBatchReads: []
        scopedPayloadReads: []

      operations: []
    `);

    // Once the scheduled sweep runs, snapshot the complete maintenance history.
    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName: 'fresh-doc', sessionKey: 'sess1' },
    );
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish();

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
      breakdown:
        externalPayloadReads: ['tsdf.sess1._o_.p (protected registry payload)']
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/expired-doc/document'
          - 'sess1/expired-doc/document'
          - 'sess1/fresh-doc/document'
        metadataBatchReads:
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - ['tsdf.sess1.expired-doc (metadata)']
          - ['document metadata']
        metadataReads:
          - 'tsdf.sess1._o_.p (protected registry metadata)'
          - 'tsdf.sess1.expired-doc (metadata)'
          - 'document metadata'
        payloadBatchReads:
          - ['tsdf.sess1._o_.p (protected registry payload)']
        scopedPayloadReads: []

      operations:
        - '📖 ❌ <internal:record>'
        - '📖 ❌ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
        - '📖 ✅ <internal:record>'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/expired-doc/document keys=["__tsdf_meta__:document","__tsdf_payload__:document"]'
        - '📚 sess1/expired-doc/document hits=1/1 ["tsdf.sess1.expired-doc (metadata)"]'
        - '🗑️ sess1/expired-doc/document ["tsdf.sess1.expired-doc (payload)","tsdf.sess1.expired-doc (metadata)"]'
        - '🗂️ sess1/expired-doc/document keys=[]'
        - '📖 ✅ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
        - '🗂️ sess1/fresh-doc/document keys=["__tsdf_meta__:document","__tsdf_payload__:document"]'
        - '📚 sess1/fresh-doc/document hits=1/1 ["document metadata"]'
        - '📖 ✅ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
    `);
  });

  test('malformed persisted records are tolerated and handled predictably', async () => {
    const corruptedKey = documentStorageKey('corrupted', 'sess1');
    const triggerKey = documentStorageKey('trigger', 'sess1');
    const mockAdapter = createMockOpfsStorageAdapter({
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

    createDocumentEnv({
      storeName: 'trigger',
      sessionKey: 'sess1',
      storageAdapter: mockAdapter.adapter,
    });

    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName: 'trigger', sessionKey: 'sess1' },
    );
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish();

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
      breakdown:
        externalPayloadReads: ['tsdf.sess1._o_.p (protected registry payload)']
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/corrupted/document'
          - 'sess1/corrupted/document'
          - 'sess1/trigger/document'
        metadataBatchReads:
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - ['tsdf.sess1.corrupted (metadata)']
          - ['document metadata']
        metadataReads:
          - 'tsdf.sess1._o_.p (protected registry metadata)'
          - 'tsdf.sess1.corrupted (metadata)'
          - 'document metadata'
        payloadBatchReads:
          - ['tsdf.sess1._o_.p (protected registry payload)']
        scopedPayloadReads: []

      operations:
        - '📖 ❌ <internal:record>'
        - '📖 ❌ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
        - '📖 ✅ <internal:record>'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/corrupted/document keys=["__tsdf_meta__:document","__tsdf_payload__:document"]'
        - '📚 sess1/corrupted/document hits=1/1 ["tsdf.sess1.corrupted (metadata)"]'
        - '🗑️ sess1/corrupted/document ["tsdf.sess1.corrupted (payload)","tsdf.sess1.corrupted (metadata)"]'
        - '🗂️ sess1/corrupted/document keys=[]'
        - '📖 ✅ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
        - '🗂️ sess1/trigger/document keys=["__tsdf_meta__:document","__tsdf_payload__:document"]'
        - '📚 sess1/trigger/document hits=1/1 ["document metadata"]'
        - '📖 ✅ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
    `);
  });

  test('cleanup removes invalid or orphaned async-managed records while preserving valid entries', async () => {
    const validKey = documentStorageKey('valid-doc', 'sess1');
    const invalidMetadataKey = documentStorageKey('invalid-metadata', 'sess1');
    const missingPayloadKey = documentStorageKey('missing-payload', 'sess1');
    const mockAdapter = createMockOpfsStorageAdapter({
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

    createDocumentEnv({
      storeName: 'valid-doc',
      sessionKey: 'sess1',
      storageAdapter: mockAdapter.adapter,
    });

    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName: 'valid-doc', sessionKey: 'sess1' },
    );
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish();

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
      breakdown:
        externalPayloadReads: ['tsdf.sess1._o_.p (protected registry payload)']
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/valid-doc/document'
          - 'sess1/invalid-metadata/document'
          - 'sess1/invalid-metadata/document'
          - 'sess1/missing-payload/document'
          - 'sess1/missing-payload/document'
        metadataBatchReads:
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - ['document metadata']
          - ['tsdf.sess1.invalid-metadata (metadata)']
          - ['tsdf.sess1.missing-payload (metadata)']
        metadataReads:
          - 'tsdf.sess1._o_.p (protected registry metadata)'
          - 'document metadata'
          - 'tsdf.sess1.invalid-metadata (metadata)'
          - 'tsdf.sess1.missing-payload (metadata)'
        payloadBatchReads:
          - ['tsdf.sess1._o_.p (protected registry payload)']
        scopedPayloadReads: []

      operations:
        - '📖 ❌ <internal:record>'
        - '📖 ❌ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
        - '📖 ✅ <internal:record>'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/valid-doc/document keys=["__tsdf_meta__:document","__tsdf_payload__:document"]'
        - '📚 sess1/valid-doc/document hits=1/1 ["document metadata"]'
        - '🗂️ sess1/invalid-metadata/document keys=["__tsdf_meta__:document","__tsdf_payload__:document"]'
        - '📚 sess1/invalid-metadata/document hits=1/1 ["tsdf.sess1.invalid-metadata (metadata)"]'
        - '🗑️ sess1/invalid-metadata/document ["tsdf.sess1.invalid-metadata (payload)","tsdf.sess1.invalid-metadata (metadata)"]'
        - '🗂️ sess1/invalid-metadata/document keys=[]'
        - '📖 ✅ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
        - '🗂️ sess1/missing-payload/document keys=["__tsdf_meta__:document"]'
        - '📚 sess1/missing-payload/document hits=1/1 ["tsdf.sess1.missing-payload (metadata)"]'
        - '🗑️ sess1/missing-payload/document ["tsdf.sess1.missing-payload (payload)","tsdf.sess1.missing-payload (metadata)"]'
        - '🗂️ sess1/missing-payload/document keys=[]'
        - '📖 ✅ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
        - '📖 ✅ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
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
    const mockAdapter = createMockOpfsStorageAdapter({
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
    createDocumentEnv({
      storeName: 'trigger-doc',
      sessionKey: 'sess-trigger',
      storageAdapter: mockAdapter.adapter,
    });

    // Capture the full sweep so the snapshot shows stale-entry removal.
    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName: 'trigger-doc', sessionKey: 'sess-trigger' },
    );
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish();

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
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans:
          - 'user@example.com/protected-doc/document'
          - 'user@example.com/unprotected-doc/document'
        metadataBatchReads: []
        metadataReads: []
        payloadBatchReads: []
        scopedPayloadReads: []

      operations:
        - '📖 ❌ <internal:record>'
        - '📖 ❌ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
        - '📖 ✅ <internal:record>'
        - '🗂️ user@example.com/protected-doc/document keys=[]'
        - '🗂️ user@example.com/unprotected-doc/document keys=[]'
        - '📖 ✅ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
    `);
  });
});
