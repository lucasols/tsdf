import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DOCUMENT_PERSISTED_ENTRY_KEY } from '../../src/persistentStorage/documentEntryKey';
import {
  buildFileName,
  getPayloadRecordKey,
} from '../../src/persistentStorage/opfsFileNaming';
import type { AsyncStorageNamespaceScope } from '../../src/persistentStorage/types';
import { resetMockBrowserOpfsForTests } from '../mocks/mockBrowserOpfs';
import { resolveAfterAllTimers } from './genericTestUtils';
import { createOpfsPersistentStorageTestStore } from './opfsPersistentStorageTestStore';
import {
  getLocalStorageTree,
  getOpfsDirTree,
  getParsedOpfsFileData,
  getParsedOpfsNamespaceValue,
  getPersistentStorageOperationTimelineString,
  startOpfsPersistentStorageOperationCapture,
  startPersistentStorageOperationCapture,
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

  test('timelineString shows the full verbose OPFS timeline', async () => {
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

    // Trigger a list scan, an entry data read, a namespace index write, and an entry data delete.
    await resolveAfterAllTimers(storeDir.values().next());
    const payloadFile = await resolveAfterAllTimers(
      storeDir.getFileHandle('d.e.p.json'),
    );
    const namespaceIndexFile = await resolveAfterAllTimers(
      storeDir.getFileHandle('d._i.r.json'),
    );
    const payloadBlob = await resolveAfterAllTimers(payloadFile.getFile());
    await resolveAfterAllTimers(payloadBlob.text());
    const writable = await resolveAfterAllTimers(
      namespaceIndexFile.createWritable(),
    );
    await resolveAfterAllTimers(
      writable.write(
        JSON.stringify({ e: { [DOCUMENT_PERSISTED_ENTRY_KEY]: { a: 3 } } }),
      ),
    );
    await resolveAfterAllTimers(writable.close());
    await resolveAfterAllTimers(storeDir.removeEntry('d.e.p.json'));

    expect(capture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time |
      1ms  | 📁 dir-open-or-create ✅ tsdf (root directory)
      2ms  | 📂 dir-open ✅ tsdf/sess1 (session directory)
      3ms  | 📂 dir-open ✅ tsdf/sess1/docs (store directory)
      4ms  | 🗂️ list-dir-values tsdf/sess1/docs
           |    └ (store directory) entries=["file:d._i.r.json","file:d.e.p.json"]
      5ms  | 👁️ #1 file-open ✅ tsdf/sess1/docs/d.e.p.json (entry data)
      6ms  | 👁️ #2 file-open ✅ tsdf/sess1/docs/d._i.r.json (namespace index)
      7ms  | 📖 #1 tsdf/sess1/docs/d.e.p.json (entry data) | 0.10 kb
      12ms | ✍️ #2 tsdf/sess1/docs/d._i.r.json
           |    └ (namespace index) | 0.05 kb -> 0.04 kb
      14ms | 🗑️ #1 ✅ tsdf/sess1/docs/d.e.p.json (entry data)
      15ms | end
      "
    `);
  });

  test('timelineString end marker uses completion time instead of the last start time', async () => {
    const mockAdapter = createOpfsPersistentStorageTestStore({});
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
      time |
      1ms  | 📁 dir-open-or-create ✅ tsdf (root directory)
      2ms  | 📂 dir-open ✅ tsdf/sess1 (session directory)
      3ms  | 📂 dir-open ✅ tsdf/sess1/docs (store directory)
      4ms  | 👁️ #1 file-open ✅ tsdf/sess1/docs/d.e.p.json (entry data)
      5ms  | 📖 #1 tsdf/sess1/docs/d.e.p.json (entry data) | 0.10 kb
      8ms  | end
      "
    `);
  });

  test('timelineString is relative to when capture starts', async () => {
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const documentScope = mockAdapter.scope('docs', 'sess1');
    documentScope.document.seed({
      value: { name: 'Cached document', value: 1 },
    });

    vi.advanceTimersByTime(15 * 24 * 60 * 60 * 1000);

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

    void storeDir.values();

    expect(capture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time |
      1ms  | 📁 dir-open-or-create ✅ tsdf (root directory)
      2ms  | 📂 dir-open ✅ tsdf/sess1 (session directory)
      3ms  | 📂 dir-open ✅ tsdf/sess1/docs (store directory)
      4ms  | end
      "
    `);
  });

  test('timelineString warns for duplicate file-open operations across the full OPFS history', () => {
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const documentScope = mockAdapter.scope('docs', 'sess1');

    documentScope.document.seed({
      value: { name: 'Cached document', value: 1 },
    });

    const capture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    const path = 'tsdf/sess1/docs/d._i.r.json';

    mockAdapter.mockBrowserOpfs.operations.push(
      {
        created: false,
        exists: true,
        path,
        startedTime: 0,
        time: 1,
        type: 'openFile',
      },
      {
        created: false,
        exists: true,
        path,
        startedTime: 2000,
        time: 2001,
        type: 'openFile',
      },
    );

    expect(capture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time   |
      0      | 👁️ #1 file-open ✅ tsdf/sess1/docs/d._i.r.json (namespace index)
             ·
      2s     | 👁️ #1 file-open ✅ tsdf/sess1/docs/d._i.r.json
             |    └ (namespace index) ⚠️ DUPLICATE OPEN
      2.001s | end
      "
    `);
  });

  test('timelineString treats ensureFile and openFile as duplicate opens of the same cached handle', () => {
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const documentScope = mockAdapter.scope('docs', 'sess1');

    documentScope.document.seed({
      value: { name: 'Cached document', value: 1 },
    });

    const capture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    const path = 'tsdf/sess1/docs/d._i.r.json';

    mockAdapter.mockBrowserOpfs.operations.push(
      {
        created: false,
        exists: true,
        path,
        startedTime: 0,
        time: 1,
        type: 'ensureFile',
      },
      {
        created: false,
        exists: true,
        path,
        startedTime: 2,
        time: 3,
        type: 'openFile',
      },
    );

    expect(capture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time |
      0    | 👁️ #1 file-open-or-create ✅ tsdf/sess1/docs/d._i.r.json
           |    └ (namespace index)
      2ms  | 👁️ #1 file-open ✅ tsdf/sess1/docs/d._i.r.json
           |    └ (namespace index) ⚠️ DUPLICATE OPEN
      3ms  | end
      "
    `);
  });

  test('timelineString warns for consecutive unchanged OPFS reads within 10ms', () => {
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const documentScope = mockAdapter.scope('docs', 'sess1');

    documentScope.document.seed({
      value: { name: 'Cached document', value: 1 },
    });

    const capture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    const path = 'tsdf/sess1/docs/d._i.r.json';
    const readRaw = mockAdapter.mockBrowserOpfs.readFile(path);
    if (readRaw === null) {
      throw new Error(`Expected OPFS file at "${path}".`);
    }

    mockAdapter.mockBrowserOpfs.operations.push(
      {
        path,
        readRaw,
        startedTime: 0,
        time: 1,
        type: 'readFile',
        valueByteSize: readRaw.length * 2,
      },
      {
        path,
        readRaw,
        startedTime: 9,
        time: 10,
        type: 'readFile',
        valueByteSize: readRaw.length * 2,
      },
    );

    expect(capture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time |
      0    | 📖 #1 tsdf/sess1/docs/d._i.r.json (namespace index) | 0.05 kb
      9ms  | 📖 #1 tsdf/sess1/docs/d._i.r.json
           |    └ (namespace index) | 0.05 kb ⚠️ REPEATED READ <10ms UNCHANGED
      10ms | end
      "
    `);
  });

  test('timelineString does not warn at the 10ms OPFS boundary', () => {
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const documentScope = mockAdapter.scope('docs', 'sess1');

    documentScope.document.seed({
      value: { name: 'Cached document', value: 1 },
    });

    const capture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    const path = 'tsdf/sess1/docs/d._i.r.json';
    const readRaw = mockAdapter.mockBrowserOpfs.readFile(path);
    if (readRaw === null) {
      throw new Error(`Expected OPFS file at "${path}".`);
    }

    mockAdapter.mockBrowserOpfs.operations.push(
      {
        path,
        readRaw,
        startedTime: 0,
        time: 1,
        type: 'readFile',
        valueByteSize: readRaw.length * 2,
      },
      {
        path,
        readRaw,
        startedTime: 10,
        time: 11,
        type: 'readFile',
        valueByteSize: readRaw.length * 2,
      },
    );

    expect(capture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time |
      0    | 📖 #1 tsdf/sess1/docs/d._i.r.json (namespace index) | 0.05 kb
      10ms | 📖 #1 tsdf/sess1/docs/d._i.r.json (namespace index) | 0.05 kb
      11ms | end
      "
    `);
  });

  test('timelineString does not warn when consecutive OPFS reads changed data', () => {
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const documentScope = mockAdapter.scope('docs', 'sess1');

    documentScope.document.seed({
      value: { name: 'Cached document', value: 1 },
    });

    const capture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    const path = 'tsdf/sess1/docs/d._i.r.json';
    const firstReadRaw = mockAdapter.mockBrowserOpfs.readFile(path);
    if (firstReadRaw === null) {
      throw new Error(`Expected OPFS file at "${path}".`);
    }

    const secondReadRaw = JSON.stringify({ e: [{ a: 123 }] });
    mockAdapter.mockBrowserOpfs.operations.push(
      {
        path,
        readRaw: firstReadRaw,
        startedTime: 0,
        time: 1,
        type: 'readFile',
        valueByteSize: firstReadRaw.length * 2,
      },
      {
        path,
        readRaw: secondReadRaw,
        startedTime: 9,
        time: 10,
        type: 'readFile',
        valueByteSize: secondReadRaw.length * 2,
      },
    );

    expect(capture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time |
      0    | 📖 #1 tsdf/sess1/docs/d._i.r.json (namespace index) | 0.05 kb
      9ms  | 📖 #1 tsdf/sess1/docs/d._i.r.json (namespace index) | 0.03 kb
      10ms | end
      "
    `);
  });

  test('timelineString warns when matching OPFS reads stay within the 10ms window despite interleaving operations', () => {
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const documentScope = mockAdapter.scope('docs', 'sess1');

    documentScope.document.seed({
      value: { name: 'Cached document', value: 1 },
    });

    const capture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    const path = 'tsdf/sess1/docs/d._i.r.json';
    const readRaw = mockAdapter.mockBrowserOpfs.readFile(path);
    if (readRaw === null) {
      throw new Error(`Expected OPFS file at "${path}".`);
    }

    mockAdapter.mockBrowserOpfs.operations.push(
      {
        path,
        readRaw,
        startedTime: 0,
        time: 1,
        type: 'readFile',
        valueByteSize: readRaw.length * 2,
      },
      {
        created: false,
        exists: true,
        path,
        startedTime: 5,
        time: 6,
        type: 'openFile',
      },
      {
        path,
        readRaw,
        startedTime: 9,
        time: 10,
        type: 'readFile',
        valueByteSize: readRaw.length * 2,
      },
    );

    expect(capture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time |
      0    | 📖 #1 tsdf/sess1/docs/d._i.r.json (namespace index) | 0.05 kb
      5ms  | 👁️ #1 file-open ✅ tsdf/sess1/docs/d._i.r.json (namespace index)
      9ms  | 📖 #1 tsdf/sess1/docs/d._i.r.json
           |    └ (namespace index) | 0.05 kb ⚠️ REPEATED READ <10ms UNCHANGED
      10ms | end
      "
    `);
  });

  test('timelineString warns for consecutive duplicated unnecessary OPFS writes within 10ms', () => {
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const documentScope = mockAdapter.scope('docs', 'sess1');

    documentScope.document.seed({
      value: { name: 'Cached document', value: 1 },
    });

    const capture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    const path = 'tsdf/sess1/docs/d._i.r.json';
    const firstWriteRaw = JSON.stringify({ e: [{ a: 123 }] });

    mockAdapter.mockBrowserOpfs.operations.push(
      {
        path,
        startedTime: 0,
        time: 1,
        type: 'writeFile',
        valueByteSizeAfter: firstWriteRaw.length * 2,
        valueByteSizeBefore: 50,
        valueChanged: true,
        writeRaw: firstWriteRaw,
      },
      {
        path,
        startedTime: 9,
        time: 10,
        type: 'writeFile',
        valueByteSizeAfter: firstWriteRaw.length * 2,
        valueByteSizeBefore: firstWriteRaw.length * 2,
        valueChanged: false,
        writeRaw: firstWriteRaw,
      },
    );

    expect(capture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time |
      0    | ✍️ #1 tsdf/sess1/docs/d._i.r.json
           |    └ (namespace index) | 0.05 kb -> 0.03 kb
      9ms  | ✍️ #1 tsdf/sess1/docs/d._i.r.json
           |    └ (namespace index) | 0.03 kb -> 0.03 kb ⚠️ UNCHANGED ⚠️ DUPLICATE WRITE <10ms UNCHANGED
      10ms | end
      "
    `);
  });

  test('timelineString does not warn at the 10ms OPFS write boundary', () => {
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const documentScope = mockAdapter.scope('docs', 'sess1');

    documentScope.document.seed({
      value: { name: 'Cached document', value: 1 },
    });

    const capture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    const path = 'tsdf/sess1/docs/d._i.r.json';
    const writeRaw = JSON.stringify({ e: [{ a: 123 }] });

    mockAdapter.mockBrowserOpfs.operations.push(
      {
        path,
        startedTime: 0,
        time: 1,
        type: 'writeFile',
        valueByteSizeAfter: writeRaw.length * 2,
        valueByteSizeBefore: 50,
        valueChanged: true,
        writeRaw,
      },
      {
        path,
        startedTime: 10,
        time: 11,
        type: 'writeFile',
        valueByteSizeAfter: writeRaw.length * 2,
        valueByteSizeBefore: writeRaw.length * 2,
        valueChanged: false,
        writeRaw,
      },
    );

    expect(capture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time |
      0    | ✍️ #1 tsdf/sess1/docs/d._i.r.json
           |    └ (namespace index) | 0.05 kb -> 0.03 kb
      10ms | ✍️ #1 tsdf/sess1/docs/d._i.r.json
           |    └ (namespace index) | 0.03 kb -> 0.03 kb ⚠️ UNCHANGED
      11ms | end
      "
    `);
  });

  test('timelineString does not warn when consecutive OPFS writes changed data', () => {
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const documentScope = mockAdapter.scope('docs', 'sess1');

    documentScope.document.seed({
      value: { name: 'Cached document', value: 1 },
    });

    const capture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    const path = 'tsdf/sess1/docs/d._i.r.json';
    const firstWriteRaw = JSON.stringify({ e: [{ a: 123 }] });
    const secondWriteRaw = JSON.stringify({ e: [{ a: 124 }] });

    mockAdapter.mockBrowserOpfs.operations.push(
      {
        path,
        startedTime: 0,
        time: 1,
        type: 'writeFile',
        valueByteSizeAfter: firstWriteRaw.length * 2,
        valueByteSizeBefore: 50,
        valueChanged: true,
        writeRaw: firstWriteRaw,
      },
      {
        path,
        startedTime: 9,
        time: 10,
        type: 'writeFile',
        valueByteSizeAfter: secondWriteRaw.length * 2,
        valueByteSizeBefore: firstWriteRaw.length * 2,
        valueChanged: true,
        writeRaw: secondWriteRaw,
      },
    );

    expect(capture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time |
      0    | ✍️ #1 tsdf/sess1/docs/d._i.r.json
           |    └ (namespace index) | 0.05 kb -> 0.03 kb
      9ms  | ✍️ #1 tsdf/sess1/docs/d._i.r.json
           |    └ (namespace index) | 0.03 kb -> 0.03 kb
      10ms | end
      "
    `);
  });

  test('timelineString warns when matching OPFS writes stay within the 10ms window despite interleaving operations', () => {
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const documentScope = mockAdapter.scope('docs', 'sess1');

    documentScope.document.seed({
      value: { name: 'Cached document', value: 1 },
    });

    const capture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    const path = 'tsdf/sess1/docs/d._i.r.json';
    const writeRaw = JSON.stringify({ e: [{ a: 123 }] });

    mockAdapter.mockBrowserOpfs.operations.push(
      {
        path,
        startedTime: 0,
        time: 1,
        type: 'writeFile',
        valueByteSizeAfter: writeRaw.length * 2,
        valueByteSizeBefore: 50,
        valueChanged: true,
        writeRaw,
      },
      {
        created: false,
        exists: true,
        path,
        startedTime: 5,
        time: 6,
        type: 'openFile',
      },
      {
        path,
        startedTime: 9,
        time: 10,
        type: 'writeFile',
        valueByteSizeAfter: writeRaw.length * 2,
        valueByteSizeBefore: writeRaw.length * 2,
        valueChanged: false,
        writeRaw,
      },
    );

    expect(capture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time |
      0    | ✍️ #1 tsdf/sess1/docs/d._i.r.json
           |    └ (namespace index) | 0.05 kb -> 0.03 kb
      5ms  | 👁️ #1 file-open ✅ tsdf/sess1/docs/d._i.r.json (namespace index)
      9ms  | ✍️ #1 tsdf/sess1/docs/d._i.r.json
           |    └ (namespace index) | 0.03 kb -> 0.03 kb ⚠️ UNCHANGED ⚠️ DUPLICATE WRITE <10ms UNCHANGED
      10ms | end
      "
    `);
  });

  test('timelineString marks recursive directory deletions', async () => {
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

    await resolveAfterAllTimers(
      sessionDir.removeEntry('docs', { recursive: true }),
    );

    expect(capture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time |
      1ms  | 📁 dir-open-or-create ✅ tsdf (root directory)
      2ms  | 📂 dir-open ✅ tsdf/sess1 (session directory)
      3ms  | 🧹 del-dir recursive ✅ tsdf/sess1/docs (store directory)
      4ms  | end
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

    expect(getParsedOpfsFileData('tsdf/sess1/docs/d._i.r.json'))
      .toMatchInlineSnapshot(`
        e:
          - { a: 0, z: 59 }
      `);
    expect(getParsedOpfsFileData('tsdf/sess1/docs/d.e.p.json'))
      .toMatchInlineSnapshot(`
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

  test('OPFS inspection helpers accept exact, encoded, and placeholder hashed payload paths', () => {
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const storeScope = mockAdapter.scope('placeholder-paths', 'sess1');

    const collectionPayload = 'user.1';
    const listItem = storeScope.listQuery.seedItem('users', 1, {
      id: 1,
      name: 'Alice',
    });
    storeScope.collection.seedItem(collectionPayload, {
      id: collectionPayload,
      name: 'Collection item',
    });
    storeScope.listQuery.seedQuery({ tableId: 'users' }, [
      { tableId: 'users', id: 1 },
    ]);

    const exactHashedQueryPath = [
      'tsdf',
      'sess1',
      'placeholder-paths',
      buildFileName(
        storeScope.listQuery.queryNamespace,
        getPayloadRecordKey(
          storeScope.listQuery.queryKey({ tableId: 'users' }),
        ),
      ),
    ].join('/');

    // Exact hashed file paths should still work as-is.
    expect(getParsedOpfsFileData(exactHashedQueryPath)).toMatchInlineSnapshot(
      `i: ['"users||1']`,
    );

    // Encoded logical file paths should keep resolving to the hashed files.
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/placeholder-paths/li.%22users%7C%7C1.p.json',
      ),
    ).toMatchInlineSnapshot(`
      d: { id: 1, name: 'Alice' }
      p: 'users||1'
    `);

    // Placeholder file paths should resolve to the same hashed payload files.
    expect(
      getParsedOpfsFileData('tsdf/sess1/placeholder-paths/ci.<"user.1>.p.json'),
    ).toMatchInlineSnapshot(`
      d: { id: 'user.1', name: 'Collection item' }
      p: 'user.1'
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/placeholder-paths/li.<"users||1>.p.json',
      ),
    ).toMatchInlineSnapshot(`
      d: { id: 1, name: 'Alice' }
      p: 'users||1'
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/placeholder-paths/lq.<{tableId:"users"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`i: ['"users||1']`);
    expect(listItem.itemKey).toBe('"users||1');
  });
});

describe('startPersistentStorageOperationCapture', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  test('timelineString wraps long localStorage labels onto a detail line', () => {
    const capture = startPersistentStorageOperationCapture();

    localStorage.setItem('tsdf._m.r.s:sess1.doc-remount-flow.m', 'abc');

    expect(capture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time |
      0    | ✍️ #1 ❌->✅ tsdf._m.r.s:sess1.doc-remount-flow.m
           |    └ (namespace index) | ❌ -> 0.01 kb
      "
    `);
  });

  test('timelineString uses async-style sync payload and index labels', () => {
    const capture = startPersistentStorageOperationCapture();

    localStorage.setItem('tsdf.sess1.sync-doc', 'abc');
    localStorage.setItem('tsdf.sess1.sync-collection.ci."1', 'abc');
    localStorage.setItem('tsdf.sess1.sync-list.lq.{tableId:"users"}', 'abc');
    localStorage.setItem('tsdf.sess1.sync-list.li."users||1', 'abc');
    localStorage.setItem('tsdf._m.r.s:sess1.sync-doc.m', 'abc');
    localStorage.setItem('tsdf.sess1.sync-offline.oq.job-1', 'abc');

    expect(capture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time |
      0    | ✍️ #1 ❌->✅ tsdf.sess1.sync-doc (entry data) | ❌ -> 0.01 kb
      .    | ✍️ #2 ❌->✅ tsdf.sess1.sync-collection.ci."1
           |    └ (entry data, <"1>) | ❌ -> 0.01 kb
      .    | ✍️ #3 ❌->✅ tsdf.sess1.sync-list.lq.{tableId:"users"}
           |    └ (query data, <{tableId:"users"}>) | ❌ -> 0.01 kb
      .    | ✍️ #4 ❌->✅ tsdf.sess1.sync-list.li."users||1
           |    └ (item data, <"users||1>) | ❌ -> 0.01 kb
      .    | ✍️ #5 ❌->✅ tsdf._m.r.s:sess1.sync-doc.m
           |    └ (namespace index) | ❌ -> 0.01 kb
      .    | ✍️ #6 ❌->✅ tsdf.sess1.sync-offline.oq.job-1
           |    └ (entry data, <job-1>) | ❌ -> 0.01 kb
      "
    `);
  });

  test('timelineString warns for consecutive unchanged localStorage reads within 10ms', () => {
    expect(
      getPersistentStorageOperationTimelineString([
        {
          exists: true,
          key: 'tsdf._m.r.s:sess1.sync-doc.m',
          rawValue: 'abc',
          time: 0,
          type: 'getItem',
          valueByteSize: 6,
        },
        {
          exists: true,
          key: 'tsdf._m.r.s:sess1.sync-doc.m',
          rawValue: 'abc',
          time: 9,
          type: 'getItem',
          valueByteSize: 6,
        },
      ]),
    ).toMatchInlineSnapshot(`
      "
      time |
      0    | 📖 #1 ✅ tsdf._m.r.s:sess1.sync-doc.m (namespace index) | 0.01 kb
      9ms  | 📖 #1 ✅ tsdf._m.r.s:sess1.sync-doc.m
           |    └ (namespace index) | 0.01 kb ⚠️ REPEATED READ <10ms UNCHANGED
      "
    `);
  });

  test('timelineString does not warn at the 10ms localStorage boundary', () => {
    expect(
      getPersistentStorageOperationTimelineString([
        {
          exists: true,
          key: 'tsdf._m.r.s:sess1.sync-doc.m',
          rawValue: 'abc',
          time: 0,
          type: 'getItem',
          valueByteSize: 6,
        },
        {
          exists: true,
          key: 'tsdf._m.r.s:sess1.sync-doc.m',
          rawValue: 'abc',
          time: 10,
          type: 'getItem',
          valueByteSize: 6,
        },
      ]),
    ).toMatchInlineSnapshot(`
      "
      time |
      0    | 📖 #1 ✅ tsdf._m.r.s:sess1.sync-doc.m (namespace index) | 0.01 kb
      10ms | 📖 #1 ✅ tsdf._m.r.s:sess1.sync-doc.m (namespace index) | 0.01 kb
      "
    `);
  });

  test('timelineString does not warn when consecutive localStorage reads changed data', () => {
    expect(
      getPersistentStorageOperationTimelineString([
        {
          exists: true,
          key: 'tsdf._m.r.s:sess1.sync-doc.m',
          rawValue: 'abc',
          time: 0,
          type: 'getItem',
          valueByteSize: 6,
        },
        {
          exists: true,
          key: 'tsdf._m.r.s:sess1.sync-doc.m',
          rawValue: 'abd',
          time: 9,
          type: 'getItem',
          valueByteSize: 6,
        },
      ]),
    ).toMatchInlineSnapshot(`
      "
      time |
      0    | 📖 #1 ✅ tsdf._m.r.s:sess1.sync-doc.m (namespace index) | 0.01 kb
      9ms  | 📖 #1 ✅ tsdf._m.r.s:sess1.sync-doc.m (namespace index) | 0.01 kb
      "
    `);
  });

  test('timelineString warns when matching localStorage reads stay within the 10ms window despite interleaving operations', () => {
    expect(
      getPersistentStorageOperationTimelineString([
        {
          exists: true,
          key: 'tsdf._m.r.s:sess1.sync-doc.m',
          rawValue: 'abc',
          time: 0,
          type: 'getItem',
          valueByteSize: 6,
        },
        { index: 0, key: 'tsdf._m.r.s:sess1.sync-doc.m', time: 5, type: 'key' },
        {
          exists: true,
          key: 'tsdf._m.r.s:sess1.sync-doc.m',
          rawValue: 'abc',
          time: 9,
          type: 'getItem',
          valueByteSize: 6,
        },
      ]),
    ).toMatchInlineSnapshot(`
      "
      time |
      0    | 📖 #1 ✅ tsdf._m.r.s:sess1.sync-doc.m (namespace index) | 0.01 kb
      5ms  | 🔑[0] #1 ✅ tsdf._m.r.s:sess1.sync-doc.m (namespace index)
      9ms  | 📖 #1 ✅ tsdf._m.r.s:sess1.sync-doc.m
           |    └ (namespace index) | 0.01 kb ⚠️ REPEATED READ <10ms UNCHANGED
      "
    `);
  });

  test('timelineString warns for consecutive duplicated unnecessary localStorage writes within 10ms', () => {
    expect(
      getPersistentStorageOperationTimelineString([
        {
          existsBefore: false,
          key: 'tsdf._m.r.s:sess1.sync-doc.m',
          rawValueAfter: 'abc',
          time: 0,
          type: 'setItem',
          valueByteSizeAfter: 6,
          valueByteSizeBefore: null,
          valueChanged: true,
        },
        {
          existsBefore: true,
          key: 'tsdf._m.r.s:sess1.sync-doc.m',
          rawValueAfter: 'abc',
          time: 9,
          type: 'setItem',
          valueByteSizeAfter: 6,
          valueByteSizeBefore: 6,
          valueChanged: false,
        },
      ]),
    ).toMatchInlineSnapshot(`
      "
      time |
      0    | ✍️ #1 ❌->✅ tsdf._m.r.s:sess1.sync-doc.m
           |    └ (namespace index) | ❌ -> 0.01 kb
      9ms  | ✍️ #1 ✅->✅ tsdf._m.r.s:sess1.sync-doc.m
           |    └ (namespace index) | 0.01 kb -> 0.01 kb ⚠️ UNCHANGED ⚠️ DUPLICATE WRITE <10ms UNCHANGED
      "
    `);
  });

  test('timelineString does not warn at the 10ms localStorage write boundary', () => {
    expect(
      getPersistentStorageOperationTimelineString([
        {
          existsBefore: false,
          key: 'tsdf._m.r.s:sess1.sync-doc.m',
          rawValueAfter: 'abc',
          time: 0,
          type: 'setItem',
          valueByteSizeAfter: 6,
          valueByteSizeBefore: null,
          valueChanged: true,
        },
        {
          existsBefore: true,
          key: 'tsdf._m.r.s:sess1.sync-doc.m',
          rawValueAfter: 'abc',
          time: 10,
          type: 'setItem',
          valueByteSizeAfter: 6,
          valueByteSizeBefore: 6,
          valueChanged: false,
        },
      ]),
    ).toMatchInlineSnapshot(`
      "
      time |
      0    | ✍️ #1 ❌->✅ tsdf._m.r.s:sess1.sync-doc.m
           |    └ (namespace index) | ❌ -> 0.01 kb
      10ms | ✍️ #1 ✅->✅ tsdf._m.r.s:sess1.sync-doc.m
           |    └ (namespace index) | 0.01 kb -> 0.01 kb ⚠️ UNCHANGED
      "
    `);
  });

  test('timelineString does not warn when consecutive localStorage writes changed data', () => {
    expect(
      getPersistentStorageOperationTimelineString([
        {
          existsBefore: false,
          key: 'tsdf._m.r.s:sess1.sync-doc.m',
          rawValueAfter: 'abc',
          time: 0,
          type: 'setItem',
          valueByteSizeAfter: 6,
          valueByteSizeBefore: null,
          valueChanged: true,
        },
        {
          existsBefore: true,
          key: 'tsdf._m.r.s:sess1.sync-doc.m',
          rawValueAfter: 'abd',
          time: 9,
          type: 'setItem',
          valueByteSizeAfter: 6,
          valueByteSizeBefore: 6,
          valueChanged: true,
        },
      ]),
    ).toMatchInlineSnapshot(`
      "
      time |
      0    | ✍️ #1 ❌->✅ tsdf._m.r.s:sess1.sync-doc.m
           |    └ (namespace index) | ❌ -> 0.01 kb
      9ms  | ✍️ #1 ✅->✅ tsdf._m.r.s:sess1.sync-doc.m
           |    └ (namespace index) | 0.01 kb -> 0.01 kb
      "
    `);
  });

  test('timelineString warns when matching localStorage writes stay within the 10ms window despite interleaving operations', () => {
    expect(
      getPersistentStorageOperationTimelineString([
        {
          existsBefore: false,
          key: 'tsdf._m.r.s:sess1.sync-doc.m',
          rawValueAfter: 'abc',
          time: 0,
          type: 'setItem',
          valueByteSizeAfter: 6,
          valueByteSizeBefore: null,
          valueChanged: true,
        },
        { index: 0, key: 'tsdf._m.r.s:sess1.sync-doc.m', time: 5, type: 'key' },
        {
          existsBefore: true,
          key: 'tsdf._m.r.s:sess1.sync-doc.m',
          rawValueAfter: 'abc',
          time: 9,
          type: 'setItem',
          valueByteSizeAfter: 6,
          valueByteSizeBefore: 6,
          valueChanged: false,
        },
      ]),
    ).toMatchInlineSnapshot(`
      "
      time |
      0    | ✍️ #1 ❌->✅ tsdf._m.r.s:sess1.sync-doc.m
           |    └ (namespace index) | ❌ -> 0.01 kb
      5ms  | 🔑[0] #1 ✅ tsdf._m.r.s:sess1.sync-doc.m (namespace index)
      9ms  | ✍️ #1 ✅->✅ tsdf._m.r.s:sess1.sync-doc.m
           |    └ (namespace index) | 0.01 kb -> 0.01 kb ⚠️ UNCHANGED ⚠️ DUPLICATE WRITE <10ms UNCHANGED
      "
    `);
  });

  test('getLocalStorageTree counts each node name once and rolls up descendant sizes', () => {
    localStorage.setItem('tsdf.docs.item.a', 'x'.repeat(40));
    localStorage.setItem('tsdf.docs.item.b', 'x'.repeat(60));
    localStorage.setItem('tsdf.docs.meta', 'x'.repeat(20));
    localStorage.setItem('tsdf.sess1._o_.s', 'x'.repeat(20));
    localStorage.setItem('tsdf._m.r.n:sess1.docs.ci.m', 'x'.repeat(20));

    expect(getLocalStorageTree()).toMatchInlineSnapshot(`
      "tsdf (0.40 kb)
      ├ _m.r.n:sess1.docs.ci.m (0.07 kb)
      ├ docs (0.26 kb)
      │ ├ item (0.21 kb)
      │ │ ├ a (0.08 kb)
      │ │ └ b (0.12 kb)
      │ └ meta (0.05 kb)
      └ sess1._o_.s (0.06 kb)"
    `);
  });
});

describe('storage tree helpers', () => {
  beforeEach(() => {
    resetMockBrowserOpfsForTests();
  });

  afterEach(() => {
    resetMockBrowserOpfsForTests();
  });

  test('getOpfsDirTree counts directory and file names once and rolls up descendant sizes', () => {
    const mockAdapter = createOpfsPersistentStorageTestStore();

    mockAdapter.mockBrowserOpfs.writeFile(
      'tsdf/sess1/docs/d.e.p.json',
      'x'.repeat(40),
    );
    mockAdapter.mockBrowserOpfs.writeFile(
      'tsdf/sess1/users/ci.%22user-1.p.json',
      'x'.repeat(60),
    );

    expect(getOpfsDirTree(mockAdapter)).toMatchInlineSnapshot(`
      "tsdf (0.29 kb)
      └ sess1 (0.28 kb)
        ├ docs (0.11 kb)
        │ └ d.e.p.json (0.10 kb)
        └ users (0.16 kb)
          └ ci.%22user-1.p.json (0.15 kb)"
    `);
  });
});
