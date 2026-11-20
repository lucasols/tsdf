import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_array, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { PartialResourcesConfig } from '../../src/listQueryStore/types';
import type {
  ListQueryOfflineOperationDefinition,
  OfflineSessionConfig,
  OfflineTempEntityPendingEntry,
} from '../../src/main';
import { opfsPersistentStorage } from '../../src/persistentStorage/storageAdapter';
import { createStoreManager } from '../../src/storeManager';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
  type ListQueryStoreTestScenario,
} from '../mocks/listQueryStoreTestEnv';
import { normalizeError, TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import {
  advanceTime,
  flushAllTimers,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { createOpfsPersistentStorageTestStore } from '../utils/opfsPersistentStorageTestStore';
import { resetSessionForTests } from '../utils/resetSessionForTests';
import {
  type CreateListQueryUserOperations,
  userRowSchema,
} from './offlineReplayTestShared';
import {
  classifyRetryableReplayFailure,
  collectionCreateInputSchema,
  listQueryQueryPayloadSchema,
} from './offlineTestShared';

let network = createOfflineNetworkMock();

type CreateUserTempEntity = NonNullable<
  CreateListQueryUserOperations['createUser']['tempEntity']
>;

const usersQuery: ListQueryParams = { tableId: 'users' };
const usersStartingWithAQuery: ListQueryParams = {
  tableId: 'users',
  filters: [{ op: 'startsWith', field: 'name', value: 'A' }],
};
type UserRow = { id: number; name: string };

const initialUsers: { users: UserRow[] } = {
  users: [
    { id: 1, name: 'Ada' },
    { id: 2, name: 'Grace' },
  ],
};

// Mirrors the `inferFields` recommended in the docs: it reports the fields
// present in the snapshot, so it can never tell that a row is complete ('*').
const partialResourcesConfig: PartialResourcesConfig<UserRow> = {
  mergeItems: (prev, fetched) => {
    if (!prev) return fetched;
    return { ...prev, ...fetched };
  },
  selectFields: (fields, item) => {
    const result: Record<string, unknown> = {};

    for (const field of fields) {
      if (field in item) {
        result[field] = item[__LEGIT_CAST__<keyof UserRow, string>(field)];
      }
    }

    return __LEGIT_CAST__<UserRow, Record<string, unknown>>(result);
  },
  inferFields: (item) => Object.keys(item),
};

/**
 * Users list store whose `createUser` offline operation declares the lists
 * (and optionally the loaded fields) of the row it creates, so the tests never
 * insert the temp row by hand.
 */
function createUsersEnv<TPartialResources extends boolean = false>({
  sessionKey,
  storeName,
  testScenario,
  addToQueries,
  loadedFields,
  partialResources,
  offlineSession,
  nextUserIdRef = { current: 3 },
  createUserDurationMs,
  failCreateUser = false,
  storageAdapter = 'local-sync',
  keepPendingData = false,
}: {
  sessionKey: string;
  storeName: string;
  testScenario: ListQueryStoreTestScenario;
  addToQueries: CreateUserTempEntity['addToQueries'];
  loadedFields?: CreateUserTempEntity['loadedFields'];
  partialResources?: PartialResourcesConfig<UserRow>;
  offlineSession?: Partial<OfflineSessionConfig>;
  nextUserIdRef?: { current: number };
  createUserDurationMs?: number;
  failCreateUser?: boolean;
  storageAdapter?: 'local-sync' | typeof opfsPersistentStorage;
  /** The saved row keeps the pending row's data instead of the server's. */
  keepPendingData?: boolean;
}) {
  const env = createListQueryStoreTestEnv<
    UserRow,
    TPartialResources,
    false,
    CreateListQueryUserOperations
  >(initialUsers, {
    id: storeName,
    getSessionKey: () => sessionKey,
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: { network: network.config, ...offlineSession },
    }),
    testScenario,
    partialResources,
    persistentStorage: {
      adapter: storageAdapter,
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
              addToQueries,
              loadedFields,
              reconcileServerEntity: (result) =>
                keepPendingData
                  ? { finalPayload: `users||${result.id}` }
                  : { finalPayload: `users||${result.id}`, finalData: result },
            },
            execute: async ({ input }) => {
              if (failCreateUser) throw new Error('create replay failed');

              const data = { id: nextUserIdRef.current, name: input.name };
              nextUserIdRef.current += 1;
              await env.serverTable.delayedSetItem(`users||${data.id}`, data, {
                durationMs: createUserDurationMs,
              });
              return data;
            },
          },
        },
      },
    },
  });

  /**
   * Creates a user the way an app would with the new option: no
   * `optimisticUpdate` and no manual `addItemToState`.
   */
  async function createUser(name: string) {
    await act(async () => {
      await env.apiStore.performMutation(`temp:${name}`, {
        mutation: async () => {
          const data = { id: nextUserIdRef.current, name };
          nextUserIdRef.current += 1;
          await env.serverTable.delayedSetItem(`users||${data.id}`, data);
          return data;
        },
        offline: { operation: 'createUser', input: { name } },
      });
    });
  }

  return { env, createUser };
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

type CreateManyListQueryUserOperations = {
  createUsers: ListQueryOfflineOperationDefinition<
    UserRow,
    ListQueryParams,
    string,
    { name: string }[],
    unknown,
    UserRow[]
  >;
};

describe('temp entities declared in list queries', () => {
  test('rows created offline show up in their declared lists without a manual insert and keep their place once saved', async () => {
    network.setOffline();
    const { env, createUser } = createUsersEnv({
      sessionKey: 'temp-queries-declared-session',
      storeName: 'temp-queries-declared-store',
      testScenario: {
        loaded: { queries: [usersQuery, usersStartingWithAQuery] },
      },
      // The lists depend on the input: every new user goes to the top of the
      // full list, and only names starting with "A" join the filtered list.
      addToQueries: (input) => ({
        queries: input.name.startsWith('A')
          ? [usersQuery, usersStartingWithAQuery]
          : [usersQuery],
        appendTo: 'start',
      }),
    });

    const hook = renderHook(() => {
      const allUsers = env.apiStore.useListQuery(usersQuery, {
        itemSelector: (item) => item.name,
      });
      const usersStartingWithA = env.apiStore.useListQuery(
        usersStartingWithAQuery,
        { itemSelector: (item) => item.name },
      );

      env.trackItemUI('all-users', allUsers.items.join(', '));
      env.trackItemUI('a-users', usersStartingWithA.items.join(', '));
      return { allUsers, usersStartingWithA };
    });
    await flushAllTimers();

    env.addTimelineComments('beforeNextAction', [
      'create "Linus" offline — declared only for the full list',
    ]);
    await createUser('Linus');

    env.addTimelineComments('beforeNextAction', [
      'create "Alan" offline — declared for both lists',
    ]);
    await createUser('Alan');

    // Both rows are visible right away, each only in the lists it declared.
    expect({
      allUsers: hook.result.current.allUsers.items,
      usersStartingWithA: hook.result.current.usersStartingWithA.items,
    }).toMatchInlineSnapshot(`
      allUsers: ['Alan', 'Linus', 'Ada', 'Grace']
      usersStartingWithA: ['Alan', 'Ada']
    `);

    env.addTimelineComments('beforeNextAction', [
      'go online — each temp row must be swapped for its saved row in place',
    ]);
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    // The saved rows replaced the temp ones under their server ids.
    expect({
      'users||3': env.apiStore.getItemState('users||3'),
      'users||4': env.apiStore.getItemState('users||4'),
      'temp:Linus': env.apiStore.getItemState('temp:Linus'),
      'temp:Alan': env.apiStore.getItemState('temp:Alan'),
    }).toMatchInlineSnapshot(`
      temp:Alan: null
      temp:Linus: null
      users||3: { id: 3, name: 'Linus' }
      users||4: { id: 4, name: 'Alan' }
    `);
    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
    // The rows never leave the lists: they keep the declared position while
    // the creates are replayed, and only the revalidation that follows the
    // replay moves them to the order the server returns.
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time   | a-users   | all-users               |
      0      | Ada       | Ada, Grace              | [all-users, a-users] ui-initialized
      12s    | Ada       | Ada, Grace              | -- create "Linus" offline — declared only for the full list
      .      | Ada       | Linus, Ada, Grace       | [all-users] ui-changed
      .      | Ada       | Linus, Ada, Grace       | offline:createUser queued
      .      | Ada       | Linus, Ada, Grace       | -- create "Alan" offline — declared for both lists
      .      | Alan, Ada | Alan, Linus, Ada, Grace | [all-users, a-users] ui-changed
      .      | Alan, Ada | Alan, Linus, Ada, Grace | offline:createUser queued
      .      | Alan, Ada | Alan, Linus, Ada, Grace | -- go online — each temp row must be swapped for its saved row in place
      .      | Alan, Ada | Alan, Linus, Ada, Grace | offline:createUser replay-started
      13.2s  | Alan, Ada | Alan, Linus, Ada, Grace | [users||3] server-data-changed (value: {"id":3,"name":"Linus"})
      .      | Alan, Ada | Alan, Linus, Ada, Grace | offline:createUser replay-finished
      .      | Alan, Ada | Alan, Linus, Ada, Grace | [all-users, all-users] ui-changed
      .      | Alan, Ada | Alan, Linus, Ada, Grace | offline:createUser replay-started
      14.4s  | Alan, Ada | Alan, Linus, Ada, Grace | [users||4] server-data-changed (value: {"id":4,"name":"Alan"})
      .      | Alan, Ada | Alan, Linus, Ada, Grace | offline:createUser replay-finished
      .      | Alan, Ada | Alan, Linus, Ada, Grace | [all-users, a-users, all-users, a-users] ui-changed
      14.41s | Alan, Ada | Alan, Linus, Ada, Grace | 🔴 >list-fetch-started
      .      | Alan, Ada | Alan, Linus, Ada, Grace | 🟠 >list-fetch-started
      15.21s | Alan, Ada | Alan, Linus, Ada, Grace | 🔴 <list-fetch-finished (value: {"count":4})
      .      | Alan, Ada | Ada, Grace, Linus, Alan | [all-users] ui-changed
      .      | Alan, Ada | Ada, Grace, Linus, Alan | 🟠 <list-fetch-finished (value: {"count":2})
      .      | Ada, Alan | Ada, Grace, Linus, Alan | [a-users] ui-changed
      "
    `);

    hook.unmount();
  });

  test('a batch create declares the lists of each row it creates', async () => {
    network.setOffline();
    const sessionKey = 'temp-queries-batch-session';
    let nextUserId = 3;

    const env = createListQueryStoreTestEnv<
      UserRow,
      false,
      false,
      CreateManyListQueryUserOperations
    >(initialUsers, {
      id: 'temp-queries-batch-store',
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
      }),
      testScenario: {
        loaded: { queries: [usersQuery, usersStartingWithAQuery] },
      },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: {
          operations: {
            createUsers: {
              inputSchema: rc_array(rc_object({ name: rc_string })),
              kind: 'create',
              getEntityRefs: ({ input }) =>
                input.map((item) => `temp:${item.name}`),
              tempEntities: {
                // Each pending entry declares its own lists.
                buildPendingEntities: (input) =>
                  input.map((item) => ({
                    tempId: `temp:${item.name}`,
                    pendingEntity: { id: -1, name: item.name },
                    addToQueries: {
                      queries: item.name.startsWith('A')
                        ? [usersQuery, usersStartingWithAQuery]
                        : [usersQuery],
                      appendTo: 'end',
                    },
                  })),
                reconcileServerEntities: (result) =>
                  result.map((item) => ({
                    tempId: `temp:${item.name}`,
                    finalPayload: `users||${item.id}`,
                    finalData: item,
                  })),
              },
              execute: async ({ input }) => {
                const results = input.map((item) => {
                  const result = { id: nextUserId, name: item.name };
                  nextUserId += 1;
                  return result;
                });
                for (const result of results) {
                  await env.serverTable.delayedSetItem(
                    `users||${result.id}`,
                    result,
                  );
                }
                return results;
              },
            },
          },
        },
      },
    });

    const hook = renderHook(() => {
      const allUsers = env.apiStore.useListQuery(usersQuery, {
        itemSelector: (item) => item.name,
      });
      const usersStartingWithA = env.apiStore.useListQuery(
        usersStartingWithAQuery,
        { itemSelector: (item) => item.name },
      );

      env.trackItemUI('all-users', allUsers.items.join(', '));
      env.trackItemUI('a-users', usersStartingWithA.items.join(', '));
      return { allUsers, usersStartingWithA };
    });
    await flushAllTimers();

    env.addTimelineComments('beforeNextAction', [
      'create "Linus" and "Alan" offline in one batch, with no manual insert',
    ]);
    await act(async () => {
      await env.apiStore.performMutation(['temp:Linus', 'temp:Alan'], {
        mutation: async () => {
          const results = [
            { id: 3, name: 'Linus' },
            { id: 4, name: 'Alan' },
          ];
          for (const result of results) {
            await env.serverTable.delayedSetItem(`users||${result.id}`, result);
          }
          return results;
        },
        offline: {
          operation: 'createUsers',
          input: [{ name: 'Linus' }, { name: 'Alan' }],
        },
      });
    });

    // Each row of the batch only joined the lists its own entry declared.
    expect({
      allUsers: hook.result.current.allUsers.items,
      usersStartingWithA: hook.result.current.usersStartingWithA.items,
    }).toMatchInlineSnapshot(`
      allUsers: ['Ada', 'Grace', 'Linus', 'Alan']
      usersStartingWithA: ['Ada', 'Alan']
    `);

    env.addTimelineComments('beforeNextAction', [
      'go online — both temp rows are swapped for their saved rows in place',
    ]);
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
    // "Alan" is the only new row of the filtered list, and both rows stay
    // visible from the moment they are queued.
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time   | a-users   | all-users               |
      0      | Ada       | Ada, Grace              | [all-users, a-users] ui-initialized
      12s    | Ada       | Ada, Grace              | -- create "Linus" and "Alan" offline in one batch, with no manual insert
      .      | Ada, Alan | Ada, Grace, Linus, Alan | [all-users, a-users] ui-changed
      .      | Ada, Alan | Ada, Grace, Linus, Alan | offline:createUsers queued
      .      | Ada, Alan | Ada, Grace, Linus, Alan | -- go online — both temp rows are swapped for their saved rows in place
      .      | Ada, Alan | Ada, Grace, Linus, Alan | offline:createUsers replay-started
      13.2s  | Ada, Alan | Ada, Grace, Linus, Alan | [users||3] server-data-changed (value: {"id":3,"name":"Linus"})
      14.4s  | Ada, Alan | Ada, Grace, Linus, Alan | [users||4] server-data-changed (value: {"id":4,"name":"Alan"})
      .      | Ada, Alan | Ada, Grace, Linus, Alan | offline:createUsers replay-finished
      .      | Ada, Alan | Ada, Grace, Linus, Alan | [all-users, all-users, a-users, all-users, a-users] ui-changed
      14.41s | Ada, Alan | Ada, Grace, Linus, Alan | 🔴 >list-fetch-started
      .      | Ada, Alan | Ada, Grace, Linus, Alan | 🟠 >list-fetch-started
      15.21s | Ada, Alan | Ada, Grace, Linus, Alan | 🔴 <list-fetch-finished (value: {"count":4})
      .      | Ada, Alan | Ada, Grace, Linus, Alan | 🟠 <list-fetch-finished (value: {"count":2})
      "
    `);

    hook.unmount();
  });

  test('a declared row is still in its list after the app restarts offline, and is saved in place when back online', async () => {
    const sessionKey = 'temp-queries-restart-session';
    const storeName = 'temp-queries-restart-store';
    const nextUserIdRef = { current: 3 };
    network.setOffline();

    const first = createUsersEnv({
      sessionKey,
      storeName,
      testScenario: { loaded: { queries: [usersQuery] } },
      addToQueries: { queries: [usersQuery], appendTo: 'start' },
      nextUserIdRef,
    });

    const firstHook = renderHook(() =>
      first.env.apiStore.useListQuery(usersQuery, {
        itemSelector: (item) => item.name,
      }),
    );
    await flushAllTimers();

    await first.createUser('Linus');
    await flushAllTimers();

    expect(firstHook.result.current.items).toMatchInlineSnapshot(`
      ['Linus', 'Ada', 'Grace']
    `);
    firstHook.unmount();

    // Restart the app while the create is still queued and the browser is
    // still offline: nothing in memory survives, only persistent storage.
    resetSessionForTests();

    const restarted = createUsersEnv({
      sessionKey,
      storeName,
      testScenario: 'idle',
      addToQueries: { queries: [usersQuery], appendTo: 'start' },
      nextUserIdRef,
    });

    restarted.env.addTimelineComments('beforeNextAction', [
      'restart the app offline — the queued row must still be at the top of its list',
    ]);
    const hook = renderHook(() => {
      const query = restarted.env.apiStore.useListQuery(usersQuery, {
        itemSelector: (item) => item.name,
      });
      restarted.env.trackItemUI('query-status', query.status);
      restarted.env.trackItemUI('query-items', query.items.join(', '));
      restarted.env.trackItemUI('pending', query.pendingSync ? 'yes' : 'no');
      return query;
    });
    await flushAllTimers();

    // The create is still queued after the restart.
    expect(
      restarted.env.apiStore
        .getOfflineEntities()
        .map((entity) => ({
          entityKey: entity.entityKey,
          kind: entity.kind,
          syncState: entity.syncState,
        })),
    ).toMatchInlineSnapshot(`
      - entityKey: '"temp:Linus'
        kind: 'create'
        syncState: 'pending'
    `);

    restarted.env.addTimelineComments('beforeNextAction', [
      'go online — the restored row is swapped for the saved row in place',
    ]);
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    expect(restarted.env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(
      `[]`,
    );
    // The row is created on the server exactly once, and the list is only
    // refetched by the revalidation that follows the replay.
    expect(
      restarted.env.serverTable.getRequestHistory('all', {
        includeTime: false,
      }),
    ).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 50, offset: 0 }
        returned_items: 3
    `);
    expect(restarted.env.timelineString).toMatchInlineSnapshot(`
      "
      time   | pending | query-items       | query-status |
      0      | -       | -                 | -            | -- restart the app offline — the queued row must still be at the top of its list
      .      | yes     | Linus, Ada, Grace | success      | [query-status, query-items, pending, pending] ui-initialized
      12s    | yes     | Linus, Ada, Grace | success      | -- go online — the restored row is swapped for the saved row in place
      .      | yes     | Linus, Ada, Grace | success      | offline:createUser replay-started
      13.2s  | yes     | Linus, Ada, Grace | success      | [users||3] server-data-changed (value: {"id":3,"name":"Linus"})
      .      | yes     | Linus, Ada, Grace | success      | offline:createUser replay-finished
      .      | no      | Linus, Ada, Grace | success      | [pending] ui-changed
      13.21s | no      | Linus, Ada, Grace | success      | 🔴 >list-fetch-started
      14.01s | no      | Linus, Ada, Grace | success      | 🔴 <list-fetch-finished (value: {"count":3})
      .      | no      | Ada, Grace, Linus | success      | [query-items] ui-changed
      "
    `);

    hook.unmount();
  });

  test.each([
    ['local storage', 'local-sync'],
    ['async storage', opfsPersistentStorage],
  ] as const)(
    'a row created offline before its list is opened after a restart shows up in the list (%s)',
    async (_, storageAdapter) => {
      if (storageAdapter !== 'local-sync') {
        createOpfsPersistentStorageTestStore();
      }
      const envOptions = {
        sessionKey: 'temp-queries-unloaded-list-session',
        storeName: 'temp-queries-unloaded-list-store',
        testScenario: 'idle',
        addToQueries: { queries: usersQuery, appendTo: 'start' },
        storageAdapter,
      } as const;

      // The user sees the list online once, so it is saved to storage.
      const first = createUsersEnv(envOptions);
      const firstHook = renderHook(() =>
        first.env.apiStore.useListQuery(usersQuery, {
          itemSelector: (item) => item.name,
        }),
      );
      await flushAllTimers();
      expect(firstHook.result.current.items).toMatchInlineSnapshot(`
        ['Ada', 'Grace']
      `);
      firstHook.unmount();
      first.env.apiStore.dispose();

      // The app restarts offline on a form screen: the saved list is not read
      // from storage yet when the user creates a row.
      network.setOffline();
      resetSessionForTests();
      const restarted = createUsersEnv(envOptions);
      await flushAllTimers();
      await act(async () => {
        await resolveAfterAllTimers(
          restarted.env.apiStore.performMutation('temp:Linus', {
            mutation: () => Promise.resolve({ id: 3, name: 'Linus' }),
            offline: { operation: 'createUser', input: { name: 'Linus' } },
          }),
        );
      });
      await flushAllTimers();

      // Going to the list shows the row created offline at its declared
      // position, instead of a list without it until the next online fetch.
      const hook = renderHook(() =>
        restarted.env.apiStore.useListQuery(usersQuery, {
          itemSelector: (item) => item.name,
        }),
      );
      await flushAllTimers();
      expect({
        items: hook.result.current.items,
        pendingSync: hook.result.current.pendingSync,
      }).toMatchInlineSnapshot(`
        items: ['Linus', 'Ada', 'Grace']
        pendingSync: '✅'
      `);

      hook.unmount();
    },
  );

  test.each([
    ['local storage', 'local-sync'],
    ['async storage', opfsPersistentStorage],
  ] as const)(
    'a row saved while its list is not open after a restart is in the list when it is opened offline (%s)',
    async (_, storageAdapter) => {
      if (storageAdapter !== 'local-sync') {
        createOpfsPersistentStorageTestStore();
      }
      const envOptions = {
        sessionKey: 'temp-queries-unloaded-list-replay-session',
        storeName: 'temp-queries-unloaded-list-replay-store',
        testScenario: 'idle',
        addToQueries: { queries: usersQuery, appendTo: 'start' },
        storageAdapter,
        nextUserIdRef: { current: 3 },
      } as const;

      // The user opens the list online, then creates a row offline: it is
      // queued and shown at the top of the list.
      const first = createUsersEnv(envOptions);
      const firstHook = renderHook(() =>
        first.env.apiStore.useListQuery(usersQuery, {
          itemSelector: (item) => item.name,
        }),
      );
      await flushAllTimers();
      act(() => {
        network.setOffline();
      });
      await act(async () => {
        await resolveAfterAllTimers(
          first.env.apiStore.performMutation('temp:Linus', {
            mutation: () => Promise.resolve({ id: 3, name: 'Linus' }),
            offline: { operation: 'createUser', input: { name: 'Linus' } },
          }),
        );
      });
      await flushAllTimers();
      expect(firstHook.result.current.items).toMatchInlineSnapshot(`
        ['Linus', 'Ada', 'Grace']
      `);
      firstHook.unmount();
      first.env.apiStore.dispose();

      // The app restarts on another screen and goes online: the create is
      // saved while the list is still only in storage.
      resetSessionForTests();
      const restarted = createUsersEnv(envOptions);
      await flushAllTimers();
      act(() => {
        network.goOnline();
      });
      await flushAllTimers();
      expect(restarted.env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(
        `[]`,
      );

      // Back offline, the user opens the list: the saved row took the place of
      // the pending one, instead of missing until the next online fetch.
      act(() => {
        network.goOffline();
      });
      await flushAllTimers();
      const hook = renderHook(() =>
        restarted.env.apiStore.useListQuery(usersQuery, {
          itemSelector: (item) => item.name,
        }),
      );
      await flushAllTimers();
      expect(hook.result.current.items).toMatchInlineSnapshot(`
        ['Linus', 'Ada', 'Grace']
      `);

      hook.unmount();
    },
  );

  test('a declared row keeps its position while its create is pending, even if the list is refetched in the meantime', async () => {
    network.setOffline();
    const { env, createUser } = createUsersEnv({
      sessionKey: 'temp-queries-stale-refetch-session',
      storeName: 'temp-queries-stale-refetch-store',
      testScenario: { loaded: { queries: [usersQuery] } },
      // Insert between the two server rows so a lost position is noticeable.
      addToQueries: { queries: [usersQuery], appendTo: () => 1 },
      // Slower than a list fetch: the refetch below resolves without the row.
      createUserDurationMs: 2000,
    });

    const hook = renderHook(() => {
      const query = env.apiStore.useListQuery(usersQuery, {
        itemSelector: (item) => item.name,
      });
      env.trackItemUI('query-items', query.items.join(', '));
      env.trackItemUI('pending', query.pendingSync ? 'yes' : 'no');
      return query;
    });
    await flushAllTimers();

    env.addTimelineComments('beforeNextAction', [
      'create "Linus" offline in the middle of the list',
    ]);
    await createUser('Linus');

    env.addTimelineComments('beforeNextAction', [
      'reconnect and refetch the list while the create is still being saved',
    ]);
    act(() => {
      network.goOnline();
      env.scheduleFetch('highPriority', usersQuery);
    });
    // Enough for the list refetch (800ms) but not for the create (2s).
    await advanceTime(810);

    // The server answered with only its two rows, but the pending row is
    // still rendered in the declared position.
    expect(hook.result.current.items).toMatchInlineSnapshot(`
      ['Ada', 'Linus', 'Grace']
    `);

    env.addTimelineComments('beforeNextAction', [
      'the create is saved — the list shows what the server last returned until it revalidates',
    ]);
    await flushAllTimers();

    // The revalidation that follows the replay brings the saved row back, in
    // the order the server returns.
    expect(hook.result.current.items).toMatchInlineSnapshot(`
      ['Ada', 'Grace', 'Linus']
    `);
    // Same behavior as a temp row inserted by hand: while pending, the row is
    // kept in place over the refetched list. The refetch already dropped it
    // from the stored list, so once the create is saved the row is missing
    // until the revalidation finishes (14s → 14.81s below).
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time   | pending | query-items       |
      0      | no      | Ada, Grace        | [query-items, pending] ui-initialized
      12s    | no      | Ada, Grace        | -- create "Linus" offline in the middle of the list
      .      | yes     | Ada, Linus, Grace | [query-items, pending] ui-changed
      .      | yes     | Ada, Linus, Grace | offline:createUser queued
      .      | yes     | Ada, Linus, Grace | -- reconnect and refetch the list while the create is still being saved
      .      | yes     | Ada, Linus, Grace | scheduled-fetch-triggered
      .      | yes     | Ada, Linus, Grace | offline:createUser replay-started
      12.01s | yes     | Ada, Linus, Grace | 🔴 >list-fetch-started
      12.81s | yes     | Ada, Linus, Grace | 🔴 <list-fetch-finished (value: {"count":2})
      14s    | yes     | Ada, Linus, Grace | -- the create is saved — the list shows what the server last returned until it revalidates
      .      | yes     | Ada, Linus, Grace | [users||3] server-data-changed (value: {"id":3,"name":"Linus"})
      .      | yes     | Ada, Linus, Grace | offline:createUser replay-finished
      .      | no      | Ada, Grace        | [query-items, pending] ui-changed
      14.01s | no      | Ada, Grace        | 🟠 >list-fetch-started
      14.81s | no      | Ada, Grace        | 🟠 <list-fetch-finished (value: {"count":3})
      .      | no      | Ada, Grace, Linus | [query-items] ui-changed
      "
    `);

    hook.unmount();
  });

  test('discarding a create that could not be saved removes the declared row from its lists', async () => {
    network.setOffline();
    const { env, createUser } = createUsersEnv({
      sessionKey: 'temp-queries-discard-session',
      storeName: 'temp-queries-discard-store',
      testScenario: {
        loaded: { queries: [usersQuery, usersStartingWithAQuery] },
      },
      addToQueries: {
        queries: [usersQuery, usersStartingWithAQuery],
        appendTo: 'end',
      },
      // The server rejects the create, and one failure is enough to ask the
      // user what to do with it.
      failCreateUser: true,
      offlineSession: {
        classifyRetryableFailure: (error, ctx) =>
          classifyRetryableReplayFailure(error, ctx.phase),
        replayRetry: { maxFailures: 1, intervalMs: 1 },
      },
    });

    const hook = renderHook(() => {
      const allUsers = env.apiStore.useListQuery(usersQuery, {
        itemSelector: (item) => item.name,
      });
      const usersStartingWithA = env.apiStore.useListQuery(
        usersStartingWithAQuery,
        { itemSelector: (item) => item.name },
      );

      env.trackItemUI('all-users', allUsers.items.join(', '));
      env.trackItemUI('a-users', usersStartingWithA.items.join(', '));
      return { allUsers, usersStartingWithA };
    });
    await flushAllTimers();

    env.addTimelineComments('beforeNextAction', ['create "Alan" offline']);
    await createUser('Alan');

    // The row is in both declared lists while the create is queued.
    expect({
      allUsers: hook.result.current.allUsers.items,
      usersStartingWithA: hook.result.current.usersStartingWithA.items,
    }).toMatchInlineSnapshot(`
      allUsers: ['Ada', 'Grace', 'Alan']
      usersStartingWithA: ['Ada', 'Alan']
    `);

    env.addTimelineComments('beforeNextAction', [
      'go online — the server rejects the create',
    ]);
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    const resolution = env.apiStore
      .getOfflineResolutions()
      .find((item) => item.operation === 'createUser');
    if (!resolution) throw new Error('Expected the createUser resolution');

    env.addTimelineComments('beforeNextAction', [
      'the user discards the create',
    ]);
    await act(async () => {
      await env.apiStore.resolveOfflineResolution(resolution.id, 'createUser', {
        action: 'discard',
      });
    });
    await flushAllTimers();

    // Nothing is left of the discarded row: no item, no pending work, and no
    // list still shows it.
    expect(env.apiStore.getItemState('temp:Alan')).toBeNull();
    expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
    expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time   | a-users   | all-users        |
      0      | Ada       | Ada, Grace       | [all-users, a-users] ui-initialized
      12s    | Ada       | Ada, Grace       | -- create "Alan" offline
      .      | Ada, Alan | Ada, Grace, Alan | [all-users, a-users] ui-changed
      .      | Ada, Alan | Ada, Grace, Alan | offline:createUser queued
      .      | Ada, Alan | Ada, Grace, Alan | -- go online — the server rejects the create
      .      | Ada, Alan | Ada, Grace, Alan | offline:createUser replay-started
      .      | Ada, Alan | Ada, Grace, Alan | offline:createUser resolution-required
      13s    | Ada, Alan | Ada, Grace, Alan | -- the user discards the create
      .      | Ada       | Ada, Grace       | [all-users, a-users] ui-changed
      13.01s | Ada       | Ada, Grace       | 🔴 >list-fetch-started
      .      | Ada       | Ada, Grace       | 🟠 >list-fetch-started
      13.81s | Ada       | Ada, Grace       | 🔴 <list-fetch-finished (value: {"count":2})
      .      | Ada       | Ada, Grace       | 🟠 <list-fetch-finished (value: {"count":1})
      "
    `);

    hook.unmount();
  });

  test('a row saved while the app is on another screen keeps its pending data when the server sends none, also with async storage', async () => {
    createOpfsPersistentStorageTestStore();
    const sessionKey = 'temp-queries-keep-pending-data-session';
    const storeName = 'temp-queries-keep-pending-data-store';
    const nextUserIdRef = { current: 3 };
    const envOptions = {
      sessionKey,
      storeName,
      testScenario: 'idle',
      addToQueries: undefined,
      nextUserIdRef,
      // The create's reconcile hook returns no `finalData`, so the saved row
      // keeps the data of the pending row
      keepPendingData: true,
      // Rows are only read from OPFS when a screen needs them
      storageAdapter: opfsPersistentStorage,
    } as const;

    network.setOffline();
    const first = createUsersEnv(envOptions);
    await flushAllTimers();
    // OPFS writes settle on timers, so they are flushed while the create is
    // queued
    await act(async () => {
      await resolveAfterAllTimers(
        first.env.apiStore.performMutation('temp:Linus', {
          mutation: () => Promise.resolve({ id: 3, name: 'Linus' }),
          offline: { operation: 'createUser', input: { name: 'Linus' } },
        }),
      );
    });
    await flushAllTimers();
    first.env.apiStore.dispose();

    // Restart the app offline on a screen that shows no user, so the pending
    // row is never read back from storage before its create is saved.
    resetSessionForTests();
    const restarted = createUsersEnv(envOptions);
    await flushAllTimers();

    act(() => {
      network.goOnline();
    });
    await flushAllTimers();
    expect(restarted.env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(
      `[]`,
    );

    // Back offline, the user opens the saved row: it holds the pending row's
    // data under its server id, instead of being missing until it is fetched.
    act(() => {
      network.goOffline();
    });
    await flushAllTimers();
    const hook = renderHook(() =>
      restarted.env.apiStore.useItem('users||3', {
        selector: (item) => item?.name ?? null,
      }),
    );
    await flushAllTimers();

    expect({
      status: hook.result.current.status,
      data: hook.result.current.data,
    }).toMatchInlineSnapshot(`
      data: 'Linus'
      status: 'success'
    `);
    // The pending row is gone: it was replaced by the saved one.
    expect(
      restarted.env.apiStore.getItemState('temp:Linus'),
    ).toMatchInlineSnapshot(`null`);

    hook.unmount();
  });
});

type DuplicateUsersOperations = {
  duplicateUsers: ListQueryOfflineOperationDefinition<
    UserRow,
    ListQueryParams,
    string,
    string[],
    unknown,
    UserRow[]
  >;
};

describe('temp entities with partial resources', () => {
  test('a row declared as fully loaded is shown by readers of every field instead of being fetched', async () => {
    const sessionKey = 'temp-queries-loaded-fields-session';
    const storeName = 'temp-queries-loaded-fields-store';
    const nextUserIdRef = { current: 3 };

    function renderUsers(
      { env }: ReturnType<typeof createUsersEnv<true>>,
      initialProps: { showNewUser: boolean },
    ) {
      return renderHook(
        ({ showNewUser }: { showNewUser: boolean }) => {
          // Both readers ask for every field of each row.
          const query = env.apiStore.useListQuery(usersQuery, {
            fields: '*',
            itemSelector: (item) => item.name,
            returnRefetchingStatus: true,
          });
          const newUser = env.apiStore.useItem(
            showNewUser ? 'temp:Linus' : false,
            {
              fields: '*',
              selector: (item) => item?.name ?? null,
              returnRefetchingStatus: true,
            },
          );

          env.trackItemUI('list-status', query.status);
          env.trackItemUI('list-items', query.items.join(', '));
          env.trackItemUI('new-user-status', newUser.status);
          env.trackItemUI('new-user', newUser.data ?? '-');
          return { query, newUser };
        },
        { initialProps },
      );
    }

    const first = createUsersEnv<true>({
      sessionKey,
      storeName,
      testScenario: 'idle',
      partialResources: partialResourcesConfig,
      addToQueries: { queries: [usersQuery], appendTo: 'end' },
      // `inferFields` only reports the keys of a row, so without this the
      // readers below would treat the temp row as partially loaded.
      loadedFields: '*',
      nextUserIdRef,
    });

    // Load the list online first so the server rows are fully loaded.
    const firstHook = renderUsers(first, { showNewUser: false });
    await flushAllTimers();

    act(() => {
      network.goOffline();
    });
    await flushAllTimers();

    first.env.addTimelineComments('beforeNextAction', [
      'create "Linus" and "Margaret" offline and open the details of "Linus"',
    ]);
    await first.createUser('Linus');
    await first.createUser('Margaret');
    firstHook.rerender({ showNewUser: true });
    await flushAllTimers();

    // The temp rows are complete for both readers, and the list keeps showing
    // the rows it already had.
    expect({
      listItems: firstHook.result.current.query.items,
      listStatus: firstHook.result.current.query.status,
      newUser: firstHook.result.current.newUser.data,
      newUserStatus: firstHook.result.current.newUser.status,
    }).toMatchInlineSnapshot(`
      listItems: ['Ada', 'Grace', 'Linus', 'Margaret']
      listStatus: 'success'
      newUser: 'Linus'
      newUserStatus: 'success'
    `);
    expect(first.env.timelineString).toMatchInlineSnapshot(`
      "
      time  | list-items                  | list-status | new-user | new-user-status |
      0     |                             | loading     | -        | idle            | [list-status, list-items, new-user-status, new-user] ui-initialized
      10ms  |                             | loading     | -        | idle            | 🔴 >list-fetch-started
      810ms |                             | loading     | -        | idle            | 🔴 <list-fetch-finished (value: {"count":2})
      .     | Ada, Grace                  | success     | -        | idle            | [list-status, list-items] ui-changed
      12s   | Ada, Grace                  | success     | -        | idle            | -- create "Linus" and "Margaret" offline and open the details of "Linus"
      .     | Ada, Grace, Linus           | success     | -        | idle            | [list-items] ui-changed
      .     | Ada, Grace, Linus           | success     | -        | idle            | offline:createUser queued
      .     | Ada, Grace, Linus, Margaret | success     | -        | idle            | [list-items] ui-changed
      .     | Ada, Grace, Linus, Margaret | success     | -        | idle            | offline:createUser queued
      .     | Ada, Grace, Linus, Margaret | success     | Linus    | success         | [new-user-status, new-user] ui-changed
      "
    `);
    firstHook.unmount();

    // Restart the app while still offline: the declared loaded fields must
    // come back from storage together with the row.
    resetSessionForTests();

    const restarted = createUsersEnv<true>({
      sessionKey,
      storeName,
      testScenario: 'idle',
      partialResources: partialResourcesConfig,
      addToQueries: { queries: [usersQuery], appendTo: 'end' },
      loadedFields: '*',
      nextUserIdRef,
    });

    restarted.env.addTimelineComments('beforeNextAction', [
      'restart the app offline with the details still open',
    ]);
    const hook = renderUsers(restarted, { showNewUser: true });
    await flushAllTimers();

    restarted.env.addTimelineComments('beforeNextAction', [
      'go online — the creates are saved one by one, then the store revalidates',
    ]);
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    // Each saved row is as complete as the temp row it replaced.
    expect(restarted.env.store.state.itemLoadedFields).toMatchInlineSnapshot(`
      "users||1: '*'
      "users||2: '*'
      "users||3: '*'
      "users||4: '*'
    `);
    // The temp rows only exist locally, so they are never requested from the
    // server: neither while offline nor after reconnecting.
    expect([
      ...first.env.serverTable.getRequestHistory('item'),
      ...restarted.env.serverTable.getRequestHistory('item'),
    ]).toMatchInlineSnapshot(`[]`);
    // The list never falls back to `loading` and never drops its rows. When
    // "Linus" is saved (13.2s) its saved row stays fully loaded, so the list
    // is not refetched while "Margaret" is still pending — the only list
    // request is the revalidation after the last create.
    // (The details reader goes to `deleted` because it was opened with the
    // temp id, which is replaced by the server id once the row is saved.)
    expect(restarted.env.timelineString).toMatchInlineSnapshot(`
      "
      time   | list-items                  | list-status | new-user | new-user-status |
      0      | -                           | -           | -        | -               | -- restart the app offline with the details still open
      .      | Ada, Grace, Linus, Margaret | success     | Linus    | success         | [list-status, list-items, new-user-status, new-user] ui-initialized
      10ms   | Ada, Grace, Linus, Margaret | success     | Linus    | success         | [list-status, list-status, new-user-status, new-user-status] ui-changed
      12s    | Ada, Grace, Linus, Margaret | success     | Linus    | success         | -- go online — the creates are saved one by one, then the store revalidates
      .      | Ada, Grace, Linus, Margaret | success     | Linus    | success         | offline:createUser replay-started
      13.2s  | Ada, Grace, Linus, Margaret | success     | Linus    | success         | [users||3] server-data-changed (value: {"id":3,"name":"Linus"})
      .      | Ada, Grace, Linus, Margaret | success     | Linus    | success         | offline:createUser replay-finished
      .      | Ada, Grace, Linus, Margaret | success     | -        | deleted         | [new-user-status, new-user] ui-changed
      .      | Ada, Grace, Linus, Margaret | success     | -        | deleted         | offline:createUser replay-started
      14.4s  | Ada, Grace, Linus, Margaret | success     | -        | deleted         | [users||4] server-data-changed (value: {"id":4,"name":"Margaret"})
      .      | Ada, Grace, Linus, Margaret | success     | -        | deleted         | offline:createUser replay-finished
      .      | Ada, Grace, Linus, Margaret | refetching  | -        | deleted         | [list-status] ui-changed
      14.41s | Ada, Grace, Linus, Margaret | refetching  | -        | deleted         | 🔴 >list-fetch-started
      15.21s | Ada, Grace, Linus, Margaret | refetching  | -        | deleted         | 🔴 <list-fetch-finished (value: {"count":4})
      .      | Ada, Grace, Linus, Margaret | success     | -        | deleted         | [list-status] ui-changed
      "
    `);

    hook.unmount();
  });

  test('a row saved while the app is on another screen stays fully loaded, also with async storage', async () => {
    createOpfsPersistentStorageTestStore();
    const sessionKey = 'temp-queries-loaded-fields-background-session';
    const storeName = 'temp-queries-loaded-fields-background-store';
    const nextUserIdRef = { current: 3 };
    const envOptions = {
      sessionKey,
      storeName,
      testScenario: 'idle',
      partialResources: partialResourcesConfig,
      addToQueries: undefined,
      loadedFields: '*',
      nextUserIdRef,
      // Rows are only read from OPFS when a screen needs them
      storageAdapter: opfsPersistentStorage,
    } as const;

    network.setOffline();
    const first = createUsersEnv<true>(envOptions);
    await flushAllTimers();
    // OPFS writes settle on timers, so they are flushed while the create is
    // queued
    await act(async () => {
      await resolveAfterAllTimers(
        first.env.apiStore.performMutation('temp:Linus', {
          mutation: () => Promise.resolve({ id: 3, name: 'Linus' }),
          offline: { operation: 'createUser', input: { name: 'Linus' } },
        }),
      );
    });
    await flushAllTimers();
    first.env.apiStore.dispose();

    // Restart the app offline on a screen that shows no user, so the temp row
    // is never read back from storage before its create is saved.
    resetSessionForTests();
    const restarted = createUsersEnv<true>(envOptions);
    await flushAllTimers();

    act(() => {
      network.goOnline();
    });
    await flushAllTimers();
    expect(restarted.env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(
      `[]`,
    );

    // Back offline, the user opens the saved row with a reader of every
    // field: it was declared complete, so it is shown instead of failing to
    // fetch its missing fields.
    act(() => {
      network.goOffline();
    });
    await flushAllTimers();
    const hook = renderHook(() =>
      restarted.env.apiStore.useItem('users||3', {
        fields: '*',
        selector: (item) => item?.name ?? null,
      }),
    );
    await flushAllTimers();

    expect({
      status: hook.result.current.status,
      data: hook.result.current.data,
    }).toMatchInlineSnapshot(`
      data: 'Linus'
      status: 'success'
    `);
    // The saved row was never requested: it was complete when it was saved.
    expect(
      restarted.env.serverTable.getRequestHistory('item'),
    ).toMatchInlineSnapshot(`[]`);

    hook.unmount();
  });
  test('copies of rows created offline are saved after a restart, even when the copied rows are no longer loaded', async () => {
    createOpfsPersistentStorageTestStore();
    const sessionKey = 'temp-queries-duplicate-session';
    let nextUserId = 3;

    function createDuplicateUsersEnv(testScenario: ListQueryStoreTestScenario) {
      const env = createListQueryStoreTestEnv<
        UserRow,
        true,
        false,
        DuplicateUsersOperations
      >(initialUsers, {
        id: 'temp-queries-duplicate-store',
        getSessionKey: () => sessionKey,
        storeManager: createStoreManager({
          errorNormalizer: normalizeError,
          getSessionKey: () => sessionKey,
          offlineSession: { network: network.config },
        }),
        testScenario,
        partialResources: partialResourcesConfig,
        persistentStorage: {
          // Rows are only read from OPFS when a screen needs them
          adapter: opfsPersistentStorage,
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            operations: {
              duplicateUsers: {
                inputSchema: rc_array(rc_string),
                kind: 'create',
                getEntityRefs: ({ input }) =>
                  input.map((sourceId) => `temp:copy:${sourceId}`),
                tempEntities: {
                  // A "duplicate" action copies the rows loaded on screen, so
                  // its pending copies can only be built while they are
                  // loaded.
                  buildPendingEntities: (
                    input,
                    tempIds,
                  ): OfflineTempEntityPendingEntry<
                    string,
                    UserRow,
                    ListQueryParams
                  >[] =>
                    input.map((sourceId, index) => {
                      const source = env.apiStore.getItemState(sourceId);
                      if (!source) throw new Error('Copied row is not loaded');
                      return {
                        tempId: tempIds[index] ?? `temp:copy:${sourceId}`,
                        pendingEntity: { id: -1, name: `${source.name} copy` },
                        loadedFields: '*',
                      };
                    }),
                  reconcileServerEntities: (result, tempIds) =>
                    result.map((item, index) => ({
                      tempId: tempIds[index] ?? `temp:copy:${item.id}`,
                      finalPayload: `users||${item.id}`,
                      finalData: item,
                    })),
                },
                execute: async ({ input }) => {
                  const results = input.map((sourceId) => {
                    const result = {
                      id: nextUserId,
                      name: `${sourceId === 'users||1' ? 'Ada' : 'Grace'} copy`,
                    };
                    nextUserId += 1;
                    return result;
                  });
                  for (const result of results) {
                    await env.serverTable.delayedSetItem(
                      `users||${result.id}`,
                      result,
                    );
                  }
                  return results;
                },
              },
            },
          },
        },
      });
      return env;
    }

    // Duplicate both rows offline while they are loaded on screen.
    network.setOffline();
    const first = createDuplicateUsersEnv({
      loaded: { items: ['users||1', 'users||2'] },
    });
    await flushAllTimers();
    // OPFS writes settle on timers, so they are flushed while the copy is
    // queued
    await act(async () => {
      await resolveAfterAllTimers(
        first.apiStore.performMutation(null, {
          mutation: () => Promise.resolve([]),
          offline: {
            operation: 'duplicateUsers',
            input: ['users||1', 'users||2'],
          },
        }),
      );
    });
    await flushAllTimers();
    first.apiStore.dispose();

    // Restart on a screen that shows no user, so the copied rows are not
    // loaded when the queued copy is saved.
    resetSessionForTests();
    const restarted = createDuplicateUsersEnv('idle');
    await flushAllTimers();
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    // The copies were created on the server once, and the saved copies
    // replaced the pending ones: nothing is left waiting for a retry or a
    // manual resolution that could create them twice.
    expect(restarted.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(
      `[]`,
    );
    expect(restarted.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
    // The saved copies are in the store under their server ids.
    expect({
      firstCopy: restarted.apiStore.getItemState('users||3'),
      secondCopy: restarted.apiStore.getItemState('users||4'),
    }).toMatchInlineSnapshot(`
      firstCopy: { id: 3, name: 'Ada copy' }
      secondCopy: { id: 4, name: 'Grace copy' }
    `);

    // Back offline, a reader of every field shows the saved copies: they were
    // declared complete when they were queued, and stay so once saved.
    act(() => {
      network.goOffline();
    });
    await flushAllTimers();
    const hook = renderHook(() =>
      ['users||3', 'users||4'].map((itemPayload) => {
        const { status, data } = restarted.apiStore.useItem(itemPayload, {
          fields: '*',
          selector: (item) => item?.name ?? null,
        });
        return { status, data };
      }),
    );
    await flushAllTimers();
    expect(hook.result.current).toMatchInlineSnapshot(`
      - { data: 'Ada copy', status: 'success' }
      - { data: 'Grace copy', status: 'success' }
    `);
    // The saved copies were never requested: they were complete when saved.
    expect(
      restarted.serverTable.getRequestHistory('item'),
    ).toMatchInlineSnapshot(`[]`);

    hook.unmount();
  });
});
