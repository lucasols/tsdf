import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import {
  rc_array,
  rc_number,
  rc_object,
  rc_string,
  rc_unknown,
} from 'runcheck';
import { expect, test } from 'vitest';
import type { DocumentOfflineOperationDefinition } from '../../src/main';
import { createStoreManager, opfsOfflineUploadAdapter } from '../../src/main';
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
import {
  getOfflineQueueEntries,
  getOfflineQueueEntryData,
} from './offlineReplayTestShared';
import { docSchema } from './offlineTestShared';
import {
  network,
  resolveWithin,
  setupOfflineUploadTests,
  type UploadDependencyOperations,
} from './offlineUploadsTestShared';

setupOfflineUploadTests();

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

test('an upload id still held by the app after its mutation replayed resolves to the same ref without uploading again', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'offline-upload-reuse-session';
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
      id: 'offline-upload-reuse-doc',
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
                replayEvents.push(
                  `execute:${ctx.input.value}:${JSON.stringify(
                    ctx.uploads.resolvedRefsById[ctx.input.attachmentId],
                  )}`,
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

  function queueEditWithAttachment(value: number) {
    return resolveAfterAllTimers(
      env.apiStore.performMutation({
        optimisticUpdate: () => {
          env.apiStore.updateState((draft) => {
            draft.value = value;
          });
        },
        mutation: () => Promise.resolve({ value }),
        offline: {
          operation: 'updateWithAttachment',
          input: { attachmentId: 'asset-1', value },
        },
      }),
    );
  }

  // The user attaches a file offline and saves an edit that depends on it.
  (
    await resolveAfterAllTimers(
      storeManager.saveOfflineUpload({
        id: 'asset-1',
        file: new File(['attachment body'], 'attachment.txt', {
          type: 'text/plain',
        }),
      }),
    )
  ).unwrap();
  await queueEditWithAttachment(2);

  // Reconnecting replays the edit: the file is uploaded once and the staged
  // upload is deleted because no queued work declares it anymore.
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await advanceTime(3_000);
  expect(storeManager.getOfflineUploads()).toMatchInlineSnapshot(`[]`);

  // The connection drops again before the app swapped the attachment id for
  // the server ref, so the user's next edit is queued still declaring it.
  network.setOffline();
  await advanceTime(0);
  await queueEditWithAttachment(3);

  // On reconnect the second edit replays with the ref of the first upload
  // instead of failing on a staged upload that no longer exists.
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await advanceTime(3_000);

  // The app can also still resolve the id itself while online.
  expect(
    (
      await resolveAfterAllTimers(storeManager.resolveOfflineUpload('asset-1'))
    ).unwrap(),
  ).toMatchInlineSnapshot(`"server:asset-1"`);

  // The file was uploaded only once, and both edits reached the server with
  // its ref.
  expect(replayEvents).toMatchInlineSnapshot(
    `['upload:asset-1', 'execute:2:"server:asset-1"', 'execute:3:"server:asset-1"']`,
  );
  // Neither edit was sent to manual resolution.
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
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
    - { fileName: 'notes.txt', id: 'plain-file' }
    - fileName: 'invoice.pdf'
      id: 'record-file'
      metadata: { fieldId: 'files', kind: 'record', tableId: 'table-7' }
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

const ORG_A = 'offline-upload-org-a';
const ORG_B = 'offline-upload-org-b';
const ORG_SWITCH_STORE = 'offline-upload-org-switch-doc';

/**
 * An app that switches org in place (the session key changes without a
 * reload), with an edit queued offline in org A that depends on `fileIds`.
 * Each upload takes 1s, then `uploadResult` decides whether it succeeds.
 * The switch happens 500ms after reconnecting.
 */
async function setupOrgSwitchReplay(args: {
  fileIds: string[];
  uploadConcurrency?: number;
  uploadResult?: (id: string) => 'ok' | 'rejected';
  /**
   * The edit loads the server snapshot (1s) and checks it for conflicts
   * before it is sent.
   */
  checksServerConflicts?: boolean;
  /** A slow device: saving an upload as `uploading` takes this long. */
  uploadingStateSaveMs?: number;
  switchMark?: string;
}) {
  createMockBrowserOpfs();
  const session = { key: ORG_A };
  const events = createLoggerStore();
  const { uploadingStateSaveMs } = args;

  network.setOffline();

  const storeManager = createStoreManager({
    getSessionKey: () => session.key,
    errorNormalizer: normalizeError,
    offlineSession: {
      network: network.config,
      uploads: {
        adapter:
          uploadingStateSaveMs === undefined
            ? opfsOfflineUploadAdapter
            : {
                save: async (sessionKey, id, record) => {
                  if (record.state === 'uploading') {
                    await new Promise((resolve) =>
                      setTimeout(resolve, uploadingStateSaveMs),
                    );
                  }
                  await opfsOfflineUploadAdapter.save(sessionKey, id, record);
                },
                load: (sessionKey, id) =>
                  opfsOfflineUploadAdapter.load(sessionKey, id),
                list: (sessionKey) => opfsOfflineUploadAdapter.list(sessionKey),
                remove: (sessionKey, id) =>
                  opfsOfflineUploadAdapter.remove(sessionKey, id),
                clearSession: (sessionKey) =>
                  opfsOfflineUploadAdapter.clearSession(sessionKey),
              },
        concurrency: args.uploadConcurrency,
        upload: async ({ id, sessionKey }) => {
          events.add({ event: `upload-start ${id} (owner: ${sessionKey})` });
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          if (args.uploadResult?.(id) === 'rejected') {
            events.add({ event: `upload-rejected ${id}` });
            throw new Error(`upload of ${id} rejected`);
          }
          events.add({ event: `upload-finish ${id}` });
          return `server:${id}`;
        },
      },
    },
  });

  const env = createDocumentStoreTestEnv<
    number,
    {
      updateWithAttachments: DocumentOfflineOperationDefinition<
        { value: number },
        { input: { attachmentIds: string[]; value: number } }
      >;
    }
  >(1, {
    id: ORG_SWITCH_STORE,
    getSessionKey: () => session.key,
    storeManager,
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        operations: {
          updateWithAttachments: {
            inputSchema: rc_object({
              attachmentIds: rc_array(rc_string),
              value: rc_number,
            }),
            kind: 'update',
            dependsOnUploads: ({ input }) => input.attachmentIds,
            ...(args.checksServerConflicts
              ? {
                  getServerSnapshot: async () => {
                    events.add({
                      event: `get-server-snapshot while ${session.key} is active`,
                    });
                    await new Promise((resolve) => setTimeout(resolve, 1_000));
                    return { value: 1 };
                  },
                  conflictHandling: {
                    // Never stored: the edit has no conflict
                    schema: rc_unknown,
                    detectConflict: () => {
                      events.add({
                        event: `detect-conflict while ${session.key} is active`,
                      });
                      return false;
                    },
                  },
                }
              : {}),
            execute: async (ctx) => {
              events.add({
                event: `execute while ${session.key} is active`,
                refs: ctx.uploads.resolvedRefsById,
              });
              await env.serverMock.delayedSetData(ctx.input.value);
              return { value: ctx.input.value };
            },
          },
        },
      },
    },
  });
  await flushAllTimers();

  // Offline in org A: stage the files and queue the edit that needs them.
  for (const id of args.fileIds) {
    await resolveWithin(
      storeManager.saveOfflineUpload({
        id,
        file: new File([id], `${id}.txt`, { type: 'text/plain' }),
      }),
    );
  }
  await resolveWithin(
    env.apiStore.performMutation({
      mutation: () => Promise.resolve({ value: 2 }),
      offline: {
        operation: 'updateWithAttachments',
        input: { attachmentIds: args.fileIds, value: 2 },
      },
    }),
  );

  // Back online, the replay starts uploading the files of org A; the user
  // switches to org B while the first upload is still being sent.
  events.addMark('back online in org A');
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await advanceTime(500);
  events.addMark(
    args.switchMark ?? 'switch to org B while the first upload is being sent',
  );
  session.key = ORG_B;
  await advanceTime(5_000);

  return {
    events,
    getOrgAQueue: () =>
      getOfflineQueueEntries(ORG_A, ORG_SWITCH_STORE).map((entry) =>
        pick(getOfflineQueueEntryData(entry), [
          'syncState',
          'attempts',
          'lastError',
          'input',
        ]),
      ),
    /** The uploads and resolutions of the active session (org A once back). */
    getUploadsAndResolutions: () => ({
      uploads: storeManager
        .getOfflineUploads()
        .map((upload) => `${upload.id}: ${upload.state}`),
      resolutions: storeManager.getOfflineResolutions(),
    }),
    switchBackToOrgA: () => {
      events.addMark('switch back to org A');
      session.key = ORG_A;
    },
    /** The next fetch of the store resumes the replay of the active session. */
    fetchAndWaitForReplay: async () => {
      env.scheduleFetch('highPriority');
      await advanceTime(5_000);
    },
  };
}

test('switching org while a replayed mutation waits for its uploads keeps the work queued for the old org instead of sending it in the new one', async () => {
  // One upload at a time: the second file is still waiting for its turn when
  // the user switches org.
  const { events, getOrgAQueue, switchBackToOrgA, fetchAndWaitForReplay } =
    await setupOrgSwitchReplay({
      fileIds: ['file-1', 'file-2'],
      uploadConcurrency: 1,
    });

  // The upload already in flight finishes, but nothing else of org A runs
  // while org B is active: the second file is not sent and the edit does not
  // reach the server.
  expect(events.changesSnapshot).toMatchInlineSnapshot(`
    "

    >>> back online in org A

    -> event: upload-start file-1 (owner: offline-upload-org-a)

    >>> switch to org B while the first upload is being sent

    -> event: upload-finish file-1
    "
  `);

  // The edit is still queued for org A as it was: no failed attempt is
  // recorded, so it does not end up in manual resolution.
  expect(getOrgAQueue()).toMatchInlineSnapshot(`
    - attempts: 0
      input:
        attachmentIds: ['file-1', 'file-2']
        value: 2
      syncState: 'pending'
  `);

  // Switching back to org A resumes the work: the file already uploaded is
  // not sent again, and the edit is replayed with both refs.
  switchBackToOrgA();
  await fetchAndWaitForReplay();

  expect(events.changesSnapshot).toMatchInlineSnapshot(`
    "

    >>> back online in org A

    -> event: upload-start file-1 (owner: offline-upload-org-a)

    >>> switch to org B while the first upload is being sent

    -> event: upload-finish file-1
    ⋅⋅⋅
    >>> switch back to org A

    -> event: upload-start file-2 (owner: offline-upload-org-a)
    -> event: upload-finish file-2
    ┌─
    ⋅ event: execute while offline-upload-org-a is active
    ⋅ refs: {file-1:server:file-1, file-2:server:file-2}
    └─
    "
  `);
  expect(getOrgAQueue()).toMatchInlineSnapshot(`[]`);
});

test('an upload that finishes after switching org does not let the old org mutation be sent in the new org', async () => {
  const { events, getOrgAQueue, switchBackToOrgA, fetchAndWaitForReplay } =
    await setupOrgSwitchReplay({ fileIds: ['file-1'] });

  // The only upload of the edit finishes after the switch, which is when the
  // replay would send the edit: it waits for org A instead.
  expect(events.changesSnapshot).toMatchInlineSnapshot(`
    "

    >>> back online in org A

    -> event: upload-start file-1 (owner: offline-upload-org-a)

    >>> switch to org B while the first upload is being sent

    -> event: upload-finish file-1
    "
  `);
  expect(getOrgAQueue()).toMatchInlineSnapshot(`
    - attempts: 0
      input:
        attachmentIds: ['file-1']
        value: 2
      syncState: 'pending'
  `);

  switchBackToOrgA();
  await fetchAndWaitForReplay();

  // Back in org A, the edit is sent with the ref uploaded before the switch.
  expect(events.changesSnapshot).toMatchInlineSnapshot(`
    "

    >>> back online in org A

    -> event: upload-start file-1 (owner: offline-upload-org-a)

    >>> switch to org B while the first upload is being sent

    -> event: upload-finish file-1
    ⋅⋅⋅
    >>> switch back to org A

    ┌─
    ⋅ event: execute while offline-upload-org-a is active
    ⋅ refs: {file-1:server:file-1}
    └─
    "
  `);
  expect(getOrgAQueue()).toMatchInlineSnapshot(`[]`);
});

test('an upload rejected after switching org leaves the old org mutation queued instead of sending it to manual resolution', async () => {
  // The first transport attempt is rejected after the switch, e.g. because
  // the app's credentials now belong to org B.
  let uploadAttempts = 0;
  const {
    events,
    getOrgAQueue,
    getUploadsAndResolutions,
    switchBackToOrgA,
    fetchAndWaitForReplay,
  } = await setupOrgSwitchReplay({
    fileIds: ['file-1'],
    uploadResult: () => {
      uploadAttempts += 1;
      return uploadAttempts === 1 ? 'rejected' : 'ok';
    },
  });

  // An unclassified upload failure normally moves the edit to manual
  // resolution and marks the upload `failed`. Rejected after the switch, it
  // says nothing about the edit, which stays queued as it was.
  expect(events.changesSnapshot).toMatchInlineSnapshot(`
    "

    >>> back online in org A

    -> event: upload-start file-1 (owner: offline-upload-org-a)

    >>> switch to org B while the first upload is being sent

    -> event: upload-rejected file-1
    "
  `);
  expect(getOrgAQueue()).toMatchInlineSnapshot(`
    - attempts: 0
      input:
        attachmentIds: ['file-1']
        value: 2
      syncState: 'pending'
  `);

  // Back in org A, before the replay resumes: the upload is still `pending`,
  // not `failed`, and no resolution was created for the edit.
  switchBackToOrgA();
  expect(getUploadsAndResolutions()).toMatchInlineSnapshot(`
    resolutions: []
    uploads: ['file-1: pending']
  `);

  // The upload is sent again and the edit replays.
  await fetchAndWaitForReplay();

  expect(events.changesSnapshot).toMatchInlineSnapshot(`
    "

    >>> back online in org A

    -> event: upload-start file-1 (owner: offline-upload-org-a)

    >>> switch to org B while the first upload is being sent

    -> event: upload-rejected file-1
    ⋅⋅⋅
    >>> switch back to org A

    -> event: upload-start file-1 (owner: offline-upload-org-a)
    -> event: upload-finish file-1
    ┌─
    ⋅ event: execute while offline-upload-org-a is active
    ⋅ refs: {file-1:server:file-1}
    └─
    "
  `);
  expect(getOrgAQueue()).toMatchInlineSnapshot(`[]`);
  expect(getUploadsAndResolutions()).toMatchInlineSnapshot(`
    resolutions: []
    uploads: []
  `);
});

test('switching org while a replayed mutation loads its server snapshot keeps it queued without checking it for conflicts or sending it', async () => {
  // No uploads: the edit only loads the server snapshot (1s) before it is
  // checked for conflicts and sent, and the user switches org meanwhile.
  const {
    events,
    getOrgAQueue,
    getUploadsAndResolutions,
    switchBackToOrgA,
    fetchAndWaitForReplay,
  } = await setupOrgSwitchReplay({
    fileIds: [],
    checksServerConflicts: true,
    switchMark: 'switch to org B while the server snapshot is loading',
  });

  // The snapshot of org A is not judged, nor the edit sent, from org B: the
  // app's conflict check could compare it with org B's data.
  expect(events.changesSnapshot).toMatchInlineSnapshot(`
    "

    >>> back online in org A

    -> event: get-server-snapshot while offline-upload-org-a is active

    >>> switch to org B while the server snapshot is loading
    "
  `);

  // Still queued for org A as it was, with no attempt counted.
  expect(getOrgAQueue()).toMatchInlineSnapshot(`
    - attempts: 0
      input:
        attachmentIds: []
        value: 2
      syncState: 'pending'
  `);

  // Back in org A, before the replay resumes: no resolution was created.
  switchBackToOrgA();
  expect(getUploadsAndResolutions().resolutions).toMatchInlineSnapshot(`[]`);

  // The snapshot is loaded again and the edit is sent.
  await fetchAndWaitForReplay();

  expect(events.changesSnapshot).toMatchInlineSnapshot(`
    "

    >>> back online in org A

    -> event: get-server-snapshot while offline-upload-org-a is active

    >>> switch to org B while the server snapshot is loading
    ⋅⋅⋅
    >>> switch back to org A

    -> event: get-server-snapshot while offline-upload-org-a is active
    -> event: detect-conflict while offline-upload-org-a is active
    -> event: execute while offline-upload-org-a is active ⋅ refs: {}
    "
  `);
  expect(getOrgAQueue()).toMatchInlineSnapshot(`[]`);
});

test('switching org while the upload state is saved on a slow device does not send the old org upload', async () => {
  // Saving the upload as `uploading` takes 1s, and the user switches org
  // while it is saved, just before the file would be sent.
  const {
    events,
    getOrgAQueue,
    getUploadsAndResolutions,
    switchBackToOrgA,
    fetchAndWaitForReplay,
  } = await setupOrgSwitchReplay({
    fileIds: ['file-1'],
    uploadingStateSaveMs: 1_000,
    switchMark: 'switch to org B while the upload state is being saved',
  });

  // The file of org A is never sent while org B is active.
  expect(events.changesSnapshot).toMatchInlineSnapshot(`
    "

    >>> back online in org A

    >>> switch to org B while the upload state is being saved
    "
  `);
  expect(getOrgAQueue()).toMatchInlineSnapshot(`
    - attempts: 0
      input:
        attachmentIds: ['file-1']
        value: 2
      syncState: 'pending'
  `);

  // Back in org A, the upload is `pending` again, with no failure recorded.
  switchBackToOrgA();
  expect(getUploadsAndResolutions()).toMatchInlineSnapshot(`
    resolutions: []
    uploads: ['file-1: pending']
  `);

  await fetchAndWaitForReplay();

  expect(events.changesSnapshot).toMatchInlineSnapshot(`
    "

    >>> back online in org A

    >>> switch to org B while the upload state is being saved
    ⋅⋅⋅
    >>> switch back to org A

    -> event: upload-start file-1 (owner: offline-upload-org-a)
    -> event: upload-finish file-1
    ┌─
    ⋅ event: execute while offline-upload-org-a is active
    ⋅ refs: {file-1:server:file-1}
    └─
    "
  `);
  expect(getOrgAQueue()).toMatchInlineSnapshot(`[]`);
});
