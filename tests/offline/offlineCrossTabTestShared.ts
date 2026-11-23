import { renderHook } from '@testing-library/react';
import { rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, vi } from 'vitest';
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
import { createSharedServerMockState } from '../mocks/serverMock';
import { createSharedServerTableState } from '../mocks/serverTableMock';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import { advanceTime } from '../utils/genericTestUtils';
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
export let network = createOfflineNetworkMock();
export let serverCalls: string[] = [];
let sharedServer = createSharedServerMockState(1);
export let sharedUsersServer = createSharedServerTableState<{ name: string }>(
  {},
);
/** While `true`, the users server rejects every delete. */
export const usersServerRules = { rejectDeletes: false };
export let sharedUserRowsServer = createSharedServerTableState<{
  id: number;
  name: string;
}>({});

/** Replaces the users the shared server starts with */
export function seedSharedUsersServer(
  initialItems: Record<string, { name: string }>,
) {
  sharedUsersServer = createSharedServerTableState(initialItems);
}

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
  usersServerRules.rejectDeletes = false;
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

export function setDocumentHidden(hidden: boolean) {
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
 * Sets the document value, like a slider. Several values queued offline are
 * merged into one request with the last one.
 */
type SetValueOperations = { setValue: UpdateValueOperations['updateValue'] };

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
export async function openTab(
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
        SetValueOperations &
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
            setValue: {
              inputSchema: docMutationInputSchema,
              kind: 'update',
              accumulation: {
                mergeInput: ({ incomingInput }) => incomingInput,
              },
              execute: async ({ input }) => {
                serverCalls.push(
                  `tab ${name} sent ${storeId} = ${input.value}`,
                );
                await env.serverMock.delayedSetData(input.value);
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
    /**
     * Queues an offline edit the way a user edit in this tab would. A
     * `setValue` edit (a slider) is merged with the one still queued.
     */
    async queueEdit(
      value: number,
      storeId = 'doc',
      operation: 'updateValue' | 'setValue' = 'updateValue',
    ) {
      await getEnv(storeId).apiStore.performMutation({
        mutation: async () => {
          await getEnv(storeId).serverMock.delayedSetData(value);
          return value;
        },
        offline: { operation, input: { value } },
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
export async function blurWindow() {
  setDocumentHidden(true);
  window.dispatchEvent(new Event('blur'));
  await advanceTime(10);
}

export type Tab = Awaited<ReturnType<typeof openTab>>;

/** Closes `closing`, then the user focuses the window of the remaining tab. */
export async function closeTabAndFocusRemaining(closing: Tab) {
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
export async function openNewVersionTab(
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

export async function openUsersTab(
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
                if (usersServerRules.rejectDeletes) {
                  throw new Error('delete rejected');
                }
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
export async function openUsersListTab(
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
export function describeTabs(
  ...tabs: Array<Pick<Tab, 'name' | 'storeManager'>>
) {
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
