import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { render, renderHook } from '@testing-library/react';
import { act, lazy, StrictMode, Suspense } from 'react';
import { rc_number, rc_object, rc_string } from 'runcheck';
import {
  afterEach,
  beforeEach,
  expect,
  onTestFinished,
  test,
  vi,
} from 'vitest';
import type {
  DocumentOfflineOperationDefinition,
  OfflineUploadAdapter,
  OfflineUploadFile,
  ValidPayload,
} from '../../src/main';
import {
  clearSessionStorage,
  createStoreManager,
  opfsOfflineUploadAdapter,
} from '../../src/main';
import { encodePathSegment } from '../../src/persistentStorage/opfsFileNaming';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createMockBrowserOpfs } from '../mocks/mockBrowserOpfs';
import { normalizeError, TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import {
  advanceTime,
  flushAllTimers,
  pick,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import {
  getOpfsDirTree,
  getParsedOpfsFileData,
} from '../utils/persistentStorageOptimizationTestUtils';
import { resetSessionForTests } from '../utils/resetSessionForTests';
import { docSchema } from './offlineTestShared';

let network = createOfflineNetworkMock();
const DIRECT_UPLOAD_ID_PATTERN =
  /^offline-direct-upload-doc:[^:]+:[^:]+:avatar$/;
const ATTACHED_UPLOAD_FILE_ID_PATTERN =
  /^offline-upload-file-attached-doc:[^:]+:[^:]+:avatar$/;

function getOfflineUploadOpfsPath(
  sessionKey: string,
  uploadId: string,
  fileName: 'binary.blob' | 'metadata.json',
): string {
  return `tsdf-uploads/${encodePathSegment(sessionKey)}/${encodePathSegment(uploadId)}/${fileName}`;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
  network = createOfflineNetworkMock();
  network.install();
  resetSessionForTests({ clearStorage: true });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  resetSessionForTests({ clearStorage: true });
});

test('useOfflineUploads keeps manual uploads pending across reconnect until a dependency consumes them', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  const uploadRenders = createLoggerStore();
  const uploadCalls: string[] = [];
  const session = createStoreManager({
    getSessionKey: () => 'offline-upload-hook-session',
    errorNormalizer: normalizeError,
    offlineSession: {
      network: network.config,
      uploads: {
        adapter: opfsOfflineUploadAdapter,
        upload: async ({ id, onProgress }) => {
          uploadCalls.push(id);
          onProgress({ progress: 0.5 });
          await new Promise((resolve) => setTimeout(resolve, 20));
          onProgress({ progress: 1 });
          return `server:${id}`;
        },
      },
    },
  });
  const uploadHook = renderHook(() => {
    const upload = session.useOfflineUploads()[0];

    uploadRenders.add(upload ? upload : { state: 'no-upload' });

    return upload;
  });
  await flushAllTimers();
  uploadRenders.reset();

  // Queue a manual upload while offline so the hook exposes the pending entry.
  network.setOffline();
  uploadRenders.addMark('queue upload while offline');
  (
    await resolveAfterAllTimers(
      session.saveOfflineUpload({
        id: 'avatar',
        file: new File(['manual upload'], 'avatar.txt', {
          type: 'text/plain',
          lastModified: 1,
        }),
      }),
    )
  ).unwrap();

  expect(
    uploadHook.result.current &&
      pick(uploadHook.result.current, ['id', 'state', 'source']),
  ).toMatchInlineSnapshot(`
    id: 'avatar'
    source: 'manual'
    state: 'pending'
  `);
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`
    "tsdf-uploads (0.47 kb)
    └ offline-upload-hook-session (0.45 kb)
      └ avatar (0.39 kb)
        ├ binary.blob (0.05 kb)
        └ metadata.json (0.33 kb)"
  `);
  expect(
    getParsedOpfsFileData(
      'tsdf-uploads/offline-upload-hook-session/avatar/metadata.json',
    ),
  ).toMatchInlineSnapshot(`
    c: 1735689612000
    i: 'avatar'
    k: 'offline-upload-hook-session'
    l: 1
    m: 'text/plain'
    n: 'avatar.txt'
    o: 'manual'
    t: 'pending'
    u: 1735689612000
    z: 13
  `);
  expect(
    getParsedOpfsFileData(
      'tsdf-uploads/offline-upload-hook-session/avatar/binary.blob',
    ),
  ).toMatchInlineSnapshot(`"manual upload"`);

  // Reconnecting should not upload a manually staged file on its own.
  uploadRenders.addMark('go online without dependency');
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await advanceTime(4_000);

  // The file stays pending because only dependency resolution may consume it.
  expect(uploadCalls).toMatchInlineSnapshot(`[]`);
  expect(uploadRenders.changesSnapshot).toMatchInlineSnapshot(`
    "

    >>> queue upload while offline

    ┌─
    ⋅ id: avatar
    ⋅ sessionKey: offline-upload-hook-session
    ⋅ source: manual
    ⋅ state: pending
    ⋅ fileName: avatar.txt
    ⋅ mimeType: text/plain
    ⋅ sizeBytes: 13
    ⋅ createdAt: 1735689612000
    ⋅ updatedAt: 1735689612000
    └─

    >>> go online without dependency
    "
  `);

  // The upload remains available to future queued mutations by its original id.
  expect(
    uploadHook.result.current &&
      pick(uploadHook.result.current, ['id', 'state', 'source', 'resolvedRef']),
  ).toMatchInlineSnapshot(`
    id: 'avatar'
    source: 'manual'
    state: 'pending'
  `);
  expect(
    getParsedOpfsFileData(
      'tsdf-uploads/offline-upload-hook-session/avatar/metadata.json',
    ),
  ).toMatchInlineSnapshot(`
    c: 1735689612000
    i: 'avatar'
    k: 'offline-upload-hook-session'
    l: 1
    m: 'text/plain'
    n: 'avatar.txt'
    o: 'manual'
    t: 'pending'
    u: 1735689612000
    z: 13
  `);

  uploadHook.unmount();
});

test('manual uploads expire only after one week in the current online session', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  const sessionKey = 'offline-upload-retention-session';
  const dayMs = 24 * 60 * 60 * 1000;
  const uploadCalls: string[] = [];
  const session = createStoreManager({
    getSessionKey: () => sessionKey,
    errorNormalizer: normalizeError,
    offlineSession: {
      network: network.config,
      uploads: {
        adapter: opfsOfflineUploadAdapter,
        upload: ({ id }) => {
          uploadCalls.push(id);
          return Promise.resolve(`server:${id}`);
        },
      },
    },
  });
  const uploadHook = renderHook(() => session.useOfflineUploads());
  await flushAllTimers();

  // Keep the upload offline first so a long disconnected stretch does not
  // start the retention clock yet.
  network.setOffline();
  (
    await resolveAfterAllTimers(
      session.saveOfflineUpload({
        id: 'stale-manual-upload',
        file: new File(['retention body'], 'retention.txt', {
          type: 'text/plain',
          lastModified: 1,
        }),
      }),
    )
  ).unwrap();

  await advanceTime(8 * dayMs);
  expect(
    getParsedOpfsFileData(
      'tsdf-uploads/offline-upload-retention-session/stale-manual-upload/metadata.json',
    ),
  ).toMatchInlineSnapshot(`
    c: 1735689612000
    i: 'stale-manual-upload'
    k: 'offline-upload-retention-session'
    l: 1
    m: 'text/plain'
    n: 'retention.txt'
    o: 'manual'
    t: 'pending'
    u: 1735689612000
    z: 14
  `);

  // A brief reconnect should neither upload the file nor start retention yet.
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await advanceTime(4_000);
  await act(async () => {
    network.setOffline();
    await Promise.resolve();
  });

  expect(uploadCalls).toMatchInlineSnapshot(`[]`);
  expect(
    uploadHook.result.current.map((upload) =>
      pick(upload, ['id', 'state', 'resolvedRef']),
    ),
  ).toMatchInlineSnapshot(`
    - { id: 'stale-manual-upload', state: 'pending' }
  `);
  expect(
    getParsedOpfsFileData(
      'tsdf-uploads/offline-upload-retention-session/stale-manual-upload/metadata.json',
    ),
  ).toMatchInlineSnapshot(`
    c: 1735689612000
    i: 'stale-manual-upload'
    k: 'offline-upload-retention-session'
    l: 1
    m: 'text/plain'
    n: 'retention.txt'
    o: 'manual'
    t: 'pending'
    u: 1735689612000
    z: 14
  `);

  // The next stable online session starts the retention window.
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await advanceTime(5_000);

  const retentionStartedMetadata = getParsedOpfsFileData(
    'tsdf-uploads/offline-upload-retention-session/stale-manual-upload/metadata.json',
  );
  expect(
    uploadHook.result.current.map((upload) =>
      pick(upload, ['id', 'state', 'resolvedRef']),
    ),
  ).toMatchInlineSnapshot(`
    - { id: 'stale-manual-upload', state: 'pending' }
  `);
  expect(retentionStartedMetadata).toMatchInlineSnapshot(`
    c: 1735689612000
    g: 1736380817009
    i: 'stale-manual-upload'
    k: 'offline-upload-retention-session'
    l: 1
    m: 'text/plain'
    n: 'retention.txt'
    o: 'manual'
    t: 'pending'
    u: 1736380817009
    z: 14
  `);

  // Leaving the online session should preserve the upload instead of expiring it.
  await advanceTime(6 * dayMs);
  await act(async () => {
    network.setOffline();
    await Promise.resolve();
  });
  await advanceTime(0);

  expect(
    pick(
      getParsedOpfsFileData(
        'tsdf-uploads/offline-upload-retention-session/stale-manual-upload/metadata.json',
      ),
      ['i', 'o', 't'],
    ),
  ).toMatchInlineSnapshot(`
    i: 'stale-manual-upload'
    o: 'manual'
    t: 'pending'
  `);

  // Re-entering an online session resets the retention window instead of
  // continuing to use the previous online session timestamp.
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await advanceTime(5_000);

  const retentionResetMetadata = getParsedOpfsFileData(
    'tsdf-uploads/offline-upload-retention-session/stale-manual-upload/metadata.json',
  );
  expect(retentionResetMetadata).toBeTruthy();
  if (
    !retentionResetMetadata ||
    typeof retentionResetMetadata !== 'object' ||
    Array.isArray(retentionResetMetadata)
  ) {
    throw new Error('Expected retention metadata to remain available');
  }
  const retentionResetMetadataRecord = Object.fromEntries(
    Object.entries(retentionResetMetadata),
  );
  expect(pick(retentionResetMetadataRecord, ['i', 'o', 't']))
    .toMatchInlineSnapshot(`
      i: 'stale-manual-upload'
      o: 'manual'
      t: 'pending'
    `);

  await advanceTime(8 * dayMs);
  await flushAllTimers();

  // After a full online week without any consumer, the persisted upload is
  // cleaned up from both state and OPFS.
  expect(uploadHook.result.current).toMatchInlineSnapshot(`[]`);
  expect(
    getParsedOpfsFileData(
      'tsdf-uploads/offline-upload-retention-session/stale-manual-upload/metadata.json',
    ),
  ).toMatchInlineSnapshot(`null`);
  expect(
    getParsedOpfsFileData(
      'tsdf-uploads/offline-upload-retention-session/stale-manual-upload/binary.blob',
    ),
  ).toMatchInlineSnapshot(`null`);
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`"empty"`);

  uploadHook.unmount();
});

type DirectUploadUpdateOperations = {
  updateValue: DocumentOfflineOperationDefinition<
    { value: number },
    { input: { value: number } }
  >;
};

test('document direct uploads survive restart and replay with restored files even when the store uses local-sync persistence', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  const sessionKey = 'offline-direct-upload-session';
  const replayedFiles: Array<Record<string, unknown>> = [];

  // Start offline so the mutation is persisted instead of replaying immediately.
  network.setOffline();

  const storeManager = createStoreManager({
    getSessionKey: () => sessionKey,
    errorNormalizer: normalizeError,
    offlineSession: {
      network: network.config,
      uploads: {
        adapter: opfsOfflineUploadAdapter,
        upload: ({ id }) => Promise.resolve(`server:${id}`),
      },
    },
  });
  const session = storeManager;
  session.getOfflineStatus();

  const env = createDocumentStoreTestEnv<number, DirectUploadUpdateOperations>(
    1,
    {
      id: 'offline-direct-upload-doc',
      storeManager,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          operations: {
            updateValue: {
              inputSchema: rc_object({ value: rc_number }),
              kind: 'update',
              execute: async (ctx) => {
                const file = ctx.uploads.filesById.avatar;
                replayedFiles.push({
                  fileName: file?.name,
                  fileText: file ? await file.text() : null,
                  uploadKeys: Object.keys(ctx.uploads.filesById),
                });
                await env.serverMock.delayedSetData(ctx.input.value);
                return ctx.input;
              },
              onSuccessExecute: ({ input }) => {
                env.apiStore.updateState((draft) => {
                  draft.value = input.value;
                });
              },
            },
          },
        },
      },
    },
  );

  const uploadHook = renderHook(() => session.useOfflineUploads());
  await flushAllTimers();

  // Queue a document mutation with a direct file attachment.
  await resolveAfterAllTimers(
    env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value = 2;
        });
      },
      mutation: () => Promise.resolve({ value: 2 }),
      offline: { operation: 'updateValue', input: { value: 2 } },
      upload: {
        avatar: new File(['direct upload body'], 'avatar.txt', {
          type: 'text/plain',
          lastModified: 1,
        }),
      },
    }),
  );
  // The queued mutation persists its direct upload through the mocked OPFS
  // adapter, so settle those storage latencies before simulating a restart.
  await flushAllTimers();

  const queuedUpload = uploadHook.result.current[0];
  expect(queuedUpload?.id).toMatch(DIRECT_UPLOAD_ID_PATTERN);
  if (!queuedUpload) {
    throw new Error('Expected the queued direct upload to be persisted');
  }
  expect(pick(queuedUpload, ['state', 'source'])).toMatchInlineSnapshot(`
    source: 'mutation'
    state: 'pending'
  `);

  // Simulate a full app restart so the mutation and upload must be restored
  // from storage instead of surviving in memory.
  uploadHook.unmount();
  resetSessionForTests();

  const restartedStoreManager = createStoreManager({
    getSessionKey: () => sessionKey,
    errorNormalizer: normalizeError,
    offlineSession: {
      network: network.config,
      uploads: {
        adapter: opfsOfflineUploadAdapter,
        upload: ({ id }) => Promise.resolve(`server:${id}`),
      },
    },
  });
  const restartedSession = restartedStoreManager;
  restartedSession.getOfflineStatus();

  const restartedEnv = createDocumentStoreTestEnv<
    number,
    DirectUploadUpdateOperations
  >(1, {
    id: 'offline-direct-upload-doc',
    storeManager: restartedStoreManager,
    testScenario: 'idle',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        operations: {
          updateValue: {
            inputSchema: rc_object({ value: rc_number }),
            kind: 'update',
            execute: async (ctx) => {
              const file = ctx.uploads.filesById.avatar;
              replayedFiles.push({
                fileName: file?.name,
                fileText: file ? await file.text() : null,
                uploadKeys: Object.keys(ctx.uploads.filesById),
              });
              return ctx.input;
            },
            onSuccessExecute: () => {},
          },
        },
      },
    },
  });
  const restartedHook = renderHook(() =>
    restartedEnv.apiStore.useDocument({ returnRefetchingStatus: true }),
  );
  await flushAllTimers();

  // Rehydration should restore the queued upload before the session is allowed
  // to replay it after reconnecting.
  expect(replayedFiles).toMatchInlineSnapshot(`[]`);
  const restartedQueuedUpload = restartedSession.getOfflineUploads()[0];
  expect(restartedQueuedUpload?.id).toBe(queuedUpload.id);
  if (!restartedQueuedUpload) {
    throw new Error(
      'Expected the restarted session to restore the queued upload',
    );
  }
  expect(pick(restartedQueuedUpload, ['state', 'source']))
    .toMatchInlineSnapshot(`
      source: 'mutation'
      state: 'pending'
    `);
  expect(getOpfsDirTree(mockBrowserOpfs)).toContain(queuedUpload.id);
  expect(getOpfsDirTree(mockBrowserOpfs)).toContain('binary.blob');
  expect(getOpfsDirTree(mockBrowserOpfs)).toContain('metadata.json');
  const persistedMetadata = getParsedOpfsFileData(
    getOfflineUploadOpfsPath(
      'offline-direct-upload-session',
      queuedUpload.id,
      'metadata.json',
    ),
  );
  const persistedMetadataRecord =
    persistedMetadata &&
    typeof persistedMetadata === 'object' &&
    !Array.isArray(persistedMetadata)
      ? Object.fromEntries(Object.entries(persistedMetadata))
      : null;
  expect(
    persistedMetadataRecord &&
      pick(persistedMetadataRecord, ['k', 'l', 'm', 'n', 'o', 't', 'z']),
  ).toMatchInlineSnapshot(`
    k: 'offline-direct-upload-session'
    l: 1
    m: 'text/plain'
    n: 'avatar.txt'
    o: 'mutation'
    t: 'pending'
    z: 18
  `);
  expect(persistedMetadataRecord?.i ?? null).toBe(queuedUpload.id);
  expect(
    getParsedOpfsFileData(
      getOfflineUploadOpfsPath(
        'offline-direct-upload-session',
        queuedUpload.id,
        'binary.blob',
      ),
    ),
  ).toMatchInlineSnapshot(`"direct upload body"`);

  // Reconnect and let the restored queue replay using the original file bytes.
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await flushAllTimers();

  // The replayed mutation should receive the restored File object rather than
  // only the upload id.
  expect(replayedFiles).toMatchInlineSnapshot(`
    - fileName: 'avatar.txt'
      fileText: 'direct upload body'
      uploadKeys: ['avatar']
  `);
  // A successful replay should clear the durable upload entry.
  expect(restartedSession.getOfflineUploads()).toMatchInlineSnapshot(`[]`);
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`"empty"`);
  expect(
    getParsedOpfsFileData(
      getOfflineUploadOpfsPath(
        'offline-direct-upload-session',
        queuedUpload.id,
        'metadata.json',
      ),
    ),
  ).toMatchInlineSnapshot(`null`);
  expect(
    getParsedOpfsFileData(
      getOfflineUploadOpfsPath(
        'offline-direct-upload-session',
        queuedUpload.id,
        'binary.blob',
      ),
    ),
  ).toMatchInlineSnapshot(`null`);

  restartedHook.unmount();
});

test('queued direct uploads keep same logical field names isolated per mutation', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  const sessionKey = 'offline-direct-upload-collision-session';
  const replayedFiles: Array<{ value: number; fileText: string | null }> = [];
  const randomSpy = vi
    .spyOn(Math, 'random')
    .mockReturnValueOnce(0.1)
    .mockReturnValueOnce(0.2)
    .mockReturnValueOnce(0.3)
    .mockReturnValueOnce(0.4)
    .mockReturnValueOnce(0.5)
    .mockReturnValue(0.6);

  try {
    network.setOffline();

    const storeManager = createStoreManager({
      getSessionKey: () => sessionKey,
      errorNormalizer: normalizeError,
      offlineSession: {
        network: network.config,
        uploads: {
          adapter: opfsOfflineUploadAdapter,
          upload: ({ id }) => Promise.resolve(`server:${id}`),
        },
      },
    });
    const session = storeManager;
    session.getOfflineStatus();

    const env = createDocumentStoreTestEnv<
      number,
      DirectUploadUpdateOperations
    >(1, {
      id: 'offline-direct-upload-collision-doc',
      storeManager,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          operations: {
            updateValue: {
              inputSchema: rc_object({ value: rc_number }),
              kind: 'update',
              execute: async (ctx) => {
                replayedFiles.push({
                  value: ctx.input.value,
                  fileText: await (ctx.uploads.filesById.avatar?.text() ??
                    null),
                });
                return ctx.input;
              },
              onSuccessExecute: () => {},
            },
          },
        },
      },
    });

    await flushAllTimers();

    // Queue two offline mutations that reuse the same logical upload key.
    await resolveAfterAllTimers(
      env.apiStore.performMutation({
        optimisticUpdate: () => {},
        mutation: () => Promise.resolve({ value: 2 }),
        offline: { operation: 'updateValue', input: { value: 2 } },
        upload: {
          avatar: new File(['first direct upload'], 'first.txt', {
            type: 'text/plain',
            lastModified: 1,
          }),
        },
      }),
    );
    // Flush mocked OPFS write latency so the first queued upload is durably
    // visible before queueing another mutation that reuses the same field name.
    await flushAllTimers();
    await resolveAfterAllTimers(
      env.apiStore.performMutation({
        optimisticUpdate: () => {},
        mutation: () => Promise.resolve({ value: 3 }),
        offline: { operation: 'updateValue', input: { value: 3 } },
        upload: {
          avatar: new File(['second direct upload'], 'second.txt', {
            type: 'text/plain',
            lastModified: 2,
          }),
        },
      }),
    );
    await flushAllTimers();

    expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`
      "tsdf-uploads (1.56 kb)
      └ offline-direct-upload-collision-session (1.54 kb)
        ├ offline-direct-upload-collision-doc:1735689612000:eeeeeeee:avatar (0.74 kb)
        │ ├ binary.blob (0.06 kb)
        │ └ metadata.json (0.56 kb)
        └ offline-direct-upload-collision-doc:1735689612009:i:avatar (0.72 kb)
          ├ binary.blob (0.06 kb)
          └ metadata.json (0.54 kb)"
    `);

    // Reconnecting should replay each mutation with its own original file.
    await act(async () => {
      network.goOnline();
      await Promise.resolve();
    });
    await flushAllTimers();

    expect(replayedFiles).toMatchInlineSnapshot(`
      - { fileText: 'first direct upload', value: 2 }
      - { fileText: 'second direct upload', value: 3 }
    `);
  } finally {
    randomSpy.mockRestore();
  }
});

test('clearSessionStorage removes registered offline uploads for local-sync sessions too', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  const sessionKey = 'offline-upload-clear-session';

  const session = createStoreManager({
    getSessionKey: () => sessionKey,
    errorNormalizer: normalizeError,
    offlineSession: {
      network: network.config,
      uploads: {
        adapter: opfsOfflineUploadAdapter,
        upload: ({ id }) => Promise.resolve(`server:${id}`),
      },
    },
  });

  await flushAllTimers();
  (
    await resolveAfterAllTimers(
      session.saveOfflineUpload({
        id: 'avatar',
        file: new File(['clear me'], 'clear.txt', {
          type: 'text/plain',
          lastModified: 1,
        }),
      }),
    )
  ).unwrap();

  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`
    "tsdf-uploads (0.46 kb)
    └ offline-upload-clear-session (0.44 kb)
      └ avatar (0.38 kb)
        ├ binary.blob (0.04 kb)
        └ metadata.json (0.33 kb)"
  `);

  // Apps call the generic session clear helper on logout even when uploads
  // were stored separately from the main local-sync persistent state.
  await resolveAfterAllTimers(clearSessionStorage(sessionKey, 'local-sync'));

  resetSessionForTests();

  const restartedSession = createStoreManager({
    getSessionKey: () => sessionKey,
    errorNormalizer: normalizeError,
    offlineSession: {
      network: network.config,
      uploads: {
        adapter: opfsOfflineUploadAdapter,
        upload: ({ id }) => Promise.resolve(`server:${id}`),
      },
    },
  });

  await flushAllTimers();

  expect(restartedSession.getOfflineUploads()).toMatchInlineSnapshot(`[]`);
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`"empty"`);
});

test('uploads named metadata.json still rehydrate their original bytes after restart', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'offline-upload-metadata-filename-session';

  const session = createStoreManager({
    getSessionKey: () => sessionKey,
    errorNormalizer: normalizeError,
    offlineSession: {
      network: network.config,
      uploads: {
        adapter: opfsOfflineUploadAdapter,
        upload: ({ id }) => Promise.resolve(`server:${id}`),
      },
    },
  });

  await flushAllTimers();
  (
    await resolveAfterAllTimers(
      session.saveOfflineUpload({
        id: 'metadata-file',
        file: new File(['real file bytes'], 'metadata.json', {
          type: 'application/json',
          lastModified: 1,
        }),
      }),
    )
  ).unwrap();

  resetSessionForTests();

  const restartedSession = createStoreManager({
    getSessionKey: () => sessionKey,
    errorNormalizer: normalizeError,
    offlineSession: {
      network: network.config,
      uploads: {
        adapter: opfsOfflineUploadAdapter,
        upload: ({ id }) => Promise.resolve(`server:${id}`),
      },
    },
  });

  await flushAllTimers();

  const restoredFile = (
    await resolveAfterAllTimers(
      restartedSession.loadOfflineUpload('metadata-file'),
    )
  ).unwrap();
  expect(restoredFile?.name).toBe('metadata.json');
  expect(await restoredFile?.text()).toBe('real file bytes');
});

type UploadDependencyOperations = {
  updateWithAttachment: DocumentOfflineOperationDefinition<
    { value: number },
    { input: { attachmentId: string; value: number } }
  >;
};

test('replayed mutations wait for pre-upload dependencies and receive the original-to-final ref map', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  const sessionKey = 'offline-upload-dependency-session';
  const replayEvents: string[] = [];

  // Keep the session offline so the manual upload and dependent mutation both
  // queue up first.
  network.setOffline();

  const storeManager = createStoreManager({
    getSessionKey: () => sessionKey,
    errorNormalizer: normalizeError,
    offlineSession: {
      network: network.config,
      uploads: {
        adapter: opfsOfflineUploadAdapter,
        upload: async ({ id, file, onProgress }) => {
          replayEvents.push(`upload-start:${id}:${file.name}`);
          onProgress({ progress: 0.5 });
          await new Promise((resolve) => setTimeout(resolve, 20));
          onProgress({ progress: 1 });
          replayEvents.push(`upload-finish:${id}`);
          return `server:${id}`;
        },
      },
    },
  });
  const session = storeManager;

  const env = createDocumentStoreTestEnv<number, UploadDependencyOperations>(
    1,
    {
      id: 'offline-upload-dependency-doc',
      storeManager,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          operations: {
            updateWithAttachment: {
              inputSchema: rc_object({
                attachmentId: rc_string,
                value: rc_number,
              }),
              kind: 'update',
              dependsOnUploads: ({ input }) => [input.attachmentId],
              execute: async (ctx) => {
                const resolvedRef =
                  ctx.uploads.resolvedRefsById[ctx.input.attachmentId];
                replayEvents.push(
                  `execute:${ctx.input.attachmentId}:${
                    typeof resolvedRef === 'string'
                      ? resolvedRef
                      : JSON.stringify(resolvedRef)
                  }`,
                );
                await env.serverMock.delayedSetData(ctx.input.value);
                return { value: ctx.input.value };
              },
              onSuccessExecute: ({ input }) => {
                env.apiStore.updateState((draft) => {
                  draft.value = input.value;
                });
              },
            },
          },
        },
      },
    },
  );

  const uploadHook = renderHook(() => session.useOfflineUploads());
  await flushAllTimers();

  // Save the upload first; the mutation will refer to this offline upload id.
  (
    await resolveAfterAllTimers(
      session.saveOfflineUpload({
        id: 'asset-1',
        file: new File(['dependency body'], 'dependency.txt', {
          type: 'text/plain',
          lastModified: 1,
        }),
      }),
    )
  ).unwrap();

  // Queue the mutation that depends on the upload resolving to a final ref.
  await resolveAfterAllTimers(
    env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value = 3;
        });
      },
      mutation: () => Promise.resolve({ value: 3 }),
      offline: {
        operation: 'updateWithAttachment',
        input: { attachmentId: 'asset-1', value: 3 },
      },
    }),
  );

  expect(
    uploadHook.result.current.map((upload) =>
      pick(upload, ['id', 'state', 'source']),
    ),
  ).toMatchInlineSnapshot(`
    - { id: 'asset-1', source: 'manual', state: 'pending' }
  `);
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`
    "tsdf-uploads (0.51 kb)
    └ offline-upload-dependency-session (0.48 kb)
      └ asset-1 (0.42 kb)
        ├ binary.blob (0.05 kb)
        └ metadata.json (0.36 kb)"
  `);
  expect(
    getParsedOpfsFileData(
      'tsdf-uploads/offline-upload-dependency-session/asset-1/metadata.json',
    ),
  ).toMatchInlineSnapshot(`
    c: 1735689612000
    i: 'asset-1'
    k: 'offline-upload-dependency-session'
    l: 1
    m: 'text/plain'
    n: 'dependency.txt'
    o: 'manual'
    t: 'pending'
    u: 1735689612000
    z: 15
  `);
  expect(
    getParsedOpfsFileData(
      'tsdf-uploads/offline-upload-dependency-session/asset-1/binary.blob',
    ),
  ).toMatchInlineSnapshot(`"dependency body"`);

  // Nothing should replay yet because the session is still offline.
  expect(replayEvents).toMatchInlineSnapshot(`[]`);

  // Reconnect so the upload resolves before the mutation executes.
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await flushAllTimers();
  await act(async () => {
    await Promise.resolve();
  });
  await flushAllTimers();

  // The mutation should execute only after the upload finishes, and it should
  // receive the rewritten server ref instead of the original offline id.
  expect(replayEvents).toMatchInlineSnapshot(`
    - 'upload-start:asset-1:dependency.txt'
    - 'upload-finish:asset-1'
    - 'execute:asset-1:server:asset-1'
  `);
  expect(uploadHook.result.current).toMatchInlineSnapshot(`[]`);
  expect(
    getParsedOpfsFileData(
      'tsdf-uploads/offline-upload-dependency-session/asset-1/metadata.json',
    ),
  ).toMatchInlineSnapshot(`null`);

  uploadHook.unmount();
});

test('replacing the attachment of a queued offline edit uploads and sends the new attachment', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'offline-accumulated-upload-dependency-session';
  const replayEvents: string[] = [];

  network.setOffline();

  const storeManager = createStoreManager({
    getSessionKey: () => sessionKey,
    errorNormalizer: normalizeError,
    offlineSession: {
      network: network.config,
      uploads: {
        adapter: opfsOfflineUploadAdapter,
        upload: async ({ id }) => {
          replayEvents.push(`upload:${id}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
          return `server:${id}`;
        },
      },
    },
  });

  const env = createDocumentStoreTestEnv<number, UploadDependencyOperations>(
    1,
    {
      id: 'offline-accumulated-upload-dependency-doc',
      storeManager,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          operations: {
            updateWithAttachment: {
              inputSchema: rc_object({
                attachmentId: rc_string,
                value: rc_number,
              }),
              kind: 'update',
              dependsOnUploads: ({ input }) => [input.attachmentId],
              // The latest edit wins: both the value and the attachment
              accumulation: {
                mergeInput: ({ incomingInput }) => incomingInput,
              },
              execute: async (ctx) => {
                const resolvedRef =
                  ctx.uploads.resolvedRefsById[ctx.input.attachmentId];
                replayEvents.push(
                  `execute:${ctx.input.attachmentId}:${JSON.stringify(resolvedRef)}`,
                );
                await env.serverMock.delayedSetData(ctx.input.value);
                return { value: ctx.input.value };
              },
            },
          },
        },
      },
    },
  );
  await flushAllTimers();

  async function saveAttachment(id: string) {
    (
      await resolveAfterAllTimers(
        storeManager.saveOfflineUpload({
          id,
          file: new File([`${id} body`], `${id}.txt`, {
            type: 'text/plain',
            lastModified: 1,
          }),
        }),
      )
    ).unwrap();
  }

  async function editWithAttachment(attachmentId: string, value: number) {
    await resolveAfterAllTimers(
      env.apiStore.performMutation({
        optimisticUpdate: () => {
          env.apiStore.updateState(() => ({ value }));
        },
        mutation: () => Promise.resolve({ value }),
        offline: {
          operation: 'updateWithAttachment',
          input: { attachmentId, value },
        },
      }),
    );
  }

  // Offline, the user attaches a file, then changes their mind and attaches
  // another one: the second edit is merged into the queued first one.
  await saveAttachment('photo-1');
  await editWithAttachment('photo-1', 2);
  await saveAttachment('photo-2');
  await editWithAttachment('photo-2', 3);

  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await flushAllTimers();

  // The replay uploads the attachment the merged edit references and sends
  // its server ref, not the one of the replaced attachment.
  expect(replayEvents).toMatchInlineSnapshot(
    `['upload:photo-2', 'execute:photo-2:"server:photo-2"']`,
  );
  expect(env.serverMock.current).toMatchInlineSnapshot(`3`);
});

test('online mutations can resolve staged upload ids after reconnect and use the final refs in the direct request', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'online-staged-upload-session';
  const requestEvents: string[] = [];

  network.setOffline();

  const storeManager = createStoreManager({
    getSessionKey: () => sessionKey,
    errorNormalizer: normalizeError,
    offlineSession: {
      network: network.config,
      uploads: {
        adapter: opfsOfflineUploadAdapter,
        upload: async ({ id, file, onProgress }) => {
          requestEvents.push(`upload-start:${id}:${file.name}`);
          onProgress({ progress: 0.5 });
          await new Promise((resolve) => setTimeout(resolve, 20));
          onProgress({ progress: 1 });
          requestEvents.push(`upload-finish:${id}`);
          return `server:${id}`;
        },
      },
    },
  });
  const session = storeManager;

  const env = createDocumentStoreTestEnv<number, UploadDependencyOperations>(
    1,
    {
      id: 'online-staged-upload-doc',
      storeManager,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          operations: {
            updateWithAttachment: {
              inputSchema: rc_object({
                attachmentId: rc_string,
                value: rc_number,
              }),
              kind: 'update',
              dependsOnUploads: ({ input }) => [input.attachmentId],
              execute: async (ctx) => {
                await env.serverMock.delayedSetData(ctx.input.value);
                return { value: ctx.input.value };
              },
              onSuccessExecute: ({ input }) => {
                env.apiStore.updateState((draft) => {
                  draft.value = input.value;
                });
              },
            },
          },
        },
      },
    },
  );

  await flushAllTimers();

  (
    await resolveAfterAllTimers(
      session.saveOfflineUpload({
        id: 'asset-1',
        file: new File(['online dependency body'], 'online-dependency.txt', {
          type: 'text/plain',
          lastModified: 1,
        }),
      }),
    )
  ).unwrap();

  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await advanceTime(0);

  const result = await resolveAfterAllTimers(
    env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value = 4;
        });
      },
      mutation: async () => {
        const resolvedRef: `server:${string}` = (
          await resolveAfterAllTimers(session.resolveOfflineUpload('asset-1'))
        ).unwrap();
        requestEvents.push(`mutation:${resolvedRef}`);
        await env.serverMock.delayedSetData(4);
        return { value: 4, resolvedRef };
      },
      offline: {
        operation: 'updateWithAttachment',
        input: { attachmentId: 'asset-1', value: 4 },
      },
    }),
  );

  expect({ ok: result.ok, value: result.ok ? result.value : null })
    .toMatchInlineSnapshot(`
      ok: '✅'

      value:
        data: { resolvedRef: 'server:asset-1', value: 4 }
        kind: 'online'
    `);
  expect(requestEvents).toMatchInlineSnapshot(`
    - 'upload-start:asset-1:online-dependency.txt'
    - 'upload-finish:asset-1'
    - 'mutation:server:asset-1'
  `);
  expect(
    session
      .getOfflineUploads()
      .map((upload) => pick(upload, ['id', 'state', 'resolvedRef', 'source'])),
  ).toMatchInlineSnapshot(`
    - id: 'asset-1'
      resolvedRef: 'server:asset-1'
      source: 'manual'
      state: 'uploaded'
  `);
});

test('upload metadata is exposed by the upload status APIs and handed to the transport when a queued mutation replays its upload dependency', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'offline-upload-metadata-replay-session';
  const replayEvents: Array<Record<string, unknown>> = [];

  // Start offline so the staged upload and its dependent mutation both queue.
  network.setOffline();

  const storeManager = createStoreManager({
    getSessionKey: () => sessionKey,
    errorNormalizer: normalizeError,
    offlineSession: {
      network: network.config,
      uploads: {
        adapter: opfsOfflineUploadAdapter,
        // One session transport serves every upload, so it depends on the
        // per-upload metadata to know which request parameters to use.
        upload: async ({ id, file, metadata }) => {
          replayEvents.push({ transport: id, fileName: file.name, metadata });
          await new Promise((resolve) => setTimeout(resolve, 20));
          return `server:${id}`;
        },
      },
    },
  });

  const env = createDocumentStoreTestEnv<number, UploadDependencyOperations>(
    1,
    {
      id: 'offline-upload-metadata-replay-doc',
      storeManager,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          operations: {
            updateWithAttachment: {
              inputSchema: rc_object({
                attachmentId: rc_string,
                value: rc_number,
              }),
              kind: 'update',
              dependsOnUploads: ({ input }) => [input.attachmentId],
              execute: async (ctx) => {
                replayEvents.push({
                  execute: ctx.uploads.resolvedRefsById[ctx.input.attachmentId],
                });
                await env.serverMock.delayedSetData(ctx.input.value);
                return { value: ctx.input.value };
              },
              onSuccessExecute: ({ input }) => {
                env.apiStore.updateState((draft) => {
                  draft.value = input.value;
                });
              },
            },
          },
        },
      },
    },
  );

  const uploadHook = renderHook(() => storeManager.useOfflineUploads());
  await flushAllTimers();

  // Stage the file together with the request parameters its upload will need.
  (
    await resolveAfterAllTimers(
      storeManager.saveOfflineUpload({
        id: 'asset-1',
        file: new File(['chat attachment'], 'photo.png', {
          type: 'image/png',
          lastModified: 1,
        }),
        metadata: { kind: 'chat', chatId: 'chat-42' },
      }),
    )
  ).unwrap();

  // Both the hook and the imperative getter expose the metadata, so UI can
  // describe a pending upload without decoding anything from its id.
  expect(
    uploadHook.result.current.map((upload) =>
      pick(upload, ['id', 'state', 'metadata']),
    ),
  ).toMatchInlineSnapshot(`
    - id: 'asset-1'
      metadata: { chatId: 'chat-42', kind: 'chat' }
      state: 'pending'
  `);
  expect(
    storeManager
      .getOfflineUploads()
      .map((upload) => pick(upload, ['id', 'state', 'metadata'])),
  ).toMatchInlineSnapshot(`
    - id: 'asset-1'
      metadata: { chatId: 'chat-42', kind: 'chat' }
      state: 'pending'
  `);

  // The metadata is stored next to the rest of the upload record (key `d`).
  expect(
    getParsedOpfsFileData(
      'tsdf-uploads/offline-upload-metadata-replay-session/asset-1/metadata.json',
    ),
  ).toMatchInlineSnapshot(`
    c: 1735689612000
    d: { chatId: 'chat-42', kind: 'chat' }
    i: 'asset-1'
    k: 'offline-upload-metadata-replay-session'
    l: 1
    m: 'image/png'
    n: 'photo.png'
    o: 'manual'
    t: 'pending'
    u: 1735689612000
    z: 15
  `);

  // Queue the mutation that depends on the staged upload.
  await resolveAfterAllTimers(
    env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value = 3;
        });
      },
      mutation: () => Promise.resolve({ value: 3 }),
      offline: {
        operation: 'updateWithAttachment',
        input: { attachmentId: 'asset-1', value: 3 },
      },
    }),
  );

  // Nothing is uploaded while the session is still offline.
  expect(replayEvents).toMatchInlineSnapshot(`[]`);

  // Reconnect so replay uploads the dependency before executing the mutation.
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await flushAllTimers();
  await act(async () => {
    await Promise.resolve();
  });
  await flushAllTimers();

  // The transport receives the metadata saved with the file, and the mutation
  // then executes with the ref that upload resolved to.
  expect(replayEvents).toMatchInlineSnapshot(`
    - fileName: 'photo.png'
      metadata: { chatId: 'chat-42', kind: 'chat' }
      transport: 'asset-1'
    - execute: 'server:asset-1'
  `);

  uploadHook.unmount();
});

test('upload metadata survives an app restart and reaches the transport when uploads are resolved online, while uploads staged without metadata keep working', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'offline-upload-metadata-restart-session';
  const transportCalls: Array<Record<string, unknown>> = [];

  function createUploadManager() {
    return createStoreManager({
      getSessionKey: () => sessionKey,
      errorNormalizer: normalizeError,
      offlineSession: {
        network: network.config,
        uploads: {
          adapter: opfsOfflineUploadAdapter,
          upload: ({ id, file, metadata }) => {
            transportCalls.push({ id, fileName: file.name, metadata });
            return Promise.resolve(`server:${id}`);
          },
        },
      },
    });
  }

  // Stage every file while offline, so nothing can be uploaded before the
  // restart.
  network.setOffline();
  const firstSession = createUploadManager();
  await flushAllTimers();

  // Two uploads need different request parameters from the same transport...
  (
    await resolveAfterAllTimers(
      firstSession.saveOfflineUpload({
        id: 'chat-file',
        file: new File(['chat attachment'], 'photo.png', {
          type: 'image/png',
          lastModified: 1,
        }),
        metadata: { kind: 'chat', chatId: 'chat-42' },
      }),
    )
  ).unwrap();
  (
    await resolveAfterAllTimers(
      firstSession.saveOfflineUpload({
        id: 'record-file',
        file: new File(['record attachment'], 'invoice.pdf', {
          type: 'application/pdf',
          lastModified: 1,
        }),
        metadata: { kind: 'record', tableId: 'table-7', fieldId: 'files' },
      }),
    )
  ).unwrap();
  // ...and one is staged without metadata.
  (
    await resolveAfterAllTimers(
      firstSession.saveOfflineUpload({
        id: 'plain-file',
        file: new File(['plain attachment'], 'notes.txt', {
          type: 'text/plain',
          lastModified: 1,
        }),
      }),
    )
  ).unwrap();

  // An upload without metadata is persisted without the metadata key (`d`),
  // which is exactly the record shape written before metadata existed. Loading
  // it below therefore also covers records persisted by older versions.
  expect(
    getParsedOpfsFileData(
      'tsdf-uploads/offline-upload-metadata-restart-session/plain-file/metadata.json',
    ),
  ).toMatchInlineSnapshot(`
    c: 1735689612000
    i: 'plain-file'
    k: 'offline-upload-metadata-restart-session'
    l: 1
    m: 'text/plain'
    n: 'notes.txt'
    o: 'manual'
    t: 'pending'
    u: 1735689612000
    z: 16
  `);

  // Simulate a full app restart: the uploads must come back from storage.
  resetSessionForTests();
  const restartedSession = createUploadManager();
  const restartedUploadsHook = renderHook(() =>
    restartedSession.useOfflineUploads(),
  );
  await flushAllTimers();

  // The restored uploads expose the same metadata they were saved with.
  expect(
    restartedUploadsHook.result.current.map((upload) =>
      pick(upload, ['id', 'state', 'metadata']),
    ),
  ).toMatchInlineSnapshot(`
    - id: 'chat-file'
      metadata: { chatId: 'chat-42', kind: 'chat' }
      state: 'pending'
    - { id: 'plain-file', state: 'pending' }
    - id: 'record-file'
      metadata: { fieldId: 'files', kind: 'record', tableId: 'table-7' }
      state: 'pending'
  `);
  expect(transportCalls).toMatchInlineSnapshot(`[]`);

  // Back online, the app resolves the staged uploads directly.
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await advanceTime(0);

  const chatRef = (
    await resolveAfterAllTimers(
      restartedSession.resolveOfflineUpload('chat-file'),
    )
  ).unwrap();
  const otherRefs = (
    await resolveAfterAllTimers(
      restartedSession.resolveOfflineUploads(['record-file', 'plain-file']),
    )
  ).unwrap();

  expect({ chatRef, otherRefs }).toMatchInlineSnapshot(`
    chatRef: 'server:chat-file'
    otherRefs: { plain-file: 'server:plain-file', record-file: 'server:record-file' }
  `);

  // Each transport call gets the restored metadata of its own upload, for
  // both the single and the batch resolve APIs. The upload staged without
  // metadata is still uploaded and simply receives no metadata.
  expect(transportCalls).toMatchInlineSnapshot(`
    - fileName: 'photo.png'
      id: 'chat-file'
      metadata: { chatId: 'chat-42', kind: 'chat' }
    - fileName: 'invoice.pdf'
      id: 'record-file'
      metadata: { fieldId: 'files', kind: 'record', tableId: 'table-7' }
    - { fileName: 'notes.txt', id: 'plain-file' }
  `);

  // Finishing the upload keeps the metadata on the upload status entry.
  expect(
    restartedUploadsHook.result.current.map((upload) =>
      pick(upload, ['id', 'state', 'metadata']),
    ),
  ).toMatchInlineSnapshot(`
    - id: 'chat-file'
      metadata: { chatId: 'chat-42', kind: 'chat' }
      state: 'uploaded'
    - { id: 'plain-file', state: 'uploaded' }
    - id: 'record-file'
      metadata: { fieldId: 'files', kind: 'record', tableId: 'table-7' }
      state: 'uploaded'
  `);

  restartedUploadsHook.unmount();
});

test('replacing a staged upload keeps its metadata unless new metadata is provided', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'offline-upload-metadata-replace-session';
  const transportCalls: Array<Record<string, unknown>> = [];
  const uploadChanges = createLoggerStore();

  network.setOffline();

  const storeManager = createStoreManager({
    getSessionKey: () => sessionKey,
    errorNormalizer: normalizeError,
    offlineSession: {
      network: network.config,
      uploads: {
        adapter: opfsOfflineUploadAdapter,
        upload: async ({ id, file, metadata }) => {
          transportCalls.push({
            id,
            fileName: file.name,
            fileText: await file.text(),
            metadata,
          });
          return `server:${id}`;
        },
      },
    },
  });
  const uploadHook = renderHook(() => {
    const upload = storeManager.useOfflineUploads()[0];

    uploadChanges.add(
      upload
        ? pick(upload, ['fileName', 'metadata', 'state'])
        : { state: 'no-upload' },
    );
  });
  await flushAllTimers();
  uploadChanges.reset();

  uploadChanges.addMark('stage the upload with metadata');
  (
    await resolveAfterAllTimers(
      storeManager.saveOfflineUpload({
        id: 'attachment',
        file: new File(['first draft'], 'draft.txt', {
          type: 'text/plain',
          lastModified: 1,
        }),
        metadata: { kind: 'record', tableId: 'table-7' },
      }),
    )
  ).unwrap();

  // The user picks another file for the same attachment: only the file is
  // replaced, the upload still targets the same record.
  uploadChanges.addMark('replace only the file');
  (
    await resolveAfterAllTimers(
      storeManager.replaceOfflineUpload({
        id: 'attachment',
        file: new File(['final version'], 'final.txt', {
          type: 'text/plain',
          lastModified: 2,
        }),
      }),
    )
  ).unwrap();

  // The attachment is moved to another record, so the replacement provides
  // new metadata.
  uploadChanges.addMark('replace the file and its metadata');
  (
    await resolveAfterAllTimers(
      storeManager.replaceOfflineUpload({
        id: 'attachment',
        file: new File(['moved version'], 'moved.txt', {
          type: 'text/plain',
          lastModified: 3,
        }),
        metadata: { kind: 'record', tableId: 'table-9' },
      }),
    )
  ).unwrap();

  expect(uploadChanges.changesSnapshot).toMatchInlineSnapshot(`
    "

    >>> stage the upload with metadata

    -> fileName: draft.txt ⋅ metadata: {kind:record, tableId:table-7} ⋅ state: pending

    >>> replace only the file

    -> fileName: final.txt ⋅ metadata: {kind:record, tableId:table-7} ⋅ state: pending

    >>> replace the file and its metadata

    -> fileName: moved.txt ⋅ metadata: {kind:record, tableId:table-9} ⋅ state: pending
    "
  `);

  // The persisted record carries the latest file name and metadata.
  expect(
    getParsedOpfsFileData(
      'tsdf-uploads/offline-upload-metadata-replace-session/attachment/metadata.json',
    ),
  ).toMatchInlineSnapshot(`
    c: 1735689612000
    d: { kind: 'record', tableId: 'table-9' }
    i: 'attachment'
    k: 'offline-upload-metadata-replace-session'
    l: 3
    m: 'text/plain'
    n: 'moved.txt'
    o: 'manual'
    t: 'pending'
    u: 1735689612018
    z: 13
  `);

  // Uploading after the replacements sends the latest file with the latest
  // metadata.
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await advanceTime(0);
  (
    await resolveAfterAllTimers(storeManager.resolveOfflineUpload('attachment'))
  ).unwrap();

  expect(transportCalls).toMatchInlineSnapshot(`
    - fileName: 'moved.txt'
      fileText: 'moved version'
      id: 'attachment'
      metadata: { kind: 'record', tableId: 'table-9' }
  `);

  uploadHook.unmount();
});

/**
 * Wraps the OPFS upload adapter to record every read the session performs, so
 * tests can assert how many times staged files are read from storage.
 */
function createReadTrackingUploadAdapter() {
  const reads: string[] = [];
  let nextLoadError: Error | null = null;

  const adapter: OfflineUploadAdapter = {
    save: (sessionKey, id, record) =>
      opfsOfflineUploadAdapter.save(sessionKey, id, record),
    load: <TResolvedRef extends ValidPayload>(
      sessionKey: string,
      id: string,
    ) => {
      reads.push(`load:${id}`);
      if (nextLoadError) {
        const error = nextLoadError;
        nextLoadError = null;
        return Promise.reject(error);
      }
      return opfsOfflineUploadAdapter.load<TResolvedRef>(sessionKey, id);
    },
    list: <TResolvedRef extends ValidPayload>(sessionKey: string) => {
      reads.push('list');
      return opfsOfflineUploadAdapter.list<TResolvedRef>(sessionKey);
    },
    remove: (sessionKey, id) => opfsOfflineUploadAdapter.remove(sessionKey, id),
    clearSession: (sessionKey) =>
      opfsOfflineUploadAdapter.clearSession(sessionKey),
  };

  return {
    adapter,
    reads,
    failNextLoad(error: Error) {
      nextLoadError = error;
    },
  };
}

/**
 * Replaces the browser object-URL registry with a deterministic one that logs
 * every created and revoked URL, so tests can assert URL lifetimes.
 */
function trackObjectUrls() {
  const events: string[] = [];
  const liveUrls = new Set<string>();
  let createdCount = 0;

  const createSpy = vi
    .spyOn(URL, 'createObjectURL')
    .mockImplementation((source) => {
      createdCount += 1;
      const url = `blob:staged-${createdCount}`;
      liveUrls.add(url);
      events.push(
        `create ${url} (${source instanceof File ? source.name : 'blob'})`,
      );
      return url;
    });
  const revokeSpy = vi
    .spyOn(URL, 'revokeObjectURL')
    .mockImplementation((url) => {
      liveUrls.delete(url);
      events.push(`revoke ${url}`);
    });

  onTestFinished(() => {
    createSpy.mockRestore();
    revokeSpy.mockRestore();
  });

  return { events, getLiveUrls: () => [...liveUrls] };
}

function createUploadFileTestManager(
  getSessionKey: () => string | false,
  adapter: OfflineUploadAdapter = opfsOfflineUploadAdapter,
) {
  return createStoreManager({
    getSessionKey,
    errorNormalizer: normalizeError,
    offlineSession: {
      network: network.config,
      uploads: {
        adapter,
        upload: async ({ id }) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return `server:${id}`;
        },
      },
    },
  });
}

/**
 * Creates the manager and lets its offline session finish starting up, as it
 * has in a running app by the time the user picks a file.
 */
async function startUploadFileTestSession(
  getSessionKey: () => string | false,
  adapter?: OfflineUploadAdapter,
) {
  const storeManager = createUploadFileTestManager(getSessionKey, adapter);
  storeManager.getOfflineStatus();
  await flushAllTimers();

  return storeManager;
}

function createImageFile(name: string, body: string): File {
  return new File([body], name, { type: 'image/png', lastModified: 1 });
}

/** Compact, log-friendly view of what `useOfflineUploadFile` returned. */
function describeStagedFile(staged: OfflineUploadFile) {
  return {
    status: staged.status,
    url: staged.url,
    fileName: staged.file?.name ?? null,
    ...(staged.error ? { error: staged.error.message } : {}),
  };
}

test('a staged file can be rendered again after an app reload, and components showing it share one storage read and one object URL', async () => {
  createMockBrowserOpfs();
  const objectUrls = trackObjectUrls();
  const storage = createReadTrackingUploadAdapter();
  const sessionKey = 'offline-upload-file-reload-session';
  const renders = createLoggerStore();

  // Stage the file while offline, so it stays staged until the "reload".
  network.setOffline();
  const firstSession = await startUploadFileTestSession(
    () => sessionKey,
    storage.adapter,
  );
  (
    await resolveAfterAllTimers(
      firstSession.saveOfflineUpload({
        id: 'photo-1',
        file: createImageFile('photo.png', 'photo bytes'),
      }),
    )
  ).unwrap();

  // Simulate a full app reload: every object URL the app created before is
  // dead, so the file has to come back from storage.
  resetSessionForTests();
  storage.reads.length = 0;
  const reloadedSession = createUploadFileTestManager(
    () => sessionKey,
    storage.adapter,
  );

  // The same staged file is rendered by two components (e.g. a chat message
  // thumbnail and a record file field), mounted right after the reload.
  function Thumbnail({ name }: { name: string }) {
    const staged = reloadedSession.useOfflineUploadFile('photo-1');

    renders.add({ component: name, ...describeStagedFile(staged) });

    return staged.url ? (
      <img
        alt={name}
        src={staged.url}
      />
    ) : null;
  }

  renders.addMark('mount both components right after the reload');
  const view = render(
    <>
      <Thumbnail name="chat" />
      <Thumbnail name="record" />
    </>,
  );
  await flushAllTimers();

  // Both components go from loading to the same managed object URL.
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "

    >>> mount both components right after the reload

    -> component: chat ⋅ status: loading ⋅ url: null ⋅ fileName: null
    -> component: record ⋅ status: loading ⋅ url: null ⋅ fileName: null
    -> component: chat ⋅ status: success ⋅ url: blob:staged-1 ⋅ fileName: photo.png
    -> component: record ⋅ status: success ⋅ url: blob:staged-1 ⋅ fileName: photo.png
    "
  `);
  expect(
    view.container.innerHTML,
    'both components render the shared object URL',
  ).toMatchInlineSnapshot(
    `"<img alt="chat" src="blob:staged-1"><img alt="record" src="blob:staged-1">"`,
  );

  // The session lists its staged uploads once on startup; the hook adds no
  // per-component (or per-id) read on top of it.
  expect(storage.reads).toMatchInlineSnapshot(`['list']`);
  // One object URL is created for the staged file, not one per component.
  expect(objectUrls.events).toMatchInlineSnapshot(
    `['create blob:staged-1 (photo.png)']`,
  );

  // A third consumer mounting later reuses the already loaded file: it gets
  // the URL on its first render, with no loading state and no storage read.
  renders.reset();
  renders.addMark('mount a late consumer');
  const lateHook = renderHook(() => {
    const staged = reloadedSession.useOfflineUploadFile('photo-1');

    renders.add({ component: 'late', ...describeStagedFile(staged) });

    return staged;
  });
  await flushAllTimers();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "

    >>> mount a late consumer

    -> component: late ⋅ status: success ⋅ url: blob:staged-1 ⋅ fileName: photo.png
    "
  `);
  // The restored file carries the original bytes.
  expect(await lateHook.result.current.file?.text()).toBe('photo bytes');
  expect(storage.reads).toMatchInlineSnapshot(`['list']`);

  // The URL stays alive while at least one consumer is mounted...
  view.unmount();
  await flushAllTimers();
  expect(objectUrls.getLiveUrls()).toMatchInlineSnapshot(`['blob:staged-1']`);

  // ...and is revoked shortly after the last consumer unmounts.
  lateHook.unmount();
  await advanceTime(1_000);
  expect(objectUrls.events).toMatchInlineSnapshot(
    `['create blob:staged-1 (photo.png)', 'revoke blob:staged-1']`,
  );
  expect(objectUrls.getLiveUrls()).toMatchInlineSnapshot(`[]`);
});

test('components mounted before their file is staged share a single storage lookup and pick the file up once it is staged, without leaking URLs under StrictMode', async () => {
  createMockBrowserOpfs();
  const objectUrls = trackObjectUrls();
  const storage = createReadTrackingUploadAdapter();
  const renders = createLoggerStore();

  network.setOffline();
  const storeManager = await startUploadFileTestSession(
    () => 'offline-upload-file-strict-mode-session',
    storage.adapter,
  );
  storage.reads.length = 0;

  function Thumbnail({ name }: { name: string }) {
    const staged = storeManager.useOfflineUploadFile('photo-1');

    renders.add({ component: name, ...describeStagedFile(staged) });

    return null;
  }

  // The optimistic entity update is synchronous while staging the file is
  // async, so components can ask for an upload id that is not staged yet.
  // StrictMode mounts, unmounts and remounts every effect.
  renders.addMark('mount before the file is staged');
  const view = render(
    <StrictMode>
      <Thumbnail name="chat" />
      <Thumbnail name="record" />
    </StrictMode>,
  );
  await flushAllTimers();

  // Two components and StrictMode's doubled effects still cause exactly one
  // storage lookup for the id.
  expect(storage.reads).toMatchInlineSnapshot(`['load:photo-1']`);
  expect(objectUrls.events).toMatchInlineSnapshot(`[]`);

  renders.addMark('stage the file');
  (
    await resolveAfterAllTimers(
      storeManager.saveOfflineUpload({
        id: 'photo-1',
        file: createImageFile('photo.png', 'photo bytes'),
      }),
    )
  ).unwrap();

  // Both components report the file as missing first and switch to the shared
  // URL as soon as it is staged.
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "

    >>> mount before the file is staged

    -> component: chat ⋅ status: loading ⋅ url: null ⋅ fileName: null
    -> component: record ⋅ status: loading ⋅ url: null ⋅ fileName: null
    -> component: chat ⋅ status: missing ⋅ url: null ⋅ fileName: null
    -> component: record ⋅ status: missing ⋅ url: null ⋅ fileName: null

    >>> stage the file

    -> component: chat ⋅ status: success ⋅ url: blob:staged-1 ⋅ fileName: photo.png
    -> component: record ⋅ status: success ⋅ url: blob:staged-1 ⋅ fileName: photo.png
    "
  `);
  // Staging does not trigger any extra storage read.
  expect(storage.reads).toMatchInlineSnapshot(`['load:photo-1']`);

  view.unmount();
  await flushAllTimers();

  // Exactly one URL was created, and it was revoked on unmount: StrictMode's
  // extra mount/unmount cycle neither duplicates nor leaks it.
  expect(objectUrls.events).toMatchInlineSnapshot(
    `['create blob:staged-1 (photo.png)', 'revoke blob:staged-1']`,
  );
  expect(objectUrls.getLiveUrls()).toMatchInlineSnapshot(`[]`);
});

test('replacing a staged file hands the new file to every consumer and revokes the previous URL', async () => {
  createMockBrowserOpfs();
  const objectUrls = trackObjectUrls();
  const renders = createLoggerStore();

  network.setOffline();
  const storeManager = await startUploadFileTestSession(
    () => 'offline-upload-file-replace-session',
  );
  (
    await resolveAfterAllTimers(
      storeManager.saveOfflineUpload({
        id: 'attachment',
        file: createImageFile('draft.png', 'draft bytes'),
      }),
    )
  ).unwrap();

  const fileHook = renderHook(() => {
    const first = storeManager.useOfflineUploadFile('attachment');
    const second = storeManager.useOfflineUploadFile('attachment');

    renders.add({
      first: `${first.status} ${first.url} ${first.file?.name}`,
      second: `${second.status} ${second.url} ${second.file?.name}`,
    });

    return first;
  });
  await flushAllTimers();
  expect(await fileHook.result.current.file?.text()).toBe('draft bytes');

  // The user picks another file for the same attachment.
  renders.addMark('replace the staged file');
  (
    await resolveAfterAllTimers(
      storeManager.replaceOfflineUpload({
        id: 'attachment',
        file: createImageFile('final.png', 'final bytes'),
      }),
    )
  ).unwrap();

  // Both consumers move to a URL of the new file, never through a missing or
  // loading state.
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> first: success blob:staged-1 draft.png ⋅ second: success blob:staged-1 draft.png

    >>> replace the staged file

    -> first: success blob:staged-2 final.png ⋅ second: success blob:staged-2 final.png
    "
  `);
  expect(await fileHook.result.current.file?.text()).toBe('final bytes');
  // The URL of the replaced file is revoked; only the new one stays alive.
  expect(objectUrls.events).toMatchInlineSnapshot(`
    - 'create blob:staged-1 (draft.png)'
    - 'create blob:staged-2 (final.png)'
    - 'revoke blob:staged-1'
  `);
  expect(objectUrls.getLiveUrls()).toMatchInlineSnapshot(`['blob:staged-2']`);

  fileHook.unmount();
});

test('deleting a staged upload clears the file for its consumers and revokes its URL', async () => {
  createMockBrowserOpfs();
  const objectUrls = trackObjectUrls();
  const renders = createLoggerStore();

  network.setOffline();
  const storeManager = await startUploadFileTestSession(
    () => 'offline-upload-file-delete-session',
  );
  (
    await resolveAfterAllTimers(
      storeManager.saveOfflineUpload({
        id: 'attachment',
        file: createImageFile('photo.png', 'photo bytes'),
      }),
    )
  ).unwrap();

  const fileHook = renderHook(() => {
    const staged = storeManager.useOfflineUploadFile('attachment');

    renders.add(describeStagedFile(staged));

    return staged;
  });
  await flushAllTimers();

  // The user removes the attachment before it was ever uploaded.
  renders.addMark('delete the staged upload');
  (
    await resolveAfterAllTimers(storeManager.deleteOfflineUpload('attachment'))
  ).unwrap();

  // The URL of the deleted file is revoked right away.
  expect(objectUrls.getLiveUrls()).toMatchInlineSnapshot(`[]`);

  // Staging the same id again makes the file available again: `missing` is
  // not a terminal state.
  renders.addMark('stage the same id again');
  (
    await resolveAfterAllTimers(
      storeManager.saveOfflineUpload({
        id: 'attachment',
        file: createImageFile('retake.png', 'retake bytes'),
      }),
    )
  ).unwrap();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: success ⋅ url: blob:staged-1 ⋅ fileName: photo.png

    >>> delete the staged upload

    -> status: missing ⋅ url: null ⋅ fileName: null

    >>> stage the same id again

    -> status: success ⋅ url: blob:staged-2 ⋅ fileName: retake.png
    "
  `);
  expect(objectUrls.events).toMatchInlineSnapshot(`
    - 'create blob:staged-1 (photo.png)'
    - 'revoke blob:staged-1'
    - 'create blob:staged-2 (retake.png)'
  `);

  fileHook.unmount();
});

type AvatarUploadOperations = {
  setAvatar: DocumentOfflineOperationDefinition<
    { value: string },
    { input: { uploadId: string }; result: { value: string } }
  >;
};

test('a staged file stays renderable until its queued mutation swaps the entity to the uploaded server ref, with no missing state in between', async () => {
  createMockBrowserOpfs();
  const objectUrls = trackObjectUrls();
  const renders = createLoggerStore();

  // Start offline so the staged file and the mutation using it are queued.
  network.setOffline();
  const storeManager = createUploadFileTestManager(
    () => 'offline-upload-file-consume-session',
  );

  // The document value is the avatar file ref: `server:<id>` for an uploaded
  // file, or `local:<uploadId>` while the avatar is only staged locally.
  const env = createDocumentStoreTestEnv<string, AvatarUploadOperations>(
    'server:old-avatar',
    {
      id: 'offline-upload-file-avatar-doc',
      storeManager,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: rc_object({ value: rc_string }),
        offline: {
          operations: {
            setAvatar: {
              inputSchema: rc_object({ uploadId: rc_string }),
              kind: 'update',
              dependsOnUploads: ({ input }) => [input.uploadId],
              execute: async (ctx) => {
                const serverRef =
                  ctx.uploads.resolvedRefsById[ctx.input.uploadId];
                if (typeof serverRef !== 'string') {
                  throw new Error('Expected the upload to resolve to a ref');
                }
                await env.serverMock.delayedSetData(serverRef);
                return { value: serverRef };
              },
              // The entity receives the real server ref here.
              onSuccessExecute: ({ result }) => {
                env.apiStore.updateState((draft) => {
                  draft.value = result.value;
                });
              },
            },
          },
        },
      },
    },
  );

  // App pattern: derive the upload id from the entity, so the hook is only
  // asked for the staged file while the entity still holds the local ref.
  const avatarHook = renderHook(() => {
    const avatarRef = env.apiStore.useDocument().data?.value ?? null;
    const stagedUploadId =
      avatarRef?.startsWith('local:') === true
        ? avatarRef.slice('local:'.length)
        : false;
    const staged = storeManager.useOfflineUploadFile(stagedUploadId);

    renders.add({
      avatarRef,
      staged: staged.status,
      imgSrc: stagedUploadId === false ? avatarRef : staged.url,
    });
  });
  await flushAllTimers();
  renders.reset();

  // The user picks a new avatar while offline: stage the file, then update
  // the entity optimistically with a local ref pointing to the staged upload.
  renders.addMark('pick a new avatar while offline');
  (
    await resolveAfterAllTimers(
      storeManager.saveOfflineUpload({
        id: 'avatar-1',
        file: createImageFile('avatar.png', 'avatar bytes'),
      }),
    )
  ).unwrap();
  await act(async () => {
    await env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value = 'local:avatar-1';
        });
      },
      mutation: () => Promise.resolve({ value: 'server:avatar-1' }),
      offline: { operation: 'setAvatar', input: { uploadId: 'avatar-1' } },
    });
  });

  // Reconnect: the upload is sent, then the queued mutation replays with the
  // uploaded ref.
  renders.addMark('reconnect and replay');
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await advanceTime(10_000);

  // The local file is rendered through the whole upload + replay, and the
  // very next render already shows the server ref: the app never sees a
  // local ref paired with a missing staged file.
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "

    >>> pick a new avatar while offline

    -> avatarRef: local:avatar-1 ⋅ staged: success ⋅ imgSrc: blob:staged-1

    >>> reconnect and replay

    -> avatarRef: local:avatar-1 ⋅ staged: success ⋅ imgSrc: blob:staged-1
    -> avatarRef: server:avatar-1 ⋅ staged: idle ⋅ imgSrc: server:avatar-1
    "
  `);
  // The URL is released as soon as the entity stops pointing to the upload.
  expect(objectUrls.events).toMatchInlineSnapshot(
    `['create blob:staged-1 (avatar.png)', 'revoke blob:staged-1']`,
  );

  // A manually staged upload is kept as `uploaded` after being consumed; the
  // app deletes it once it no longer needs the local file.
  expect(
    storeManager
      .getOfflineUploads()
      .map((upload) => pick(upload, ['id', 'state', 'resolvedRef'])),
  ).toMatchInlineSnapshot(
    `- { id: 'avatar-1', resolvedRef: 'server:avatar-1', state: 'uploaded' }`,
  );
  (
    await resolveAfterAllTimers(storeManager.deleteOfflineUpload('avatar-1'))
  ).unwrap();
  expect(storeManager.getOfflineUploads()).toMatchInlineSnapshot(`[]`);

  avatarHook.unmount();
});

test('a file attached to a queued mutation is released once the mutation has been replayed and the entity already holds the server data', async () => {
  createMockBrowserOpfs();
  const objectUrls = trackObjectUrls();
  const renders = createLoggerStore();

  network.setOffline();
  const storeManager = createUploadFileTestManager(
    () => 'offline-upload-file-attached-session',
  );

  const env = createDocumentStoreTestEnv<number, DirectUploadUpdateOperations>(
    1,
    {
      id: 'offline-upload-file-attached-doc',
      storeManager,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          operations: {
            updateValue: {
              inputSchema: rc_object({ value: rc_number }),
              kind: 'update',
              execute: async (ctx) => {
                await env.serverMock.delayedSetData(ctx.input.value);
                return ctx.input;
              },
              // Marks the entity as synced with a value the optimistic
              // update never used, so the log shows when replay finished.
              onSuccessExecute: ({ input }) => {
                env.apiStore.updateState((draft) => {
                  draft.value = input.value * 100;
                });
              },
            },
          },
        },
      },
    },
  );
  await flushAllTimers();

  // Queue a mutation with a directly attached file while offline.
  await resolveAfterAllTimers(
    env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value = 2;
        });
      },
      mutation: () => Promise.resolve({ value: 2 }),
      offline: { operation: 'updateValue', input: { value: 2 } },
      upload: { avatar: createImageFile('avatar.png', 'avatar bytes') },
    }),
  );
  await flushAllTimers();

  // Attached files are staged under a generated id exposed by the uploads
  // list; a pending-uploads UI renders them by that id.
  const attachedUploadId = storeManager.getOfflineUploads()[0]?.id;
  expect(attachedUploadId).toMatch(ATTACHED_UPLOAD_FILE_ID_PATTERN);

  const fileHook = renderHook(() => {
    const docValue = env.apiStore.useDocument().data?.value ?? null;
    const staged = storeManager.useOfflineUploadFile(attachedUploadId);

    renders.add({ docValue, ...describeStagedFile(staged) });
  });
  await flushAllTimers();

  renders.addMark('reconnect and replay');
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await flushAllTimers();

  // The attached file stays available until replay succeeded: the entity is
  // updated by `onSuccessExecute` (value 200) before the consumed upload is
  // dropped and the hook reports it as missing. The last render is the
  // store's recovery revalidation after replay, which replaces the client-only
  // `onSuccessExecute` marker with the server value (2).
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> docValue: 2 ⋅ status: success ⋅ url: blob:staged-1 ⋅ fileName: avatar.png

    >>> reconnect and replay

    -> docValue: 2 ⋅ status: success ⋅ url: blob:staged-1 ⋅ fileName: avatar.png
    -> docValue: 200 ⋅ status: success ⋅ url: blob:staged-1 ⋅ fileName: avatar.png
    -> docValue: 200 ⋅ status: missing ⋅ url: null ⋅ fileName: null
    -> docValue: 2 ⋅ status: missing ⋅ url: null ⋅ fileName: null
    "
  `);
  expect(objectUrls.events).toMatchInlineSnapshot(
    `['create blob:staged-1 (avatar.png)', 'revoke blob:staged-1']`,
  );
  expect(storeManager.getOfflineUploads()).toMatchInlineSnapshot(`[]`);

  fileHook.unmount();
});

test('a falsy id disables the hook, and the file is only kept while a consumer needs it', async () => {
  createMockBrowserOpfs();
  const objectUrls = trackObjectUrls();
  const storage = createReadTrackingUploadAdapter();
  const renders = createLoggerStore();

  network.setOffline();
  const storeManager = await startUploadFileTestSession(
    () => 'offline-upload-file-falsy-id-session',
    storage.adapter,
  );
  (
    await resolveAfterAllTimers(
      storeManager.saveOfflineUpload({
        id: 'photo-1',
        file: createImageFile('photo.png', 'photo bytes'),
      }),
    )
  ).unwrap();
  storage.reads.length = 0;

  const initialProps: { id: string | false | null | undefined } = { id: false };
  const fileHook = renderHook(
    ({ id }) => {
      const staged = storeManager.useOfflineUploadFile(id);

      renders.add({ id, ...describeStagedFile(staged) });

      return staged;
    },
    { initialProps },
  );
  await flushAllTimers();

  // Without an id nothing is read and no URL is created.
  expect(objectUrls.events).toMatchInlineSnapshot(`[]`);

  renders.addMark('ask for the staged file');
  fileHook.rerender({ id: 'photo-1' });
  await flushAllTimers();

  // Going back to a falsy id (e.g. the entity now has a server ref) returns
  // the idle state right away.
  for (const disabledId of [null, undefined, false] as const) {
    renders.addMark(`disable with ${String(disabledId)}`);
    fileHook.rerender({ id: disabledId });
    await advanceTime(100);
  }

  // The URL is only released after a moment without consumers, so asking for
  // the file again right away reuses it instead of creating a new one.
  renders.addMark('ask for the staged file again right away');
  fileHook.rerender({ id: 'photo-1' });
  await advanceTime(100);

  // Without any consumer for a full second the URL is revoked...
  renders.addMark('disable for more than a second');
  fileHook.rerender({ id: false });
  await advanceTime(1_000);
  expect(objectUrls.getLiveUrls()).toMatchInlineSnapshot(`[]`);

  // ...and asking again creates a fresh one for the still staged file.
  renders.addMark('ask for the staged file once more');
  fileHook.rerender({ id: 'photo-1' });
  await advanceTime(100);

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> id: ❌ ⋅ status: idle ⋅ url: null ⋅ fileName: null

    >>> ask for the staged file

    -> id: photo-1 ⋅ status: success ⋅ url: blob:staged-1 ⋅ fileName: photo.png

    >>> disable with null

    -> id: null ⋅ status: idle ⋅ url: null ⋅ fileName: null

    >>> disable with undefined

    -> id: undefined ⋅ status: idle ⋅ url: null ⋅ fileName: null

    >>> disable with false

    -> id: ❌ ⋅ status: idle ⋅ url: null ⋅ fileName: null

    >>> ask for the staged file again right away

    -> id: photo-1 ⋅ status: success ⋅ url: blob:staged-1 ⋅ fileName: photo.png

    >>> disable for more than a second

    -> id: ❌ ⋅ status: idle ⋅ url: null ⋅ fileName: null

    >>> ask for the staged file once more

    -> id: photo-1 ⋅ status: success ⋅ url: blob:staged-2 ⋅ fileName: photo.png
    "
  `);

  fileHook.unmount();
  await advanceTime(1_000);

  // Each URL was revoked once the hook stopped needing the file, and the
  // session never had to read the file from storage again.
  expect(objectUrls.events).toMatchInlineSnapshot(`
    - 'create blob:staged-1 (photo.png)'
    - 'revoke blob:staged-1'
    - 'create blob:staged-2 (photo.png)'
    - 'revoke blob:staged-2'
  `);
  expect(storage.reads).toMatchInlineSnapshot(`[]`);
});

test('a file read by a render that never commits is released instead of leaking its URL', async () => {
  createMockBrowserOpfs();
  const objectUrls = trackObjectUrls();
  const renders = createLoggerStore();

  network.setOffline();
  const storeManager = await startUploadFileTestSession(
    () => 'offline-upload-file-suspended-session',
  );
  (
    await resolveAfterAllTimers(
      storeManager.saveOfflineUpload({
        id: 'photo-1',
        file: createImageFile('photo.png', 'photo bytes'),
      }),
    )
  ).unwrap();

  // A code-split sibling whose chunk is still being downloaded.
  const SuspendedSibling = lazy(
    () => new Promise<{ default: () => null }>(() => {}),
  );

  function Thumbnail() {
    const staged = storeManager.useOfflineUploadFile('photo-1');

    renders.add(describeStagedFile(staged));

    return staged.url ? (
      <img
        alt="photo"
        src={staged.url}
      />
    ) : null;
  }

  // The thumbnail renders (reading the staged file) but the tree is not
  // committed, because a sibling is suspended.
  const view = render(
    <Suspense fallback="loading sibling">
      <Thumbnail />
      <SuspendedSibling />
    </Suspense>,
  );
  await advanceTime(100);

  // The file the session already holds is available on the very first render,
  // which needs an object URL even though nothing was mounted yet.
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: success ⋅ url: blob:staged-1 ⋅ fileName: photo.png
    "
  `);
  expect(view.container.innerHTML).toMatchInlineSnapshot(`"loading sibling"`);
  expect(objectUrls.getLiveUrls()).toMatchInlineSnapshot(`['blob:staged-1']`);

  // No component ended up mounted with that URL, so it is revoked shortly
  // after instead of staying alive until the upload leaves the session.
  await advanceTime(1_000);
  expect(objectUrls.events).toMatchInlineSnapshot(
    `['create blob:staged-1 (photo.png)', 'revoke blob:staged-1']`,
  );

  view.unmount();
});

test('switching the active session stops exposing the previous session file', async () => {
  createMockBrowserOpfs();
  const objectUrls = trackObjectUrls();
  const renders = createLoggerStore();
  let activeSessionKey: string | false = 'offline-upload-file-tenant-a';

  network.setOffline();
  const storeManager = await startUploadFileTestSession(() => activeSessionKey);
  (
    await resolveAfterAllTimers(
      storeManager.saveOfflineUpload({
        id: 'photo-1',
        file: createImageFile('tenant-a.png', 'tenant a bytes'),
      }),
    )
  ).unwrap();

  const fileHook = renderHook(() => {
    const staged = storeManager.useOfflineUploadFile('photo-1');

    renders.add({ session: activeSessionKey, ...describeStagedFile(staged) });
  });
  await flushAllTimers();

  // Another account becomes active: its session has no upload with this id.
  renders.addMark('switch to another session');
  activeSessionKey = 'offline-upload-file-tenant-b';
  fileHook.rerender();
  await flushAllTimers();
  // The URL of the previous session file is revoked.
  expect(objectUrls.getLiveUrls()).toMatchInlineSnapshot(`[]`);

  // Logged out: there is no session to read uploads from.
  renders.addMark('log out');
  activeSessionKey = false;
  fileHook.rerender();
  await flushAllTimers();

  renders.addMark('switch back to the first session');
  activeSessionKey = 'offline-upload-file-tenant-a';
  fileHook.rerender();
  await flushAllTimers();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ session: offline-upload-file-tenant-a
    ⋅ status: success
    ⋅ url: blob:staged-1
    ⋅ fileName: tenant-a.png
    └─

    >>> switch to another session

    ┌─
    ⋅ session: offline-upload-file-tenant-b
    ⋅ status: loading
    ⋅ url: null
    ⋅ fileName: null
    └─
    ┌─
    ⋅ session: offline-upload-file-tenant-b
    ⋅ status: missing
    ⋅ url: null
    ⋅ fileName: null
    └─

    >>> log out

    -> session: ❌ ⋅ status: loading ⋅ url: null ⋅ fileName: null
    -> session: ❌ ⋅ status: missing ⋅ url: null ⋅ fileName: null

    >>> switch back to the first session

    ┌─
    ⋅ session: offline-upload-file-tenant-a
    ⋅ status: success
    ⋅ url: blob:staged-2
    ⋅ fileName: tenant-a.png
    └─
    "
  `);
  expect(objectUrls.events).toMatchInlineSnapshot(`
    - 'create blob:staged-1 (tenant-a.png)'
    - 'revoke blob:staged-1'
    - 'create blob:staged-2 (tenant-a.png)'
  `);

  fileHook.unmount();
});

test('a storage failure while reading a staged file is reported as an error state', async () => {
  createMockBrowserOpfs();
  const objectUrls = trackObjectUrls();
  const storage = createReadTrackingUploadAdapter();
  const renders = createLoggerStore();

  network.setOffline();
  const storeManager = await startUploadFileTestSession(
    () => 'offline-upload-file-error-session',
    storage.adapter,
  );

  // The id is not known to this session yet, so the hook has to look it up in
  // storage, and that read fails.
  storage.failNextLoad(new Error('Storage is unavailable'));
  const fileHook = renderHook(() => {
    const staged = storeManager.useOfflineUploadFile('photo-1');

    renders.add(describeStagedFile(staged));

    return staged;
  });
  await flushAllTimers();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: loading ⋅ url: null ⋅ fileName: null
    -> status: error ⋅ url: null ⋅ fileName: null ⋅ error: Storage is unavailable
    "
  `);
  expect(fileHook.result.current.error).toBeInstanceOf(Error);
  expect(objectUrls.events).toMatchInlineSnapshot(`[]`);

  fileHook.unmount();
});

test('replacing an upload right after a restart keeps the metadata saved before the restart', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'offline-upload-metadata-replace-after-restart-session';
  const transportCalls: Array<Record<string, unknown>> = [];

  function createUploadManager() {
    return createStoreManager({
      getSessionKey: () => sessionKey,
      errorNormalizer: normalizeError,
      offlineSession: {
        network: network.config,
        uploads: {
          adapter: opfsOfflineUploadAdapter,
          upload: async ({ id, file, metadata }) => {
            transportCalls.push({ id, fileText: await file.text(), metadata });
            return `server:${id}`;
          },
        },
      },
    });
  }

  // Stage the upload offline with the metadata the transport needs.
  network.setOffline();
  const firstSession = createUploadManager();
  await flushAllTimers();
  (
    await resolveAfterAllTimers(
      firstSession.saveOfflineUpload({
        id: 'attachment',
        file: new File(['first draft'], 'draft.txt', {
          type: 'text/plain',
          lastModified: 1,
        }),
        metadata: { kind: 'chat', chatId: 'chat-42' },
      }),
    )
  ).unwrap();

  // After a full restart, replacing the file is the first thing the app does
  // with the new session, before the stored uploads were listed.
  resetSessionForTests();
  const restartedSession = createUploadManager();
  (
    await resolveAfterAllTimers(
      restartedSession.replaceOfflineUpload({
        id: 'attachment',
        file: new File(['final version'], 'final.txt', {
          type: 'text/plain',
          lastModified: 2,
        }),
      }),
    )
  ).unwrap();
  await flushAllTimers();

  // The replacement keeps the metadata persisted before the restart instead
  // of silently dropping it.
  expect(
    restartedSession
      .getOfflineUploads()
      .map((upload) => pick(upload, ['id', 'fileName', 'metadata'])),
  ).toMatchInlineSnapshot(`
    - fileName: 'final.txt'
      id: 'attachment'
      metadata: { chatId: 'chat-42', kind: 'chat' }
  `);

  // So the transport still receives it when the replaced file is uploaded.
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await advanceTime(0);
  (
    await resolveAfterAllTimers(
      restartedSession.resolveOfflineUpload('attachment'),
    )
  ).unwrap();

  expect(transportCalls).toMatchInlineSnapshot(`
    - fileText: 'final version'
      id: 'attachment'
      metadata: { chatId: 'chat-42', kind: 'chat' }
  `);
});

test('saving a new file over an upload that is still being sent is rejected, so the new file is never marked as uploaded with the previous file ref', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'offline-upload-save-while-uploading-session';
  const transportCalls: string[] = [];

  const storeManager = createStoreManager({
    getSessionKey: () => sessionKey,
    errorNormalizer: normalizeError,
    offlineSession: {
      network: network.config,
      uploads: {
        adapter: opfsOfflineUploadAdapter,
        upload: async ({ file }) => {
          transportCalls.push(`upload-start:${file.name}`);
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          transportCalls.push(`upload-finish:${file.name}`);
          return `server:${file.name}`;
        },
      },
    },
  });
  await flushAllTimers();

  (
    await resolveAfterAllTimers(
      storeManager.saveOfflineUpload({
        id: 'avatar',
        file: new File(['first photo'], 'first.png', {
          type: 'image/png',
          lastModified: 1,
        }),
      }),
    )
  ).unwrap();

  // The app starts sending the first photo...
  const firstResolve = storeManager.resolveOfflineUpload('avatar');
  await advanceTime(100);
  expect(storeManager.getOfflineUploads()[0]?.state).toBe('uploading');

  // ...and the user picks another photo for the same upload id mid-upload.
  const savePromise = storeManager.saveOfflineUpload({
    id: 'avatar',
    file: new File(['second photo'], 'second.png', {
      type: 'image/png',
      lastModified: 2,
    }),
  });
  // Let the storage write settle while the first upload is still running.
  await advanceTime(100);
  const saveDuringUpload = await savePromise;

  // The save is rejected instead of swapping the file under the running
  // upload.
  expect(
    saveDuringUpload.ok ? 'saved' : saveDuringUpload.error.message,
  ).toMatchInlineSnapshot(
    `"Cannot change upload "avatar" while it is queued or uploading"`,
  );

  // Let the first upload finish. A bounded advance keeps the 7-day retention
  // cleanup of the uploaded file from running before the assertions.
  await advanceTime(1_000);
  expect((await firstResolve).unwrap()).toBe('server:first.png');

  // The stored upload is still the file that was actually sent, so its ref
  // matches its bytes.
  const storedUpload = storeManager.getOfflineUploads()[0];
  expect(
    storedUpload && pick(storedUpload, ['fileName', 'state', 'resolvedRef']),
  ).toMatchInlineSnapshot(`
    fileName: 'first.png'
    resolvedRef: 'server:first.png'
    state: 'uploaded'
  `);
  expect(transportCalls).toMatchInlineSnapshot(
    `['upload-start:first.png', 'upload-finish:first.png']`,
  );
});

test('upload concurrency is respected across separate resolve calls, and an upload waiting in the queue cannot be replaced', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'offline-upload-concurrency-session';
  const transportCalls: string[] = [];

  const storeManager = createStoreManager({
    getSessionKey: () => sessionKey,
    errorNormalizer: normalizeError,
    offlineSession: {
      network: network.config,
      uploads: {
        adapter: opfsOfflineUploadAdapter,
        // Only one file may be sent at a time.
        concurrency: 1,
        upload: async ({ file }) => {
          transportCalls.push(`upload-start:${file.name}`);
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          transportCalls.push(`upload-finish:${file.name}`);
          return `server:${file.name}`;
        },
      },
    },
  });
  await flushAllTimers();

  for (const name of ['first', 'second']) {
    (
      await resolveAfterAllTimers(
        storeManager.saveOfflineUpload({
          id: name,
          file: new File([`${name} photo`], `${name}.png`, {
            type: 'image/png',
            lastModified: 1,
          }),
        }),
      )
    ).unwrap();
  }

  // The app resolves each upload from a separate call, e.g. two form fields
  // submitted one after the other.
  const firstResolve = storeManager.resolveOfflineUpload('first');
  await advanceTime(100);
  const secondResolve = storeManager.resolveOfflineUpload('second');
  await advanceTime(100);

  // The second upload waits behind the first one, so its file can no longer
  // be swapped: the queued transport would send it and pair the ref with it.
  const replaceWhileQueued = await storeManager.replaceOfflineUpload({
    id: 'second',
    file: new File(['other photo'], 'other.png', {
      type: 'image/png',
      lastModified: 2,
    }),
  });
  expect(
    replaceWhileQueued.ok ? 'replaced' : replaceWhileQueued.error.message,
  ).toMatchInlineSnapshot(
    `"Cannot change upload "second" while it is queued or uploading"`,
  );

  // Bounded advance: both uploads take 1s each, and retention cleanup of the
  // uploaded files must not run before the assertions.
  await advanceTime(2_500);
  expect((await firstResolve).unwrap()).toBe('server:first.png');
  expect((await secondResolve).unwrap()).toBe('server:second.png');

  // The second file only starts after the first one finished.
  expect(transportCalls).toMatchInlineSnapshot(`
    - 'upload-start:first.png'
    - 'upload-finish:first.png'
    - 'upload-start:second.png'
    - 'upload-finish:second.png'
  `);
});

test('a file queued offline is kept after a restart when another store is created before the store that queued it', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  const sessionKey = 'offline-lazy-store-upload-session';
  const replayedFiles: Array<{ fileName?: string; fileText: string | null }> =
    [];

  function createManager() {
    return createStoreManager({
      getSessionKey: () => sessionKey,
      errorNormalizer: normalizeError,
      offlineSession: {
        network: network.config,
        uploads: {
          adapter: opfsOfflineUploadAdapter,
          upload: ({ id }) => Promise.resolve(`server:${id}`),
        },
      },
    });
  }

  // The store of the "profile" screen, whose edits carry an avatar file.
  function createProfileStore(
    storeManager: ReturnType<typeof createManager>,
    testScenario: 'loaded' | 'idle',
  ) {
    return createDocumentStoreTestEnv<number, DirectUploadUpdateOperations>(1, {
      id: 'offline-lazy-profile-doc',
      storeManager,
      testScenario,
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          operations: {
            updateValue: {
              inputSchema: rc_object({ value: rc_number }),
              kind: 'update',
              execute: async (ctx) => {
                const file = ctx.uploads.filesById.avatar;
                replayedFiles.push({
                  fileName: file?.name,
                  fileText: file ? await file.text() : null,
                });
                return ctx.input;
              },
              onSuccessExecute: () => {},
            },
          },
        },
      },
    });
  }

  // Queue a profile edit with an avatar while offline.
  network.setOffline();
  const storeManager = createManager();
  storeManager.getOfflineStatus();
  const profileEnv = createProfileStore(storeManager, 'loaded');
  await flushAllTimers();

  await resolveAfterAllTimers(
    profileEnv.apiStore.performMutation({
      mutation: () => Promise.resolve({ value: 2 }),
      offline: { operation: 'updateValue', input: { value: 2 } },
      upload: {
        avatar: new File(['avatar body'], 'avatar.txt', {
          type: 'text/plain',
          lastModified: 1,
        }),
      },
    }),
  );
  await flushAllTimers();
  expect(storeManager.getOfflineUploads()).toHaveLength(1);

  // The app restarts on another screen: only the "settings" store is created,
  // the profile store is code-split and created later.
  resetSessionForTests();
  const restartedStoreManager = createManager();
  restartedStoreManager.getOfflineStatus();
  const settingsEnv = createDocumentStoreTestEnv<
    number,
    DirectUploadUpdateOperations
  >(1, {
    id: 'offline-lazy-settings-doc',
    storeManager: restartedStoreManager,
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        operations: {
          updateValue: {
            inputSchema: rc_object({ value: rc_number }),
            kind: 'update',
            execute: (ctx) => Promise.resolve(ctx.input),
            onSuccessExecute: () => {},
          },
        },
      },
    },
  });
  await flushAllTimers();

  // Still offline, the user edits a setting.
  await resolveAfterAllTimers(
    settingsEnv.apiStore.performMutation({
      mutation: () => Promise.resolve({ value: 5 }),
      offline: { operation: 'updateValue', input: { value: 5 } },
    }),
  );
  await flushAllTimers();

  // The queued profile edit still needs its avatar, so the settings store
  // being the only one created must not delete it.
  expect(
    restartedStoreManager.getOfflineUploads().map((upload) => upload.state),
  ).toMatchInlineSnapshot(`['pending']`);
  expect(getOpfsDirTree(mockBrowserOpfs)).toContain('binary.blob');

  // The user opens the profile screen and the connection comes back: the
  // queued edit is sent with the original file.
  createProfileStore(restartedStoreManager, 'idle');
  await flushAllTimers();
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  // A minute online, far less than the one-week retention of unused files.
  await advanceTime(60_000);

  expect(replayedFiles).toMatchInlineSnapshot(`
    - { fileName: 'avatar.txt', fileText: 'avatar body' }
  `);
  // Once the profile store exists and its edit is sent, the file is unused
  // and removed as usual.
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`"empty"`);
});

test('a file queued offline by an older version is removed once its edit is sent', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  const sessionKey = 'offline-legacy-upload-session';
  const replayedFiles: Array<string | null> = [];

  function createManager() {
    return createStoreManager({
      getSessionKey: () => sessionKey,
      errorNormalizer: normalizeError,
      offlineSession: {
        network: network.config,
        uploads: {
          adapter: opfsOfflineUploadAdapter,
          upload: ({ id }) => Promise.resolve(`server:${id}`),
        },
      },
    });
  }

  function createProfileStore(
    storeManager: ReturnType<typeof createManager>,
    testScenario: 'loaded' | 'idle',
  ) {
    return createDocumentStoreTestEnv<number, DirectUploadUpdateOperations>(1, {
      id: 'offline-legacy-profile-doc',
      storeManager,
      testScenario,
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          operations: {
            updateValue: {
              inputSchema: rc_object({ value: rc_number }),
              kind: 'update',
              execute: async (ctx) => {
                const file = ctx.uploads.filesById.avatar;
                replayedFiles.push(file ? await file.text() : null);
                return ctx.input;
              },
              onSuccessExecute: () => {},
            },
          },
        },
      },
    });
  }

  // Queue a profile edit with an avatar while offline.
  network.setOffline();
  const storeManager = createManager();
  storeManager.getOfflineStatus();
  const profileEnv = createProfileStore(storeManager, 'loaded');
  await flushAllTimers();

  await resolveAfterAllTimers(
    profileEnv.apiStore.performMutation({
      mutation: () => Promise.resolve({ value: 2 }),
      offline: { operation: 'updateValue', input: { value: 2 } },
      upload: {
        avatar: new File(['avatar body'], 'avatar.txt', {
          type: 'text/plain',
          lastModified: 1,
        }),
      },
    }),
  );
  await flushAllTimers();
  const [queuedUpload] = storeManager.getOfflineUploads();
  if (!queuedUpload) throw new Error('Expected the queued avatar upload');

  // Older versions didn't persist which store queued the file: drop it from
  // the stored record to get the same data an upgraded app finds.
  const metadataPath = getOfflineUploadOpfsPath(
    sessionKey,
    queuedUpload.id,
    'metadata.json',
  );
  const storedMetadata = mockBrowserOpfs.readFile(metadataPath);
  const legacyMetadata = storedMetadata?.replace(
    ',"s":"offline-legacy-profile-doc"',
    '',
  );
  if (legacyMetadata === undefined || legacyMetadata === storedMetadata) {
    throw new Error('Expected the stored record to have a store name');
  }
  mockBrowserOpfs.writeFile(metadataPath, legacyMetadata);

  // The upgraded app restarts on the profile screen and the connection comes
  // back: the queued edit is sent with the original file.
  resetSessionForTests();
  const restartedStoreManager = createManager();
  restartedStoreManager.getOfflineStatus();
  createProfileStore(restartedStoreManager, 'idle');
  await flushAllTimers();
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  // A minute online, far less than the one-week retention of unused files.
  await advanceTime(60_000);

  expect(replayedFiles).toMatchInlineSnapshot(`['avatar body']`);
  // Nothing in the profile queue uses the file anymore, so it's removed right
  // away instead of staying in storage until the retention expires.
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`"empty"`);
});
