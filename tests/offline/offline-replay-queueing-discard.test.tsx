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
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
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
  summarizeResolution,
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

test('discarding one of two failed offline changes of a document keeps the other one visible until it is handled', async () => {
  const sessionKey = 'offline-discard-document-pending-session';

  // The server rejects every change, so they end up waiting for the user to
  // decide what to do with them.
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

  const updateValueOffline = async (value: number) => {
    await act(async () => {
      await env.apiStore.performMutation({
        optimisticUpdate: () => {
          env.apiStore.updateState((draft) => {
            draft.value = value;
          });
        },
        mutation: () => Promise.reject(new Error('unreachable while offline')),
        offline: { operation: 'updateValue', input: { value } },
      });
    });
  };

  env.addTimelineComments('beforeNextAction', [
    'offline: change the value to 2, then to 3',
  ]);
  await act(async () => {
    network.goOffline();
    await Promise.resolve();
  });
  await updateValueOffline(2);
  await updateValueOffline(3);

  env.addTimelineComments('beforeNextAction', [
    'back online: the server rejects both changes until they need a resolution',
  ]);
  act(() => {
    network.goOnline();
  });
  // 3 attempts per change, 5s apart: 30s covers both.
  await advanceTime(30_000);
  await flushAllTimers();

  const [firstResolution, secondResolution] =
    env.apiStore.getOfflineResolutions();
  if (!firstResolution || !secondResolution) {
    throw new Error('Expected both changes to be waiting for a resolution');
  }
  expect(
    [firstResolution, secondResolution].map(
      (resolution) => summarizeResolution(resolution).input,
    ),
  ).toMatchInlineSnapshot(`['value: 2', 'value: 3']`);

  // Discard the first change. Refetching the document now would replace the
  // second change, which still waits for a decision: the document keeps
  // showing it.
  env.addTimelineComments('beforeNextAction', [
    'discard the change to 2: no refetch, the change to 3 is still shown',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(
      firstResolution.id,
      'updateValue',
      { action: 'discard' },
    );
  });
  await flushAllTimers();

  // Discarding the last change refetches the document: it shows the server
  // value again.
  env.addTimelineComments('beforeNextAction', [
    'discard the change to 3: the document is refetched',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(
      secondResolution.id,
      'updateValue',
      { action: 'discard' },
    );
  });
  await flushAllTimers();

  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ui        |
    0      | "value:1" | ui-initialized
    10ms   | "value:1" | 🔴 >fetch-started
    810ms  | "value:1" | 🔴 <fetch-finished (value: 1)
    1s     | "value:1" | -- offline: change the value to 2, then to 3
    .      | "value:2" | ui-changed
    .      | "value:2" | offline:updateValue queued
    .      | "value:3" | ui-changed
    .      | "value:3" | offline:updateValue queued
    .      | "value:3" | -- back online: the server rejects both changes until they need a resolution
    .      | "value:3" | offline:updateValue replay-started
    6s     | "value:3" | offline:updateValue replay-started
    11s    | "value:3" | offline:updateValue replay-started
    .      | "value:3" | offline:updateValue resolution-required
    .      | "value:3" | offline:updateValue replay-started
    16s    | "value:3" | offline:updateValue replay-started
    21s    | "value:3" | offline:updateValue replay-started
    .      | "value:3" | offline:updateValue resolution-required
    31.01s | "value:3" | -- discard the change to 2: no refetch, the change to 3 is still shown
    .      | "value:3" | -- discard the change to 3: the document is refetched
    .      | "value:3" | 🟠 >fetch-started
    31.81s | "value:3" | 🟠 <fetch-finished (value: 1)
    .      | "value:1" | ui-changed
    "
  `);

  hook.unmount();
});

test('discarding the last failed offline change of a realtime document refetches it once', async () => {
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
    'back online: the server rejects the change until it needs a resolution',
  ]);
  act(() => {
    network.goOnline();
  });
  // 3 attempts, 5s apart.
  await advanceTime(15_000);
  await flushAllTimers();

  const [resolution] = env.apiStore.getOfflineResolutions();
  if (!resolution) {
    throw new Error('Expected the change to be waiting for a resolution');
  }

  // Discarding the last change makes the store recover. A realtime store
  // waits one reconnect cooldown before its recovery revalidation, but the
  // discard already refetches the document right away: that refetch is the
  // recovery revalidation, so the document is not fetched a second time when
  // the cooldown ends.
  env.addTimelineComments('beforeNextAction', [
    'discard the change: the document is refetched once',
  ]);
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
    .      | "value:2" | -- back online: the server rejects the change until it needs a resolution
    .      | "value:2" | offline:updateValue replay-started
    6s     | "value:2" | offline:updateValue replay-started
    11s    | "value:2" | offline:updateValue replay-started
    .      | "value:2" | offline:updateValue resolution-required
    16.01s | "value:2" | -- discard the change: the document is refetched once
    .      | "value:2" | 🔴 >fetch-started
    16.81s | "value:2" | 🔴 <fetch-finished (value: 1)
    .      | "value:1" | ui-changed
    "
  `);

  hook.unmount();
});

test('discarding one of two failed offline changes of a collection item keeps the other one visible until it is handled', async () => {
  network.setOffline();
  const sessionKey = 'offline-discard-collection-pending-session';

  type RejectedRenameOperations = {
    patchUserName: CollectionOfflineOperationDefinition<
      { value: { name: string } },
      string,
      { itemId: string; name: string },
      unknown
    >;
  };

  // The server rejects every rename, so they end up waiting for the user to
  // decide what to do with them.
  const env = createCollectionStoreTestEnv<
    { name: string },
    RejectedRenameOperations
  >(
    { 'users||1': { name: 'Ada' } },
    {
      id: 'offline-discard-collection-pending-store',
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
          },
        },
      },
    },
  );

  const hook = renderHook(() => {
    const ada = env.apiStore.useItem('users||1');
    env.trackItemUI('ada', ada.data?.value.name ?? `- ${ada.status}`);
  });
  await advanceTime(1_000);

  const renameAdaOffline = async (name: string) => {
    await act(async () => {
      await env.apiStore.performMutation('users||1', {
        optimisticUpdate: () => {
          env.apiStore.updateItemState('users||1', () => ({ value: { name } }));
        },
        mutation: () => Promise.reject(new Error('unreachable while offline')),
        offline: {
          operation: 'patchUserName',
          input: { itemId: 'users||1', name },
        },
      });
    });
  };

  env.addTimelineComments('beforeNextAction', ['offline: rename Ada twice']);
  await renameAdaOffline('Ada renamed');
  await renameAdaOffline('Ada renamed again');

  env.addTimelineComments('beforeNextAction', [
    'back online: the server rejects both renames until they need a resolution',
  ]);
  act(() => {
    network.goOnline();
  });
  // 3 attempts per rename, 5s apart: 30s covers both.
  await advanceTime(30_000);
  await flushAllTimers();

  const [firstRename, secondRename] = env.apiStore.getOfflineResolutions();
  if (!firstRename || !secondRename) {
    throw new Error('Expected both renames to be waiting for a resolution');
  }

  // Discard the first rename. Refetching Ada now would replace the second
  // rename, which still waits for a decision: she keeps showing it.
  env.addTimelineComments('beforeNextAction', [
    'discard the first rename: no refetch, the second rename is still shown',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(
      firstRename.id,
      'patchUserName',
      { action: 'discard' },
    );
  });
  await flushAllTimers();

  // Discarding the last rename refetches Ada: she shows the server name.
  env.addTimelineComments('beforeNextAction', [
    'discard the second rename: Ada is refetched',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(
      secondRename.id,
      'patchUserName',
      { action: 'discard' },
    );
  });
  await flushAllTimers();

  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ada               |
    0      | Ada               | [ada] ui-initialized
    1s     | Ada               | -- offline: rename Ada twice
    .      | Ada renamed       | [ada] ui-changed
    .      | Ada renamed       | offline:patchUserName queued
    .      | Ada renamed again | [ada] ui-changed
    .      | Ada renamed again | offline:patchUserName queued
    .      | Ada renamed again | -- back online: the server rejects both renames until they need a resolution
    .      | Ada renamed again | offline:patchUserName replay-started
    6s     | Ada renamed again | offline:patchUserName replay-started
    11s    | Ada renamed again | offline:patchUserName replay-started
    .      | Ada renamed again | offline:patchUserName resolution-required
    .      | Ada renamed again | offline:patchUserName replay-started
    16s    | Ada renamed again | offline:patchUserName replay-started
    21s    | Ada renamed again | offline:patchUserName replay-started
    .      | Ada renamed again | offline:patchUserName resolution-required
    31.01s | Ada renamed again | -- discard the first rename: no refetch, the second rename is still shown
    .      | Ada renamed again | -- discard the second rename: Ada is refetched
    .      | Ada renamed again | 🔴 [users||1] >fetch-started
    31.81s | Ada renamed again | 🔴 [users||1] <fetch-finished (value: {"name":"Ada"})
    .      | Ada               | [ada] ui-changed
    "
  `);

  hook.unmount();
});

test('discarding failed offline changes of collection items puts those items back to the server values', async () => {
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
    'back online: the server rejects both changes until they need a resolution',
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

  // Discard only Grace's delete. The delete removed her item locally, so
  // there is nothing left in the store to invalidate: the store fetches her
  // item again and she shows up with the server value. Ada's rename is still
  // waiting for a decision, so her item is untouched.
  env.addTimelineComments('beforeNextAction', [
    'discard the delete of Grace: only Grace is refetched',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(
      deleteResolution.id,
      'deleteUser',
      { action: 'discard' },
    );
  });
  await flushAllTimers();

  // Discard the rename: Ada is refetched and shows the server name.
  env.addTimelineComments('beforeNextAction', [
    'discard the rename of Ada: Ada is refetched',
  ]);
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
    .      | Ada renamed | - deleted | -- back online: the server rejects both changes until they need a resolution
    .      | Ada renamed | - deleted | offline:patchUserName replay-started
    6.01s  | Ada renamed | - deleted | offline:patchUserName replay-started
    11.01s | Ada renamed | - deleted | offline:patchUserName replay-started
    .      | Ada renamed | - deleted | offline:patchUserName resolution-required
    .      | Ada renamed | - deleted | offline:deleteUser replay-started
    16.01s | Ada renamed | - deleted | offline:deleteUser replay-started
    21.01s | Ada renamed | - deleted | offline:deleteUser replay-started
    .      | Ada renamed | - deleted | offline:deleteUser resolution-required
    31.02s | Ada renamed | - deleted | -- discard the delete of Grace: only Grace is refetched
    .      | Ada renamed | - loading | [grace] ui-changed
    .      | Ada renamed | - loading | 🔴 [users||2] >fetch-started
    31.82s | Ada renamed | - loading | 🔴 [users||2] <fetch-finished (value: {"name":"Grace"})
    .      | Ada renamed | Grace     | [grace] ui-changed
    32.83s | Ada renamed | Grace     | -- discard the rename of Ada: Ada is refetched
    .      | Ada renamed | Grace     | 🟠 [users||1] >fetch-started
    .      | Ada renamed | Grace     | 🟡 [users||2] >fetch-started
    33.63s | Ada renamed | Grace     | 🟠 [users||1] <fetch-finished (value: {"name":"Ada"})
    .      | Ada         | Grace     | [ada] ui-changed
    .      | Ada         | Grace     | 🟡 [users||2] <fetch-finished (value: {"name":"Grace"})
    "
  `);

  hook.unmount();
});

test('discarding a failed offline creation puts existing items changed on top of it back to the server values', async () => {
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
    'back online: the server rejects the team and the rename until they need a resolution',
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

  // Discarding the team also discards the move of Ada, which was made on top
  // of it: Ada is refetched and leaves the team that never existed. Grace's
  // rename is still waiting for a decision, so her item is untouched.
  env.addTimelineComments('beforeNextAction', [
    'discard the team creation: the move of Ada is discarded with it',
  ]);
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
    .      | Ada in temp:Core | Grace renamed | -- back online: the server rejects the team and the rename until they need a resolution
    .      | Ada in temp:Core | Grace renamed | offline:createTeam replay-started
    6.01s  | Ada in temp:Core | Grace renamed | offline:createTeam replay-started
    11.01s | Ada in temp:Core | Grace renamed | offline:createTeam replay-started
    .      | Ada in temp:Core | Grace renamed | offline:createTeam resolution-required
    .      | Ada in temp:Core | Grace renamed | offline:moveUserToTeam resolution-required
    .      | Ada in temp:Core | Grace renamed | offline:patchUserName replay-started
    16.01s | Ada in temp:Core | Grace renamed | offline:patchUserName replay-started
    21.01s | Ada in temp:Core | Grace renamed | offline:patchUserName replay-started
    .      | Ada in temp:Core | Grace renamed | offline:patchUserName resolution-required
    31.02s | Ada in temp:Core | Grace renamed | -- discard the team creation: the move of Ada is discarded with it
    .      | Ada in temp:Core | Grace renamed | 🔴 [users||1] >fetch-started
    31.82s | Ada in temp:Core | Grace renamed | 🔴 [users||1] <fetch-finished (value: {"name":"Ada"})
    .      | Ada in no team   | Grace renamed | [ada] ui-changed
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
    1.01s | "  Ada  " | -- back online: the creation is replayed and the item revalidated
    .     | "  Ada  " | offline:createUser replay-started
    2.21s | "  Ada  " | [users||client-1] server-data-changed (value: {"name":"Ada"})
    .     | "  Ada  " | offline:createUser replay-finished
    2.22s | "  Ada  " | 🔴 [users||client-1] >fetch-started
    3.02s | "  Ada  " | 🔴 [users||client-1] <fetch-finished (value: {"name":"Ada"})
    .     | "Ada"     | [user] ui-changed
    "
  `);

  hook.unmount();
});

test('discarding a failed offline creation with a client-generated id removes the collection item', async () => {
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
    'back online: the server rejects the creation until it needs a resolution',
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

  // Discarding the creation removes Linus, like the rollback of a temp
  // entity. He is not fetched: the server never got him.
  env.addTimelineComments('beforeNextAction', [
    'discard the creation: Linus is removed',
  ]);
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
    time   | linus     |
    0      | -         | -- offline: create Linus
    .      | -         | offline:createUser queued
    .      | Linus     | ui-initialized
    1.01s  | Linus     | -- back online: the server rejects the creation until it needs a resolution
    .      | Linus     | offline:createUser replay-started
    6.01s  | Linus     | offline:createUser replay-started
    11.01s | Linus     | offline:createUser replay-started
    .      | Linus     | offline:createUser resolution-required
    16.01s | Linus     | -- discard the creation: Linus is removed
    .      | - deleted | ui-changed
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
