import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { DocumentOfflineOperationDefinition } from '../../src/main';
import {
  clearSessionStorage,
  createStoreManager,
  opfsOfflineUploadAdapter,
} from '../../src/main';
import { encodePathSegment } from '../../src/persistentStorage/opfsFileNaming';
import { createOfflineNetworkMock } from '../../src/testing';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createMockBrowserOpfs } from '../mocks/mockBrowserOpfs';
import { normalizeError, TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import {
  advanceTime,
  flushAllTimers,
  pick,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import {
  getOpfsDirTree,
  getParsedOpfsFileData,
} from '../utils/persistentStorageOptimizationTestUtils';
import { resetSessionForTests } from '../utils/resetSessionForTests';
import { docSchema } from './offlineTestShared';

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
