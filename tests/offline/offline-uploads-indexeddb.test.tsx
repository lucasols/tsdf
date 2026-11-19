import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { indexedDbOfflineUploadAdapter } from '../../src/indexed-db-storage';
import type { DocumentOfflineOperationDefinition } from '../../src/main';
import { clearSessionStorage, createStoreManager } from '../../src/main';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { normalizeError, TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import {
  advanceTime,
  flushAllTimers,
  pick,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import {
  getIndexedDbOfflineUploadsSnapshot,
  overwriteIndexedDbOfflineUploadMetadata,
  resetIndexedDbOfflineUploadStorageForTests,
} from '../utils/indexedDbOfflineUploadTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { resetSessionForTests } from '../utils/resetSessionForTests';
import { docSchema, waitForMicrotaskCondition } from './offlineTestShared';

let network = createOfflineNetworkMock();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
  network = createOfflineNetworkMock();
  network.install();
  resetSessionForTests({ clearStorage: true });
  resetIndexedDbOfflineUploadStorageForTests();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetSessionForTests({ clearStorage: true });
  resetIndexedDbOfflineUploadStorageForTests();
});

type UploadTransport = (ctx: {
  id: string;
  file: File;
  onProgress: (progress: { progress: number }) => void;
}) => Promise<string>;

function createUploadSession(
  sessionKey: string,
  upload: UploadTransport = ({ id }) => Promise.resolve(`server:${id}`),
) {
  const storeManager = createStoreManager({
    getSessionKey: () => sessionKey,
    errorNormalizer: normalizeError,
    offlineSession: {
      network: network.config,
      uploads: { adapter: indexedDbOfflineUploadAdapter, upload },
    },
  });
  // Reading the offline status starts the session, which hydrates the uploads
  // staged in previous app runs (apps do it by rendering the offline hooks).
  storeManager.getOfflineStatus();

  return storeManager;
}

/** Simulates closing the app and opening it again: only IndexedDB survives. */
function restartApp(): void {
  resetSessionForTests();
}

function textFile(
  content: string,
  name: string,
  lastModified = 1,
  type = 'text/plain',
): File {
  return new File([content], name, { type, lastModified });
}

async function describeFile(file: File | null) {
  if (!file) return null;

  return {
    name: file.name,
    type: file.type,
    lastModified: file.lastModified,
    size: file.size,
    text: await file.text(),
  };
}

/** Durable records read straight from IndexedDB. */
function getStoredUploads() {
  return resolveAfterAllTimers(getIndexedDbOfflineUploadsSnapshot());
}

/** Only the stored key and file bytes, for assertions about which files exist. */
async function getStoredUploadFiles() {
  return (await getStoredUploads()).map((upload) =>
    pick(upload, ['key', 'file']),
  );
}

test('staged uploads are restored with their original bytes, name, type and last-modified date after an app restart', async () => {
  const sessionKey = 'idb-upload-restart-session';
  const session = createUploadSession(sessionKey);
  await flushAllTimers();

  // Stage a file while offline, as a user attaching a photo without network.
  network.setOffline();
  (
    await resolveAfterAllTimers(
      session.saveOfflineUpload({
        id: 'avatar',
        file: textFile('manual upload', 'avatar.txt', 1234),
      }),
    )
  ).unwrap();

  // The record is durable: metadata and file bytes are stored under the
  // `sessionKey / uploadId` key in IndexedDB.
  expect(await getStoredUploads()).toMatchInlineSnapshot(`
    - file: 'manual upload'
      key: 'idb-upload-restart-session / avatar'
      metadata:
        c: 1735689612000
        i: 'avatar'
        k: 'idb-upload-restart-session'
        l: 1234
        m: 'text/plain'
        n: 'avatar.txt'
        o: 'manual'
        t: 'pending'
        u: 1735689612000
        z: 13
  `);

  restartApp();
  const restartedSession = createUploadSession(sessionKey);
  await flushAllTimers();

  // Hydration lists the pending upload again without any user action.
  expect(restartedSession.getOfflineUploads()).toMatchInlineSnapshot(`
    - createdAt: 1735689612000
      fileName: 'avatar.txt'
      id: 'avatar'
      mimeType: 'text/plain'
      sessionKey: 'idb-upload-restart-session'
      sizeBytes: 13
      source: 'manual'
      state: 'pending'
      updatedAt: 1735689612000
  `);

  // The restored `File` is equivalent to the one the user picked.
  const restoredFile = (
    await resolveAfterAllTimers(restartedSession.loadOfflineUpload('avatar'))
  ).unwrap();
  expect(restoredFile).toBeInstanceOf(File);
  expect(await describeFile(restoredFile)).toMatchInlineSnapshot(`
    lastModified: 1234
    name: 'avatar.txt'
    size: 13
    text: 'manual upload'
    type: 'text/plain'
  `);
});

test('replacing a staged upload overwrites the stored file and the replacement survives a restart', async () => {
  const sessionKey = 'idb-upload-replace-session';
  const session = createUploadSession(sessionKey);
  await flushAllTimers();
  network.setOffline();

  (
    await resolveAfterAllTimers(
      session.saveOfflineUpload({
        id: 'contract',
        file: textFile('first draft', 'draft.txt', 1),
      }),
    )
  ).unwrap();

  // The user picks another file for the same upload slot a bit later.
  await advanceTime(1_000);
  (
    await resolveAfterAllTimers(
      session.replaceOfflineUpload({
        id: 'contract',
        file: textFile('final version!', 'final.md', 2, 'text/markdown'),
      }),
    )
  ).unwrap();

  // Only one record exists for the id and it holds the replacement. The
  // original staging time (`c`) is kept while the update time (`u`) moves.
  expect(await getStoredUploads()).toMatchInlineSnapshot(`
    - file: 'final version!'
      key: 'idb-upload-replace-session / contract'
      metadata:
        c: 1735689612000
        i: 'contract'
        k: 'idb-upload-replace-session'
        l: 2
        m: 'text/markdown'
        n: 'final.md'
        o: 'manual'
        t: 'pending'
        u: 1735689613002
        z: 14
  `);

  restartApp();
  const restartedSession = createUploadSession(sessionKey);
  await flushAllTimers();

  expect(
    await describeFile(
      (
        await resolveAfterAllTimers(
          restartedSession.loadOfflineUpload('contract'),
        )
      ).unwrap(),
    ),
  ).toMatchInlineSnapshot(`
    lastModified: 2
    name: 'final.md'
    size: 14
    text: 'final version!'
    type: 'text/markdown'
  `);
});

test('deleted uploads do not come back after a restart and unknown upload ids load as null', async () => {
  const sessionKey = 'idb-upload-delete-session';
  const session = createUploadSession(sessionKey);
  await flushAllTimers();
  network.setOffline();

  for (const id of ['keep-me', 'delete-me']) {
    (
      await resolveAfterAllTimers(
        session.saveOfflineUpload({
          id,
          file: textFile(`${id} body`, `${id}.txt`),
        }),
      )
    ).unwrap();
  }

  (
    await resolveAfterAllTimers(session.deleteOfflineUpload('delete-me'))
  ).unwrap();

  // Deleting an id that was never staged is not an error.
  const deleteUnknownResult = await resolveAfterAllTimers(
    session.deleteOfflineUpload('never-staged'),
  );
  expect(deleteUnknownResult.ok).toBe(true);

  // Both the metadata and the file bytes of the deleted upload are gone.
  expect(await getStoredUploadFiles()).toMatchInlineSnapshot(`
    - { file: 'keep-me body', key: 'idb-upload-delete-session / keep-me' }
  `);

  restartApp();
  const restartedSession = createUploadSession(sessionKey);
  await flushAllTimers();

  expect(
    restartedSession.getOfflineUploads().map((upload) => upload.id),
  ).toMatchInlineSnapshot(`['keep-me']`);

  // Loading a deleted or never staged id resolves to `null`, not an error.
  const loadResults = {
    deleted: (
      await resolveAfterAllTimers(
        restartedSession.loadOfflineUpload('delete-me'),
      )
    ).unwrap(),
    neverStaged: (
      await resolveAfterAllTimers(
        restartedSession.loadOfflineUpload('never-staged'),
      )
    ).unwrap(),
  };
  expect(loadResults).toMatchInlineSnapshot(`
    deleted: null
    neverStaged: null
  `);
});

test('uploads with the same id stay isolated between sessions', async () => {
  // Two users of the same browser profile stage a file with the same id.
  const aliceSession = createUploadSession('idb-upload-alice');
  const bobSession = createUploadSession('idb-upload-bob');
  await flushAllTimers();
  network.setOffline();

  (
    await resolveAfterAllTimers(
      aliceSession.saveOfflineUpload({
        id: 'avatar',
        file: textFile('alice photo', 'alice.txt'),
      }),
    )
  ).unwrap();
  (
    await resolveAfterAllTimers(
      bobSession.saveOfflineUpload({
        id: 'avatar',
        file: textFile('bob photo', 'bob.txt'),
      }),
    )
  ).unwrap();

  restartApp();
  const restartedAlice = createUploadSession('idb-upload-alice');
  const restartedBob = createUploadSession('idb-upload-bob');
  await flushAllTimers();

  // Each session only sees and loads its own file.
  expect({
    alice: await describeFile(
      (
        await resolveAfterAllTimers(restartedAlice.loadOfflineUpload('avatar'))
      ).unwrap(),
    ),
    bob: await describeFile(
      (
        await resolveAfterAllTimers(restartedBob.loadOfflineUpload('avatar'))
      ).unwrap(),
    ),
  }).toMatchInlineSnapshot(`
    alice:
      lastModified: 1
      name: 'alice.txt'
      size: 11
      text: 'alice photo'
      type: 'text/plain'

    bob:
      lastModified: 1
      name: 'bob.txt'
      size: 9
      text: 'bob photo'
      type: 'text/plain'
  `);

  // Deleting the upload in one session leaves the other session's file alone.
  (
    await resolveAfterAllTimers(restartedAlice.deleteOfflineUpload('avatar'))
  ).unwrap();

  expect({
    alice: restartedAlice.getOfflineUploads().map((upload) => upload.fileName),
    bob: restartedBob.getOfflineUploads().map((upload) => upload.fileName),
  }).toMatchInlineSnapshot(`
    alice: []
    bob: ['bob.txt']
  `);
  expect(await getStoredUploadFiles()).toMatchInlineSnapshot(`
    - { file: 'bob photo', key: 'idb-upload-bob / avatar' }
  `);
});

test('clearSessionStorage removes the staged uploads of that session only', async () => {
  network.setOffline();
  const loggedOutSession = createUploadSession('idb-upload-logout');
  const otherSession = createUploadSession('idb-upload-logout-other');
  await flushAllTimers();

  for (const [session, owner] of [
    [loggedOutSession, 'logout'],
    [otherSession, 'other'],
  ] as const) {
    for (const id of ['doc-1', 'doc-2']) {
      (
        await resolveAfterAllTimers(
          session.saveOfflineUpload({
            id,
            file: textFile(`${owner} ${id}`, `${id}.txt`),
          }),
        )
      ).unwrap();
    }
  }

  // Apps call the generic session clear helper on logout even when uploads
  // are stored separately from the main local-sync persistent state.
  await resolveAfterAllTimers(
    clearSessionStorage('idb-upload-logout', 'local-sync'),
  );

  expect(await getStoredUploadFiles()).toMatchInlineSnapshot(`
    - { file: 'other doc-1', key: 'idb-upload-logout-other / doc-1' }
    - { file: 'other doc-2', key: 'idb-upload-logout-other / doc-2' }
  `);

  restartApp();
  const restartedLoggedOutSession = createUploadSession('idb-upload-logout');
  const restartedOtherSession = createUploadSession('idb-upload-logout-other');
  await flushAllTimers();

  expect({
    loggedOut: restartedLoggedOutSession
      .getOfflineUploads()
      .map((upload) => upload.id),
    other: restartedOtherSession.getOfflineUploads().map((upload) => upload.id),
  }).toMatchInlineSnapshot(`
    loggedOut: []
    other: ['doc-1', 'doc-2']
  `);
});

type DirectUploadUpdateOperations = {
  updateValue: DocumentOfflineOperationDefinition<
    { value: number },
    { input: { value: number } }
  >;
};

test('a queued mutation with a directly attached file survives a restart and replays with the restored file', async () => {
  const sessionKey = 'idb-direct-upload-session';
  const replayedFiles: Array<Record<string, unknown>> = [];

  function createEnv(
    storeManager: ReturnType<typeof createUploadSession>,
    testScenario: 'idle' | 'loaded',
  ) {
    const env = createDocumentStoreTestEnv<
      number,
      DirectUploadUpdateOperations
    >(1, {
      id: 'idb-direct-upload-doc',
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
    });

    return env;
  }

  // Start offline so the mutation is queued instead of sent.
  network.setOffline();
  const storeManager = createUploadSession(sessionKey);
  const env = createEnv(storeManager, 'loaded');
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
      upload: { avatar: textFile('direct upload body', 'avatar.txt') },
    }),
  );
  await flushAllTimers();

  // The attachment was persisted as a mutation-owned upload.
  const queuedUpload = storeManager.getOfflineUploads()[0];
  if (!queuedUpload) {
    throw new Error('Expected the queued direct upload to be persisted');
  }
  expect(
    (await getStoredUploads()).map((upload) => ({
      file: upload.file,
      isQueuedUpload: upload.key === `${sessionKey} / ${queuedUpload.id}`,
      metadata: pick(upload.metadata, ['n', 'o', 't']),
    })),
  ).toMatchInlineSnapshot(`
    - file: 'direct upload body'
      isQueuedUpload: '✅'
      metadata: { n: 'avatar.txt', o: 'mutation', t: 'pending' }
  `);

  // Restart while still offline: the queued mutation and its file must be
  // restored from storage instead of surviving in memory.
  restartApp();
  const restartedStoreManager = createUploadSession(sessionKey);
  const restartedEnv = createEnv(restartedStoreManager, 'idle');
  const restartedHook = renderHook(() =>
    restartedEnv.apiStore.useDocument({ returnRefetchingStatus: true }),
  );
  await flushAllTimers();

  expect(replayedFiles).toMatchInlineSnapshot(`[]`);
  expect(
    restartedStoreManager
      .getOfflineUploads()
      .map((upload) => ({
        isQueuedUpload: upload.id === queuedUpload.id,
        ...pick(upload, ['state', 'source']),
      })),
  ).toMatchInlineSnapshot(`
    - { isQueuedUpload: '✅', source: 'mutation', state: 'pending' }
  `);

  // Reconnect and let the restored queue replay.
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await flushAllTimers();

  // The replayed operation receives the restored File, not only its id.
  expect(replayedFiles).toMatchInlineSnapshot(`
    - fileName: 'avatar.txt'
      fileText: 'direct upload body'
      uploadKeys: ['avatar']
  `);
  // A successful replay clears the durable upload entry.
  expect(restartedStoreManager.getOfflineUploads()).toMatchInlineSnapshot(`[]`);
  expect(await getStoredUploads()).toMatchInlineSnapshot(`[]`);

  restartedHook.unmount();
});

type UploadDependencyOperations = {
  updateWithAttachment: DocumentOfflineOperationDefinition<
    { value: number },
    { input: { attachmentId: string; value: number } }
  >;
};

test('after a restart, replay sends the restored file through the upload transport before executing the dependent mutation', async () => {
  const sessionKey = 'idb-upload-dependency-session';
  const replayEvents: string[] = [];

  const upload: UploadTransport = async ({ id, file, onProgress }) => {
    // Read the bytes like a real transport building the request body would.
    replayEvents.push(
      `upload-start:${id}:${file.name}:${file.type}:${await file.text()}`,
    );
    onProgress({ progress: 0.5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    onProgress({ progress: 1 });
    replayEvents.push(`upload-finish:${id}`);
    return `server:${id}`;
  };

  function createEnv(
    storeManager: ReturnType<typeof createUploadSession>,
    testScenario: 'idle' | 'loaded',
  ) {
    const env = createDocumentStoreTestEnv<number, UploadDependencyOperations>(
      1,
      {
        id: 'idb-upload-dependency-doc',
        storeManager,
        testScenario,
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
                  replayEvents.push(
                    `execute:${ctx.input.attachmentId}:${JSON.stringify(
                      ctx.uploads.resolvedRefsById[ctx.input.attachmentId],
                    )}`,
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

    return env;
  }

  // Keep the session offline so the manual upload and the dependent mutation
  // both queue up first.
  network.setOffline();
  const storeManager = createUploadSession(sessionKey, upload);
  const env = createEnv(storeManager, 'loaded');
  await flushAllTimers();

  (
    await resolveAfterAllTimers(
      storeManager.saveOfflineUpload({
        id: 'asset-1',
        file: textFile('dependency body', 'dependency.txt'),
      }),
    )
  ).unwrap();
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
  await flushAllTimers();

  // Restart while offline, then reconnect in the new app instance.
  restartApp();
  const restartedStoreManager = createUploadSession(sessionKey, upload);
  const restartedEnv = createEnv(restartedStoreManager, 'idle');
  const restartedHook = renderHook(() =>
    restartedEnv.apiStore.useDocument({ returnRefetchingStatus: true }),
  );
  await flushAllTimers();
  expect(replayEvents).toMatchInlineSnapshot(`[]`);

  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await flushAllTimers();
  await act(async () => {
    await Promise.resolve();
  });
  await flushAllTimers();

  // The transport got the file restored from IndexedDB, and the mutation only
  // executed after the upload finished, receiving the final server ref.
  expect(replayEvents).toMatchInlineSnapshot(`
    - 'upload-start:asset-1:dependency.txt:text/plain:dependency body'
    - 'upload-finish:asset-1'
    - 'execute:asset-1:"server:asset-1"'
  `);
  // The consumed upload is removed from the session and from IndexedDB.
  expect(restartedStoreManager.getOfflineUploads()).toMatchInlineSnapshot(`[]`);
  expect(await getStoredUploads()).toMatchInlineSnapshot(`[]`);

  restartedHook.unmount();
});

test('manual uploads nobody consumed are removed from IndexedDB after one week online', async () => {
  const sessionKey = 'idb-upload-retention-session';
  const dayMs = 24 * 60 * 60 * 1000;
  const session = createUploadSession(sessionKey);
  const uploadHook = renderHook(() => session.useOfflineUploads());
  await flushAllTimers();

  network.setOffline();
  (
    await resolveAfterAllTimers(
      session.saveOfflineUpload({
        id: 'stale-manual-upload',
        file: textFile('retention body', 'retention.txt'),
      }),
    )
  ).unwrap();

  // A stable online session starts the retention window: the stored metadata
  // gets the online session timestamp (`g`) and the file bytes stay intact.
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await advanceTime(6_000);

  expect(await getStoredUploads()).toMatchInlineSnapshot(`
    - file: 'retention body'
      key: 'idb-upload-retention-session / stale-manual-upload'
      metadata:
        c: 1735689612000
        g: 1735689617002
        i: 'stale-manual-upload'
        k: 'idb-upload-retention-session'
        l: 1
        m: 'text/plain'
        n: 'retention.txt'
        o: 'manual'
        t: 'pending'
        u: 1735689617002
        z: 14
  `);

  // Still within the week: nothing is removed.
  await advanceTime(6 * dayMs);
  expect(
    uploadHook.result.current.map((upload) => upload.id),
  ).toMatchInlineSnapshot(`['stale-manual-upload']`);

  // After a full online week without any consumer, the upload is cleaned up
  // from both the session state and IndexedDB.
  await advanceTime(2 * dayMs);
  await flushAllTimers();

  expect(uploadHook.result.current).toMatchInlineSnapshot(`[]`);
  expect(await getStoredUploads()).toMatchInlineSnapshot(`[]`);

  uploadHook.unmount();
});

/** Reads the compact upload state (`t`) of a metadata record being written. */
function getStoredUploadState(metadata: unknown): unknown {
  return typeof metadata === 'object' && metadata !== null && 't' in metadata
    ? metadata.t
    : undefined;
}

test('upload state changes only rewrite the stored metadata, not the file bytes', async () => {
  const sessionKey = 'idb-upload-write-efficiency-session';
  const writes = createLoggerStore();
  const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put');
  let loggedWriteCount = 0;

  /** Logs the IndexedDB writes made since the previous call under a phase label. */
  function logWritesOf(phase: string) {
    writes.addMark(phase);
    for (
      let index = loggedWriteCount;
      index < putSpy.mock.calls.length;
      index++
    ) {
      const store: unknown = putSpy.mock.contexts[index];
      const value: unknown = putSpy.mock.calls[index]?.[0];
      writes.add({
        store: store instanceof IDBObjectStore ? store.name : 'unknown',
        ...(value instanceof ArrayBuffer
          ? { bytes: value.byteLength }
          : { uploadState: getStoredUploadState(value) }),
      });
    }
    loggedWriteCount = putSpy.mock.calls.length;
  }

  network.setOffline();
  const session = createUploadSession(sessionKey);
  await flushAllTimers();

  (
    await resolveAfterAllTimers(
      session.saveOfflineUpload({
        id: 'video',
        file: textFile('large video bytes', 'video.txt'),
      }),
    )
  ).unwrap();
  logWritesOf('stage upload while offline');

  // Restart so the next state changes act on a file restored from IndexedDB.
  restartApp();
  const restartedSession = createUploadSession(sessionKey);
  await flushAllTimers();

  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await advanceTime(6_000);
  logWritesOf('reconnect: the retention window is stamped on the upload');

  (
    await resolveAfterAllTimers(restartedSession.resolveOfflineUpload('video'))
  ).unwrap();
  logWritesOf('upload the restored file');

  (
    await resolveAfterAllTimers(
      restartedSession.replaceOfflineUpload({
        id: 'video',
        file: textFile('final cut', 'video-final.txt'),
      }),
    )
  ).unwrap();
  logWritesOf('replace the file');

  (
    await resolveAfterAllTimers(restartedSession.resolveOfflineUpload('video'))
  ).unwrap();
  logWritesOf('upload the replacement');

  // File bytes are written once per staged file. Every other change (retention
  // stamp, uploading, uploaded) only rewrites the small metadata record.
  expect(writes.snapshot).toMatchInlineSnapshot(`
    "

    >>> stage upload while offline

    -> store: metadata ⋅ uploadState: pending
    -> store: files ⋅ bytes: 17

    >>> reconnect: the retention window is stamped on the upload

    -> store: metadata ⋅ uploadState: pending

    >>> upload the restored file

    -> store: metadata ⋅ uploadState: uploading
    -> store: metadata ⋅ uploadState: uploaded

    >>> replace the file

    -> store: metadata ⋅ uploadState: pending
    -> store: files ⋅ bytes: 9

    >>> upload the replacement

    -> store: metadata ⋅ uploadState: uploading
    -> store: metadata ⋅ uploadState: uploaded
    "
  `);

  // The metadata-only writes left the stored bytes of the last file intact.
  expect(await getStoredUploads()).toMatchInlineSnapshot(`
    - file: 'final cut'
      key: 'idb-upload-write-efficiency-session / video'
      metadata:
        c: 1735689612000
        g: 1735689629002
        i: 'video'
        k: 'idb-upload-write-efficiency-session'
        l: 1
        m: 'text/plain'
        n: 'video-final.txt'
        o: 'manual'
        p: { loadedBytes: 9, progress: 1, totalBytes: 9 }
        r: 'server:video'
        t: 'uploaded'
        u: 1735689630010
        z: 9
  `);
});

test('a failed IndexedDB write is reported as a failed Result instead of throwing', async () => {
  const sessionKey = 'idb-upload-write-failure-session';
  network.setOffline();
  const session = createUploadSession(sessionKey);
  await flushAllTimers();

  // Browsers accept the write requests and then abort the whole transaction
  // when the data cannot be stored, for example when the origin is over its
  // storage quota.
  const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put');
  const savePromise = session.saveOfflineUpload({
    id: 'too-big',
    file: textFile('does not fit', 'too-big.txt'),
  });
  // The metadata and the file bytes are queued in one transaction, which the
  // fake IndexedDB only processes once timers advance: abort it before that.
  await waitForMicrotaskCondition(() => putSpy.mock.calls.length === 2);
  const filesStore: unknown = putSpy.mock.contexts[1];
  if (!(filesStore instanceof IDBObjectStore)) {
    throw new Error('Expected the file bytes write to be queued');
  }
  filesStore.transaction.abort();

  const saveResult = await resolveAfterAllTimers(savePromise);

  // The app gets an error Result it can show to the user.
  expect(
    saveResult.ok ? 'saved' : { error: saveResult.error.message },
  ).toMatchInlineSnapshot(
    `error: 'IndexedDB offline upload transaction aborted.'`,
  );

  // The aborted transaction left no partial record behind: the metadata write
  // that was part of the same transaction was rolled back too.
  expect(await getStoredUploads()).toMatchInlineSnapshot(`[]`);
});

test('stored uploads with unreadable metadata are skipped while the valid ones are restored', async () => {
  const sessionKey = 'idb-upload-corrupted-session';
  const session = createUploadSession(sessionKey);
  await flushAllTimers();
  network.setOffline();

  for (const id of ['valid', 'corrupted']) {
    (
      await resolveAfterAllTimers(
        session.saveOfflineUpload({
          id,
          file: textFile(`${id} body`, `${id}.txt`),
        }),
      )
    ).unwrap();
  }

  // Simulate a record whose metadata is not in the shape this version writes.
  await resolveAfterAllTimers(
    overwriteIndexedDbOfflineUploadMetadata(sessionKey, 'corrupted', {
      i: 'corrupted',
      unexpected: true,
    }),
  );

  restartApp();
  const restartedSession = createUploadSession(sessionKey);
  await flushAllTimers();

  // Hydration keeps working and only exposes the upload it can trust.
  expect(
    restartedSession.getOfflineUploads().map((upload) => upload.id),
  ).toMatchInlineSnapshot(`['valid']`);
  const corruptedLoadResult = await resolveAfterAllTimers(
    restartedSession.loadOfflineUpload('corrupted'),
  );
  expect(
    corruptedLoadResult.ok ? corruptedLoadResult.value : 'error',
  ).toMatchInlineSnapshot(`null`);
});
