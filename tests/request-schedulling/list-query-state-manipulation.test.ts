import { describe, test } from 'vitest';

describe('update state functions', () => {
  test('update state of one item', () => {
    const { store } = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
    });

    expect(store.getItemState('users||1')).toMatchInlineSnapshot(`
      {
        "id": 1,
        "name": "User 1",
      }
    `);

    store.updateItemState('users||1', (data) => {
      data.name = 'User 1 updated';
    });

    expect(store.getItemState('users||1')).toMatchInlineSnapshot(`
      {
        "id": 1,
        "name": "User 1 updated",
      }
    `);
  });

  test('update multiple itens state', () => {
    const { store } = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
    });

    store.updateItemState(['users||1', 'users||2'], () => {
      return {
        name: 'new name',
        id: 1,
      };
    });

    expect(
      simplifyArraySnapshot(
        store.getItemState(['users||1', 'users||2', 'users||3']),
      ),
    ).toMatchInlineSnapshot(`
      "
      payload: users||1, data: {name: new name, id: 1}
      payload: users||2, data: {name: new name, id: 1}
      payload: users||3, data: {id: 3, name: User 3}
      "
    `);
  });

  test('update multiple itens state with filter fn', () => {
    const { store } = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
    });

    store.updateItemState(
      (_, state) => state.id > 2,
      (data) => {
        data.name = 'modified';
      },
    );

    expect(simplifyArraySnapshot(store.getItemState(() => true)))
      .toMatchInlineSnapshot(`
      "
      payload: users||1, data: {id: 1, name: User 1}
      payload: users||2, data: {id: 2, name: User 2}
      payload: users||3, data: {id: 3, name: modified}
      payload: users||4, data: {id: 4, name: modified}
      payload: users||5, data: {id: 5, name: modified}
      "
    `);
  });

  test('create if not exist', () => {
    const { store } = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
    });

    let storeUpdates = 0;
    store.store.subscribe(() => {
      storeUpdates++;
    });

    store.updateItemState(
      '20',
      (data) => {
        data.name = 'item 20';
      },
      {
        ifNothingWasUpdated: () => {
          store.addItemToState('users||20', {
            name: 'item 20',
            id: 20,
          });
        },
      },
    );

    expect(storeUpdates).toEqual(1);

    expect(simplifyArraySnapshot(store.getItemState(() => true)))
      .toMatchInlineSnapshot(`
      "
      payload: users||1, data: {id: 1, name: User 1}
      payload: users||2, data: {id: 2, name: User 2}
      payload: users||3, data: {id: 3, name: User 3}
      payload: users||4, data: {id: 4, name: User 4}
      payload: users||5, data: {id: 5, name: User 5}
      payload: users||20, data: {name: item 20, id: 20}
      "
    `);
  });

  test('addItemToState', () => {
    const { store } = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
    });

    expect(store.getItemState('users||20')).toBeUndefined();

    store.addItemToState('users||20', {
      name: 'item users||20',
      id: 20,
    });

    expect(store.getItemState('users||20')).toMatchInlineSnapshot(`
      {
        "id": 20,
        "name": "item users||20",
      }
    `);
    expect(store.store.state.itemQueries['users||20']).toMatchInlineSnapshot(`
      {
        "error": null,
        "payload": "users||20",
        "refetchOnMount": false,
        "status": "success",
        "wasLoaded": true,
      }
    `);
  });

  test('addItemToState with addItemToQueries', () => {
    const { store } = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
      disableInitialDataInvalidation: true,
    });

    expect(store.getItemState('users||20')).toBeUndefined();

    store.addItemToState(
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

    expect(store.store.state).toEqual({
      itemQueries: {
        'users||1': {
          error: null,
          payload: 'users||1',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
        'users||2': {
          error: null,
          payload: 'users||2',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
        'users||20': {
          error: null,
          payload: 'users||20',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
        'users||3': {
          error: null,
          payload: 'users||3',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
        'users||4': {
          error: null,
          payload: 'users||4',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
        'users||5': {
          error: null,
          payload: 'users||5',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
      },
      items: {
        'users||1': { id: 1, name: 'User 1' },
        'users||2': { id: 2, name: 'User 2' },
        'users||20': { id: 20, name: 'item users||20' },
        'users||3': { id: 3, name: 'User 3' },
        'users||4': { id: 4, name: 'User 4' },
        'users||5': { id: 5, name: 'User 5' },
      },
      queries: {
        [`{"tableId":"users"}`]: {
          error: null,
          hasMore: false,
          items: [
            'users||20',
            'users||1',
            'users||2',
            'users||3',
            'users||4',
            'users||5',
          ],
          payload: { tableId: 'users' },
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
      },
    });
  });

  test('addItemToState with existing items and addItemToQueries', () => {
    const { store } = createTestEnv({
      initialServerData,
      disableInitialDataInvalidation: true,
      useLoadedSnapshot: { tables: ['users'] },
    });

    expect(store.getItemState('users||1')).not.toBeUndefined();

    store.addItemToState(
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

    expect(store.store.state).toEqual({
      itemQueries: {
        'users||1': {
          error: null,
          payload: 'users||1',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
        'users||2': {
          error: null,
          payload: 'users||2',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
        'users||3': {
          error: null,
          payload: 'users||3',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
        'users||4': {
          error: null,
          payload: 'users||4',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
        'users||5': {
          error: null,
          payload: 'users||5',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
      },
      items: {
        'users||1': { id: 20, name: 'item users||20' },
        'users||2': { id: 2, name: 'User 2' },
        'users||3': { id: 3, name: 'User 3' },
        'users||4': { id: 4, name: 'User 4' },
        'users||5': { id: 5, name: 'User 5' },
      },
      queries: {
        [`{"tableId":"users"}`]: {
          error: null,
          hasMore: false,
          items: ['users||1', 'users||2', 'users||3', 'users||4', 'users||5'],
          payload: { tableId: 'users' },
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
      },
    });
  });

  test('delete item state', () => {
    const { store } = createTestEnv({
      initialServerData,
      disableInitialDataInvalidation: true,
      useLoadedSnapshot: { tables: ['users'] },
    });

    expect(store.getItemState('users||1')).toBeDefined();

    store.deleteItemState('users||1');

    expect(store.getItemState('users||1')).toBeNull();

    expect(store.scheduleItemFetch('highPriority', 'users||1')).toBe('started');

    const defaulItemQueryProps = {
      error: null,
      refetchOnMount: false,
      status: 'success',
      wasLoaded: true,
    };
    expect(store.store.state).toEqual({
      itemQueries: {
        'users||1': {
          error: null,
          payload: 'users||1',
          refetchOnMount: false,
          status: 'loading',
          wasLoaded: false,
        },
        'users||2': { ...defaulItemQueryProps, payload: 'users||2' },
        'users||3': { ...defaulItemQueryProps, payload: 'users||3' },
        'users||4': { ...defaulItemQueryProps, payload: 'users||4' },
        'users||5': { ...defaulItemQueryProps, payload: 'users||5' },
      },
      items: {
        'users||1': null,
        'users||2': { id: 2, name: 'User 2' },
        'users||3': { id: 3, name: 'User 3' },
        'users||4': { id: 4, name: 'User 4' },
        'users||5': { id: 5, name: 'User 5' },
      },
      queries: {
        '{"tableId":"users"}': {
          error: null,
          hasMore: false,
          items: ['users||2', 'users||3', 'users||4', 'users||5'],
          payload: { tableId: 'users' },
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
      },
    });
  });
});
