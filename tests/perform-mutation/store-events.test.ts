import {
  afterEach,
  assert,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { StoreMutationError } from '../../src/utils/storeShared';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, pick } from '../utils/genericTestUtils';

// mutationIds (and fetchIds) come from a module-level counter in
// requestScheduler. Reset the counter between tests so snapshots with
// absolute ids don't shift when tests are added or reordered.
const counterState = vi.hoisted(() => ({ value: 0 }));

vi.mock('../../src/requestScheduler', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/requestScheduler')>();
  return {
    ...actual,
    getAutoIncrementId: () => {
      counterState.value += 1;
      return counterState.value;
    },
  };
});

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
});

beforeEach(() => {
  counterState.value = 0;
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
      - payload: { mutationId: 1, status: 'success' }
        type: 'mutationEnd'
    `);
  });

  test('emits mutationEnd with success: false on failed mutation', async () => {
    const env = createDocumentStoreTestEnv(1);
    const events: unknown[] = [];
    const failure = new Error('fail');

    env.apiStore.storeEvents.on('*', (event) => {
      events.push(event);
    });

    const promise = env.apiStore.performMutation({
      mutation: () => Promise.reject(failure),
    });

    const result = await promise;

    assert(!result.ok);
    assert(result.error instanceof StoreMutationError);
    expect(result.error).toBeInstanceOf(StoreMutationError);
    expect(result.error).toMatchInlineSnapshot(`
      Error#:
        message: 'fail'
        name: 'StoreMutationError'
        kind: 'error'
        code: 500
        id: 'fetch-error'
        cause:
          Error#: { message: 'fail', name: 'Error' }
    `);
    expect(events).toMatchInlineSnapshot(`
      - payload: { mutationId: 1 }
        type: 'mutationStart'
      - payload: { mutationId: 1, status: 'error' }
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
      - payload: { mutationId: 1 }
        type: 'mutationStart'
      - payload: { mutationId: 1, status: 'success' }
        type: 'mutationEnd'
      - payload: { mutationId: 2 }
        type: 'mutationStart'
      - payload: { mutationId: 2, status: 'success' }
        type: 'mutationEnd'
    `);
  });

  // Regression guard: when optimisticUpdate returns false the lifecycle
  // short-circuits before calling `mutation`, but mutationEnd must still fire
  // with success: false so listeners can release any per-mutation UI state.
  test('emits mutationEnd with success: false when optimisticUpdate skips the mutation', async () => {
    const env = createDocumentStoreTestEnv(1);
    const events: unknown[] = [];
    const mutationCalls: string[] = [];

    env.apiStore.storeEvents.on('*', (event) => {
      events.push(event);
    });

    const result = await env.apiStore.performMutation({
      optimisticUpdate: () => false,
      mutation: () => {
        mutationCalls.push('ran');
        return Promise.resolve('ok');
      },
    });

    // skip short-circuits before `mutation` is called
    expect(mutationCalls).toMatchInlineSnapshot(`[]`);
    assert(!result.ok);
    expect(result.error).toMatchInlineSnapshot(`kind: 'skipped'`);
    // mutationStart fires before the skip, mutationEnd fires after with success: false
    expect(events).toMatchInlineSnapshot(`
      - payload: { mutationId: 1 }
        type: 'mutationStart'
      - payload: { mutationId: 1, status: 'skipped' }
        type: 'mutationEnd'
    `);
  });

  // Regression guard: when a pending debounced mutation is superseded by a newer
  // one sharing the same debounce key, the original promise resolves with a
  // skip — but mutationEnd must still fire for the skipped id.
  test('emits mutationEnd with success: false when a debounced mutation is skipped', async () => {
    const env = createDocumentStoreTestEnv(1);
    const events: unknown[] = [];

    env.apiStore.storeEvents.on('*', (event) => {
      events.push(event);
    });

    const firstPromise = env.apiStore.performMutation({
      debounce: { context: 'document:set-value', payload: 'doc-1', ms: 300 },
      mutation: () => Promise.resolve('first'),
    });

    await advanceTime(100);

    const secondPromise = env.apiStore.performMutation({
      debounce: { context: 'document:set-value', payload: 'doc-1', ms: 300 },
      mutation: () => Promise.resolve('second'),
    });

    await advanceTime(300);

    const [firstResult, secondResult] = await Promise.all([
      firstPromise,
      secondPromise,
    ]);

    // the first mutation is the one that gets skipped; the second runs
    assert(!firstResult.ok);
    assert(secondResult.ok);
    // both mutationStart events fire, then a mutationEnd for the skipped first
    // (success: false) and a mutationEnd for the second (success: true)
    expect(events).toMatchInlineSnapshot(`
      - payload: { mutationId: 1 }
        type: 'mutationStart'
      - payload: { mutationId: 2 }
        type: 'mutationStart'
      - payload: { mutationId: 1, status: 'skipped' }
        type: 'mutationEnd'
      - payload: { mutationId: 2, status: 'success' }
        type: 'mutationEnd'
    `);
  });
});

describe('collectionStore storeEvents', () => {
  test('emits mutationStart and mutationEnd with a single affected item on success', async () => {
    const env = createCollectionStoreTestEnv({ 'item-1': { name: 'Item 1' } });
    const events: unknown[] = [];

    env.apiStore.storeEvents.on('*', (event) => {
      events.push(event);
    });

    const result = await env.apiStore.performMutation('item-1', {
      mutation: () => Promise.resolve('ok'),
    });

    assert(result.ok);
    expect(events).toMatchInlineSnapshot(`
      - payload:
          items: ['item-1']
          mutationId: 1
        type: 'mutationStart'
      - payload:
          items: ['item-1']
          mutationId: 1
          status: 'success'
        type: 'mutationEnd'
    `);
  });

  test('emits events with array payload', async () => {
    const env = createCollectionStoreTestEnv({
      'item-1': { name: 'Item 1' },
      'item-2': { name: 'Item 2' },
    });
    const events: unknown[] = [];

    env.apiStore.storeEvents.on('*', (event) => {
      events.push(event);
    });

    const result = await env.apiStore.performMutation(['item-1', 'item-2'], {
      mutation: () => Promise.resolve('ok'),
    });

    assert(result.ok);
    expect(events).toMatchInlineSnapshot(`
      - payload:
          items: ['item-1', 'item-2']
          mutationId: 1
        type: 'mutationStart'
      - payload:
          items: ['item-1', 'item-2']
          mutationId: 1
          status: 'success'
        type: 'mutationEnd'
    `);
  });

  test('emits mutationEnd with success: false on failure', async () => {
    const env = createCollectionStoreTestEnv({ 'item-1': { name: 'Item 1' } });
    const events: unknown[] = [];
    const failure = new Error('fail');

    env.apiStore.storeEvents.on('*', (event) => {
      events.push(event);
    });

    const result = await env.apiStore.performMutation('item-1', {
      mutation: () => Promise.reject(failure),
    });

    assert(!result.ok);
    assert(result.error instanceof StoreMutationError);
    expect(result.error).toBeInstanceOf(StoreMutationError);
    expect(result.error).toMatchInlineSnapshot(`
      Error#:
        message: 'fail'
        name: 'StoreMutationError'
        kind: 'error'
        code: 500
        id: 'fetch-error'
        cause:
          Error#: { message: 'fail', name: 'Error' }
    `);
    expect(events).toMatchInlineSnapshot(`
      - payload:
          items: ['item-1']
          mutationId: 1
        type: 'mutationStart'
      - payload:
          items: ['item-1']
          mutationId: 1
          status: 'error'
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
      - payload:
          items: ['item-1']
          mutationId: 1
        type: 'mutationStart'
      - payload:
          items: ['item-1']
          mutationId: 1
          status: 'success'
        type: 'mutationEnd'
      - payload:
          items: ['item-2']
          mutationId: 2
        type: 'mutationStart'
      - payload:
          items: ['item-2']
          mutationId: 2
          status: 'success'
        type: 'mutationEnd'
    `);
  });

  test('emits events with no affected items for undefined, null, and false', async () => {
    const env = createCollectionStoreTestEnv({
      'item-1': { name: 'Item 1' },
      'item-2': { name: 'Item 2' },
    });
    const events: unknown[] = [];

    env.apiStore.storeEvents.on('*', (event) => {
      events.push(event);
    });

    const undefinedResult = await env.apiStore.performMutation(undefined, {
      mutation: () => Promise.resolve('undefined'),
    });
    const nullResult = await env.apiStore.performMutation(null, {
      mutation: () => Promise.resolve('null'),
    });
    const falseResult = await env.apiStore.performMutation(false, {
      mutation: () => Promise.resolve('false'),
    });

    assert(undefinedResult.ok);
    assert(nullResult.ok);
    assert(falseResult.ok);
    expect(events).toMatchInlineSnapshot(`
      - payload:
          items: []
          mutationId: 1
        type: 'mutationStart'
      - payload:
          items: []
          mutationId: 1
          status: 'success'
        type: 'mutationEnd'
      - payload:
          items: []
          mutationId: 2
        type: 'mutationStart'
      - payload:
          items: []
          mutationId: 2
          status: 'success'
        type: 'mutationEnd'
      - payload:
          items: []
          mutationId: 3
        type: 'mutationStart'
      - payload:
          items: []
          mutationId: 3
          status: 'success'
        type: 'mutationEnd'
    `);
  });

  test('passes multi-item targets to mutation callbacks and invalidates each affected item', async () => {
    const env = createCollectionStoreTestEnv(
      { 'item-1': { name: 'Item 1' }, 'item-2': { name: 'Item 2' } },
      { testScenario: 'loaded' },
    );

    let optimisticPayload: string | string[] | undefined;
    let mutationPayload: string | string[] | undefined;
    let successPayload: string | string[] | undefined;

    const result = await env.apiStore.performMutation(['item-1', 'item-2'], {
      optimisticUpdate: (payload) => {
        optimisticPayload = payload;
      },
      mutation: (payload) => {
        mutationPayload = payload;
        return Promise.resolve('ok');
      },
      onSuccess: (_response, payload) => {
        successPayload = payload;
      },
      revalidateOnSuccess: true,
    });

    assert(result.ok);
    expect(optimisticPayload).toMatchInlineSnapshot(`
      ['item-1', 'item-2']
    `);
    expect(mutationPayload).toMatchInlineSnapshot(`
      ['item-1', 'item-2']
    `);
    expect(successPayload).toMatchInlineSnapshot(`
      ['item-1', 'item-2']
    `);
    expect(
      pick(env.apiStore.getItemState('item-1'), ['refetchOnMount']),
    ).toMatchInlineSnapshot(`refetchOnMount: 'highPriority'`);
    expect(
      pick(env.apiStore.getItemState('item-2'), ['refetchOnMount']),
    ).toMatchInlineSnapshot(`refetchOnMount: 'highPriority'`);
  });

  test('no-target mutations pass an empty array and skip item invalidation', async () => {
    const env = createCollectionStoreTestEnv(
      { 'item-1': { name: 'Item 1' }, 'item-2': { name: 'Item 2' } },
      { testScenario: 'loaded' },
    );

    let mutationPayload: string | string[] | undefined;

    const result = await env.apiStore.performMutation(undefined, {
      mutation: (payload) => {
        mutationPayload = payload;
        return Promise.resolve('ok');
      },
      revalidateOnSuccess: true,
    });

    assert(result.ok);
    expect(mutationPayload).toMatchInlineSnapshot(`
      []
    `);
    expect(
      pick(env.apiStore.getItemState('item-1'), ['refetchOnMount']),
    ).toMatchInlineSnapshot(`refetchOnMount: '❌'`);
    expect(
      pick(env.apiStore.getItemState('item-2'), ['refetchOnMount']),
    ).toMatchInlineSnapshot(`refetchOnMount: '❌'`);
  });

  // Regression guard: same skip semantics as the documentStore case, but
  // mutationEnd must still carry the affected items list.
  test('emits mutationEnd with success: false when optimisticUpdate skips the mutation', async () => {
    const env = createCollectionStoreTestEnv({ 'item-1': { name: 'Item 1' } });
    const events: unknown[] = [];
    const mutationCalls: string[] = [];

    env.apiStore.storeEvents.on('*', (event) => {
      events.push(event);
    });

    const result = await env.apiStore.performMutation('item-1', {
      optimisticUpdate: () => false,
      mutation: () => {
        mutationCalls.push('ran');
        return Promise.resolve('ok');
      },
    });

    expect(mutationCalls).toMatchInlineSnapshot(`[]`);
    assert(!result.ok);
    expect(events).toMatchInlineSnapshot(`
      - payload:
          items: ['item-1']
          mutationId: 1
        type: 'mutationStart'
      - payload:
          items: ['item-1']
          mutationId: 1
          status: 'skipped'
        type: 'mutationEnd'
    `);
  });

  test('emits mutationEnd with success: false when a debounced mutation is skipped', async () => {
    const env = createCollectionStoreTestEnv({ 'item-1': { name: 'Item 1' } });
    const events: unknown[] = [];

    env.apiStore.storeEvents.on('*', (event) => {
      events.push(event);
    });

    const firstPromise = env.apiStore.performMutation('item-1', {
      debounce: { context: 'collection:update', payload: 'item-1', ms: 300 },
      mutation: () => Promise.resolve('first'),
    });

    await advanceTime(100);

    const secondPromise = env.apiStore.performMutation('item-1', {
      debounce: { context: 'collection:update', payload: 'item-1', ms: 300 },
      mutation: () => Promise.resolve('second'),
    });

    await advanceTime(300);

    const [firstResult, secondResult] = await Promise.all([
      firstPromise,
      secondPromise,
    ]);

    assert(!firstResult.ok);
    assert(secondResult.ok);
    expect(events).toMatchInlineSnapshot(`
      - payload:
          items: ['item-1']
          mutationId: 1
        type: 'mutationStart'
      - payload:
          items: ['item-1']
          mutationId: 2
        type: 'mutationStart'
      - payload:
          items: ['item-1']
          mutationId: 1
          status: 'skipped'
        type: 'mutationEnd'
      - payload:
          items: ['item-1']
          mutationId: 2
          status: 'success'
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
          mutationId: 1
        type: 'mutationStart'
      - payload:
          items: ['users||1']
          mutationId: 1
          status: 'success'
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
      { mutation: () => Promise.resolve('ok') },
    );

    assert(result.ok);
    expect(events).toMatchInlineSnapshot(`
      - payload:
          items: ['users||1', 'users||2']
          mutationId: 1
        type: 'mutationStart'
      - payload:
          items: ['users||1', 'users||2']
          mutationId: 1
          status: 'success'
        type: 'mutationEnd'
    `);
  });

  test('emits mutationEnd with success: false on failure', async () => {
    const env = createListQueryStoreTestEnv({
      users: [{ id: 1, name: 'User 1' }],
    });
    const events: unknown[] = [];
    const failure = new Error('fail');

    env.apiStore.storeEvents.on('*', (event) => {
      events.push(event);
    });

    const result = await env.apiStore.performMutation('users||1', {
      mutation: () => Promise.reject(failure),
    });

    assert(!result.ok);
    assert(result.error instanceof StoreMutationError);
    expect(result.error).toBeInstanceOf(StoreMutationError);
    expect(result.error).toMatchInlineSnapshot(`
      Error#:
        message: 'fail'
        name: 'StoreMutationError'
        kind: 'error'
        code: 500
        id: 'fetch-error'
        cause:
          Error#: { message: 'fail', name: 'Error' }
    `);
    expect(events).toMatchInlineSnapshot(`
      - payload:
          items: ['users||1']
          mutationId: 1
        type: 'mutationStart'
      - payload:
          items: ['users||1']
          mutationId: 1
          status: 'error'
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
          mutationId: 1
        type: 'mutationStart'
      - payload:
          items: ['users||1']
          mutationId: 1
          status: 'success'
        type: 'mutationEnd'
      - payload:
          items: ['users||2']
          mutationId: 2
        type: 'mutationStart'
      - payload:
          items: ['users||2']
          mutationId: 2
          status: 'success'
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
          mutationId: 1
        type: 'mutationStart'
      - payload:
          items: []
          mutationId: 1
          status: 'success'
        type: 'mutationEnd'
    `);
  });

  test('treats null and false as no-target mutations too', async () => {
    const env = createListQueryStoreTestEnv({
      users: [{ id: 1, name: 'User 1' }],
    });
    const events: unknown[] = [];

    env.apiStore.storeEvents.on('*', (event) => {
      events.push(event);
    });

    const nullResult = await env.apiStore.performMutation(null, {
      mutation: () => Promise.resolve('null'),
    });
    const falseResult = await env.apiStore.performMutation(false, {
      mutation: () => Promise.resolve('false'),
    });

    assert(nullResult.ok);
    assert(falseResult.ok);
    expect(events).toMatchInlineSnapshot(`
      - payload:
          items: []
          mutationId: 1
        type: 'mutationStart'
      - payload:
          items: []
          mutationId: 1
          status: 'success'
        type: 'mutationEnd'
      - payload:
          items: []
          mutationId: 2
        type: 'mutationStart'
      - payload:
          items: []
          mutationId: 2
          status: 'success'
        type: 'mutationEnd'
    `);
  });

  test('nullish no-target mutations no longer expand to loaded items', async () => {
    const env = createListQueryStoreTestEnv(
      {
        users: [
          { id: 1, name: 'User 1' },
          { id: 2, name: 'User 2' },
        ],
      },
      { testScenario: { loaded: { tables: ['users'] } } },
    );

    let mutationPayload: unknown;

    const result = await env.apiStore.performMutation(undefined, {
      mutation: (payload) => {
        mutationPayload = payload;
        return Promise.resolve('ok');
      },
      revalidateOnSuccess: true,
    });

    assert(result.ok);
    expect(mutationPayload).toMatchInlineSnapshot(`
      []
    `);
    expect(
      pick(
        env.apiStore.store.state.itemQueries[
          env.apiStore.getItemKey('users||1')
        ],
        ['refetchOnMount'],
      ),
    ).toMatchInlineSnapshot(`refetchOnMount: '❌'`);
    expect(
      pick(
        env.apiStore.store.state.itemQueries[
          env.apiStore.getItemKey('users||2')
        ],
        ['refetchOnMount'],
      ),
    ).toMatchInlineSnapshot(`refetchOnMount: '❌'`);
  });

  test('emits mutationEnd with success: false when optimisticUpdate skips the mutation', async () => {
    const env = createListQueryStoreTestEnv({
      users: [{ id: 1, name: 'User 1' }],
    });
    const events: unknown[] = [];
    const mutationCalls: string[] = [];

    env.apiStore.storeEvents.on('*', (event) => {
      events.push(event);
    });

    const result = await env.apiStore.performMutation('users||1', {
      optimisticUpdate: () => false,
      mutation: () => {
        mutationCalls.push('ran');
        return Promise.resolve('ok');
      },
    });

    expect(mutationCalls).toMatchInlineSnapshot(`[]`);
    assert(!result.ok);
    expect(events).toMatchInlineSnapshot(`
      - payload:
          items: ['users||1']
          mutationId: 1
        type: 'mutationStart'
      - payload:
          items: ['users||1']
          mutationId: 1
          status: 'skipped'
        type: 'mutationEnd'
    `);
  });

  test('emits mutationEnd with success: false when a debounced mutation is skipped', async () => {
    const env = createListQueryStoreTestEnv({
      users: [{ id: 1, name: 'User 1' }],
    });
    const events: unknown[] = [];

    env.apiStore.storeEvents.on('*', (event) => {
      events.push(event);
    });

    const firstPromise = env.apiStore.performMutation('users||1', {
      debounce: { context: 'list:update', payload: 'users||1', ms: 300 },
      mutation: () => Promise.resolve('first'),
    });

    await advanceTime(100);

    const secondPromise = env.apiStore.performMutation('users||1', {
      debounce: { context: 'list:update', payload: 'users||1', ms: 300 },
      mutation: () => Promise.resolve('second'),
    });

    await advanceTime(300);

    const [firstResult, secondResult] = await Promise.all([
      firstPromise,
      secondPromise,
    ]);

    assert(!firstResult.ok);
    assert(secondResult.ok);
    expect(events).toMatchInlineSnapshot(`
      - payload:
          items: ['users||1']
          mutationId: 1
        type: 'mutationStart'
      - payload:
          items: ['users||1']
          mutationId: 2
        type: 'mutationStart'
      - payload:
          items: ['users||1']
          mutationId: 1
          status: 'skipped'
        type: 'mutationEnd'
      - payload:
          items: ['users||1']
          mutationId: 2
          status: 'success'
        type: 'mutationEnd'
    `);
  });
});
