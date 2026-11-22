import { typingTest } from '@ls-stack/utils/typingTestUtils';
import type { Result } from 't-result';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type {
  CollectionStore,
  DefineCollectionOfflineOperations,
  DefineOfflineOperation,
  DocumentStore,
  ListQueryStore,
  MutationSkipped,
  OfflineMutationInput,
  OfflineMutationResult,
  OfflineMutationUploadsInput,
  StoreMutationError,
} from '../../src/main';
import { createStoreManager } from '../../src/storeManager';
import { createOfflineNetworkMock } from '../../src/testing';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import type { ListQueryParams } from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import {
  type PatchUserOperations,
  type UpdateValueExecuteContext,
  type UpdateValueOperations,
} from '../offline/offlineReplayTestShared';
import {
  docMutationInputSchema,
  docSchema,
} from '../offline/offlineTestShared';
import {
  flushAllTimers,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import { resetSessionForTests } from '../utils/resetSessionForTests';

// An app often decides at runtime whether a mutation may be queued offline
// (a per-workspace setting, a field type that can't be replayed, ...). It
// passes `offline: descriptor | undefined` (and the matching optional
// `upload`) in one `performMutation(...)` call instead of writing the call
// twice, and gets the union of both result types.

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

type MutationResult<T> = Result<T, StoreMutationError | MutationSkipped>;

test('one performMutation call with an optional offline descriptor runs online-only or offline-capable saves', async () => {
  const sessionKey = 'optional-offline-descriptor-document';
  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    getSessionKey: () => sessionKey,
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: { network: network.config },
    }),
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        operations: {
          updateValue: {
            inputSchema: docMutationInputSchema,
            kind: 'update',
            execute: async ({ input }: UpdateValueExecuteContext) => {
              await env.serverMock.delayedSetData(input.value);
              return input;
            },
            onSuccessExecute: ({ input }) => {
              env.apiStore.updateState((draft) => {
                draft.value = input.value;
              });
            },
          },
        },
      },
    },
  });

  // The app's single save helper: only some saves may be queued offline.
  function saveValue(value: number, canQueueOffline: boolean) {
    return env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value = value;
        });
      },
      mutation: async () => {
        await env.serverMock.delayedSetData(value);
        return value;
      },
      offline: canQueueOffline
        ? { operation: 'updateValue', input: { value } }
        : undefined,
    });
  }

  // The result is the direct value or an `OfflineMutationResult`.
  typingTest.expectTypesAreEqual<
    Awaited<ReturnType<typeof saveValue>>,
    MutationResult<number | OfflineMutationResult<number>>
  >();

  await flushAllTimers();

  // Online, without a descriptor: the direct server value, as with the
  // online-only overload.
  const onlineOnly = await resolveAfterAllTimers(saveValue(2, false));
  // Online, with a descriptor: the request is sent directly.
  const offlineCapableWhileOnline = await resolveAfterAllTimers(
    saveValue(3, true),
  );

  // Offline, with a descriptor: the save is queued for replay.
  network.goOffline();
  await flushAllTimers();
  const offlineCapableWhileOffline = await resolveAfterAllTimers(
    saveValue(4, true),
  );

  expect({
    onlineOnly: onlineOnly.unwrap(),
    offlineCapableWhileOnline: offlineCapableWhileOnline.unwrap(),
    offlineCapableWhileOffline: offlineCapableWhileOffline.unwrap(),
  }).toMatchInlineSnapshot(`
    offlineCapableWhileOffline: { kind: 'queued' }
    offlineCapableWhileOnline: { data: 3, kind: 'online' }
    onlineOnly: 2
  `);
});

type Todo = { title: string };
type TodoOperations = DefineCollectionOfflineOperations<
  Todo,
  string,
  { renameTodo: DefineOfflineOperation<{ id: string; title: string }> }
>;
type User = { id: number; name: string };

/**
 * Type-level checks of the three stores, never called: the assertions are the
 * `typingTest` calls, which fail `pnpm tsc` when a type regresses.
 */
function optionalOfflineDescriptorTypes(
  documentStore: DocumentStore<{ value: number }, UpdateValueOperations>,
  collectionStore: CollectionStore<Todo, string, TodoOperations>,
  listQueryStore: ListQueryStore<
    User,
    ListQueryParams,
    string,
    false,
    PatchUserOperations
  >,
  // Descriptors and attachments the app only has for some saves
  documentOffline: OfflineMutationInput<UpdateValueOperations> | undefined,
  collectionOffline: OfflineMutationInput<TodoOperations> | undefined,
  listQueryOffline: OfflineMutationInput<PatchUserOperations> | undefined,
  upload: OfflineMutationUploadsInput | undefined,
  // Item targets the app only has for some saves (`null` for a create)
  maybeCollectionTarget: string | null,
  maybeListQueryTarget: string | null,
) {
  const mutation = () => Promise.resolve(1);

  // Document store: optional descriptor, together with an optional `upload`
  const documentResult = documentStore.performMutation({
    mutation,
    offline: documentOffline,
    upload,
  });
  typingTest.expectTypesAreEqual<
    Awaited<typeof documentResult>,
    MutationResult<number | OfflineMutationResult<number>>
  >();

  // Collection store, with an item target and with `null`
  const collectionResult = collectionStore.performMutation('1', {
    mutation,
    offline: collectionOffline,
    upload,
  });
  typingTest.expectTypesAreEqual<
    Awaited<typeof collectionResult>,
    MutationResult<number | OfflineMutationResult<number>>
  >();
  const collectionCreateResult = collectionStore.performMutation(null, {
    mutation,
    offline: collectionOffline,
    upload,
  });
  typingTest.expectTypesAreEqual<
    Awaited<typeof collectionCreateResult>,
    MutationResult<number | OfflineMutationResult<number>>
  >();

  // List query store, with an item target and with `null`
  const listQueryResult = listQueryStore.performMutation('users||1', {
    mutation,
    offline: listQueryOffline,
    upload,
  });
  typingTest.expectTypesAreEqual<
    Awaited<typeof listQueryResult>,
    MutationResult<number | OfflineMutationResult<number>>
  >();
  const listQueryCreateResult = listQueryStore.performMutation(null, {
    mutation,
    offline: listQueryOffline,
    upload,
  });
  typingTest.expectTypesAreEqual<
    Awaited<typeof listQueryCreateResult>,
    MutationResult<number | OfflineMutationResult<number>>
  >();

  // A target that may be missing (`target | null`) is accepted too, with the
  // same union result
  const collectionMaybeTargetResult = collectionStore.performMutation(
    maybeCollectionTarget,
    { mutation, offline: collectionOffline, upload },
  );
  typingTest.expectTypesAreEqual<
    Awaited<typeof collectionMaybeTargetResult>,
    MutationResult<number | OfflineMutationResult<number>>
  >();
  const listQueryMaybeTargetResult = listQueryStore.performMutation(
    maybeListQueryTarget,
    { mutation, offline: listQueryOffline, upload },
  );
  typingTest.expectTypesAreEqual<
    Awaited<typeof listQueryMaybeTargetResult>,
    MutationResult<number | OfflineMutationResult<number>>
  >();

  // ... but never with `optimisticUpdate`: with `null` there are no items to
  // snapshot, so a failed mutation could not roll the optimistic changes back.
  // The overload for a `target | null` payload (the last one, which
  // `Parameters` resolves) has no `optimisticUpdate` option.
  type CollectionMaybeTargetArgs = Parameters<
    typeof collectionStore.performMutation
  >;
  type ListQueryMaybeTargetArgs = Parameters<
    typeof listQueryStore.performMutation
  >;
  typingTest.expectTypesAreEqual<
    CollectionMaybeTargetArgs[0],
    string | string[] | null
  >();
  typingTest.expectTypesAreEqual<
    'optimisticUpdate' extends keyof CollectionMaybeTargetArgs[1]
      ? true
      : false,
    false
  >();
  typingTest.expectTypesAreEqual<
    null extends ListQueryMaybeTargetArgs[0] ? true : false,
    true
  >();
  typingTest.expectTypesAreEqual<
    'optimisticUpdate' extends keyof ListQueryMaybeTargetArgs[1] ? true : false,
    false
  >();

  // The other overloads keep their narrower results: no descriptor gives the
  // direct value, a descriptor always given gives `OfflineMutationResult`.
  const onlineResult = documentStore.performMutation({ mutation });
  typingTest.expectTypesAreEqual<
    Awaited<typeof onlineResult>,
    MutationResult<number>
  >();
  const offlineResult = collectionStore.performMutation('1', {
    mutation,
    offline: { operation: 'renameTodo', input: { id: '1', title: 'Todo' } },
    upload,
  });
  typingTest.expectTypesAreEqual<
    Awaited<typeof offlineResult>,
    MutationResult<OfflineMutationResult<number>>
  >();
}

void optionalOfflineDescriptorTypes;
