import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type {
  CollectionOfflineOperationDefinition,
  ListQueryOfflineOperationDefinition,
} from '../../src/main';
import { createStoreManager } from '../../src/storeManager';
import { createOfflineNetworkMock } from '../../src/testing';
import { createFocusChangeCoordinator } from '../browser-tabs/browser-tabs-test-helpers';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import { resetSessionForTests } from '../utils/resetSessionForTests';
import {
  type UpdateValueConflictOperations,
  userPatchSchema,
  userRowSchema,
} from './offlineReplayTestShared';
import {
  collectionSchema,
  docConflictSchema,
  docMutationInputSchema,
  docSchema,
  listQueryQueryPayloadSchema,
} from './offlineTestShared';

// While an offline change waits for the user to decide on it (a conflict
// here: someone else changed the same data meanwhile), the UI keeps showing
// the local version of what it changed. The background refetches (a view
// remounting, a window focus, a realtime update) leave it alone. An explicit
// fetch still shows what the server has, and once the change is handled the
// store refetches it.

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

const conflictSchema = rc_object({ reason: rc_string });

function goOnline() {
  act(() => {
    network.goOnline();
  });
}

// -- CollectionStore ------------------------------------------------------------

type RenameItemOperations = {
  renameItem: CollectionOfflineOperationDefinition<
    { value: { name: string } },
    string,
    { itemId: string; name: string },
    { reason: string }
  >;
};

/**
 * A loaded collection store whose offline renames always conflict, and a
 * view showing Ada.
 */
function setupCollection(name: string, usesRealTimeUpdates: boolean) {
  network.setOffline();
  const sessionKey = `${name}-session`;
  const tabs = createFocusChangeCoordinator(['app'], 'app');

  const env = createCollectionStoreTestEnv<
    { name: string },
    RenameItemOperations
  >(
    { 'users||1': { name: 'Ada' } },
    {
      id: name,
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
      }),
      testScenario: 'loaded',
      usesRealTimeUpdates,
      revalidateOnWindowFocus: true,
      bindFocusController: tabs.bind('app'),
      persistentStorage: {
        adapter: 'local-sync',
        schema: collectionSchema,
        payloadSchema: rc_string,
        offline: {
          operations: {
            renameItem: {
              inputSchema: userPatchSchema,
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              conflictHandling: {
                schema: conflictSchema,
                detectConflict: () => ({ reason: 'renamed by someone else' }),
              },
              execute: async ({ input }) => {
                await env.serverTable.delayedUpdateItem(input.itemId, {
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

  function renderAdaView() {
    return renderHook(() => {
      const ada = env.apiStore.useItem('users||1');
      env.trackItemUI('ada', ada.data?.value.name ?? `- ${ada.status}`);
    });
  }

  async function renameAdaOffline() {
    env.addTimelineComments('beforeNextAction', ['offline: rename Ada']);
    await act(async () => {
      await env.apiStore.performMutation('users||1', {
        optimisticUpdate: () => {
          env.apiStore.updateItemState('users||1', (draft) => {
            draft.value.name = 'Ada edited';
          });
        },
        mutation: () => Promise.reject(new Error('unreachable while offline')),
        offline: {
          operation: 'renameItem',
          input: { itemId: 'users||1', name: 'Ada edited' },
        },
      });
    });
  }

  // The user keeps their rename: the app saves it through its own API (the
  // server marks what it saved with a ` (saved)` suffix, which only a refetch
  // brings to the client), then marks the conflict as handled.
  async function keepAdaRename() {
    env.serverTable.updateItem('users||1', { name: 'Ada edited (saved)' });
    const [resolution] = env.apiStore.getOfflineResolutions();
    if (!resolution) throw new Error('Expected Ada to wait for a decision');
    env.addTimelineComments('beforeNextAction', [
      'the user keeps their rename: Ada is refetched',
    ]);
    await act(async () => {
      await env.apiStore.resolveOfflineResolution(resolution.id, 'renameItem', {
        action: 'commit',
      });
    });
    await flushAllTimers();
  }

  return { env, tabs, renderAdaView, renameAdaOffline, keepAdaRename };
}

test('collection: an item waiting for a decision keeps its local version when its view remounts or the window is focused', async () => {
  const { env, tabs, renderAdaView, renameAdaOffline, keepAdaRename } =
    setupCollection('held-local-collection', false);

  let view = renderAdaView();
  await flushAllTimers();

  // Offline: rename Ada. Meanwhile Bob renames her on the server.
  await renameAdaOffline();
  env.serverTable.updateItem('users||1', { name: 'Ada by Bob' });

  env.addTimelineComments('beforeNextAction', [
    'back online: the rename of Ada conflicts',
  ]);
  goOnline();
  await flushAllTimers();

  // The view showing Ada remounts (e.g. the user navigates back to it), then
  // the window is focused again. Neither refetches Ada: that would replace
  // the rename the user still has to decide on.
  env.addTimelineComments('beforeNextAction', [
    'the view remounts, then the window is focused',
  ]);
  view.unmount();
  view = renderAdaView();
  await flushAllTimers();
  await tabs.blur();
  await tabs.focusTab('app');
  await flushAllTimers();

  // An explicit fetch (e.g. the user asks to see the server's version) still
  // replaces it.
  env.addTimelineComments('beforeNextAction', ['explicit fetch of Ada']);
  act(() => {
    env.scheduleFetch('highPriority', 'users||1');
  });
  await flushAllTimers();

  // Once the conflict is handled, Ada is refetched in the background, which
  // brings what the server saved.
  await keepAdaRename();

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time    | ada                |
    0       | Ada                | [ada] ui-initialized
    12s     | Ada                | -- offline: rename Ada
    .       | Ada edited         | [ada] ui-changed
    .       | Ada edited         | offline:renameItem queued
    .       | Ada edited         | [users||1] server-data-changed (value: {"name":"Ada by Bob"})
    .       | Ada edited         | -- back online: the rename of Ada conflicts
    .       | Ada edited         | offline:renameItem resolution-required
    13s     | Ada edited         | -- the view remounts, then the window is focused
    .       | Ada edited         | 🔕 window-blurred
    13.005s | Ada edited         | 👁 window-focused
    13.01s  | Ada edited         | -- explicit fetch of Ada
    .       | Ada edited         | [users||1] scheduled-fetch-triggered
    13.02s  | Ada edited         | 🔴 [users||1] >fetch-started
    13.82s  | Ada edited         | 🔴 [users||1] <fetch-finished (value: {"name":"Ada by Bob"})
    .       | Ada by Bob         | [ada] ui-changed
    14.82s  | Ada by Bob         | [users||1] server-data-changed (value: {"name":"Ada edited (saved)"})
    14.83s  | Ada by Bob         | -- the user keeps their rename: Ada is refetched
    .       | Ada by Bob         | 🟠 [users||1] >fetch-started
    15.63s  | Ada by Bob         | 🟠 [users||1] <fetch-finished (value: {"name":"Ada edited (saved)"})
    .       | Ada edited (saved) | [ada] ui-changed
    "
  `);

  view.unmount();
});

test('collection: an item waiting for a decision keeps its local version when a realtime update reports it changed', async () => {
  const { env, renderAdaView, renameAdaOffline, keepAdaRename } =
    setupCollection('held-local-collection-realtime', true);

  const view = renderAdaView();
  await flushAllTimers();

  await renameAdaOffline();

  env.addTimelineComments('beforeNextAction', [
    'back online: the rename of Ada conflicts',
  ]);
  goOnline();
  await flushAllTimers();

  // Bob renames Ada and the realtime handler invalidates her: the refetch
  // would replace the rename the user still has to decide on.
  env.addTimelineComments('beforeNextAction', [
    'Bob renames Ada: a realtime update reports it',
  ]);
  act(() => {
    env.serverTable.setItem(
      'users||1',
      { name: 'Ada by Bob' },
      { triggerRTUEvent: true },
    );
  });
  await flushAllTimers();

  await keepAdaRename();

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ada                |
    0     | Ada                | [ada] ui-initialized
    .     | Ada                | -- offline: rename Ada
    .     | Ada edited         | [ada] ui-changed
    .     | Ada edited         | offline:renameItem queued
    .     | Ada edited         | -- back online: the rename of Ada conflicts
    .     | Ada edited         | offline:renameItem resolution-required
    2s    | Ada edited         | -- Bob renames Ada: a realtime update reports it
    .     | Ada edited         | [users||1] server-data-changed (value: {"name":"Ada by Bob"})
    .     | Ada edited         | [users||1] received-ws-data-change-event
    .     | Ada edited         | [users||1] server-data-changed (value: {"name":"Ada edited (saved)"})
    4.01s | Ada edited         | -- the user keeps their rename: Ada is refetched
    .     | Ada edited         | 🔴 [users||1] >fetch-started
    4.81s | Ada edited         | 🔴 [users||1] <fetch-finished (value: {"name":"Ada edited (saved)"})
    .     | Ada edited (saved) | [ada] ui-changed
    "
  `);

  view.unmount();
});

// -- ListQueryStore -------------------------------------------------------------

type RenameUserOperations = {
  renameUser: ListQueryOfflineOperationDefinition<
    { id: number; name: string },
    ListQueryParams,
    string,
    { itemId: string; name: string },
    { reason: string }
  >;
};

/**
 * A loaded list query store whose offline renames always conflict, and a
 * view with the list of users and a detail panel showing Ada.
 */
function setupListQuery(name: string, usesRealTimeUpdates: boolean) {
  network.setOffline();
  const sessionKey = `${name}-session`;
  const tabs = createFocusChangeCoordinator(['app'], 'app');

  const env = createListQueryStoreTestEnv<
    { id: number; name: string },
    false,
    false,
    RenameUserOperations
  >(
    {
      users: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ],
    },
    {
      id: name,
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
      }),
      testScenario: { loaded: { queries: [{ tableId: 'users' }] } },
      usesRealTimeUpdates,
      revalidateOnWindowFocus: true,
      bindFocusController: tabs.bind('app'),
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: {
          operations: {
            renameUser: {
              inputSchema: userPatchSchema,
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              conflictHandling: {
                schema: conflictSchema,
                detectConflict: () => ({ reason: 'renamed by someone else' }),
              },
              execute: async ({ input }) => {
                await env.serverTable.delayedUpdateItem(input.itemId, {
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

  function renderUsersView() {
    return renderHook(() => {
      const query = env.apiStore.useListQuery(
        { tableId: 'users' },
        { itemSelector: (item) => item.name },
      );
      const ada = env.apiStore.useItem('users||1');
      env.trackItemUI('rows', query.items.join(', '));
      env.trackItemUI('ada', ada.data?.name ?? `- ${ada.status}`);
    });
  }

  async function renameAdaOffline() {
    env.addTimelineComments('beforeNextAction', ['offline: rename Ada']);
    await act(async () => {
      await env.apiStore.performMutation('users||1', {
        optimisticUpdate: () => {
          env.apiStore.updateItemState('users||1', (item) => ({
            ...item,
            name: 'Ada edited',
          }));
        },
        mutation: () => Promise.reject(new Error('unreachable while offline')),
        offline: {
          operation: 'renameUser',
          input: { itemId: 'users||1', name: 'Ada edited' },
        },
      });
    });
  }

  // The user keeps their rename: the app saves it through its own API (the
  // server marks what it saved with a ` (saved)` suffix, which only a refetch
  // brings to the client), then marks the conflict as handled.
  async function keepAdaRename() {
    env.serverTable.updateItem('users||1', { name: 'Ada edited (saved)' });
    const [resolution] = env.apiStore.getOfflineResolutions();
    if (!resolution) throw new Error('Expected Ada to wait for a decision');
    env.addTimelineComments('beforeNextAction', [
      'the user keeps their rename: Ada and the list are refetched',
    ]);
    await act(async () => {
      await env.apiStore.resolveOfflineResolution(resolution.id, 'renameUser', {
        action: 'commit',
      });
    });
    await flushAllTimers();
  }

  return { env, tabs, renderUsersView, renameAdaOffline, keepAdaRename };
}

test('list query: an item waiting for a decision keeps its local version when its view remounts or the window is focused', async () => {
  const { env, tabs, renderUsersView, renameAdaOffline, keepAdaRename } =
    setupListQuery('held-local-list', false);

  let view = renderUsersView();
  await flushAllTimers();

  // Offline: rename Ada. Meanwhile Bob renames her on the server.
  await renameAdaOffline();
  env.serverTable.updateItem('users||1', { name: 'Ada by Bob' });

  // The recovery revalidation refetches the list, which keeps the local
  // version of Ada.
  env.addTimelineComments('beforeNextAction', [
    'back online: the rename of Ada conflicts',
  ]);
  goOnline();
  await flushAllTimers();

  // The view remounts (e.g. the user navigates back to it), then the window
  // is focused again. Ada is not refetched: that would replace the rename the
  // user still has to decide on. The list refetched on both keeps her local
  // version too.
  env.addTimelineComments('beforeNextAction', [
    'the view remounts, then the window is focused',
  ]);
  view.unmount();
  view = renderUsersView();
  await flushAllTimers();
  await tabs.blur();
  await tabs.focusTab('app');
  await flushAllTimers();

  // An explicit fetch (e.g. the user asks to see the server's version) still
  // replaces it.
  env.addTimelineComments('beforeNextAction', ['explicit fetch of Ada']);
  act(() => {
    env.scheduleItemFetch('highPriority', 'users||1');
  });
  await flushAllTimers();

  // Once the conflict is handled, Ada is refetched in the background, which
  // brings what the server saved.
  await keepAdaRename();

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time    | ada                | rows                      |
    0       | Ada                | Ada, Grace                | [rows, ada] ui-initialized
    3.01s   | Ada                | Ada, Grace                | -- offline: rename Ada
    .       | Ada edited         | Ada edited, Grace         | [rows, ada] ui-changed
    .       | Ada edited         | Ada edited, Grace         | offline:renameUser queued
    .       | Ada edited         | Ada edited, Grace         | [users||1] server-data-changed (value: {"name":"Ada by Bob"})
    .       | Ada edited         | Ada edited, Grace         | -- back online: the rename of Ada conflicts
    .       | Ada edited         | Ada edited, Grace         | offline:renameUser resolution-required
    3.02s   | Ada edited         | Ada edited, Grace         | 🔴 >list-fetch-started
    3.82s   | Ada edited         | Ada edited, Grace         | 🔴 <list-fetch-finished (value: {"count":2})
    4.83s   | Ada edited         | Ada edited, Grace         | -- the view remounts, then the window is focused
    .       | Ada edited         | Ada edited, Grace         | 🟠 >list-fetch-started
    5.63s   | Ada edited         | Ada edited, Grace         | 🟠 <list-fetch-finished (value: {"count":2})
    6.63s   | Ada edited         | Ada edited, Grace         | 🔕 window-blurred
    6.635s  | Ada edited         | Ada edited, Grace         | 👁 window-focused
    6.645s  | Ada edited         | Ada edited, Grace         | 🟡 >list-fetch-started
    7.445s  | Ada edited         | Ada edited, Grace         | 🟡 <list-fetch-finished (value: {"count":2})
    8.445s  | Ada edited         | Ada edited, Grace         | -- explicit fetch of Ada
    .       | Ada edited         | Ada edited, Grace         | [users||1] scheduled-fetch-triggered
    8.455s  | Ada edited         | Ada edited, Grace         | 🟢 [users||1] >fetch-started
    9.255s  | Ada edited         | Ada edited, Grace         | 🟢 [users||1] <fetch-finished (value: {"id":1,"name":"Ada by Bob"})
    .       | Ada by Bob         | Ada by Bob, Grace         | [rows, ada] ui-changed
    10.255s | Ada by Bob         | Ada by Bob, Grace         | [users||1] server-data-changed (value: {"name":"Ada edited (saved)"})
    10.265s | Ada by Bob         | Ada by Bob, Grace         | -- the user keeps their rename: Ada and the list are refetched
    .       | Ada by Bob         | Ada by Bob, Grace         | 🔵 >list-fetch-started
    .       | Ada by Bob         | Ada by Bob, Grace         | 🟣 [users||1] >fetch-started
    11.065s | Ada by Bob         | Ada by Bob, Grace         | 🔵 <list-fetch-finished (value: {"count":2})
    .       | Ada edited (saved) | Ada edited (saved), Grace | [rows, ada] ui-changed
    .       | Ada edited (saved) | Ada edited (saved), Grace | 🟣 [users||1] <fetch-finished (value: {"id":1,"name":"Ada edited (saved)"})
    "
  `);

  view.unmount();
});

test('list query: an item waiting for a decision keeps its local version when a realtime update reports it changed', async () => {
  const { env, renderUsersView, renameAdaOffline, keepAdaRename } =
    setupListQuery('held-local-list-realtime', true);

  const view = renderUsersView();
  await flushAllTimers();

  await renameAdaOffline();

  env.addTimelineComments('beforeNextAction', [
    'back online: the rename of Ada conflicts',
  ]);
  goOnline();
  await flushAllTimers();

  // Bob renames Ada and the realtime handler invalidates her and the lists of
  // the table. The list is refetched and keeps the local version of Ada, and
  // Ada is not refetched: that would replace the rename the user still has
  // to decide on.
  env.addTimelineComments('beforeNextAction', [
    'Bob renames Ada: a realtime update reports it',
  ]);
  act(() => {
    env.serverTable.setItem(
      'users||1',
      { id: 1, name: 'Ada by Bob' },
      { triggerRTUEvent: true },
    );
  });
  await flushAllTimers();

  await keepAdaRename();

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ada                | rows                      |
    0     | Ada                | Ada, Grace                | [rows, ada] ui-initialized
    .     | Ada                | Ada, Grace                | -- offline: rename Ada
    .     | Ada edited         | Ada edited, Grace         | [rows, ada] ui-changed
    .     | Ada edited         | Ada edited, Grace         | offline:renameUser queued
    .     | Ada edited         | Ada edited, Grace         | -- back online: the rename of Ada conflicts
    .     | Ada edited         | Ada edited, Grace         | offline:renameUser resolution-required
    2.01s | Ada edited         | Ada edited, Grace         | 🔴 >list-fetch-started
    2.81s | Ada edited         | Ada edited, Grace         | 🔴 <list-fetch-finished (value: {"count":2})
    3.81s | Ada edited         | Ada edited, Grace         | -- Bob renames Ada: a realtime update reports it
    .     | Ada edited         | Ada edited, Grace         | [users||1] server-data-changed (value: {"id":1,"name":"Ada by Bob"})
    .     | Ada edited         | Ada edited, Grace         | [users||1] received-ws-data-change-event
    3.82s | Ada edited         | Ada edited, Grace         | 🟠 >list-fetch-started
    4.62s | Ada edited         | Ada edited, Grace         | 🟠 <list-fetch-finished (value: {"count":2})
    5.62s | Ada edited         | Ada edited, Grace         | [users||1] server-data-changed (value: {"name":"Ada edited (saved)"})
    7.63s | Ada edited         | Ada edited, Grace         | -- the user keeps their rename: Ada and the list are refetched
    .     | Ada edited         | Ada edited, Grace         | 🟡 >list-fetch-started
    .     | Ada edited         | Ada edited, Grace         | 🟢 [users||1] >fetch-started
    8.43s | Ada edited         | Ada edited, Grace         | 🟡 <list-fetch-finished (value: {"count":2})
    .     | Ada edited (saved) | Ada edited (saved), Grace | [rows, ada] ui-changed
    .     | Ada edited (saved) | Ada edited (saved), Grace | 🟢 [users||1] <fetch-finished (value: {"id":1,"name":"Ada edited (saved)"})
    "
  `);

  view.unmount();
});

// -- DocumentStore --------------------------------------------------------------

/**
 * A loaded document store whose offline changes always conflict, and a view
 * showing it. With `reloadedWithServerValue`, it is the same store after the
 * app reloads, starting from what was saved on the device while the server
 * has that value.
 */
function setupDocument(
  name: string,
  usesRealTimeUpdates: boolean,
  reloadedWithServerValue?: number,
) {
  const reloaded = reloadedWithServerValue !== undefined;
  if (!reloaded) network.setOffline();
  const sessionKey = `${name}-session`;
  const tabs = createFocusChangeCoordinator(['app'], 'app');

  const env = createDocumentStoreTestEnv<number, UpdateValueConflictOperations>(
    reloadedWithServerValue ?? 1,
    {
      id: name,
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
      }),
      testScenario: reloaded ? 'idle' : 'loaded',
      usesRealTimeUpdates,
      revalidateOnWindowFocus: true,
      bindFocusController: tabs.bind('app'),
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              kind: 'update',
              conflictHandling: {
                schema: docConflictSchema,
                detectConflict: () => ({ reason: 'changed by someone else' }),
              },
              execute: async ({ input }) => {
                await env.serverMock.delayedSetData(input.value);
                return input;
              },
              onSuccessExecute: () => {},
            },
          },
        },
      },
    },
  );

  function renderDocumentView() {
    return renderHook(() => {
      const doc = env.apiStore.useDocument();
      env.trackUIChanges(doc.data?.value ?? `- ${doc.status}`);
    });
  }

  async function changeValueOffline() {
    env.addTimelineComments('beforeNextAction', ['offline: change to 2']);
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
  }

  // The user keeps their change: the app saves it through its own API, then
  // marks the conflict as handled.
  async function keepChange() {
    env.setServerData(2);
    const [resolution] = env.apiStore.getOfflineResolutions();
    if (!resolution)
      throw new Error('Expected a change waiting for a decision');
    env.addTimelineComments('beforeNextAction', [
      'the user keeps their change: the document is refetched',
    ]);
    await act(async () => {
      await env.apiStore.resolveOfflineResolution(
        resolution.id,
        'updateValue',
        { action: 'commit' },
      );
    });
    await flushAllTimers();
  }

  return { env, tabs, renderDocumentView, changeValueOffline, keepChange };
}

test('document: a document waiting for a decision keeps its local version when its view remounts or the window is focused', async () => {
  const { env, tabs, renderDocumentView, changeValueOffline, keepChange } =
    setupDocument('held-local-document', false);

  let view = renderDocumentView();
  await flushAllTimers();

  // Offline: change the value to 2. Meanwhile someone else sets it to 5.
  await changeValueOffline();
  env.setServerData(5);

  env.addTimelineComments('beforeNextAction', [
    'back online: the change conflicts',
  ]);
  goOnline();
  await flushAllTimers();

  // The view remounts (e.g. the user navigates back to it), then the window
  // is focused again. Neither refetches the document: that would replace the
  // change the user still has to decide on.
  env.addTimelineComments('beforeNextAction', [
    'the view remounts, then the window is focused',
  ]);
  view.unmount();
  view = renderDocumentView();
  await flushAllTimers();
  await tabs.blur();
  await tabs.focusTab('app');
  await flushAllTimers();

  // An explicit fetch (e.g. the user asks to see the server's version) still
  // replaces it.
  env.addTimelineComments('beforeNextAction', ['explicit fetch']);
  act(() => {
    env.scheduleFetch('highPriority');
  });
  await flushAllTimers();

  // Once the conflict is handled, the document is refetched in the
  // background, which brings what the server saved.
  await keepChange();

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ui |
    0      | 1  | ui-initialized
    1.01s  | 1  | -- offline: change to 2
    .      | 2  | ui-changed
    .      | 2  | offline:updateValue queued
    .      | 2  | server-data-changed (value: 5)
    .      | 2  | -- back online: the change conflicts
    .      | 2  | offline:updateValue resolution-required
    2.01s  | 2  | -- the view remounts, then the window is focused
    .      | 2  | 🔕 window-blurred
    2.015s | 2  | 👁 window-focused
    2.02s  | 2  | -- explicit fetch
    .      | 2  | scheduled-fetch-triggered
    2.03s  | 2  | 🔴 >fetch-started
    2.83s  | 2  | 🔴 <fetch-finished (value: 5)
    .      | 5  | ui-changed
    3.83s  | 5  | server-data-changed (value: 2)
    3.84s  | 5  | -- the user keeps their change: the document is refetched
    .      | 5  | 🟠 >fetch-started
    4.64s  | 5  | 🟠 <fetch-finished (value: 2)
    .      | 2  | ui-changed
    "
  `);

  view.unmount();
});

test('document: a document waiting for a decision keeps its local version when a realtime update reports it changed', async () => {
  const { env, renderDocumentView, changeValueOffline, keepChange } =
    setupDocument('held-local-document-realtime', true);

  const view = renderDocumentView();
  await flushAllTimers();

  await changeValueOffline();

  env.addTimelineComments('beforeNextAction', [
    'back online: the change conflicts',
  ]);
  goOnline();
  await flushAllTimers();

  // Someone else sets the value to 5 and the realtime handler invalidates
  // the document: the refetch would replace the change the user still has to
  // decide on.
  env.addTimelineComments('beforeNextAction', [
    'someone else changes it: a realtime update reports it',
  ]);
  act(() => {
    env.emulateExternalRTU(5);
  });
  await flushAllTimers();

  await keepChange();

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 1  | ui-initialized
    .     | 1  | -- offline: change to 2
    .     | 2  | ui-changed
    .     | 2  | offline:updateValue queued
    .     | 2  | -- back online: the change conflicts
    .     | 2  | offline:updateValue resolution-required
    1s    | 2  | -- someone else changes it: a realtime update reports it
    .     | 2  | server-data-changed (value: 5)
    .     | 2  | received-ws-data-change-event
    .     | 2  | server-data-changed (value: 2)
    3.01s | 2  | -- the user keeps their change: the document is refetched
    .     | 2  | 🔴 >fetch-started
    3.81s | 2  | 🔴 <fetch-finished (value: 2)
    "
  `);

  view.unmount();
});

test('document: a document waiting for a decision keeps its local version after a failed refresh', async () => {
  const { env, renderDocumentView, changeValueOffline, keepChange } =
    setupDocument('held-local-document-failed-refresh', false);

  let view = renderDocumentView();
  await flushAllTimers();

  // Offline: change the value to 2. Meanwhile someone else sets it to 5.
  await changeValueOffline();
  env.setServerData(5);

  env.addTimelineComments('beforeNextAction', [
    'back online: the change conflicts',
  ]);
  goOnline();
  await flushAllTimers();

  // The user asks to refresh, but the server fails: the document keeps
  // showing the local version together with the error.
  env.serverMock.setNextFetchError('server error');
  env.addTimelineComments('beforeNextAction', ['explicit fetch fails']);
  act(() => {
    env.scheduleFetch('highPriority');
  });
  await flushAllTimers();

  // A minute later the view remounts: the failed refresh doesn't make the
  // mount refetch replace the change the user still has to decide on.
  await advanceTime(60_000);
  env.addTimelineComments('beforeNextAction', ['the view remounts']);
  view.unmount();
  view = renderDocumentView();
  await flushAllTimers();

  // Once the conflict is handled, the document is refetched.
  await keepChange();

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ui |
    0      | 1  | ui-initialized
    1.01s  | 1  | -- offline: change to 2
    .      | 2  | ui-changed
    .      | 2  | offline:updateValue queued
    .      | 2  | server-data-changed (value: 5)
    .      | 2  | -- back online: the change conflicts
    .      | 2  | offline:updateValue resolution-required
    2.01s  | 2  | -- explicit fetch fails
    .      | 2  | scheduled-fetch-triggered
    2.02s  | 2  | 🔴 >fetch-started
    .      | 2  | 🔴 <fetch-error (value: "error")
    62.02s | 2  | -- the view remounts
    .      | 2  | server-data-changed (value: 2)
    62.03s | 2  | -- the user keeps their change: the document is refetched
    .      | 2  | 🟠 >fetch-started
    62.83s | 2  | 🟠 <fetch-finished (value: 2)
    "
  `);

  view.unmount();
});

test('document: a document waiting for a decision keeps its local version after the app reloads', async () => {
  const before = setupDocument('held-local-document-reload', false);

  const view = before.renderDocumentView();
  await flushAllTimers();

  // Offline: change the value to 2. Meanwhile someone else sets it to 5.
  await before.changeValueOffline();
  before.env.setServerData(5);
  goOnline();
  await flushAllTimers();
  view.unmount();
  before.env.apiStore.dispose();

  // The app reloads with the change still waiting for a decision. The view
  // mounts before the queued work is read from the device: its mount fetch
  // still waits for it and leaves the local version alone.
  resetSessionForTests();
  const { env, renderDocumentView, keepChange } = setupDocument(
    'held-local-document-reload',
    false,
    5,
  );
  env.addTimelineComments('beforeNextAction', [
    'the app reloads and the view mounts',
  ]);
  const reloadedView = renderDocumentView();
  await flushAllTimers();

  // Once the conflict is handled, the document is refetched.
  await keepChange();

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ui |
    0      | -  | -- the app reloads and the view mounts
    .      | 2  | ui-initialized
    .      | 2  | offline:updateValue resolution-required
    12s    | 2  | server-data-changed (value: 2)
    12.01s | 2  | -- the user keeps their change: the document is refetched
    .      | 2  | 🔴 >fetch-started
    12.81s | 2  | 🔴 <fetch-finished (value: 2)
    "
  `);

  reloadedView.unmount();
});
