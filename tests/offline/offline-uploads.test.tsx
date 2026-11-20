import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_array, rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type {
  CollectionOfflineOperationDefinition,
  DocumentOfflineOperationDefinition,
  ListQueryOfflineOperationDefinition,
  OfflineSessionConfig,
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
  getOfflineQueueEntries,
  getOfflineQueueEntryData,
  getSortedQueueSummary,
  userRowSchema,
} from './offlineReplayTestShared';
import {
  classifyRetryableReplayFailure,
  collectionSchema,
  docConflictSchema,
  docSchema,
  getGlobalOfflineStatusSummary,
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

function createOpfsUploadSession(sessionKey: string) {
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

function textFile(content: string, name: string, lastModified: number): File {
  return new File([content], name, { type: 'text/plain', lastModified });
}

/**
 * Simulates a previous app run that staged the given uploads and was then
 * closed, so the next session has to restore them from storage on startup.
 */
async function stageUploadsInPreviousAppRun(
  sessionKey: string,
  filesById: Record<string, File>,
): Promise<void> {
  const previousSession = createOpfsUploadSession(sessionKey);
  await flushAllTimers();

  for (const [id, file] of Object.entries(filesById)) {
    (
      await resolveAfterAllTimers(
        previousSession.saveOfflineUpload({ id, file }),
      )
    ).unwrap();
  }
  await flushAllTimers();

  resetSessionForTests();
}

test('a file staged while the session is still restoring stored uploads is listed together with the restored ones', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  const sessionKey = 'offline-upload-hydration-save-session';

  // Stay offline so the staged uploads are kept pending.
  network.setOffline();
  await stageUploadsInPreviousAppRun(sessionKey, {
    'staged-in-previous-run': textFile('old body', 'old.txt', 1),
  });

  // App startup: mounting the uploads hook starts the session, which begins
  // restoring the stored uploads in the background...
  const session = createOpfsUploadSession(sessionKey);
  const uploadHook = renderHook(() => session.useOfflineUploads());

  // ...and the user attaches a new file right away, before the restore
  // finished.
  (
    await resolveAfterAllTimers(
      session.saveOfflineUpload({
        id: 'staged-during-startup',
        file: textFile('new body', 'new.txt', 2),
      }),
    )
  ).unwrap();
  await flushAllTimers();

  // Both the restored upload and the one staged during startup are listed.
  // Apps derive the upload dependency ids of their mutations from this list,
  // so a missing entry would leave the new file out of the next mutation.
  expect(
    uploadHook.result.current.map((upload) =>
      pick(upload, ['id', 'fileName', 'state']),
    ),
  ).toMatchInlineSnapshot(`
    - { fileName: 'new.txt', id: 'staged-during-startup', state: 'pending' }
    - { fileName: 'old.txt', id: 'staged-in-previous-run', state: 'pending' }
  `);
  expect(
    session.getOfflineUploads().map((upload) => upload.id),
  ).toMatchInlineSnapshot(
    `['staged-during-startup', 'staged-in-previous-run']`,
  );
  // The list matches what is stored.
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`
    "tsdf-uploads (1.01 kb)
    └ offline-upload-hydration-save-session (0.98 kb)
      ├ staged-during-startup (0.45 kb)
      │ ├ binary.blob (0.04 kb)
      │ └ metadata.json (0.38 kb)
      └ staged-in-previous-run (0.46 kb)
        ├ binary.blob (0.04 kb)
        └ metadata.json (0.38 kb)"
  `);

  uploadHook.unmount();
});

test('an upload deleted while the session is still restoring stored uploads does not come back', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  const sessionKey = 'offline-upload-hydration-delete-session';

  network.setOffline();
  await stageUploadsInPreviousAppRun(sessionKey, {
    'discarded-draft': textFile('draft body', 'draft.txt', 1),
    'kept-attachment': textFile('attachment body', 'attachment.txt', 2),
  });

  // One of the stored uploads is slow to read, so the restore is still running
  // well after the other one was already read from storage.
  mockBrowserOpfs.setReadDelay(
    'tsdf-uploads/offline-upload-hydration-delete-session/kept-attachment',
    200,
  );

  // App startup: the stored uploads are being restored in the background...
  const session = createOpfsUploadSession(sessionKey);
  const uploadHook = renderHook(() => session.useOfflineUploads());
  await advanceTime(20);

  // ...while the app discards the draft attachment it knows by id.
  (
    await resolveAfterAllTimers(session.deleteOfflineUpload('discarded-draft'))
  ).unwrap();
  await flushAllTimers();

  // The deleted upload must not be listed again once the restore finishes,
  // otherwise the app would offer a file that no longer exists in storage.
  expect(
    uploadHook.result.current.map((upload) =>
      pick(upload, ['id', 'fileName', 'state']),
    ),
  ).toMatchInlineSnapshot(
    `- { fileName: 'attachment.txt', id: 'kept-attachment', state: 'pending' }`,
  );
  expect(
    session.getOfflineUploads().map((upload) => upload.id),
  ).toMatchInlineSnapshot(`['kept-attachment']`);
  // The list matches what is stored.
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`
    "tsdf-uploads (0.56 kb)
    └ offline-upload-hydration-delete-session (0.54 kb)
      └ kept-attachment (0.46 kb)
        ├ binary.blob (0.05 kb)
        └ metadata.json (0.38 kb)"
  `);

  uploadHook.unmount();
});

test('replacing a file while the session is still restoring stored uploads updates the stored upload instead of starting a new one', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'offline-upload-hydration-replace-session';

  network.setOffline();
  await stageUploadsInPreviousAppRun(sessionKey, {
    attachment: textFile('first draft', 'draft.txt', 1),
  });

  // The app stays closed for an hour.
  await advanceTime(60 * 60 * 1000);

  // App startup: the stored uploads are being restored in the background...
  const session = createOpfsUploadSession(sessionKey);
  const uploadHook = renderHook(() => session.useOfflineUploads());

  // ...and the user picks another file for the same attachment right away.
  (
    await resolveAfterAllTimers(
      session.replaceOfflineUpload({
        id: 'attachment',
        file: textFile('final version', 'final.txt', 2),
      }),
    )
  ).unwrap();
  await flushAllTimers();

  // The replacement is applied on top of the stored upload: the file changes,
  // while `createdAt` still is the time the upload was first staged, an hour
  // before the replacement (`updatedAt`).
  expect(
    uploadHook.result.current.map((upload) => ({
      ...pick(upload, ['id', 'fileName', 'state']),
      createdAt: new Date(upload.createdAt).toISOString(),
      updatedAt: new Date(upload.updatedAt).toISOString(),
    })),
  ).toMatchInlineSnapshot(`
    - createdAt: '2025-01-01T00:00:00.003Z'
      fileName: 'final.txt'
      id: 'attachment'
      state: 'pending'
      updatedAt: '2025-01-01T01:00:12.013Z'
  `);
  expect(
    getParsedOpfsFileData(
      'tsdf-uploads/offline-upload-hydration-replace-session/attachment/binary.blob',
    ),
  ).toMatchInlineSnapshot(`"final version"`);

  uploadHook.unmount();
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

type AccumulatedAttachmentsOperations = {
  setAttachments: DocumentOfflineOperationDefinition<
    { value: number },
    { input: { attachmentIds: string[]; value: number } }
  >;
};

test('offline edits merged into one queued mutation upload the files added by every edit before replaying', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'offline-upload-accumulation-session';
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
          replayEvents.push(`upload-start:${id}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
          replayEvents.push(`upload-finish:${id}`);
          return `server:${id}`;
        },
      },
    },
  });

  const env = createDocumentStoreTestEnv<
    number,
    AccumulatedAttachmentsOperations
  >(1, {
    id: 'offline-upload-accumulation-doc',
    storeManager,
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        operations: {
          setAttachments: {
            inputSchema: rc_object({
              attachmentIds: rc_array(rc_string),
              value: rc_number,
            }),
            kind: 'update',
            dependsOnUploads: ({ input }) => input.attachmentIds,
            // Queued edits of the document are merged into a single entry:
            // files accumulate, the latest value wins.
            accumulation: {
              mergeInput: ({ existingInput, incomingInput }) => ({
                attachmentIds: [
                  ...existingInput.attachmentIds,
                  ...incomingInput.attachmentIds,
                ],
                value: incomingInput.value,
              }),
            },
            execute: async (ctx) => {
              replayEvents.push(
                `execute:${ctx.input.attachmentIds
                  .map((id) => JSON.stringify(ctx.uploads.resolvedRefsById[id]))
                  .join(',')}`,
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
  });

  await flushAllTimers();

  async function attachFileOffline(uploadId: string, value: number) {
    (
      await resolveAfterAllTimers(
        storeManager.saveOfflineUpload({
          id: uploadId,
          file: new File([`body of ${uploadId}`], `${uploadId}.txt`, {
            type: 'text/plain',
            lastModified: 1,
          }),
        }),
      )
    ).unwrap();

    await resolveAfterAllTimers(
      env.apiStore.performMutation({
        optimisticUpdate: () => {
          env.apiStore.updateState((draft) => {
            draft.value = value;
          });
        },
        mutation: () => Promise.resolve({ value }),
        offline: {
          operation: 'setAttachments',
          input: { attachmentIds: [uploadId], value },
        },
      }),
    );
  }

  // Two offline edits, each adding one file. They are merged into one queued
  // mutation whose input references both files.
  await attachFileOffline('file-1', 2);
  await attachFileOffline('file-2', 3);

  expect(
    getOfflineQueueEntries(sessionKey, 'offline-upload-accumulation-doc').map(
      (entry) => getOfflineQueueEntryData(entry).input,
    ),
  ).toMatchInlineSnapshot(`
    - attachmentIds: ['file-1', 'file-2']
      value: 3
  `);

  // Reconnect: both files must be uploaded before the merged mutation runs,
  // and it must receive the server ref of each one (not the local upload id).
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await flushAllTimers();
  await act(async () => {
    await Promise.resolve();
  });
  await flushAllTimers();

  expect(replayEvents).toMatchInlineSnapshot(`
    - 'upload-start:file-1'
    - 'upload-start:file-2'
    - 'upload-finish:file-1'
    - 'upload-finish:file-2'
    - 'execute:"server:file-1","server:file-2"'
  `);
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
 * Error thrown by the upload transport in the failure-handling tests below. A
 * real transport throws whatever its HTTP client throws; what matters is that
 * the session classifiers can tell a connection problem, a server outage and a
 * rejected file apart.
 */
class UploadTransportError extends Error {
  kind: 'connection' | 'server-down' | 'rejected-file';

  constructor(kind: UploadTransportError['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Recovery probes at 5s, 10s, 20s, ... without random jitter. */
const deterministicRecoveryProbe = {
  initialIntervalMs: 5_000,
  maxIntervalMs: 60_000,
  backoffMultiplier: 2,
  jitterRatio: 0,
} as const;

/**
 * Document store with one `updateWithAttachment` offline operation that
 * depends on a staged upload, plus a scripted upload transport.
 *
 * The timeline (`env.timelineString`) tracks what a UI would show: the upload
 * state (and its last error), the sync state of the dependent operation and
 * the session connectivity mode. `requests` lists what reached the server.
 */
function createUploadFailureTestEnv({
  sessionKey,
  storeId,
  offlineSession,
  uploadAttempts,
}: {
  sessionKey: string;
  storeId: string;
  /** Session classifiers and modes under test (the uploads config is added here). */
  offlineSession: Omit<OfflineSessionConfig<string>, 'uploads'>;
  /** Outcome of each transport call, in order. Calls past the end succeed. */
  uploadAttempts: Array<UploadTransportError | 'success'>;
}) {
  const requests: string[] = [];
  let transportCalls = 0;

  const storeManager = createStoreManager({
    getSessionKey: () => sessionKey,
    errorNormalizer: normalizeError,
    offlineSession: {
      ...offlineSession,
      uploads: {
        adapter: opfsOfflineUploadAdapter,
        upload: async ({ id }) => {
          const outcome = uploadAttempts[transportCalls] ?? 'success';
          transportCalls += 1;
          // Every upload request takes 200ms to succeed or fail.
          await new Promise((resolve) => setTimeout(resolve, 200));

          if (outcome !== 'success') {
            requests.push(`upload ${id} -> ${outcome.message}`);
            throw outcome;
          }

          requests.push(`upload ${id} -> server:${id}`);
          return `server:${id}`;
        },
      },
    },
  });

  const env = createDocumentStoreTestEnv<number, UploadDependencyOperations>(
    1,
    {
      id: storeId,
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
                requests.push(
                  `execute updateWithAttachment with ${JSON.stringify(resolvedRef)}`,
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

  const uiHook = renderHook(() => {
    const uploads = storeManager.useOfflineUploads();
    const upload = uploads[0];
    const entity = env.apiStore.useOfflineEntities()[0];
    const status = storeManager.useOfflineStatus();

    const uploadLabel = upload
      ? `${upload.state}${upload.lastError ? ` (${upload.lastError.message})` : ''}`
      : 'none';
    const sessionLabel = status.outage.active
      ? 'outage'
      : status.network.active
        ? 'network-offline'
        : 'online';

    env.trackUIChanges(
      `upload:${uploadLabel} | op:${entity?.syncState ?? 'none'} | session:${sessionLabel}`,
    );

    return uploads;
  });

  // The calls below run inside `act` because the tracked UI re-renders
  // synchronously with them.
  async function stageDependencyUpload() {
    await act(async () => {
      (
        await resolveAfterAllTimers(
          storeManager.saveOfflineUpload({
            id: 'asset-1',
            file: new File(['attachment body'], 'attachment.txt', {
              type: 'text/plain',
              lastModified: 1,
            }),
          }),
        )
      ).unwrap();
    });
  }

  return {
    env,
    requests,
    unmount: () => uiHook.unmount(),
    /** Uploads as the UI currently sees them through `useOfflineUploads()`. */
    getUploads: () => uiHook.result.current,
    /** Stages the `asset-1` file without queueing anything that depends on it. */
    stageUpload: stageDependencyUpload,
    /** Stages the `asset-1` upload and queues the mutation that depends on it. */
    async stageUploadAndQueueDependentMutation() {
      await stageDependencyUpload();
      await act(async () => {
        await resolveAfterAllTimers(
          env.apiStore.performMutation({
            mutation: () => Promise.resolve({ value: 3 }),
            offline: {
              operation: 'updateWithAttachment',
              input: { attachmentId: 'asset-1', value: 3 },
            },
          }),
        );
      });
    },
    /** Uploads the staged `asset-1` file through the online path. */
    resolveUploadOnline() {
      return act(async () => {
        const pendingResult = storeManager.resolveOfflineUpload('asset-1');
        // Covers the 200ms transport request without reaching the one-week
        // retention timer of unreferenced uploads.
        await advanceTime(1_000);
        return pendingResult;
      });
    },
  };
}

test('a dependency upload that fails with a connection error stays pending and is uploaded again once the network recovers', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'upload-connection-failure-session';
  let uploadEndpointReachable = false;
  const classifiedFailures: unknown[] = [];

  // The browser starts offline so the upload and its mutation are queued.
  network.setOffline();

  const { env, requests, unmount, ...actions } = createUploadFailureTestEnv({
    sessionKey,
    storeId: 'upload-connection-failure-doc',
    offlineSession: {
      // The session treats connection errors as "network is down", exactly
      // like it does for a failed `execute`.
      classifyFailure: (error, ctx) => {
        classifiedFailures.push(ctx);
        return error instanceof UploadTransportError &&
          error.kind === 'connection'
          ? 'network'
          : 'ignore';
      },
      network: {
        ...network.config,
        recoveryCheck: () => uploadEndpointReachable,
        recoveryProbe: deterministicRecoveryProbe,
      },
    },
    // The browser reports online, but the upload endpoint is unreachable.
    uploadAttempts: [
      new UploadTransportError('connection', 'Upload failed: Network error'),
    ],
  });
  await flushAllTimers();
  env.clearTimeline();

  await actions.stageUploadAndQueueDependentMutation();

  env.addTimelineComments('beforeNextAction', [
    'browser reconnects, but the upload endpoint is still unreachable',
  ]);
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  // Long enough for three failed recovery probes (after 5s, 15s and 35s).
  await advanceTime(40_000);

  // The classifier is told which upload failed, on top of the usual context
  // of the operation that was being replayed.
  expect(classifiedFailures).toMatchInlineSnapshot(`
    - operationName: 'updateWithAttachment'
      phase: 'sync'
      sessionKey: 'upload-connection-failure-session'
      storeType: 'document'
      uploadId: 'asset-1'
  `);

  // The upload was attempted once and the operation never reached the server.
  expect(requests).toMatchInlineSnapshot(
    `['upload asset-1 -> Upload failed: Network error']`,
  );

  // The upload is waiting to be sent again (not failed), the operation is
  // still queued and nothing asks the user for manual resolution.
  expect(
    actions
      .getUploads()
      .map((upload) => pick(upload, ['id', 'state', 'lastError'])),
  ).toMatchInlineSnapshot(`
    - id: 'asset-1'
      lastError: { message: 'Upload failed: Network error' }
      state: 'pending'
  `);
  expect(
    env.apiStore
      .getOfflineEntities()
      .map((entity) =>
        pick(entity, ['syncState', 'pendingMutations', 'requiresResolution']),
      ),
  ).toMatchInlineSnapshot(
    `- { pendingMutations: 1, requiresResolution: '❌', syncState: 'pending' }`,
  );
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);

  env.addTimelineComments('beforeNextAction', [
    'the upload endpoint is reachable again; the next recovery probe notices it',
  ]);
  uploadEndpointReachable = true;
  // The backoff puts the next probe 40s after the previous one.
  await advanceTime(40_000);

  // The upload ran again and the operation executed exactly once, with the
  // ref returned by the successful upload.
  expect(requests).toMatchInlineSnapshot(`
    - 'upload asset-1 -> Upload failed: Network error'
    - 'upload asset-1 -> server:asset-1'
    - 'execute updateWithAttachment with "server:asset-1"'
  `);

  // The operation that depended on the upload was sent, so the staged file
  // was deleted. The timeline above shows it reached `uploaded` without the
  // earlier error before that.
  expect(
    actions
      .getUploads()
      .map((upload) =>
        pick(upload, ['id', 'state', 'resolvedRef', 'lastError']),
      ),
  ).toMatchInlineSnapshot(`[]`);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time    | ui                                                                                     |
    12s     | -                                                                                      | -- timeline-cleared
    12.009s | "upload:pending | op:none | session:network-offline"                                   | ui-changed
    .       | "upload:pending | op:pending | session:network-offline"                                | ui-changed
    .       | "upload:pending | op:pending | session:network-offline"                                | offline:updateWithAttachment queued
    .       | "upload:pending | op:pending | session:network-offline"                                | -- browser reconnects, but the upload endpoint is still unreachable
    .       | "upload:pending | op:pending | session:online"                                         | ui-changed
    .       | "upload:pending | op:syncing | session:online"                                         | ui-changed
    12.018s | "upload:uploading | op:syncing | session:online"                                       | ui-changed
    12.227s | "upload:pending (Upload failed: Network error) | op:syncing | session:online"          | ui-changed
    .       | "upload:pending (Upload failed: Network error) | op:syncing | session:network-offline" | ui-changed
    .       | "upload:pending (Upload failed: Network error) | op:pending | session:network-offline" | ui-changed
    87.227s | "upload:pending (Upload failed: Network error) | op:pending | session:network-offline" | -- the upload endpoint is reachable again; the next recovery probe notices it
    .       | "upload:pending (Upload failed: Network error) | op:pending | session:online"          | ui-changed
    .       | "upload:pending (Upload failed: Network error) | op:syncing | session:online"          | ui-changed
    87.236s | "upload:uploading (Upload failed: Network error) | op:syncing | session:online"        | ui-changed
    87.445s | "upload:uploaded | op:syncing | session:online"                                        | ui-changed
    .       | "upload:uploaded | op:syncing | session:online"                                        | offline:updateWithAttachment replay-started
    88.645s | "upload:uploaded | op:syncing | session:online"                                        | server-data-changed (value: 3)
    .       | "upload:uploaded | op:syncing | session:online"                                        | offline:updateWithAttachment replay-finished
    .       | "upload:uploaded | op:none | session:online"                                           | ui-changed
    88.647s | "upload:none | op:none | session:online"                                               | ui-changed
    "
  `);

  unmount();
});

test('a dependency upload failure classified as an outage puts the session in outage mode and is uploaded again after the outage ends', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'upload-outage-failure-session';
  let serverIsBack = false;

  network.setOffline();

  const { env, requests, unmount, ...actions } = createUploadFailureTestEnv({
    sessionKey,
    storeId: 'upload-outage-failure-doc',
    offlineSession: {
      classifyFailure: (error) =>
        error instanceof UploadTransportError && error.kind === 'server-down'
          ? 'outage'
          : 'ignore',
      network: network.config,
      outage: {
        enabled: true,
        recoveryCheck: () => serverIsBack,
        recoveryProbe: deterministicRecoveryProbe,
      },
    },
    uploadAttempts: [
      new UploadTransportError('server-down', 'Upload failed: 503'),
    ],
  });
  await flushAllTimers();
  env.clearTimeline();

  await actions.stageUploadAndQueueDependentMutation();

  env.addTimelineComments('beforeNextAction', [
    'browser reconnects while the upload service answers 503',
  ]);
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await advanceTime(40_000);

  // The session is in outage mode, the same as after an outage-classified
  // `execute` failure.
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '✅'
    network: { active: '❌', enabled: '✅' }
    outage: { active: '✅', enabled: '✅' }
    sessionKey: 'upload-outage-failure-session'
  `);

  // The upload keeps waiting and the operation stays queued without any
  // manual resolution, no matter how long the outage lasts.
  expect(
    actions
      .getUploads()
      .map((upload) => pick(upload, ['id', 'state', 'lastError'])),
  ).toMatchInlineSnapshot(`
    - id: 'asset-1'
      lastError: { message: 'Upload failed: 503' }
      state: 'pending'
  `);
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);

  env.addTimelineComments('beforeNextAction', [
    'the upload service is back; the next outage recovery probe notices it',
  ]);
  serverIsBack = true;
  await advanceTime(40_000);

  expect(requests).toMatchInlineSnapshot(`
    - 'upload asset-1 -> Upload failed: 503'
    - 'upload asset-1 -> server:asset-1'
    - 'execute updateWithAttachment with "server:asset-1"'
  `);
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '❌'
    network: { active: '❌', enabled: '✅' }
    outage: { active: '❌', enabled: '✅' }
    sessionKey: 'upload-outage-failure-session'
  `);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time    | ui                                                                    |
    12s     | -                                                                     | -- timeline-cleared
    12.009s | "upload:pending | op:none | session:network-offline"                  | ui-changed
    .       | "upload:pending | op:pending | session:network-offline"               | ui-changed
    .       | "upload:pending | op:pending | session:network-offline"               | offline:updateWithAttachment queued
    .       | "upload:pending | op:pending | session:network-offline"               | -- browser reconnects while the upload service answers 503
    .       | "upload:pending | op:pending | session:online"                        | ui-changed
    .       | "upload:pending | op:syncing | session:online"                        | ui-changed
    12.018s | "upload:uploading | op:syncing | session:online"                      | ui-changed
    12.227s | "upload:pending (Upload failed: 503) | op:syncing | session:online"   | ui-changed
    .       | "upload:pending (Upload failed: 503) | op:syncing | session:outage"   | ui-changed
    .       | "upload:pending (Upload failed: 503) | op:pending | session:outage"   | ui-changed
    87.227s | "upload:pending (Upload failed: 503) | op:pending | session:outage"   | -- the upload service is back; the next outage recovery probe notices it
    .       | "upload:pending (Upload failed: 503) | op:pending | session:online"   | ui-changed
    .       | "upload:pending (Upload failed: 503) | op:syncing | session:online"   | ui-changed
    87.236s | "upload:uploading (Upload failed: 503) | op:syncing | session:online" | ui-changed
    87.445s | "upload:uploaded | op:syncing | session:online"                       | ui-changed
    .       | "upload:uploaded | op:syncing | session:online"                       | offline:updateWithAttachment replay-started
    88.645s | "upload:uploaded | op:syncing | session:online"                       | server-data-changed (value: 3)
    .       | "upload:uploaded | op:syncing | session:online"                       | offline:updateWithAttachment replay-finished
    .       | "upload:uploaded | op:none | session:online"                          | ui-changed
    88.647s | "upload:none | op:none | session:online"                              | ui-changed
    "
  `);

  unmount();
});

test('a dependency upload failure marked as retryable is uploaded again on the replay retry cadence without failing the upload', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'upload-retryable-failure-session';

  network.setOffline();

  const { env, requests, unmount, ...actions } = createUploadFailureTestEnv({
    sessionKey,
    storeId: 'upload-retryable-failure-doc',
    offlineSession: {
      network: network.config,
      // A timeout is not a connectivity problem for the whole session, but
      // sending the upload again is safe.
      classifyRetryableFailure: (error, ctx) =>
        ctx.uploadId !== undefined &&
        error instanceof UploadTransportError &&
        error.kind === 'connection',
    },
    // Two timeouts, then the upload goes through.
    uploadAttempts: [
      new UploadTransportError('connection', 'Upload timed out'),
      new UploadTransportError('connection', 'Upload timed out'),
    ],
  });
  await flushAllTimers();
  env.clearTimeline();

  await actions.stageUploadAndQueueDependentMutation();

  env.addTimelineComments('beforeNextAction', [
    'browser reconnects; the first two upload attempts time out',
  ]);
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  // Replay retries every 5s by default: attempts at 0s, 5s and 10s.
  await advanceTime(15_000);

  // Two failures stayed below the default budget of 3, so the third attempt
  // uploaded the file and the operation executed once.
  expect(requests).toMatchInlineSnapshot(`
    - 'upload asset-1 -> Upload timed out'
    - 'upload asset-1 -> Upload timed out'
    - 'upload asset-1 -> server:asset-1'
    - 'execute updateWithAttachment with "server:asset-1"'
  `);
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  // The operation was sent, so the staged file it depended on was deleted.
  expect(
    actions
      .getUploads()
      .map((upload) =>
        pick(upload, ['id', 'state', 'resolvedRef', 'lastError']),
      ),
  ).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time    | ui                                                                           |
    12s     | -                                                                            | -- timeline-cleared
    12.009s | "upload:pending | op:none | session:network-offline"                         | ui-changed
    .       | "upload:pending | op:pending | session:network-offline"                      | ui-changed
    .       | "upload:pending | op:pending | session:network-offline"                      | offline:updateWithAttachment queued
    .       | "upload:pending | op:pending | session:network-offline"                      | -- browser reconnects; the first two upload attempts time out
    .       | "upload:pending | op:pending | session:online"                               | ui-changed
    .       | "upload:pending | op:syncing | session:online"                               | ui-changed
    12.018s | "upload:uploading | op:syncing | session:online"                             | ui-changed
    12.227s | "upload:pending (Upload timed out) | op:syncing | session:online"            | ui-changed
    .       | "upload:pending (Upload timed out) | op:needs-confirmation | session:online" | ui-changed
    17.227s | "upload:pending (Upload timed out) | op:syncing | session:online"            | ui-changed
    17.236s | "upload:uploading (Upload timed out) | op:syncing | session:online"          | ui-changed
    17.445s | "upload:pending (Upload timed out) | op:syncing | session:online"            | ui-changed
    .       | "upload:pending (Upload timed out) | op:needs-confirmation | session:online" | ui-changed
    22.445s | "upload:pending (Upload timed out) | op:syncing | session:online"            | ui-changed
    22.454s | "upload:uploading (Upload timed out) | op:syncing | session:online"          | ui-changed
    22.663s | "upload:uploaded | op:syncing | session:online"                              | ui-changed
    .       | "upload:uploaded | op:syncing | session:online"                              | offline:updateWithAttachment replay-started
    23.863s | "upload:uploaded | op:syncing | session:online"                              | server-data-changed (value: 3)
    .       | "upload:uploaded | op:syncing | session:online"                              | offline:updateWithAttachment replay-finished
    .       | "upload:uploaded | op:none | session:online"                                 | ui-changed
    23.865s | "upload:none | op:none | session:online"                                     | ui-changed
    "
  `);

  unmount();
});

test('a retryable dependency upload failure that keeps failing uses up the replay retry budget and then requires manual resolution', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'upload-retry-budget-session';
  const uploadTimeout = new UploadTransportError(
    'connection',
    'Upload timed out',
  );

  network.setOffline();

  const { env, requests, unmount, ...actions } = createUploadFailureTestEnv({
    sessionKey,
    storeId: 'upload-retry-budget-doc',
    offlineSession: {
      network: network.config,
      classifyRetryableFailure: (error) =>
        error instanceof UploadTransportError && error.kind === 'connection',
    },
    // As many timeouts as the default retry budget allows (3 failures).
    uploadAttempts: [uploadTimeout, uploadTimeout, uploadTimeout],
  });
  await flushAllTimers();
  env.clearTimeline();

  await actions.stageUploadAndQueueDependentMutation();

  env.addTimelineComments('beforeNextAction', [
    'browser reconnects; every upload attempt times out',
  ]);
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await advanceTime(60_000);

  // After the third failure nothing is retried anymore: the operation waits
  // for the user and the upload is reported as failed.
  expect(requests).toMatchInlineSnapshot(`
    - 'upload asset-1 -> Upload timed out'
    - 'upload asset-1 -> Upload timed out'
    - 'upload asset-1 -> Upload timed out'
  `);
  expect(env.apiStore.getOfflineResolutions().map(summarizeResolution))
    .toMatchInlineSnapshot(`
      - error: 'Upload timed out'
        input: 'attachmentId: "asset-1", value: 3'
        kind: 'retry-exhausted'
        on: 'document:document'
        op: 'updateWithAttachment'
    `);
  expect(
    actions
      .getUploads()
      .map((upload) => pick(upload, ['id', 'state', 'lastError'])),
  ).toMatchInlineSnapshot(`
    - id: 'asset-1'
      lastError: { message: 'Upload timed out' }
      state: 'failed'
  `);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time    | ui                                                                           |
    12s     | -                                                                            | -- timeline-cleared
    12.009s | "upload:pending | op:none | session:network-offline"                         | ui-changed
    .       | "upload:pending | op:pending | session:network-offline"                      | ui-changed
    .       | "upload:pending | op:pending | session:network-offline"                      | offline:updateWithAttachment queued
    .       | "upload:pending | op:pending | session:network-offline"                      | -- browser reconnects; every upload attempt times out
    .       | "upload:pending | op:pending | session:online"                               | ui-changed
    .       | "upload:pending | op:syncing | session:online"                               | ui-changed
    12.018s | "upload:uploading | op:syncing | session:online"                             | ui-changed
    12.227s | "upload:pending (Upload timed out) | op:syncing | session:online"            | ui-changed
    .       | "upload:pending (Upload timed out) | op:needs-confirmation | session:online" | ui-changed
    17.227s | "upload:pending (Upload timed out) | op:syncing | session:online"            | ui-changed
    17.236s | "upload:uploading (Upload timed out) | op:syncing | session:online"          | ui-changed
    17.445s | "upload:pending (Upload timed out) | op:syncing | session:online"            | ui-changed
    .       | "upload:pending (Upload timed out) | op:needs-confirmation | session:online" | ui-changed
    22.445s | "upload:pending (Upload timed out) | op:syncing | session:online"            | ui-changed
    22.454s | "upload:uploading (Upload timed out) | op:syncing | session:online"          | ui-changed
    22.663s | "upload:pending (Upload timed out) | op:syncing | session:online"            | ui-changed
    22.672s | "upload:failed (Upload timed out) | op:syncing | session:online"             | ui-changed
    .       | "upload:failed (Upload timed out) | op:syncing | session:online"             | offline:updateWithAttachment resolution-required
    .       | "upload:failed (Upload timed out) | op:resolution-required | session:online" | ui-changed
    "
  `);

  unmount();
});

test('a permanently rejected dependency upload sends the operation to manual resolution, where retry uploads the file again', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'upload-permanent-failure-session';

  network.setOffline();

  const { env, requests, unmount, ...actions } = createUploadFailureTestEnv({
    sessionKey,
    storeId: 'upload-permanent-failure-doc',
    // No classifier recognizes the error: it is neither a connectivity
    // problem nor safe to retry automatically, so it is a permanent failure.
    offlineSession: { network: network.config },
    uploadAttempts: [
      new UploadTransportError('rejected-file', 'File type not accepted'),
    ],
  });
  await flushAllTimers();
  env.clearTimeline();

  await actions.stageUploadAndQueueDependentMutation();

  env.addTimelineComments('beforeNextAction', [
    'browser reconnects and the server rejects the file',
  ]);
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  // Just the time the upload request takes: no retry timer is involved.
  await advanceTime(1_000);

  // The operation never executed and is now a resolution that carries the
  // upload error and points to the upload it depends on.
  expect(requests).toMatchInlineSnapshot(
    `['upload asset-1 -> File type not accepted']`,
  );
  const [resolution] = env.apiStore.getOfflineResolutions();
  if (!resolution || resolution.kind !== 'retry-exhausted') {
    throw new Error('Expected a retry-exhausted resolution');
  }
  expect(
    pick(resolution, [
      'kind',
      'operation',
      'lastReplayError',
      'dependencyUploadIds',
    ]),
  ).toMatchInlineSnapshot(`
    dependencyUploadIds: ['asset-1']
    kind: 'retry-exhausted'
    lastReplayError: { message: 'File type not accepted' }
    operation: 'updateWithAttachment'
  `);

  // The upload is marked as failed, with the error the transport reported.
  expect(
    actions
      .getUploads()
      .map((upload) => pick(upload, ['id', 'state', 'lastError'])),
  ).toMatchInlineSnapshot(`
    - id: 'asset-1'
      lastError: { message: 'File type not accepted' }
      state: 'failed'
  `);

  // Time passing does not retry a permanent failure on its own.
  await advanceTime(60_000);
  expect(requests).toHaveLength(1);

  env.addTimelineComments('beforeNextAction', [
    'the server now accepts the file and the user resolves with "retry"',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(
      resolution.id,
      'updateWithAttachment',
      { action: 'retry' },
    );
  });
  await advanceTime(5_000);

  // Retry uploaded the file again and then executed the operation once.
  expect(requests).toMatchInlineSnapshot(`
    - 'upload asset-1 -> File type not accepted'
    - 'upload asset-1 -> server:asset-1'
    - 'execute updateWithAttachment with "server:asset-1"'
  `);
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);

  // The operation that depended on the upload was sent, so the staged file
  // was deleted. The timeline above shows it reached `uploaded` without the
  // earlier error before that.
  expect(
    actions
      .getUploads()
      .map((upload) =>
        pick(upload, ['id', 'state', 'resolvedRef', 'lastError']),
      ),
  ).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time    | ui                                                                                 |
    12s     | -                                                                                  | -- timeline-cleared
    12.009s | "upload:pending | op:none | session:network-offline"                               | ui-changed
    .       | "upload:pending | op:pending | session:network-offline"                            | ui-changed
    .       | "upload:pending | op:pending | session:network-offline"                            | offline:updateWithAttachment queued
    .       | "upload:pending | op:pending | session:network-offline"                            | -- browser reconnects and the server rejects the file
    .       | "upload:pending | op:pending | session:online"                                     | ui-changed
    .       | "upload:pending | op:syncing | session:online"                                     | ui-changed
    12.018s | "upload:uploading | op:syncing | session:online"                                   | ui-changed
    12.227s | "upload:pending (File type not accepted) | op:syncing | session:online"            | ui-changed
    12.236s | "upload:failed (File type not accepted) | op:syncing | session:online"             | ui-changed
    .       | "upload:failed (File type not accepted) | op:syncing | session:online"             | offline:updateWithAttachment resolution-required
    .       | "upload:failed (File type not accepted) | op:resolution-required | session:online" | ui-changed
    73.009s | "upload:failed (File type not accepted) | op:resolution-required | session:online" | -- the server now accepts the file and the user resolves with "retry"
    .       | "upload:failed (File type not accepted) | op:pending | session:online"             | ui-changed
    .       | "upload:failed (File type not accepted) | op:syncing | session:online"             | ui-changed
    73.018s | "upload:uploading (File type not accepted) | op:syncing | session:online"          | ui-changed
    73.227s | "upload:uploaded | op:syncing | session:online"                                    | ui-changed
    .       | "upload:uploaded | op:syncing | session:online"                                    | offline:updateWithAttachment replay-started
    74.427s | "upload:uploaded | op:syncing | session:online"                                    | server-data-changed (value: 3)
    .       | "upload:uploaded | op:syncing | session:online"                                    | offline:updateWithAttachment replay-finished
    .       | "upload:uploaded | op:none | session:online"                                       | ui-changed
    74.429s | "upload:none | op:none | session:online"                                           | ui-changed
    "
  `);

  unmount();
});

test('discarding the resolution of a rejected dependency upload removes the operation without uploading again', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'upload-permanent-failure-discard-session';

  network.setOffline();

  const { env, requests, unmount, ...actions } = createUploadFailureTestEnv({
    sessionKey,
    storeId: 'upload-permanent-failure-discard-doc',
    offlineSession: { network: network.config },
    uploadAttempts: [
      new UploadTransportError('rejected-file', 'File is too large'),
    ],
  });
  await flushAllTimers();
  env.clearTimeline();

  await actions.stageUploadAndQueueDependentMutation();

  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await advanceTime(1_000);

  const [resolution] = env.apiStore.getOfflineResolutions();
  if (!resolution) throw new Error('Expected a resolution');
  expect(summarizeResolution(resolution)).toMatchInlineSnapshot(`
    error: 'File is too large'
    input: 'attachmentId: "asset-1", value: 3'
    kind: 'retry-exhausted'
    on: 'document:document'
    op: 'updateWithAttachment'
  `);

  // The discard resolves once the staged file was deleted from storage, which
  // needs the (fake) clock to move.
  await resolveWithin(
    env.apiStore.resolveOfflineResolution(
      resolution.id,
      'updateWithAttachment',
      { action: 'discard' },
    ),
  );
  await advanceTime(10_000);

  // The operation is gone and nothing else was sent to the server.
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(requests).toMatchInlineSnapshot(
    `['upload asset-1 -> File is too large']`,
  );

  // Nothing else depends on the staged file, so the discard deleted it too.
  expect(
    actions
      .getUploads()
      .map((upload) => pick(upload, ['id', 'state', 'lastError'])),
  ).toMatchInlineSnapshot(`[]`);

  unmount();
});

test('resolveOfflineUpload returns the transport error without touching the session mode and uploads again on the next call', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'upload-online-failure-session';
  const classifyFailure = vi.fn(() => 'network' as const);

  // The file is staged while the browser is offline.
  network.setOffline();

  const { env, requests, unmount, ...actions } = createUploadFailureTestEnv({
    sessionKey,
    storeId: 'upload-online-failure-doc',
    offlineSession: { classifyFailure, network: network.config },
    uploadAttempts: [
      new UploadTransportError('connection', 'Upload failed: Network error'),
    ],
  });
  await flushAllTimers();
  env.clearTimeline();

  await actions.stageUpload();

  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await advanceTime(0);

  // Back online, the app uploads the staged file itself instead of queueing
  // an operation that depends on it.
  env.addTimelineComments('beforeNextAction', [
    'app calls resolveOfflineUpload while the upload endpoint is unreachable',
  ]);
  const failedResult = await actions.resolveUploadOnline();

  // The caller gets the transport error back and decides what to do with it:
  // the session classifiers are not consulted and the session stays online.
  expect(
    failedResult.ok ? null : failedResult.error.message,
  ).toMatchInlineSnapshot(`"Upload failed: Network error"`);
  expect(classifyFailure).not.toHaveBeenCalled();
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '❌'
    network: { active: '❌', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'upload-online-failure-session'
  `);

  // Nothing retries on the app's behalf, so the upload is marked as failed.
  expect(
    actions
      .getUploads()
      .map((upload) => pick(upload, ['id', 'state', 'lastError'])),
  ).toMatchInlineSnapshot(`
    - id: 'asset-1'
      lastError: { message: 'Upload failed: Network error' }
      state: 'failed'
  `);

  // A failed upload is not blocked: resolving it again runs the transport
  // again, and the success clears the stored error.
  env.addTimelineComments('beforeNextAction', [
    'app calls resolveOfflineUpload again',
  ]);
  const retriedResult = await actions.resolveUploadOnline();

  expect(retriedResult.ok ? retriedResult.value : null).toMatchInlineSnapshot(
    `"server:asset-1"`,
  );
  expect(requests).toMatchInlineSnapshot(`
    - 'upload asset-1 -> Upload failed: Network error'
    - 'upload asset-1 -> server:asset-1'
  `);
  expect(
    actions
      .getUploads()
      .map((upload) =>
        pick(upload, ['id', 'state', 'resolvedRef', 'lastError']),
      ),
  ).toMatchInlineSnapshot(
    `- { id: 'asset-1', resolvedRef: 'server:asset-1', state: 'uploaded' }`,
  );
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time    | ui                                                                           |
    12s     | -                                                                            | -- timeline-cleared
    12.009s | "upload:pending | op:none | session:network-offline"                         | ui-changed
    .       | "upload:pending | op:none | session:online"                                  | ui-changed
    12.018s | "upload:pending | op:none | session:online"                                  | -- app calls resolveOfflineUpload while the upload endpoint is unreachable
    .       | "upload:uploading | op:none | session:online"                                | ui-changed
    12.227s | "upload:failed (Upload failed: Network error) | op:none | session:online"    | ui-changed
    13.018s | "upload:failed (Upload failed: Network error) | op:none | session:online"    | -- app calls resolveOfflineUpload again
    .       | "upload:uploading (Upload failed: Network error) | op:none | session:online" | ui-changed
    13.227s | "upload:uploaded | op:none | session:online"                                 | ui-changed
    "
  `);

  unmount();
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
