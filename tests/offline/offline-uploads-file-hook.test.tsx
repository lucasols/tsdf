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
import { createStoreManager, opfsOfflineUploadAdapter } from '../../src/main';
import { createOfflineNetworkMock } from '../../src/testing';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createMockBrowserOpfs } from '../mocks/mockBrowserOpfs';
import { normalizeError, TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import {
  advanceTime,
  flushAllTimers,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import { resetSessionForTests } from '../utils/resetSessionForTests';
import type { UpdateValueOperations as DirectUploadUpdateOperations } from './offlineReplayTestShared';
import { docSchema } from './offlineTestShared';

let network = createOfflineNetworkMock();
const ATTACHED_UPLOAD_FILE_ID_PATTERN =
  /^offline-upload-file-attached-doc:[^:]+:[^:]+:avatar$/;

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

  // The staged upload was deleted once its only queued mutation replayed, which
  // happened after the entity already pointed to the server ref.
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
