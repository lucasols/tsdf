import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_number, rc_object } from 'runcheck';
import { expect, test, vi } from 'vitest';
import type { DocumentOfflineOperationDefinition } from '../../src/main';
import {
  clearAllSessionStorage,
  clearSessionStorage,
  createStoreManager,
  opfsOfflineUploadAdapter,
} from '../../src/main';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createMockBrowserOpfs } from '../mocks/mockBrowserOpfs';
import { normalizeError } from '../mocks/testEnvUtils';
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
// `clearAllSessionStorage` loads the built-in async adapters with a dynamic
// import, which can't finish while the fake timers are advanced unless the
// module is already loaded.
import '../../src/persistentStorage/asyncStorageAdapters';
import { docSchema } from './offlineTestShared';
import {
  getOfflineUploadOpfsPath,
  network,
  setupOfflineUploadTests,
  type DirectUploadUpdateOperations,
} from './offlineUploadsTestShared';

setupOfflineUploadTests();

const DIRECT_UPLOAD_ID_PATTERN =
  /^offline-direct-upload-doc:[^:]+:[^:]+:avatar$/;

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

test('clearAllSessionStorage on logout removes the staged uploads of a session not opened since the page loaded', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  const openedOrg = 'offline-upload-logout-opened-org';
  const otherOrg = 'offline-upload-logout-other-org';
  const keptOrg = 'offline-upload-logout-kept-org';

  function createOrgSession(sessionKey: string) {
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

  async function stagePhoto(
    session: ReturnType<typeof createOrgSession>,
  ): Promise<void> {
    (
      await resolveAfterAllTimers(
        session.saveOfflineUpload({
          id: 'photo',
          file: new File(['photo bytes'], 'photo.jpg', {
            type: 'image/jpeg',
            lastModified: 1,
          }),
        }),
      )
    ).unwrap();
  }

  // --- Setup: in an earlier page load the user staged a photo in each org ---
  for (const sessionKey of [openedOrg, otherOrg, keptOrg]) {
    await stagePhoto(createOrgSession(sessionKey));
  }

  // --- Reload: only one of the orgs is opened in this page ---
  resetSessionForTests();
  const openedSession = createOrgSession(openedOrg);
  // A screen of the opened org lists its staged photo
  const openedUploads = renderHook(() =>
    openedSession.useOfflineUploads().map(({ id }) => id),
  );
  // Not long enough for the one-week retention to delete the photo
  await advanceTime(1_000);
  expect(openedUploads.result.current).toMatchInlineSnapshot(`['photo']`);

  // --- Action: logout clears the storage of the opened org and of an org
  // the user didn't open since the page loaded ---
  await resolveAfterAllTimers(
    Promise.all([
      clearAllSessionStorage(openedOrg),
      clearAllSessionStorage(otherOrg),
    ]),
  );

  // The staged photos of both cleared orgs are gone, including the one of the
  // org no offline session was created for in this page. The org that was not
  // cleared keeps its own.
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`
    "tsdf-uploads (0.47 kb)
    └ offline-upload-logout-kept-org (0.45 kb)
      └ photo (0.39 kb)
        ├ binary.blob (0.04 kb)
        └ metadata.json (0.34 kb)"
  `);
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

test('replacing a staged file and resolving it in the same moment never pairs the new file with the previous file ref', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'offline-upload-save-and-resolve-together-session';
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

  // The app swaps the photo and immediately asks for its server ref, without
  // waiting for the save to finish.
  const savePromise = storeManager.saveOfflineUpload({
    id: 'avatar',
    file: new File(['second photo'], 'second.png', {
      type: 'image/png',
      lastModified: 2,
    }),
  });
  const resolvePromise = storeManager.resolveOfflineUpload('avatar');

  // Bounded advance: lets the upload finish without running the 7-day
  // retention cleanup of the uploaded file.
  await advanceTime(2_000);
  const saveResult = await savePromise;
  const resolvedRef = (await resolvePromise).unwrap();

  // Whichever call wins, the stored file and the ref it is marked with must
  // belong together: the ref the app got is the ref of the bytes kept under
  // the id, and the file that was sent is the one now stored.
  const storedUpload = storeManager.getOfflineUploads()[0];
  expect({
    save: saveResult.ok ? 'saved' : saveResult.error.message,
    resolvedRef,
    stored:
      storedUpload && pick(storedUpload, ['fileName', 'state', 'resolvedRef']),
    transportCalls,
  }).toMatchInlineSnapshot(`
    resolvedRef: 'server:first.png'
    save: 'Cannot change upload "avatar" while it is queued or uploading'
    stored: { fileName: 'first.png', resolvedRef: 'server:first.png', state: 'uploaded' }
    transportCalls: ['upload-start:first.png', 'upload-finish:first.png']
  `);
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

function createUploadsStoreManager(sessionKey: string) {
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

type DocumentValueOperation = DocumentOfflineOperationDefinition<
  { value: number },
  { input: { value: number } }
>;

/**
 * A document store defining `operationNames`. Each replay is logged in `sent`
 * with the content of its attached `avatar` file.
 */
function createRecordingDocumentEnv({
  storeManager,
  storeName,
  operationNames,
  sent,
}: {
  storeManager: ReturnType<typeof createUploadsStoreManager>;
  storeName: string;
  operationNames: readonly string[];
  sent: string[];
}) {
  const operations: Record<string, DocumentValueOperation> = {};
  for (const operationName of operationNames) {
    operations[operationName] = {
      inputSchema: rc_object({ value: rc_number }),
      kind: 'update',
      execute: async (ctx) => {
        const avatar = ctx.uploads.filesById.avatar;
        sent.push(
          `${operationName}(${ctx.input.value})${avatar ? ` with avatar "${await avatar.text()}"` : ''}`,
        );
        return ctx.input;
      },
    };
  }

  return createDocumentStoreTestEnv<
    number,
    Record<string, DocumentValueOperation>
  >(1, {
    id: storeName,
    storeManager,
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: { operations },
    },
  });
}

function queueOfflineEdit(
  env: ReturnType<typeof createRecordingDocumentEnv>,
  operation: string,
  value: number,
  avatarContent?: string,
) {
  return resolveAfterAllTimers(
    env.apiStore.performMutation({
      mutation: () => Promise.resolve(value),
      offline: { operation, input: { value } },
      upload:
        avatarContent === undefined
          ? undefined
          : {
              avatar: new File([avatarContent], 'avatar.txt', {
                type: 'text/plain',
                lastModified: 1,
              }),
            },
    }),
  );
}

test('an older deploy keeps the attached file of an edit queued for an operation only a newer deploy knows', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'offline-unknown-operation-upload-session';
  const storeName = 'offline-unknown-operation-upload-doc';
  const sent: string[] = [];

  // In the newer deploy, which added `updateValue`, the user attaches a file
  // to an offline edit.
  network.setOffline();
  const newerStoreManager = createUploadsStoreManager(sessionKey);
  const newerEnv = createRecordingDocumentEnv({
    storeManager: newerStoreManager,
    storeName,
    operationNames: ['updateValue', 'legacyUpdateValue'],
    sent,
  });
  await queueOfflineEdit(newerEnv, 'updateValue', 2, 'new photo');
  await flushAllTimers();
  const [queuedUpload] = newerStoreManager.getOfflineUploads();
  if (!queuedUpload) throw new Error('Expected the attached file to be saved');

  // A tab of the older deploy, which only knows `legacyUpdateValue`, opens
  // the store while online. Then the connection drops and the user makes
  // another offline edit there. Refreshing its offline state cleans up the
  // files no queued work references, and it can't see the newer deploy's
  // edit.
  resetSessionForTests();
  act(() => {
    network.goOnline();
  });
  const olderStoreManager = createUploadsStoreManager(sessionKey);
  const olderEnv = createRecordingDocumentEnv({
    storeManager: olderStoreManager,
    storeName,
    operationNames: ['legacyUpdateValue'],
    sent,
  });
  const olderHook = renderHook(() => olderEnv.apiStore.useDocument());
  await advanceTime(5_000);
  act(() => {
    network.setOffline();
  });
  await queueOfflineEdit(olderEnv, 'legacyUpdateValue', 3);
  await advanceTime(5_000);
  olderHook.unmount();

  // The file of the edit the older deploy can't see is kept.
  expect(
    olderStoreManager
      .getOfflineUploads()
      .map(({ id }) => (id === queuedUpload.id ? 'attached file' : id)),
  ).toMatchInlineSnapshot(`['attached file']`);

  // Back in the newer deploy, both edits are sent, the first one with its file.
  resetSessionForTests();
  const reloadedEnv = createRecordingDocumentEnv({
    storeManager: createUploadsStoreManager(sessionKey),
    storeName,
    operationNames: ['updateValue', 'legacyUpdateValue'],
    sent,
  });
  const reloadedHook = renderHook(() => reloadedEnv.apiStore.useDocument());
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(sent).toMatchInlineSnapshot(
    `['updateValue(2) with avatar "new photo"', 'legacyUpdateValue(3)']`,
  );

  reloadedHook.unmount();
});
