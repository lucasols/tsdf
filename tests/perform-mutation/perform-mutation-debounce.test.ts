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
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime } from '../utils/genericTestUtils';

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

describe('documentStore performMutation debounce', () => {
  test('skips previous mutation when debounce key matches', async () => {
    const env = createDocumentStoreTestEnv(1);
    const mutationCalls: string[] = [];

    const firstPromise = env.apiStore.performMutation({
      debounce: { context: 'document:set-value', payload: 'doc-1', ms: 300 },
      mutation: () => {
        mutationCalls.push('first');
        return Promise.resolve('first');
      },
    });

    await advanceTime(100);

    const secondPromise = env.apiStore.performMutation({
      debounce: { context: 'document:set-value', payload: 'doc-1', ms: 300 },
      mutation: () => {
        mutationCalls.push('second');
        return Promise.resolve('second');
      },
    });

    await advanceTime(299);
    expect(mutationCalls).toMatchInlineSnapshot(`[]`);

    await advanceTime(1);

    const [firstResult, secondResult] = await Promise.all([
      firstPromise,
      secondPromise,
    ]);

    expect(mutationCalls).toMatchInlineSnapshot(`['second']`);
    assert(!firstResult.ok);
    expect(firstResult.error).toMatchInlineSnapshot(`
      kind: 'skipped'
    `);
    assert(secondResult.ok);
    expect(secondResult.value).toBe('second');
  });

  test('does not deduplicate mutations with different debounce payload', async () => {
    const env = createDocumentStoreTestEnv(1);
    const mutationCalls: string[] = [];

    const firstPromise = env.apiStore.performMutation({
      debounce: { context: 'document:set-value', payload: 'doc-1', ms: 300 },
      mutation: () => {
        mutationCalls.push('first');
        return Promise.resolve('first');
      },
    });

    const secondPromise = env.apiStore.performMutation({
      debounce: { context: 'document:set-value', payload: 'doc-2', ms: 300 },
      mutation: () => {
        mutationCalls.push('second');
        return Promise.resolve('second');
      },
    });

    await advanceTime(299);
    expect(mutationCalls).toMatchInlineSnapshot(`[]`);

    await advanceTime(1);

    const [firstResult, secondResult] = await Promise.all([
      firstPromise,
      secondPromise,
    ]);

    expect(mutationCalls.toSorted()).toMatchInlineSnapshot(
      `['first', 'second']`,
    );
    assert(firstResult.ok);
    expect(firstResult.value).toBe('first');
    assert(secondResult.ok);
    expect(secondResult.value).toBe('second');
  });
});

describe('collectionStore performMutation debounce', () => {
  test('skips previous mutation when debounce key matches', async () => {
    const env = createCollectionStoreTestEnv({ 'item-1': { name: 'Item 1' } });
    const mutationCalls: string[] = [];

    const firstPromise = env.apiStore.performMutation('item-1', {
      debounce: { context: 'collection:update', payload: 'item-1', ms: 300 },
      mutation: () => {
        mutationCalls.push('first');
        return Promise.resolve('first');
      },
    });

    await advanceTime(100);

    const secondPromise = env.apiStore.performMutation('item-1', {
      debounce: { context: 'collection:update', payload: 'item-1', ms: 300 },
      mutation: () => {
        mutationCalls.push('second');
        return Promise.resolve('second');
      },
    });

    await advanceTime(299);
    expect(mutationCalls).toMatchInlineSnapshot(`[]`);

    await advanceTime(1);

    const [firstResult, secondResult] = await Promise.all([
      firstPromise,
      secondPromise,
    ]);

    expect(mutationCalls).toMatchInlineSnapshot(`['second']`);
    assert(!firstResult.ok);
    expect(firstResult.error).toMatchInlineSnapshot(`
      kind: 'skipped'
    `);
    assert(secondResult.ok);
    expect(secondResult.value).toBe('second');
  });

  test('does not deduplicate mutations with different debounce payload', async () => {
    const env = createCollectionStoreTestEnv({
      'item-1': { name: 'Item 1' },
      'item-2': { name: 'Item 2' },
    });
    const mutationCalls: string[] = [];

    const firstPromise = env.apiStore.performMutation('item-1', {
      debounce: { context: 'collection:update', payload: 'item-1', ms: 300 },
      mutation: () => {
        mutationCalls.push('first');
        return Promise.resolve('first');
      },
    });

    const secondPromise = env.apiStore.performMutation('item-2', {
      debounce: { context: 'collection:update', payload: 'item-2', ms: 300 },
      mutation: () => {
        mutationCalls.push('second');
        return Promise.resolve('second');
      },
    });

    await advanceTime(299);
    expect(mutationCalls).toMatchInlineSnapshot(`[]`);

    await advanceTime(1);

    const [firstResult, secondResult] = await Promise.all([
      firstPromise,
      secondPromise,
    ]);

    expect(mutationCalls.toSorted()).toMatchInlineSnapshot(
      `['first', 'second']`,
    );
    assert(firstResult.ok);
    expect(firstResult.value).toBe('first');
    assert(secondResult.ok);
    expect(secondResult.value).toBe('second');
  });
});

describe('listQueryStore performMutation debounce', () => {
  test('skips previous mutation when debounce key matches', async () => {
    const env = createListQueryStoreTestEnv({
      users: [{ id: 1, name: 'User 1' }],
    });
    const mutationCalls: string[] = [];

    const firstPromise = env.apiStore.performMutation('users||1', {
      debounce: { context: 'list-query:update', payload: 'users||1', ms: 300 },
      mutation: () => {
        mutationCalls.push('first');
        return Promise.resolve('first');
      },
    });

    await advanceTime(100);

    const secondPromise = env.apiStore.performMutation('users||1', {
      debounce: { context: 'list-query:update', payload: 'users||1', ms: 300 },
      mutation: () => {
        mutationCalls.push('second');
        return Promise.resolve('second');
      },
    });

    await advanceTime(299);
    expect(mutationCalls).toMatchInlineSnapshot(`[]`);

    await advanceTime(1);

    const [firstResult, secondResult] = await Promise.all([
      firstPromise,
      secondPromise,
    ]);

    expect(mutationCalls).toMatchInlineSnapshot(`['second']`);
    assert(!firstResult.ok);
    expect(firstResult.error).toMatchInlineSnapshot(`
      kind: 'skipped'
    `);
    assert(secondResult.ok);
    expect(secondResult.value).toBe('second');
  });

  test('does not deduplicate mutations with different debounce payload', async () => {
    const env = createListQueryStoreTestEnv({
      users: [
        { id: 1, name: 'User 1' },
        { id: 2, name: 'User 2' },
      ],
    });
    const mutationCalls: string[] = [];

    const firstPromise = env.apiStore.performMutation('users||1', {
      debounce: { context: 'list-query:update', payload: 'users||1', ms: 300 },
      mutation: () => {
        mutationCalls.push('first');
        return Promise.resolve('first');
      },
    });

    const secondPromise = env.apiStore.performMutation('users||2', {
      debounce: { context: 'list-query:update', payload: 'users||2', ms: 300 },
      mutation: () => {
        mutationCalls.push('second');
        return Promise.resolve('second');
      },
    });

    await advanceTime(299);
    expect(mutationCalls).toMatchInlineSnapshot(`[]`);

    await advanceTime(1);

    const [firstResult, secondResult] = await Promise.all([
      firstPromise,
      secondPromise,
    ]);

    expect(mutationCalls.toSorted()).toMatchInlineSnapshot(
      `['first', 'second']`,
    );
    assert(firstResult.ok);
    expect(firstResult.value).toBe('first');
    assert(secondResult.ok);
    expect(secondResult.value).toBe('second');
  });
});
