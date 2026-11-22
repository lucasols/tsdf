import { typingTest } from '@ls-stack/utils/typingTestUtils';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_array, rc_number, rc_object, rc_string } from 'runcheck';
import { expect, test } from 'vitest';
import type {
  CollectionOfflineOperationDefinition,
  DocumentOfflineOperationDefinition,
  ListQueryOfflineOperationDefinition,
  OfflineDirectMutationUploadsContext,
  OfflineSessionConfig,
} from '../../src/main';
import { createStoreManager, opfsOfflineUploadAdapter } from '../../src/main';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { createMockBrowserOpfs } from '../mocks/mockBrowserOpfs';
import { normalizeError } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';
import { getOpfsDirTree } from '../utils/persistentStorageOptimizationTestUtils';
import { userRowSchema } from './offlineReplayTestShared';
import {
  collectionSchema,
  docSchema,
  listQueryQueryPayloadSchema,
} from './offlineTestShared';
import {
  network,
  resolveWithin,
  setupOfflineUploadTests,
  type UploadDependencyOperations,
} from './offlineUploadsTestShared';

// An offline-enabled mutation that runs online right away (it is not queued)
// gets the uploads its operation declares with `dependsOnUploads`, already
// uploaded, like `execute` does on replay. The staged files are deleted once
// the direct request succeeds, and kept for the replay when it falls back to
// the queue.

setupOfflineUploadTests();

/** Thrown by the upload transport and by the direct request in these tests. */
class RequestError extends Error {
  kind: 'connection' | 'rejected';

  constructor(kind: RequestError['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Connection errors take the session offline, anything else is the request's own error. */
function classifyConnectionErrors(error: unknown) {
  return error instanceof RequestError && error.kind === 'connection'
    ? 'network'
    : 'ignore';
}

const attachmentFile = new File(['attachment body'], 'attachment.txt', {
  type: 'text/plain',
  lastModified: 1,
});

/**
 * Document store whose `updateWithAttachment` operation depends on the staged
 * `asset-1` upload, with a scripted upload transport and direct request.
 *
 * `requests` lists what reached the server: uploads, direct requests and
 * replayed requests, with the file ref each request was sent with. The
 * timeline (`env.timelineString`) tracks what a UI would show: the upload
 * state, the sync state of the operation and the session mode.
 */
function createDirectUploadTestEnv({
  sessionKey,
  offlineSession = {},
  uploadAttempts = [],
  directRequestAttempts = [],
}: {
  sessionKey: string;
  /** Session classifiers and gate under test (network and uploads are added here). */
  offlineSession?: Pick<OfflineSessionConfig, 'classifyFailure' | 'enabled'>;
  /** Outcome of each upload transport call, in order. Calls past the end succeed. */
  uploadAttempts?: RequestError[];
  /** Outcome of each direct request, in order. Calls past the end succeed. */
  directRequestAttempts?: RequestError[];
}) {
  const requests: string[] = [];
  let uploadCalls = 0;
  let directRequestCalls = 0;

  const storeManager = createStoreManager({
    getSessionKey: () => sessionKey,
    errorNormalizer: normalizeError,
    offlineSession: {
      ...offlineSession,
      network: network.config,
      uploads: {
        adapter: opfsOfflineUploadAdapter,
        upload: async ({ id }) => {
          const failure = uploadAttempts[uploadCalls];
          uploadCalls += 1;
          // Every upload request takes 200ms to succeed or fail.
          await new Promise((resolve) => setTimeout(resolve, 200));

          if (failure) {
            requests.push(`upload ${id} -> ${failure.message}`);
            throw failure;
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
      id: 'direct-upload-doc',
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
              execute: async ({ input, uploads }) => {
                requests.push(
                  `replay with ${JSON.stringify(uploads.resolvedRefsById[input.attachmentId])}`,
                );
                await env.serverMock.delayedSetData(input.value);
                return { value: input.value };
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

    env.trackUIChanges(
      `upload:${uploadLabel} | op:${entity?.syncState ?? 'none'} | session:${
        status.network.active ? 'offline' : 'online'
      }`,
    );

    return uploads;
  });

  return {
    env,
    storeManager,
    requests,
    unmount: () => uiHook.unmount(),
    /** Uploads as the UI currently sees them through `useOfflineUploads()`. */
    getUploads: () =>
      uiHook.result.current.map((upload) =>
        pick(upload, ['id', 'state', 'resolvedRef', 'lastError']),
      ),
    async stageUpload() {
      await act(async () => {
        (
          await resolveWithin(
            storeManager.saveOfflineUpload({
              id: 'asset-1',
              file: attachmentFile,
            }),
          )
        ).unwrap();
      });
    },
    /**
     * Saves the attachment through `performMutation`, the way the app's save
     * button does. The direct request sends the ref it receives in `uploads`.
     */
    saveAttachment() {
      return act(() =>
        resolveWithin(
          env.apiStore.performMutation({
            mutation: async ({ uploads }) => {
              const failure = directRequestAttempts[directRequestCalls];
              directRequestCalls += 1;
              requests.push(
                `direct request with ${JSON.stringify(uploads.resolvedRefsById['asset-1'])}`,
              );
              if (failure) {
                // Fails after the usual 1.2s request duration
                await new Promise((resolve) => setTimeout(resolve, 1_200));
                throw failure;
              }
              await env.serverMock.delayedSetData(3);
              return { value: 3 };
            },
            offline: {
              operation: 'updateWithAttachment',
              input: { attachmentId: 'asset-1', value: 3 },
            },
          }),
          // Covers the 200ms upload and the 1.2s request, without reaching
          // the one-week retention timer of unreferenced uploads.
          2_000,
        ),
      );
    },
  };
}

async function reconnect() {
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await advanceTime(3_000);
}

test('a mutation that runs online gets the declared uploads already uploaded and deletes the staged files once it succeeds', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  const { env, storeManager, requests, unmount, ...actions } =
    createDirectUploadTestEnv({ sessionKey: 'direct-upload-success' });
  await flushAllTimers();

  await actions.stageUpload();
  env.clearTimeline();

  const result = await actions.saveAttachment();

  // The file is uploaded first, and the direct request is sent with the ref
  // the upload returned instead of the local upload id.
  expect(result.unwrap()).toMatchInlineSnapshot(`
    data: { value: 3 }
    kind: 'online'
  `);
  expect(requests).toMatchInlineSnapshot(
    `['upload asset-1 -> server:asset-1', 'direct request with "server:asset-1"']`,
  );

  // The request consumed the upload, so the staged file is deleted right
  // away, as after a replay, instead of waiting for the retention window.
  expect(actions.getUploads()).toMatchInlineSnapshot(`[]`);
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`"empty"`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time    | ui                                            |
    12.1s   | -                                             | -- timeline-cleared
    12.108s | "upload:uploading | op:none | session:online" | ui-changed
    12.316s | "upload:uploaded | op:none | session:online"  | ui-changed
    13.516s | "upload:uploaded | op:none | session:online"  | server-data-changed (value: 3)
    13.518s | "upload:none | op:none | session:online"      | ui-changed
    "
  `);

  // Data that still holds the local id (e.g. an optimistic update not
  // replaced yet) resolves to the same server ref for the rest of the app
  // session, without uploading again.
  expect(
    (
      await resolveWithin(storeManager.resolveOfflineUpload('asset-1'))
    ).unwrap(),
  ).toMatchInlineSnapshot(`"server:asset-1"`);
  expect(requests).toHaveLength(2);

  unmount();
});

test('a call whose offline descriptor is only sometimes set gets the declared uploads when it is set', async () => {
  createMockBrowserOpfs();
  const { env, requests, unmount, ...actions } = createDirectUploadTestEnv({
    sessionKey: 'direct-upload-optional-descriptor',
  });
  await flushAllTimers();

  await actions.stageUpload();

  // The app's single save helper: only some saves may be queued offline, so
  // it passes `offline: descriptor | undefined` in one call. `uploads` is
  // then only there when the descriptor is set.
  function saveAttachment(canQueueOffline: boolean) {
    return act(() =>
      resolveWithin(
        env.apiStore.performMutation({
          mutation: async ({ uploads }) => {
            typingTest.expectTypesAreEqual<
              typeof uploads,
              OfflineDirectMutationUploadsContext | undefined
            >();
            requests.push(
              `direct request with ${JSON.stringify(uploads?.resolvedRefsById['asset-1'] ?? 'no uploads')}`,
            );
            await env.serverMock.delayedSetData(3);
            return { value: 3 };
          },
          offline: canQueueOffline
            ? {
                operation: 'updateWithAttachment',
                input: { attachmentId: 'asset-1', value: 3 },
              }
            : undefined,
        }),
        2_000,
      ),
    );
  }

  // Without a descriptor it is a plain online mutation: nothing is uploaded
  // and the staged file stays for another call.
  expect((await saveAttachment(false)).unwrap()).toMatchInlineSnapshot(
    `value: 3`,
  );
  expect(actions.getUploads()).toMatchInlineSnapshot(
    `- { id: 'asset-1', state: 'pending' }`,
  );

  // With a descriptor, the upload runs first and the request gets its server
  // ref, then the staged file is released, as with a required descriptor.
  expect((await saveAttachment(true)).unwrap()).toMatchInlineSnapshot(`
    data: { value: 3 }
    kind: 'online'
  `);
  expect(requests).toMatchInlineSnapshot(`
    - 'direct request with "no uploads"'
    - 'upload asset-1 -> server:asset-1'
    - 'direct request with "server:asset-1"'
  `);
  expect(actions.getUploads()).toMatchInlineSnapshot(`[]`);

  unmount();
});

test('a direct request that fails offline after the upload is queued with its upload, and the replay sends the uploaded ref', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  const { env, requests, unmount, ...actions } = createDirectUploadTestEnv({
    sessionKey: 'direct-upload-request-offline',
    offlineSession: { classifyFailure: classifyConnectionErrors },
    directRequestAttempts: [
      new RequestError('connection', 'Request failed: Network error'),
    ],
  });
  await flushAllTimers();

  await actions.stageUpload();
  env.clearTimeline();

  const result = await actions.saveAttachment();

  // The connection drops after the upload finished, while the request is
  // sent: the mutation falls back to the queue.
  expect(result.unwrap()).toMatchInlineSnapshot(`kind: 'queued'`);
  expect(requests).toMatchInlineSnapshot(
    `['upload asset-1 -> server:asset-1', 'direct request with "server:asset-1"']`,
  );

  // The queued mutation declares the upload, so it is kept (already
  // uploaded) instead of being deleted by the failed direct run.
  expect(actions.getUploads()).toMatchInlineSnapshot(`
    - { id: 'asset-1', resolvedRef: 'server:asset-1', state: 'uploaded' }
  `);
  expect(getOpfsDirTree(mockBrowserOpfs)).not.toBe('empty');

  env.addTimelineComments('beforeNextAction', ['the network comes back']);
  await reconnect();

  // The replay reuses the ref of the upload sent by the direct run: the file
  // is not uploaded again, and the server never gets the local upload id.
  expect(requests).toMatchInlineSnapshot(`
    - 'upload asset-1 -> server:asset-1'
    - 'direct request with "server:asset-1"'
    - 'replay with "server:asset-1"'
  `);

  // The replay consumed the upload.
  expect(actions.getUploads()).toMatchInlineSnapshot(`[]`);
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`"empty"`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time    | ui                                               |
    12.1s   | -                                                | -- timeline-cleared
    12.108s | "upload:uploading | op:none | session:online"    | ui-changed
    12.316s | "upload:uploaded | op:none | session:online"     | ui-changed
    13.516s | "upload:uploaded | op:none | session:offline"    | ui-changed
    .       | "upload:uploaded | op:pending | session:offline" | ui-changed
    .       | "upload:uploaded | op:pending | session:offline" | offline:updateWithAttachment queued
    14.1s   | "upload:uploaded | op:pending | session:offline" | -- the network comes back
    .       | "upload:uploaded | op:pending | session:online"  | ui-changed
    .       | "upload:uploaded | op:syncing | session:online"  | ui-changed
    .       | "upload:uploaded | op:syncing | session:online"  | offline:updateWithAttachment replay-started
    15.3s   | "upload:uploaded | op:syncing | session:online"  | server-data-changed (value: 3)
    .       | "upload:uploaded | op:syncing | session:online"  | offline:updateWithAttachment replay-finished
    .       | "upload:uploaded | op:none | session:online"     | ui-changed
    15.302s | "upload:none | op:none | session:online"         | ui-changed
    "
  `);

  unmount();
});

test('an upload that fails offline during a direct run queues the mutation without sending the request', async () => {
  createMockBrowserOpfs();
  const classifiedFailures: unknown[] = [];
  const { env, requests, unmount, ...actions } = createDirectUploadTestEnv({
    sessionKey: 'direct-upload-transport-offline',
    offlineSession: {
      classifyFailure: (error, ctx) => {
        classifiedFailures.push(ctx);
        return classifyConnectionErrors(error);
      },
    },
    uploadAttempts: [
      new RequestError('connection', 'Upload failed: Network error'),
    ],
  });
  await flushAllTimers();

  await actions.stageUpload();
  env.clearTimeline();

  const result = await actions.saveAttachment();

  // The request can't be sent without the file, so it is never called and
  // the mutation is queued.
  expect(result.unwrap()).toMatchInlineSnapshot(`kind: 'queued'`);
  expect(requests).toMatchInlineSnapshot(
    `['upload asset-1 -> Upload failed: Network error']`,
  );

  // The classifier is told which upload failed, on top of the usual context
  // of the mutation.
  expect(classifiedFailures).toMatchInlineSnapshot(`
    - operationName: 'updateWithAttachment'
      phase: 'mutation'
      sessionKey: 'direct-upload-transport-offline'
      storeType: 'document'
      uploadId: 'asset-1'
  `);

  // The upload waits to be sent again with the replay.
  expect(actions.getUploads()).toMatchInlineSnapshot(`
    - id: 'asset-1'
      lastError: { message: 'Upload failed: Network error' }
      state: 'pending'
  `);

  env.addTimelineComments('beforeNextAction', ['the network comes back']);
  await reconnect();

  expect(requests).toMatchInlineSnapshot(`
    - 'upload asset-1 -> Upload failed: Network error'
    - 'upload asset-1 -> server:asset-1'
    - 'replay with "server:asset-1"'
  `);
  expect(actions.getUploads()).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time    | ui                                                                              |
    12.1s   | -                                                                               | -- timeline-cleared
    12.108s | "upload:uploading | op:none | session:online"                                   | ui-changed
    12.316s | "upload:pending (Upload failed: Network error) | op:none | session:online"      | ui-changed
    .       | "upload:pending (Upload failed: Network error) | op:none | session:offline"     | ui-changed
    .       | "upload:pending (Upload failed: Network error) | op:pending | session:offline"  | ui-changed
    .       | "upload:pending (Upload failed: Network error) | op:pending | session:offline"  | offline:updateWithAttachment queued
    14.1s   | "upload:pending (Upload failed: Network error) | op:pending | session:offline"  | -- the network comes back
    .       | "upload:pending (Upload failed: Network error) | op:pending | session:online"   | ui-changed
    .       | "upload:pending (Upload failed: Network error) | op:syncing | session:online"   | ui-changed
    14.108s | "upload:uploading (Upload failed: Network error) | op:syncing | session:online" | ui-changed
    14.316s | "upload:uploaded | op:syncing | session:online"                                 | ui-changed
    .       | "upload:uploaded | op:syncing | session:online"                                 | offline:updateWithAttachment replay-started
    15.516s | "upload:uploaded | op:syncing | session:online"                                 | server-data-changed (value: 3)
    .       | "upload:uploaded | op:syncing | session:online"                                 | offline:updateWithAttachment replay-finished
    .       | "upload:uploaded | op:none | session:online"                                    | ui-changed
    15.518s | "upload:none | op:none | session:online"                                        | ui-changed
    "
  `);

  unmount();
});

test('an upload rejected during a direct run fails the mutation and keeps the staged file for another attempt', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  const { env, requests, unmount, ...actions } = createDirectUploadTestEnv({
    sessionKey: 'direct-upload-transport-rejected',
    offlineSession: { classifyFailure: classifyConnectionErrors },
    uploadAttempts: [new RequestError('rejected', 'File type not accepted')],
  });
  await flushAllTimers();

  await actions.stageUpload();

  const result = await actions.saveAttachment();

  // Not a connection problem: the mutation fails with the upload error, as
  // any other failed request, and the request is never sent.
  expect(result.ok ? null : result.error).toMatchInlineSnapshot(`
    Error#:
      message: 'File type not accepted'
      name: 'StoreMutationError'
      kind: 'error'
      code: 500
      id: 'fetch-error'
      cause:
        Error#: { message: 'File type not accepted', name: 'Error', kind: 'rejected' }
  `);
  expect(requests).toMatchInlineSnapshot(
    `['upload asset-1 -> File type not accepted']`,
  );
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);

  // Nothing will retry it, so the upload is `failed`. The file stays staged:
  // the app decides whether to try again or delete it.
  expect(actions.getUploads()).toMatchInlineSnapshot(`
    - id: 'asset-1'
      lastError: { message: 'File type not accepted' }
      state: 'failed'
  `);
  expect(getOpfsDirTree(mockBrowserOpfs)).not.toBe('empty');

  // Saving again uploads the file again.
  await actions.saveAttachment();
  expect(requests).toMatchInlineSnapshot(`
    - 'upload asset-1 -> File type not accepted'
    - 'upload asset-1 -> server:asset-1'
    - 'direct request with "server:asset-1"'
  `);
  expect(actions.getUploads()).toMatchInlineSnapshot(`[]`);

  unmount();
});

test('when several uploads of a direct run are rejected, all of them become failed', async () => {
  createMockBrowserOpfs();
  const storeManager = createStoreManager({
    getSessionKey: () => 'direct-upload-several-rejected',
    errorNormalizer: normalizeError,
    offlineSession: {
      network: network.config,
      classifyFailure: classifyConnectionErrors,
      uploads: {
        adapter: opfsOfflineUploadAdapter,
        upload: async ({ id }) => {
          // The second file is bigger: it is still uploading when the first
          // one is rejected.
          await new Promise((resolve) =>
            setTimeout(resolve, id === 'asset-1' ? 200 : 400),
          );
          throw new RequestError('rejected', `File ${id} not accepted`);
        },
      },
    },
  });
  const env = createDocumentStoreTestEnv<
    number,
    {
      updateWithAttachments: DocumentOfflineOperationDefinition<
        { value: number },
        { input: { attachmentIds: string[] } }
      >;
    }
  >(1, {
    id: 'direct-upload-several-rejected-doc',
    storeManager,
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        operations: {
          updateWithAttachments: {
            inputSchema: rc_object({ attachmentIds: rc_array(rc_string) }),
            kind: 'update',
            dependsOnUploads: ({ input }) => input.attachmentIds,
            execute: () => Promise.resolve({ value: 3 }),
          },
        },
      },
    },
  });
  await flushAllTimers();

  for (const id of ['asset-1', 'asset-2']) {
    (
      await resolveWithin(
        storeManager.saveOfflineUpload({ id, file: attachmentFile }),
      )
    ).unwrap();
  }

  let directRequestSent = false;
  const result = await resolveWithin(
    env.apiStore.performMutation({
      mutation: () => {
        directRequestSent = true;
        return Promise.resolve({ value: 3 });
      },
      offline: {
        operation: 'updateWithAttachments',
        input: { attachmentIds: ['asset-1', 'asset-2'] },
      },
    }),
    1_000,
  );
  // Lets the second upload settle after the mutation already failed
  await advanceTime(1_000);

  // The mutation fails with the first rejection and is not queued
  expect(result.ok ? null : result.error).toMatchInlineSnapshot(`
    Error#:
      message: 'File asset-1 not accepted'
      name: 'StoreMutationError'
      kind: 'error'
      code: 500
      id: 'fetch-error'
      cause:
        Error#: { message: 'File asset-1 not accepted', name: 'Error', kind: 'rejected' }
  `);
  expect(directRequestSent).toBe(false);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);

  // Nothing will retry either upload, so both are `failed`, not only the one
  // that failed the mutation: a `pending` upload would look like it is
  // waiting for an automatic retry.
  expect(
    storeManager
      .getOfflineUploads()
      .map((upload) => pick(upload, ['id', 'state', 'lastError'])),
  ).toMatchInlineSnapshot(`
    - id: 'asset-1'
      lastError: { message: 'File asset-1 not accepted' }
      state: 'failed'
    - id: 'asset-2'
      lastError: { message: 'File asset-2 not accepted' }
      state: 'failed'
  `);
});

test('a direct request that fails with its own error keeps the uploaded file staged', async () => {
  createMockBrowserOpfs();
  const { requests, unmount, ...actions } = createDirectUploadTestEnv({
    sessionKey: 'direct-upload-request-rejected',
    offlineSession: { classifyFailure: classifyConnectionErrors },
    directRequestAttempts: [new RequestError('rejected', 'Validation failed')],
  });
  await flushAllTimers();

  await actions.stageUpload();

  const result = await actions.saveAttachment();

  expect(result.ok ? null : result.error).toMatchInlineSnapshot(`
    Error#:
      message: 'Validation failed'
      name: 'StoreMutationError'
      kind: 'error'
      code: 500
      id: 'fetch-error'
      cause:
        Error#: { message: 'Validation failed', name: 'Error', kind: 'rejected' }
  `);

  // The request did not use the upload, so it is not deleted: a new attempt
  // sends the same uploaded ref without uploading again.
  expect(actions.getUploads()).toMatchInlineSnapshot(`
    - { id: 'asset-1', resolvedRef: 'server:asset-1', state: 'uploaded' }
  `);

  await actions.saveAttachment();
  expect(requests).toMatchInlineSnapshot(`
    - 'upload asset-1 -> server:asset-1'
    - 'direct request with "server:asset-1"'
    - 'direct request with "server:asset-1"'
  `);
  expect(actions.getUploads()).toMatchInlineSnapshot(`[]`);

  unmount();
});

test('with the session gate closed, the mutation still gets the declared uploads and deletes them once it succeeds', async () => {
  createMockBrowserOpfs();
  const { requests, unmount, ...actions } = createDirectUploadTestEnv({
    sessionKey: 'direct-upload-gate-closed',
    // The offline layer is turned off, e.g. by a feature flag.
    offlineSession: { enabled: () => false },
  });
  await flushAllTimers();

  await actions.stageUpload();

  const result = await actions.saveAttachment();

  expect(result.unwrap()).toMatchInlineSnapshot(`
    data: { value: 3 }
    kind: 'online'
  `);
  expect(requests).toMatchInlineSnapshot(
    `['upload asset-1 -> server:asset-1', 'direct request with "server:asset-1"']`,
  );
  expect(actions.getUploads()).toMatchInlineSnapshot(`[]`);

  unmount();
});

type AttachmentCollectionOperations = {
  attachFile: CollectionOfflineOperationDefinition<
    { value: { name: string } },
    string,
    { itemId: string; attachmentId: string },
    unknown
  >;
};

test('collection store: the direct mutation gets the declared uploads as its second argument', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'direct-upload-collection';
  const requests: string[] = [];

  const storeManager = createStoreManager({
    getSessionKey: () => sessionKey,
    errorNormalizer: normalizeError,
    offlineSession: {
      network: network.config,
      uploads: {
        adapter: opfsOfflineUploadAdapter,
        upload: ({ id }) => {
          requests.push(`upload ${id}`);
          return Promise.resolve(`server:${id}`);
        },
      },
    },
  });
  const env = createCollectionStoreTestEnv<
    { name: string },
    AttachmentCollectionOperations
  >(
    { 'items||1': { name: 'Ada' } },
    {
      id: 'direct-upload-collection-store',
      storeManager,
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
              execute: () => Promise.resolve(undefined),
              onSuccessExecute: () => {},
            },
          },
        },
      },
    },
  );
  await flushAllTimers();
  (
    await resolveWithin(
      storeManager.saveOfflineUpload({ id: 'asset-1', file: attachmentFile }),
    )
  ).unwrap();

  const result = await resolveWithin(
    env.apiStore.performMutation('items||1', {
      mutation: (itemPayload, { uploads }) => {
        requests.push(
          `direct request for ${String(itemPayload)} with ${JSON.stringify(uploads.resolvedRefsById['asset-1'])}`,
        );
        return Promise.resolve(undefined);
      },
      offline: {
        operation: 'attachFile',
        input: { itemId: 'items||1', attachmentId: 'asset-1' },
      },
    }),
  );

  expect(result.ok).toBe(true);
  expect(requests).toMatchInlineSnapshot(
    `['upload asset-1', 'direct request for items||1 with "server:asset-1"']`,
  );
  expect(storeManager.getOfflineUploads()).toMatchInlineSnapshot(`[]`);
});

type UserRow = { id: number; name: string };

type AvatarListQueryOperations = {
  setAvatar: ListQueryOfflineOperationDefinition<
    UserRow,
    { tableId: string },
    string,
    { itemId: string; avatarId: string },
    unknown
  >;
};

test('list query store: the direct mutation gets the declared uploads as its second argument', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'direct-upload-list-query';
  const requests: string[] = [];

  const storeManager = createStoreManager({
    getSessionKey: () => sessionKey,
    errorNormalizer: normalizeError,
    offlineSession: {
      network: network.config,
      uploads: {
        adapter: opfsOfflineUploadAdapter,
        upload: ({ id }) => {
          requests.push(`upload ${id}`);
          return Promise.resolve(`server:${id}`);
        },
      },
    },
  });
  const env = createListQueryStoreTestEnv<
    UserRow,
    false,
    false,
    AvatarListQueryOperations
  >(
    { users: [{ id: 1, name: 'Ada' }] },
    {
      id: 'direct-upload-list-query-store',
      storeManager,
      testScenario: { loaded: { queries: [{ tableId: 'users' }] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: {
          operations: {
            setAvatar: {
              inputSchema: rc_object({
                itemId: rc_string,
                avatarId: rc_string,
              }),
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              dependsOnUploads: ({ input }) => [input.avatarId],
              execute: () => Promise.resolve(undefined),
              onSuccessExecute: () => {},
            },
          },
        },
      },
    },
  );
  await flushAllTimers();
  (
    await resolveWithin(
      storeManager.saveOfflineUpload({ id: 'avatar-1', file: attachmentFile }),
    )
  ).unwrap();

  const result = await resolveWithin(
    env.apiStore.performMutation('users||1', {
      mutation: (itemPayload, { uploads }) => {
        requests.push(
          `direct request for ${String(itemPayload)} with ${JSON.stringify(uploads.resolvedRefsById['avatar-1'])}`,
        );
        return Promise.resolve(undefined);
      },
      offline: {
        operation: 'setAvatar',
        input: { itemId: 'users||1', avatarId: 'avatar-1' },
      },
    }),
  );

  expect(result.ok).toBe(true);
  expect(requests).toMatchInlineSnapshot(
    `['upload avatar-1', 'direct request for users||1 with "server:avatar-1"']`,
  );
  expect(storeManager.getOfflineUploads()).toMatchInlineSnapshot(`[]`);
});
