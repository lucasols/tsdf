import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type {
  DocumentOfflineOperationDefinition,
  OfflineSessionConfig,
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
import {
  docSchema,
  getGlobalOfflineStatusSummary,
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
  async function stageUpload() {
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
    stageUpload,
    /** Stages the `asset-1` upload and queues the mutation that depends on it. */
    async stageUploadAndQueueDependentMutation() {
      await stageUpload();
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

  // The successful upload no longer reports the earlier failure.
  expect(
    actions
      .getUploads()
      .map((upload) =>
        pick(upload, ['id', 'state', 'resolvedRef', 'lastError']),
      ),
  ).toMatchInlineSnapshot(
    `- { id: 'asset-1', resolvedRef: 'server:asset-1', state: 'uploaded' }`,
  );
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

  // The upload succeeded, so the previous error is gone.
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

  await act(async () => {
    await env.apiStore.resolveOfflineResolution(
      resolution.id,
      'updateWithAttachment',
      { action: 'discard' },
    );
  });
  await advanceTime(10_000);

  // The operation is gone and nothing else was sent to the server.
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(requests).toMatchInlineSnapshot(
    `['upload asset-1 -> File is too large']`,
  );

  // The staged file is left in place, still marked with its failure.
  expect(
    actions
      .getUploads()
      .map((upload) => pick(upload, ['id', 'state', 'lastError'])),
  ).toMatchInlineSnapshot(`
    - id: 'asset-1'
      lastError: { message: 'File is too large' }
      state: 'failed'
  `);

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
