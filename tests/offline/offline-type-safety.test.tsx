import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { CollectionOfflineOperationDefinition } from '../../src/main';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import type {
  PatchUserOperations,
  UpdateValueOperations,
} from './offlineReplayTestShared';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

test('type safety: document test env requires explicit offline operation typing', () => {
  const plainEnv = createDocumentStoreTestEnv(1);
  const typedEnv = createDocumentStoreTestEnv<number, UpdateValueOperations>(1);

  // Type-only assertions: the function is never executed.
  function typeCheck_() {
    void plainEnv.apiStore.performMutation({
      mutation: () => Promise.resolve(2),
      // @ts-expect-error - offline mutations should not be available by default
      offline: { operation: 'updateValue', input: { value: 2 } },
    });

    void plainEnv.apiStore.performMutation({
      mutation: () => Promise.resolve(2),
      // @ts-expect-error - offline mutations should not be available by default
      offline: [
        { operation: 'updateValue', input: { value: 2 } },
        { operation: 'updateValue', input: { value: 3 } },
      ],
    });

    void typedEnv.apiStore.performMutation({
      mutation: () => Promise.resolve(2),
      offline: { operation: 'updateValue', input: { value: 2 } },
    });

    void typedEnv.apiStore.performMutation({
      mutation: () => Promise.resolve(2),
      offline: [
        { operation: 'updateValue', input: { value: 2 } },
        { operation: 'updateValue', input: { value: 3 } },
      ],
    });

    async function queuedOfflineResultType_() {
      const queued = await typedEnv.apiStore.performMutation({
        mutation: () => Promise.resolve(2),
        offline: { operation: 'updateValue', input: { value: 2 } },
      });

      if (queued.ok) {
        const queuedValue:
          | { kind: 'online'; data: number }
          | { kind: 'queued' } = queued.value;
        void queuedValue;

        if (queued.value.kind === 'online') {
          const serverValue: number = queued.value.data;
          void serverValue;
        }

        // @ts-expect-error - queued offline mutations do not always expose a server payload directly
        const serverValue: number = queued.value.data;
        void serverValue;
      }
    }

    async function onlineResultType_() {
      const result = await typedEnv.apiStore.performMutation({
        mutation: () => Promise.resolve(2),
      });

      if (result.ok) {
        const serverValue: number = result.value;
        void serverValue;
      }
    }

    void queuedOfflineResultType_;
    void onlineResultType_;
  }

  void typeCheck_;
  expect(true).toBe(true);
});

type RenameCollectionItemOperations = {
  renameItem: CollectionOfflineOperationDefinition<
    { value: { name: string } },
    string,
    { name: string }
  >;
};

test('type safety: collection test env requires explicit offline operation typing', () => {
  const initialCollectionData = { 'users||1': { name: 'Ada' } };
  const plainEnv = createCollectionStoreTestEnv(initialCollectionData);
  const typedEnv = createCollectionStoreTestEnv<
    { name: string },
    RenameCollectionItemOperations
  >(initialCollectionData);

  function typeCheck_() {
    void plainEnv.apiStore.performMutation('users||1', {
      mutation: () => Promise.resolve({ value: { name: 'Grace' } }),
      // @ts-expect-error - offline mutations should not be available by default
      offline: { operation: 'renameItem', input: { name: 'Grace' } },
    });

    void plainEnv.apiStore.performMutation('users||1', {
      mutation: () => Promise.resolve({ value: { name: 'Grace' } }),
      // @ts-expect-error - offline mutations should not be available by default
      offline: [
        { operation: 'renameItem', input: { name: 'Grace' } },
        { operation: 'renameItem', input: { name: 'Linus' } },
      ],
    });

    void typedEnv.apiStore.performMutation('users||1', {
      mutation: () => Promise.resolve({ value: { name: 'Grace' } }),
      offline: { operation: 'renameItem', input: { name: 'Grace' } },
    });

    void typedEnv.apiStore.performMutation('users||1', {
      mutation: () => Promise.resolve({ value: { name: 'Grace' } }),
      offline: [
        { operation: 'renameItem', input: { name: 'Grace' } },
        { operation: 'renameItem', input: { name: 'Linus' } },
      ],
    });

    async function queuedOfflineResultType_() {
      const queued = await typedEnv.apiStore.performMutation('users||1', {
        mutation: () => Promise.resolve({ value: { name: 'Grace' } }),
        offline: { operation: 'renameItem', input: { name: 'Grace' } },
      });

      if (queued.ok) {
        const queuedValue:
          | { kind: 'online'; data: { value: { name: string } } }
          | { kind: 'queued' } = queued.value;
        void queuedValue;

        if (queued.value.kind === 'online') {
          const serverValue: { value: { name: string } } = queued.value.data;
          void serverValue;
        }

        // @ts-expect-error - queued offline mutations do not always expose a server payload directly
        const serverValue: { value: { name: string } } = queued.value.data;
        void serverValue;
      }
    }

    async function onlineResultType_() {
      const result = await typedEnv.apiStore.performMutation('users||1', {
        mutation: () => Promise.resolve({ value: { name: 'Grace' } }),
      });

      if (result.ok) {
        const serverValue: { value: { name: string } } = result.value;
        void serverValue;
      }
    }

    void queuedOfflineResultType_;
    void onlineResultType_;
  }

  void typeCheck_;
  expect(true).toBe(true);
});

test('type safety: list-query test env requires explicit offline operation typing', () => {
  const initialTables = { users: [{ id: 1, name: 'Ada' }] };
  const plainEnv = createListQueryStoreTestEnv(initialTables);
  const typedEnv = createListQueryStoreTestEnv<
    { id: number; name: string },
    false,
    false,
    PatchUserOperations
  >(initialTables);

  function typeCheck_() {
    void plainEnv.apiStore.performMutation('users||1', {
      mutation: () => Promise.resolve({ name: 'Ada offline' }),
      // @ts-expect-error - offline mutations should not be available by default
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||1', name: 'Ada offline' },
      },
    });

    void plainEnv.apiStore.performMutation('users||1', {
      mutation: () => Promise.resolve({ name: 'Ada offline' }),
      // @ts-expect-error - offline mutations should not be available by default
      offline: [
        {
          operation: 'patchUserName',
          input: { itemId: 'users||1', name: 'Ada offline' },
        },
        {
          operation: 'patchUserName',
          input: { itemId: 'users||1', name: 'Ada queued again' },
        },
      ],
    });

    void typedEnv.apiStore.performMutation('users||1', {
      mutation: () => Promise.resolve({ name: 'Ada offline' }),
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||1', name: 'Ada offline' },
      },
    });

    void typedEnv.apiStore.performMutation('users||1', {
      mutation: () => Promise.resolve({ name: 'Ada offline' }),
      offline: [
        {
          operation: 'patchUserName',
          input: { itemId: 'users||1', name: 'Ada offline' },
        },
        {
          operation: 'patchUserName',
          input: { itemId: 'users||1', name: 'Ada queued again' },
        },
      ],
    });

    async function queuedOfflineResultType_() {
      const queued = await typedEnv.apiStore.performMutation('users||1', {
        mutation: () => Promise.resolve({ name: 'Ada offline' }),
        offline: {
          operation: 'patchUserName',
          input: { itemId: 'users||1', name: 'Ada offline' },
        },
      });

      if (queued.ok) {
        const queuedValue:
          | { kind: 'online'; data: { name: string } }
          | { kind: 'queued' } = queued.value;
        void queuedValue;

        if (queued.value.kind === 'online') {
          const serverValue: { name: string } = queued.value.data;
          void serverValue;
        }

        // @ts-expect-error - queued offline mutations do not always expose a server payload directly
        const serverValue: { name: string } = queued.value.data;
        void serverValue;
      }
    }

    async function onlineResultType_() {
      const result = await typedEnv.apiStore.performMutation('users||1', {
        mutation: () => Promise.resolve({ name: 'Ada offline' }),
      });

      if (result.ok) {
        const serverValue: { name: string } = result.value;
        void serverValue;
      }
    }

    void queuedOfflineResultType_;
    void onlineResultType_;
  }

  void typeCheck_;
  expect(true).toBe(true);
});
