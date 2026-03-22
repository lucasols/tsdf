import { describe, expect, test, vi } from 'vitest';
import { ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY } from '../../../src/persistentStorage/asyncStorageAdapter';
import { createOpfsPersistentStorageTestStore } from '../../utils/opfsPersistentStorageTestStore';
import {
  getParsedLocalStorageValue,
  getParsedOpfsEntryFiles,
  startPersistentStorageOperationCapture,
  startOpfsPersistentStorageOperationCapture,
} from '../../utils/persistentStorageOptimizationTestUtils';
import {
  createDocumentEnv,
  setProtectedKeysSnapshot,
  setupAsyncStorageEfficiencyTestSuite,
  waitForScheduledCleanup,
} from './shared';

setupAsyncStorageEfficiencyTestSuite();

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
    // Startup should only schedule the sweep; it should not perform storage I/O yet.
    const startupReadCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    createDocumentEnv({ storeName: 'fresh-doc', sessionKey: 'sess1' });
    const startupOperations = startupReadCapture.finish().timelineString;

    expect(startupOperations).toMatchInlineSnapshot(`"empty"`);

    // Once the scheduled sweep runs, snapshot the complete maintenance history.
    const localStorageCapture = startPersistentStorageOperationCapture();
    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;
    const localStorageOperations = localStorageCapture.finish().timelineString;

    expect({
      expiredEntryExists: mockAdapter.has(expiredKey),
      freshEntryExists: mockAdapter.has(freshKey),
    }).toMatchInlineSnapshot(`
      expiredEntryExists: '❌'
      freshEntryExists: '✅'
    `);
    expect(localStorageOperations).toMatchInlineSnapshot(`
      "
      time |
      2s   | 📖 ❌ #1 tsdf._am.g (async global maintenance)
      .    | 📖 ❌ #1 tsdf._am.g (async global maintenance)
      .    | ✍️ ❌->✅ #1 tsdf._am.g (async global maintenance) | ❌ -> 0.04 kb
      "
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      simplified
      time   |
      2.002s | 🗂️ tsdf (root directory) entries=["dir:sess1"]
      .      | 🗂️ tsdf/sess1 (session directory) entries=["dir:expired-doc","dir:fresh-doc"]
      .      | 🗂️ tsdf/sess1/expired-doc (store directory) entries=["dir:document"]
      .      | 🗂️ tsdf/sess1/fresh-doc (store directory) entries=["dir:document"]
      2.006s | 🗂️ tsdf/sess1/expired-doc/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      2.009s | 🗑️ ✅ tsdf/sess1/expired-doc/document/__tsdf_payload__%3Adocument.json
             |    └ (tsdf.sess1.expired-doc (payload))
      .      | 🗑️ ✅ tsdf/sess1/expired-doc/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.expired-doc (metadata))
      .      | 🗂️ tsdf/sess1/fresh-doc/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      2.011s | 📖 tsdf/sess1/expired-doc/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.expired-doc (metadata)) | 0.23 kb
      2.014s | 📖 tsdf/sess1/fresh-doc/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.fresh-doc (metadata)) | 0.23 kb

      verbose
      time   |
      2.002s | 📁 dir-open-or-create ✅ tsdf (root directory)
      .      | 🗂️ tsdf (root directory) entries=["dir:sess1"]
      .      | 🗂️ tsdf/sess1 (session directory) entries=["dir:expired-doc","dir:fresh-doc"]
      .      | 🗂️ tsdf/sess1/expired-doc (store directory) entries=["dir:document"]
      .      | 🗂️ tsdf/sess1/fresh-doc (store directory) entries=["dir:document"]
      2.003s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.004s | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.005s | 📂 dir-open ✅ tsdf/sess1/expired-doc (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.006s | 📂 dir-open ✅ tsdf/sess1/expired-doc/document (scope directory)
      .      | 🗂️ tsdf/sess1/expired-doc/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/expired-doc (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.007s | 📂 dir-open ✅ tsdf/sess1/expired-doc/document (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/expired-doc (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.008s | 📄 file-open ✅ tsdf/sess1/expired-doc/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.expired-doc (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/expired-doc/document (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/fresh-doc (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.009s | 🗑️ ✅ tsdf/sess1/expired-doc/document/__tsdf_payload__%3Adocument.json
             |    └ (tsdf.sess1.expired-doc (payload))
      .      | 🗑️ ✅ tsdf/sess1/expired-doc/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.expired-doc (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/fresh-doc/document (scope directory)
      .      | 🗂️ tsdf/sess1/fresh-doc/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/fresh-doc (store directory)
      2.01s  | 📂 dir-open ✅ tsdf/sess1/fresh-doc/document (scope directory)
      2.011s | 📖 tsdf/sess1/expired-doc/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.expired-doc (metadata)) | 0.23 kb
      .      | 📄 file-open ✅ tsdf/sess1/fresh-doc/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.fresh-doc (metadata))
      2.014s | 📖 tsdf/sess1/fresh-doc/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.fresh-doc (metadata)) | 0.23 kb
      "
    `);
    expect(
      getParsedLocalStorageValue(ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY),
    ).toMatchInlineSnapshot(`lca: 1735689602000`);
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
      2.002s | 🗂️ tsdf (root directory) entries=["dir:sess1"]
      .      | 🗂️ tsdf/sess1 (session directory) entries=["dir:corrupted","dir:trigger"]
      .      | 🗂️ tsdf/sess1/corrupted (store directory) entries=["dir:document"]
      .      | 🗂️ tsdf/sess1/trigger (store directory) entries=["dir:document"]
      2.006s | 🗂️ tsdf/sess1/corrupted/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      2.009s | 🗑️ ✅ tsdf/sess1/corrupted/document/__tsdf_payload__%3Adocument.json
             |    └ (tsdf.sess1.corrupted (payload))
      .      | 🗑️ ✅ tsdf/sess1/corrupted/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.corrupted (metadata))
      .      | 🗂️ tsdf/sess1/trigger/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      2.011s | 📖 tsdf/sess1/corrupted/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.corrupted (metadata)) | 0.02 kb
      2.014s | 📖 tsdf/sess1/trigger/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.trigger (metadata)) | 0.23 kb

      verbose
      time   |
      2.002s | 📁 dir-open-or-create ✅ tsdf (root directory)
      .      | 🗂️ tsdf (root directory) entries=["dir:sess1"]
      .      | 🗂️ tsdf/sess1 (session directory) entries=["dir:corrupted","dir:trigger"]
      .      | 🗂️ tsdf/sess1/corrupted (store directory) entries=["dir:document"]
      .      | 🗂️ tsdf/sess1/trigger (store directory) entries=["dir:document"]
      2.003s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.004s | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.005s | 📂 dir-open ✅ tsdf/sess1/corrupted (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.006s | 📂 dir-open ✅ tsdf/sess1/corrupted/document (scope directory)
      .      | 🗂️ tsdf/sess1/corrupted/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/corrupted (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.007s | 📂 dir-open ✅ tsdf/sess1/corrupted/document (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/corrupted (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.008s | 📄 file-open ✅ tsdf/sess1/corrupted/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.corrupted (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/corrupted/document (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/trigger (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.009s | 🗑️ ✅ tsdf/sess1/corrupted/document/__tsdf_payload__%3Adocument.json
             |    └ (tsdf.sess1.corrupted (payload))
      .      | 🗑️ ✅ tsdf/sess1/corrupted/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.corrupted (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/trigger/document (scope directory)
      .      | 🗂️ tsdf/sess1/trigger/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/trigger (store directory)
      2.01s  | 📂 dir-open ✅ tsdf/sess1/trigger/document (scope directory)
      2.011s | 📖 tsdf/sess1/corrupted/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.corrupted (metadata)) | 0.02 kb
      .      | 📄 file-open ✅ tsdf/sess1/trigger/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.trigger (metadata))
      2.014s | 📖 tsdf/sess1/trigger/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.trigger (metadata)) | 0.23 kb
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
      2.002s | 🗂️ tsdf (root directory) entries=["dir:sess1"]
      .      | 🗂️ tsdf/sess1
             |    └ (session directory) entries=["dir:invalid-metadata","dir:missing-payload","dir:valid-doc"]
      .      | 🗂️ tsdf/sess1/invalid-metadata (store directory) entries=["dir:document"]
      .      | 🗂️ tsdf/sess1/missing-payload (store directory) entries=["dir:document"]
      .      | 🗂️ tsdf/sess1/valid-doc (store directory) entries=["dir:document"]
      2.006s | 🗂️ tsdf/sess1/invalid-metadata/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      2.009s | 🗑️ ✅ tsdf/sess1/invalid-metadata/document/__tsdf_payload__%3Adocument.json
             |    └ (tsdf.sess1.invalid-metadata (payload))
      .      | 🗑️ ✅ tsdf/sess1/invalid-metadata/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.invalid-metadata (metadata))
      .      | 🗂️ tsdf/sess1/missing-payload/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json"]
      2.011s | 📖 tsdf/sess1/invalid-metadata/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.invalid-metadata (metadata)) | 0.02 kb
      2.012s | 🗑️ ✅ tsdf/sess1/missing-payload/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.missing-payload (metadata))
      .      | 🗂️ tsdf/sess1/valid-doc/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      2.014s | 📖 tsdf/sess1/missing-payload/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.missing-payload (metadata)) | 0.21 kb
      2.017s | 📖 tsdf/sess1/valid-doc/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.valid-doc (metadata)) | 0.23 kb

      verbose
      time   |
      2.002s | 📁 dir-open-or-create ✅ tsdf (root directory)
      .      | 🗂️ tsdf (root directory) entries=["dir:sess1"]
      .      | 🗂️ tsdf/sess1
             |    └ (session directory) entries=["dir:invalid-metadata","dir:missing-payload","dir:valid-doc"]
      .      | 🗂️ tsdf/sess1/invalid-metadata (store directory) entries=["dir:document"]
      .      | 🗂️ tsdf/sess1/missing-payload (store directory) entries=["dir:document"]
      .      | 🗂️ tsdf/sess1/valid-doc (store directory) entries=["dir:document"]
      2.003s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.004s | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.005s | 📂 dir-open ✅ tsdf/sess1/invalid-metadata (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.006s | 📂 dir-open ✅ tsdf/sess1/invalid-metadata/document (scope directory)
      .      | 🗂️ tsdf/sess1/invalid-metadata/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/invalid-metadata (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.007s | 📂 dir-open ✅ tsdf/sess1/invalid-metadata/document (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/invalid-metadata (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.008s | 📄 file-open ✅ tsdf/sess1/invalid-metadata/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.invalid-metadata (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/invalid-metadata/document (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/missing-payload (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.009s | 🗑️ ✅ tsdf/sess1/invalid-metadata/document/__tsdf_payload__%3Adocument.json
             |    └ (tsdf.sess1.invalid-metadata (payload))
      .      | 🗑️ ✅ tsdf/sess1/invalid-metadata/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.invalid-metadata (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/missing-payload/document (scope directory)
      .      | 🗂️ tsdf/sess1/missing-payload/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/missing-payload (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.01s  | 📂 dir-open ✅ tsdf/sess1/missing-payload/document (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/missing-payload (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.011s | 📖 tsdf/sess1/invalid-metadata/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.invalid-metadata (metadata)) | 0.02 kb
      .      | 📄 file-open ✅ tsdf/sess1/missing-payload/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.missing-payload (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/missing-payload/document (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/valid-doc (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.012s | 🧹 ❌ tsdf/sess1/missing-payload/document/__tsdf_payload__%3Adocument.json (scope directory)
      .      | 🗑️ ✅ tsdf/sess1/missing-payload/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.missing-payload (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/valid-doc/document (scope directory)
      .      | 🗂️ tsdf/sess1/valid-doc/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/valid-doc (store directory)
      2.013s | 📂 dir-open ✅ tsdf/sess1/valid-doc/document (scope directory)
      2.014s | 📖 tsdf/sess1/missing-payload/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.missing-payload (metadata)) | 0.21 kb
      .      | 📄 file-open ✅ tsdf/sess1/valid-doc/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.valid-doc (metadata))
      2.017s | 📖 tsdf/sess1/valid-doc/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.sess1.valid-doc (metadata)) | 0.23 kb
      "
    `);
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
      maintenanceState: getParsedLocalStorageValue(
        ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY,
      ),
    }).toMatchInlineSnapshot(`
      maintenanceState: { lca: 1735689602000 }
      protectedEntryExists: '✅'
      unprotectedEntryExists: '❌'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      simplified
      time   |
      2.002s | 🗂️ tsdf (root directory) entries=["dir:user%40example.com"]
      .      | 🗂️ tsdf/user%40example.com (session directory) entries=["dir:protected-doc","dir:unprotected-doc"]
      .      | 🗂️ tsdf/user%40example.com/protected-doc (store directory) entries=["dir:document"]
      .      | 🗂️ tsdf/user%40example.com/unprotected-doc (store directory) entries=["dir:document"]
      2.005s | 🗂️ tsdf/user%40example.com/protected-doc/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      2.007s | 🗂️ tsdf/user%40example.com/unprotected-doc/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      2.01s  | 📖 tsdf/user%40example.com/protected-doc/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.user@example.com.protected-doc (metadata)) | 0.23 kb
      .      | 🗑️ ✅ tsdf/user%40example.com/unprotected-doc/document/__tsdf_payload__%3Adocument.json
             |    └ (tsdf.user@example.com.unprotected-doc (payload))
      .      | 🗑️ ✅ tsdf/user%40example.com/unprotected-doc/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.user@example.com.unprotected-doc (metadata))
      2.012s | 📖 tsdf/user%40example.com/unprotected-doc/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.user@example.com.unprotected-doc (metadata)) | 0.23 kb

      verbose
      time   |
      2.002s | 📁 dir-open-or-create ✅ tsdf (root directory)
      .      | 🗂️ tsdf (root directory) entries=["dir:user%40example.com"]
      .      | 🗂️ tsdf/user%40example.com (session directory) entries=["dir:protected-doc","dir:unprotected-doc"]
      .      | 🗂️ tsdf/user%40example.com/protected-doc (store directory) entries=["dir:document"]
      .      | 🗂️ tsdf/user%40example.com/unprotected-doc (store directory) entries=["dir:document"]
      2.003s | 📂 dir-open ✅ tsdf/user%40example.com (session directory)
      2.004s | 📂 dir-open ✅ tsdf/user%40example.com/protected-doc (store directory)
      .      | 📂 dir-open ✅ tsdf/user%40example.com (session directory)
      2.005s | 📂 dir-open ✅ tsdf/user%40example.com/protected-doc/document (scope directory)
      .      | 🗂️ tsdf/user%40example.com/protected-doc/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      .      | 📂 dir-open ✅ tsdf/user%40example.com/protected-doc (store directory)
      .      | 📂 dir-open ✅ tsdf/user%40example.com (session directory)
      2.006s | 📂 dir-open ✅ tsdf/user%40example.com/protected-doc/document (scope directory)
      .      | 📂 dir-open ✅ tsdf/user%40example.com/unprotected-doc (store directory)
      .      | 📂 dir-open ✅ tsdf/user%40example.com (session directory)
      2.007s | 📄 file-open ✅ tsdf/user%40example.com/protected-doc/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.user@example.com.protected-doc (metadata))
      .      | 📂 dir-open ✅ tsdf/user%40example.com/unprotected-doc/document (scope directory)
      .      | 🗂️ tsdf/user%40example.com/unprotected-doc/document
             |    └ (scope directory) entries=["file:__tsdf_meta__%3Adocument.json","file:__tsdf_payload__%3Adocument.json"]
      .      | 📂 dir-open ✅ tsdf/user%40example.com/unprotected-doc (store directory)
      .      | 📂 dir-open ✅ tsdf/user%40example.com (session directory)
      2.008s | 📂 dir-open ✅ tsdf/user%40example.com/unprotected-doc/document (scope directory)
      .      | 📂 dir-open ✅ tsdf/user%40example.com/unprotected-doc (store directory)
      2.009s | 📄 file-open ✅ tsdf/user%40example.com/unprotected-doc/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.user@example.com.unprotected-doc (metadata))
      .      | 📂 dir-open ✅ tsdf/user%40example.com/unprotected-doc/document (scope directory)
      2.01s  | 📖 tsdf/user%40example.com/protected-doc/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.user@example.com.protected-doc (metadata)) | 0.23 kb
      .      | 🗑️ ✅ tsdf/user%40example.com/unprotected-doc/document/__tsdf_payload__%3Adocument.json
             |    └ (tsdf.user@example.com.unprotected-doc (payload))
      .      | 🗑️ ✅ tsdf/user%40example.com/unprotected-doc/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.user@example.com.unprotected-doc (metadata))
      2.012s | 📖 tsdf/user%40example.com/unprotected-doc/document/__tsdf_meta__%3Adocument.json
             |    └ (tsdf.user@example.com.unprotected-doc (metadata)) | 0.23 kb
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

  test('startup cleanup falls back to unlocked coordination when navigator.locks is unavailable', async () => {
    const staleTimestamp = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const staleDoc = mockAdapter.scope('stale-doc', 'sess1');
    const staleKey = staleDoc.document.storageKey();
    const originalLocksDescriptor = Object.getOwnPropertyDescriptor(
      globalThis.navigator,
      'locks',
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    staleDoc.document.seed(
      { value: { name: 'stale', value: 1 } },
      { timestamp: staleTimestamp },
    );

    Object.defineProperty(globalThis.navigator, 'locks', {
      value: null,
      writable: true,
      configurable: true,
    });

    try {
      createDocumentEnv({ storeName: 'trigger-doc', sessionKey: 'sess1' });
      await waitForScheduledCleanup();

      expect({
        maintenanceState: getParsedLocalStorageValue(
          ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY,
        ),
        staleEntryExists: mockAdapter.has(staleKey),
      }).toMatchInlineSnapshot(`
        maintenanceState: { lca: 1735689602000 }
        staleEntryExists: '❌'
      `);
      expect(warnSpy.mock.calls).toMatchInlineSnapshot(`
        - - '[TSDF] navigator.locks is unavailable; async OPFS startup cleanup is using unlocked coordination.'
      `);
    } finally {
      warnSpy.mockRestore();

      if (originalLocksDescriptor) {
        Object.defineProperty(
          globalThis.navigator,
          'locks',
          originalLocksDescriptor,
        );
      } else {
        Reflect.deleteProperty(globalThis.navigator, 'locks');
      }
    }
  });
});
