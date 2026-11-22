import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { act } from 'react';
import { rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { CollectionOfflineOperationDefinition } from '../../src/main';
import { createStoreManager } from '../../src/storeManager';
import { createOfflineNetworkMock } from '../../src/testing';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import {
  advanceTime,
  flushAllTimers,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import { resetSessionForTests } from '../utils/resetSessionForTests';
import {
  getOfflineQueueEntries,
  getSortedQueueSummary,
} from './offlineReplayTestShared';
import {
  collectionSchema,
  getGlobalOfflineStatusSummary,
} from './offlineTestShared';

let network = createOfflineNetworkMock();

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

type RenameItemOperations = {
  renameItem: CollectionOfflineOperationDefinition<
    { value: { name: string } },
    string,
    { id: string; name: string }
  >;
};

// `offlineSession.enabled` returning `'replay-only'`: the app stops queueing
// new offline work (e.g. the workspace lost offline mode with a plan
// downgrade) while the changes already queued still reach the server.

test('replay-only gate: queued changes are still sent, but new changes are no longer queued', async () => {
  network.setOffline();
  const sessionKey = 'gate-replay-only';
  const storeName = 'gate-replay-only-store';
  const replayedInputs: { id: string; name: string }[] = [];
  const statusChanges = createLoggerStore();
  // The workspace setting the app reads
  let workspaceHasOfflineMode = true;
  const storeManager = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: {
      enabled: () => (workspaceHasOfflineMode ? true : 'replay-only'),
      network: network.config,
    },
  });

  const env: ReturnType<
    typeof createCollectionStoreTestEnv<{ name: string }, RenameItemOperations>
  > = createCollectionStoreTestEnv<{ name: string }, RenameItemOperations>(
    { 'users||1': { name: 'Ada' }, 'users||2': { name: 'Bob' } },
    {
      id: storeName,
      getSessionKey: () => sessionKey,
      storeManager,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: collectionSchema,
        payloadSchema: rc_string,
        offline: {
          operations: {
            renameItem: {
              inputSchema: rc_object({ id: rc_string, name: rc_string }),
              kind: 'update',
              getEntityRefs: ({ input }) => [input.id],
              execute: ({ input }) => {
                replayedInputs.push(input);
                return env.serverTable
                  .delayedUpdateItem(input.id, { name: input.name })
                  .then(() => ({ value: { name: input.name } }));
              },
              onSuccessExecute: ({ input }) => {
                env.apiStore.updateItemState(input.id, () => ({
                  value: { name: input.name },
                }));
              },
            },
          },
        },
      },
    },
  );

  // The direct request of a rename: it fails while the device is offline
  function renameItem(id: string, name: string) {
    return env.apiStore.performMutation(id, {
      optimisticUpdate: () => {
        env.apiStore.updateItemState(id, () => ({ value: { name } }));
      },
      mutation: async () => {
        if (network.isOffline()) throw new Error('Failed to fetch');
        await env.serverTable.delayedUpdateItem(id, { name });
        return { value: { name } };
      },
      offline: { operation: 'renameItem', input: { id, name } },
    });
  }

  await Promise.resolve();

  // -- Offline mode on: a rename made offline is queued --
  const queuedResult = await renameItem('users||1', 'Grace');
  expect(queuedResult.ok && queuedResult.value).toMatchInlineSnapshot(`
    kind: 'queued'
  `);
  statusChanges.addMark('Rename queued offline');
  statusChanges.add(getGlobalOfflineStatusSummary(sessionKey));

  // -- The workspace loses offline mode while the rename is still queued --
  workspaceHasOfflineMode = false;
  storeManager.setOfflineRuntimeConfig({}).unwrap();
  await Promise.resolve();
  // The session still follows the connection, so the queued rename waits for
  // it to come back instead of being sent (and failing) while offline
  statusChanges.addMark('Workspace loses offline mode, still offline');
  statusChanges.add(getGlobalOfflineStatusSummary(sessionKey));
  // No new work is queued for a lost connection anymore
  expect(storeManager.getOfflineRuntimeConfig().mutationQueueing)
    .toMatchInlineSnapshot(`
      network: 'disallow'
      outage: 'disallow'
    `);

  // -- A new rename made offline is not queued --
  const failedResult = await renameItem('users||2', 'Linus');
  // It fails like a plain online mutation: the error reaches the caller and
  // the optimistic rename is rolled back
  expect({ error: failedResult.ok ? null : failedResult.error })
    .toMatchInlineSnapshot(`
      error{Error}:
        message: 'Failed to fetch'
        name: 'StoreMutationError'
        kind: 'error'
        code: 500
        id: 'fetch-error'
        cause:
          Error#: { message: 'Failed to fetch', name: 'Error' }
    `);
  expect(env.apiStore.getItemState('users||2')?.data).toMatchInlineSnapshot(`
    value: { name: 'Bob' }
  `);
  // Only the rename queued before is waiting, and it was never attempted
  expect(
    getSortedQueueSummary(sessionKey, storeName, [
      'input',
      'attempts',
      'syncState',
    ]),
  ).toMatchInlineSnapshot(`
    - attempts: 0
      input: { id: 'users||1', name: 'Grace' }
      syncState: 'pending'
  `);
  expect(replayedInputs).toMatchInlineSnapshot(`[]`);

  // -- The connection comes back --
  act(() => {
    network.goOnline();
  });
  // The queued rename is being sent
  await advanceTime(10);
  expect(replayedInputs).toMatchInlineSnapshot(`
    - { id: 'users||1', name: 'Grace' }
  `);

  // -- The user renames the same item again while the old rename is sent --
  const renameWhileReplaying = renameItem('users||1', 'Grace Hopper');
  await flushAllTimers();
  // Sent on its own, it could reach the server before the older rename,
  // which would then overwrite it: it joins the queue behind it instead
  const renameWhileReplayingResult = await renameWhileReplaying;
  expect(renameWhileReplayingResult.ok && renameWhileReplayingResult.value)
    .toMatchInlineSnapshot(`
      kind: 'queued'
    `);
  statusChanges.addMark('Back online');
  statusChanges.add(getGlobalOfflineStatusSummary(sessionKey));

  // Both renames reached the server, in the order they were made
  expect(replayedInputs).toMatchInlineSnapshot(`
    - { id: 'users||1', name: 'Grace' }
    - { id: 'users||1', name: 'Grace Hopper' }
  `);
  expect(env.serverTable.get('users||1')).toMatchInlineSnapshot(`
    name: 'Grace Hopper'
  `);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
    `[]`,
  );

  // -- With an empty queue, a rename runs as a plain online mutation --
  const onlineResult = await resolveAfterAllTimers(
    renameItem('users||2', 'Linus'),
  );
  expect(onlineResult.ok && onlineResult.value).toMatchInlineSnapshot(`
    data:
      value: { name: 'Linus' }

    kind: 'online'
  `);

  expect(statusChanges.changesSnapshot).toMatchInlineSnapshot(`
    "

    >>> Rename queued offline

    ┌─
    ⋅ isOfflineMode: ✅
    ⋅ network: {enabled:✅, active:✅}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: gate-replay-only
    └─

    >>> Workspace loses offline mode, still offline

    ┌─
    ⋅ isOfflineMode: ✅
    ⋅ network: {enabled:✅, active:✅}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: gate-replay-only
    └─

    >>> Back online

    ┌─
    ⋅ isOfflineMode: ❌
    ⋅ network: {enabled:✅, active:❌}
    ⋅ outage: {enabled:❌, active:❌}
    ⋅ sessionKey: gate-replay-only
    └─
    "
  `);
});
