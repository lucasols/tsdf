import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

import {
  createListQueryStoreTestEnv,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { flushAllTimers } from '../utils/genericTestUtils';

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

const initialServerData: Tables = {
  users: range(1, 5).map((id) => ({ id, name: `User ${id}` })),
};

describe('update state functions', () => {
  test('update state of one item', () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'] } },
    });

    expect(env.apiStore.getItemState('users||1')).toMatchInlineSnapshot(`
      id: 1
      name: 'User 1'
    `);

    env.apiStore.updateItemState('users||1', (data) => {
      data.name = 'User 1 updated';
    });

    expect(env.apiStore.getItemState('users||1')).toMatchInlineSnapshot(`
      id: 1
      name: 'User 1 updated'
    `);
  });

  test('update multiple itens state', () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'] } },
    });

    env.apiStore.updateItemState(['users||1', 'users||2'], () => {
      return { name: 'new name', id: 1 };
    });

    expect(env.apiStore.getItemState(['users||1', 'users||2', 'users||3']))
      .toMatchInlineSnapshot(`
        - data: { id: 1, name: 'new name' }
          payload: 'users||1'
        - data: { id: 1, name: 'new name' }
          payload: 'users||2'
        - data: { id: 3, name: 'User 3' }
          payload: 'users||3'
      `);
  });

  test('update multiple itens state with filter fn', () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'] } },
    });

    env.apiStore.updateItemState(
      (_, state) => state.id > 2,
      (data) => {
        data.name = 'modified';
      },
    );

    expect(env.apiStore.getItemState(() => true)).toMatchInlineSnapshot(`
      - data: { id: 1, name: 'User 1' }
        payload: 'users||1'
      - data: { id: 2, name: 'User 2' }
        payload: 'users||2'
      - data: { id: 3, name: 'modified' }
        payload: 'users||3'
      - data: { id: 4, name: 'modified' }
        payload: 'users||4'
      - data: { id: 5, name: 'modified' }
        payload: 'users||5'
    `);
  });

  test('predicate updates keep touched items fresh for cache eviction', async () => {
    const env = createListQueryStoreTestEnv(
      { users: range(1, 3).map((id) => ({ id, name: `User ${id}` })) },
      { maxItems: 2 },
    );

    env.scheduleItemFetch('highPriority', 'users||1');
    await flushAllTimers();
    env.scheduleItemFetch('highPriority', 'users||2');
    await flushAllTimers();

    env.apiStore.updateItemState(
      (_, state) => state.name === 'User 1',
      (data) => {
        data.name = 'Updated User 1';
      },
    );

    env.scheduleItemFetch('highPriority', 'users||3');
    await flushAllTimers();

    expect(env.apiStore.getItemState('users||1')).toMatchInlineSnapshot(`
      id: 1
      name: 'Updated User 1'
    `);
    expect(env.apiStore.getItemState('users||2')).toBeUndefined();
    expect(env.apiStore.getItemState('users||3')).toMatchInlineSnapshot(`
      id: 3
      name: 'User 3'
    `);
  });

  test('create if not exist', () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'] } },
    });

    let storeUpdates = 0;
    env.store.subscribe(() => {
      storeUpdates++;
    });

    env.apiStore.updateItemState(
      '20',
      (data) => {
        data.name = 'item 20';
      },
      {
        ifNothingWasUpdated: () => {
          env.apiStore.addItemToState('users||20', { name: 'item 20', id: 20 });
        },
      },
    );

    expect(storeUpdates).toEqual(1);

    expect(env.apiStore.getItemState(() => true)).toMatchInlineSnapshot(`
      - data: { id: 1, name: 'User 1' }
        payload: 'users||1'
      - data: { id: 2, name: 'User 2' }
        payload: 'users||2'
      - data: { id: 3, name: 'User 3' }
        payload: 'users||3'
      - data: { id: 4, name: 'User 4' }
        payload: 'users||4'
      - data: { id: 5, name: 'User 5' }
        payload: 'users||5'
      - data: { id: 20, name: 'item 20' }
        payload: 'users||20'
    `);
  });

  test('addItemToState', () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'] } },
    });

    expect(env.apiStore.getItemState('users||20')).toBeUndefined();

    env.apiStore.addItemToState('users||20', {
      name: 'item users||20',
      id: 20,
    });

    expect(env.apiStore.getItemState('users||20')).toMatchInlineSnapshot(`
      id: 20
      name: 'item users||20'
    `);

    expect(env.store.state.itemQueries[env.getStoreItemKeyFromRaw('users||20')])
      .toMatchInlineSnapshot(`
        error: null
        payload: 'users||20'
        refetchOnMount: '❌'
        status: 'success'
        wasLoaded: '✅'
      `);
  });

  test('addItemToState with addItemToQueries', () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'] } },
    });

    expect(env.apiStore.getItemState('users||20')).toBeUndefined();

    env.apiStore.addItemToState(
      'users||20',
      { name: 'item users||20', id: 20 },
      {
        addItemToQueries: { queries: { tableId: 'users' }, appendTo: 'start' },
      },
    );

    expect(env.store.state).toMatchInlineSnapshot(`
      itemFieldInvalidationFields: {}

      itemLoadedFields: {}

      itemQueries:
        "users||1:
          error: null
          payload: 'users||1'
          refetchOnMount: '❌'
          status: 'success'
          wasLoaded: '✅'
        "users||2:
          error: null
          payload: 'users||2'
          refetchOnMount: '❌'
          status: 'success'
          wasLoaded: '✅'
        "users||20:
          error: null
          payload: 'users||20'
          refetchOnMount: '❌'
          status: 'success'
          wasLoaded: '✅'
        "users||3:
          error: null
          payload: 'users||3'
          refetchOnMount: '❌'
          status: 'success'
          wasLoaded: '✅'
        "users||4:
          error: null
          payload: 'users||4'
          refetchOnMount: '❌'
          status: 'success'
          wasLoaded: '✅'
        "users||5:
          error: null
          payload: 'users||5'
          refetchOnMount: '❌'
          status: 'success'
          wasLoaded: '✅'

      items:
        "users||1: { id: 1, name: 'User 1' }
        "users||2: { id: 2, name: 'User 2' }
        "users||20: { id: 20, name: 'item users||20' }
        "users||3: { id: 3, name: 'User 3' }
        "users||4: { id: 4, name: 'User 4' }
        "users||5: { id: 5, name: 'User 5' }

      queries:
        {tableId:"users"}:
          error: null
          hasMore: '❌'
          items: ['"users||20', '"users||1', '"users||2', '"users||3', '"users||4', '"users||5']
          payload: { tableId: 'users' }
          refetchOnMount: '❌'
          status: 'success'
          wasLoaded: '✅'
    `);
  });

  test('addItemToState with existing items and addItemToQueries', () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'] } },
    });

    expect(env.apiStore.getItemState('users||1')).not.toBeUndefined();

    env.apiStore.addItemToState(
      'users||1',
      { name: 'item users||20', id: 20 },
      {
        addItemToQueries: { queries: { tableId: 'users' }, appendTo: 'start' },
      },
    );

    expect(env.store.state).toMatchInlineSnapshot(`
      itemFieldInvalidationFields: {}

      itemLoadedFields: {}

      itemQueries:
        "users||1:
          error: null
          payload: 'users||1'
          refetchOnMount: '❌'
          status: 'success'
          wasLoaded: '✅'
        "users||2:
          error: null
          payload: 'users||2'
          refetchOnMount: '❌'
          status: 'success'
          wasLoaded: '✅'
        "users||3:
          error: null
          payload: 'users||3'
          refetchOnMount: '❌'
          status: 'success'
          wasLoaded: '✅'
        "users||4:
          error: null
          payload: 'users||4'
          refetchOnMount: '❌'
          status: 'success'
          wasLoaded: '✅'
        "users||5:
          error: null
          payload: 'users||5'
          refetchOnMount: '❌'
          status: 'success'
          wasLoaded: '✅'

      items:
        "users||1: { id: 20, name: 'item users||20' }
        "users||2: { id: 2, name: 'User 2' }
        "users||3: { id: 3, name: 'User 3' }
        "users||4: { id: 4, name: 'User 4' }
        "users||5: { id: 5, name: 'User 5' }

      queries:
        {tableId:"users"}:
          error: null
          hasMore: '❌'
          items: ['"users||1', '"users||2', '"users||3', '"users||4', '"users||5']
          payload: { tableId: 'users' }
          refetchOnMount: '❌'
          status: 'success'
          wasLoaded: '✅'
    `);
  });

  test('delete item state', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'] } },
    });

    expect(env.apiStore.getItemState('users||1')).toBeDefined();

    env.apiStore.deleteItemState('users||1');

    expect(env.apiStore.getItemState('users||1')).toBeNull();

    expect(env.scheduleItemFetch('highPriority', 'users||1')).toBe('triggered');

    // Wait for coalescing window
    await vi.advanceTimersByTimeAsync(15);

    expect(env.store.state).toMatchInlineSnapshot(`
      itemFieldInvalidationFields: {}

      itemLoadedFields: {}

      itemQueries:
        "users||1:
          error: null
          payload: 'users||1'
          refetchOnMount: '❌'
          status: 'loading'
          wasLoaded: '❌'
        "users||2:
          error: null
          payload: 'users||2'
          refetchOnMount: '❌'
          status: 'success'
          wasLoaded: '✅'
        "users||3:
          error: null
          payload: 'users||3'
          refetchOnMount: '❌'
          status: 'success'
          wasLoaded: '✅'
        "users||4:
          error: null
          payload: 'users||4'
          refetchOnMount: '❌'
          status: 'success'
          wasLoaded: '✅'
        "users||5:
          error: null
          payload: 'users||5'
          refetchOnMount: '❌'
          status: 'success'
          wasLoaded: '✅'

      items:
        "users||1: null
        "users||2: { id: 2, name: 'User 2' }
        "users||3: { id: 3, name: 'User 3' }
        "users||4: { id: 4, name: 'User 4' }
        "users||5: { id: 5, name: 'User 5' }

      queries:
        {tableId:"users"}:
          error: null
          hasMore: '❌'
          items: ['"users||2', '"users||3', '"users||4', '"users||5']
          payload: { tableId: 'users' }
          refetchOnMount: '❌'
          status: 'success'
          wasLoaded: '✅'
    `);
  });
});
