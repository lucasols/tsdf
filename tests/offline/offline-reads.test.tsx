import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { flushAllTimers, pick } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { userRowSchema } from './offlineReplayTestShared';
import { docSchema, listQueryQueryPayloadSchema } from './offlineTestShared';

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

test('offline fetches short-circuit to cached data without clearing the last successful snapshot', async () => {
  network.setOffline();

  const env = createDocumentStoreTestEnv(1, {
    getSessionKey: () => 'offline-read-cache-session',
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offlineMode: { network: network.config, operations: {} },
    },
  });

  await Promise.resolve();
  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  env.scheduleFetch('highPriority');
  await flushAllTimers();

  expect(env.store.state).toMatchInlineSnapshot(`
    data: { value: 1 }
    error: { code: 0, id: 'offline', message: 'Offline' }
    refetchOnMount: '❌'
    status: 'error'
  `);
  expect(env.serverMock.fetchHistory).toMatchInlineSnapshot(`[]`);
});

test('offline fetches without cached data return the normalized connectivity error', async () => {
  network.setOffline();

  const env = createDocumentStoreTestEnv(1, {
    getSessionKey: () => 'offline-read-empty-session',
    testScenario: 'idle',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offlineMode: { network: network.config, operations: {} },
    },
  });

  await Promise.resolve();
  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  env.scheduleFetch('highPriority');
  await flushAllTimers();

  expect(env.store.state).toMatchInlineSnapshot(`
    data: null
    error: { code: 0, id: 'offline', message: 'Offline' }
    refetchOnMount: '❌'
    status: 'error'
  `);
  expect(env.serverMock.fetchHistory).toMatchInlineSnapshot(`[]`);
});

test('offline list-query refetches keep the last successful query snapshot visible', async () => {
  const usersQuery = { tableId: 'users' } as const;
  const env = createListQueryStoreTestEnv(
    { users: [{ id: 1, name: 'Ada' }] },
    {
      getSessionKey: () => 'offline-list-query-cache-session',
      testScenario: { loaded: { queries: [usersQuery] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offlineMode: { network: network.config, operations: {} },
      },
    },
  );

  const hook = renderHook(() => {
    const query = env.apiStore.useListQuery(usersQuery, {
      itemSelector: (item) => item.name,
    });

    env.trackItemUI('query-status', query.status);
    env.trackItemUI('query-items', query.items.join(', '));

    return query;
  });

  // Start from a real successful query snapshot before forcing the session offline.
  await flushAllTimers();
  expect(pick(hook.result.current, ['items', 'status'])).toMatchInlineSnapshot(`
    items: ['Ada']
    status: 'success'
  `);

  // Once offline, a manual refetch should surface the connectivity error without blanking cached items.
  env.clearTimeline();
  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  env.scheduleFetch('highPriority', usersQuery);
  await flushAllTimers();

  expect(pick(hook.result.current, ['error', 'items', 'status']))
    .toMatchInlineSnapshot(`
      error: { code: 0, id: 'offline', message: 'Offline' }
      items: ['Ada']
      status: 'error'
    `);
  expect(env.serverTable.getRequestHistory('list', { includeTime: false }))
    .toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 50, offset: 0 }
        returned_items: 1
    `);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | query-items | query-status |
    1.81s | Ada         | success      | -- timeline-cleared
    .     | Ada         | success      | scheduled-fetch-triggered
    1.82s | Ada         | error        | [query-status] ui-changed
    "
  `);

  hook.unmount();
});

test('offline list-query mounts without cached data return the normalized connectivity error', async () => {
  const usersQuery = { tableId: 'users' } as const;
  network.setOffline();

  const env = createListQueryStoreTestEnv(
    { users: [{ id: 1, name: 'Ada' }] },
    {
      getSessionKey: () => 'offline-list-query-empty-session',
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offlineMode: { network: network.config, operations: {} },
      },
    },
  );

  const hook = renderHook(() => {
    const query = env.apiStore.useListQuery(usersQuery, {
      itemSelector: (item) => item.name,
    });

    env.trackItemUI('query-status', query.status);
    env.trackItemUI('query-items', query.items.join(', '));

    return query;
  });
  await flushAllTimers();

  expect(pick(hook.result.current, ['error', 'items', 'status']))
    .toMatchInlineSnapshot(`
      error: { code: 0, id: 'offline', message: 'Offline' }
      items: []
      status: 'error'
    `);
  expect(
    env.serverTable.getRequestHistory('list', { includeTime: false }),
  ).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time | query-items | query-status |
    0    |             | loading      | [query-status, query-items] ui-initialized
    10ms |             | error        | [query-status] ui-changed
    "
  `);

  hook.unmount();
});
