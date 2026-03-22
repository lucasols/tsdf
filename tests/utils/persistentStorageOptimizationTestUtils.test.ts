import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AsyncStorageNamespaceScope } from '../../src/persistentStorage/types';
import { resetMockBrowserOpfsForTests } from '../mocks/mockBrowserOpfs';
import { resolveAfterAllTimers } from './genericTestUtils';
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
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const documentScope = mockAdapter.scope('docs', 'sess1');
    documentScope.document.seed({
      value: { name: 'Cached document', value: 1 },
    });

    const capture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    const navigatorRoot = await resolveAfterAllTimers(
      navigator.storage.getDirectory(),
    );
    const opfsRoot = await resolveAfterAllTimers(
      navigatorRoot.getDirectoryHandle('tsdf', { create: true }),
    );
    const sessionDir = await resolveAfterAllTimers(
      opfsRoot.getDirectoryHandle('sess1'),
    );
    const storeDir = await resolveAfterAllTimers(
      sessionDir.getDirectoryHandle('docs'),
    );

    // Trigger a list scan, a payload read, a metadata write, and a payload delete.
    void storeDir.values();
    const payloadFile = await resolveAfterAllTimers(
      storeDir.getFileHandle('d.e.p.json'),
    );
    const metadataFile = await resolveAfterAllTimers(
      storeDir.getFileHandle('d.e.m.json'),
    );
    const payloadBlob = await resolveAfterAllTimers(payloadFile.getFile());
    await resolveAfterAllTimers(payloadBlob.text());
    const writable = await resolveAfterAllTimers(metadataFile.createWritable());
    await resolveAfterAllTimers(
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
    await resolveAfterAllTimers(writable.close());
    await resolveAfterAllTimers(storeDir.removeEntry('d.e.p.json'));

    expect(capture.finish().timelineString).toMatchInlineSnapshot(`
      "
      simplified
      time |
      4ms  | 🗂️ list-dir tsdf/sess1/docs
           |    └ (store directory) entries=["file:d.e.m.json","file:d.e.p.json"]
      8ms  | 📖 tsdf/sess1/docs/d.e.p.json (tsdf.sess1.docs (payload)) | 0.10 kb
      12ms | ✍️ tsdf/sess1/docs/d.e.m.json (tsdf.sess1.docs (metadata)) | 0.19 kb -> 0.16 kb
      14ms | 🗑️ ✅ tsdf/sess1/docs/d.e.p.json (tsdf.sess1.docs (payload))
      15ms | end

      verbose
      time |
      1ms  | 📁 dir-open-or-create ✅ tsdf (root directory)
      2ms  | 📂 dir-open ✅ tsdf/sess1 (session directory)
      3ms  | 📂 dir-open ✅ tsdf/sess1/docs (store directory)
      4ms  | 🗂️ list-dir tsdf/sess1/docs
           |    └ (store directory) entries=["file:d.e.m.json","file:d.e.p.json"]
      5ms  | 📄 file-open ✅ tsdf/sess1/docs/d.e.p.json (tsdf.sess1.docs (payload))
      6ms  | 📄 file-open ✅ tsdf/sess1/docs/d.e.m.json (tsdf.sess1.docs (metadata))
      8ms  | 📖 tsdf/sess1/docs/d.e.p.json (tsdf.sess1.docs (payload)) | 0.10 kb
      12ms | ✍️ tsdf/sess1/docs/d.e.m.json (tsdf.sess1.docs (metadata)) | 0.19 kb -> 0.16 kb
      14ms | 🗑️ ✅ tsdf/sess1/docs/d.e.p.json (tsdf.sess1.docs (payload))
      15ms | end
      "
    `);
  });

  test('timelineString end marker uses completion time instead of the last start time', async () => {
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
    const documentScope = mockAdapter.scope('docs', 'sess1');
    documentScope.document.seed({
      value: { name: 'Cached document', value: 1 },
    });

    const capture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    const navigatorRoot = await resolveAfterAllTimers(
      navigator.storage.getDirectory(),
    );
    const opfsRoot = await resolveAfterAllTimers(
      navigatorRoot.getDirectoryHandle('tsdf', { create: true }),
    );
    const sessionDir = await resolveAfterAllTimers(
      opfsRoot.getDirectoryHandle('sess1'),
    );
    const storeDir = await resolveAfterAllTimers(
      sessionDir.getDirectoryHandle('docs'),
    );
    const payloadFile = await resolveAfterAllTimers(
      storeDir.getFileHandle('d.e.p.json'),
    );
    const payloadBlob = await resolveAfterAllTimers(payloadFile.getFile());
    await resolveAfterAllTimers(payloadBlob.text());

    expect(capture.finish().timelineString).toMatchInlineSnapshot(`
      "
      simplified
      time |
      6ms  | 📖 tsdf/sess1/docs/d.e.p.json (tsdf.sess1.docs (payload)) | 0.10 kb
      58ms | end

      verbose
      time |
      1ms  | 📁 dir-open-or-create ✅ tsdf (root directory)
      2ms  | 📂 dir-open ✅ tsdf/sess1 (session directory)
      3ms  | 📂 dir-open ✅ tsdf/sess1/docs (store directory)
      4ms  | 📄 file-open ✅ tsdf/sess1/docs/d.e.p.json (tsdf.sess1.docs (payload))
      6ms  | 📖 tsdf/sess1/docs/d.e.p.json (tsdf.sess1.docs (payload)) | 0.10 kb
      58ms | end
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
