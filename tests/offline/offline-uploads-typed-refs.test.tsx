import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import type { DocumentOfflineOperationDefinition } from '../../src/main';
import { createStoreManager, opfsOfflineUploadAdapter } from '../../src/main';
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
import { getParsedOpfsFileData } from '../utils/persistentStorageOptimizationTestUtils';
import { resetSessionForTests } from '../utils/resetSessionForTests';
import { docSchema } from './offlineTestShared';

let network = createOfflineNetworkMock();

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

type UploadDependencyOperations = {
  updateWithAttachment: DocumentOfflineOperationDefinition<
    { value: number },
    { input: { attachmentId: string; value: number } }
  >;
};

const uploadedFileRefSchema = rc_object({ fileId: rc_string, url: rc_string });

async function reconnect() {
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await advanceTime(0);
}

async function disconnect() {
  await act(async () => {
    network.goOffline();
    await Promise.resolve();
  });
  await advanceTime(0);
}

test('after an app update changes the upload ref shape, restored refs that fail the resolved ref schema are uploaded again while refs that still match are reused', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'offline-upload-ref-schema-restart-session';
  const transportCalls: string[] = [];

  // The previous app version resolved uploads to plain string refs and had no
  // schema for them.
  function createPreviousVersionManager() {
    return createStoreManager({
      getSessionKey: () => sessionKey,
      errorNormalizer: normalizeError,
      offlineSession: {
        network: network.config,
        uploads: {
          adapter: opfsOfflineUploadAdapter,
          upload: ({ id }) => {
            transportCalls.push(`previous version uploads ${id}`);
            return Promise.resolve(`legacy-ref:${id}`);
          },
        },
      },
    });
  }

  // The updated app resolves uploads to `{ fileId, url }` objects and declares
  // that shape, so refs restored from storage are validated against it.
  function createUpdatedVersionManager() {
    return createStoreManager({
      getSessionKey: () => sessionKey,
      errorNormalizer: normalizeError,
      offlineSession: {
        network: network.config,
        uploads: {
          adapter: opfsOfflineUploadAdapter,
          upload: ({ id, file }) => {
            transportCalls.push(`updated version uploads ${id} (${file.name})`);
            return Promise.resolve({
              fileId: `file-${id}`,
              url: `https://cdn.test/${id}`,
            });
          },
          resolvedRefSchema: uploadedFileRefSchema,
        },
      },
    });
  }

  // --- Previous app version: a file is staged offline and uploaded once the
  // connection is back, which persists its legacy string ref.
  network.setOffline();
  const previousVersion = createPreviousVersionManager();
  await flushAllTimers();
  (
    await resolveAfterAllTimers(
      previousVersion.saveOfflineUpload({
        id: 'legacy-file',
        file: new File(['legacy attachment'], 'legacy.txt', {
          type: 'text/plain',
          lastModified: 1,
        }),
      }),
    )
  ).unwrap();
  await reconnect();
  const legacyRef = (
    await resolveAfterAllTimers(
      previousVersion.resolveOfflineUpload('legacy-file'),
    )
  ).unwrap();
  expect(legacyRef).toMatchInlineSnapshot(`"legacy-ref:legacy-file"`);
  await disconnect();
  // Let the storage writes settle before simulating a restart.
  await flushAllTimers();

  // --- The app is updated and restarted while the user is still offline.
  resetSessionForTests();
  const updatedVersion = createUpdatedVersionManager();
  const updatedUploadsHook = renderHook(() =>
    updatedVersion.useOfflineUploads(),
  );
  await flushAllTimers();

  // The stored legacy ref does not match the schema, so the upload is exposed
  // as not uploaded yet instead of handing out a ref with the wrong shape.
  expect(
    updatedUploadsHook.result.current.map((upload) =>
      pick(upload, ['id', 'state', 'resolvedRef']),
    ),
  ).toMatchInlineSnapshot(`
    - { id: 'legacy-file', state: 'pending' }
  `);

  // A file staged and uploaded by the updated app gets a ref in the new shape.
  (
    await resolveAfterAllTimers(
      updatedVersion.saveOfflineUpload({
        id: 'new-file',
        file: new File(['new attachment'], 'new.txt', {
          type: 'text/plain',
          lastModified: 1,
        }),
      }),
    )
  ).unwrap();
  await reconnect();
  (
    await resolveAfterAllTimers(updatedVersion.resolveOfflineUpload('new-file'))
  ).unwrap();
  await disconnect();
  // Let the storage writes settle before simulating the next restart.
  await flushAllTimers();
  updatedUploadsHook.unmount();

  // --- The updated app restarts again, still offline.
  resetSessionForTests();
  const restartedVersion = createUpdatedVersionManager();
  const restartedUploadsHook = renderHook(() =>
    restartedVersion.useOfflineUploads(),
  );
  await flushAllTimers();
  transportCalls.push('--- updated app restarted ---');

  // The ref that matches the schema is restored as uploaded, while the legacy
  // one is still treated as pending.
  expect(
    restartedUploadsHook.result.current.map((upload) =>
      pick(upload, ['id', 'state', 'resolvedRef']),
    ),
  ).toMatchInlineSnapshot(`
    - { id: 'legacy-file', state: 'pending' }
    - id: 'new-file'
      resolvedRef: { fileId: 'file-new-file', url: 'https://cdn.test/new-file' }
      state: 'uploaded'
  `);

  // Back online, the app resolves both uploads.
  await reconnect();
  const resolvedRefs = (
    await resolveAfterAllTimers(
      restartedVersion.resolveOfflineUploads(['legacy-file', 'new-file']),
    )
  ).unwrap();

  // Both refs come back in the shape the updated app expects.
  expect(resolvedRefs).toMatchInlineSnapshot(`
    legacy-file: { fileId: 'file-legacy-file', url: 'https://cdn.test/legacy-file' }
    new-file: { fileId: 'file-new-file', url: 'https://cdn.test/new-file' }
  `);

  // After the restart only the legacy upload is sent again, from the file
  // that is still staged; the valid ref is reused without a second upload.
  expect(transportCalls).toMatchInlineSnapshot(`
    - 'previous version uploads legacy-file'
    - 'updated version uploads new-file (new.txt)'
    - '--- updated app restarted ---'
    - 'updated version uploads legacy-file (legacy.txt)'
  `);

  // The fresh ref replaced the legacy one in storage (key `r`), so the next
  // restart restores this upload as uploaded.
  const persistedLegacyUpload = getParsedOpfsFileData(
    getOfflineUploadOpfsPath(sessionKey, 'legacy-file', 'metadata.json'),
  );
  expect(
    persistedLegacyUpload &&
      typeof persistedLegacyUpload === 'object' &&
      !Array.isArray(persistedLegacyUpload)
      ? pick(Object.fromEntries(Object.entries(persistedLegacyUpload)), [
          'r',
          't',
        ])
      : null,
  ).toMatchInlineSnapshot(`
    r: { fileId: 'file-legacy-file', url: 'https://cdn.test/legacy-file' }
    t: 'uploaded'
  `);

  restartedUploadsHook.unmount();
});

type UploadedFileRef = { fileId: string; url: string };

type TypedUploadDependencyOperations = {
  updateWithAttachment: DocumentOfflineOperationDefinition<
    { value: number },
    { input: { attachmentId: string; value: number } },
    UploadedFileRef
  >;
};

test('a queued mutation replays with a freshly uploaded ref when the ref stored for its upload dependency fails the resolved ref schema', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'offline-upload-ref-schema-replay-session';
  const storeId = 'offline-upload-ref-schema-replay-doc';
  const replayEvents: Array<Record<string, unknown>> = [];
  const attachmentInputSchema = rc_object({
    attachmentId: rc_string,
    value: rc_number,
  });

  // --- Previous app version: uploads resolve to plain string refs.
  network.setOffline();
  const previousStoreManager = createStoreManager({
    getSessionKey: () => sessionKey,
    errorNormalizer: normalizeError,
    offlineSession: {
      network: network.config,
      uploads: {
        adapter: opfsOfflineUploadAdapter,
        upload: ({ id }) => Promise.resolve(`legacy-ref:${id}`),
      },
    },
  });
  const previousEnv = createDocumentStoreTestEnv<
    number,
    UploadDependencyOperations
  >(1, {
    id: storeId,
    storeManager: previousStoreManager,
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        operations: {
          updateWithAttachment: {
            inputSchema: attachmentInputSchema,
            kind: 'update',
            dependsOnUploads: ({ input }) => [input.attachmentId],
            execute: (ctx) => ({ value: ctx.input.value }),
            onSuccessExecute: () => {},
          },
        },
      },
    },
  });
  await flushAllTimers();

  // The attachment is staged and then uploaded while online, which persists
  // its legacy string ref...
  (
    await resolveAfterAllTimers(
      previousStoreManager.saveOfflineUpload({
        id: 'asset-1',
        file: new File(['attachment body'], 'attachment.txt', {
          type: 'text/plain',
          lastModified: 1,
        }),
      }),
    )
  ).unwrap();
  await reconnect();
  (
    await resolveAfterAllTimers(
      previousStoreManager.resolveOfflineUpload('asset-1'),
    )
  ).unwrap();

  // ...and the mutation that uses it is queued after the connection drops.
  await disconnect();
  await resolveAfterAllTimers(
    previousEnv.apiStore.performMutation({
      optimisticUpdate: () => {
        previousEnv.apiStore.updateState((draft) => {
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

  expect(
    previousStoreManager
      .getOfflineUploads()
      .map((upload) => pick(upload, ['id', 'state', 'resolvedRef'])),
  ).toMatchInlineSnapshot(`
    - { id: 'asset-1', resolvedRef: 'legacy-ref:asset-1', state: 'uploaded' }
  `);

  // --- The app is updated and restarted while still offline. Uploads now
  // resolve to `{ fileId, url }` and the session validates restored refs.
  resetSessionForTests();
  const storeManager = createStoreManager({
    getSessionKey: () => sessionKey,
    errorNormalizer: normalizeError,
    offlineSession: {
      network: network.config,
      uploads: {
        adapter: opfsOfflineUploadAdapter,
        upload: async ({ id, file }) => {
          replayEvents.push({ transport: id, fileText: await file.text() });
          return { fileId: `file-${id}`, url: `https://cdn.test/${id}` };
        },
        resolvedRefSchema: uploadedFileRefSchema,
      },
    },
  });
  const env = createDocumentStoreTestEnv<
    number,
    TypedUploadDependencyOperations
  >(1, {
    id: storeId,
    storeManager,
    testScenario: 'idle',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        operations: {
          updateWithAttachment: {
            inputSchema: attachmentInputSchema,
            kind: 'update',
            dependsOnUploads: ({ input }) => [input.attachmentId],
            execute: async (ctx) => {
              // Typed as `UploadedFileRef | undefined` by the operation type.
              const uploadedFile =
                ctx.uploads.resolvedRefsById[ctx.input.attachmentId];
              replayEvents.push({ execute: uploadedFile });
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

  // The restored legacy ref fails the schema, so the dependency is pending
  // again. Nothing replays while offline.
  expect(
    storeManager
      .getOfflineUploads()
      .map((upload) => pick(upload, ['id', 'state', 'resolvedRef'])),
  ).toMatchInlineSnapshot(`
    - { id: 'asset-1', state: 'pending' }
  `);
  expect(replayEvents).toMatchInlineSnapshot(`[]`);

  // Reconnect so the restored queue replays.
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await flushAllTimers();
  await act(async () => {
    await Promise.resolve();
  });
  await flushAllTimers();

  // The staged file is uploaded again by the updated transport and the
  // mutation executes with a ref in the shape it expects, never with the
  // legacy string.
  expect(replayEvents).toMatchInlineSnapshot(`
    - { fileText: 'attachment body', transport: 'asset-1' }
    - execute: { fileId: 'file-asset-1', url: 'https://cdn.test/asset-1' }
  `);
  expect(env.serverMock.current).toBe(3);
});

test('a tab on the updated app does not resolve a file another tab sent and deleted to a ref of the previous version that fails its resolved ref schema', async () => {
  createMockBrowserOpfs();
  installInMemoryBroadcastChannel();
  const sessionKey = 'offline-upload-ref-schema-released-session';
  const storeId = 'offline-upload-ref-schema-released-doc';
  const sentRefs: unknown[] = [];

  network.setOffline();

  // --- First tab: still running the previous app version, which resolves
  // uploads to plain string refs. It has the form that saves the edit.
  const previousVersionTab = createStoreManager({
    getSessionKey: () => sessionKey,
    errorNormalizer: normalizeError,
    offlineSession: {
      network: network.config,
      uploads: {
        adapter: opfsOfflineUploadAdapter,
        upload: ({ id }) => Promise.resolve(`legacy-ref:${id}`),
      },
    },
  });
  const previousEnv = createDocumentStoreTestEnv<
    number,
    UploadDependencyOperations
  >(1, {
    id: storeId,
    storeManager: previousVersionTab,
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
            execute: (ctx) => {
              sentRefs.push(
                ctx.uploads.resolvedRefsById[ctx.input.attachmentId],
              );
              return { value: ctx.input.value };
            },
            onSuccessExecute: () => {},
          },
        },
      },
    },
  });
  // The first tab is the one in front, so it leads and sends queued edits.
  await flushAllTimers();

  // --- Second tab: opened in the background after a deploy, so it runs the
  // updated app. A separate instance of the library stands for the separate
  // tab.
  setDocumentHidden(true);
  vi.resetModules();
  const updatedTabLib = await import('../../src/main');
  const updatedTabSessionCoordinator =
    await import('../../src/persistentStorage/offline/sessionCoordinator');

  try {
    const updatedVersionTab = updatedTabLib.createStoreManager({
      getSessionKey: () => sessionKey,
      errorNormalizer: normalizeError,
      offlineSession: {
        network: network.config,
        uploads: {
          adapter: updatedTabLib.opfsOfflineUploadAdapter,
          upload: ({ id }) =>
            Promise.resolve({
              fileId: `file-${id}`,
              url: `https://cdn.test/${id}`,
            }),
          resolvedRefSchema: uploadedFileRefSchema,
        },
      },
    });
    updatedVersionTab.getOfflineStatus();
    await flushAllTimers();
    // Every tab reads the same `document.hidden`; the background tab only
    // had to start hidden to not take over leadership.
    setDocumentHidden(false);

    // While offline, the user picks a photo in the first tab and saves an
    // edit that uses it.
    (
      await resolveAfterAllTimers(
        previousVersionTab.saveOfflineUpload({
          id: 'avatar',
          file: new File(['avatar body'], 'avatar.png', {
            type: 'image/png',
            lastModified: 1,
          }),
        }),
      )
    ).unwrap();
    await resolveAfterAllTimers(
      previousEnv.apiStore.performMutation({
        mutation: () => Promise.resolve({ value: 2 }),
        offline: {
          operation: 'updateWithAttachment',
          input: { attachmentId: 'avatar', value: 2 },
        },
      }),
    );
    await flushAllTimers();

    // On reconnect the first tab uploads the photo, sends the edit, and
    // deletes the photo: no queued work uses it anymore.
    await reconnect();
    await flushAllTimers();
    expect(sentRefs).toMatchInlineSnapshot(`['legacy-ref:avatar']`);

    // The first tab still resolves the id to its own ref, for app data that
    // holds it...
    const previousTabResult = await resolveAfterAllTimers(
      previousVersionTab.resolveOfflineUpload('avatar'),
    );
    expect(previousTabResult.unwrap()).toBe('legacy-ref:avatar');

    // ...but the updated tab never hands out the previous version's ref,
    // which fails its schema. The file is already deleted, so the id is
    // unknown there.
    const updatedTabResult = await resolveAfterAllTimers(
      updatedVersionTab.resolveOfflineUpload('avatar'),
    );
    expect(
      updatedTabResult.ok
        ? updatedTabResult.value
        : updatedTabResult.error.message,
    ).toBe('Unknown offline upload "avatar"');
  } finally {
    setDocumentHidden(false);
    // The second library instance is not covered by `resetSessionForTests`.
    updatedTabSessionCoordinator.__resetSessionOfflineCoordinatorRegistryForTests();
    vi.unstubAllGlobals();
  }
});

function setDocumentHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', {
    value: hidden,
    writable: true,
    configurable: true,
  });
}

/**
 * Replaces the global `BroadcastChannel` with an in-memory one, so two
 * instances of the library can sync with each other like two browser tabs.
 */
function installInMemoryBroadcastChannel(): void {
  const channelsByName = new Map<string, Set<InMemoryBroadcastChannel>>();

  class InMemoryBroadcastChannel extends EventTarget {
    readonly name: string;

    constructor(name: string) {
      super();
      this.name = name;
      const channels = channelsByName.get(name) ?? new Set();
      channels.add(this);
      channelsByName.set(name, channels);
    }

    postMessage(message: unknown) {
      // Like the real channel, messages are structured-cloned and delivered
      // asynchronously to every other channel with the same name.
      const serializedMessage = structuredClone(message);
      for (const peer of channelsByName.get(this.name) ?? []) {
        if (peer === this) continue;

        setTimeout(() => {
          peer.dispatchEvent(
            new MessageEvent('message', {
              data: structuredClone(serializedMessage),
            }),
          );
        }, 0);
      }
    }

    close() {
      channelsByName.get(this.name)?.delete(this);
    }
  }

  vi.stubGlobal('BroadcastChannel', InMemoryBroadcastChannel);
}

test('a tab on the updated app does not expose refs published by a tab still on the previous version when they fail its resolved ref schema', async () => {
  createMockBrowserOpfs();
  installInMemoryBroadcastChannel();
  const sessionKey = 'offline-upload-ref-schema-tabs-session';
  const validatedRefs: unknown[] = [];
  const updatedTabTransportCalls: string[] = [];

  network.setOffline();

  // --- First tab: still running the previous app version, which resolves
  // uploads to plain string refs.
  const previousVersionTab = createStoreManager({
    getSessionKey: () => sessionKey,
    errorNormalizer: normalizeError,
    offlineSession: {
      network: network.config,
      uploads: {
        adapter: opfsOfflineUploadAdapter,
        upload: ({ id }) => Promise.resolve(`legacy-ref:${id}`),
      },
    },
  });
  previousVersionTab.getOfflineStatus();

  // --- Second tab: opened after a deploy, so it runs the updated app. A
  // separate instance of the library stands for the separate tab.
  vi.resetModules();
  const updatedTabLib = await import('../../src/main');
  const updatedTabSessionCoordinator =
    await import('../../src/persistentStorage/offline/sessionCoordinator');

  try {
    const updatedVersionTab = updatedTabLib.createStoreManager({
      getSessionKey: () => sessionKey,
      errorNormalizer: normalizeError,
      offlineSession: {
        network: network.config,
        uploads: {
          adapter: updatedTabLib.opfsOfflineUploadAdapter,
          upload: ({ id, file }) => {
            updatedTabTransportCalls.push(`${id} (${file.name})`);
            return Promise.resolve({
              fileId: `file-${id}`,
              url: `https://cdn.test/${id}`,
            });
          },
          // Records every ref the session validates.
          resolvedRefSchema: z.preprocess(
            (ref) => {
              validatedRefs.push(ref);
              return ref;
            },
            z.object({ fileId: z.string(), url: z.string() }),
          ),
        },
      },
    });
    updatedVersionTab.getOfflineStatus();
    await flushAllTimers();

    // The first tab stages a file and uploads it once it is back online.
    (
      await resolveAfterAllTimers(
        previousVersionTab.saveOfflineUpload({
          id: 'avatar',
          file: new File(['avatar body'], 'avatar.png', {
            type: 'image/png',
            lastModified: 1,
          }),
        }),
      )
    ).unwrap();
    await reconnect();
    (
      await resolveAfterAllTimers(
        previousVersionTab.resolveOfflineUpload('avatar'),
      )
    ).unwrap();
    // Staging another file makes the first tab publish its uploads again,
    // including the already uploaded one.
    (
      await resolveAfterAllTimers(
        previousVersionTab.saveOfflineUpload({
          id: 'cover',
          file: new File(['cover body'], 'cover.png', {
            type: 'image/png',
            lastModified: 1,
          }),
        }),
      )
    ).unwrap();
    await advanceTime(0);

    // The first tab sees its own legacy ref...
    expect(
      previousVersionTab
        .getOfflineUploads()
        .map((upload) => pick(upload, ['id', 'state', 'resolvedRef'])),
    ).toMatchInlineSnapshot(`
      - { id: 'avatar', resolvedRef: 'legacy-ref:avatar', state: 'uploaded' }
      - { id: 'cover', state: 'pending' }
    `);
    // ...but the updated tab received a ref that fails its schema, so it
    // lists the upload as not uploaded yet instead of exposing that ref.
    expect(
      updatedVersionTab
        .getOfflineUploads()
        .map((upload) => pick(upload, ['id', 'state', 'resolvedRef'])),
    ).toMatchInlineSnapshot(`
      - { id: 'avatar', state: 'pending' }
      - { id: 'cover', state: 'pending' }
    `);
    // The ref was published more than once, but validated a single time.
    expect(validatedRefs).toMatchInlineSnapshot(`['legacy-ref:avatar']`);

    // When the updated tab needs the ref, it uploads the staged file itself.
    const resolvedRef = (
      await resolveAfterAllTimers(
        updatedVersionTab.resolveOfflineUpload('avatar'),
      )
    ).unwrap();

    expect(resolvedRef).toMatchInlineSnapshot(`
      fileId: 'file-avatar'
      url: 'https://cdn.test/avatar'
    `);
    expect(updatedTabTransportCalls).toMatchInlineSnapshot(`
      ['avatar (avatar.png)']
    `);
  } finally {
    // The second library instance is not covered by `resetSessionForTests`.
    updatedTabSessionCoordinator.__resetSessionOfflineCoordinatorRegistryForTests();
    vi.unstubAllGlobals();
  }
});
