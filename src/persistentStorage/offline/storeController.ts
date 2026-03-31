import { createAsyncQueue } from '@ls-stack/utils/asyncQueue';
import { deepEqual } from '@ls-stack/utils/deepEqual';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { isObject } from '@ls-stack/utils/typeGuards';
import { rc_parse } from 'runcheck';

import type { ValidPayload } from '../../utils/storeShared';
import { createPersistentStorageNamespaceHandle } from '../persistentStorageManager';
import {
  OFFLINE_CONFLICT_STORAGE_ENTRY_PREFIX,
  OFFLINE_ENTITY_STORAGE_ENTRY_PREFIX,
  OFFLINE_QUEUE_STORAGE_ENTRY_PREFIX,
} from '../storageEntryPrefixes';
import type { StorageAdapter } from '../types';
import { validateWithSchema } from '../validateWithSchema';
import type { PreparedOfflineMutation } from './mutationRuntime';
import { getOrCreateSessionOfflineCoordinator } from './sessionCoordinator';
import {
  offlineResolutionRecordSchema,
  type AnyOfflineOperationDefinition,
  type GlobalOfflineEntity,
  type OfflineModeConfig,
  type OfflineMutationInput,
  type OfflineOperationSchemaShape,
  type OfflineQueueEntry,
  type OfflineResolutionRecord,
  type OfflineResolveConflictResult,
  type OfflineStoreType,
} from './types';

const DEFAULT_REPLAY_RETRY_MAX_FAILURES = 5;
const DEFAULT_REPLAY_RETRY_INTERVAL_MS = 5_000;

type OfflineEntityRef = {
  entityKey: string;
  entityKind: 'document' | 'item' | 'query';
};

type OfflineStoreAdapter = {
  getEntityRefs?: (args: {
    operationName: string;
    input: unknown;
  }) => unknown[];
  normalizeEntityRefs?: (entityRefs: unknown[]) => OfflineEntityRef[];
  getProtectedCacheKeys: (entityRefs: OfflineEntityRef[]) => string[];
  applyPendingEntity?: (args: {
    operationName: string;
    input: unknown;
    tempId: ValidPayload;
    pendingEntity: unknown;
  }) => void;
  rollbackPendingEntity?: (args: {
    operationName: string;
    input: unknown;
    tempId: ValidPayload;
    pendingEntity: unknown;
  }) => void;
  reconcileTempEntity?: (args: {
    operationName: string;
    input: unknown;
    tempId: ValidPayload;
    result: unknown;
    reconciliation: { finalPayload: ValidPayload; finalData?: unknown };
  }) => void;
  captureQueuedMutationOverlays?: (args: {
    sessionKey: string;
    entityRefs: OfflineEntityRef[];
  }) => void;
  syncEntityOverlays?: (args: {
    sessionKey: string;
    entities: GlobalOfflineEntity[];
  }) => void;
};

type CreateOfflineStoreControllerOptions<
  TOperations extends Record<string, AnyOfflineOperationDefinition>,
> = {
  storeName: string;
  storeType: OfflineStoreType;
  getSessionKey: () => string | false;
  onPersistentStorageError?: (error: unknown) => void;
  adapter: StorageAdapter;
  offlineMode: OfflineModeConfig<TOperations>;
  storeAdapter: OfflineStoreAdapter;
};

type ActiveSessionState = {
  sessionKey: string;
  session: ReturnType<typeof getOrCreateSessionOfflineCoordinator>;
  unregister: (() => void) | null;
  queueNamespace: ReturnType<
    typeof createPersistentStorageNamespaceHandle<OfflineQueueEntry>
  >;
  resolutionNamespace: ReturnType<
    typeof createPersistentStorageNamespaceHandle<OfflineResolutionRecord>
  >;
  entityNamespace: ReturnType<
    typeof createPersistentStorageNamespaceHandle<GlobalOfflineEntity>
  >;
};

type NamespacePersistenceHandle<T> = Pick<
  ReturnType<typeof createPersistentStorageNamespaceHandle<T>>,
  'load' | 'listKeys' | 'remove' | 'save'
>;

function buildEntityId(
  sessionKey: string,
  storeName: string,
  entityKey: string,
): string {
  return `${sessionKey}:${storeName}:${entityKey}`;
}

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

function getQueueOrder(entry: {
  queueOrder?: number;
  createdAt: number;
}): number {
  return typeof entry.queueOrder === 'number'
    ? entry.queueOrder
    : entry.createdAt;
}

export const offlineSessionUnavailableError = Object.assign(
  new Error('Offline session unavailable'),
  { code: 460, id: 'offline-session-unavailable' as const },
);

function normalizeEntityRefs(entityRefs: OfflineEntityRef[]): string {
  return JSON.stringify(
    entityRefs
      .map((ref) => `${ref.entityKind}:${ref.entityKey}`)
      .sort((left, right) => left.localeCompare(right)),
  );
}

function compareQueueEntries(
  left: OfflineQueueEntry,
  right: OfflineQueueEntry,
): number {
  const leftQueueOrder = getQueueOrder(left);
  const rightQueueOrder = getQueueOrder(right);

  if (leftQueueOrder !== rightQueueOrder) {
    return leftQueueOrder - rightQueueOrder;
  }
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  return left.id.localeCompare(right.id);
}

export type OfflineStoreController<
  TOperations extends Record<string, OfflineOperationSchemaShape>,
> = {
  hydrateIfNeeded: () => Promise<void>;
  canQueueMutation: () => boolean;
  prepareForMutation: <TName extends keyof TOperations & string>(
    args: OfflineMutationInput<TOperations, TName>,
  ) => Promise<PreparedOfflineMutation>;
  queueMutation: <TName extends keyof TOperations & string>(
    args: OfflineMutationInput<TOperations, TName>,
  ) => Promise<void>;
  getOfflineEntities: () => GlobalOfflineEntity[];
  getOfflineResolutions: () => OfflineResolutionRecord[];
  resolveOfflineResolution: (
    resolutionId: string,
    resolution: unknown,
  ) => Promise<void>;
  prepareForFetch: () => Promise<void>;
  getSessionStatus: () => { effectiveOffline: boolean } | null;
  evaluateOfflineFetchError: (
    error: unknown,
    operationName?: string,
  ) => Promise<void>;
  ensureReplayScheduled: () => Promise<void>;
};

type OfflineStoreControllerBootstrap = Pick<
  OfflineStoreController<Record<string, OfflineOperationSchemaShape>>,
  'hydrateIfNeeded' | 'ensureReplayScheduled'
>;

export function initializeOfflineStoreController(
  controller: OfflineStoreControllerBootstrap | null | undefined,
): void {
  void controller?.hydrateIfNeeded().then(() => {
    void controller.ensureReplayScheduled();
  });
}

export function createOfflineStoreController<
  TOperations extends Record<string, AnyOfflineOperationDefinition>,
>({
  storeName,
  storeType,
  getSessionKey,
  onPersistentStorageError,
  adapter,
  offlineMode,
  storeAdapter,
}: CreateOfflineStoreControllerOptions<TOperations>): OfflineStoreController<TOperations> {
  const replayQueue = createAsyncQueue({ concurrency: 1, autoStart: true });
  let activeSession: ActiveSessionState | null = null;
  let replayScheduled = false;
  let replayRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let hydratedSessionKey: string | null = null;
  let hydratedPromise: Promise<void> | null = null;
  let nextQueueOrder = 0;
  const replayRetryMaxFailures =
    offlineMode.replayRetry?.maxFailures ?? DEFAULT_REPLAY_RETRY_MAX_FAILURES;
  const replayRetryIntervalMs =
    offlineMode.replayRetry?.intervalMs ?? DEFAULT_REPLAY_RETRY_INTERVAL_MS;
  const queueEntries = new Map<string, OfflineQueueEntry>();
  const resolutions = new Map<string, OfflineResolutionRecord>();
  const countedReplayFailures = new Map<string, number>();

  type InternalQueuedMutationArgs<TName extends keyof TOperations & string> = {
    operation: TName;
    input: unknown;
    tempId?: ValidPayload;
    entityRefs?: OfflineEntityRef[];
  };

  type PreparedQueuedMutation = {
    currentSessionKey: string;
    operationName: string;
    operation: AnyOfflineOperationDefinition;
    validatedInput: unknown;
    tempId?: ValidPayload;
    entityRefs?: OfflineEntityRef[];
  };

  type PreparedMutationBatch = {
    currentSessionKey: string;
    mutations: PreparedQueuedMutation[];
  };

  type PlannedQueuedMutation = {
    operationName: string;
    validatedInput: unknown;
    tempId?: ValidPayload;
    pendingEntity?: unknown;
    nextEntry: OfflineQueueEntry;
    previousEntry?: OfflineQueueEntry;
  };

  async function loadNamespaceRecords<T extends { id: string }>(
    namespace: NamespacePersistenceHandle<T>,
  ): Promise<Map<string, T>> {
    const keys = await namespace.listKeys();
    const records = await Promise.all(
      keys.map((key) => namespace.load(key, { touch: 'never' })),
    );
    const loadedRecords = new Map<string, T>();

    for (const record of records) {
      if (!record) continue;
      loadedRecords.set(record.id, record);
    }

    return loadedRecords;
  }

  function clearReplayRetryTimer(): void {
    if (replayRetryTimer !== null) {
      clearTimeout(replayRetryTimer);
      replayRetryTimer = null;
    }
  }

  function resetReplayRetryState(): void {
    clearReplayRetryTimer();
    countedReplayFailures.clear();
  }

  function scheduleReplayRetry(): void {
    if (replayRetryTimer !== null) return;

    replayRetryTimer = setTimeout(() => {
      replayRetryTimer = null;
      void ensureReplayScheduled();
    }, replayRetryIntervalMs);
  }

  function isActiveSessionState(current: ActiveSessionState): boolean {
    return activeSession?.sessionKey === current.sessionKey;
  }

  function teardownActiveSession(): void {
    activeSession?.unregister?.();
    activeSession = null;
    resetReplayRetryState();
    queueEntries.clear();
    resolutions.clear();
    nextQueueOrder = 0;
    hydratedSessionKey = null;
    hydratedPromise = null;
  }

  function ensureActiveSession(): ActiveSessionState | null {
    const sessionKey = getSessionKey();
    if (sessionKey === false) {
      if (activeSession) {
        teardownActiveSession();
      }
      return null;
    }

    if (activeSession?.sessionKey === sessionKey) return activeSession;

    teardownActiveSession();

    const session = getOrCreateSessionOfflineCoordinator(sessionKey, {
      adapter,
      onPersistentStorageError,
      // WORKAROUND: Session coordinators keep offline operation schemas under a generic erased shape, and session creation restores the caller's concrete operations map.
      config: __LEGIT_CAST__<
        OfflineModeConfig<Record<string, OfflineOperationSchemaShape>>,
        OfflineModeConfig<TOperations>
      >(offlineMode),
    });

    const queueNamespace =
      createPersistentStorageNamespaceHandle<OfflineQueueEntry>({
        storeName,
        adapter,
        getSessionKey: () => sessionKey,
        onPersistentStorageError,
        entryPrefix: OFFLINE_QUEUE_STORAGE_ENTRY_PREFIX,
      });
    const resolutionNamespace =
      createPersistentStorageNamespaceHandle<OfflineResolutionRecord>({
        storeName,
        adapter,
        getSessionKey: () => sessionKey,
        onPersistentStorageError,
        entryPrefix: OFFLINE_CONFLICT_STORAGE_ENTRY_PREFIX,
      });
    const entityNamespace =
      createPersistentStorageNamespaceHandle<GlobalOfflineEntity>({
        storeName,
        adapter,
        getSessionKey: () => sessionKey,
        onPersistentStorageError,
        entryPrefix: OFFLINE_ENTITY_STORAGE_ENTRY_PREFIX,
      });

    const unregister = session.registerStore({
      storeName,
      onGreenCycle: () => {
        void ensureReplayScheduled();
      },
      onOfflineCycle: () => {
        resetReplayRetryState();
      },
    });

    activeSession = {
      sessionKey,
      session,
      unregister,
      queueNamespace,
      resolutionNamespace,
      entityNamespace,
    };

    return activeSession;
  }

  async function hydrateIfNeeded(): Promise<void> {
    const current = ensureActiveSession();
    if (!current) return;
    if (hydratedSessionKey === current.sessionKey) return;
    if (hydratedPromise) return hydratedPromise;

    hydratedPromise = (async () => {
      const [loadedQueueEntries, loadedResolutionEntries] = await Promise.all([
        loadNamespaceRecords(current.queueNamespace),
        loadNamespaceRecords(current.resolutionNamespace),
      ]);

      if (!isActiveSessionState(current)) return;

      queueEntries.clear();
      resolutions.clear();
      for (const entry of loadedQueueEntries.values()) {
        queueEntries.set(entry.id, entry);
      }
      for (const resolution of loadedResolutionEntries.values()) {
        const parsed = rc_parse(resolution, offlineResolutionRecordSchema);
        if (!parsed.ok) {
          void current.resolutionNamespace.remove(resolution.id);
          continue;
        }
        resolutions.set(resolution.id, resolution);
      }
      nextQueueOrder = getNextQueueOrder(loadedQueueEntries.values());
      hydratedSessionKey = current.sessionKey;
      refreshDerivedState(current);
    })().finally(() => {
      hydratedPromise = null;
    });

    return hydratedPromise;
  }

  function refreshDerivedState(current?: ActiveSessionState): void {
    const session = current ?? ensureActiveSession();
    if (!session || !isActiveSessionState(session)) return;
    const sessionState = session;

    const entitiesByKey = new Map<string, GlobalOfflineEntity>();

    function createEntityBase(
      ref: OfflineEntityRef,
    ): Pick<
      GlobalOfflineEntity,
      | 'id'
      | 'sessionKey'
      | 'storeName'
      | 'storeType'
      | 'entityKey'
      | 'entityKind'
    > {
      return {
        id: buildEntityId(sessionState.sessionKey, storeName, ref.entityKey),
        sessionKey: sessionState.sessionKey,
        storeName,
        storeType,
        entityKey: ref.entityKey,
        entityKind: ref.entityKind,
      };
    }

    for (const entry of queueEntries.values()) {
      for (const ref of entry.entityRefs) {
        const existing = entitiesByKey.get(ref.entityKey);

        entitiesByKey.set(ref.entityKey, {
          ...createEntityBase(ref),
          pendingMutations: (existing?.pendingMutations ?? 0) + 1,
          syncState:
            existing?.syncState === 'needs-confirmation'
              ? existing.syncState
              : entry.syncState,
          requiresResolution: existing?.requiresResolution ?? false,
          createdAt: existing?.createdAt ?? entry.createdAt,
          updatedAt: entry.updatedAt,
          tempId: entry.tempId ?? existing?.tempId,
        });
      }
    }

    for (const resolution of resolutions.values()) {
      for (const ref of resolution.entityRefs) {
        const existing = entitiesByKey.get(ref.entityKey);

        entitiesByKey.set(ref.entityKey, {
          ...createEntityBase(ref),
          pendingMutations: existing?.pendingMutations ?? 0,
          syncState: 'resolution-required',
          requiresResolution: true,
          createdAt: existing?.createdAt ?? resolution.createdAt,
          updatedAt: resolution.updatedAt,
          tempId: resolution.tempId ?? existing?.tempId,
        });
      }
    }

    const entities = [...entitiesByKey.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    const protectedKeys = storeAdapter.getProtectedCacheKeys(
      entities.map((entity) => ({
        entityKey: entity.entityKey,
        entityKind: entity.entityKind,
      })),
    );

    sessionState.session.syncStoreData(storeName, {
      entities,
      resolutions: [...resolutions.values()],
      protectedKeys,
    });
    storeAdapter.syncEntityOverlays?.({
      sessionKey: sessionState.sessionKey,
      entities,
    });

    void syncEntityNamespace(sessionState, entities);
  }

  async function syncEntityNamespace(
    current: ActiveSessionState,
    entities: GlobalOfflineEntity[],
  ): Promise<void> {
    const existingKeys = await current.entityNamespace.listKeys();
    const nextKeys = new Set(entities.map((entity) => entity.entityKey));

    await Promise.all([
      ...entities.map((entity) =>
        current.entityNamespace.save(entity.entityKey, entity),
      ),
      ...existingKeys
        .filter((key) => !nextKeys.has(key))
        .map((key) => current.entityNamespace.remove(key)),
    ]);
  }

  function getSortedEntries(): OfflineQueueEntry[] {
    return [...queueEntries.values()].sort(compareQueueEntries);
  }

  function getNextQueueOrder(entries: Iterable<OfflineQueueEntry>): number {
    let highestQueueOrder = -1;

    for (const entry of entries) {
      const entryQueueOrder = getQueueOrder(entry);
      if (entryQueueOrder > highestQueueOrder) {
        highestQueueOrder = entryQueueOrder;
      }
    }

    return highestQueueOrder + 1;
  }

  function previewQueueOrders(count: number): {
    queueOrders: number[];
    nextQueueOrderValue: number;
  } {
    const baseQueueOrder = Math.max(nextQueueOrder, Date.now());
    const queueOrders = Array.from({ length: count }, (_, index) => {
      return baseQueueOrder + index;
    });

    return { queueOrders, nextQueueOrderValue: baseQueueOrder + count };
  }

  function buildFreshQueueEntry(args: {
    current: ActiveSessionState;
    operation: string;
    input: unknown;
    entityRefs: OfflineEntityRef[];
    queueOrder: number;
    tempId?: ValidPayload;
  }): OfflineQueueEntry {
    const now = Date.now();

    return {
      id: `${storeName}:${now}:${Math.random().toString(36).slice(2, 10)}`,
      sessionKey: args.current.sessionKey,
      storeName,
      storeType,
      operation: args.operation,
      input: args.input,
      queueOrder: args.queueOrder,
      entityRefs: args.entityRefs,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      lastAttemptAt: null,
      syncState: 'pending',
      tempId: args.tempId,
    };
  }

  function findAccumulationCandidate(args: {
    operationName: string;
    entityRefs: OfflineEntityRef[];
    entries?: Iterable<OfflineQueueEntry>;
  }): OfflineQueueEntry | null {
    const normalizedEntityRefs = normalizeEntityRefs(args.entityRefs);
    let candidate: OfflineQueueEntry | null = null;

    for (const entry of args.entries ?? queueEntries.values()) {
      if (entry.operation !== args.operationName) continue;
      if (entry.syncState !== 'pending') continue;
      if (entry.attempts > 0) continue;
      if (entry.tempId !== undefined) continue;
      if (normalizeEntityRefs(entry.entityRefs) !== normalizedEntityRefs) {
        continue;
      }

      if (!candidate || compareQueueEntries(entry, candidate) < 0) {
        candidate = entry;
      }
    }

    return candidate;
  }

  function buildResolutionRecordBase(
    current: ActiveSessionState,
    entry: OfflineQueueEntry,
  ) {
    const now = Date.now();

    return {
      entryId: entry.id,
      sessionKey: current.sessionKey,
      storeName,
      storeType,
      operation: entry.operation,
      input: entry.input,
      enqueuedAt: entry.createdAt,
      entityRefs: entry.entityRefs,
      createdAt: now,
      updatedAt: now,
      tempId: entry.tempId,
    };
  }

  function buildConflictResolutionRecord(
    current: ActiveSessionState,
    entry: OfflineQueueEntry,
    conflict: unknown,
  ): OfflineResolutionRecord {
    return {
      ...buildResolutionRecordBase(current, entry),
      id: `conflict:${entry.id}`,
      kind: 'conflict',
      conflict,
    };
  }

  function buildRetryExhaustedResolutionRecord(
    current: ActiveSessionState,
    entry: OfflineQueueEntry,
    lastReplayError: { message: string },
  ): OfflineResolutionRecord {
    return {
      ...buildResolutionRecordBase(current, entry),
      id: `retry-exhausted:${entry.id}`,
      kind: 'retry-exhausted',
      lastReplayError,
    };
  }

  function replacePayloadReferences(
    value: unknown,
    tempId: ValidPayload,
    finalPayload: ValidPayload,
  ): unknown {
    if (deepEqual(value, tempId)) return finalPayload;
    if (!Array.isArray(value) && !isObject(value)) return value;

    if (Array.isArray(value)) {
      const nextValue = [...value];
      let didChange = false;

      for (const [index, item] of value.entries()) {
        const replacedItem = replacePayloadReferences(
          item,
          tempId,
          finalPayload,
        );
        if (replacedItem !== item) {
          didChange = true;
          nextValue[index] = replacedItem;
        }
      }

      return didChange ? nextValue : value;
    }

    let didChange = false;
    const nextValue: Record<string, unknown> = {};

    for (const [key, entryValue] of Object.entries(value)) {
      const replacedValue = replacePayloadReferences(
        entryValue,
        tempId,
        finalPayload,
      );
      if (replacedValue !== entryValue) {
        didChange = true;
      }

      nextValue[key] = replacedValue;
    }

    return didChange ? nextValue : value;
  }

  function resolveEntityRefsForInput(
    operationName: string,
    input: unknown,
    fallbackEntityRefs: OfflineEntityRef[],
  ): OfflineEntityRef[] {
    const operation = offlineMode.operations[operationName];
    if (!operation) return fallbackEntityRefs;

    const rawEntityRefs =
      typeof operation.getEntityRefs === 'function'
        ? operation.getEntityRefs({ input })
        : (storeAdapter.getEntityRefs?.({ operationName, input }) ?? []);

    if (rawEntityRefs.length === 0) return fallbackEntityRefs;

    if (storeAdapter.normalizeEntityRefs) {
      return storeAdapter.normalizeEntityRefs(rawEntityRefs);
    }

    // WORKAROUND: Custom store adapters can return a concrete payload-key array
    // shape that is structurally compatible with OfflineEntityRef[], but TypeScript
    // cannot connect that erased generic to this controller-level union.
    return __LEGIT_CAST__<OfflineEntityRef[], unknown[]>(rawEntityRefs);
  }

  async function rebindQueuedEntriesAfterTempReconciliation(args: {
    current: ActiveSessionState;
    entryIdToSkip: string;
    tempId: ValidPayload;
    finalPayload: ValidPayload;
  }): Promise<void> {
    const changedQueueEntries: OfflineQueueEntry[] = [];

    for (const entry of queueEntries.values()) {
      if (entry.id === args.entryIdToSkip) continue;

      const rewrittenInput = replacePayloadReferences(
        entry.input,
        args.tempId,
        args.finalPayload,
      );

      if (rewrittenInput === entry.input) continue;

      const operation = offlineMode.operations[entry.operation];
      if (!operation) continue;

      const validatedInput = validateWithSchema(
        operation.inputSchema,
        rewrittenInput,
      );
      if (validatedInput === null) continue;

      const rewrittenEntry = {
        ...entry,
        input: validatedInput,
        entityRefs: resolveEntityRefsForInput(
          entry.operation,
          validatedInput,
          entry.entityRefs,
        ),
      };

      await persistEntry(rewrittenEntry, args.current, true);
      changedQueueEntries.push(rewrittenEntry);
    }

    for (const resolution of resolutions.values()) {
      const rewrittenInput = replacePayloadReferences(
        resolution.input,
        args.tempId,
        args.finalPayload,
      );

      if (rewrittenInput === resolution.input) continue;

      const operation = offlineMode.operations[resolution.operation];
      if (!operation) continue;

      const validatedInput = validateWithSchema(
        operation.inputSchema,
        rewrittenInput,
      );
      if (validatedInput === null) continue;

      const rewrittenResolution = {
        ...resolution,
        input: validatedInput,
        entityRefs: resolveEntityRefsForInput(
          resolution.operation,
          validatedInput,
          resolution.entityRefs,
        ),
      };

      resolutions.set(rewrittenResolution.id, rewrittenResolution);
      await args.current.resolutionNamespace.save(
        rewrittenResolution.id,
        rewrittenResolution,
      );
    }

    for (const entry of changedQueueEntries) {
      storeAdapter.captureQueuedMutationOverlays?.({
        sessionKey: args.current.sessionKey,
        entityRefs: entry.entityRefs,
      });
    }

    refreshDerivedState(args.current);
  }

  async function persistEntry(
    entry: OfflineQueueEntry,
    current?: ActiveSessionState,
    skipRefresh?: boolean,
  ): Promise<void> {
    const session = current ?? ensureActiveSession();
    if (!session) return;
    if (isActiveSessionState(session)) {
      queueEntries.set(entry.id, entry);
    }
    await session.queueNamespace.save(entry.id, entry);
    if (!skipRefresh && isActiveSessionState(session)) {
      refreshDerivedState(session);
    }
  }

  async function removeEntry(
    entryId: string,
    current?: ActiveSessionState,
    skipRefresh?: boolean,
  ): Promise<void> {
    const session = current ?? ensureActiveSession();
    if (!session) return;
    if (isActiveSessionState(session)) {
      queueEntries.delete(entryId);
      countedReplayFailures.delete(entryId);
      if (queueEntries.size === 0) {
        clearReplayRetryTimer();
      }
    }
    await session.queueNamespace.remove(entryId);
    if (!skipRefresh && isActiveSessionState(session)) {
      refreshDerivedState(session);
    }
  }

  async function persistResolution(
    resolution: OfflineResolutionRecord,
    current?: ActiveSessionState,
  ): Promise<void> {
    const session = current ?? ensureActiveSession();
    if (!session) return;
    if (isActiveSessionState(session)) {
      resolutions.set(resolution.id, resolution);
    }
    await session.resolutionNamespace.save(resolution.id, resolution);
    if (isActiveSessionState(session)) {
      refreshDerivedState(session);
    }
  }

  async function removeResolution(
    resolutionId: string,
    current?: ActiveSessionState,
  ): Promise<void> {
    const session = current ?? ensureActiveSession();
    if (!session) return;
    if (isActiveSessionState(session)) {
      resolutions.delete(resolutionId);
    }
    await session.resolutionNamespace.remove(resolutionId);
    if (isActiveSessionState(session)) {
      refreshDerivedState(session);
    }
  }

  async function persistValidatedConflictResolution(args: {
    current: ActiveSessionState;
    entry: OfflineQueueEntry;
    conflict: unknown;
    conflictHandling: NonNullable<
      AnyOfflineOperationDefinition['conflictHandling']
    >;
  }): Promise<void> {
    if (
      args.conflictHandling.schema &&
      validateWithSchema(args.conflictHandling.schema, args.conflict) === null
    ) {
      throw new Error(
        `Invalid offline conflict payload for operation "${args.entry.operation}"`,
      );
    }

    await persistResolution(
      buildConflictResolutionRecord(args.current, args.entry, args.conflict),
      args.current,
    );
    await removeEntry(args.entry.id, args.current);
  }

  function prepareMutationWithSession<TName extends keyof TOperations & string>(
    current: ActiveSessionState,
    args: InternalQueuedMutationArgs<TName>,
  ): PreparedQueuedMutation {
    const operationName = String(args.operation);
    const operation = offlineMode.operations[operationName];
    if (!operation) {
      throw new Error(
        `Unknown offline operation "${operationName}" for store "${storeName}"`,
      );
    }

    const validatedInput = validateWithSchema(
      operation.inputSchema,
      args.input,
    );
    if (validatedInput === null) {
      throw new Error(`Invalid offline operation input for "${operationName}"`);
    }

    return {
      currentSessionKey: current.sessionKey,
      operationName,
      operation,
      validatedInput,
      tempId: args.tempId,
      entityRefs: args.entityRefs,
    };
  }

  function normalizeMutationArgs<TName extends keyof TOperations & string>(
    args: OfflineMutationInput<TOperations, TName>,
  ): InternalQueuedMutationArgs<TName>[] {
    if ('operation' in args) {
      return [{ operation: args.operation, input: args.input }];
    }

    if (args.length === 0) {
      throw new Error('Offline mutation list must contain at least one entry');
    }

    return args.map((entry: { operation: TName; input: unknown }) => ({
      operation: entry.operation,
      input: entry.input,
    }));
  }

  function prepareMutationBatchWithSession<
    TName extends keyof TOperations & string,
  >(
    current: ActiveSessionState,
    args: OfflineMutationInput<TOperations, TName>,
  ): PreparedMutationBatch {
    const mutations = normalizeMutationArgs(args).map((entry) =>
      prepareMutationWithSession(current, entry),
    );

    return { currentSessionKey: current.sessionKey, mutations };
  }

  async function planPreparedMutation(args: {
    current: ActiveSessionState;
    preparedMutation: PreparedQueuedMutation;
    queueOrder: number;
    workingQueue: Map<string, OfflineQueueEntry>;
  }): Promise<PlannedQueuedMutation> {
    const {
      current,
      preparedMutation: {
        operation,
        operationName,
        validatedInput,
        tempId: preparedTempId,
        entityRefs: preparedEntityRefs,
      },
      queueOrder,
      workingQueue,
    } = args;

    const tempEntity = operation.tempEntity;
    if (storeType === 'document' && tempEntity) {
      throw new Error(
        `Document offline operation "${operationName}" does not support tempEntity`,
      );
    }

    const rawEntityRefs =
      typeof operation.getEntityRefs === 'function'
        ? operation.getEntityRefs({ input: validatedInput })
        : (storeAdapter.getEntityRefs?.({
            operationName,
            input: validatedInput,
          }) ?? []);
    const resolvedEntityRefs = storeAdapter.normalizeEntityRefs
      ? storeAdapter.normalizeEntityRefs(rawEntityRefs)
      : // WORKAROUND: When no normalizer is provided, entity refs already come from the operation definition, but the controller stores them as unknown[].
        __LEGIT_CAST__<OfflineEntityRef[], unknown[]>(rawEntityRefs);
    const entityRefs =
      tempEntity !== undefined &&
      preparedTempId !== undefined &&
      preparedEntityRefs !== undefined
        ? preparedEntityRefs
        : resolvedEntityRefs;
    const tempId =
      tempEntity !== undefined
        ? (preparedTempId ??
          // WORKAROUND: Single-entity temp ids travel through rawEntityRefs as unknown values until the store adapter converts them back to payload ids.
          __LEGIT_CAST__<ValidPayload | undefined, unknown>(rawEntityRefs[0]))
        : preparedTempId;

    if (tempEntity) {
      if (rawEntityRefs.length !== 1) {
        throw new Error(
          `Temp entity operation "${operationName}" must resolve exactly one entity ref`,
        );
      }
      if (
        resolvedEntityRefs.length !== 1 ||
        resolvedEntityRefs[0]?.entityKind !== 'item'
      ) {
        throw new Error(
          `Temp entity operation "${operationName}" must resolve exactly one item ref`,
        );
      }
      if (entityRefs.length !== 1 || entityRefs[0]?.entityKind !== 'item') {
        throw new Error(
          `Temp entity operation "${operationName}" must preserve exactly one item ref`,
        );
      }
    }

    const now = Date.now();
    const pendingEntity =
      tempId !== undefined && tempEntity && storeAdapter.applyPendingEntity
        ? tempEntity.buildPendingEntity(validatedInput, tempId)
        : undefined;

    if (operation.accumulation && tempId === undefined) {
      const existingEntry = findAccumulationCandidate({
        operationName,
        entityRefs,
        entries: workingQueue.values(),
      });

      if (existingEntry) {
        const mergedInput = await operation.accumulation.mergeInput({
          sessionKey: current.sessionKey,
          existingInput: existingEntry.input,
          incomingInput: validatedInput,
        });
        const validatedMergedInput = validateWithSchema(
          operation.inputSchema,
          mergedInput,
        );

        if (validatedMergedInput === null) {
          throw new Error(
            `Invalid accumulated offline operation input for "${operationName}"`,
          );
        }

        const nextEntry = {
          ...existingEntry,
          input: validatedMergedInput,
          updatedAt: now,
        };
        workingQueue.set(nextEntry.id, nextEntry);

        return {
          operationName,
          validatedInput,
          tempId,
          pendingEntity,
          nextEntry,
          previousEntry: existingEntry,
        };
      }
    }

    const nextEntry = buildFreshQueueEntry({
      current,
      operation: operationName,
      input: validatedInput,
      queueOrder,
      entityRefs,
      tempId,
    });
    workingQueue.set(nextEntry.id, nextEntry);

    return { operationName, validatedInput, tempId, pendingEntity, nextEntry };
  }

  async function queuePreparedMutations(
    args: PreparedMutationBatch,
  ): Promise<void> {
    const current = ensureActiveSession();
    if (!current || current.sessionKey !== args.currentSessionKey) {
      throw offlineSessionUnavailableError;
    }

    const { queueOrders, nextQueueOrderValue } = previewQueueOrders(
      args.mutations.length,
    );
    const workingQueue = new Map(queueEntries);
    const plannedMutations: PlannedQueuedMutation[] = [];

    for (const [index, mutation] of args.mutations.entries()) {
      const queueOrder = queueOrders[index];
      if (queueOrder === undefined) {
        throw new Error('Missing queue order for prepared offline mutation');
      }

      plannedMutations.push(
        await planPreparedMutation({
          current,
          preparedMutation: mutation,
          queueOrder,
          workingQueue,
        }),
      );
    }

    const persistedMutations: PlannedQueuedMutation[] = [];
    const appliedPendingMutations: PlannedQueuedMutation[] = [];
    const previousNextQueueOrder = nextQueueOrder;

    try {
      for (const mutation of plannedMutations) {
        await persistEntry(mutation.nextEntry, current, true);
        persistedMutations.push(mutation);
      }

      nextQueueOrder = nextQueueOrderValue;

      if (storeAdapter.applyPendingEntity) {
        for (const mutation of plannedMutations) {
          if (
            mutation.tempId === undefined ||
            mutation.pendingEntity === undefined
          ) {
            continue;
          }

          storeAdapter.applyPendingEntity({
            operationName: mutation.operationName,
            input: mutation.validatedInput,
            tempId: mutation.tempId,
            pendingEntity: mutation.pendingEntity,
          });
          appliedPendingMutations.push(mutation);
        }
      }

      for (const mutation of plannedMutations) {
        storeAdapter.captureQueuedMutationOverlays?.({
          sessionKey: current.sessionKey,
          entityRefs: mutation.nextEntry.entityRefs,
        });
      }
    } catch (error) {
      for (const mutation of appliedPendingMutations.reverse()) {
        if (
          mutation.tempId === undefined ||
          mutation.pendingEntity === undefined
        ) {
          continue;
        }

        storeAdapter.rollbackPendingEntity?.({
          operationName: mutation.operationName,
          input: mutation.validatedInput,
          tempId: mutation.tempId,
          pendingEntity: mutation.pendingEntity,
        });
      }

      for (const mutation of persistedMutations.reverse()) {
        if (mutation.previousEntry) {
          await persistEntry(mutation.previousEntry, current, true);
          continue;
        }

        await removeEntry(mutation.nextEntry.id, current, true);
      }

      nextQueueOrder = previousNextQueueOrder;
      refreshDerivedState(current);

      throw error;
    }

    refreshDerivedState(current);
    await ensureReplayScheduled();
  }

  async function ensureReplayScheduled(): Promise<void> {
    let current = ensureActiveSession();
    if (!current) return;
    if (hydratedSessionKey !== current.sessionKey || hydratedPromise !== null) {
      await hydrateIfNeeded();
      current = ensureActiveSession();
      if (!current) return;
    }
    if (
      replayScheduled ||
      replayRetryTimer !== null ||
      current.session.getStatus().effectiveOffline ||
      !current.session.isLeader() ||
      queueEntries.size === 0
    ) {
      return;
    }

    replayScheduled = true;
    void replayQueue.resultifyAdd(async () => {
      try {
        await drainReplay();
      } finally {
        replayScheduled = false;

        const nextEntry = getSortedEntries()[0];
        if (nextEntry?.syncState === 'needs-confirmation') {
          scheduleReplayRetry();
        }
      }
    });
  }

  async function drainReplay(): Promise<void> {
    while (true) {
      const current = ensureActiveSession();
      if (!current) return;
      if (
        current.session.getStatus().effectiveOffline ||
        !current.session.isLeader()
      ) {
        return;
      }

      const nextEntry = getSortedEntries()[0];
      if (!nextEntry) return;

      const operation = offlineMode.operations[nextEntry.operation];
      if (!operation) {
        await removeEntry(nextEntry.id, current);
        continue;
      }

      const shouldCheckSkipBeforeRetry =
        nextEntry.syncState === 'needs-confirmation';
      const conflictHandling = operation.conflictHandling;
      const tempEntity = operation.tempEntity;
      const replayCheckBaseCtx = {
        input: nextEntry.input,
        enqueuedAt: nextEntry.createdAt,
        updatedAt: nextEntry.updatedAt,
      };
      let entryToUse: OfflineQueueEntry = {
        ...nextEntry,
        syncState: 'syncing',
        updatedAt: Date.now(),
        lastAttemptAt: Date.now(),
      };
      await persistEntry(entryToUse, current);

      try {
        const shouldPrepareReplayCheckCtx = Boolean(
          (shouldCheckSkipBeforeRetry && operation.shouldSkipSync) ||
          conflictHandling,
        );
        const replayCheckCtx = shouldPrepareReplayCheckCtx
          ? {
              ...replayCheckBaseCtx,
              serverSnapshot: operation.getServerSnapshot
                ? await operation.getServerSnapshot(replayCheckBaseCtx)
                : undefined,
            }
          : null;

        if (shouldCheckSkipBeforeRetry && operation.shouldSkipSync) {
          if (!replayCheckCtx) {
            throw new Error('Replay check context was not prepared');
          }
          const shouldSkip = await operation.shouldSkipSync(replayCheckCtx);

          if (shouldSkip) {
            await removeEntry(entryToUse.id, current);
            continue;
          }
        }

        const conflict = conflictHandling
          ? await conflictHandling.detectConflict(
              replayCheckCtx ??
                ({ ...replayCheckBaseCtx, serverSnapshot: undefined } as const),
            )
          : false;

        if (conflict) {
          if (!conflictHandling) {
            throw new Error(
              `Operation "${entryToUse.operation}" returned a conflict without conflictHandling configured`,
            );
          }

          await persistValidatedConflictResolution({
            current,
            entry: entryToUse,
            conflict,
            conflictHandling,
          });
          continue;
        }

        const result = await operation.execute({
          input: entryToUse.input,
          enqueuedAt: entryToUse.createdAt,
          updatedAt: entryToUse.updatedAt,
        });

        if (
          entryToUse.tempId !== undefined &&
          tempEntity &&
          storeAdapter.reconcileTempEntity
        ) {
          const reconciliation = tempEntity.reconcileServerEntity(
            result,
            entryToUse.tempId,
          );
          storeAdapter.reconcileTempEntity({
            operationName: entryToUse.operation,
            input: entryToUse.input,
            tempId: entryToUse.tempId,
            result,
            reconciliation,
          });
          await rebindQueuedEntriesAfterTempReconciliation({
            current,
            entryIdToSkip: entryToUse.id,
            tempId: entryToUse.tempId,
            finalPayload: reconciliation.finalPayload,
          });
        }

        await removeEntry(entryToUse.id, current);
      } catch (error) {
        const lastError = { message: toMessage(error) };
        const classification = await current.session.classifyFailure(error, {
          phase: 'sync',
          storeType,
          operationName: entryToUse.operation,
          sessionKey: current.sessionKey,
        });

        if (
          classification === 'outage' ||
          current.session.getStatus().effectiveOffline
        ) {
          entryToUse = {
            ...entryToUse,
            attempts: entryToUse.attempts + 1,
            updatedAt: Date.now(),
            lastAttemptAt: Date.now(),
            syncState: 'pending',
            lastError,
          };
          await persistEntry(entryToUse, current);
          return;
        }

        const nextFailures =
          (countedReplayFailures.get(entryToUse.id) ?? 0) + 1;
        countedReplayFailures.set(entryToUse.id, nextFailures);

        entryToUse = {
          ...entryToUse,
          attempts: entryToUse.attempts + 1,
          updatedAt: Date.now(),
          lastAttemptAt: Date.now(),
          syncState: 'needs-confirmation',
          lastError,
        };

        if (nextFailures >= replayRetryMaxFailures) {
          await removeEntry(entryToUse.id, current, true);
          await persistResolution(
            buildRetryExhaustedResolutionRecord(current, entryToUse, lastError),
            current,
          );
          return;
        }

        await persistEntry(entryToUse, current);
        return;
      }
    }
  }

  async function queueMutation<TName extends keyof TOperations & string>(
    args: OfflineMutationInput<TOperations, TName>,
  ): Promise<void> {
    await hydrateIfNeeded();
    const current = ensureActiveSession();
    if (!current) {
      throw offlineSessionUnavailableError;
    }

    await queuePreparedMutations(
      prepareMutationBatchWithSession(current, args),
    );
  }

  async function prepareForMutation<TName extends keyof TOperations & string>(
    args: OfflineMutationInput<TOperations, TName>,
  ): Promise<PreparedOfflineMutation> {
    await hydrateIfNeeded();
    const current = ensureActiveSession();
    if (!current) {
      throw offlineSessionUnavailableError;
    }

    const prepared = prepareMutationBatchWithSession(current, args);
    await current.session.refreshNetworkState();

    return {
      effectiveOffline: current.session.getStatus().effectiveOffline,
      queueMutation: () => queuePreparedMutations(prepared),
      classifyError: async (error) => {
        const preparedCurrent = ensureActiveSession();
        if (
          !preparedCurrent ||
          preparedCurrent.sessionKey !== prepared.currentSessionKey
        ) {
          throw offlineSessionUnavailableError;
        }

        await preparedCurrent.session.refreshNetworkState();
        if (preparedCurrent.session.getStatus().effectiveOffline) {
          return true;
        }

        const firstMutation = prepared.mutations[0];
        const classification = await preparedCurrent.session.classifyFailure(
          error,
          {
            phase: 'mutation',
            storeType,
            operationName: firstMutation?.operationName,
            sessionKey: preparedCurrent.sessionKey,
          },
        );

        return (
          classification === 'outage' ||
          preparedCurrent.session.getStatus().effectiveOffline
        );
      },
    };
  }

  function getOfflineEntities(): GlobalOfflineEntity[] {
    const current = ensureActiveSession();
    if (!current) return [];
    return current.session
      .getEntities()
      .filter((entity) => entity.storeName === storeName);
  }

  function getOfflineResolutions(): OfflineResolutionRecord[] {
    return [...resolutions.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
  }

  async function resolveOfflineResolution(
    resolutionId: string,
    resolution: unknown,
  ): Promise<void> {
    await hydrateIfNeeded();
    const current = ensureActiveSession();
    if (!current) return;

    const resolutionRecord = resolutions.get(resolutionId);
    if (!resolutionRecord) return;

    const operation = offlineMode.operations[resolutionRecord.operation];
    if (!operation) {
      await removeResolution(resolutionId, current);
      return;
    }

    if (resolutionRecord.kind === 'retry-exhausted') {
      const action = isObject(resolution) ? resolution.action : undefined;

      if (action !== 'retry' && action !== 'discard') {
        throw new Error('Invalid offline resolution action');
      }

      await removeResolution(resolutionId, current);

      if (action === 'discard') return;

      const { queueOrders, nextQueueOrderValue } = previewQueueOrders(1);
      const queueOrder = queueOrders[0];
      if (queueOrder === undefined) {
        throw new Error('Missing queue order for replay resolution requeue');
      }
      nextQueueOrder = nextQueueOrderValue;

      const nextEntry = buildFreshQueueEntry({
        current,
        operation: resolutionRecord.operation,
        input: resolutionRecord.input,
        entityRefs: resolutionRecord.entityRefs,
        queueOrder,
        tempId: resolutionRecord.tempId,
      });
      await persistEntry(nextEntry, current);
      await ensureReplayScheduled();
      return;
    }

    if (!operation.conflictHandling) {
      await removeResolution(resolutionId, current);
      return;
    }

    const result = await operation.conflictHandling.resolveConflict({
      input: resolutionRecord.input,
      conflict: resolutionRecord.conflict,
      enqueuedAt: resolutionRecord.enqueuedAt,
      updatedAt: resolutionRecord.updatedAt,
      resolution,
    });

    await removeResolution(resolutionId, current);

    const typedResult: OfflineResolveConflictResult<unknown> = result;
    if (!typedResult) return;

    const requeue = typedResult.requeue;

    if (requeue) {
      await queuePreparedMutations({
        currentSessionKey: current.sessionKey,
        mutations: [
          prepareMutationWithSession(current, {
            // WORKAROUND: Resolution records persist operation names as plain strings, and requeueing needs to rebind the validated name to the operation-map key type.
            operation: __LEGIT_CAST__<keyof TOperations & string, string>(
              resolutionRecord.operation,
            ),
            input: requeue.input,
            tempId: resolutionRecord.tempId,
            entityRefs: resolutionRecord.entityRefs,
          }),
        ],
      });
    }
  }

  async function evaluateOfflineFetchError(
    error: unknown,
    operationName?: string,
  ): Promise<void> {
    const current = ensureActiveSession();
    if (!current) return;

    await current.session.classifyFailure(error, {
      phase: 'fetch',
      storeType,
      operationName,
      sessionKey: current.sessionKey,
    });
  }

  function getSessionStatus() {
    const current = ensureActiveSession();
    return current?.session.getStatus() ?? null;
  }

  function canQueueMutation(): boolean {
    return getSessionKey() !== false;
  }

  async function prepareForFetch(): Promise<void> {
    await hydrateIfNeeded();
    const current = ensureActiveSession();
    if (!current) return;
    await current.session.refreshNetworkState();
  }

  return {
    hydrateIfNeeded,
    canQueueMutation,
    prepareForMutation,
    queueMutation,
    getOfflineEntities,
    getOfflineResolutions,
    resolveOfflineResolution,
    prepareForFetch,
    getSessionStatus,
    evaluateOfflineFetchError,
    ensureReplayScheduled,
  };
}
