import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { renderHook } from '@testing-library/react';
import { rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeAll, beforeEach, vi } from 'vitest';
import type { OffsetPaginationConfig } from '../../../src/listQueryStore/types';
import {
  createAsyncStorageAdapter,
  serializeProtectedRef,
} from '../../../src/persistentStorage/asyncStorageAdapter';
import { DOCUMENT_PERSISTED_ENTRY_KEY } from '../../../src/persistentStorage/documentEntryKey';
import {
  clearSessionProtectedKeysSnapshot,
  setSessionProtectedKeysSnapshot,
} from '../../../src/persistentStorage/offline/sessionProtectionRegistry';
import { OpfsAsyncStorageDriver } from '../../../src/persistentStorage/opfsAsyncStorageAdapter';
import { opfsPersistentStorage } from '../../../src/persistentStorage/storageAdapter';
import type { PersistentStorageSchema } from '../../../src/persistentStorage/types';
import { createCollectionStoreTestEnv } from '../../mocks/collectionStoreTestEnv';
import {
  createDocumentStoreTestEnv,
  type DocumentStoreTestScenario,
} from '../../mocks/documentStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  type Row,
  type Tables,
} from '../../mocks/listQueryStoreTestEnv';
import { resetMockBrowserOpfsForTests } from '../../mocks/mockBrowserOpfs';
import { TEST_INITIAL_TIME } from '../../mocks/testEnvUtils';
import {
  advanceTime,
  flushAllTimers,
  resolveAfterAllTimers,
} from '../../utils/genericTestUtils';
import { createOpfsPersistentStorageTestStore } from '../../utils/opfsPersistentStorageTestStore';
import { startOpfsPersistentStorageOperationCapture } from '../../utils/persistentStorageOptimizationTestUtils';
import * as byteBudgetTestUtils from '../persistentStorageByteBudgetTestUtils';

export function sumPersistedEntryBytes(...sizes: number[]): number {
  return byteBudgetTestUtils.sumPersistedEntryBytes(...sizes);
}

export function getAsyncCollectionEntrySizeBytes<T>(
  payload: string,
  data: T,
): number {
  return byteBudgetTestUtils.getAsyncCollectionEntrySizeBytes(payload, data);
}

export function getAsyncListItemEntrySizeBytes<T>(
  payload: string,
  data: T,
  options: { loadedFields?: string[] } = {},
): number {
  return byteBudgetTestUtils.getAsyncListItemEntrySizeBytes(
    payload,
    data,
    options,
  );
}

export function getAsyncListQueryEntrySizeBytes(
  payload: unknown,
  items: string[],
  options: { hasMore?: boolean } = {},
): number {
  return byteBudgetTestUtils.getAsyncListQueryEntrySizeBytes(
    payload,
    items,
    options,
  );
}

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

export function setupAsyncStorageEfficiencyTestSuite(): void {
  beforeAll(() => {
    vi.useFakeTimers();
  });

  beforeEach(() => {
    vi.setSystemTime(TEST_INITIAL_TIME);
    resetMockBrowserOpfsForTests();
    opfsPersistentStorage.resetForTests?.();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    localStorage.clear();
    resetMockBrowserOpfsForTests();
    opfsPersistentStorage.resetForTests?.();
    clearSessionProtectedKeysSnapshot('sess1');
    clearSessionProtectedKeysSnapshot('session1');
    clearSessionProtectedKeysSnapshot('user@example.com');
    clearSessionProtectedKeysSnapshot('sess-trigger');
  });
}

export async function waitForScheduledCleanup(delayMs = 3000): Promise<void> {
  await advanceTime(delayMs);
  await flushAllTimers();
}

export type MockOpfsAdapter = ReturnType<
  typeof createOpfsPersistentStorageTestStore
>;

export async function settleStartupBackgroundScan(
  mockAdapter: MockOpfsAdapter,
): Promise<void> {
  await waitForScheduledCleanup();
  mockAdapter.clearInstrumentation();
}

export async function flushInvalidationPersistence(
  delayMs = 1100,
): Promise<void> {
  await flushAllTimers();
  await advanceTime(delayMs);
  await flushAllTimers();
  await advanceTime(2100);
  await flushAllTimers();
}

export async function captureHookRemount<Result>(args: {
  mockAdapter: MockOpfsAdapter;
  render: () => Result;
  settleTimeMs?: number;
}) {
  const firstMountCapture = startOpfsPersistentStorageOperationCapture(
    args.mockAdapter,
  );
  const firstHook = renderHook(args.render);
  await advanceTime(args.settleTimeMs ?? 250);
  const firstMountOperations = firstMountCapture.finish().timelineString;

  firstHook.unmount();

  const remountCapture = startOpfsPersistentStorageOperationCapture(
    args.mockAdapter,
  );
  const secondHook = renderHook(args.render);
  await advanceTime(args.settleTimeMs ?? 250);
  const remountOperations = remountCapture.finish().timelineString;

  return { secondHook, firstMountOperations, remountOperations };
}

export type DocumentState = { name: string; value: number };

export function createDocumentEnv(options: {
  serverData?: DocumentState;
  sessionKey?: string;
  storeName: string;
  testScenario?: DocumentStoreTestScenario<DocumentState>;
}) {
  return createDocumentStoreTestEnv(
    options.serverData ?? { name: 'test', value: 42 },
    {
      id: options.storeName,
      getSessionKey: () => options.sessionKey ?? 'session1',
      testScenario: options.testScenario,
      persistentStorage: {
        adapter: opfsPersistentStorage,
        schema: wrappedDocumentSchema,
      },
    },
  );
}

export type CollectionItemState = { id: string; name: string };

export function createCollectionEnv(options: {
  maxBytes?: number;
  pinnedItems?: string[];
  serverData?: Record<string, CollectionItemState>;
  sessionKey?: string;
  storeName: string;
}) {
  return createCollectionStoreTestEnv(options.serverData ?? {}, {
    id: options.storeName,
    getSessionKey: () => options.sessionKey ?? 'session1',
    persistentStorage: {
      adapter: opfsPersistentStorage,
      schema: wrappedCollectionItemSchema,
      payloadSchema: rc_string,
      maxBytes: options.maxBytes,
      pinnedItems: options.pinnedItems,
    },
  });
}

export function rawItemPayload(tableId: string, id: number): string {
  return `${tableId}||${id}`;
}

export function storeItemKey(tableId: string, id: number): string {
  return getCompositeKey(rawItemPayload(tableId, id));
}

export function createListQueryEnv(options: {
  defaultQuerySize?: number;
  maxItemBytes?: number;
  maxQueryBytes?: number;
  maxQuerySize?: number;
  offsetPagination?: OffsetPaginationConfig;
  pinnedItems?: string[];
  pinnedQueries?: Array<{ tableId: string }>;
  serverData?: Tables<Row>;
  sessionKey?: string;
  storeName: string;
}) {
  return createListQueryStoreTestEnv(options.serverData ?? {}, {
    id: options.storeName,
    getSessionKey: () => options.sessionKey ?? 'session1',
    offsetPagination: options.offsetPagination,
    defaultQuerySize: options.defaultQuerySize,
    persistentStorage: {
      adapter: opfsPersistentStorage,
      schema: rowSchema,
      itemPayloadSchema: rc_string,
      queryPayloadSchema: listQueryParamsSchema,
      maxItemBytes: options.maxItemBytes,
      maxQueryBytes: options.maxQueryBytes,
      maxQuerySize: options.maxQuerySize,
      pinnedItems: options.pinnedItems,
      pinnedQueries: options.pinnedQueries,
    },
  });
}

export async function syncEntriesOfflineProtectedFromSiblingTab(
  sessionKey: string,
  keys: string[],
): Promise<void> {
  const siblingAdapter = createAsyncStorageAdapter(
    new OpfsAsyncStorageDriver(),
  );
  await resolveAfterAllTimers(
    siblingAdapter.syncSessionProtectedKeys(
      sessionKey,
      keys.map((key) => serializeProtectedStorageKey(key)),
      [],
    ),
  );
}

export function setProtectedKeysSnapshot(
  sessionKey: string,
  keys: string[],
): void {
  setSessionProtectedKeysSnapshot(
    sessionKey,
    keys.map((key) => serializeProtectedStorageKey(key)),
  );
}

function serializeProtectedStorageKey(storageKey: string): string {
  if (storageKey.includes('.ci.')) {
    return serializeProtectedNamespaceEntry(
      storageKey,
      '.ci.',
      'collection.item',
    );
  }

  if (storageKey.includes('.li.')) {
    return serializeProtectedNamespaceEntry(
      storageKey,
      '.li.',
      'listQuery.item',
    );
  }

  if (storageKey.includes('.lq.')) {
    return serializeProtectedNamespaceEntry(
      storageKey,
      '.lq.',
      'listQuery.query',
    );
  }

  const prefix = 'tsdf.';
  if (!storageKey.startsWith(prefix)) {
    throw new Error(`Unsupported protected storage key: ${storageKey}`);
  }

  const lastSeparatorIndex = storageKey.lastIndexOf('.');
  if (lastSeparatorIndex <= prefix.length) {
    throw new Error(`Unsupported protected storage key: ${storageKey}`);
  }

  return serializeProtectedRef({
    sessionKey: storageKey.slice(prefix.length, lastSeparatorIndex),
    storeName: storageKey.slice(lastSeparatorIndex + 1),
    key: DOCUMENT_PERSISTED_ENTRY_KEY,
    kind: 'document',
  });
}

function serializeProtectedNamespaceEntry(
  storageKey: string,
  marker: '.ci.' | '.li.' | '.lq.',
  kind: 'collection.item' | 'listQuery.item' | 'listQuery.query',
): string {
  const prefix = 'tsdf.';
  const markerIndex = storageKey.indexOf(marker);
  if (!storageKey.startsWith(prefix) || markerIndex < 0) {
    throw new Error(`Unsupported protected storage key: ${storageKey}`);
  }

  const beforeMarker = storageKey.slice(prefix.length, markerIndex);
  const lastSeparatorIndex = beforeMarker.lastIndexOf('.');
  if (lastSeparatorIndex < 0) {
    throw new Error(`Unsupported protected storage key: ${storageKey}`);
  }

  return serializeProtectedRef({
    sessionKey: beforeMarker.slice(0, lastSeparatorIndex),
    storeName: beforeMarker.slice(lastSeparatorIndex + 1),
    key: storageKey.slice(markerIndex + marker.length),
    kind,
  });
}
