import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_array, rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type {
  CollectionOfflineOperationDefinition,
  DocumentOfflineOperationDefinition,
  ListQueryOfflineOperationDefinition,
} from '../../src/main';
import {
  clearSessionStorage,
  createStoreManager,
  opfsOfflineUploadAdapter,
} from '../../src/main';
import { encodePathSegment } from '../../src/persistentStorage/opfsFileNaming';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
} from '../mocks/listQueryStoreTestEnv';
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
import {
  deleteItemInputSchema,
  getSortedQueueSummary,
  userRowSchema,
} from './offlineReplayTestShared';
import {
  classifyRetryableReplayFailure,
  collectionSchema,
  docConflictSchema,
  docSchema,
  listQueryQueryPayloadSchema,
  summarizeResolution,
} from './offlineTestShared';

let network = createOfflineNetworkMock();
const DIRECT_UPLOAD_ID_PATTERN =
  /^offline-direct-upload-doc:[^:]+:[^:]+:avatar$/;

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
      "tsdf-uploads (1.40 kb)
      └ offline-direct-upload-collision-session (1.37 kb)
        ├ offline-direct-upload-collision-doc:1735689612000:eeeeeeee:avatar (0.66 kb)
        │ ├ binary.blob (0.06 kb)
        │ └ metadata.json (0.47 kb)
        └ offline-direct-upload-collision-doc:1735689612009:i:avatar (0.64 kb)
          ├ binary.blob (0.06 kb)
          └ metadata.json (0.46 kb)"
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

  // Reconnect so the upload resolves before the mutation executes. Only a few
  // seconds pass: flushing every timer would also run the one-week retention
  // of unreferenced uploads and hide whether the replay consumed the file.
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await advanceTime(3_000);

  // The mutation should execute only after the upload finishes, and it should
  // receive the rewritten server ref instead of the original offline id.
  expect(replayEvents).toMatchInlineSnapshot(`
    - 'upload-start:asset-1:dependency.txt'
    - 'upload-finish:asset-1'
    - 'execute:asset-1:server:asset-1'
  `);
  // The successful replay consumed the staged upload: its record and its
  // bytes are deleted right away instead of waiting for the retention window.
  expect(uploadHook.result.current).toMatchInlineSnapshot(`[]`);
  expect(
    getParsedOpfsFileData(
      'tsdf-uploads/offline-upload-dependency-session/asset-1/metadata.json',
    ),
  ).toMatchInlineSnapshot(`null`);
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`"empty"`);

  uploadHook.unmount();
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

// ---------------------------------------------------------------------------
// Staged uploads follow the queued work that depends on them
// ---------------------------------------------------------------------------

/**
 * Session whose upload transport resolves instantly and whose replay gives up
 * after a single failure, so one rejected `execute` is enough to turn a queued
 * mutation into a manual resolution.
 */
function createUploadCleanupStoreManager(sessionKey: string) {
  return createStoreManager({
    getSessionKey: () => sessionKey,
    errorNormalizer: normalizeError,
    offlineSession: {
      network: network.config,
      classifyRetryableFailure: (error, ctx) =>
        classifyRetryableReplayFailure(error, ctx.phase),
      replayRetry: { maxFailures: 1, intervalMs: 1 },
      uploads: {
        adapter: opfsOfflineUploadAdapter,
        upload: ({ id }) => Promise.resolve(`server:${id}`),
      },
    },
  });
}

/**
 * Settles `promise` while advancing the fake clock by a bounded amount.
 *
 * `flushAllTimers` / `resolveAfterAllTimers` also run the one-week upload
 * retention timer once the session is online, and that timer deletes
 * unreferenced uploads on its own. These tests must prove the upload is
 * removed by the queue change itself, so they never jump that far.
 */
async function resolveWithin<T>(promise: Promise<T> | T, ms = 100): Promise<T> {
  const [result] = await Promise.all([promise, advanceTime(ms)]);
  return result;
}

type UploadCleanupStoreManager = ReturnType<
  typeof createUploadCleanupStoreManager
>;

/** Stages a file the same way an app does before queueing its mutation. */
async function stageUpload(
  storeManager: UploadCleanupStoreManager,
  id: string,
): Promise<void> {
  (
    await resolveWithin(
      storeManager.saveOfflineUpload({
        id,
        file: new File([`${id} bytes`], `${id}.txt`, {
          type: 'text/plain',
          lastModified: 1,
        }),
      }),
    )
  ).unwrap();
}

function getStagedUploads(storeManager: UploadCleanupStoreManager) {
  return storeManager
    .getOfflineUploads()
    .map((upload) => pick(upload, ['id', 'source', 'state']));
}

async function reconnect(): Promise<void> {
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  // Long enough for the upload transport, the replay and the storage writes,
  // far below the one-week upload retention.
  await advanceTime(2_000);
}

test('discarding a failed mutation deletes the staged upload it depended on, and keeps a file no mutation used yet', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  network.setOffline();
  const storeManager = createUploadCleanupStoreManager(
    'offline-upload-discard-session',
  );

  const env = createDocumentStoreTestEnv<number, UploadDependencyOperations>(
    1,
    {
      id: 'offline-upload-discard-doc',
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
              // The server rejects the mutation after its file was uploaded.
              execute: () =>
                Promise.reject(new Error('server rejected the attachment')),
              onSuccessExecute: () => {},
            },
          },
        },
      },
    },
  );
  await flushAllTimers();

  // --- Setup: two staged files, only one of them used by a queued mutation ---
  await stageUpload(storeManager, 'asset-1');
  // The user picked this file but has not submitted its mutation yet.
  await stageUpload(storeManager, 'draft-asset');
  await resolveWithin(
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

  // --- Replay fails: the file is uploaded, then the mutation is rejected ---
  await reconnect();

  const [resolution] = env.apiStore.getOfflineResolutions();
  if (!resolution) {
    throw new Error('Expected the failed replay to require a resolution');
  }
  expect(summarizeResolution(resolution)).toMatchInlineSnapshot(`
    error: 'server rejected the attachment'
    input: 'attachmentId: "asset-1", value: 3'
    kind: 'retry-exhausted'
    on: 'document:document'
    op: 'updateWithAttachment'
  `);
  // While the resolution is pending its upload must stay available, because
  // the user may still retry it.
  expect(getStagedUploads(storeManager)).toMatchInlineSnapshot(`
    - { id: 'asset-1', source: 'manual', state: 'uploaded' }
    - { id: 'draft-asset', source: 'manual', state: 'pending' }
  `);
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`
    "tsdf-uploads (1.07 kb)
    └ offline-upload-discard-session (1.04 kb)
      ├ asset-1 (0.55 kb)
      │ ├ binary.blob (0.05 kb)
      │ └ metadata.json (0.49 kb)
      └ draft-asset (0.44 kb)
        ├ binary.blob (0.05 kb)
        └ metadata.json (0.36 kb)"
  `);

  // --- Action: the user gives up on the mutation ---
  await resolveWithin(
    env.apiStore.resolveOfflineResolution(
      resolution.id,
      'updateWithAttachment',
      { action: 'discard' },
    ),
  );

  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  // Nothing can consume `asset-1` anymore, so both its record and its bytes
  // are gone. `draft-asset` was never referenced by queued work and is kept
  // for the mutation the user has not queued yet.
  expect(getStagedUploads(storeManager)).toMatchInlineSnapshot(
    `- { id: 'draft-asset', source: 'manual', state: 'pending' }`,
  );
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`
    "tsdf-uploads (0.52 kb)
    └ offline-upload-discard-session (0.49 kb)
      └ draft-asset (0.44 kb)
        ├ binary.blob (0.05 kb)
        └ metadata.json (0.36 kb)"
  `);
});

const usersQuery = { tableId: 'users' } as const;

type UserRow = { id: number; name: string };

type UserLifecycleOperations = {
  createUser: ListQueryOfflineOperationDefinition<
    UserRow,
    ListQueryParams,
    string,
    { name: string; avatarId: string },
    unknown,
    UserRow
  >;
  renameUser: ListQueryOfflineOperationDefinition<
    UserRow,
    ListQueryParams,
    string,
    { itemId: string; name: string; attachmentId: string },
    unknown
  >;
  deleteUser: ListQueryOfflineOperationDefinition<
    UserRow,
    ListQueryParams,
    string,
    { itemId: string },
    unknown
  >;
};

/**
 * Users list where creating a user uploads an avatar, renaming a user uploads
 * an attachment, and deleting a user that only exists offline cancels its
 * whole pending lifecycle.
 */
function createUserLifecycleEnv(args: {
  storeManager: UploadCleanupStoreManager;
  storeName: string;
  replayedOperations: string[];
  createUser: (input: { name: string }) => Promise<UserRow>;
}) {
  const env: ReturnType<
    typeof createListQueryStoreTestEnv<
      UserRow,
      false,
      false,
      UserLifecycleOperations
    >
  > = createListQueryStoreTestEnv<
    UserRow,
    false,
    false,
    UserLifecycleOperations
  >(
    { users: [{ id: 1, name: 'Ada' }] },
    {
      id: args.storeName,
      storeManager: args.storeManager,
      testScenario: { loaded: { queries: [usersQuery] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: {
          operations: {
            createUser: {
              inputSchema: rc_object({ name: rc_string, avatarId: rc_string }),
              kind: 'create',
              getEntityRefs: ({ input }) => [`temp:${input.name}`],
              dependsOnUploads: ({ input }) => [input.avatarId],
              tempEntity: {
                buildPendingEntity: (input) => ({ id: -1, name: input.name }),
                reconcileServerEntity: (result) => ({
                  finalPayload: `users||${result.id}`,
                  finalData: result,
                }),
              },
              execute: ({ input }) => {
                args.replayedOperations.push('createUser');
                return args.createUser(input);
              },
            },
            renameUser: {
              inputSchema: rc_object({
                itemId: rc_string,
                name: rc_string,
                attachmentId: rc_string,
              }),
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              dependsOnUploads: ({ input }) => [input.attachmentId],
              execute: ({ input }) => {
                args.replayedOperations.push('renameUser');
                return Promise.resolve({ name: input.name });
              },
              onSuccessExecute: ({ input }) => {
                env.apiStore.updateItemState(input.itemId, (item) => ({
                  ...item,
                  name: input.name,
                }));
              },
            },
            deleteUser: {
              inputSchema: deleteItemInputSchema,
              kind: 'delete',
              getEntityRefs: ({ input }) => [input.itemId],
              supersedes: {
                scope: 'same-entity',
                dropSelfIfTempLifecycleCancelled: true,
              },
              execute: () => {
                args.replayedOperations.push('deleteUser');
                return Promise.resolve(undefined);
              },
              onSuccessExecute: ({ input }) => {
                env.apiStore.deleteItemState(input.itemId);
              },
            },
          },
        },
      },
    },
  );

  /** Queues the creation of the user "Linus" with the given avatar upload. */
  async function queueCreateLinus(avatarId: string): Promise<void> {
    await resolveWithin(
      env.apiStore.performMutation('temp:Linus', {
        optimisticUpdate: () => {
          env.apiStore.addItemToState(
            'temp:Linus',
            { id: -1, name: 'Linus' },
            { addItemToQueries: { queries: [usersQuery], appendTo: 'end' } },
          );
        },
        mutation: () => Promise.resolve({ id: 3, name: 'Linus' }),
        offline: {
          operation: 'createUser',
          input: { name: 'Linus', avatarId },
        },
      }),
    );
  }

  /** Queues a rename of the still-offline "Linus" with the given attachment. */
  async function queueRenameLinus(
    name: string,
    attachmentId: string,
  ): Promise<void> {
    await resolveWithin(
      env.apiStore.performMutation('temp:Linus', {
        optimisticUpdate: () => {
          env.apiStore.updateItemState('temp:Linus', (item) => ({
            ...item,
            name,
          }));
        },
        mutation: () => Promise.resolve({ name }),
        offline: {
          operation: 'renameUser',
          input: { itemId: 'temp:Linus', name, attachmentId },
        },
      }),
    );
  }

  return { ...env, queueCreateLinus, queueRenameLinus };
}

test('discarding a failed create also deletes the staged uploads of the queued edits that depended on the new entity', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  network.setOffline();
  const storeManager = createUploadCleanupStoreManager(
    'offline-upload-cascade-discard-session',
  );
  const replayedOperations: string[] = [];
  const env = createUserLifecycleEnv({
    storeManager,
    storeName: 'offline-upload-cascade-discard-users',
    replayedOperations,
    // The server refuses to create the user.
    createUser: () => Promise.reject(new Error('create replay failed')),
  });
  await flushAllTimers();

  // --- Setup: a create and an edit of the new user, each with its own file ---
  await stageUpload(storeManager, 'linus-avatar');
  await stageUpload(storeManager, 'rename-attachment');
  await env.queueCreateLinus('linus-avatar');
  await env.queueRenameLinus('Linus T.', 'rename-attachment');

  // --- Replay: the create fails, so the rename is blocked behind it ---
  await reconnect();

  // Back offline, the user edits the new user once more. This edit stays in
  // the queue (it is not a resolution record) behind the failed create.
  await act(async () => {
    network.goOffline();
    await Promise.resolve();
  });
  await stageUpload(storeManager, 'second-rename-attachment');
  await env.queueRenameLinus('Linus Torvalds', 'second-rename-attachment');

  // So the chain to discard has both kinds of dependents: the first rename is
  // a blocked resolution record (below), the second one a plain queue entry.
  expect(
    getSortedQueueSummary(
      'offline-upload-cascade-discard-session',
      'offline-upload-cascade-discard-users',
    ),
  ).toMatchInlineSnapshot(`
    - input:
        attachmentId: 'second-rename-attachment'
        itemId: 'temp:Linus'
        name: 'Linus Torvalds'
      operation: 'renameUser'
  `);

  expect(
    env.apiStore
      .getOfflineResolutions()
      .map(summarizeResolution)
      .sort((left, right) => left.op.localeCompare(right.op)),
  ).toMatchInlineSnapshot(`
    - blocks: 1
      error: 'create replay failed'
      input: 'avatarId: "linus-avatar", name: "Linus"'
      kind: 'retry-exhausted'
      on: 'item:temp:Linus'
      op: 'createUser'
      tempIds: ['temp:Linus']
    - blockedBy: 1
      error: 'Blocked by unresolved dependency'
      input: 'attachmentId: "rename-attachment", itemId: "temp:Linus", name: "Linus T."'
      kind: 'retry-exhausted'
      on: 'item:temp:Linus'
      op: 'renameUser'
  `);
  // Only the create got as far as uploading its file; all of them stay staged
  // while the user can still retry the chain.
  expect(getStagedUploads(storeManager)).toMatchInlineSnapshot(`
    - { id: 'linus-avatar', source: 'manual', state: 'uploaded' }
    - { id: 'rename-attachment', source: 'manual', state: 'pending' }
    - { id: 'second-rename-attachment', source: 'manual', state: 'pending' }
  `);
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`
    "tsdf-uploads (1.76 kb)
    └ offline-upload-cascade-discard-session (1.74 kb)
      ├ linus-avatar (0.61 kb)
      │ ├ binary.blob (0.06 kb)
      │ └ metadata.json (0.53 kb)
      ├ rename-attachment (0.50 kb)
      │ ├ binary.blob (0.07 kb)
      │ └ metadata.json (0.40 kb)
      └ second-rename-attachment (0.55 kb)
        ├ binary.blob (0.08 kb)
        └ metadata.json (0.43 kb)"
  `);

  const createResolution = env.apiStore
    .getOfflineResolutions()
    .find((resolution) => resolution.operation === 'createUser');
  if (!createResolution) {
    throw new Error('Expected the failed create to require a resolution');
  }

  // --- Action: discarding the create also drops both edits of the new user ---
  await resolveWithin(
    env.apiStore.resolveOfflineResolution(createResolution.id, 'createUser', {
      action: 'discard',
    }),
  );

  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  expect(
    getSortedQueueSummary(
      'offline-upload-cascade-discard-session',
      'offline-upload-cascade-discard-users',
    ),
  ).toMatchInlineSnapshot(`[]`);
  expect(replayedOperations).toMatchInlineSnapshot(`['createUser']`);
  // The files of the discarded create AND of both cascaded edits are gone.
  expect(getStagedUploads(storeManager)).toMatchInlineSnapshot(`[]`);
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`"empty"`);
});

test('deleting an entity that only exists offline deletes the staged uploads of its cancelled create and edits', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  network.setOffline();
  const storeManager = createUploadCleanupStoreManager(
    'offline-upload-temp-cancel-session',
  );
  const replayedOperations: string[] = [];
  const env = createUserLifecycleEnv({
    storeManager,
    storeName: 'offline-upload-temp-cancel-users',
    replayedOperations,
    createUser: (input) => Promise.resolve({ id: 3, name: input.name }),
  });
  await flushAllTimers();

  // --- Setup: a create and an edit of the new user, each with its own file ---
  await stageUpload(storeManager, 'linus-avatar');
  await stageUpload(storeManager, 'rename-attachment');
  await env.queueCreateLinus('linus-avatar');
  await env.queueRenameLinus('Linus T.', 'rename-attachment');

  expect(getStagedUploads(storeManager)).toMatchInlineSnapshot(`
    - { id: 'linus-avatar', source: 'manual', state: 'pending' }
    - { id: 'rename-attachment', source: 'manual', state: 'pending' }
  `);
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`
    "tsdf-uploads (1.03 kb)
    └ offline-upload-temp-cancel-session (1.01 kb)
      ├ linus-avatar (0.45 kb)
      │ ├ binary.blob (0.06 kb)
      │ └ metadata.json (0.37 kb)
      └ rename-attachment (0.49 kb)
        ├ binary.blob (0.07 kb)
        └ metadata.json (0.39 kb)"
  `);

  // --- Action: the user deletes the new user before anything was replayed ---
  // The delete cancels the create and the rename, and drops itself too because
  // the server never knew about this user.
  await resolveWithin(
    env.apiStore.performMutation('temp:Linus', {
      optimisticUpdate: () => {
        env.apiStore.deleteItemState('temp:Linus');
      },
      mutation: () => Promise.resolve(undefined),
      offline: { operation: 'deleteUser', input: { itemId: 'temp:Linus' } },
    }),
  );

  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  // The cancelled work will never replay, so its files are removed right
  // away, while still offline.
  expect(getStagedUploads(storeManager)).toMatchInlineSnapshot(`[]`);
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`"empty"`);

  // Reconnecting has nothing left to upload or replay.
  await reconnect();
  expect(replayedOperations).toMatchInlineSnapshot(`[]`);
});

type AttachmentCollectionOperations = {
  attachFile: CollectionOfflineOperationDefinition<
    { value: { name: string } },
    string,
    { itemId: string; attachmentId: string },
    unknown
  >;
  deleteItem: CollectionOfflineOperationDefinition<
    { value: { name: string } },
    string,
    { itemId: string },
    unknown
  >;
};

/**
 * Collection where `attachFile` depends on a staged upload and `deleteItem`
 * supersedes the queued edits of the item it deletes.
 */
function createAttachmentCollectionEnv(args: {
  storeManager: UploadCleanupStoreManager;
  storeName: string;
  replayedOperations: string[];
}) {
  const env = createCollectionStoreTestEnv<
    { name: string },
    AttachmentCollectionOperations
  >(
    { 'items||1': { name: 'Ada' } },
    {
      id: args.storeName,
      storeManager: args.storeManager,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: collectionSchema,
        payloadSchema: rc_string,
        offline: {
          operations: {
            attachFile: {
              inputSchema: rc_object({
                itemId: rc_string,
                attachmentId: rc_string,
              }),
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              dependsOnUploads: ({ input }) => [input.attachmentId],
              execute: () => {
                args.replayedOperations.push(`${args.storeName}:attachFile`);
                return Promise.resolve(undefined);
              },
              onSuccessExecute: () => {},
            },
            deleteItem: {
              inputSchema: deleteItemInputSchema,
              kind: 'delete',
              getEntityRefs: ({ input }) => [input.itemId],
              supersedes: { scope: 'same-entity' },
              execute: () => {
                args.replayedOperations.push(`${args.storeName}:deleteItem`);
                return Promise.resolve(undefined);
              },
              onSuccessExecute: ({ input }) => {
                env.apiStore.deleteItemState(input.itemId);
              },
            },
          },
        },
      },
    },
  );

  async function queueAttachFile(attachmentId: string): Promise<void> {
    await resolveWithin(
      env.apiStore.performMutation('items||1', {
        optimisticUpdate: () => {},
        mutation: () => Promise.resolve(undefined),
        offline: {
          operation: 'attachFile',
          input: { itemId: 'items||1', attachmentId },
        },
      }),
    );
  }

  async function queueDeleteItem(): Promise<void> {
    await resolveWithin(
      env.apiStore.performMutation('items||1', {
        optimisticUpdate: () => {
          env.apiStore.deleteItemState('items||1');
        },
        mutation: () => Promise.resolve(undefined),
        offline: { operation: 'deleteItem', input: { itemId: 'items||1' } },
      }),
    );
  }

  return { ...env, queueAttachFile, queueDeleteItem };
}

test('a queued edit superseded by a delete releases its staged upload, and keeps a file no mutation used yet', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  network.setOffline();
  const storeManager = createUploadCleanupStoreManager(
    'offline-upload-supersede-session',
  );
  const replayedOperations: string[] = [];
  const env = createAttachmentCollectionEnv({
    storeManager,
    storeName: 'offline-upload-supersede-items',
    replayedOperations,
  });
  await flushAllTimers();

  // --- Setup: one file used by a queued edit, one not used by anything yet ---
  await stageUpload(storeManager, 'attachment-1');
  await stageUpload(storeManager, 'draft-asset');
  await env.queueAttachFile('attachment-1');

  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`
    "tsdf-uploads (0.97 kb)
    └ offline-upload-supersede-session (0.95 kb)
      ├ attachment-1 (0.45 kb)
      │ ├ binary.blob (0.06 kb)
      │ └ metadata.json (0.37 kb)
      └ draft-asset (0.44 kb)
        ├ binary.blob (0.05 kb)
        └ metadata.json (0.36 kb)"
  `);

  // --- Action: deleting the item prunes the queued edit that needed the file ---
  await env.queueDeleteItem();

  // The pruned edit will never replay, so `attachment-1` is removed while
  // still offline. `draft-asset` was never referenced and stays.
  expect(getStagedUploads(storeManager)).toMatchInlineSnapshot(
    `- { id: 'draft-asset', source: 'manual', state: 'pending' }`,
  );
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`
    "tsdf-uploads (0.53 kb)
    └ offline-upload-supersede-session (0.50 kb)
      └ draft-asset (0.44 kb)
        ├ binary.blob (0.05 kb)
        └ metadata.json (0.36 kb)"
  `);

  // Only the delete is replayed after reconnecting, and the unused file is
  // still waiting for its mutation.
  await reconnect();
  expect(replayedOperations).toMatchInlineSnapshot(
    `['offline-upload-supersede-items:deleteItem']`,
  );
  expect(getStagedUploads(storeManager)).toMatchInlineSnapshot(
    `- { id: 'draft-asset', source: 'manual', state: 'pending' }`,
  );
});

test('an upload shared by queued mutations of two stores survives until the last one is gone', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  network.setOffline();
  const storeManager = createUploadCleanupStoreManager(
    'offline-upload-shared-session',
  );
  const replayedOperations: string[] = [];
  const tasks = createAttachmentCollectionEnv({
    storeManager,
    storeName: 'offline-upload-shared-tasks',
    replayedOperations,
  });
  const notes = createAttachmentCollectionEnv({
    storeManager,
    storeName: 'offline-upload-shared-notes',
    replayedOperations,
  });
  await flushAllTimers();

  // --- Setup: the same staged file is attached to a task and to a note ---
  await stageUpload(storeManager, 'shared-asset');
  await tasks.queueAttachFile('shared-asset');
  await notes.queueAttachFile('shared-asset');

  // --- Action 1: the task (and its queued edit) is deleted ---
  await tasks.queueDeleteItem();

  // The note's queued edit lives in another store but still needs the file,
  // so it must not be deleted yet.
  expect(getStagedUploads(storeManager)).toMatchInlineSnapshot(
    `- { id: 'shared-asset', source: 'manual', state: 'pending' }`,
  );
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`
    "tsdf-uploads (0.52 kb)
    └ offline-upload-shared-session (0.50 kb)
      └ shared-asset (0.44 kb)
        ├ binary.blob (0.06 kb)
        └ metadata.json (0.36 kb)"
  `);

  // --- Action 2: the note is deleted too ---
  await notes.queueDeleteItem();

  // No queued work references the file anymore.
  expect(getStagedUploads(storeManager)).toMatchInlineSnapshot(`[]`);
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`"empty"`);
});

type AttachmentsConflictOperations = {
  saveAttachments: DocumentOfflineOperationDefinition<
    { value: number },
    {
      input: { attachmentIds: string[]; value: number };
      conflict: { reason: string };
    }
  >;
};

/**
 * Document whose `saveAttachments` mutation depends on several staged uploads
 * and reports a conflict for `value: 2` instead of executing.
 */
function createAttachmentsConflictEnv(args: {
  storeManager: UploadCleanupStoreManager;
  storeName: string;
  executedRefs: unknown[];
}) {
  const env = createDocumentStoreTestEnv<number, AttachmentsConflictOperations>(
    1,
    {
      id: args.storeName,
      storeManager: args.storeManager,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          operations: {
            saveAttachments: {
              inputSchema: rc_object({
                attachmentIds: rc_array(rc_string),
                value: rc_number,
              }),
              kind: 'update',
              dependsOnUploads: ({ input }) => input.attachmentIds,
              execute: (ctx) => {
                args.executedRefs.push(ctx.uploads.resolvedRefsById);
                return Promise.resolve({ value: ctx.input.value });
              },
              onSuccessExecute: ({ input }) => {
                env.apiStore.updateState((draft) => {
                  draft.value = input.value;
                });
              },
              conflictHandling: {
                schema: docConflictSchema,
                detectConflict: ({ input }) =>
                  input.value === 2 ? { reason: 'server-changed' } : false,
              },
            },
          },
        },
      },
    },
  );

  /** Queues the conflicting mutation and replays it into a conflict record. */
  async function queueConflictingMutation(attachmentIds: string[]) {
    await resolveWithin(
      env.apiStore.performMutation({
        optimisticUpdate: () => {
          env.apiStore.updateState((draft) => {
            draft.value = 2;
          });
        },
        mutation: () => Promise.resolve({ value: 2 }),
        offline: {
          operation: 'saveAttachments',
          input: { attachmentIds, value: 2 },
        },
      }),
    );
    await reconnect();

    const [conflict] = env.apiStore.getOfflineResolutions();
    if (!conflict || conflict.kind !== 'conflict') {
      throw new Error('Expected the replay to stop on a conflict');
    }
    return conflict;
  }

  return { ...env, queueConflictingMutation };
}

test('requeueing a conflict deletes the staged uploads the replacement no longer uses and keeps the ones it still needs', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  network.setOffline();
  const storeManager = createUploadCleanupStoreManager(
    'offline-upload-requeue-session',
  );
  const executedRefs: unknown[] = [];
  const env = createAttachmentsConflictEnv({
    storeManager,
    storeName: 'offline-upload-requeue-doc',
    executedRefs,
  });
  await flushAllTimers();

  // --- Setup: a mutation with two files stops on a conflict ---
  await stageUpload(storeManager, 'attachment-a');
  await stageUpload(storeManager, 'attachment-b');
  const conflict = await env.queueConflictingMutation([
    'attachment-a',
    'attachment-b',
  ]);

  // A conflict is detected before anything is uploaded, so both files are
  // still waiting.
  expect(getStagedUploads(storeManager)).toMatchInlineSnapshot(`
    - { id: 'attachment-a', source: 'manual', state: 'pending' }
    - { id: 'attachment-b', source: 'manual', state: 'pending' }
  `);

  // Go back offline so the replacement stays queued and its uploads can be
  // inspected before it replays.
  await act(async () => {
    network.goOffline();
    await Promise.resolve();
  });
  await stageUpload(storeManager, 'attachment-c');

  // --- Action: the replacement drops `attachment-a` and adds `attachment-c` ---
  await resolveWithin(
    env.apiStore.resolveOfflineResolution(conflict.id, 'saveAttachments', {
      action: 'requeue',
      input: { attachmentIds: ['attachment-b', 'attachment-c'], value: 3 },
    }),
  );

  // Only the file the replacement stopped using is deleted.
  expect(getStagedUploads(storeManager)).toMatchInlineSnapshot(`
    - { id: 'attachment-b', source: 'manual', state: 'pending' }
    - { id: 'attachment-c', source: 'manual', state: 'pending' }
  `);
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`
    "tsdf-uploads (0.97 kb)
    └ offline-upload-requeue-session (0.95 kb)
      ├ attachment-b (0.44 kb)
      │ ├ binary.blob (0.06 kb)
      │ └ metadata.json (0.36 kb)
      └ attachment-c (0.44 kb)
        ├ binary.blob (0.06 kb)
        └ metadata.json (0.36 kb)"
  `);

  // --- Replay: the replacement uploads and consumes the files it kept ---
  await reconnect();

  expect(executedRefs).toMatchInlineSnapshot(
    `- { attachment-b: 'server:attachment-b', attachment-c: 'server:attachment-c' }`,
  );
  expect(getStagedUploads(storeManager)).toMatchInlineSnapshot(`[]`);
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`"empty"`);
});

test('committing a conflict without replaying it deletes the staged uploads it depended on', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  network.setOffline();
  const storeManager = createUploadCleanupStoreManager(
    'offline-upload-commit-session',
  );
  const executedRefs: unknown[] = [];
  const env = createAttachmentsConflictEnv({
    storeManager,
    storeName: 'offline-upload-commit-doc',
    executedRefs,
  });
  await flushAllTimers();

  // --- Setup: a mutation with a staged file stops on a conflict ---
  await stageUpload(storeManager, 'attachment-a');
  const conflict = await env.queueConflictingMutation(['attachment-a']);

  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`
    "tsdf-uploads (0.52 kb)
    └ offline-upload-commit-session (0.50 kb)
      └ attachment-a (0.44 kb)
        ├ binary.blob (0.06 kb)
        └ metadata.json (0.36 kb)"
  `);

  // --- Action: the user accepts the current state instead of replaying ---
  await resolveWithin(
    env.apiStore.resolveOfflineResolution(conflict.id, 'saveAttachments', {
      action: 'commit',
    }),
  );

  // The mutation is settled without ever executing, so its file has no
  // consumer left.
  expect(executedRefs).toMatchInlineSnapshot(`[]`);
  expect(getStagedUploads(storeManager)).toMatchInlineSnapshot(`[]`);
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`"empty"`);
});

test('files attached directly to a mutation are deleted when that mutation is discarded', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  network.setOffline();
  const storeManager = createUploadCleanupStoreManager(
    'offline-direct-upload-discard-session',
  );

  const env = createDocumentStoreTestEnv<number, DirectUploadUpdateOperations>(
    1,
    {
      id: 'offline-direct-upload-discard-doc',
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
              execute: () =>
                Promise.reject(new Error('server rejected the file')),
              onSuccessExecute: () => {},
            },
          },
        },
      },
    },
  );
  await flushAllTimers();

  // --- Setup: the file travels with the mutation instead of being staged ---
  await resolveWithin(
    env.apiStore.performMutation({
      optimisticUpdate: () => {},
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
  await reconnect();

  const [resolution] = env.apiStore.getOfflineResolutions();
  if (!resolution) {
    throw new Error('Expected the failed replay to require a resolution');
  }
  // The attached file is kept while the user can still retry.
  expect(
    storeManager
      .getOfflineUploads()
      .map((upload) => pick(upload, ['source', 'state'])),
  ).toMatchInlineSnapshot(`- { source: 'mutation', state: 'pending' }`);

  // --- Action: the user gives up on the mutation ---
  await resolveWithin(
    env.apiStore.resolveOfflineResolution(resolution.id, 'updateValue', {
      action: 'discard',
    }),
  );

  expect(storeManager.getOfflineUploads()).toMatchInlineSnapshot(`[]`);
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`"empty"`);
});
