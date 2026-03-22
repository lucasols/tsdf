import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AsyncStorageNamespaceScope } from '../../src/persistentStorage/types';
import { resetMockBrowserOpfsForTests } from '../mocks/mockBrowserOpfs';
import { flushAllTimers } from './genericTestUtils';
import { createOpfsPersistentStorageTestStore } from './opfsPersistentStorageTestStore';
import {
  getParsedOpfsEntryFiles,
  getParsedOpfsNamespaceValue,
  startOpfsPersistentStorageOperationCapture,
} from './persistentStorageOptimizationTestUtils';

const INTERNAL_ASYNC_SCOPE: AsyncStorageNamespaceScope = {
  sessionKey: '__tsdf_async__',
  storeName: '__tsdf_async__',
  kind: '__internal.protected',
};

describe('startOpfsPersistentStorageOperationCapture', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    resetMockBrowserOpfsForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetMockBrowserOpfsForTests();
  });

  test('timelineString shows simplified effects first and full verbose detail second', async () => {
    async function resolveWithTimers<T>(promise: Promise<T>): Promise<T> {
      await flushAllTimers();
      return await promise;
    }

    const mockAdapter = createOpfsPersistentStorageTestStore();
    const documentScope = mockAdapter.scope('docs', 'sess1');
    documentScope.document.seed({
      value: { name: 'Cached document', value: 1 },
    });

    const capture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    const navigatorRoot = await resolveWithTimers(
      navigator.storage.getDirectory(),
    );
    const opfsRoot = await resolveWithTimers(
      navigatorRoot.getDirectoryHandle('tsdf', { create: true }),
    );
    const sessionDir = await resolveWithTimers(
      opfsRoot.getDirectoryHandle('sess1'),
    );
    const storeDir = await resolveWithTimers(
      sessionDir.getDirectoryHandle('docs'),
    );

    // Trigger a list scan, a payload read, a metadata write, and a payload delete.
    void storeDir.values();
    const payloadFile = await resolveWithTimers(
      storeDir.getFileHandle(
        `document~${encodeURIComponent('__tsdf_payload__:document')}.json`,
      ),
    );
    const metadataFile = await resolveWithTimers(
      storeDir.getFileHandle(
        `document~${encodeURIComponent('__tsdf_meta__:document')}.json`,
      ),
    );
    const payloadBlob = await resolveWithTimers(payloadFile.getFile());
    await resolveWithTimers(payloadBlob.text());
    const writable = await resolveWithTimers(metadataFile.createWritable());
    await resolveWithTimers(
      writable.write(
        JSON.stringify({
          key: 'document',
          writtenAt: 2,
          lastAccessAt: 3,
          version: 1,
          customMetadata: {},
        }),
      ),
    );
    await resolveWithTimers(writable.close());
    await resolveWithTimers(
      storeDir.removeEntry(
        `document~${encodeURIComponent('__tsdf_payload__:document')}.json`,
      ),
    );

    expect(capture.finish().timelineString).toMatchInlineSnapshot(`
      "
      simplified
      time |
      4ms  | 🗂️ tsdf/sess1/docs
           |    └ (store directory) entries=["file:document~__tsdf_meta__%3Adocument.json","file:document~__tsdf_payload__%3Adocument.json"]
      7ms  | 🗑️ ✅ tsdf/sess1/docs/document~__tsdf_payload__%3Adocument.json (tsdf.sess1.docs (payload))
      8ms  | 📖 tsdf/sess1/docs/document~__tsdf_payload__%3Adocument.json (tsdf.sess1.docs (payload)) | 0.10 kb
      10ms | ✍️ tsdf/sess1/docs/document~__tsdf_meta__%3Adocument.json
           |    └ (tsdf.sess1.docs (metadata)) | 0.19 kb -> 0.16 kb

      verbose
      time |
      2ms  | 📁 dir-open-or-create ✅ tsdf (root directory)
      3ms  | 📂 dir-open ✅ tsdf/sess1 (session directory)
      4ms  | 📂 dir-open ✅ tsdf/sess1/docs (store directory)
      .    | 🗂️ tsdf/sess1/docs
           |    └ (store directory) entries=["file:document~__tsdf_meta__%3Adocument.json","file:document~__tsdf_payload__%3Adocument.json"]
      5ms  | 📄 file-open ✅ tsdf/sess1/docs/document~__tsdf_payload__%3Adocument.json (tsdf.sess1.docs (payload))
      6ms  | 📄 file-open ✅ tsdf/sess1/docs/document~__tsdf_meta__%3Adocument.json (tsdf.sess1.docs (metadata))
      7ms  | 🗑️ ✅ tsdf/sess1/docs/document~__tsdf_payload__%3Adocument.json (tsdf.sess1.docs (payload))
      8ms  | 📖 tsdf/sess1/docs/document~__tsdf_payload__%3Adocument.json (tsdf.sess1.docs (payload)) | 0.10 kb
      10ms | ✍️ tsdf/sess1/docs/document~__tsdf_meta__%3Adocument.json
           |    └ (tsdf.sess1.docs (metadata)) | 0.19 kb -> 0.16 kb
      "
    `);
  });

  test('OPFS inspection helpers read logical entry files and raw namespace records', () => {
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const documentScope = mockAdapter.scope('docs', 'sess1');

    documentScope.document.seed({
      value: { name: 'Cached document', value: 1 },
    });
    mockAdapter.rawNamespace.set(INTERNAL_ASYNC_SCOPE, 'maintenance', {
      lastSuccessfulCleanupAt: 123,
      startupCleanupLease: null,
    });

    expect(
      getParsedOpfsEntryFiles(mockAdapter, documentScope.document.storageKey()),
    ).toMatchInlineSnapshot(`
      metadata:
        customMetadata: {}
        key: 'document'
        lastAccessAt: 0
        sizeBytes: 52
        version: 1
        writtenAt: 0

      payload:
        d:
          value: { name: 'Cached document', value: 1 }
    `);
    expect(
      getParsedOpfsNamespaceValue(
        mockAdapter,
        INTERNAL_ASYNC_SCOPE,
        'maintenance',
      ),
    ).toMatchInlineSnapshot(`
      lastSuccessfulCleanupAt: 123
      startupCleanupLease: null
    `);
  });
});
