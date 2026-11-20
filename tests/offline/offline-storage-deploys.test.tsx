import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  type DocumentOfflineOperationDefinition,
  type ListQueryOfflineOperationDefinition,
} from '../../src/main';
import { opfsPersistentStorage } from '../../src/persistentStorage/storageAdapter';
import { createStoreManager } from '../../src/storeManager';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
} from '../mocks/listQueryStoreTestEnv';
import { normalizeError, TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import {
  flushAllTimers,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { createOpfsPersistentStorageTestStore } from '../utils/opfsPersistentStorageTestStore';
import { resetSessionForTests } from '../utils/resetSessionForTests';
import {
  type CreateListQueryUserOperations,
  deleteItemInputSchema,
  type UpdateValueConflictOperations,
  userPatchSchema,
  userRowSchema,
} from './offlineReplayTestShared';
import {
  collectionCreateInputSchema,
  docConflictSchema,
  docMutationInputSchema,
  docSchema,
  listQueryQueryPayloadSchema,
  offlineStorageUsersQuery,
  type OfflineStorageUserRow,
  offlineStorageUsersTable,
  summarizeResolution,
} from './offlineTestShared';

let network = createOfflineNetworkMock();

/**
 * A document store with an `updateValue` operation whose replay of `value: 3`
 * ends in a conflict. In the deploy tests, it is the app after the deploy that
 * added `updateValue`.
 */
function createConflictingDocumentEnv({
  sessionKey,
  storeName,
  onExecute,
  adapter = 'local-sync',
  startedLongBeforeTestTime = false,
}: {
  sessionKey: string;
  storeName: string;
  onExecute?: (input: { value: number }) => void;
  adapter?: 'local-sync' | typeof opfsPersistentStorage;
  /** The app ran days before `TEST_INITIAL_TIME`. */
  startedLongBeforeTestTime?: boolean;
}) {
  const env = createDocumentStoreTestEnv<number, UpdateValueConflictOperations>(
    1,
    {
      id: storeName,
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
      }),
      testScenario: 'loaded',
      __DANGEROUS_IGNORE_INITIAL_TIME_CHECK__: startedLongBeforeTestTime,
      persistentStorage: {
        adapter,
        schema: docSchema,
        offline: {
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              kind: 'update',
              execute: async ({ input }) => {
                onExecute?.(input);
                await env.serverMock.delayedSetData(input.value);
                return input;
              },
              conflictHandling: {
                schema: docConflictSchema,
                detectConflict: ({ input }) =>
                  input.value === 3 ? { reason: 'server-changed' } : false,
              },
            },
          },
        },
      },
    },
  );

  return env;
}

type OlderDeployOperations = {
  legacyUpdateValue: DocumentOfflineOperationDefinition<
    { value: number },
    { input: { value: number } }
  >;
};

/**
 * The same store in a tab still running the deploy from before `updateValue`
 * existed: it only knows `legacyUpdateValue`.
 */
function createOlderDeployDocumentEnv({
  sessionKey,
  storeName,
}: {
  sessionKey: string;
  storeName: string;
}) {
  return createDocumentStoreTestEnv<number, OlderDeployOperations>(1, {
    id: storeName,
    getSessionKey: () => sessionKey,
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: { network: network.config },
    }),
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        operations: {
          legacyUpdateValue: {
            inputSchema: docMutationInputSchema,
            kind: 'update',
            execute: ({ input }) => Promise.resolve(input),
          },
        },
      },
    },
  });
}

function createDeployStoreManager(
  sessionKey: string,
  onPersistentStorageError?: (error: unknown) => void,
) {
  return createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: { network: network.config },
    onPersistentStorageError,
  });
}

type DocumentValueOperation = DocumentOfflineOperationDefinition<
  { value: number },
  { input: { value: number } }
>;

/**
 * A document store of a deploy that defines `operationNames`. Each replay is
 * logged in `sent` as `label.operation(value)`.
 */
function createDeployDocumentEnv({
  storeManager,
  storeName,
  label,
  operationNames,
  removedOperations,
  sent,
}: {
  storeManager: ReturnType<typeof createDeployStoreManager>;
  storeName: string;
  label: string;
  operationNames: readonly string[];
  removedOperations?: readonly string[];
  sent: string[];
}) {
  const operations: Record<string, DocumentValueOperation> = {};
  for (const operationName of operationNames) {
    operations[operationName] = {
      inputSchema: docMutationInputSchema,
      kind: 'update',
      execute: ({ input }) => {
        sent.push(`${label}.${operationName}(${input.value})`);
        return Promise.resolve(input);
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
      offline: { operations, removedOperations },
    },
  });
}

function queueOfflineValueEdit(
  env: ReturnType<typeof createDeployDocumentEnv>,
  operation: string,
  value: number,
) {
  return resolveAfterAllTimers(
    env.apiStore.performMutation({
      mutation: () => Promise.resolve(value),
      offline: { operation, input: { value } },
    }),
  );
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

test('opfs conflicts left unresolved for more than two weeks can still be resolved', async () => {
  createOpfsPersistentStorageTestStore();
  const sessionKey = 'offline-opfs-old-conflict-session';
  const storeName = 'offline-opfs-old-conflict-doc';

  // Fifteen days ago, longer than the async cache max age, an offline edit
  // ended in a conflict when the connection came back, and the user left it
  // unresolved.
  vi.setSystemTime(TEST_INITIAL_TIME - 15 * 24 * 60 * 60 * 1000);
  network.setOffline();
  const firstEnv = createConflictingDocumentEnv({
    sessionKey,
    storeName,
    adapter: opfsPersistentStorage,
    startedLongBeforeTestTime: true,
  });
  await resolveAfterAllTimers(
    firstEnv.apiStore.performMutation({
      optimisticUpdate: () => {
        firstEnv.apiStore.updateState((draft) => {
          draft.value = 3;
        });
      },
      mutation: async () => {
        await firstEnv.serverMock.delayedSetData(3);
        return 3;
      },
      offline: { operation: 'updateValue', input: { value: 3 } },
    }),
  );
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();
  expect(firstEnv.apiStore.getOfflineResolutions()).toHaveLength(1);

  // Today the user opens the app online, which runs the storage cleanup.
  resetSessionForTests();
  vi.setSystemTime(TEST_INITIAL_TIME);
  const restartedEnv = createConflictingDocumentEnv({
    sessionKey,
    storeName,
    adapter: opfsPersistentStorage,
  });
  const restartedHook = renderHook(() => restartedEnv.apiStore.useDocument());
  await flushAllTimers();
  restartedHook.unmount();

  // The conflict is unsent work, not cached data: it doesn't expire, so it is
  // still there when the app is opened again.
  resetSessionForTests();
  const reopenedEnv = createConflictingDocumentEnv({
    sessionKey,
    storeName,
    adapter: opfsPersistentStorage,
  });
  const reopenedHook = renderHook(() => reopenedEnv.apiStore.useDocument());
  await flushAllTimers();

  const [resolution] = reopenedEnv.apiStore.getOfflineResolutions();
  if (!resolution) throw new Error('Expected the conflict to be kept');
  expect(summarizeResolution(resolution)).toMatchInlineSnapshot(`
    input: 'value: 3'
    kind: 'conflict'
    on: 'document:document'
    op: 'updateValue'
    reason: 'server-changed'
  `);

  reopenedHook.unmount();
});

test('an older deploy keeps edits queued for an operation only a newer deploy knows, and the newer deploy sends them', async () => {
  const sessionKey = 'offline-unknown-operation-entry-session';
  const storeName = 'offline-unknown-operation-entry-doc';
  const sentByNewerDeploy: { value: number }[] = [];

  // The user edits offline in the newer deploy.
  network.setOffline();
  const newerEnv = createConflictingDocumentEnv({ sessionKey, storeName });
  await resolveAfterAllTimers(
    newerEnv.apiStore.performMutation({
      optimisticUpdate: () => {
        newerEnv.apiStore.updateState((draft) => {
          draft.value = 2;
        });
      },
      mutation: async () => {
        await newerEnv.serverMock.delayedSetData(2);
        return 2;
      },
      offline: { operation: 'updateValue', input: { value: 2 } },
    }),
  );
  await flushAllTimers();

  // The connection comes back while only a tab of the older deploy is open
  // (e.g. a tab that was not reloaded after the deploy).
  resetSessionForTests();
  act(() => {
    network.goOnline();
  });
  const olderEnv = createOlderDeployDocumentEnv({ sessionKey, storeName });
  const olderHook = renderHook(() => olderEnv.apiStore.useDocument());
  await flushAllTimers();

  // The older deploy can't send an operation it doesn't define, so it doesn't
  // list it either. Before, its replay deleted the edit from storage.
  expect(olderEnv.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  olderHook.unmount();

  // The user reloads into the newer deploy: the edit is still queued and is
  // sent once.
  resetSessionForTests();
  const reloadedEnv = createConflictingDocumentEnv({
    sessionKey,
    storeName,
    onExecute: (input) => {
      sentByNewerDeploy.push(input);
    },
  });
  const reloadedHook = renderHook(() => reloadedEnv.apiStore.useDocument());
  await flushAllTimers();

  expect(sentByNewerDeploy).toMatchInlineSnapshot(`
    - value: 2
  `);
  expect(reloadedEnv.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);

  reloadedHook.unmount();
});

test('an older deploy keeps conflicts of an operation only a newer deploy knows', async () => {
  const sessionKey = 'offline-unknown-operation-resolution-session';
  const storeName = 'offline-unknown-operation-resolution-doc';

  // In the newer deploy, an offline edit ends in a conflict when it is sent.
  network.setOffline();
  const newerEnv = createConflictingDocumentEnv({ sessionKey, storeName });
  await resolveAfterAllTimers(
    newerEnv.apiStore.performMutation({
      optimisticUpdate: () => {
        newerEnv.apiStore.updateState((draft) => {
          draft.value = 3;
        });
      },
      mutation: async () => {
        await newerEnv.serverMock.delayedSetData(3);
        return 3;
      },
      offline: { operation: 'updateValue', input: { value: 3 } },
    }),
  );
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();
  expect(newerEnv.apiStore.getOfflineResolutions()).toHaveLength(1);

  // A tab of the older deploy opens the store. It can't resolve a conflict of
  // an operation it doesn't define, so it doesn't list it. Before, it deleted
  // the conflict from storage while loading it.
  resetSessionForTests();
  const olderEnv = createOlderDeployDocumentEnv({ sessionKey, storeName });
  const olderHook = renderHook(() => olderEnv.apiStore.useDocument());
  await flushAllTimers();
  expect(olderEnv.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  olderHook.unmount();

  // Back in the newer deploy, the user can still resolve the conflict.
  resetSessionForTests();
  const reloadedEnv = createConflictingDocumentEnv({ sessionKey, storeName });
  const reloadedHook = renderHook(() => reloadedEnv.apiStore.useDocument());
  await flushAllTimers();

  const [resolution] = reloadedEnv.apiStore.getOfflineResolutions();
  if (!resolution) throw new Error('Expected the conflict to still be queued');
  expect(summarizeResolution(resolution)).toMatchInlineSnapshot(`
    input: 'value: 3'
    kind: 'conflict'
    on: 'document:document'
    op: 'updateValue'
    reason: 'server-changed'
  `);

  reloadedHook.unmount();
});

test('an older deploy pauses sync behind edits only a newer deploy can send, so the latest edit is the one kept', async () => {
  const sessionKey = 'offline-unknown-operation-order-session';
  const docStoreName = 'offline-unknown-operation-order-doc';
  const otherStoreName = 'offline-unknown-operation-order-other';
  const sent: string[] = [];

  // In the newer deploy, which added `updateValue`, the user edits a document
  // offline twice: first with the new operation, then with one both deploys
  // know. Then they edit another store, also with an operation both know.
  network.setOffline();
  const newerStoreManager = createDeployStoreManager(sessionKey);
  const newerDoc = createDeployDocumentEnv({
    storeManager: newerStoreManager,
    storeName: docStoreName,
    label: 'doc',
    operationNames: ['updateValue', 'legacyUpdateValue'],
    sent,
  });
  const newerOther = createDeployDocumentEnv({
    storeManager: newerStoreManager,
    storeName: otherStoreName,
    label: 'other',
    operationNames: ['legacyUpdateValue'],
    sent,
  });
  await queueOfflineValueEdit(newerDoc, 'updateValue', 5);
  await queueOfflineValueEdit(newerDoc, 'legacyUpdateValue', 7);
  await queueOfflineValueEdit(newerOther, 'legacyUpdateValue', 1);
  await flushAllTimers();

  // The connection comes back while only a tab of the older deploy, which
  // doesn't define `updateValue`, is open.
  resetSessionForTests();
  act(() => {
    network.goOnline();
  });
  const reportedErrors: string[] = [];
  const olderStoreManager = createDeployStoreManager(sessionKey, (error) => {
    reportedErrors.push(error instanceof Error ? error.message : 'unknown');
  });
  const olderDoc = createDeployDocumentEnv({
    storeManager: olderStoreManager,
    storeName: docStoreName,
    label: 'doc',
    operationNames: ['legacyUpdateValue'],
    sent,
  });
  const olderOther = createDeployDocumentEnv({
    storeManager: olderStoreManager,
    storeName: otherStoreName,
    label: 'other',
    operationNames: ['legacyUpdateValue'],
    sent,
  });
  const olderDocHook = renderHook(() => olderDoc.apiStore.useDocument());
  const olderOtherHook = renderHook(() => olderOther.apiStore.useDocument());
  await flushAllTimers();

  // Sending the edits it knows would put `7` on the server before `5`, and
  // the newer deploy would later overwrite the user's latest edit with `5`.
  // The document store waits instead, and so does the later edit of the
  // other store, to keep the order the user made them in.
  expect(sent).toMatchInlineSnapshot(`[]`);
  // The app is told why the store waits, in case the operation was removed
  // for good (e.g. a rolled back deploy) and must be listed in
  // `removedOperations`.
  expect(reportedErrors).toMatchInlineSnapshot(
    `- '[tsdf] Store "offline-unknown-operation-order-doc" has unsent offline work of operations this deploy does not define (updateValue). It is kept for a deploy that defines them, and the store pauses sending its offline work until then. If they were removed for good, list them in removedOperations.'`,
  );
  olderDocHook.unmount();
  olderOtherHook.unmount();

  // The user reloads into the newer deploy: every edit is sent in order.
  resetSessionForTests();
  const reloadedStoreManager = createDeployStoreManager(sessionKey);
  const reloadedDoc = createDeployDocumentEnv({
    storeManager: reloadedStoreManager,
    storeName: docStoreName,
    label: 'doc',
    operationNames: ['updateValue', 'legacyUpdateValue'],
    sent,
  });
  const reloadedOther = createDeployDocumentEnv({
    storeManager: reloadedStoreManager,
    storeName: otherStoreName,
    label: 'other',
    operationNames: ['legacyUpdateValue'],
    sent,
  });
  const reloadedDocHook = renderHook(() => reloadedDoc.apiStore.useDocument());
  const reloadedOtherHook = renderHook(() =>
    reloadedOther.apiStore.useDocument(),
  );
  await flushAllTimers();

  expect(sent).toMatchInlineSnapshot(
    `['doc.updateValue(5)', 'doc.legacyUpdateValue(7)', 'other.legacyUpdateValue(1)']`,
  );

  reloadedDocHook.unmount();
  reloadedOtherHook.unmount();
});

test('an online edit in an older deploy waits behind an earlier edit only a newer deploy can send', async () => {
  const sessionKey = 'offline-unknown-operation-online-edit-session';
  const storeName = 'offline-unknown-operation-online-edit-doc';
  const sent: string[] = [];

  // In the newer deploy, which added `updateValue`, the user edits the
  // document offline.
  network.setOffline();
  const newerEnv = createDeployDocumentEnv({
    storeManager: createDeployStoreManager(sessionKey),
    storeName,
    label: 'newer',
    operationNames: ['updateValue', 'legacyUpdateValue'],
    sent,
  });
  await queueOfflineValueEdit(newerEnv, 'updateValue', 5);
  await flushAllTimers();

  // Back online, in a tab of the older deploy, the user edits it again. Sent
  // right away, this later edit would reach the server first and the newer
  // deploy would then overwrite it with `5`: it waits behind it instead.
  resetSessionForTests();
  act(() => {
    network.goOnline();
  });
  const olderEnv = createDeployDocumentEnv({
    storeManager: createDeployStoreManager(sessionKey),
    storeName,
    label: 'older',
    operationNames: ['legacyUpdateValue'],
    sent,
  });
  const olderHook = renderHook(() => olderEnv.apiStore.useDocument());
  await flushAllTimers();
  await queueOfflineValueEdit(olderEnv, 'legacyUpdateValue', 9);
  await flushAllTimers();
  olderHook.unmount();

  // The user reloads into the newer deploy: both edits are sent in the order
  // they were made, so the server ends with the latest one. Had the older
  // deploy sent `9` right away, only `5` would be sent here.
  resetSessionForTests();
  const reloadedEnv = createDeployDocumentEnv({
    storeManager: createDeployStoreManager(sessionKey),
    storeName,
    label: 'reloaded',
    operationNames: ['updateValue', 'legacyUpdateValue'],
    sent,
  });
  const reloadedHook = renderHook(() => reloadedEnv.apiStore.useDocument());
  await flushAllTimers();
  expect(sent).toMatchInlineSnapshot(
    `['reloaded.updateValue(5)', 'reloaded.legacyUpdateValue(9)']`,
  );

  reloadedHook.unmount();
});

test('queued edits of an operation listed in removedOperations are deleted and no longer hold back sync', async () => {
  const sessionKey = 'offline-removed-operation-session';
  const storeName = 'offline-removed-operation-doc';
  const sent: string[] = [];
  const reportedErrors: string[] = [];

  // An older deploy still has `oldUpdateValue`. The user edits offline with
  // it, then with `updateValue`.
  network.setOffline();
  const olderEnv = createDeployDocumentEnv({
    storeManager: createDeployStoreManager(sessionKey),
    storeName,
    label: 'doc',
    operationNames: ['oldUpdateValue', 'updateValue'],
    sent,
  });
  await queueOfflineValueEdit(olderEnv, 'oldUpdateValue', 2);
  await queueOfflineValueEdit(olderEnv, 'updateValue', 3);
  await flushAllTimers();

  // The next deploy deletes `oldUpdateValue` for good and lists it in
  // `removedOperations`. The user opens it online.
  resetSessionForTests();
  act(() => {
    network.goOnline();
  });
  const newerEnv = createDeployDocumentEnv({
    storeManager: createDeployStoreManager(sessionKey, (error) => {
      reportedErrors.push(error instanceof Error ? error.message : 'unknown');
    }),
    storeName,
    label: 'doc',
    operationNames: ['updateValue'],
    removedOperations: ['oldUpdateValue'],
    sent,
  });
  const newerHook = renderHook(() => newerEnv.apiStore.useDocument());
  await flushAllTimers();

  // The edit of the removed operation can't be sent by any deploy anymore:
  // it is dropped and reported, and the edit after it is sent.
  expect(sent).toMatchInlineSnapshot(`['doc.updateValue(3)']`);
  expect(reportedErrors).toMatchInlineSnapshot(
    `- '[tsdf] Store "offline-removed-operation-doc" still had 1 unsent offline record(s) (queued mutations or pending resolutions) of operations listed in its removedOperations, or of entities they created. They are deleted: no deploy can replay them anymore.'`,
  );
  newerHook.unmount();

  // It was deleted from storage, so it is not reported again.
  resetSessionForTests();
  reportedErrors.length = 0;
  const reopenedEnv = createDeployDocumentEnv({
    storeManager: createDeployStoreManager(sessionKey, (error) => {
      reportedErrors.push(error instanceof Error ? error.message : 'unknown');
    }),
    storeName,
    label: 'doc',
    operationNames: ['updateValue'],
    removedOperations: ['oldUpdateValue'],
    sent,
  });
  const reopenedHook = renderHook(() => reopenedEnv.apiStore.useDocument());
  await flushAllTimers();
  expect(reportedErrors).toMatchInlineSnapshot(`[]`);

  reopenedHook.unmount();
});

/**
 * The persistent storage config of a users list query store of a deploy that
 * defines `operations`.
 */
function usersDeployPersistentStorage<TOperations>(
  operations: TOperations,
  removedOperations?: readonly string[],
) {
  return {
    adapter: 'local-sync' as const,
    schema: userRowSchema,
    itemPayloadSchema: rc_string,
    queryPayloadSchema: listQueryQueryPayloadSchema,
    offline: { operations, removedOperations },
  };
}

type PatchUserNameOperation = ListQueryOfflineOperationDefinition<
  OfflineStorageUserRow,
  ListQueryParams,
  string,
  { itemId: string; name: string },
  unknown
>;

function createPatchUserNameOperation(sent: string[]): PatchUserNameOperation {
  return {
    inputSchema: userPatchSchema,
    kind: 'update',
    getEntityRefs: ({ input }) => [input.itemId],
    execute: ({ input }) => {
      sent.push(`patchUserName(${input.itemId}, ${input.name})`);
      return Promise.resolve({ name: input.name });
    },
    // Only what is sent matters here.
    onSuccessExecute: () => {},
  };
}

function createCreateUserOperation(
  sent: string[],
): CreateListQueryUserOperations['createUser'] {
  return {
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
    execute: ({ input }) => {
      sent.push(`createUser(${input.name})`);
      return Promise.resolve({ id: 3, name: input.name });
    },
  };
}

type PatchUserNameOperations = { patchUserName: PatchUserNameOperation };

test('removing a create operation also deletes the queued edits of the items it would have created', async () => {
  const sessionKey = 'offline-removed-create-operation-session';
  const storeName = 'offline-removed-create-operation-users';
  const sent: string[] = [];
  const reportedErrors: string[] = [];

  // In a deploy that still has `createUser`, the user creates a user offline
  // and renames it. They also rename a user that already exists.
  network.setOffline();
  const createUser = createCreateUserOperation(sent);
  const olderEnv = createListQueryStoreTestEnv<
    OfflineStorageUserRow,
    false,
    false,
    CreateListQueryUserOperations & PatchUserNameOperations
  >(offlineStorageUsersTable, {
    id: storeName,
    storeManager: createDeployStoreManager(sessionKey),
    testScenario: { loaded: { queries: [offlineStorageUsersQuery] } },
    persistentStorage: usersDeployPersistentStorage({
      createUser,
      patchUserName: createPatchUserNameOperation(sent),
    }),
  });
  await resolveAfterAllTimers(
    olderEnv.apiStore.performMutation(null, {
      mutation: () => Promise.resolve({ id: 3, name: 'Linus' }),
      offline: { operation: 'createUser', input: { name: 'Linus' } },
    }),
  );
  await resolveAfterAllTimers(
    olderEnv.apiStore.performMutation('temp:Linus', {
      mutation: () => Promise.resolve({ name: 'Linus T.' }),
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'temp:Linus', name: 'Linus T.' },
      },
    }),
  );
  await resolveAfterAllTimers(
    olderEnv.apiStore.performMutation('users||1', {
      mutation: () => Promise.resolve({ name: 'Ada L.' }),
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||1', name: 'Ada L.' },
      },
    }),
  );
  await flushAllTimers();

  // The next deploy deletes `createUser` for good and lists it in
  // `removedOperations`. The user opens it online.
  resetSessionForTests();
  act(() => {
    network.goOnline();
  });
  const newerEnv = createListQueryStoreTestEnv<
    OfflineStorageUserRow,
    false,
    false,
    PatchUserNameOperations
  >(offlineStorageUsersTable, {
    id: storeName,
    storeManager: createDeployStoreManager(sessionKey, (error) => {
      reportedErrors.push(error instanceof Error ? error.message : 'unknown');
    }),
    testScenario: { loaded: { queries: [offlineStorageUsersQuery] } },
    persistentStorage: usersDeployPersistentStorage(
      { patchUserName: createPatchUserNameOperation(sent) },
      ['createUser'],
    ),
  });
  const newerHook = renderHook(() =>
    newerEnv.apiStore.useListQuery(offlineStorageUsersQuery),
  );
  await flushAllTimers();

  // The created user never reaches the server, so its rename is deleted with
  // it instead of being sent for an item the server doesn't have. The rename
  // of the existing user is still sent.
  expect(sent).toMatchInlineSnapshot(`['patchUserName(users||1, Ada L.)']`);
  expect(reportedErrors).toMatchInlineSnapshot(
    `- '[tsdf] Store "offline-removed-create-operation-users" still had 2 unsent offline record(s) (queued mutations or pending resolutions) of operations listed in its removedOperations, or of entities they created. They are deleted: no deploy can replay them anymore.'`,
  );
  // The optimistic row of the user that will never be created is removed
  // too, instead of staying as a normal row the user could keep editing
  expect(newerEnv.apiStore.getItemState('temp:Linus')).toBeNull();

  newerHook.unmount();
});

test('removing a create operation also deletes the queued edits of its items that the deploy does not define', async () => {
  const sessionKey = 'offline-removed-create-unknown-edit-session';
  const storeName = 'offline-removed-create-unknown-edit-users';
  const sent: string[] = [];
  const reportedErrors: string[] = [];

  // In a deploy with `createUser` and `patchUserName`, the user creates a user
  // offline and renames it.
  network.setOffline();
  const olderEnv = createListQueryStoreTestEnv<
    OfflineStorageUserRow,
    false,
    false,
    CreateListQueryUserOperations & PatchUserNameOperations
  >(offlineStorageUsersTable, {
    id: storeName,
    storeManager: createDeployStoreManager(sessionKey),
    testScenario: { loaded: { queries: [offlineStorageUsersQuery] } },
    persistentStorage: usersDeployPersistentStorage({
      createUser: createCreateUserOperation(sent),
      patchUserName: createPatchUserNameOperation(sent),
    }),
  });
  await resolveAfterAllTimers(
    olderEnv.apiStore.performMutation(null, {
      mutation: () => Promise.resolve({ id: 3, name: 'Linus' }),
      offline: { operation: 'createUser', input: { name: 'Linus' } },
    }),
  );
  await resolveAfterAllTimers(
    olderEnv.apiStore.performMutation('temp:Linus', {
      mutation: () => Promise.resolve({ name: 'Linus T.' }),
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'temp:Linus', name: 'Linus T.' },
      },
    }),
  );
  await flushAllTimers();

  // The next deploy deletes `createUser` for good and, for now, has no
  // `patchUserName` either (it only renames through `renameUser`). The user
  // opens it online.
  resetSessionForTests();
  act(() => {
    network.goOnline();
  });
  const middleEnv = createListQueryStoreTestEnv<
    OfflineStorageUserRow,
    false,
    false,
    { renameUser: PatchUserNameOperation }
  >(offlineStorageUsersTable, {
    id: storeName,
    storeManager: createDeployStoreManager(sessionKey, (error) => {
      reportedErrors.push(error instanceof Error ? error.message : 'unknown');
    }),
    testScenario: { loaded: { queries: [offlineStorageUsersQuery] } },
    persistentStorage: usersDeployPersistentStorage(
      { renameUser: createPatchUserNameOperation(sent) },
      ['createUser'],
    ),
  });
  const middleHook = renderHook(() =>
    middleEnv.apiStore.useListQuery(offlineStorageUsersQuery),
  );
  await flushAllTimers();

  // The rename of the user that will never exist is deleted with its creation,
  // although this deploy can't read it: kept, it would pause the store's sync
  // and later be sent for an item the server doesn't have
  expect(reportedErrors).toMatchInlineSnapshot(
    `- '[tsdf] Store "offline-removed-create-unknown-edit-users" still had 2 unsent offline record(s) (queued mutations or pending resolutions) of operations listed in its removedOperations, or of entities they created. They are deleted: no deploy can replay them anymore.'`,
  );
  middleHook.unmount();

  // A later deploy brings `patchUserName` back. Nothing is left to send.
  resetSessionForTests();
  const laterEnv = createListQueryStoreTestEnv<
    OfflineStorageUserRow,
    false,
    false,
    PatchUserNameOperations
  >(offlineStorageUsersTable, {
    id: storeName,
    storeManager: createDeployStoreManager(sessionKey),
    testScenario: { loaded: { queries: [offlineStorageUsersQuery] } },
    persistentStorage: usersDeployPersistentStorage(
      { patchUserName: createPatchUserNameOperation(sent) },
      ['createUser'],
    ),
  });
  const laterHook = renderHook(() =>
    laterEnv.apiStore.useListQuery(offlineStorageUsersQuery),
  );
  await flushAllTimers();

  expect(sent).toMatchInlineSnapshot(`[]`);

  laterHook.unmount();
});

type InviteUserOperation = ListQueryOfflineOperationDefinition<
  OfflineStorageUserRow,
  ListQueryParams,
  string,
  { name: string; invitedBy: string },
  unknown,
  OfflineStorageUserRow
>;

test('removing a create operation also deletes the creations that only depend on its items through dependsOn', async () => {
  const sessionKey = 'offline-removed-create-unknown-dependent-session';
  const storeName = 'offline-removed-create-unknown-dependent-users';
  const sent: string[] = [];
  const reportedErrors: string[] = [];

  // `inviteUser` creates a new user invited by another one. It only refers to
  // the inviter through `dependsOn`, not through its entity refs.
  const inviteUser: InviteUserOperation = {
    inputSchema: rc_object({ name: rc_string, invitedBy: rc_string }),
    kind: 'create',
    getEntityRefs: ({ input }) => [`temp:${input.name}`],
    dependsOn: ({ input }) => [input.invitedBy],
    tempEntity: {
      buildPendingEntity: (input) => ({ id: -2, name: input.name }),
      reconcileServerEntity: (result) => ({
        finalPayload: `users||${result.id}`,
        finalData: result,
      }),
    },
    execute: ({ input }) => {
      sent.push(`inviteUser(${input.name}, ${input.invitedBy})`);
      return Promise.resolve({ id: 4, name: input.name });
    },
  };

  // In a deploy with `createUser` and `inviteUser`, the user creates Linus
  // offline, then invites Grace on Linus' behalf.
  network.setOffline();
  const olderEnv = createListQueryStoreTestEnv<
    OfflineStorageUserRow,
    false,
    false,
    CreateListQueryUserOperations & { inviteUser: InviteUserOperation }
  >(offlineStorageUsersTable, {
    id: storeName,
    storeManager: createDeployStoreManager(sessionKey),
    testScenario: { loaded: { queries: [offlineStorageUsersQuery] } },
    persistentStorage: usersDeployPersistentStorage({
      createUser: createCreateUserOperation(sent),
      inviteUser,
    }),
  });
  await resolveAfterAllTimers(
    olderEnv.apiStore.performMutation(null, {
      mutation: () => Promise.resolve({ id: 3, name: 'Linus' }),
      offline: { operation: 'createUser', input: { name: 'Linus' } },
    }),
  );
  await resolveAfterAllTimers(
    olderEnv.apiStore.performMutation(null, {
      mutation: () => Promise.resolve({ id: 4, name: 'Grace' }),
      offline: {
        operation: 'inviteUser',
        input: { name: 'Grace', invitedBy: 'temp:Linus' },
      },
    }),
  );
  await flushAllTimers();

  // The next deploy deletes `createUser` for good and doesn't define
  // `inviteUser` yet. The user opens it online.
  resetSessionForTests();
  act(() => {
    network.goOnline();
  });
  const middleEnv = createListQueryStoreTestEnv<
    OfflineStorageUserRow,
    false,
    false,
    PatchUserNameOperations
  >(offlineStorageUsersTable, {
    id: storeName,
    storeManager: createDeployStoreManager(sessionKey, (error) => {
      reportedErrors.push(error instanceof Error ? error.message : 'unknown');
    }),
    testScenario: { loaded: { queries: [offlineStorageUsersQuery] } },
    persistentStorage: usersDeployPersistentStorage(
      { patchUserName: createPatchUserNameOperation(sent) },
      ['createUser'],
    ),
  });
  const middleHook = renderHook(() =>
    middleEnv.apiStore.useListQuery(offlineStorageUsersQuery),
  );
  await flushAllTimers();

  // Grace's invitation needs Linus, who will never exist. This deploy can't
  // run `inviteUser.dependsOn`, but the invitation's input holds Linus' temp
  // id, so it is deleted with his creation instead of pausing the sync
  expect(reportedErrors).toMatchInlineSnapshot(
    `- '[tsdf] Store "offline-removed-create-unknown-dependent-users" still had 2 unsent offline record(s) (queued mutations or pending resolutions) of operations listed in its removedOperations, or of entities they created. They are deleted: no deploy can replay them anymore.'`,
  );
  middleHook.unmount();

  // A later deploy brings `inviteUser` back. Nothing is left to send for an
  // inviter the server doesn't have.
  resetSessionForTests();
  const laterEnv = createListQueryStoreTestEnv<
    OfflineStorageUserRow,
    false,
    false,
    { inviteUser: InviteUserOperation }
  >(offlineStorageUsersTable, {
    id: storeName,
    storeManager: createDeployStoreManager(sessionKey),
    testScenario: { loaded: { queries: [offlineStorageUsersQuery] } },
    persistentStorage: usersDeployPersistentStorage({ inviteUser }, [
      'createUser',
    ]),
  });
  const laterHook = renderHook(() =>
    laterEnv.apiStore.useListQuery(offlineStorageUsersQuery),
  );
  await flushAllTimers();

  expect(sent).toMatchInlineSnapshot(`[]`);

  laterHook.unmount();
});

type DeleteUserOperations = {
  deleteUser: ListQueryOfflineOperationDefinition<
    OfflineStorageUserRow,
    ListQueryParams,
    string,
    { itemId: string },
    unknown
  >;
};

test('deleting an unsent item in an older deploy does not drop its creation while a newer deploy still has edits of it', async () => {
  const sessionKey = 'offline-older-delete-unsent-item-session';
  const storeName = 'offline-older-delete-unsent-item-users';
  const sent: string[] = [];
  const deleteUser: DeleteUserOperations['deleteUser'] = {
    inputSchema: deleteItemInputSchema,
    kind: 'delete',
    getEntityRefs: ({ input }) => [input.itemId],
    // Deleting an item that never reached the server drops its creation
    // and the delete itself
    supersedes: {
      scope: 'same-entity',
      dropSelfIfTempLifecycleCancelled: true,
    },
    execute: ({ input }) => {
      sent.push(`deleteUser(${input.itemId})`);
      return Promise.resolve(undefined);
    },
    // Only what is sent matters here.
    onSuccessExecute: () => {},
  };

  // In the newer deploy, the user creates a user offline and renames it with
  // `patchUserName`, an operation the older deploy doesn't have
  network.setOffline();
  const newerEnv = createListQueryStoreTestEnv<
    OfflineStorageUserRow,
    false,
    false,
    CreateListQueryUserOperations &
      PatchUserNameOperations &
      DeleteUserOperations
  >(offlineStorageUsersTable, {
    id: storeName,
    storeManager: createDeployStoreManager(sessionKey),
    testScenario: { loaded: { queries: [offlineStorageUsersQuery] } },
    persistentStorage: usersDeployPersistentStorage({
      createUser: createCreateUserOperation(sent),
      patchUserName: createPatchUserNameOperation(sent),
      deleteUser,
    }),
  });
  await resolveAfterAllTimers(
    newerEnv.apiStore.performMutation(null, {
      mutation: () => Promise.resolve({ id: 3, name: 'Linus' }),
      offline: { operation: 'createUser', input: { name: 'Linus' } },
    }),
  );
  await resolveAfterAllTimers(
    newerEnv.apiStore.performMutation('temp:Linus', {
      mutation: () => Promise.resolve({ name: 'Linus T.' }),
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'temp:Linus', name: 'Linus T.' },
      },
    }),
  );
  await flushAllTimers();

  // Still offline, the user opens the older deploy and deletes that user
  resetSessionForTests();
  const olderEnv = createListQueryStoreTestEnv<
    OfflineStorageUserRow,
    false,
    false,
    CreateListQueryUserOperations & DeleteUserOperations
  >(offlineStorageUsersTable, {
    id: storeName,
    storeManager: createDeployStoreManager(sessionKey),
    testScenario: { loaded: { queries: [offlineStorageUsersQuery] } },
    persistentStorage: usersDeployPersistentStorage({
      createUser: createCreateUserOperation(sent),
      deleteUser,
    }),
  });
  const olderHook = renderHook(() =>
    olderEnv.apiStore.useListQuery(offlineStorageUsersQuery),
  );
  await flushAllTimers();
  await resolveAfterAllTimers(
    olderEnv.apiStore.performMutation('temp:Linus', {
      mutation: () => Promise.resolve(undefined),
      offline: { operation: 'deleteUser', input: { itemId: 'temp:Linus' } },
    }),
  );
  await flushAllTimers();
  olderHook.unmount();

  // Back online in the newer deploy, the creation, the rename and the delete
  // are sent in the order the user made them. Dropping the creation and the
  // delete would have left the rename to be sent for an item the server never
  // had.
  resetSessionForTests();
  act(() => {
    network.goOnline();
  });
  const reloadedEnv = createListQueryStoreTestEnv<
    OfflineStorageUserRow,
    false,
    false,
    CreateListQueryUserOperations &
      PatchUserNameOperations &
      DeleteUserOperations
  >(offlineStorageUsersTable, {
    id: storeName,
    storeManager: createDeployStoreManager(sessionKey),
    testScenario: { loaded: { queries: [offlineStorageUsersQuery] } },
    persistentStorage: usersDeployPersistentStorage({
      createUser: createCreateUserOperation(sent),
      patchUserName: createPatchUserNameOperation(sent),
      deleteUser,
    }),
  });
  const reloadedHook = renderHook(() =>
    reloadedEnv.apiStore.useListQuery(offlineStorageUsersQuery),
  );
  await flushAllTimers();

  expect(sent).toMatchInlineSnapshot(`
    - 'createUser(Linus)'
    - 'patchUserName(users||3, Linus T.)'
    - 'deleteUser(users||3)'
  `);

  reloadedHook.unmount();
});

test('local-sync offline edits of list-query items are persisted without storage errors', async () => {
  const sessionKey = 'offline-entity-payload-session';
  const storeName = 'offline-entity-payload-users';
  const sent: string[] = [];
  const reportedErrors: string[] = [];

  // The user renames an existing user while offline. The store keeps the
  // edited item's payload with the offline work it saves for that item.
  network.setOffline();
  const env = createListQueryStoreTestEnv<
    OfflineStorageUserRow,
    false,
    false,
    PatchUserNameOperations
  >(offlineStorageUsersTable, {
    id: storeName,
    storeManager: createDeployStoreManager(sessionKey, (error) => {
      reportedErrors.push(error instanceof Error ? error.message : 'unknown');
    }),
    testScenario: { loaded: { queries: [offlineStorageUsersQuery] } },
    persistentStorage: usersDeployPersistentStorage({
      patchUserName: createPatchUserNameOperation(sent),
    }),
  });
  await resolveAfterAllTimers(
    env.apiStore.performMutation('users||1', {
      mutation: () => Promise.resolve({ name: 'Ada L.' }),
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||1', name: 'Ada L.' },
      },
    }),
  );
  await flushAllTimers();

  // Saving the offline state of an item with a payload must not fail: the
  // app's storage error handler would otherwise report it on every offline
  // edit of a list-query or collection item.
  expect(reportedErrors).toMatchInlineSnapshot(`[]`);
});
