import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AsyncStorageNamespaceScope } from '../../src/persistentStorage/types';
import { resetMockBrowserOpfsForTests } from '../mocks/mockBrowserOpfs';
import { resolveAfterAllTimers } from './genericTestUtils';
import { createOpfsPersistentStorageTestStore } from './opfsPersistentStorageTestStore';
import {
  getLocalStorageTree,
  getOpfsDirTree,
  getParsedOpfsFileData,
  getParsedOpfsNamespaceValue,
  startPersistentStorageOperationCapture,
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
      writable.write(JSON.stringify({ e: { document: { a: 3 } } })),
    );
    await resolveAfterAllTimers(writable.close());
    await resolveAfterAllTimers(storeDir.removeEntry('d.e.p.json'));

    expect(capture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time |
      1ms  | 📁 dir-open-or-create ✅ tsdf (root directory)
      2ms  | 📂 dir-open ✅ tsdf/sess1 (session directory)
      3ms  | 📂 dir-open ✅ tsdf/sess1/docs (store directory)
      4ms  | 🗂️ list-dir tsdf/sess1/docs
           |    └ (store directory) entries=["file:d._i.r.json","file:d.e.p.json"]
      5ms  | 👁️ file-open ✅ #1 tsdf/sess1/docs/d.e.p.json (entry data)
      6ms  | 👁️ file-open ✅ #2 tsdf/sess1/docs/d._i.r.json (namespace index)
      7ms  | 📖 #1 tsdf/sess1/docs/d.e.p.json (entry data) | 0.10 kb
      12ms | ✍️ #2 tsdf/sess1/docs/d._i.r.json
           |    └ (namespace index) | 0.05 kb -> 0.05 kb
      14ms | 🗑️ ✅ #1 tsdf/sess1/docs/d.e.p.json (entry data)
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
      4ms  | 👁️ file-open ✅ #1 tsdf/sess1/docs/d.e.p.json (entry data)
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
          - a: 0
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
      0    | ✍️ ❌->✅ #1 tsdf._m.r.s:sess1.doc-remount-flow.m
           |    └ (root, single, manifest) | ❌ -> 0.01 kb
      "
    `);
  });

  test('getLocalStorageTree counts each node name once and rolls up descendant sizes', () => {
    localStorage.setItem('tsdf.docs.item.a', 'x'.repeat(40));
    localStorage.setItem('tsdf.docs.item.b', 'x'.repeat(60));
    localStorage.setItem('tsdf.docs.meta', 'x'.repeat(20));

    expect(getLocalStorageTree()).toMatchInlineSnapshot(`
      "tsdf (0.27 kb)
      └ docs (0.26 kb)
        ├ item (0.21 kb)
        │ ├ a (0.08 kb)
        │ └ b (0.12 kb)
        └ meta (0.05 kb)"
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
      'tsdf/sess1/docs/d.e.m.json',
      'x'.repeat(20),
    );
    mockAdapter.mockBrowserOpfs.writeFile(
      'tsdf/sess1/docs/d.e.p.json',
      'x'.repeat(40),
    );
    mockAdapter.mockBrowserOpfs.writeFile(
      'tsdf/sess1/users/ci.%22user-1.p.json',
      'x'.repeat(60),
    );

    expect(getOpfsDirTree(mockAdapter)).toMatchInlineSnapshot(`
      "tsdf (0.35 kb)
      └ sess1 (0.34 kb)
        ├ docs (0.16 kb)
        │ ├ d.e.m.json (0.06 kb)
        │ └ d.e.p.json (0.10 kb)
        └ users (0.16 kb)
          └ ci.%22user-1.p.json (0.15 kb)"
    `);
  });
});
