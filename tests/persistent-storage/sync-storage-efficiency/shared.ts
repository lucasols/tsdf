import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { renderHook } from '@testing-library/react';
import { rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeAll, beforeEach, vi } from 'vitest';

import type { OffsetPaginationConfig } from '../../../src/listQueryStore/types';
import { resetManagedLocalStorageState } from '../../../src/persistentStorage/localStorageMetadata';
import { resetExpirationScanTracking } from '../../../src/persistentStorage/persistentStorageManager';
import type {
  PersistentStorageSchema,
  StorageCacheEntry,
} from '../../../src/persistentStorage/types';
import { createCollectionStoreTestEnv } from '../../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../../mocks/documentStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
  type Row,
  type Tables,
} from '../../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../../mocks/testEnvUtils';
import {
  advanceTime,
  flushAllTimers,
  waitForScheduledCleanup as waitForScheduledCleanupHelper,
} from '../../utils/genericTestUtils';
import { startPersistentStorageOperationCapture } from '../../utils/persistentStorageOptimizationTestUtils';
import { createLocalStoragePersistentTestStore } from '../../utils/persistentStorageTestStore';

export const wrappedDocumentSchema = rc_object({
  value: rc_object({ name: rc_string, value: rc_number }),
});

export const wrappedCollectionItemSchema = rc_object({
  value: rc_object({ id: rc_string, name: rc_string }),
});

export const rowSchema = __LEGIT_CAST__<PersistentStorageSchema<Row>, unknown>(
  rc_object({
    id: rc_number,
    name: rc_string,
    age: rc_number.optional(),
    email: rc_string.optional(),
  }),
);

export const listQueryParamsSchema = rc_object({ tableId: rc_string });

export const persistentStore = createLocalStoragePersistentTestStore();

function listLocalStorageKeysByPrefix(prefix: string): string[] {
  const keys: string[] = [];

  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) {
      keys.push(key);
    }
  }

  return keys;
}

export function setupSyncStorageEfficiencyTestSuite(): void {
  beforeAll(() => {
    vi.useFakeTimers();
  });

  beforeEach(() => {
    resetExpirationScanTracking();
    vi.setSystemTime(TEST_INITIAL_TIME);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    localStorage.clear();
    resetManagedLocalStorageState();
  });
}

export async function waitForScheduledCleanup(delayMs = 2100): Promise<void> {
  await waitForScheduledCleanupHelper(delayMs);
}

export async function settleStartupBackgroundScan(): Promise<void> {
  // Creating a local-sync persistence handle schedules the one-off global scan.
  // Drain it before capturing operation-specific traces so snapshots stay focused.
  await waitForScheduledCleanup();
}

export async function flushInvalidationPersistence(
  delayMs = 1100,
): Promise<void> {
  await flushAllTimers();
  await advanceTime(delayMs);
  await flushAllTimers();
}

export async function captureHookRemount<Result>(render: () => Result) {
  const firstMountCapture = startPersistentStorageOperationCapture();
  const firstHook = renderHook(render);
  await flushAllTimers();
  const firstMountOperations = firstMountCapture.finish().timelineString;

  firstHook.unmount();

  const remountCapture = startPersistentStorageOperationCapture();
  const secondHook = renderHook(render);
  await flushAllTimers();
  const remountOperations = remountCapture.finish().timelineString;

  return { secondHook, firstMountOperations, remountOperations };
}

export type DocumentState = { name: string; value: number };

export function setCachedDocumentData(
  storeName: string,
  sessionKey: string,
  data: DocumentState,
): string {
  return persistentStore
    .scope(storeName, sessionKey)
    .document.seed({ value: data });
}

export function createDocumentEnv(options: {
  storeName: string;
  sessionKey?: string;
  serverData?: DocumentState;
}) {
  return createDocumentStoreTestEnv(
    options.serverData ?? { name: 'test', value: 42 },
    {
      getSessionKey: () => options.sessionKey ?? 'session1',
      persistentStorage: {
        storeName: options.storeName,
        adapter: 'local-sync',
        schema: wrappedDocumentSchema,
      },
    },
  );
}

export type CollectionItemState = { id: string; name: string };

type PersistedCollectionItemState = { value: CollectionItemState };

export function setCachedCollectionItem(
  storeName: string,
  sessionKey: string,
  payload: string,
  data: PersistedCollectionItemState,
): string {
  return persistentStore
    .scope(storeName, sessionKey)
    .collection.seedItem(payload, data);
}

export function listStoredCollectionItemPayloads(
  storeName: string,
  sessionKey: string,
): string[] {
  const prefix = `tsdf.${sessionKey}.${storeName}.ci.`;
  const payloads: string[] = [];

  for (const key of listLocalStorageKeysByPrefix(prefix)) {
    const rawEntry = localStorage.getItem(key);
    if (rawEntry === null) continue;

    const entry = __LEGIT_CAST__<
      | StorageCacheEntry<{
          data: PersistedCollectionItemState;
          payload: string;
        }>
      | { p: string },
      unknown
    >(JSON.parse(rawEntry));
    payloads.push('p' in entry ? entry.p : entry.data.payload);
  }

  return payloads;
}

export function createCollectionEnv(options: {
  storeName: string;
  sessionKey?: string;
  maxItems?: number;
  serverData?: Record<string, CollectionItemState>;
}) {
  return createCollectionStoreTestEnv(options.serverData ?? {}, {
    getSessionKey: () => options.sessionKey ?? 'session1',
    persistentStorage: {
      storeName: options.storeName,
      adapter: 'local-sync',
      schema: wrappedCollectionItemSchema,
      payloadSchema: rc_string,
      maxItems: options.maxItems,
    },
  });
}

export function rawItemPayload(tableId: string, id: number): string {
  return `${tableId}||${id}`;
}

export function storeItemKey(tableId: string, id: number): string {
  return getCompositeKey(rawItemPayload(tableId, id));
}

export function setCachedItem(
  storeName: string,
  sessionKey: string,
  tableId: string,
  id: number,
  data: Row,
): string {
  return persistentStore
    .scope(storeName, sessionKey)
    .listQuery.seedItem(tableId, id, data).storageKey;
}

export function setCachedQuery(
  storeName: string,
  sessionKey: string,
  params: ListQueryParams,
  items: string[],
  hasMore = false,
): string {
  return persistentStore
    .scope(storeName, sessionKey)
    .listQuery.seedQuery(params, items, { hasMore });
}

export function listStoredKeys(prefix: string): string[] {
  return listLocalStorageKeysByPrefix(prefix).map((key) =>
    key.slice(prefix.length),
  );
}

export function createListQueryEnv(options: {
  storeName: string;
  sessionKey?: string;
  maxItems?: number;
  maxQueries?: number;
  maxQuerySize?: number;
  serverData?: Tables<Row>;
  offsetPagination?: OffsetPaginationConfig;
  defaultQuerySize?: number;
}) {
  return createListQueryStoreTestEnv(options.serverData ?? {}, {
    id: options.storeName,
    getSessionKey: () => options.sessionKey ?? 'session1',
    offsetPagination: options.offsetPagination,
    defaultQuerySize: options.defaultQuerySize,
    persistentStorage: {
      storeName: options.storeName,
      adapter: 'local-sync',
      schema: rowSchema,
      itemPayloadSchema: rc_string,
      queryPayloadSchema: listQueryParamsSchema,
      maxItems: options.maxItems,
      maxQueries: options.maxQueries,
      maxQuerySize: options.maxQuerySize,
    },
  });
}
