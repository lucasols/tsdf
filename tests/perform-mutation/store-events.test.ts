import {
  afterEach,
  assert,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';

beforeAll(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

describe('documentStore storeEvents', () => {
  test('emits mutationStart and mutationEnd on successful mutation', async () => {
    const env = createDocumentStoreTestEnv(1);
    const events: unknown[] = [];

    env.apiStore.storeEvents.on('*', (event) => {
      events.push(event);
    });

    const promise = env.apiStore.performMutation({
      mutation: () => Promise.resolve('ok'),
    });

    const result = await promise;

    assert(result.ok);
    expect(events).toMatchInlineSnapshot(`
      - payload: { mutationId: 1 }
        type: 'mutationStart'
      - payload: { mutationId: 1, success: '✅' }
        type: 'mutationEnd'
    `);
  });

  test('emits mutationEnd with success: false on failed mutation', async () => {
    const env = createDocumentStoreTestEnv(1);
    const events: unknown[] = [];

    env.apiStore.storeEvents.on('*', (event) => {
      events.push(event);
    });

    const promise = env.apiStore.performMutation({
      mutation: () => Promise.reject(new Error('fail')),
    });

    const result = await promise;

    assert(!result.ok);
    expect(events).toMatchInlineSnapshot(`
      - payload: { mutationId: 2 }
        type: 'mutationStart'
      - payload: { mutationId: 2, success: '❌' }
        type: 'mutationEnd'
    `);
  });

  test('mutationId increments across mutations', async () => {
    const env = createDocumentStoreTestEnv(1);
    const events: unknown[] = [];

    env.apiStore.storeEvents.on('*', (event) => {
      events.push(event);
    });

    await env.apiStore.performMutation({
      mutation: () => Promise.resolve('first'),
    });

    await env.apiStore.performMutation({
      mutation: () => Promise.resolve('second'),
    });

    expect(events).toMatchInlineSnapshot(`
      - payload: { mutationId: 3 }
        type: 'mutationStart'
      - payload: { mutationId: 3, success: '✅' }
        type: 'mutationEnd'
      - payload: { mutationId: 4 }
        type: 'mutationStart'
      - payload: { mutationId: 4, success: '✅' }
        type: 'mutationEnd'
    `);
  });
});

describe('collectionStore storeEvents', () => {
  test('emits mutationStart and mutationEnd with correct payload on success', async () => {
    const env = createCollectionStoreTestEnv({
      'item-1': { name: 'Item 1' },
    });
    const events: unknown[] = [];

    env.apiStore.storeEvents.on('*', (event) => {
      events.push(event);
    });

    const result = await env.apiStore.performMutation('item-1', {
      mutation: () => Promise.resolve('ok'),
    });

    assert(result.ok);
    expect(events).toMatchInlineSnapshot(`
      - payload: { mutationId: 5, payload: 'item-1' }
        type: 'mutationStart'
      - payload: { mutationId: 5, payload: 'item-1', success: '✅' }
        type: 'mutationEnd'
    `);
  });

  test('emits mutationEnd with success: false on failure', async () => {
    const env = createCollectionStoreTestEnv({
      'item-1': { name: 'Item 1' },
    });
    const events: unknown[] = [];

    env.apiStore.storeEvents.on('*', (event) => {
      events.push(event);
    });

    const result = await env.apiStore.performMutation('item-1', {
      mutation: () => Promise.reject(new Error('fail')),
    });

    assert(!result.ok);
    expect(events).toMatchInlineSnapshot(`
      - payload: { mutationId: 6, payload: 'item-1' }
        type: 'mutationStart'
      - payload: { mutationId: 6, payload: 'item-1', success: '❌' }
        type: 'mutationEnd'
    `);
  });

  test('mutationId increments across mutations', async () => {
    const env = createCollectionStoreTestEnv({
      'item-1': { name: 'Item 1' },
      'item-2': { name: 'Item 2' },
    });
    const events: unknown[] = [];

    env.apiStore.storeEvents.on('*', (event) => {
      events.push(event);
    });

    await env.apiStore.performMutation('item-1', {
      mutation: () => Promise.resolve('first'),
    });

    await env.apiStore.performMutation('item-2', {
      mutation: () => Promise.resolve('second'),
    });

    expect(events).toMatchInlineSnapshot(`
      - payload: { mutationId: 7, payload: 'item-1' }
        type: 'mutationStart'
      - payload: { mutationId: 7, payload: 'item-1', success: '✅' }
        type: 'mutationEnd'
      - payload: { mutationId: 8, payload: 'item-2' }
        type: 'mutationStart'
      - payload: { mutationId: 8, payload: 'item-2', success: '✅' }
        type: 'mutationEnd'
    `);
  });
});

describe('listQueryStore storeEvents', () => {
  test('emits events with single item payload', async () => {
    const env = createListQueryStoreTestEnv({
      users: [{ id: 1, name: 'User 1' }],
    });
    const events: unknown[] = [];

    env.apiStore.storeEvents.on('*', (event) => {
      events.push(event);
    });

    const result = await env.apiStore.performMutation('users||1', {
      mutation: () => Promise.resolve('ok'),
    });

    assert(result.ok);
    expect(events).toMatchInlineSnapshot(`
      - payload:
          items: ['users||1']
          mutationId: 9
        type: 'mutationStart'
      - payload:
          items: ['users||1']
          mutationId: 9
          success: '✅'
        type: 'mutationEnd'
    `);
  });

  test('emits events with array payload', async () => {
    const env = createListQueryStoreTestEnv({
      users: [
        { id: 1, name: 'User 1' },
        { id: 2, name: 'User 2' },
      ],
    });
    const events: unknown[] = [];

    env.apiStore.storeEvents.on('*', (event) => {
      events.push(event);
    });

    const result = await env.apiStore.performMutation(
      ['users||1', 'users||2'],
      {
        mutation: () => Promise.resolve('ok'),
      },
    );

    assert(result.ok);
    expect(events).toMatchInlineSnapshot(`
      - payload:
          items: ['users||1', 'users||2']
          mutationId: 10
        type: 'mutationStart'
      - payload:
          items: ['users||1', 'users||2']
          mutationId: 10
          success: '✅'
        type: 'mutationEnd'
    `);
  });

  test('emits mutationEnd with success: false on failure', async () => {
    const env = createListQueryStoreTestEnv({
      users: [{ id: 1, name: 'User 1' }],
    });
    const events: unknown[] = [];

    env.apiStore.storeEvents.on('*', (event) => {
      events.push(event);
    });

    const result = await env.apiStore.performMutation('users||1', {
      mutation: () => Promise.reject(new Error('fail')),
    });

    assert(!result.ok);
    expect(events).toMatchInlineSnapshot(`
      - payload:
          items: ['users||1']
          mutationId: 11
        type: 'mutationStart'
      - payload:
          items: ['users||1']
          mutationId: 11
          success: '❌'
        type: 'mutationEnd'
    `);
  });

  test('mutationId increments across mutations', async () => {
    const env = createListQueryStoreTestEnv({
      users: [
        { id: 1, name: 'User 1' },
        { id: 2, name: 'User 2' },
      ],
    });
    const events: unknown[] = [];

    env.apiStore.storeEvents.on('*', (event) => {
      events.push(event);
    });

    await env.apiStore.performMutation('users||1', {
      mutation: () => Promise.resolve('first'),
    });

    await env.apiStore.performMutation('users||2', {
      mutation: () => Promise.resolve('second'),
    });

    expect(events).toMatchInlineSnapshot(`
      - payload:
          items: ['users||1']
          mutationId: 12
        type: 'mutationStart'
      - payload:
          items: ['users||1']
          mutationId: 12
          success: '✅'
        type: 'mutationEnd'
      - payload:
          items: ['users||2']
          mutationId: 13
        type: 'mutationStart'
      - payload:
          items: ['users||2']
          mutationId: 13
          success: '✅'
        type: 'mutationEnd'
    `);
  });

  test('emits events even when no items are affected', async () => {
    const env = createListQueryStoreTestEnv({
      users: [{ id: 1, name: 'User 1' }],
    });
    const events: unknown[] = [];

    env.apiStore.storeEvents.on('*', (event) => {
      events.push(event);
    });

    const result = await env.apiStore.performMutation(undefined, {
      mutation: () => Promise.resolve('ok'),
    });

    assert(result.ok);
    expect(events).toMatchInlineSnapshot(`
      - payload:
          items: []
          mutationId: 14
        type: 'mutationStart'
      - payload:
          items: []
          mutationId: 14
          success: '✅'
        type: 'mutationEnd'
    `);
  });
});
