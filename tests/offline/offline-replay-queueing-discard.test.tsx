import { sleep } from '@ls-stack/utils/sleep';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type {
  CollectionOfflineOperationDefinition,
  DocumentOfflineOperationDefinition,
} from '../../src/main';
import { createStoreManager } from '../../src/storeManager';
import { createOfflineNetworkMock } from '../../src/testing';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import {
  deleteItemInputSchema,
  getLocalStorageKeys,
  type UpdateValueOperations,
  userPatchSchema,
} from './offlineReplayTestShared';
import {
  classifyRetryableReplayFailure,
  collectionCreateInputSchema,
  collectionSchema,
  docMutationInputSchema,
  docSchema,
} from './offlineTestShared';

let network = createOfflineNetworkMock();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
  network = createOfflineNetworkMock();
  network.install();
  localStorage.clear();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  localStorage.clear();
});

test('a failed offline change of a realtime document shows the server value once it needs a decision, and discarding it fetches nothing', async () => {
  const sessionKey = 'offline-discard-realtime-document-session';

  // The server rejects the change on every replay attempt, so it ends up
  // waiting for the user to decide what to do with it.
  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    getSessionKey: () => sessionKey,
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: {
        network: network.config,
        classifyRetryableFailure: (error, ctx) =>
          classifyRetryableReplayFailure(error, ctx.phase),
      },
    }),
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        operations: {
          updateValue: {
            inputSchema: docMutationInputSchema,
            kind: 'update',
            execute: () => {
              throw new Error('update rejected');
            },
            onSuccessExecute: () => {},
          },
        },
      },
    },
  });

  const hook = renderHook(() => {
    const doc = env.apiStore.useDocument();
    env.trackUIChanges(`value:${doc.data?.value ?? 'null'}`);
  });
  // Let the mount revalidation finish while online.
  await advanceTime(1_000);

  env.addTimelineComments('beforeNextAction', [
    'offline: change the value to 2',
  ]);
  await act(async () => {
    network.goOffline();
    await Promise.resolve();
  });
  await act(async () => {
    await env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value = 2;
        });
      },
      mutation: () => Promise.reject(new Error('unreachable while offline')),
      offline: { operation: 'updateValue', input: { value: 2 } },
    });
  });

  env.addTimelineComments('beforeNextAction', [
    'back online: the server rejects the change until it needs a resolution, then the document is refetched',
  ]);
  act(() => {
    network.goOnline();
  });
  // 3 attempts, 5s apart. Once the change needs a decision it only lives in
  // its resolution record: the document is refetched to show the server
  // value. That refetch is also the recovery revalidation, which a realtime
  // store would otherwise run when its reconnect cooldown ends, so the
  // document is fetched once.
  await advanceTime(15_000);
  await flushAllTimers();

  const [resolution] = env.apiStore.getOfflineResolutions();
  if (!resolution) {
    throw new Error('Expected the change to be waiting for a resolution');
  }

  // The document already shows the server value: discarding the change only
  // drops its record, nothing is fetched (no new timeline entry)
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(resolution.id, 'updateValue', {
      action: 'discard',
    });
  });
  await flushAllTimers();

  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ui        |
    0      | "value:1" | ui-initialized
    1s     | "value:1" | -- offline: change the value to 2
    .      | "value:2" | ui-changed
    .      | "value:2" | offline:updateValue queued
    .      | "value:2" | -- back online: the server rejects the change until it needs a resolution, then the document is refetched
    .      | "value:2" | offline:updateValue replay-started
    6s     | "value:2" | offline:updateValue replay-started
    11s    | "value:2" | offline:updateValue replay-started
    .      | "value:2" | offline:updateValue resolution-required
    11.01s | "value:2" | 🔴 >fetch-started
    11.81s | "value:2" | 🔴 <fetch-finished (value: 1)
    .      | "value:1" | ui-changed
    "
  `);

  hook.unmount();
});

test('failed offline changes of collection items show the server values once they need a decision, also for an item deleted locally', async () => {
  network.setOffline();
  const sessionKey = 'offline-discard-collection-item-session';

  type RejectedChangeOperations = {
    patchUserName: CollectionOfflineOperationDefinition<
      { value: { name: string } },
      string,
      { itemId: string; name: string },
      unknown
    >;
    deleteUser: CollectionOfflineOperationDefinition<
      { value: { name: string } },
      string,
      { itemId: string },
      unknown
    >;
  };

  // The server rejects every change, so they end up waiting for the user to
  // decide what to do with them.
  const env = createCollectionStoreTestEnv<
    { name: string },
    RejectedChangeOperations
  >(
    { 'users||1': { name: 'Ada' }, 'users||2': { name: 'Grace' } },
    {
      id: 'offline-discard-collection-item-store',
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: {
          network: network.config,
          classifyRetryableFailure: (error, ctx) =>
            classifyRetryableReplayFailure(error, ctx.phase),
        },
      }),
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: collectionSchema,
        payloadSchema: rc_string,
        offline: {
          operations: {
            patchUserName: {
              inputSchema: userPatchSchema,
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              execute: () => {
                throw new Error('rename rejected');
              },
              onSuccessExecute: () => {},
            },
            deleteUser: {
              inputSchema: deleteItemInputSchema,
              kind: 'delete',
              getEntityRefs: ({ input }) => [input.itemId],
              execute: () => {
                throw new Error('delete rejected');
              },
              onSuccessExecute: () => {},
            },
          },
        },
      },
    },
  );

  const hook = renderHook(() => {
    const ada = env.apiStore.useItem('users||1');
    const grace = env.apiStore.useItem('users||2');

    env.trackItemUI('ada', ada.data?.value.name ?? `- ${ada.status}`);
    env.trackItemUI('grace', grace.data?.value.name ?? `- ${grace.status}`);
  });
  await flushAllTimers();

  env.addTimelineComments('beforeNextAction', [
    'offline: rename Ada and delete Grace',
  ]);
  await act(async () => {
    await env.apiStore.performMutation('users||1', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('users||1', () => ({
          value: { name: 'Ada renamed' },
        }));
      },
      mutation: () => Promise.reject(new Error('unreachable while offline')),
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||1', name: 'Ada renamed' },
      },
    });
    await env.apiStore.performMutation('users||2', {
      optimisticUpdate: () => {
        env.apiStore.deleteItemState('users||2');
      },
      mutation: () => Promise.reject(new Error('unreachable while offline')),
      offline: { operation: 'deleteUser', input: { itemId: 'users||2' } },
    });
  });

  env.addTimelineComments('beforeNextAction', [
    'back online: the server rejects both changes until they need a resolution, then Ada and Grace are refetched',
  ]);
  act(() => {
    network.goOnline();
  });
  // 3 attempts per change, 5s apart: 30s covers both.
  await advanceTime(30_000);
  await flushAllTimers();

  const renameResolution = env.apiStore
    .getOfflineResolutions()
    .find((resolution) => resolution.operation === 'patchUserName');
  const deleteResolution = env.apiStore
    .getOfflineResolutions()
    .find((resolution) => resolution.operation === 'deleteUser');
  if (!renameResolution || !deleteResolution) {
    throw new Error('Expected both changes to be waiting for a resolution');
  }

  // Each change was refetched once it needed a decision: Ada shows her server
  // name, and Grace, whose delete removed her item locally, was fetched again
  // and shows up. Discarding the changes only drops their records.
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(
      deleteResolution.id,
      'deleteUser',
      { action: 'discard' },
    );
  });
  await flushAllTimers();

  await act(async () => {
    await env.apiStore.resolveOfflineResolution(
      renameResolution.id,
      'patchUserName',
      { action: 'discard' },
    );
  });
  await flushAllTimers();

  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ada         | grace     |
    0      | Ada         | Grace     | [ada, grace] ui-initialized
    1.01s  | Ada         | Grace     | -- offline: rename Ada and delete Grace
    .      | Ada renamed | Grace     | [ada] ui-changed
    .      | Ada renamed | Grace     | offline:patchUserName queued
    .      | Ada renamed | - deleted | [grace] ui-changed
    .      | Ada renamed | - deleted | offline:deleteUser queued
    .      | Ada renamed | - deleted | -- back online: the server rejects both changes until they need a resolution, then Ada and Grace are refetched
    .      | Ada renamed | - deleted | offline:patchUserName replay-started
    6.01s  | Ada renamed | - deleted | offline:patchUserName replay-started
    11.01s | Ada renamed | - deleted | offline:patchUserName replay-started
    .      | Ada renamed | - deleted | offline:patchUserName resolution-required
    .      | Ada renamed | - deleted | offline:deleteUser replay-started
    11.02s | Ada renamed | - deleted | 🔴 [users||1] >fetch-started
    11.82s | Ada renamed | - deleted | 🔴 [users||1] <fetch-finished (value: {"name":"Ada"})
    .      | Ada         | - deleted | [ada] ui-changed
    16.01s | Ada         | - deleted | offline:deleteUser replay-started
    21.01s | Ada         | - deleted | offline:deleteUser replay-started
    .      | Ada         | - deleted | offline:deleteUser resolution-required
    21.02s | Ada         | - deleted | 🟠 [users||1] >fetch-started
    .      | Ada         | - loading | [grace] ui-changed
    .      | Ada         | - loading | 🟡 [users||2] >fetch-started
    21.82s | Ada         | - loading | 🟠 [users||1] <fetch-finished (value: {"name":"Ada"})
    .      | Ada         | - loading | 🟡 [users||2] <fetch-finished (value: {"name":"Grace"})
    .      | Ada         | Grace     | [grace] ui-changed
    "
  `);

  hook.unmount();
});

test('a failed offline creation puts existing items changed on top of it back to the server values once it needs a decision', async () => {
  network.setOffline();
  const sessionKey = 'offline-discard-create-dependents-session';

  type TeamUser = { name: string; teamId?: string };
  type TeamOperations = {
    createTeam: CollectionOfflineOperationDefinition<
      { value: TeamUser },
      string,
      { name: string },
      unknown,
      { id: string }
    >;
    moveUserToTeam: CollectionOfflineOperationDefinition<
      { value: TeamUser },
      string,
      { itemId: string; teamId: string },
      unknown
    >;
    patchUserName: CollectionOfflineOperationDefinition<
      { value: TeamUser },
      string,
      { itemId: string; name: string },
      unknown
    >;
  };

  // The server rejects the team creation and the rename, so they end up
  // waiting for the user to decide what to do with them.
  const env = createCollectionStoreTestEnv<TeamUser, TeamOperations>(
    { 'users||1': { name: 'Ada' }, 'users||2': { name: 'Grace' } },
    {
      id: 'offline-discard-create-dependents-store',
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: {
          network: network.config,
          classifyRetryableFailure: (error, ctx) =>
            classifyRetryableReplayFailure(error, ctx.phase),
        },
      }),
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: rc_object({
          value: rc_object({
            name: rc_string,
            teamId: rc_string.optionalKey(),
          }),
        }),
        payloadSchema: rc_string,
        offline: {
          operations: {
            createTeam: {
              inputSchema: collectionCreateInputSchema,
              kind: 'create',
              getEntityRefs: ({ input }) => [`temp:${input.name}`],
              tempEntity: {
                buildPendingEntity: (input) => ({
                  value: { name: input.name },
                }),
                reconcileServerEntity: (result) => ({
                  finalPayload: result.id,
                }),
              },
              execute: () => {
                throw new Error('team creation rejected');
              },
            },
            moveUserToTeam: {
              inputSchema: rc_object({ itemId: rc_string, teamId: rc_string }),
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              dependsOn: ({ input }) => [input.teamId],
              execute: async ({ input }) => {
                await env.serverTable.delayedUpdateItem(input.itemId, {
                  teamId: input.teamId,
                });
              },
              onSuccessExecute: () => {},
            },
            patchUserName: {
              inputSchema: userPatchSchema,
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              execute: () => {
                throw new Error('rename rejected');
              },
              onSuccessExecute: () => {},
            },
          },
        },
      },
    },
  );

  const hook = renderHook(() => {
    const ada = env.apiStore.useItem('users||1');
    const grace = env.apiStore.useItem('users||2');

    env.trackItemUI(
      'ada',
      `${ada.data?.value.name} in ${ada.data?.value.teamId ?? 'no team'}`,
    );
    env.trackItemUI('grace', grace.data?.value.name ?? `- ${grace.status}`);
  });
  await flushAllTimers();

  env.addTimelineComments('beforeNextAction', [
    'offline: create a team, move Ada into it and rename Grace',
  ]);
  await act(async () => {
    await env.apiStore.performMutation(null, {
      mutation: () => Promise.reject(new Error('unreachable while offline')),
      offline: { operation: 'createTeam', input: { name: 'Core' } },
    });
    await env.apiStore.performMutation('users||1', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('users||1', (user) => ({
          value: { ...user.value, teamId: 'temp:Core' },
        }));
      },
      mutation: () => Promise.reject(new Error('unreachable while offline')),
      offline: {
        operation: 'moveUserToTeam',
        input: { itemId: 'users||1', teamId: 'temp:Core' },
      },
    });
    await env.apiStore.performMutation('users||2', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('users||2', () => ({
          value: { name: 'Grace renamed' },
        }));
      },
      mutation: () => Promise.reject(new Error('unreachable while offline')),
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||2', name: 'Grace renamed' },
      },
    });
  });

  env.addTimelineComments('beforeNextAction', [
    'back online: the server rejects the team and the rename until they need a resolution, then Ada and Grace are refetched',
  ]);
  act(() => {
    network.goOnline();
  });
  // 3 attempts per change, 5s apart: 30s covers both.
  await advanceTime(30_000);
  await flushAllTimers();

  const teamResolution = env.apiStore
    .getOfflineResolutions()
    .find((resolution) => resolution.operation === 'createTeam');
  if (!teamResolution) {
    throw new Error('Expected the team creation to wait for a resolution');
  }

  // Once the team creation needed a decision, the move of Ada made on top of
  // it waits with it: Ada was refetched and left the team that doesn't exist
  // on the server. Grace's rename needed a decision too and she shows her
  // server name. Discarding the team also discards the move of Ada, without
  // fetching anything.
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(
      teamResolution.id,
      'createTeam',
      { action: 'discard' },
    );
  });
  await flushAllTimers();

  expect(
    env.apiStore
      .getOfflineResolutions()
      .map((resolution) => resolution.operation),
  ).toMatchInlineSnapshot(`['patchUserName']`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ada              | grace         |
    0      | Ada in no team   | Grace         | [ada, grace] ui-initialized
    1.01s  | Ada in no team   | Grace         | -- offline: create a team, move Ada into it and rename Grace
    .      | Ada in no team   | Grace         | offline:createTeam queued
    .      | Ada in temp:Core | Grace         | [ada] ui-changed
    .      | Ada in temp:Core | Grace         | offline:moveUserToTeam queued
    .      | Ada in temp:Core | Grace renamed | [grace] ui-changed
    .      | Ada in temp:Core | Grace renamed | offline:patchUserName queued
    .      | Ada in temp:Core | Grace renamed | -- back online: the server rejects the team and the rename until they need a resolution, then Ada and Grace are refetched
    .      | Ada in temp:Core | Grace renamed | offline:createTeam replay-started
    6.01s  | Ada in temp:Core | Grace renamed | offline:createTeam replay-started
    11.01s | Ada in temp:Core | Grace renamed | offline:createTeam replay-started
    .      | Ada in temp:Core | Grace renamed | offline:createTeam resolution-required
    .      | Ada in temp:Core | Grace renamed | offline:moveUserToTeam resolution-required
    .      | Ada in temp:Core | Grace renamed | offline:patchUserName replay-started
    11.02s | Ada in temp:Core | Grace renamed | 🔴 [users||1] >fetch-started
    11.82s | Ada in temp:Core | Grace renamed | 🔴 [users||1] <fetch-finished (value: {"name":"Ada"})
    .      | Ada in no team   | Grace renamed | [ada] ui-changed
    16.01s | Ada in no team   | Grace renamed | offline:patchUserName replay-started
    21.01s | Ada in no team   | Grace renamed | offline:patchUserName replay-started
    .      | Ada in no team   | Grace renamed | offline:patchUserName resolution-required
    21.02s | Ada in no team   | Grace renamed | 🟠 [users||1] >fetch-started
    .      | Ada in no team   | Grace renamed | 🟡 [users||2] >fetch-started
    21.82s | Ada in no team   | Grace renamed | 🟠 [users||1] <fetch-finished (value: {"name":"Ada"})
    .      | Ada in no team   | Grace renamed | 🟡 [users||2] <fetch-finished (value: {"name":"Grace"})
    .      | Ada in no team   | Grace         | [grace] ui-changed
    "
  `);

  hook.unmount();
});

test('an offline creation that keeps its client-generated id shows the server value once replayed', async () => {
  network.setOffline();
  const sessionKey = 'offline-client-id-create-session';

  type CreateWithClientIdOperations = {
    createUser: CollectionOfflineOperationDefinition<
      { value: { name: string } },
      string,
      { itemId: string; name: string },
      unknown,
      { id: string }
    >;
  };

  // The app generates the item id on the client, so the server keeps it:
  // reconciling the creation does not move the item to another key. The
  // server normalizes the name it receives.
  const env = createCollectionStoreTestEnv<
    { name: string },
    CreateWithClientIdOperations
  >(
    {},
    {
      id: 'offline-client-id-create-store',
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
      }),
      persistentStorage: {
        adapter: 'local-sync',
        schema: collectionSchema,
        payloadSchema: rc_string,
        offline: {
          operations: {
            createUser: {
              inputSchema: userPatchSchema,
              kind: 'create',
              getEntityRefs: ({ input }) => [input.itemId],
              tempEntity: {
                buildPendingEntity: (input) => ({
                  value: { name: input.name },
                }),
                reconcileServerEntity: (_result, tempId) => ({
                  finalPayload: tempId,
                }),
              },
              execute: async ({ input }) => {
                await env.serverTable.delayedSetItem(input.itemId, {
                  name: input.name.trim(),
                });
                return { id: input.itemId };
              },
            },
          },
        },
      },
    },
  );

  // Create the user offline: the screen shows the local value right away.
  await act(async () => {
    await env.apiStore.performMutation(null, {
      mutation: () => Promise.reject(new Error('unreachable while offline')),
      offline: {
        operation: 'createUser',
        input: { itemId: 'users||client-1', name: '  Ada  ' },
      },
    });
  });

  const hook = renderHook(() => {
    const user = env.apiStore.useItem('users||client-1');

    env.trackItemUI('user', `"${user.data?.value.name ?? '-'}"`);
  });
  await flushAllTimers();

  // Back online: the creation is replayed. With nothing left to sync, the
  // store revalidates the now confirmed item, which shows the server value.
  env.addTimelineComments('beforeNextAction', [
    'back online: the creation is replayed and the item revalidated',
  ]);
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | user      |
    0     | -         | offline:createUser queued
    .     | "  Ada  " | [user] ui-initialized
    1s    | "  Ada  " | -- back online: the creation is replayed and the item revalidated
    .     | "  Ada  " | offline:createUser replay-started
    2.2s  | "  Ada  " | [users||client-1] server-data-changed (value: {"name":"Ada"})
    .     | "  Ada  " | offline:createUser replay-finished
    2.21s | "  Ada  " | 🔴 [users||client-1] >fetch-started
    3.01s | "  Ada  " | 🔴 [users||client-1] <fetch-finished (value: {"name":"Ada"})
    .     | "Ada"     | [user] ui-changed
    "
  `);

  hook.unmount();
});

test('a failed offline creation with a client-generated id removes the collection item once it needs a decision', async () => {
  network.setOffline();
  const sessionKey = 'offline-discard-client-id-collection-session';
  const storeName = 'offline-discard-client-id-collection-store';

  type CreateWithClientIdOperations = {
    createUser: CollectionOfflineOperationDefinition<
      { value: { name: string } },
      string,
      { itemId: string; name: string },
      unknown
    >;
  };

  // The app generates the item id on the client, so the creation needs no
  // temp entity. The server rejects it on every replay attempt.
  const env = createCollectionStoreTestEnv<
    { name: string },
    CreateWithClientIdOperations
  >(
    { 'users||1': { name: 'Ada' } },
    {
      id: storeName,
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: {
          network: network.config,
          classifyRetryableFailure: (error, ctx) =>
            classifyRetryableReplayFailure(error, ctx.phase),
        },
      }),
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: collectionSchema,
        payloadSchema: rc_string,
        offline: {
          operations: {
            createUser: {
              inputSchema: userPatchSchema,
              kind: 'create',
              getEntityRefs: ({ input }) => [input.itemId],
              execute: () => {
                throw new Error('creation rejected');
              },
              onSuccessExecute: () => {},
            },
          },
        },
      },
    },
  );

  env.addTimelineComments('beforeNextAction', ['offline: create Linus']);
  await act(async () => {
    await env.apiStore.performMutation('users||3', {
      optimisticUpdate: () => {
        env.apiStore.addItemToState('users||3', { value: { name: 'Linus' } });
      },
      mutation: () => Promise.reject(new Error('unreachable while offline')),
      offline: {
        operation: 'createUser',
        input: { itemId: 'users||3', name: 'Linus' },
      },
    });
  });

  // The user opens the detail screen of Linus.
  const hook = renderHook(() => {
    const linus = env.apiStore.useItem('users||3');

    env.trackItemUI('linus', linus.data?.value.name ?? `- ${linus.status}`);
  });
  await flushAllTimers();

  env.addTimelineComments('beforeNextAction', [
    'back online: the server rejects the creation until it needs a resolution, then Linus is removed',
  ]);
  act(() => {
    network.goOnline();
  });
  await advanceTime(15_000);
  await flushAllTimers();

  const [createResolution] = env.apiStore.getOfflineResolutions();
  if (!createResolution) {
    throw new Error('Expected the creation to wait for a resolution');
  }

  // Once the creation needed a decision, Linus was removed, like the
  // rollback of a temp entity: the creation only lives in its resolution
  // record. He is not fetched: the server never got him. Discarding the
  // creation only drops its record.
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(
      createResolution.id,
      'createUser',
      { action: 'discard' },
    );
  });
  await flushAllTimers();

  // The never-saved item is not readable as loaded data anymore, and its
  // persisted cache entry is gone, so a reload does not restore it.
  expect(env.apiStore.getItemState('users||3')).toMatchInlineSnapshot(`null`);
  expect(
    getLocalStorageKeys().filter((key) =>
      key.startsWith(`tsdf.${sessionKey}.${storeName}.ci.`),
    ),
  ).toMatchInlineSnapshot(
    `- 'tsdf.offline-discard-client-id-collection-session.offline-discard-client-id-collection-store.ci."users||1'`,
  );
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time | linus     |
    0    | -         | -- offline: create Linus
    .    | -         | offline:createUser queued
    .    | Linus     | ui-initialized
    1s   | Linus     | -- back online: the server rejects the creation until it needs a resolution, then Linus is removed
    .    | Linus     | offline:createUser replay-started
    6s   | Linus     | offline:createUser replay-started
    11s  | Linus     | offline:createUser replay-started
    .    | Linus     | offline:createUser resolution-required
    .    | - deleted | ui-changed
    "
  `);

  hook.unmount();
});

test('a failed offline creation with a client-generated id that the user sends again shows the saved item once the server has it', async () => {
  network.setOffline();
  const sessionKey = 'offline-retry-client-id-collection-session';

  type CreateWithClientIdOperations = {
    createUser: CollectionOfflineOperationDefinition<
      { value: { name: string } },
      string,
      { itemId: string; name: string },
      unknown
    >;
  };

  // The app generates the item id on the client, so the creation needs no
  // temp entity. The server rejects it until the user sends it again.
  let rejectCreation = true;
  const env = createCollectionStoreTestEnv<
    { name: string },
    CreateWithClientIdOperations
  >(
    { 'users||1': { name: 'Ada' } },
    {
      id: 'offline-retry-client-id-collection-store',
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: {
          network: network.config,
          classifyRetryableFailure: (error, ctx) =>
            classifyRetryableReplayFailure(error, ctx.phase),
        },
      }),
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: collectionSchema,
        payloadSchema: rc_string,
        offline: {
          operations: {
            createUser: {
              inputSchema: userPatchSchema,
              kind: 'create',
              getEntityRefs: ({ input }) => [input.itemId],
              execute: async ({ input }) => {
                if (rejectCreation) throw new Error('creation rejected');
                await env.serverTable.delayedSetItem(input.itemId, {
                  name: input.name,
                });
              },
              onSuccessExecute: () => {},
            },
          },
        },
      },
    },
  );

  env.addTimelineComments('beforeNextAction', ['offline: create Linus']);
  await act(async () => {
    await env.apiStore.performMutation('users||3', {
      optimisticUpdate: () => {
        env.apiStore.addItemToState('users||3', { value: { name: 'Linus' } });
      },
      mutation: () => Promise.reject(new Error('unreachable while offline')),
      offline: {
        operation: 'createUser',
        input: { itemId: 'users||3', name: 'Linus' },
      },
    });
  });

  // The user opens the detail screen of Linus.
  const hook = renderHook(() => {
    const linus = env.apiStore.useItem('users||3');

    env.trackItemUI('linus', linus.data?.value.name ?? `- ${linus.status}`);
  });
  await flushAllTimers();

  env.addTimelineComments('beforeNextAction', [
    'back online: the server rejects the creation until it needs a decision, then Linus is removed',
  ]);
  act(() => {
    network.goOnline();
  });
  await advanceTime(15_000);
  await flushAllTimers();

  const [createResolution] = env.apiStore.getOfflineResolutions();
  if (!createResolution) {
    throw new Error('Expected the creation to wait for a decision');
  }

  // The server accepts the creation now, and the user sends it again.
  rejectCreation = false;
  env.addTimelineComments('beforeNextAction', [
    'the user sends the creation again',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(
      createResolution.id,
      'createUser',
      { action: 'retry' },
    );
  });
  await flushAllTimers();

  // Removed while the creation waited, Linus is fetched once the server saved
  // him: the screen shows him again instead of staying deleted.
  expect(env.apiStore.getItemState('users||3')).toMatchInlineSnapshot(`
    data:
      value: { name: 'Linus' }

    error: null
    payload: 'users||3'
    refetchOnMount: '❌'
    status: 'success'
    wasLoaded: '✅'
  `);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | linus     |
    0      | -         | -- offline: create Linus
    .      | -         | offline:createUser queued
    .      | Linus     | [linus] ui-initialized
    1s     | Linus     | -- back online: the server rejects the creation until it needs a decision, then Linus is removed
    .      | Linus     | offline:createUser replay-started
    6s     | Linus     | offline:createUser replay-started
    11s    | Linus     | offline:createUser replay-started
    .      | Linus     | offline:createUser resolution-required
    .      | - deleted | [linus] ui-changed
    16s    | - deleted | -- the user sends the creation again
    .      | - deleted | offline:createUser replay-started
    17.2s  | - deleted | [users||3] server-data-changed (value: {"name":"Linus"})
    .      | - deleted | offline:createUser replay-finished
    17.21s | - loading | [linus] ui-changed
    .      | - loading | 🔴 [users||3] >fetch-started
    18.01s | - loading | 🔴 [users||3] <fetch-finished (value: {"name":"Linus"})
    .      | Linus     | [linus] ui-changed
    "
  `);

  hook.unmount();
});

test('an addition made while a queued addition starts replaying is not lost', async () => {
  network.setOffline();

  const sessionKey = 'offline-accumulation-during-replay-session';
  const storeName = 'offline-accumulation-during-replay-store';
  type CounterOperations = {
    setValue: DocumentOfflineOperationDefinition<
      { value: number },
      { input: { value: number } }
    >;
    addToValue: DocumentOfflineOperationDefinition<
      { value: number },
      { input: { value: number } }
    >;
  };
  const env = createDocumentStoreTestEnv<number, CounterOperations>(0, {
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
          setValue: {
            inputSchema: docMutationInputSchema,
            kind: 'update',
            execute: async ({ input }) => {
              await env.serverMock.delayedSetData(input.value, {
                durationMs: 1000,
              });
              return input;
            },
          },
          addToValue: {
            inputSchema: docMutationInputSchema,
            kind: 'update',
            // Additions waiting in the queue are combined into one. Merging
            // is async (e.g. it reads app data first), so the replay can
            // pick the queued addition up while it runs.
            accumulation: {
              mergeInput: async ({ existingInput, incomingInput }) => {
                await sleep(200);
                return { value: existingInput.value + incomingInput.value };
              },
            },
            execute: async ({ input }) => {
              await sleep(1000);
              env.serverMock.setData(env.serverMock.current + input.value);
              return input;
            },
          },
        },
      },
    },
  });

  function addToValue(value: number) {
    return env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value += value;
        });
      },
      mutation: async () => {
        await sleep(1000);
        env.serverMock.setData(env.serverMock.current + value);
        return env.serverMock.current;
      },
      offline: { operation: 'addToValue', input: { value } },
    });
  }

  // Offline: the value is set to 100, then 10 is added.
  await env.apiStore.performMutation({
    optimisticUpdate: () => {
      env.apiStore.updateState((draft) => {
        draft.value = 100;
      });
    },
    mutation: async () => {
      await env.serverMock.delayedSetData(100);
      return 100;
    },
    offline: { operation: 'setValue', input: { value: 100 } },
  });
  await addToValue(10);

  // Back online: the queue replays the set first.
  act(() => {
    network.goOnline();
  });
  await advanceTime(900);

  // Right before the set finishes, the user adds 20. It joins the queue
  // behind the queued addition and starts merging into it, but the replay
  // picks that addition up (and sends it) while the merge runs.
  let lateAddition: ReturnType<typeof addToValue> | undefined;
  act(() => {
    lateAddition = addToValue(20);
  });
  await flushAllTimers();
  expect((await lateAddition)?.ok).toBe(true);

  // Every addition reached the server exactly once: 100 + 10 + 20.
  expect(env.serverMock.current).toBe(130);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
});
