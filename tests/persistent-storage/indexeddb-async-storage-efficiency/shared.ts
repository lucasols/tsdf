import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { act, cleanup, renderHook } from '@testing-library/react';
import { rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeAll, beforeEach, vi } from 'vitest';
import type { OffsetPaginationConfig } from '../../../src/listQueryStore/types';
import { serializeProtectedRef } from '../../../src/persistentStorage/asyncStorageAdapter';
import {
  clearSessionProtectedKeysSnapshot,
  setSessionProtectedKeysSnapshot,
} from '../../../src/persistentStorage/offline/sessionProtectionRegistry';
import { __resetSessionOfflineCoordinatorRegistryForTests } from '../../../src/persistentStorage/offline/sessionCoordinator';
import { resetExpirationScanTracking } from '../../../src/persistentStorage/persistentStorageManager';
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
import { TEST_INITIAL_TIME } from '../../mocks/testEnvUtils';
import {
  createIndexedDbPersistentStorageTestStore,
  getCurrentIndexedDbPersistentStorageTestStore,
  resetCurrentIndexedDbPersistentStorageTestStore,
} from '../../utils/indexedDbPersistentStorageTestStore';
import { startIndexedDbPersistentStorageOperationCapture } from '../../utils/indexedDbPersistentStorageOptimizationTestUtils';
import { advanceTime, flushAllTimers } from '../../utils/genericTestUtils';

export const wrappedDocumentSchema = rc_object({
  value: rc_object({ name: rc_string, value: rc_number }),
});

export const wrappedCollectionItemSchema = rc_object({
  value: rc_object({ id: rc_string, name: rc_string }),
});

export const rowSchema = __LEGIT_CAST__<PersistentStorageSchema<Row>, unknown>(
  rc_object({
    age: rc_number.optional(),
    email: rc_string.optional(),
    id: rc_number,
    name: rc_string,
  }),
);

export const listQueryParamsSchema = rc_object({ tableId: rc_string });
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const INDEXED_DB_REAL_TASK_SETTLE_PASSES = 20;
let pendingTestEnvDisposers: Array<() => void> = [];

async function waitForRealTaskTick(): Promise<void> {
  await new Promise<void>((resolve) => {
    realSetTimeout(resolve, 0);
  });
}

export type MockIndexedDbAdapter = ReturnType<
  typeof createIndexedDbPersistentStorageTestStore
>;

async function settleIndexedDbAsyncPhase(
  _mockAdapter?: MockIndexedDbAdapter,
): Promise<void> {
  for (let pass = 0; pass < INDEXED_DB_REAL_TASK_SETTLE_PASSES; pass++) {
    await Promise.resolve();
    await waitForRealTaskTick();
  }
}

async function waitForCapturedOperationsToSettle(
  mockAdapter: MockIndexedDbAdapter,
): Promise<void> {
  let previousOperationCount = -1;
  let stablePasses = 0;

  for (let pass = 0; pass < 80; pass++) {
    await Promise.resolve();
    await waitForRealTaskTick();

    const operationCount = mockAdapter.operations.length;
    stablePasses =
      operationCount === previousOperationCount ? stablePasses + 1 : 0;
    previousOperationCount = operationCount;

    if (operationCount > 0 && stablePasses >= 4) {
      return;
    }

    if (pass >= 12 && operationCount === 0 && stablePasses >= 4) {
      return;
    }
  }
}

export function setupIndexedDbAsyncStorageEfficiencyTestSuite(): void {
  beforeAll(() => {
    vi.useFakeTimers();
  });

  beforeEach(async () => {
    for (const dispose of pendingTestEnvDisposers.splice(0)) {
      dispose();
    }
    cleanup();
    vi.clearAllTimers();
    vi.setSystemTime(TEST_INITIAL_TIME);
    __resetSessionOfflineCoordinatorRegistryForTests();
    resetExpirationScanTracking();
    await resetCurrentIndexedDbPersistentStorageTestStore();
  });

  afterEach(async () => {
    for (const dispose of pendingTestEnvDisposers.splice(0)) {
      dispose();
    }
    cleanup();
    if (vi.isFakeTimers()) {
      await flushAllTimers();
    }
    localStorage.clear();
    __resetSessionOfflineCoordinatorRegistryForTests();
    resetExpirationScanTracking();
    await resetCurrentIndexedDbPersistentStorageTestStore();
    clearSessionProtectedKeysSnapshot('sess1');
    clearSessionProtectedKeysSnapshot('session1');
    clearSessionProtectedKeysSnapshot('user@example.com');
    clearSessionProtectedKeysSnapshot('sess-trigger');
  });
}

export const setupAsyncStorageEfficiencyTestSuite =
  setupIndexedDbAsyncStorageEfficiencyTestSuite;

export function createMockIndexedDbAdapter() {
  return createIndexedDbPersistentStorageTestStore();
}

export async function waitForScheduledCleanup(
  delayMs = 3000,
): Promise<void> {
  await advanceTime(delayMs);
  await settleIndexedDbStorage();
}

export async function settleStartupBackgroundScan(
  mockAdapter: MockIndexedDbAdapter,
): Promise<void> {
  await waitForScheduledCleanup();
  await settleIndexedDbAsyncPhase(mockAdapter);
  mockAdapter.clearInstrumentation();
}

export async function flushInvalidationPersistence(
  delayMs = 1100,
): Promise<void> {
  await settleIndexedDbStorage();
  await advanceTime(delayMs);
  await settleIndexedDbStorage();
  await advanceTime(2100);
  await settleIndexedDbStorage();
}

export async function settleIndexedDbStorage(): Promise<void> {
  await advanceTime(0);
  await flushAllTimers();
  await settleIndexedDbAsyncPhase();
  await advanceTime(0);
  await flushAllTimers();
  await settleIndexedDbAsyncPhase();
  await act(async () => {
    await Promise.resolve();
  });
}

export async function settleIndexedDbStorageCapture(
  mockAdapter: MockIndexedDbAdapter,
): Promise<void> {
  await settleIndexedDbStorage();
  await waitForCapturedOperationsToSettle(mockAdapter);
  await settleIndexedDbStorage();
  await waitForCapturedOperationsToSettle(mockAdapter);
}

export async function resolveAfterIndexedDbStorage<T>(
  promise: Promise<T>,
  mockAdapter: MockIndexedDbAdapter,
): Promise<T> {
  const pendingResult = Symbol('pendingResult');
  let didSettle = false;

  const settledResultPromise = promise.then(
    (value) => {
      didSettle = true;
      return { status: 'resolved' as const, value };
    },
    (error) => {
      didSettle = true;
      return { status: 'rejected' as const, error };
    },
  );

  for (let pass = 0; pass < 10; pass++) {
    if (didSettle) break;
    await settleIndexedDbStorageCapture(mockAdapter);
  }

  const settledResult = await Promise.race([
    settledResultPromise,
    Promise.resolve(pendingResult),
  ]);

  if (settledResult === pendingResult) {
    throw new Error('IndexedDB promise did not settle while draining storage work.');
  }

  if (settledResult.status === 'rejected') {
    throw settledResult.error;
  }

  return settledResult.value;
}

export async function captureHookRemount<Result>(args: {
  isReady?: (result: Result) => boolean;
  mockAdapter: MockIndexedDbAdapter;
  render: () => Result;
  settleTimeMs?: number;
}) {
  const firstMountCapture = startIndexedDbPersistentStorageOperationCapture(
    args.mockAdapter,
  );
  const firstHook = renderHook(args.render);
  await advanceTime(args.settleTimeMs ?? 250);
  await settleIndexedDbStorageCapture(args.mockAdapter);
  const firstMountOperations = firstMountCapture.finish().timelineString;

  firstHook.unmount();

  const remountCapture = startIndexedDbPersistentStorageOperationCapture(
    args.mockAdapter,
  );
  const secondHook = renderHook(args.render);
  await advanceTime(args.settleTimeMs ?? 250);
  await settleIndexedDbStorageCapture(args.mockAdapter);
  if (args.isReady !== undefined) {
    await waitForHookValue(() => secondHook.result.current, args.isReady);
  }
  const remountOperations = remountCapture.finish().timelineString;

  return { firstMountOperations, remountOperations, secondHook };
}

export async function waitForHookValue<Result>(
  read: () => Result,
  isReady: (result: Result) => boolean,
): Promise<Result> {
  let current = read();

  for (let pass = 0; pass < 80; pass++) {
    if (isReady(current)) return current;
    await Promise.resolve();
    await waitForRealTaskTick();
    await act(async () => {
      await Promise.resolve();
    });
    current = read();
  }

  throw new Error(
    `Hook state did not settle while draining IndexedDB storage work. Last value: ${JSON.stringify(
      current,
    )}`,
  );
}

export async function waitForIndexedDbCondition(
  isReady: () => boolean,
): Promise<void> {
  for (let pass = 0; pass < 80; pass++) {
    if (isReady()) return;
    await Promise.resolve();
    await waitForRealTaskTick();
    await act(async () => {
      await Promise.resolve();
    });
  }

  throw new Error('IndexedDB state did not settle to the expected condition.');
}

export type DocumentState = { name: string; value: number };

export function createDocumentEnv(options: {
  serverData?: DocumentState;
  sessionKey?: string;
  storeName: string;
  testScenario?: DocumentStoreTestScenario<DocumentState>;
}) {
  const mockAdapter = getCurrentIndexedDbPersistentStorageTestStore();
  const env = createDocumentStoreTestEnv(
    options.serverData ?? { name: 'test', value: 42 },
    {
      id: options.storeName,
      getSessionKey: () => options.sessionKey ?? 'session1',
      persistentStorage: {
        adapter: mockAdapter.adapter,
        schema: wrappedDocumentSchema,
      },
      testScenario: options.testScenario,
    },
  );
  pendingTestEnvDisposers.push(() => env.apiStore.dispose());
  return env;
}

export type CollectionItemState = { id: string; name: string };

export function createCollectionEnv(options: {
  maxItems?: number;
  pinnedItems?: string[];
  serverData?: Record<string, CollectionItemState>;
  sessionKey?: string;
  storeName: string;
}) {
  const mockAdapter = getCurrentIndexedDbPersistentStorageTestStore();
  void mockAdapter;
  const env = createCollectionStoreTestEnv(options.serverData ?? {}, {
    id: options.storeName,
    getSessionKey: () => options.sessionKey ?? 'session1',
    persistentStorage: {
      adapter: mockAdapter.adapter,
      maxItems: options.maxItems,
      payloadSchema: rc_string,
      pinnedItems: options.pinnedItems,
      schema: wrappedCollectionItemSchema,
    },
  });
  pendingTestEnvDisposers.push(() => env.apiStore.dispose());
  return env;
}

export function rawItemPayload(tableId: string, id: number): string {
  return `${tableId}||${id}`;
}

export function storeItemKey(tableId: string, id: number): string {
  return getCompositeKey(rawItemPayload(tableId, id));
}

export function createListQueryEnv(options: {
  defaultQuerySize?: number;
  maxItems?: number;
  maxQueries?: number;
  maxQuerySize?: number;
  offsetPagination?: OffsetPaginationConfig;
  pinnedItems?: string[];
  pinnedQueries?: Array<{ tableId: string }>;
  serverData?: Tables<Row>;
  sessionKey?: string;
  storeName: string;
}) {
  const mockAdapter = getCurrentIndexedDbPersistentStorageTestStore();
  void mockAdapter;
  const env = createListQueryStoreTestEnv(options.serverData ?? {}, {
    defaultQuerySize: options.defaultQuerySize,
    getSessionKey: () => options.sessionKey ?? 'session1',
    id: options.storeName,
    offsetPagination: options.offsetPagination,
    persistentStorage: {
      adapter: mockAdapter.adapter,
      itemPayloadSchema: rc_string,
      maxItems: options.maxItems,
      maxQueries: options.maxQueries,
      maxQuerySize: options.maxQuerySize,
      pinnedItems: options.pinnedItems,
      pinnedQueries: options.pinnedQueries,
      queryPayloadSchema: listQueryParamsSchema,
      schema: rowSchema,
    },
  });
  pendingTestEnvDisposers.push(() => env.apiStore.dispose());
  return env;
}

export async function updateEntryCustomMetadata(
  mockAdapter: MockIndexedDbAdapter,
  key: string,
  update: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const currentMetadata = await mockAdapter.readMetadata(key);
  if (currentMetadata === null) {
    throw new Error(`Expected metadata for ${key}.`);
  }

  mockAdapter.setMetadata(key, {
    ...currentMetadata,
    customMetadata: update(currentMetadata.customMetadata),
  });
  await mockAdapter.flushPendingWrites();
}

export async function markEntryOfflineProtected(
  mockAdapter: MockIndexedDbAdapter,
  key: string,
): Promise<void> {
  await updateEntryCustomMetadata(mockAdapter, key, (current) => ({
    ...current,
    o: true,
  }));
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

  return serializeProtectedRef({
    key: 'document',
    kind: 'document',
    sessionKey: storageKey.split('.').slice(1, -1).join('.'),
    storeName: storageKey.split('.').at(-1) ?? '',
  });
}

function serializeProtectedNamespaceEntry(
  storageKey: string,
  marker: '.ci.' | '.li.' | '.lq.',
  kind: 'collection.item' | 'listQuery.item' | 'listQuery.query',
): string {
  const markerIndex = storageKey.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`Missing "${marker}" in ${storageKey}.`);
  }

  const prefix = storageKey.slice('tsdf.'.length, markerIndex);
  const entryKey = storageKey.slice(markerIndex + marker.length);
  const lastSeparatorIndex = prefix.lastIndexOf('.');
  if (lastSeparatorIndex < 0) {
    throw new Error(`Invalid storage key: ${storageKey}.`);
  }

  return serializeProtectedRef({
    key: entryKey,
    kind,
    sessionKey: prefix.slice(0, lastSeparatorIndex),
    storeName: prefix.slice(lastSeparatorIndex + 1),
  });
}
