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
import * as byteBudgetTestUtils from '../persistentStorageByteBudgetTestUtils';

export function sumPersistedEntryBytes(...sizes: number[]): number {
  return byteBudgetTestUtils.sumPersistedEntryBytes(...sizes);
}

export function getLocalCollectionEntrySizeBytes<T>(
  payload: string,
  data: T,
  version?: number,
): number {
  return byteBudgetTestUtils.getLocalCollectionEntrySizeBytes(
    payload,
    data,
    version,
  );
}

export function getLocalListItemEntrySizeBytes<T>(
  payload: string,
  data: T,
  options: { loadedFields?: string[]; version?: number } = {},
): number {
  return byteBudgetTestUtils.getLocalListItemEntrySizeBytes(
    payload,
    data,
    options,
  );
}

export function getLocalListQueryEntrySizeBytes(
  payload: unknown,
  items: string[],
  options: { hasMore?: boolean; lastAccessAt?: number; version?: number } = {},
): number {
  return byteBudgetTestUtils.getLocalListQueryEntrySizeBytes(
    payload,
    items,
    options,
  );
}

export const wrappedDocumentSchema = rc_object({
  value: rc_object({ name: rc_string, value: rc_number }),
});

const wrappedCollectionItemSchema = rc_object({
  value: rc_object({ id: rc_string, name: rc_string }),
});

const rowSchema = __LEGIT_CAST__<PersistentStorageSchema<Row>, unknown>(
  rc_object({
    id: rc_number,
    name: rc_string,
    age: rc_number.optional(),
    email: rc_string.optional(),
  }),
);

const listQueryParamsSchema = rc_object({ tableId: rc_string });

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

export async function waitForScheduledCleanup(delayMs = 12_100): Promise<void> {
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

type HookRemountSettleMode = 'flushAllTimers' | 'none';

export async function captureHookRemount<Result>(
  render: () => Result,
  options: {
    firstMountSettleMode?: HookRemountSettleMode;
    remountSettleMode?: HookRemountSettleMode;
  } = {},
) {
  const settleCapturedMount = async (
    mode: HookRemountSettleMode = 'flushAllTimers',
  ) => {
    if (mode === 'flushAllTimers') {
      await flushAllTimers();
    }
  };

  const firstMountCapture = startPersistentStorageOperationCapture();
  const firstHook = renderHook(render);
  await settleCapturedMount(options.firstMountSettleMode);
  const firstMountOperations = firstMountCapture.finish().timelineString;

  firstHook.unmount();

  const remountCapture = startPersistentStorageOperationCapture();
  const secondHook = renderHook(render);
  await settleCapturedMount(options.remountSettleMode);
  const remountOperations = remountCapture.finish().timelineString;

  return { secondHook, firstMountOperations, remountOperations };
}

type DocumentState = { name: string; value: number };

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
      id: options.storeName,
      getSessionKey: () => options.sessionKey ?? 'session1',
      persistentStorage: {
        adapter: 'local-sync',
        schema: wrappedDocumentSchema,
      },
    },
  );
}

type CollectionItemState = { id: string; name: string };

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
  maxBytes?: number;
  serverData?: Record<string, CollectionItemState>;
}) {
  return createCollectionStoreTestEnv(options.serverData ?? {}, {
    id: options.storeName,
    getSessionKey: () => options.sessionKey ?? 'session1',
    persistentStorage: {
      adapter: 'local-sync',
      schema: wrappedCollectionItemSchema,
      payloadSchema: rc_string,
      maxBytes: options.maxBytes,
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
  maxItemBytes?: number;
  maxQueryBytes?: number;
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
      adapter: 'local-sync',
      schema: rowSchema,
      itemPayloadSchema: rc_string,
      queryPayloadSchema: listQueryParamsSchema,
      maxItemBytes: options.maxItemBytes,
      maxQueryBytes: options.maxQueryBytes,
      maxQuerySize: options.maxQuerySize,
    },
  });
}
