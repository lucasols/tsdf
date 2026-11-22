import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import { rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  CollectionOfflineOperationDefinition,
  DocumentOfflineOperationDefinition,
  ListQueryOfflineOperationDefinition,
  PersistentStorageSchema,
  ValidPayload,
} from '../../src/main';
import type { OfflineNetworkModeConfig } from '../../src/persistentStorage/offline/types';
import { createOfflineNetworkMock } from '../../src/testing';
import type { ListQueryParams } from '../mocks/listQueryStoreTestEnv';
import { createMockBrowserOpfs } from '../mocks/mockBrowserOpfs';
import { createSharedServerMockState } from '../mocks/serverMock';
import { createSharedServerTableState } from '../mocks/serverTableMock';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import { advanceTime } from '../utils/genericTestUtils';
import { getOpfsDirTree } from '../utils/persistentStorageOptimizationTestUtils';
import {
  type CreateListQueryUserOperations,
  type CreateUserOperations,
  type UpdateValueConflictOperations,
  type UpdateValueOperations,
  userRowSchema,
} from './offlineReplayTestShared';
import {
  collectionCreateInputSchema,
  collectionSchema,
  docConflictSchema,
  docMutationInputSchema,
  docSchema,
  listQueryQueryPayloadSchema,
} from './offlineTestShared';

/**
 * In-memory `BroadcastChannel` shared by every simulated tab. Like the real
 * one, a message is cloned, never delivered back to its sender, and delivered
 * asynchronously.
 */
class TestBroadcastChannel {
  static channels = new Map<string, Set<TestBroadcastChannel>>();
  readonly listeners = new Set<(event: { data: unknown }) => void>();
  readonly name: string;

  constructor(name: string) {
    this.name = name;
    const peers = TestBroadcastChannel.channels.get(name) ?? new Set();
    peers.add(this);
    TestBroadcastChannel.channels.set(name, peers);
  }

  addEventListener(
    _type: 'message',
    listener: (event: { data: unknown }) => void,
  ) {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: 'message',
    listener: (event: { data: unknown }) => void,
  ) {
    this.listeners.delete(listener);
  }

  postMessage(data: unknown) {
    for (const peer of TestBroadcastChannel.channels.get(this.name) ?? []) {
      if (peer === this) continue;
      const copy = structuredClone(data);
      setTimeout(() => {
        for (const listener of peer.listeners) listener({ data: copy });
      }, 0);
    }
  }

  close() {
    TestBroadcastChannel.channels.get(this.name)?.delete(this);
    this.listeners.clear();
  }
}

type LockCallback<T> = (lock: { name: string } | null) => T | Promise<T>;

/**
 * `navigator.locks` shared by every simulated tab, like the browser's lock
 * manager is shared by the tabs of an origin: a lock is held by one tab at a
 * time, other requests wait for it in order, and an `ifAvailable` request gets
 * `null` while another tab holds it.
 */
function createSharedLockManager() {
  const waitingByName = new Map<string, Array<() => void>>();

  async function request<T>(
    name: string,
    optionsOrCallback: LockCallback<T> | { ifAvailable?: boolean },
    callback?: LockCallback<T>,
  ): Promise<T> {
    const run =
      typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
    if (!run) throw new Error('navigator.locks.request needs a callback');
    const ifAvailable =
      typeof optionsOrCallback !== 'function' &&
      optionsOrCallback.ifAvailable === true;

    const waiting = waitingByName.get(name);
    if (waiting) {
      if (ifAvailable) return await run(null);
      await new Promise<void>((acquire) => {
        waiting.push(acquire);
      });
    } else {
      waitingByName.set(name, []);
    }

    try {
      return await run({ name });
    } finally {
      // Hand the lock straight to the next waiting request, if any
      const next = waitingByName.get(name)?.shift();
      if (next) next();
      else waitingByName.delete(name);
    }
  }

  return { request };
}

const addToValueInputSchema = rc_object({ amount: rc_number });

const sessionKey = 'cross-tab-session';
let network = createOfflineNetworkMock();
let serverCalls: string[] = [];
let sharedServer = createSharedServerMockState(1);
let sharedUsersServer = createSharedServerTableState<{ name: string }>({});
let sharedUserRowsServer = createSharedServerTableState<{
  id: number;
  name: string;
}>({});
const openTabs: Array<{ close: () => void }> = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
  vi.stubGlobal('BroadcastChannel', TestBroadcastChannel);
  // Restored to the single-tab mock by `vitest.setup.ts` after each test
  Object.defineProperty(globalThis.navigator, 'locks', {
    value: createSharedLockManager(),
    writable: true,
    configurable: true,
  });
  setDocumentHidden(false);
  network = createOfflineNetworkMock();
  network.install();
  serverCalls = [];
  sharedServer = createSharedServerMockState(1);
  sharedUsersServer = createSharedServerTableState({});
  sharedUserRowsServer = createSharedServerTableState({
    'users||1': { id: 1, name: 'Grace' },
  });
  localStorage.clear();
});

afterEach(() => {
  for (const tab of openTabs.splice(0)) tab.close();
  TestBroadcastChannel.channels.clear();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function setDocumentHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', {
    value: hidden,
    writable: true,
    configurable: true,
  });
}

/**
 * Adds to the document value, like a "+1" button. Several additions queued
 * offline are merged into one request.
 */
type AddToValueOperations = {
  addToValue: DocumentOfflineOperationDefinition<
    { value: number },
    { input: { amount: number } }
  >;
};

/**
 * Sets the document value with a file the user staged with
 * `saveOfflineUpload`, like a form whose file input uploads on its own.
 */
type UpdateWithAttachmentOperations = {
  updateWithAttachment: DocumentOfflineOperationDefinition<
    { value: number },
    {
      input: { value: number; attachmentId: string };
      conflict: { reason: string };
    }
  >;
};

const updateWithAttachmentInputSchema = rc_object({
  value: rc_number,
  attachmentId: rc_string,
});

/**
 * Opens a simulated browser tab: a fresh module graph, so the offline session
 * coordinator and every store registry belong to this tab only, like in a real
 * browser. Tabs share `localStorage`, `BroadcastChannel`, the network, and the
 * server.
 *
 * Every tab reads the same `document.hidden`, so a tab opened with
 * `focused: false` only starts in the background; focus changes after that go
 * through `blurWindow` and `closeTabAndFocusRemaining`.
 *
 * With `uploads: true` the tab stores offline file uploads in OPFS, shared by
 * every tab like in a real browser (install it with `createMockBrowserOpfs`).
 *
 * `network` replaces parts of the app's connectivity config (its check, its
 * recovery check) in this tab only.
 */
async function openTab(
  name: string,
  options: {
    focused: boolean;
    storeIds?: string[];
    uploads?: boolean;
    network?: Pick<OfflineNetworkModeConfig, 'getIsOffline' | 'recoveryCheck'>;
  },
) {
  setDocumentHidden(!options.focused);
  vi.resetModules();
  const [
    { createStoreManager },
    { createDocumentStoreTestEnv },
    sessionModule,
    { opfsOfflineUploadAdapter },
  ] = await Promise.all([
    import('../../src/storeManager'),
    import('../mocks/documentStoreTestEnv'),
    import('../../src/persistentStorage/offline/sessionCoordinator'),
    import('../../src/persistentStorage/opfsOfflineUploadAdapter'),
  ]);

  const storeManager = createStoreManager<ValidPayload>({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: {
      network: { ...network.config, ...options.network },
      ...(options.uploads
        ? {
            uploads: {
              adapter: opfsOfflineUploadAdapter,
              upload: ({ id }) => {
                serverCalls.push(`tab ${name} uploaded ${id}`);
                return Promise.resolve(`server:${id}`);
              },
            },
          }
        : {}),
    },
  });

  function createDocEnv(storeId: string) {
    const env = createDocumentStoreTestEnv<
      number,
      UpdateValueConflictOperations &
        AddToValueOperations &
        UpdateWithAttachmentOperations
    >(1, {
      id: storeId,
      getSessionKey: () => sessionKey,
      storeManager,
      sharedServerState: sharedServer,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              kind: 'update',
              execute: async ({ input }) => {
                serverCalls.push(
                  `tab ${name} sent ${storeId} = ${input.value}`,
                );
                await env.serverMock.delayedSetData(input.value);
                return input;
              },
              conflictHandling: {
                schema: docConflictSchema,
                // Negative values simulate an edit the server rejects.
                detectConflict: ({ input }) =>
                  input.value < 0 ? { reason: 'server-changed' } : null,
              },
            },
            updateWithAttachment: {
              inputSchema: updateWithAttachmentInputSchema,
              kind: 'update',
              dependsOnUploads: ({ input }) => [input.attachmentId],
              execute: async ({ input, uploads }) => {
                serverCalls.push(
                  `tab ${name} sent ${storeId} = ${input.value} with ${JSON.stringify(
                    uploads.resolvedRefsById[input.attachmentId],
                  )}`,
                );
                await env.serverMock.delayedSetData(input.value);
                return { value: input.value };
              },
              conflictHandling: {
                schema: docConflictSchema,
                // Negative values simulate an edit the server rejects.
                detectConflict: ({ input }) =>
                  input.value < 0 ? { reason: 'server-changed' } : null,
              },
            },
            addToValue: {
              inputSchema: addToValueInputSchema,
              kind: 'update',
              accumulation: {
                mergeInput: ({ existingInput, incomingInput }) => ({
                  amount: existingInput.amount + incomingInput.amount,
                }),
              },
              execute: async ({ input }) => {
                serverCalls.push(
                  `tab ${name} sent ${storeId} += ${input.amount}`,
                );
                await env.serverMock.delayedSetData(
                  env.serverMock.current + input.amount,
                );
                return input;
              },
            },
          },
        },
      },
    });
    return env;
  }

  const envs = new Map(
    (options.storeIds ?? ['doc']).map((storeId) => [
      storeId,
      createDocEnv(storeId),
    ]),
  );

  function getEnv(storeId = 'doc') {
    const env = envs.get(storeId);
    if (!env) throw new Error(`Store "${storeId}" is not open in tab ${name}`);
    return env;
  }

  const tab = {
    name,
    storeManager,
    getEnv,
    /** Queues an offline edit the way a user edit in this tab would. */
    async queueEdit(value: number, storeId = 'doc') {
      await getEnv(storeId).apiStore.performMutation({
        mutation: async () => {
          await getEnv(storeId).serverMock.delayedSetData(value);
          return value;
        },
        offline: { operation: 'updateValue', input: { value } },
      });
      await advanceTime(10);
    },
    /** Queues an offline "+amount" click, merged with the ones still queued. */
    async queueAddition(amount: number, storeId = 'doc') {
      await getEnv(storeId).apiStore.performMutation({
        mutation: async () => {
          const { serverMock } = getEnv(storeId);
          await serverMock.delayedSetData(serverMock.current + amount);
          return amount;
        },
        offline: { operation: 'addToValue', input: { amount } },
      });
      await advanceTime(10);
    },
    /** Queues an offline edit with an attached file, like a form with a file input. */
    async queueEditWithFile(value: number, storeId = 'doc') {
      const mutation = getEnv(storeId).apiStore.performMutation({
        mutation: async () => {
          await getEnv(storeId).serverMock.delayedSetData(value);
          return value;
        },
        offline: { operation: 'updateValue', input: { value } },
        upload: {
          avatar: new File(['avatar'], 'avatar.txt', {
            type: 'text/plain',
            lastModified: 1,
          }),
        },
      });
      // Saving the file to OPFS takes a few timer ticks
      await advanceTime(100);
      await mutation;
    },
    /** Stages a file with `saveOfflineUpload`, like a file input that uploads on its own. */
    async stageFile(uploadId: string) {
      const saved = storeManager.saveOfflineUpload({
        id: uploadId,
        file: new File(['photo'], 'photo.txt', {
          type: 'text/plain',
          lastModified: 1,
        }),
      });
      // Saving the file to OPFS takes a few timer ticks
      await advanceTime(100);
      (await saved).unwrap();
    },
    /** Queues an offline edit that uses a file staged with `stageFile`. */
    async queueEditWithStagedFile(value: number, attachmentId: string) {
      await getEnv().apiStore.performMutation({
        mutation: async () => {
          await getEnv().serverMock.delayedSetData(value);
          return value;
        },
        offline: {
          operation: 'updateWithAttachment',
          input: { value, attachmentId },
        },
      });
      await advanceTime(10);
    },
    close() {
      for (const env of envs.values()) env.apiStore.dispose();
      sessionModule.__resetSessionOfflineCoordinatorRegistryForTests();
      const index = openTabs.indexOf(tab);
      if (index >= 0) openTabs.splice(index, 1);
    },
  };
  openTabs.push(tab);
  await advanceTime(50);
  return tab;
}

/** Moves the whole browser window to the background (every tab loses focus). */
async function blurWindow() {
  setDocumentHidden(true);
  window.dispatchEvent(new Event('blur'));
  await advanceTime(10);
}

type Tab = Awaited<ReturnType<typeof openTab>>;

/** Closes `closing`, then the user focuses the window of the remaining tab. */
async function closeTabAndFocusRemaining(closing: Tab) {
  closing.close();
  await advanceTime(10);
  setDocumentHidden(false);
  window.dispatchEvent(new Event('focus'));
  await advanceTime(10);
}

type UpdateValueV2Operations = {
  updateValueV2: UpdateValueOperations['updateValue'];
  updateWithAttachmentV2: DocumentOfflineOperationDefinition<
    { value: number },
    { input: { value: number; attachmentId: string } }
  >;
};

/**
 * Opens a tab running a newer deploy of the app, where the document store's
 * offline operations were renamed to `updateValueV2` and
 * `updateWithAttachmentV2`. The app does not set
 * `getAppVersion`, so this tab shares the offline session with older tabs.
 *
 * With `uploads: true` the tab stores offline file uploads in OPFS, like
 * `openTab`.
 */
async function openNewVersionTab(
  name: string,
  options: { uploads?: boolean } = {},
) {
  setDocumentHidden(true);
  vi.resetModules();
  const [
    { createStoreManager },
    { createDocumentStoreTestEnv },
    sessionModule,
    { opfsOfflineUploadAdapter },
  ] = await Promise.all([
    import('../../src/storeManager'),
    import('../mocks/documentStoreTestEnv'),
    import('../../src/persistentStorage/offline/sessionCoordinator'),
    import('../../src/persistentStorage/opfsOfflineUploadAdapter'),
  ]);

  const storeManager = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: {
      network: network.config,
      ...(options.uploads
        ? {
            uploads: {
              adapter: opfsOfflineUploadAdapter,
              upload: ({ id }) => {
                serverCalls.push(`tab ${name} uploaded ${id}`);
                return Promise.resolve(`server:${id}`);
              },
            },
          }
        : {}),
    },
  });
  const env = createDocumentStoreTestEnv<number, UpdateValueV2Operations>(1, {
    id: 'doc',
    getSessionKey: () => sessionKey,
    storeManager,
    sharedServerState: sharedServer,
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        operations: {
          updateValueV2: {
            inputSchema: docMutationInputSchema,
            kind: 'update',
            execute: async ({ input }) => {
              serverCalls.push(`tab ${name} sent doc = ${input.value} (v2)`);
              await env.serverMock.delayedSetData(input.value);
              return input;
            },
          },
          updateWithAttachmentV2: {
            inputSchema: updateWithAttachmentInputSchema,
            kind: 'update',
            dependsOnUploads: ({ input }) => [input.attachmentId],
            execute: async ({ input, uploads }) => {
              serverCalls.push(
                `tab ${name} sent doc = ${input.value} with ${JSON.stringify(
                  uploads.resolvedRefsById[input.attachmentId],
                )} (v2)`,
              );
              await env.serverMock.delayedSetData(input.value);
              return { value: input.value };
            },
          },
        },
      },
    },
  });

  const tab = {
    name,
    storeManager,
    async queueEdit(value: number) {
      await env.apiStore.performMutation({
        mutation: async () => {
          await env.serverMock.delayedSetData(value);
          return value;
        },
        offline: { operation: 'updateValueV2', input: { value } },
      });
      await advanceTime(10);
    },
    /** Queues an offline edit that uses a file staged in any tab. */
    async queueEditWithStagedFile(value: number, attachmentId: string) {
      await env.apiStore.performMutation({
        mutation: async () => {
          await env.serverMock.delayedSetData(value);
          return value;
        },
        offline: {
          operation: 'updateWithAttachmentV2',
          input: { value, attachmentId },
        },
      });
      await advanceTime(10);
    },
    close() {
      env.apiStore.dispose();
      sessionModule.__resetSessionOfflineCoordinatorRegistryForTests();
      const index = openTabs.indexOf(tab);
      if (index >= 0) openTabs.splice(index, 1);
    },
  };
  openTabs.push(tab);
  await advanceTime(50);
  return tab;
}

/**
 * Opens a simulated tab (see `openTab`) with a users collection whose offline
 * `createUser` operation shows the new user under a temp id (`temp:<name>`)
 * until the server assigns its final id (`users||<name>`).
 */
const renameUserInputSchema: PersistentStorageSchema<{
  id: string;
  name: string;
}> = rc_object({ id: rc_string, name: rc_string });

/** Renames a user. The server rejects every rename with a conflict. */
type RenameUserOperations = {
  renameUser: CollectionOfflineOperationDefinition<
    { value: { name: string } },
    string,
    { id: string; name: string },
    { reason: string }
  >;
};

/**
 * Creates a user under an id the app generates on the client (no temp
 * entity). The server rejects every such creation with a conflict.
 */
type CreateUserWithIdOperations = {
  createUserWithId: CollectionOfflineOperationDefinition<
    { value: { name: string } },
    string,
    { id: string; name: string },
    { reason: string }
  >;
};

/** Deletes a user. A user created offline is created and then deleted. */
type DeleteUserOperations = {
  deleteUser: CollectionOfflineOperationDefinition<
    { value: { name: string } },
    string,
    { id: string }
  >;
};

async function openUsersTab(
  name: string,
  options: {
    focused: boolean;
    /** Users already loaded in the tab (from `sharedUsersServer`). */
    loadedUsers?: string[];
  },
) {
  setDocumentHidden(!options.focused);
  vi.resetModules();
  const [
    { createStoreManager },
    { createCollectionStoreTestEnv },
    sessionModule,
  ] = await Promise.all([
    import('../../src/storeManager'),
    import('../mocks/collectionStoreTestEnv'),
    import('../../src/persistentStorage/offline/sessionCoordinator'),
  ]);

  const storeManager = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: { network: network.config },
  });
  const env = createCollectionStoreTestEnv<
    { name: string },
    CreateUserOperations &
      RenameUserOperations &
      CreateUserWithIdOperations &
      DeleteUserOperations
  >(
    Object.fromEntries(
      (options.loadedUsers ?? []).map((payload) => [
        payload,
        sharedUsersServer.items.get(payload) ?? { name: 'missing' },
      ]),
    ),
    {
      id: 'users',
      getSessionKey: () => sessionKey,
      storeManager,
      sharedServerTableState: sharedUsersServer,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: collectionSchema,
        payloadSchema: rc_string,
        offline: {
          operations: {
            createUser: {
              inputSchema: collectionCreateInputSchema,
              kind: 'create',
              getEntityRefs: ({ input }) => [`temp:${input.name}`],
              tempEntity: {
                buildPendingEntity: (input) => ({
                  value: { name: input.name },
                }),
                reconcileServerEntity: (result) => ({
                  finalPayload: result.id,
                  finalData: { value: { name: result.name } },
                }),
              },
              execute: async ({ input }) => {
                serverCalls.push(`tab ${name} sent create ${input.name}`);
                const result = { id: `users||${input.name}`, name: input.name };
                await env.serverTable.delayedSetItem(result.id, {
                  name: result.name,
                });
                return result;
              },
            },
            renameUser: {
              inputSchema: renameUserInputSchema,
              kind: 'update',
              getEntityRefs: ({ input }) => [input.id],
              conflictHandling: {
                schema: docConflictSchema,
                detectConflict: () => ({ reason: 'server-changed' }),
              },
              execute: async ({ input }) => {
                serverCalls.push(`tab ${name} sent rename ${input.name}`);
                await env.serverTable.delayedUpdateItem(input.id, {
                  name: input.name,
                });
                return { value: { name: input.name } };
              },
              onSuccessExecute: ({ input }) => {
                env.apiStore.updateItemState(input.id, (draft) => {
                  draft.value.name = input.name;
                });
              },
            },
            createUserWithId: {
              inputSchema: renameUserInputSchema,
              kind: 'create',
              getEntityRefs: ({ input }) => [input.id],
              conflictHandling: {
                schema: docConflictSchema,
                detectConflict: () => ({ reason: 'server-changed' }),
              },
              execute: async ({ input }) => {
                serverCalls.push(`tab ${name} sent create ${input.name}`);
                await env.serverTable.delayedSetItem(input.id, {
                  name: input.name,
                });
                return { value: { name: input.name } };
              },
              onSuccessExecute: ({ input }) => {
                env.apiStore.addItemToState(input.id, {
                  value: { name: input.name },
                });
              },
            },
            deleteUser: {
              inputSchema: rc_object({ id: rc_string }),
              kind: 'delete',
              getEntityRefs: ({ input }) => [input.id],
              execute: async ({ input }) => {
                serverCalls.push(`tab ${name} sent delete ${input.id}`);
                await env.serverTable.delayedRemoveItem(input.id);
              },
              onSuccessExecute: ({ input }) => {
                env.apiStore.deleteItemState(input.id);
              },
            },
          },
        },
      },
    },
  );

  const reconciledUsers: string[] = [];
  env.apiStore.storeEvents.on('tempEntityReconciled', ({ payload }) => {
    reconciledUsers.push(`${payload.tempId} -> ${payload.finalPayload}`);
  });

  const tab = {
    name,
    storeManager,
    /** `tempEntityReconciled` events this tab's store emitted, in order. */
    reconciledUsers,
    getUserName(payload: string) {
      return env.apiStore.getItemState(payload)?.data?.value.name ?? null;
    },
    /** What code holding a user's temp id resolves it to in this tab. */
    resolveTempItemPayload(payload: string) {
      return env.apiStore.resolveTempItemPayload(payload);
    },
    /**
     * The name a screen of this tab renders for the user, with the changes
     * still waiting to be sent applied (`null` for a deleted user). The
     * screen does not fetch on its own.
     */
    async renderUserName(payload: string) {
      const screen = renderHook(() =>
        env.apiStore.useItem(payload, {
          disableRefetches: true,
          disableRefetchOnMount: true,
        }),
      );
      await advanceTime(10);
      const userName = screen.result.current.data?.value.name ?? null;
      screen.unmount();
      return userName;
    },
    /**
     * Whether the user is marked for a refetch: set when the store is
     * revalidated with no screen showing the user, so the next screen that
     * shows it fetches it again.
     */
    isMarkedForRefetch(payload: string) {
      return !!env.apiStore.getItemState(payload)?.refetchOnMount;
    },
    /** Renames a user offline, showing the new name right away. */
    async queueRename(payload: string, userName: string) {
      await env.apiStore.performMutation(payload, {
        optimisticUpdate: () => {
          env.apiStore.updateItemState(payload, (draft) => {
            draft.value.name = userName;
          });
        },
        mutation: async () => {
          await env.serverTable.delayedUpdateItem(payload, { name: userName });
          return { value: { name: userName } };
        },
        offline: {
          operation: 'renameUser',
          input: { id: payload, name: userName },
        },
      });
      await advanceTime(10);
    },
    /** Creates a user the way a "new user" form in this tab would. */
    async queueCreate(userName: string) {
      await env.apiStore.performMutation(null, {
        mutation: async () => {
          const result = { id: `users||${userName}`, name: userName };
          await env.serverTable.delayedSetItem(result.id, { name: userName });
          return result;
        },
        offline: { operation: 'createUser', input: { name: userName } },
      });
      await advanceTime(10);
    },
    /** Deletes a user offline, removing it from the screen right away. */
    async queueDelete(payload: string) {
      await env.apiStore.performMutation(payload, {
        optimisticUpdate: () => {
          env.apiStore.deleteItemState(payload);
        },
        mutation: async () => {
          await env.serverTable.delayedRemoveItem(payload);
        },
        offline: { operation: 'deleteUser', input: { id: payload } },
      });
      await advanceTime(10);
    },
    /**
     * Creates a user offline under an id generated in this tab, showing it
     * right away.
     */
    async queueCreateWithId(payload: string, userName: string) {
      await env.apiStore.performMutation(payload, {
        optimisticUpdate: () => {
          env.apiStore.addItemToState(payload, { value: { name: userName } });
        },
        mutation: async () => {
          await env.serverTable.delayedSetItem(payload, { name: userName });
          return { value: { name: userName } };
        },
        offline: {
          operation: 'createUserWithId',
          input: { id: payload, name: userName },
        },
      });
      await advanceTime(10);
    },
    close() {
      env.apiStore.dispose();
      sessionModule.__resetSessionOfflineCoordinatorRegistryForTests();
      const index = openTabs.indexOf(tab);
      if (index >= 0) openTabs.splice(index, 1);
    },
  };
  openTabs.push(tab);
  await advanceTime(50);
  return tab;
}

const usersListQuery = { tableId: 'users' } as const;

/** Deletes a user. A user created offline is created and then deleted. */
type DeleteListQueryUserOperations = {
  deleteUser: ListQueryOfflineOperationDefinition<
    { id: number; name: string },
    ListQueryParams,
    string,
    { id: string }
  >;
};

/**
 * Opens a simulated tab (see `openTab`) with a users list-query store whose
 * offline `createUser` operation lists the new user under a temp id
 * (`temp:<name>`) until the server assigns its final id (`users||<id>`). With
 * `listOpen` the tab shows the users list; otherwise it is on another screen.
 */
async function openUsersListTab(
  name: string,
  options: { focused: boolean; listOpen: boolean },
) {
  setDocumentHidden(!options.focused);
  vi.resetModules();
  const [
    { createStoreManager },
    { createListQueryStoreTestEnv },
    sessionModule,
  ] = await Promise.all([
    import('../../src/storeManager'),
    import('../mocks/listQueryStoreTestEnv'),
    import('../../src/persistentStorage/offline/sessionCoordinator'),
  ]);

  const storeManager = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: { network: network.config },
  });
  const env = createListQueryStoreTestEnv<
    { id: number; name: string },
    false,
    false,
    CreateListQueryUserOperations & DeleteListQueryUserOperations
  >(
    {},
    {
      id: 'users-list',
      getSessionKey: () => sessionKey,
      storeManager,
      sharedServerTableState: sharedUserRowsServer,
      testScenario: options.listOpen
        ? { loaded: { queries: [usersListQuery] } }
        : 'idle',
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: {
          operations: {
            createUser: {
              inputSchema: collectionCreateInputSchema,
              kind: 'create',
              getEntityRefs: ({ input }) => [`temp:${input.name}`],
              tempEntity: {
                buildPendingEntity: (input) => ({ id: -1, name: input.name }),
                reconcileServerEntity: (result) => ({
                  finalPayload: `users||${result.id}`,
                  finalData: result,
                }),
              },
              execute: async ({ input }) => {
                serverCalls.push(`tab ${name} sent create ${input.name}`);
                const result = { id: 2, name: input.name };
                await env.serverTable.delayedSetItem('users||2', result);
                return result;
              },
            },
            deleteUser: {
              inputSchema: rc_object({ id: rc_string }),
              kind: 'delete',
              getEntityRefs: ({ input }) => [input.id],
              execute: async ({ input }) => {
                serverCalls.push(`tab ${name} sent delete ${input.id}`);
                await env.serverTable.delayedRemoveItem(input.id);
              },
              onSuccessExecute: ({ input }) => {
                env.apiStore.deleteItemState(input.id);
              },
            },
          },
        },
      },
    },
  );

  const reconciledUsers: string[] = [];
  const seenByReconciledListeners: {
    listRows: string[];
    resolvedTempId: string;
  }[] = [];
  env.apiStore.storeEvents.on('tempEntityReconciled', ({ payload }) => {
    reconciledUsers.push(`${payload.tempId} -> ${payload.finalPayload}`);
    seenByReconciledListeners.push({
      listRows: tab.getListRows(),
      resolvedTempId: tab.resolveTempItemPayload(payload.tempId),
    });
  });

  const tab = {
    name,
    storeManager,
    /** `tempEntityReconciled` events this tab's store emitted, in order. */
    reconciledUsers,
    /**
     * What a `tempEntityReconciled` listener of this tab read from the store
     * when it was called: the rows of the users list and what the temp id of
     * the event resolved to.
     */
    seenByReconciledListeners,
    /** The user stored under `payload` in this tab, if any. */
    getUser(payload: string) {
      return env.apiStore.getItemState(payload);
    },
    /** What code holding a user's temp id resolves it to in this tab. */
    resolveTempItemPayload(payload: string) {
      return env.apiStore.resolveTempItemPayload(payload);
    },
    /**
     * The name a screen of this tab renders for the user, with the changes
     * still waiting to be sent applied (`null` for a deleted user). The
     * screen does not fetch on its own.
     */
    async renderUserName(payload: string) {
      const screen = renderHook(() =>
        env.apiStore.useItem(payload, {
          disableRefetches: true,
          disableRefetchOnMount: true,
        }),
      );
      await advanceTime(10);
      const userName = screen.result.current.data?.name ?? null;
      screen.unmount();
      return userName;
    },
    /** The rows the users list shows, like `Ada (temp id)`. */
    getListRows() {
      const query = env.apiStore.getQueryState(usersListQuery);
      return (query?.items ?? []).map((itemKey) => {
        const user = env.store.state.items[itemKey];
        if (!user) return '<missing row>';
        return user.id < 0
          ? `${user.name} (temp id)`
          : `${user.name} (id ${user.id})`;
      });
    },
    /** Creates a user from the list's "new user" form in this tab. */
    async queueCreate(userName: string) {
      await env.apiStore.performMutation(`temp:${userName}`, {
        optimisticUpdate: () => {
          env.apiStore.addItemToState(
            `temp:${userName}`,
            { id: -1, name: userName },
            {
              addItemToQueries: { queries: [usersListQuery], appendTo: 'end' },
            },
          );
        },
        mutation: async () => {
          const result = { id: 2, name: userName };
          await env.serverTable.delayedSetItem('users||2', result);
          return result;
        },
        offline: { operation: 'createUser', input: { name: userName } },
      });
      await advanceTime(10);
    },
    /** Deletes a user offline, removing it from the list right away. */
    async queueDelete(payload: string) {
      await env.apiStore.performMutation(payload, {
        optimisticUpdate: () => {
          env.apiStore.deleteItemState(payload);
        },
        mutation: async () => {
          await env.serverTable.delayedRemoveItem(payload);
        },
        offline: { operation: 'deleteUser', input: { id: payload } },
      });
      await advanceTime(10);
    },
    close() {
      env.apiStore.dispose();
      sessionModule.__resetSessionOfflineCoordinatorRegistryForTests();
      const index = openTabs.indexOf(tab);
      if (index >= 0) openTabs.splice(index, 1);
    },
  };
  openTabs.push(tab);
  await advanceTime(50);
  return tab;
}

/**
 * What each tab shows: whether it leads offline replay, and the session-wide
 * resolution and entity lists an app-wide offline panel renders.
 */
function describeTabs(...tabs: Array<Pick<Tab, 'name' | 'storeManager'>>) {
  return Object.fromEntries(
    tabs.map((tab) => [
      `tab ${tab.name}`,
      {
        leader: tab.storeManager.getOfflineStatus().isLeader,
        resolutions: tab.storeManager
          .getOfflineResolutions()
          .map((resolution) => `${resolution.storeName}: ${resolution.kind}`),
        entities: tab.storeManager
          .getOfflineEntities()
          .map((entity) => `${entity.storeName}: ${entity.syncState}`),
      },
    ]),
  );
}

test('a conflict created by another tab can be discarded after switching to this tab', async () => {
  network.setOffline();
  const tabA = await openTab('A', { focused: true });
  const tabB = await openTab('B', { focused: false });
  await blurWindow();

  // The user edits in tab A while offline. On reconnect tab A (the leader)
  // replays the edit and the server rejects it with a conflict.
  await tabA.queueEdit(-1);
  network.goOnline();
  await advanceTime(3_000);

  // Both tabs list the conflict, including the leader that created it: the
  // background tab's broadcasts must not wipe the leader's own list.
  expect(describeTabs(tabA, tabB)).toMatchInlineSnapshot(`
    tab A:
      entities: ['doc: resolution-required']
      leader: '✅'
      resolutions: ['doc: conflict']

    tab B:
      entities: ['doc: resolution-required']
      leader: '❌'
      resolutions: ['doc: conflict']
  `);

  // The user closes tab A and handles the conflict from tab B's offline panel.
  await closeTabAndFocusRemaining(tabA);
  expect(describeTabs(tabB)).toMatchInlineSnapshot(`
    tab B:
      entities: ['doc: resolution-required']
      leader: '✅'
      resolutions: ['doc: conflict']
  `);

  const [conflict] = tabB.storeManager.getOfflineResolutions();
  const result = await tabB.storeManager.resolveOfflineResolution(
    conflict?.id ?? 'missing',
    'discard',
  );
  await advanceTime(10);

  expect(result.ok).toBe(true);
  expect(describeTabs(tabB)).toMatchInlineSnapshot(`
    tab B:
      entities: []
      leader: '✅'
      resolutions: []
  `);
  // The conflict was detected before execute and the edit was discarded, so
  // nothing reached the server.
  expect(serverCalls).toMatchInlineSnapshot(`[]`);
});

test('an edit queued in a tab that was closed is sent by the remaining tab', async () => {
  network.setOffline();
  const tabA = await openTab('A', { focused: true });
  const tabB = await openTab('B', { focused: false });
  await blurWindow();

  // The user edits in tab A while offline, closes it, and keeps using tab B.
  await tabA.queueEdit(2);
  await closeTabAndFocusRemaining(tabA);

  // Tab B now leads, so it must send tab A's edit once the network is back.
  network.goOnline();
  await advanceTime(3_000);

  expect(serverCalls).toMatchInlineSnapshot(`['tab B sent doc = 2']`);
  expect(describeTabs(tabB)).toMatchInlineSnapshot(`
    tab B:
      entities: []
      leader: '✅'
      resolutions: []
  `);
});

test('an edit another tab already sent is not sent again after the leader tab closes', async () => {
  network.setOffline();
  const tabA = await openTab('A', { focused: true });
  await tabA.queueEdit(2);

  // Tab B opens while the edit is still queued, so it loads it from storage.
  const tabB = await openTab('B', { focused: false });
  await blurWindow();

  // Tab A leads and sends the edit on reconnect.
  network.goOnline();
  await advanceTime(3_000);
  expect(serverCalls).toMatchInlineSnapshot(`['tab A sent doc = 2']`);

  // The user closes tab A; tab B takes over. A later network drop and
  // recovery makes the new leader replay whatever it still has queued.
  await closeTabAndFocusRemaining(tabA);
  network.goOffline();
  await advanceTime(100);
  network.goOnline();
  await advanceTime(3_000);

  // The edit reached the server exactly once.
  expect(serverCalls).toMatchInlineSnapshot(`['tab A sent doc = 2']`);
  expect(describeTabs(tabB)).toMatchInlineSnapshot(`
    tab B:
      entities: []
      leader: '✅'
      resolutions: []
  `);
});

test('a tab opened in the background does not also send the queued edits', async () => {
  network.setOffline();
  const tabA = await openTab('A', { focused: true });
  await tabA.queueEdit(2);

  // A second tab opens in the background (e.g. a link opened in a new tab)
  // while tab A keeps the focus. Tab A stays the only leader.
  const tabB = await openTab('B', { focused: false });
  // Tab A still has the focus (`openTab` hid the shared document for tab B).
  setDocumentHidden(false);
  expect(describeTabs(tabA, tabB)).toMatchInlineSnapshot(`
    tab A:
      entities: ['doc: pending']
      leader: '✅'
      resolutions: []

    tab B:
      entities: ['doc: pending']
      leader: '❌'
      resolutions: []
  `);

  network.goOnline();
  await advanceTime(3_000);

  expect(serverCalls).toMatchInlineSnapshot(`['tab A sent doc = 2']`);
});

test('forced offline mode holds the replay in every tab, and releasing it sends an edit queued in a background tab once', async () => {
  // The real network stays up for the whole test.
  const tabA = await openTab('A', { focused: true });
  const tabB = await openTab('B', { focused: false });
  // Tab A keeps the focus, so it leads the session and holds the replay lock.
  setDocumentHidden(false);

  function describeForcedMode(...tabs: Tab[]) {
    return Object.fromEntries(
      tabs.map((tab) => {
        const status = tab.storeManager.getOfflineStatus();
        return [
          `tab ${tab.name}`,
          {
            leader: status.isLeader,
            forced: status.isForcedOffline,
            offline: status.isOfflineMode,
            entities: tab.storeManager
              .getOfflineEntities()
              .map((entity) => `${entity.storeName}: ${entity.syncState}`),
          },
        ];
      }),
    );
  }

  // --- The background tab forces offline mode: the leading tab follows it.
  (await tabB.storeManager.setForcedOfflineMode(true)).unwrap();
  await advanceTime(10);

  // --- The user edits in the background tab, which queues the edit.
  await tabB.queueEdit(2);
  expect(describeForcedMode(tabA, tabB)).toMatchInlineSnapshot(`
    tab A:
      entities: ['doc: pending']
      forced: '✅'
      leader: '✅'
      offline: '✅'

    tab B:
      entities: ['doc: pending']
      forced: '✅'
      leader: '❌'
      offline: '✅'
  `);

  // --- Neither a browser `online` event nor time passing ends forced mode:
  // the leading tab, which now holds the edit too, does not send it.
  network.goOnline();
  await advanceTime(60_000);
  expect(serverCalls).toMatchInlineSnapshot(`[]`);

  // --- Releasing from the leading tab recovers both tabs, and the leader
  // sends the edit queued in the other tab exactly once.
  (await tabA.storeManager.setForcedOfflineMode(false)).unwrap();
  await advanceTime(3_000);

  expect(serverCalls).toMatchInlineSnapshot(`['tab A sent doc = 2']`);
  expect(describeForcedMode(tabA, tabB)).toMatchInlineSnapshot(`
    tab A:
      entities: []
      forced: '❌'
      leader: '✅'
      offline: '❌'

    tab B:
      entities: []
      forced: '❌'
      leader: '❌'
      offline: '❌'
  `);
});

test('offline items of a store open only in another tab stay listed in every tab', async () => {
  network.setOffline();
  const tabA = await openTab('A', {
    focused: true,
    storeIds: ['doc', 'only-in-a'],
  });
  const tabB = await openTab('B', { focused: false });
  await blurWindow();

  // The user edits both stores in tab A, then edits the shared store in tab B.
  await tabA.queueEdit(2, 'only-in-a');
  await tabA.queueEdit(3);
  await tabB.queueEdit(4);

  // Tab B's broadcast only covers the store it has open, so neither tab loses
  // the edit pending on the store that is open only in tab A.
  expect(describeTabs(tabA, tabB)).toMatchInlineSnapshot(`
    tab A:
      entities: ['doc: pending', 'only-in-a: pending']
      leader: '✅'
      resolutions: []

    tab B:
      entities: ['doc: pending', 'only-in-a: pending']
      leader: '❌'
      resolutions: []
  `);

  // On reconnect the leader sends every edit, including the one queued in tab
  // B, in the order they were made.
  network.goOnline();
  await advanceTime(5_000);
  expect(serverCalls).toMatchInlineSnapshot(
    `['tab A sent only-in-a = 2', 'tab A sent doc = 3', 'tab A sent doc = 4']`,
  );
  expect(describeTabs(tabA, tabB)).toMatchInlineSnapshot(`
    tab A:
      entities: []
      leader: '✅'
      resolutions: []

    tab B:
      entities: []
      leader: '❌'
      resolutions: []
  `);
});

test('a tab opened later also lists offline items of a store open only in another tab', async () => {
  network.setOffline();
  const tabA = await openTab('A', {
    focused: true,
    storeIds: ['doc', 'only-in-a'],
  });

  // The user edits a store that only tab A has open, then opens a second tab
  // that only has the shared store.
  await tabA.queueEdit(2, 'only-in-a');
  const tabB = await openTab('B', { focused: false });

  // The new tab's offline panel also lists the pending edit of tab A's store.
  expect(describeTabs(tabB)).toMatchInlineSnapshot(`
    tab B:
      entities: ['only-in-a: pending']
      leader: '❌'
      resolutions: []
  `);
});

test('an older tab does not delete edits queued for an operation only a newer deploy knows', async () => {
  network.setOffline();
  const oldTab = await openTab('A', { focused: true });
  const newTab = await openNewVersionTab('B');
  await blurWindow();

  // A tab running the new deploy queues an edit for the renamed operation,
  // while the tab still running the old deploy leads.
  await newTab.queueEdit(5);

  // On reconnect the old leader cannot replay the unknown operation; it must
  // leave the edit in storage instead of dropping it.
  network.goOnline();
  await advanceTime(3_000);
  expect(serverCalls).toMatchInlineSnapshot(`[]`);

  // The user closes the old tab; the new tab leads and sends the edit after
  // the next network recovery.
  await closeTabAndFocusRemaining(oldTab);
  network.goOffline();
  await advanceTime(100);
  network.goOnline();
  await advanceTime(3_000);

  expect(serverCalls).toMatchInlineSnapshot(`['tab B sent doc = 5 (v2)']`);
  expect(describeTabs(newTab)).toMatchInlineSnapshot(`
    tab B:
      entities: []
      leader: '✅'
      resolutions: []
  `);
});

test('an older tab keeps a file that an edit only a newer deploy can send still needs', async () => {
  const opfs = createMockBrowserOpfs();
  network.setOffline();
  const oldTab = await openTab('A', { focused: true, uploads: true });
  const newTab = await openNewVersionTab('B', { uploads: true });
  await blurWindow();

  // Offline, the user picks a photo in the tab still running the old deploy
  // and saves an edit with it. Later, in the tab running the new deploy, they
  // save another edit with the same photo, through an operation the old
  // deploy doesn't define. Both tabs were already open, so the old tab learns
  // about the new edit from the new tab's message, not from storage.
  await oldTab.stageFile('photo');
  await oldTab.queueEditWithStagedFile(3, 'photo');
  await newTab.queueEditWithStagedFile(5, 'photo');

  // On reconnect the old tab leads: it sends its own edit and keeps the new
  // deploy's edit, which it can't send. That edit still needs the photo, so
  // the old tab must not delete it once its own edit no longer uses it.
  network.goOnline();
  await advanceTime(3_000);
  expect(serverCalls).toMatchInlineSnapshot(
    `['tab A uploaded photo', 'tab A sent doc = 3 with "server:photo"']`,
  );
  expect(getOpfsDirTree(opfs)).toContain('binary.blob');

  // The user closes the old tab; the new tab leads and sends its edit with
  // the photo after the next network recovery.
  await closeTabAndFocusRemaining(oldTab);
  network.goOffline();
  await advanceTime(100);
  network.goOnline();
  await advanceTime(3_000);

  expect(serverCalls).toMatchInlineSnapshot(`
    - 'tab A uploaded photo'
    - 'tab A sent doc = 3 with "server:photo"'
    - 'tab B sent doc = 5 with "server:photo" (v2)'
  `);
});

test('disposing a store does not bring back offline items another tab reported earlier', async () => {
  network.setOffline();
  const tabA = await openTab('A', { focused: true });
  const tabB = await openTab('B', { focused: false });
  await blurWindow();

  // The user edits in tab A while offline, closes it, and tab B sends the edit
  // once the network is back.
  await tabA.queueEdit(2);
  await closeTabAndFocusRemaining(tabA);
  network.goOnline();
  await advanceTime(3_000);
  expect(serverCalls).toMatchInlineSnapshot(`['tab B sent doc = 2']`);

  // Tab B then disposes the store (e.g. the user navigates away from the
  // screen that owns it). Tab A's old report of the pending edit must not
  // reappear in the session-wide lists.
  tabB.getEnv().apiStore.dispose();
  await advanceTime(10);

  expect(describeTabs(tabB)).toMatchInlineSnapshot(`
    tab B:
      entities: []
      leader: '✅'
      resolutions: []
  `);
});

test('the file attached to an edit queued in another tab is kept when the edit ends in a conflict', async () => {
  const opfs = createMockBrowserOpfs();
  network.setOffline();
  const tabA = await openTab('A', { focused: true, uploads: true });
  const tabB = await openTab('B', { focused: false, uploads: true });
  await blurWindow();

  // While offline the user submits an edit with an attached file in tab B,
  // then switches to tab A, which leads.
  await tabB.queueEditWithFile(-1);
  setDocumentHidden(false);
  expect(getOpfsDirTree(opfs)).toContain('binary.blob');

  // On reconnect tab A replays tab B's edit and the server rejects it with a
  // conflict, which keeps the edit and its file for the user to retry.
  network.goOnline();
  await advanceTime(3_000);
  expect(describeTabs(tabA, tabB)).toMatchInlineSnapshot(`
    tab A:
      entities: ['doc: resolution-required']
      leader: '✅'
      resolutions: ['doc: conflict']

    tab B:
      entities: ['doc: resolution-required']
      leader: '❌'
      resolutions: ['doc: conflict']
  `);

  // Tab B, which saved the file, must not delete it while it applies tab A's
  // changes one at a time: retrying the conflict needs the file.
  expect(getOpfsDirTree(opfs)).toContain('binary.blob');
});

test('a file another tab uploaded and deleted is neither uploaded again nor written back to storage', async () => {
  const opfs = createMockBrowserOpfs();
  network.setOffline();
  const tabA = await openTab('A', { focused: true, uploads: true });
  const tabB = await openTab('B', { focused: false, uploads: true });
  await blurWindow();

  // While offline the user picks a photo in tab B and saves an edit that uses
  // it, then switches to tab A, which leads.
  await tabB.stageFile('photo');
  await tabB.queueEditWithStagedFile(2, 'photo');
  setDocumentHidden(false);

  // On reconnect tab A uploads the photo, sends the edit, and deletes the
  // photo from storage: no queued work uses it anymore.
  network.goOnline();
  await advanceTime(3_000);
  expect(serverCalls).toMatchInlineSnapshot(
    `['tab A uploaded photo', 'tab A sent doc = 2 with "server:photo"']`,
  );
  expect(getOpfsDirTree(opfs)).not.toContain('binary.blob');

  // The user closes tab A and edits again in tab B, whose form still holds
  // the photo's upload id (the server ref has not reached it yet).
  await closeTabAndFocusRemaining(tabA);
  network.goOffline();
  await advanceTime(100);
  await tabB.queueEditWithStagedFile(3, 'photo');
  network.goOnline();
  // Past the online stabilization after which unused uploads are stamped for
  // retention
  await advanceTime(10_000);

  // Tab B learned the photo's server ref from tab A: the second edit reuses it
  // instead of uploading the photo again.
  expect(serverCalls).toMatchInlineSnapshot(`
    - 'tab A uploaded photo'
    - 'tab A sent doc = 2 with "server:photo"'
    - 'tab B sent doc = 3 with "server:photo"'
  `);
  // Tab B no longer lists the photo, nor writes its stale copy back to storage.
  expect(
    tabB.storeManager.getOfflineUploads().map((upload) => upload.id),
  ).toMatchInlineSnapshot(`[]`);
  expect(getOpfsDirTree(opfs)).not.toContain('binary.blob');
});

test('a staged file rendered in one tab is replaced there by its server ref once another tab sends its edit and deletes it', async () => {
  createMockBrowserOpfs();
  network.setOffline();
  await openTab('A', { focused: true, uploads: true });
  const tabB = await openTab('B', { focused: false, uploads: true });
  await blurWindow();

  // Offline, the user picks a photo in tab B, which renders its preview, and
  // saves an edit that uses it.
  await tabB.stageFile('photo');
  const preview = renderHook(() =>
    tabB.storeManager.useOfflineUploadFile('photo'),
  );
  await advanceTime(100);
  await tabB.queueEditWithStagedFile(2, 'photo');
  const previewUrl = preview.result.current.url;
  expect(preview.result.current.status).toBe('success');

  // The user switches to tab A, which uploads the photo on reconnect, sends
  // the edit and deletes the photo: no queued work uses it anymore.
  const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL');
  setDocumentHidden(false);
  network.goOnline();
  await advanceTime(3_000);
  expect(serverCalls).toMatchInlineSnapshot(
    `['tab A uploaded photo', 'tab A sent doc = 2 with "server:photo"']`,
  );

  // Tab B's preview no longer exposes the deleted file, and its object URL is
  // revoked instead of leaking. It reports the server ref tab A uploaded the
  // photo to, so tab B renders the uploaded photo instead of uploading it.
  const { status, url, resolvedRef } = preview.result.current;
  expect({ status, url, resolvedRef }).toMatchInlineSnapshot(`
    resolvedRef: 'server:photo'
    status: 'missing'
    url: null
  `);
  expect(revokeObjectURL).toHaveBeenCalledWith(previewUrl);

  preview.unmount();
});

test('deleting a sent file in one tab makes its id unknown in every open tab', async () => {
  createMockBrowserOpfs();
  network.setOffline();
  const tabA = await openTab('A', { focused: true, uploads: true });
  const tabB = await openTab('B', { focused: false, uploads: true });
  await blurWindow();

  // Offline, the user picks a photo in tab B and saves an edit with it, then
  // switches to tab A, which sends both on reconnect and deletes the photo.
  await tabB.stageFile('photo');
  await tabB.queueEditWithStagedFile(2, 'photo');
  setDocumentHidden(false);
  network.goOnline();
  await advanceTime(3_000);

  // Both tabs still resolve the photo's id to the server ref, for app data
  // that holds it.
  const resolveInBothTabs = async () => {
    const results = Promise.all(
      [tabA, tabB].map((tab) => tab.storeManager.resolveOfflineUpload('photo')),
    );
    // Reading the upload records takes a few timer ticks
    await advanceTime(100);
    return (await results).map((result) =>
      result.ok ? result.value : result.error.message,
    );
  };
  expect(await resolveInBothTabs()).toMatchInlineSnapshot(
    `['server:photo', 'server:photo']`,
  );

  // The app forgets the photo from tab A, e.g. after the form was cleared.
  const deleted = tabA.storeManager.deleteOfflineUpload('photo');
  await advanceTime(100);
  expect((await deleted).ok).toBe(true);

  // Tab B forgets it too instead of still resolving the deleted id.
  expect(await resolveInBothTabs()).toMatchInlineSnapshot(
    `['Unknown offline upload "photo"', 'Unknown offline upload "photo"']`,
  );
});

test('discarding a conflict in one tab deletes the file another tab staged for it', async () => {
  const opfs = createMockBrowserOpfs();
  network.setOffline();
  const tabA = await openTab('A', { focused: true, uploads: true });
  const tabB = await openTab('B', { focused: false, uploads: true });
  await blurWindow();

  // Both tabs are open when the user, offline, picks a photo in tab B and
  // saves an edit with it that the server will reject. Tab A never read the
  // photo: it was staged after tab A listed the stored uploads.
  await tabB.stageFile('photo');
  await tabB.queueEditWithStagedFile(-1, 'photo');
  setDocumentHidden(false);

  // On reconnect tab A replays the edit and the server rejects it with a
  // conflict, which keeps the photo for the user to retry.
  network.goOnline();
  await advanceTime(3_000);
  expect(describeTabs(tabA)).toMatchInlineSnapshot(`
    tab A:
      entities: ['doc: resolution-required']
      leader: '✅'
      resolutions: ['doc: conflict']
  `);
  expect(getOpfsDirTree(opfs)).toContain('binary.blob');

  // The user discards the conflict from tab A's offline panel.
  const [conflict] = tabA.storeManager.getOfflineResolutions();
  const discarded = tabA.storeManager.resolveOfflineResolution(
    conflict?.id ?? 'missing',
    'discard',
  );
  // Reading and deleting the photo in OPFS takes a few timer ticks
  await advanceTime(100);
  expect((await discarded).ok).toBe(true);

  // Nothing uses the photo anymore, so it is deleted from storage and neither
  // tab lists it.
  expect(getOpfsDirTree(opfs)).not.toContain('binary.blob');
  expect(
    [tabA, tabB].map((tab) =>
      tab.storeManager.getOfflineUploads().map((upload) => upload.id),
    ),
  ).toMatchInlineSnapshot(`
    - []
    - []
  `);
  // The conflict was detected before execute, so nothing was uploaded or sent.
  expect(serverCalls).toMatchInlineSnapshot(`[]`);
});

test('the leading tab keeps its queued edits while its own connectivity check still fails', async () => {
  // The app's connectivity check also requires the tab's realtime connection,
  // which each tab opens on its own.
  const tabARealtimeConnected = false;
  network.setOffline();
  const tabA = await openTab('A', {
    focused: true,
    network: {
      getIsOffline: () => !network.isOnline() || !tabARealtimeConnected,
    },
  });
  const tabB = await openTab('B', { focused: false });
  // Tab A keeps the focus and leads
  setDocumentHidden(false);
  await tabA.queueEdit(2);

  // The browser is back online. Tab B's check passes and it tells the other
  // tabs, but tab A's realtime connection is still down.
  network.goOnline();
  await advanceTime(3_000);

  // Tab A trusts its own check over tab B's report: sending now would fail,
  // so the edit stays queued.
  expect(serverCalls).toMatchInlineSnapshot(`[]`);
  expect(describeTabs(tabA, tabB)).toMatchInlineSnapshot(`
    tab A:
      entities: ['doc: pending']
      leader: '✅'
      resolutions: []

    tab B:
      entities: ['doc: pending']
      leader: '❌'
      resolutions: []
  `);
});

test('a tab whose own connectivity check fails stays offline until that check passes, even with a recovery check', async () => {
  // The app's connectivity check also requires the tab's realtime connection,
  // which each tab opens on its own. The recovery check only pings the server.
  let tabARealtimeConnected = false;
  network.setOffline();
  const tabA = await openTab('A', {
    focused: true,
    network: {
      getIsOffline: () => !network.isOnline() || !tabARealtimeConnected,
      recoveryCheck: () => network.isOnline(),
    },
  });
  await openTab('B', { focused: false });
  // Tab A keeps the focus and leads
  setDocumentHidden(false);
  await tabA.queueEdit(2);

  const tabAStatus = createLoggerStore();
  function logTabA(label: string) {
    tabAStatus.add({
      label,
      offline: tabA.storeManager.getOfflineStatus().isOfflineMode,
      serverCalls: serverCalls.join(', '),
    });
  }

  // The browser is back online and tab B reports it to the other tabs, but
  // tab A's realtime connection stays down for a minute. Recovery probes run
  // every few seconds, so this covers several of them.
  network.goOnline();
  await advanceTime(10_000);
  logTabA('10s after reconnecting');
  await advanceTime(20_000);
  logTabA('30s after reconnecting');
  await advanceTime(30_000);
  logTabA('60s after reconnecting');

  // The realtime connection is back and tab A's check runs again on the
  // user's next edit: tab A is back online and sends the queued edit, then
  // the new one, queued behind it because it changes the same document.
  tabARealtimeConnected = true;
  tabAStatus.addMark('realtime connection back');
  void tabA.queueEdit(3);
  await advanceTime(5_000);
  logTabA('after the next edit');

  // Tab A goes by its own check like a single tab would: the server ping
  // does not bring it online while the check still fails, so it never sends
  // the queued edit only to drop back offline on tab B's next report.
  expect(tabAStatus.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> label: 10s after reconnecting ⋅ offline: ✅ ⋅ serverCalls: ''
    -> label: 30s after reconnecting ⋅ offline: ✅ ⋅ serverCalls: ''
    -> label: 60s after reconnecting ⋅ offline: ✅ ⋅ serverCalls: ''

    >>> realtime connection back

    ┌─
    ⋅ label: after the next edit
    ⋅ offline: ❌
    ⋅ serverCalls: tab A sent doc = 2, tab A sent doc = 3
    └─
    "
  `);
});

test('a "no connection" detected in one tab is not shown in the other tabs nor after a reload', async () => {
  // The app's connectivity check also requires the tab's realtime connection,
  // which each tab opens on its own: tab A's is down, tab B's is up.
  const tabB = await openTab('B', { focused: false });
  const tabA = await openTab('A', {
    focused: true,
    network: { getIsOffline: () => true },
  });
  // Tab A queues an edit offline, so its offline status reaches the other
  // tabs and the persisted session
  await tabA.queueEdit(2);
  await advanceTime(1_000);

  function describeConnection(...tabs: Tab[]) {
    return tabs.map(
      (tab) =>
        `tab ${tab.name}: ${tab.storeManager.getOfflineStatus().isNetworkDetectedOffline ? 'no connection' : 'connected'}`,
    );
  }

  // Each tab reports what its own check sees: tab B keeps showing it is
  // connected even after receiving tab A's offline status
  expect(describeConnection(tabA, tabB)).toMatchInlineSnapshot(
    `['tab A: no connection', 'tab B: connected']`,
  );

  // A tab opened later (e.g. a reload) restores the persisted session, but
  // not tab A's detection: its own check sees the connection
  const tabC = await openTab('C', { focused: false });
  expect(describeConnection(tabC)).toMatchInlineSnapshot(
    `['tab C: connected']`,
  );
});

test('the tab that created an item offline learns its final id when another tab sends it', async () => {
  network.setOffline();
  const tabA = await openUsersTab('A', { focused: true });
  const tabB = await openUsersTab('B', { focused: false });
  await blurWindow();

  // While offline the user creates "Ada" in tab B, which shows her under a
  // temp id until the server assigns the real one.
  await tabB.queueCreate('Ada');
  expect(tabB.getUserName('temp:Ada')).toBe('Ada');

  // The user switches to tab A, which leads and sends tab B's creation on
  // reconnect.
  setDocumentHidden(false);
  network.goOnline();
  await advanceTime(3_000);
  expect(serverCalls).toMatchInlineSnapshot(`['tab A sent create Ada']`);

  // Tab B is told which id replaced its temp one, like the tab that sent it,
  // so a detail view open on the temp user in tab B can switch to the real one.
  expect({ tabA: tabA.reconciledUsers, tabB: tabB.reconciledUsers })
    .toMatchInlineSnapshot(`
    tabA: ['temp:Ada -> users||Ada']
    tabB: ['temp:Ada -> users||Ada']
  `);
  // The user itself reaches tab B under the final id.
  expect({
    temp: tabB.getUserName('temp:Ada'),
    final: tabB.getUserName('users||Ada'),
  }).toMatchInlineSnapshot(`
    final: 'Ada'
    temp: null
  `);
  expect(describeTabs(tabA, tabB)).toMatchInlineSnapshot(`
    tab A:
      entities: []
      leader: '✅'
      resolutions: []

    tab B:
      entities: []
      leader: '❌'
      resolutions: []
  `);
});

test('a user created offline stays in the list of its tab when a tab on another screen sends it', async () => {
  network.setOffline();
  // Tab A leads but is on another screen: it never loaded the users list
  const tabA = await openUsersListTab('A', { focused: true, listOpen: false });
  const tabB = await openUsersListTab('B', { focused: false, listOpen: true });
  await blurWindow();

  // While offline the user adds "Ada" from the users list in tab B
  await tabB.queueCreate('Ada');
  expect(tabB.getListRows()).toMatchInlineSnapshot(
    `['Grace (id 1)', 'Ada (temp id)']`,
  );

  // The user switches to tab A, which sends tab B's creation on reconnect
  setDocumentHidden(false);
  network.goOnline();
  await advanceTime(3_000);
  expect(serverCalls).toMatchInlineSnapshot(`['tab A sent create Ada']`);

  // Ada stays in tab B's list, at the same position, under her final id.
  // Tab A had no list to move her in, so tab B moves its own row.
  expect(tabB.getListRows()).toMatchInlineSnapshot(
    `['Grace (id 1)', 'Ada (id 2)']`,
  );
  expect(describeTabs(tabA, tabB)).toMatchInlineSnapshot(`
    tab A:
      entities: []
      leader: '✅'
      resolutions: []

    tab B:
      entities: []
      leader: '❌'
      resolutions: []
  `);
});

test('a user created and then deleted offline stays deleted in the tab that did it while another tab sends both changes', async () => {
  network.setOffline();
  await openUsersTab('A', { focused: true });
  const tabB = await openUsersTab('B', { focused: false });
  // Tab A keeps the focus and leads
  setDocumentHidden(false);

  // While offline the user creates Ada in tab B and then deletes her there.
  await tabB.queueCreate('Ada');
  await tabB.queueDelete('temp:Ada');
  expect(await tabB.renderUserName('temp:Ada')).toBeNull();

  // On reconnect tab A sends the creation and then the deletion. This is
  // right before the deletion is saved: the server holds Ada.
  network.goOnline();
  await advanceTime(2_200);
  expect(serverCalls).toMatchInlineSnapshot(
    `['tab A sent create Ada', 'tab A sent delete users||Ada']`,
  );
  expect(sharedUsersServer.items.has('users||Ada')).toBe(true);

  // A screen of tab B that resolves the temp id it holds still renders Ada
  // as deleted: the deletion tab B queued follows her to her final id.
  const adaInTabB = tabB.resolveTempItemPayload('temp:Ada');
  expect(adaInTabB).toBe('users||Ada');
  expect(await tabB.renderUserName(adaInTabB)).toBeNull();

  // Once the deletion is saved Ada is gone from the server and stays
  // deleted in tab B
  await advanceTime(3_000);
  expect(sharedUsersServer.items.has('users||Ada')).toBe(false);
  expect(await tabB.renderUserName(adaInTabB)).toBeNull();
});

test('a listed user created and then deleted offline stays deleted in the tab that did it while another tab sends both changes', async () => {
  network.setOffline();
  await openUsersListTab('A', { focused: true, listOpen: true });
  const tabB = await openUsersListTab('B', { focused: false, listOpen: true });
  // Tab A keeps the focus and leads
  setDocumentHidden(false);

  // While offline the user creates Ada in tab B and then deletes her there.
  await tabB.queueCreate('Ada');
  await tabB.queueDelete('temp:Ada');
  expect(await tabB.renderUserName('temp:Ada')).toBeNull();

  // On reconnect tab A sends the creation and then the deletion. This is
  // right before the deletion is saved: the server holds Ada.
  network.goOnline();
  await advanceTime(2_200);
  expect(serverCalls).toMatchInlineSnapshot(
    `['tab A sent create Ada', 'tab A sent delete users||2']`,
  );
  expect(sharedUserRowsServer.items.has('users||2')).toBe(true);

  // A screen of tab B that resolves the temp id it holds still renders Ada
  // as deleted: the deletion tab B queued follows her to her final id.
  const adaInTabB = tabB.resolveTempItemPayload('temp:Ada');
  expect(adaInTabB).toBe('users||2');
  expect(await tabB.renderUserName(adaInTabB)).toBeNull();

  // Once the deletion is saved Ada is gone from the server and stays
  // deleted in tab B
  await advanceTime(3_000);
  expect(sharedUserRowsServer.items.has('users||2')).toBe(false);
  expect(await tabB.renderUserName(adaInTabB)).toBeNull();
});

test('"+1" clicks queued at the same moment in two tabs all reach the server', async () => {
  network.setOffline();
  const tabA = await openTab('A', { focused: true });
  const tabB = await openTab('B', { focused: false });
  await blurWindow();

  // An earlier offline click in tab A, already known to tab B.
  await tabA.queueAddition(1);

  // Both tabs queue a click before either hears about the other's (e.g. an
  // app reacting to the same realtime event in every open tab). Each tab
  // would merge its click into the queued "+1".
  await Promise.all([tabA.queueAddition(2), tabB.queueAddition(3)]);

  network.goOnline();
  await advanceTime(5_000);

  // The server started at 1 and every click (1 + 2 + 3) is applied once.
  expect(tabA.getEnv().serverMock.current).toBe(7);
  expect(describeTabs(tabA, tabB)).toMatchInlineSnapshot(`
    tab A:
      entities: []
      leader: '✅'
      resolutions: []

    tab B:
      entities: []
      leader: '❌'
      resolutions: []
  `);
});

test('an edit whose request fails after another tab queued a newer edit is sent first', async () => {
  const tabA = await openTab('A', { focused: true });
  const tabB = await openTab('B', { focused: false });

  // Tab A is online, so its edit goes straight to the server, which hangs
  let failTabAEdit: (error: Error) => void = () => {};
  const tabAEdit = tabA.getEnv().apiStore.performMutation({
    mutation: () =>
      new Promise<number>((_, reject) => {
        failTabAEdit = reject;
      }),
    offline: { operation: 'updateValue', input: { value: 2 } },
  });
  await advanceTime(100);

  // The connection drops and the user edits the same value in tab B, which
  // queues the newer edit
  network.goOffline();
  await advanceTime(100);
  await tabB.queueEdit(3);

  // Tab A's request then fails with a network error and is queued
  failTabAEdit(new Error('Network request failed'));
  const tabAResult = await tabAEdit;
  expect(
    tabAResult.ok ? tabAResult.value : tabAResult.error,
  ).toMatchInlineSnapshot(`kind: 'queued'`);

  network.goOnline();
  await advanceTime(5_000);

  // The edits reach the server in the order they were made, so the newer
  // edit of tab B is kept
  expect(serverCalls).toMatchInlineSnapshot(
    `['tab A sent doc = 2', 'tab A sent doc = 3']`,
  );
  expect(tabA.getEnv().serverMock.current).toBe(3);
});

test('an edit another tab turned into a conflict keeps showing in the tab that made it', async () => {
  network.setOffline();
  // Tab A keeps the focus and leads
  await openTab('A', { focused: true });
  const tabB = await openTab('B', { focused: false });
  setDocumentHidden(false);

  // The user edits in tab B while offline and sees the new value right away;
  // the server will reject the edit with a conflict (negative values).
  const tabBEnv = tabB.getEnv();
  await tabBEnv.apiStore.performMutation({
    optimisticUpdate: () => {
      tabBEnv.apiStore.updateState((draft) => {
        draft.value = -1;
      });
    },
    mutation: async () => {
      await tabBEnv.serverMock.delayedSetData(-1);
      return -1;
    },
    offline: { operation: 'updateValue', input: { value: -1 } },
  });
  await advanceTime(10);

  const tabBDoc = createLoggerStore();
  function logTabB(label: string) {
    tabBDoc.add({
      label,
      value: tabBEnv.store.state.data?.value,
      // set when the store is revalidated with no screen showing it: the
      // next screen that shows the document refetches it
      refetchOnOpen: tabBEnv.store.state.refetchOnMount !== false,
      resolutions: describeTabs(tabB)['tab B']?.resolutions.join(', '),
    });
  }
  logTabB('edit queued in tab B');

  // On reconnect tab A replays the edit and moves it to a conflict. Tab B
  // still has a change waiting for the user's decision, so it must not
  // refetch the document and replace the edit with the server value.
  network.goOnline();
  await advanceTime(10_000);
  logTabB('after tab A replayed it');

  expect(tabBDoc.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> label: edit queued in tab B ⋅ value: -1 ⋅ refetchOnOpen: ❌ ⋅ resolutions: ''
    ┌─
    ⋅ label: after tab A replayed it
    ⋅ value: -1
    ⋅ refetchOnOpen: ❌
    ⋅ resolutions: doc: conflict
    └─
    "
  `);
});

test('an edit sent again from another tab keeps showing in the tab that made it', async () => {
  network.setOffline();
  // Tab A keeps the focus and leads
  const tabA = await openTab('A', { focused: true });
  const tabB = await openTab('B', { focused: false });
  setDocumentHidden(false);

  // The user edits in tab B while offline; on reconnect tab A replays the
  // edit and the server rejects it with a conflict (negative values).
  const tabBEnv = tabB.getEnv();
  await tabBEnv.apiStore.performMutation({
    optimisticUpdate: () => {
      tabBEnv.apiStore.updateState((draft) => {
        draft.value = -1;
      });
    },
    mutation: async () => {
      await tabBEnv.serverMock.delayedSetData(-1);
      return -1;
    },
    offline: { operation: 'updateValue', input: { value: -1 } },
  });
  await advanceTime(10);
  network.goOnline();
  await advanceTime(10_000);

  const tabBDoc = createLoggerStore();
  function logTabB(label: string) {
    tabBDoc.add({
      label,
      value: tabBEnv.store.state.data?.value,
      // set when the store is revalidated with no screen showing it: the
      // next screen that shows the document refetches it
      refetchOnOpen: tabBEnv.store.state.refetchOnMount !== false,
      resolutions: describeTabs(tabB)['tab B']?.resolutions.join(', '),
    });
  }
  logTabB('conflict waiting for a decision');

  // From tab A's offline panel the user sends the edit again with another
  // value, which the server rejects too. The change moves from the conflict
  // back to the queue and into a new conflict without ever being gone, so
  // tab B must not refetch the document over it.
  const [conflict] = tabA.storeManager.getOfflineResolutions();
  await tabA
    .getEnv()
    .apiStore.resolveOfflineResolution(
      conflict?.id ?? 'missing',
      'updateValue',
      { action: 'requeue', input: { value: -2 } },
    );
  await advanceTime(10_000);
  logTabB('sent again from tab A and rejected again');

  expect(tabBDoc.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ label: conflict waiting for a decision
    ⋅ value: -1
    ⋅ refetchOnOpen: ❌
    ⋅ resolutions: doc: conflict
    └─
    ┌─
    ⋅ label: sent again from tab A and rejected again
    ⋅ value: -1
    ⋅ refetchOnOpen: ❌
    ⋅ resolutions: doc: conflict
    └─
    "
  `);
});

test('discarding a conflict in one tab refetches the user in the tab that made the change', async () => {
  sharedUsersServer = createSharedServerTableState({
    'users||Ada': { name: 'Ada' },
    'users||Bob': { name: 'Bob' },
  });
  network.setOffline();
  const loadedUsers = ['users||Ada', 'users||Bob'];
  const tabA = await openUsersTab('A', { focused: true, loadedUsers });
  const tabB = await openUsersTab('B', { focused: false, loadedUsers });
  // Tab A keeps the focus and leads
  setDocumentHidden(false);

  // The user renames both users in tab B while offline. On reconnect tab A
  // replays both renames and the server rejects each with a conflict.
  await tabB.queueRename('users||Ada', 'Ada local');
  await tabB.queueRename('users||Bob', 'Bob local');
  network.goOnline();
  await advanceTime(10_000);

  const tabBUsers = createLoggerStore();
  function logTabB(label: string) {
    tabBUsers.add({
      label,
      ada: tabB.getUserName('users||Ada'),
      adaMarkedForRefetch: tabB.isMarkedForRefetch('users||Ada'),
      bob: tabB.getUserName('users||Bob'),
      bobMarkedForRefetch: tabB.isMarkedForRefetch('users||Bob'),
    });
  }
  logTabB('both renames rejected');

  // The user discards Ada's rename from tab A's offline panel; Bob's conflict
  // still waits for a decision.
  // (Ada's rename was queued first, so its conflict is listed first.)
  const [adaConflict] = tabA.storeManager.getOfflineResolutions();
  await tabA.storeManager.resolveOfflineResolution(
    adaConflict?.id ?? 'missing',
    'discard',
  );
  await advanceTime(3_000);
  logTabB('Ada rename discarded in tab A');

  // Tab B drops the discarded rename like tab A: Ada is refetched (here no
  // screen shows it, so the next one that does fetches it), while Bob keeps
  // the rename that still waits for a decision.
  expect(tabBUsers.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ label: both renames rejected
    ⋅ ada: Ada local
    ⋅ adaMarkedForRefetch: ❌
    ⋅ bob: Bob local
    ⋅ bobMarkedForRefetch: ❌
    └─
    ┌─
    ⋅ label: Ada rename discarded in tab A
    ⋅ ada: Ada local
    ⋅ adaMarkedForRefetch: ✅
    ⋅ bob: Bob local
    ⋅ bobMarkedForRefetch: ❌
    └─
    "
  `);
});

test('discarding a user created offline with a client-generated id removes it from every tab', async () => {
  network.setOffline();
  const tabA = await openUsersTab('A', { focused: true });
  const tabB = await openUsersTab('B', { focused: false });
  // Tab A keeps the focus and leads
  setDocumentHidden(false);

  // The user creates Linus in tab B while offline, under an id the app
  // generated. On reconnect tab A replays the creation and the server rejects
  // it with a conflict.
  await tabB.queueCreateWithId('users||Linus', 'Linus');
  network.goOnline();
  await advanceTime(10_000);

  const users = createLoggerStore();
  function logTabs(label: string) {
    users.add({
      label,
      tabA: tabA.getUserName('users||Linus'),
      tabAMarkedForRefetch: tabA.isMarkedForRefetch('users||Linus'),
      tabB: tabB.getUserName('users||Linus'),
      tabBMarkedForRefetch: tabB.isMarkedForRefetch('users||Linus'),
    });
  }
  logTabs('creation rejected');

  // The user discards the creation from tab A's offline panel
  const [createConflict] = tabA.storeManager.getOfflineResolutions();
  await tabA.storeManager.resolveOfflineResolution(
    createConflict?.id ?? 'missing',
    'discard',
  );
  await advanceTime(3_000);
  logTabs('creation discarded in tab A');

  // Linus never reached the server: both tabs drop him instead of keeping the
  // unsaved user or marking him for a refetch the server would answer with
  // "not found".
  expect(users.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ label: creation rejected
    ⋅ tabA: Linus
    ⋅ tabAMarkedForRefetch: ❌
    ⋅ tabB: Linus
    ⋅ tabBMarkedForRefetch: ❌
    └─
    ┌─
    ⋅ label: creation discarded in tab A
    ⋅ tabA: null
    ⋅ tabAMarkedForRefetch: ❌
    ⋅ tabB: null
    ⋅ tabBMarkedForRefetch: ❌
    └─
    "
  `);
  expect(serverCalls).toMatchInlineSnapshot(`[]`);
  expect(describeTabs(tabA, tabB)).toMatchInlineSnapshot(`
    tab A:
      entities: []
      leader: '✅'
      resolutions: []

    tab B:
      entities: []
      leader: '❌'
      resolutions: []
  `);
});

describe('a record created offline is saved while several tabs are open', () => {
  test('a user created offline in one tab keeps its row in the other tab once it is saved, and both tabs learn the final id', async () => {
    network.setOffline();
    const tabA = await openUsersListTab('A', { focused: true, listOpen: true });
    const tabB = await openUsersListTab('B', {
      focused: false,
      listOpen: true,
    });
    // Tab A keeps the focus and leads
    setDocumentHidden(false);

    // While offline the user adds Ada from the users list in tab A. Tab B
    // shows the new row too, and the user opens Ada's page there: it only
    // knows her temp id.
    await tabA.queueCreate('Ada');
    expect({
      tabA: tabA.getListRows(),
      tabB: tabB.getListRows(),
      tabBOpenPage: tabB.getUser('temp:Ada'),
    }).toMatchInlineSnapshot(`
      tabA: ['Grace (id 1)', 'Ada (temp id)']
      tabB: ['Grace (id 1)', 'Ada (temp id)']
      tabBOpenPage: { id: -1, name: 'Ada' }
    `);

    // Back online: tab A sends the creation and the server assigns `users||2`
    network.goOnline();
    await advanceTime(3_000);
    expect(serverCalls).toMatchInlineSnapshot(`['tab A sent create Ada']`);

    // Both tabs replaced the temp row with the final one, in the same
    // position of the list
    expect({ tabA: tabA.getListRows(), tabB: tabB.getListRows() })
      .toMatchInlineSnapshot(`
        tabA: ['Grace (id 1)', 'Ada (id 2)']
        tabB: ['Grace (id 1)', 'Ada (id 2)']
      `);
    expect({
      tabA: { temp: tabA.getUser('temp:Ada'), final: tabA.getUser('users||2') },
      tabB: { temp: tabB.getUser('temp:Ada'), final: tabB.getUser('users||2') },
    }).toMatchInlineSnapshot(`
      tabA:
        final: { id: 2, name: 'Ada' }
        temp: null

      tabB:
        final: { id: 2, name: 'Ada' }
        temp: null
    `);

    // Both tabs are told which final id replaced the temp one, so the page
    // open on Ada in tab B can follow her...
    expect({ tabA: tabA.reconciledUsers, tabB: tabB.reconciledUsers })
      .toMatchInlineSnapshot(`
        tabA: ['temp:Ada -> users||2']
        tabB: ['temp:Ada -> users||2']
      `);
    // ...and code that still holds the temp id later can resolve it
    expect({
      tabA: tabA.resolveTempItemPayload('temp:Ada'),
      tabB: tabB.resolveTempItemPayload('temp:Ada'),
      unknown: tabB.resolveTempItemPayload('temp:Unknown'),
    }).toMatchInlineSnapshot(`
      tabA: 'users||2'
      tabB: 'users||2'
      unknown: 'temp:Unknown'
    `);

    // The listeners were called with the store already updated, in the tab
    // that sent the creation too: the list shows the saved row and the temp
    // id already resolves to the final one
    expect({
      tabA: tabA.seenByReconciledListeners,
      tabB: tabB.seenByReconciledListeners,
    }).toMatchInlineSnapshot(`
      tabA:
        - listRows: ['Grace (id 1)', 'Ada (id 2)']
          resolvedTempId: 'users||2'
      tabB:
        - listRows: ['Grace (id 1)', 'Ada (id 2)']
          resolvedTempId: 'users||2'
    `);
  });

  test('a tab that does not show the users list still learns the final id of a user created offline', async () => {
    network.setOffline();
    const tabA = await openUsersListTab('A', { focused: true, listOpen: true });
    // Tab B is on another screen: for example it only holds the temp id in a
    // link to the user's page
    const tabB = await openUsersListTab('B', {
      focused: false,
      listOpen: false,
    });
    setDocumentHidden(false);

    await tabA.queueCreate('Ada');
    network.goOnline();
    await advanceTime(3_000);

    expect({
      reconciled: tabB.reconciledUsers,
      resolved: tabB.resolveTempItemPayload('temp:Ada'),
      // The saved user reaches every tab through the store's tab sync
      final: tabB.getUser('users||2'),
    }).toMatchInlineSnapshot(`
      final: { id: 2, name: 'Ada' }
      reconciled: ['temp:Ada -> users||2']
      resolved: 'users||2'
    `);
  });

  test('a user created offline in one tab and sent by a tab opened later keeps her place in the list of the tab that created her', async () => {
    network.setOffline();
    const creator = await openUsersListTab('creator', {
      focused: true,
      listOpen: true,
    });

    await creator.queueCreate('Ada');

    // The user opens the app in another tab while still offline. It starts
    // with the creation waiting to be sent and, being the focused tab, it is
    // the one that sends it once the connection is back. It has no list
    // mounted: only the tab that created Ada shows her.
    const late = await openUsersListTab('late', {
      focused: true,
      listOpen: false,
    });
    network.goOnline();

    // Stop right after the creation is saved, before the lists are fetched
    // again: the row is moved by the reconciliation, not by a refetch
    for (let step = 0; step < 50 && serverCalls.length === 0; step++) {
      await advanceTime(100);
    }
    await advanceTime(1_300);
    expect(serverCalls).toMatchInlineSnapshot(`['tab late sent create Ada']`);

    // The saved user took the place of the temp row
    expect({
      list: creator.getListRows(),
      temp: creator.getUser('temp:Ada'),
      final: creator.getUser('users||2'),
    }).toMatchInlineSnapshot(`
      final: { id: 2, name: 'Ada' }
      list: ['Grace (id 1)', 'Ada (id 2)']
      temp: null
    `);
    expect({ creator: creator.reconciledUsers, late: late.reconciledUsers })
      .toMatchInlineSnapshot(`
        creator: ['temp:Ada -> users||2']
        late: ['temp:Ada -> users||2']
      `);
    expect(creator.resolveTempItemPayload('temp:Ada')).toMatchInlineSnapshot(
      `"users||2"`,
    );

    // The list fetched again after the replay keeps her there
    await advanceTime(5_000);
    expect(creator.getListRows()).toMatchInlineSnapshot(
      `['Grace (id 1)', 'Ada (id 2)']`,
    );
  });

  test('a user created offline in one tab is replaced by the saved user in the other tab, and both tabs learn the final id', async () => {
    network.setOffline();
    const tabA = await openUsersTab('A', { focused: true });
    const tabB = await openUsersTab('B', { focused: false });
    // Tab A keeps the focus and leads
    setDocumentHidden(false);

    // While offline the user creates Ada in tab A. Tab B gets her too.
    await tabA.queueCreate('Ada');
    expect({
      tabA: tabA.getUserName('temp:Ada'),
      tabB: tabB.getUserName('temp:Ada'),
    }).toMatchInlineSnapshot(`
      tabA: 'Ada'
      tabB: 'Ada'
    `);

    network.goOnline();
    await advanceTime(3_000);
    expect(serverCalls).toMatchInlineSnapshot(`['tab A sent create Ada']`);

    expect({
      tabA: {
        temp: tabA.getUserName('temp:Ada'),
        final: tabA.getUserName('users||Ada'),
      },
      tabB: {
        temp: tabB.getUserName('temp:Ada'),
        final: tabB.getUserName('users||Ada'),
      },
    }).toMatchInlineSnapshot(`
      tabA: { final: 'Ada', temp: null }
      tabB: { final: 'Ada', temp: null }
    `);
    expect({ tabA: tabA.reconciledUsers, tabB: tabB.reconciledUsers })
      .toMatchInlineSnapshot(`
        tabA: ['temp:Ada -> users||Ada']
        tabB: ['temp:Ada -> users||Ada']
      `);
    expect({
      tabA: tabA.resolveTempItemPayload('temp:Ada'),
      tabB: tabB.resolveTempItemPayload('temp:Ada'),
    }).toMatchInlineSnapshot(`
      tabA: 'users||Ada'
      tabB: 'users||Ada'
    `);
  });
});
