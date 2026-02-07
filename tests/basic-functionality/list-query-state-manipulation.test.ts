import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  createListQueryStoreTestEnv,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';

beforeAll(() => {
  vi.useFakeTimers();
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
      return {
        name: 'new name',
        id: 1,
      };
    });

    expect(
      env.apiStore.getItemState(['users||1', 'users||2', 'users||3']),
    ).toMatchInlineSnapshot(`
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
          env.apiStore.addItemToState('users||20', {
            name: 'item 20',
            id: 20,
          });
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

    expect(
      env.store.state.itemQueries[env.getStoreItemKeyFromRaw('users||20')],
    ).toMatchInlineSnapshot(`
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
      {
        name: 'item users||20',
        id: 20,
      },
      {
        addItemToQueries: {
          queries: { tableId: 'users' },
          appendTo: 'start',
        },
      },
    );

    const k1 = env.getStoreItemKeyFromRaw('users||1');
    const k2 = env.getStoreItemKeyFromRaw('users||2');
    const k3 = env.getStoreItemKeyFromRaw('users||3');
    const k4 = env.getStoreItemKeyFromRaw('users||4');
    const k5 = env.getStoreItemKeyFromRaw('users||5');
    const k20 = env.getStoreItemKeyFromRaw('users||20');
    const queryKey = env.getQueryKey({ tableId: 'users' });

    expect(env.store.state).toEqual({
      itemQueries: {
        [k1]: {
          error: null,
          payload: 'users||1',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
        [k2]: {
          error: null,
          payload: 'users||2',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
        [k20]: {
          error: null,
          payload: 'users||20',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
        [k3]: {
          error: null,
          payload: 'users||3',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
        [k4]: {
          error: null,
          payload: 'users||4',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
        [k5]: {
          error: null,
          payload: 'users||5',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
      },
      items: {
        [k1]: { id: 1, name: 'User 1' },
        [k2]: { id: 2, name: 'User 2' },
        [k20]: { id: 20, name: 'item users||20' },
        [k3]: { id: 3, name: 'User 3' },
        [k4]: { id: 4, name: 'User 4' },
        [k5]: { id: 5, name: 'User 5' },
      },
      queries: {
        [queryKey]: {
          error: null,
          hasMore: false,
          items: [k20, k1, k2, k3, k4, k5],
          payload: { tableId: 'users' },
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
      },
    });
  });

  test('addItemToState with existing items and addItemToQueries', () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'] } },
    });

    expect(env.apiStore.getItemState('users||1')).not.toBeUndefined();

    env.apiStore.addItemToState(
      'users||1',
      {
        name: 'item users||20',
        id: 20,
      },
      {
        addItemToQueries: {
          queries: { tableId: 'users' },
          appendTo: 'start',
        },
      },
    );

    const k1 = env.getStoreItemKeyFromRaw('users||1');
    const k2 = env.getStoreItemKeyFromRaw('users||2');
    const k3 = env.getStoreItemKeyFromRaw('users||3');
    const k4 = env.getStoreItemKeyFromRaw('users||4');
    const k5 = env.getStoreItemKeyFromRaw('users||5');
    const queryKey = env.getQueryKey({ tableId: 'users' });

    expect(env.store.state).toEqual({
      itemQueries: {
        [k1]: {
          error: null,
          payload: 'users||1',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
        [k2]: {
          error: null,
          payload: 'users||2',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
        [k3]: {
          error: null,
          payload: 'users||3',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
        [k4]: {
          error: null,
          payload: 'users||4',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
        [k5]: {
          error: null,
          payload: 'users||5',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
      },
      items: {
        [k1]: { id: 20, name: 'item users||20' },
        [k2]: { id: 2, name: 'User 2' },
        [k3]: { id: 3, name: 'User 3' },
        [k4]: { id: 4, name: 'User 4' },
        [k5]: { id: 5, name: 'User 5' },
      },
      queries: {
        [queryKey]: {
          error: null,
          hasMore: false,
          items: [k1, k2, k3, k4, k5],
          payload: { tableId: 'users' },
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
      },
    });
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

    const k1 = env.getStoreItemKeyFromRaw('users||1');
    const k2 = env.getStoreItemKeyFromRaw('users||2');
    const k3 = env.getStoreItemKeyFromRaw('users||3');
    const k4 = env.getStoreItemKeyFromRaw('users||4');
    const k5 = env.getStoreItemKeyFromRaw('users||5');
    const queryKey = env.getQueryKey({ tableId: 'users' });

    const defaultItemQueryProps = {
      error: null,
      refetchOnMount: false,
      status: 'success',
      wasLoaded: true,
    };
    expect(env.store.state).toEqual({
      itemQueries: {
        [k1]: {
          error: null,
          payload: 'users||1',
          refetchOnMount: false,
          status: 'loading',
          wasLoaded: false,
        },
        [k2]: { ...defaultItemQueryProps, payload: 'users||2' },
        [k3]: { ...defaultItemQueryProps, payload: 'users||3' },
        [k4]: { ...defaultItemQueryProps, payload: 'users||4' },
        [k5]: { ...defaultItemQueryProps, payload: 'users||5' },
      },
      items: {
        [k1]: null,
        [k2]: { id: 2, name: 'User 2' },
        [k3]: { id: 3, name: 'User 3' },
        [k4]: { id: 4, name: 'User 4' },
        [k5]: { id: 5, name: 'User 5' },
      },
      queries: {
        [queryKey]: {
          error: null,
          hasMore: false,
          items: [k2, k3, k4, k5],
          payload: { tableId: 'users' },
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
      },
    });
  });
});
