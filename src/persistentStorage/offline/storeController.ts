import { createAsyncQueue } from '@ls-stack/utils/asyncQueue';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';

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
import type {
  AnyOfflineOperationDefinition,
  GlobalOfflineEntity,
  OfflineConflictRecord,
  OfflineMutationInput,
  OfflineModeConfig,
  OfflineOperationSchemaShape,
  OfflineQueueEntry,
  OfflineResolveConflictResult,
  OfflineStoreType,
} from './types';

const NEEDS_CONFIRMATION_RETRY_MS = 250;

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
  conflictNamespace: ReturnType<
    typeof createPersistentStorageNamespaceHandle<OfflineConflictRecord>
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
  getOfflineConflicts: () => OfflineConflictRecord[];
  resolveOfflineConflict: (
    conflictId: string,
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
  const queueEntries = new Map<string, OfflineQueueEntry>();
  const conflicts = new Map<string, OfflineConflictRecord>();
  const confirmationRetriesConsumed = new Set<string>();

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

  function resetConfirmationRetries(): void {
    clearReplayRetryTimer();
    confirmationRetriesConsumed.clear();
  }

  function scheduleReplayRetry(entryId: string): void {
    if (confirmationRetriesConsumed.has(entryId)) return;
    if (replayRetryTimer !== null) return;
    confirmationRetriesConsumed.add(entryId);

    replayRetryTimer = setTimeout(() => {
      replayRetryTimer = null;
      void ensureReplayScheduled();
    }, NEEDS_CONFIRMATION_RETRY_MS);
  }

  function isActiveSessionState(current: ActiveSessionState): boolean {
    return activeSession?.sessionKey === current.sessionKey;
  }

  function teardownActiveSession(): void {
    activeSession?.unregister?.();
    activeSession = null;
    resetConfirmationRetries();
    queueEntries.clear();
    conflicts.clear();
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
    const conflictNamespace =
      createPersistentStorageNamespaceHandle<OfflineConflictRecord>({
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
        confirmationRetriesConsumed.clear();
        void ensureReplayScheduled();
      },
    });

    activeSession = {
      sessionKey,
      session,
      unregister,
      queueNamespace,
      conflictNamespace,
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
      const [loadedQueueEntries, loadedConflictEntries] = await Promise.all([
        loadNamespaceRecords(current.queueNamespace),
        loadNamespaceRecords(current.conflictNamespace),
      ]);

      if (!isActiveSessionState(current)) return;

      queueEntries.clear();
      conflicts.clear();
      for (const entry of loadedQueueEntries.values()) {
        queueEntries.set(entry.id, entry);
      }
      for (const conflict of loadedConflictEntries.values()) {
        conflicts.set(conflict.id, conflict);
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
          hasConflict: existing?.hasConflict ?? false,
          createdAt: existing?.createdAt ?? entry.createdAt,
          updatedAt: entry.updatedAt,
          tempId: entry.tempId ?? existing?.tempId,
        });
      }
    }

    for (const conflict of conflicts.values()) {
      for (const ref of conflict.entityRefs) {
        const existing = entitiesByKey.get(ref.entityKey);

        entitiesByKey.set(ref.entityKey, {
          ...createEntityBase(ref),
          pendingMutations: existing?.pendingMutations ?? 0,
          syncState: 'conflict',
          hasConflict: true,
          createdAt: existing?.createdAt ?? conflict.createdAt,
          updatedAt: conflict.updatedAt,
          tempId: conflict.tempId ?? existing?.tempId,
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
      conflicts: [...conflicts.values()],
      protectedKeys,
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

  function buildConflictRecord(
    current: ActiveSessionState,
    entry: OfflineQueueEntry,
    conflict: unknown,
  ): OfflineConflictRecord {
    const now = Date.now();

    return {
      id: `conflict:${entry.id}`,
      entryId: entry.id,
      sessionKey: current.sessionKey,
      storeName,
      storeType,
      operation: entry.operation,
      input: entry.input,
      conflict,
      enqueuedAt: entry.createdAt,
      entityRefs: entry.entityRefs,
      createdAt: now,
      updatedAt: now,
      tempId: entry.tempId,
    };
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
      confirmationRetriesConsumed.delete(entryId);
      if (queueEntries.size === 0) {
        resetConfirmationRetries();
      }
    }
    await session.queueNamespace.remove(entryId);
    if (!skipRefresh && isActiveSessionState(session)) {
      refreshDerivedState(session);
    }
  }

  async function persistConflict(
    conflict: OfflineConflictRecord,
    current?: ActiveSessionState,
  ): Promise<void> {
    const session = current ?? ensureActiveSession();
    if (!session) return;
    if (isActiveSessionState(session)) {
      conflicts.set(conflict.id, conflict);
    }
    await session.conflictNamespace.save(conflict.id, conflict);
    if (isActiveSessionState(session)) {
      refreshDerivedState(session);
    }
  }

  async function removeConflict(
    conflictId: string,
    current?: ActiveSessionState,
  ): Promise<void> {
    const session = current ?? ensureActiveSession();
    if (!session) return;
    if (isActiveSessionState(session)) {
      conflicts.delete(conflictId);
    }
    await session.conflictNamespace.remove(conflictId);
    if (isActiveSessionState(session)) {
      refreshDerivedState(session);
    }
  }

  async function persistValidatedConflict(args: {
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

    await persistConflict(
      buildConflictRecord(args.current, args.entry, args.conflict),
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
      : __LEGIT_CAST__<OfflineEntityRef[], unknown[]>(rawEntityRefs);
    const entityRefs =
      tempEntity !== undefined &&
      preparedTempId !== undefined &&
      preparedEntityRefs !== undefined
        ? preparedEntityRefs
        : resolvedEntityRefs;
    const tempId =
      tempEntity !== undefined
        ? (preparedTempId ??
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

    const nextEntry = {
      id: `${storeName}:${now}:${Math.random().toString(36).slice(2, 10)}`,
      sessionKey: current.sessionKey,
      storeName,
      storeType,
      operation: operationName,
      input: validatedInput,
      queueOrder,
      entityRefs,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      lastAttemptAt: null,
      syncState: 'pending' as const,
      tempId,
    };
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
    clearReplayRetryTimer();
    if (hydratedSessionKey !== current.sessionKey || hydratedPromise !== null) {
      await hydrateIfNeeded();
      current = ensureActiveSession();
      if (!current) return;
    }
    if (
      replayScheduled ||
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
          scheduleReplayRetry(nextEntry.id);
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

          await persistValidatedConflict({
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
        }

        await removeEntry(entryToUse.id, current);
      } catch (error) {
        entryToUse = {
          ...entryToUse,
          attempts: entryToUse.attempts + 1,
          updatedAt: Date.now(),
          lastAttemptAt: Date.now(),
          syncState: operation.shouldSkipSync
            ? 'needs-confirmation'
            : 'pending',
          lastError: { message: toMessage(error) },
        };
        await persistEntry(entryToUse, current);
        await current.session.classifyFailure(error, {
          phase: 'sync',
          storeType,
          operationName: entryToUse.operation,
          sessionKey: current.sessionKey,
        });
        if (operation.shouldSkipSync) {
          scheduleReplayRetry(entryToUse.id);
        }
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

  function getOfflineConflicts(): OfflineConflictRecord[] {
    return [...conflicts.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
  }

  async function resolveOfflineConflict(
    conflictId: string,
    resolution: unknown,
  ): Promise<void> {
    await hydrateIfNeeded();
    const current = ensureActiveSession();
    if (!current) return;

    const conflict = conflicts.get(conflictId);
    if (!conflict) return;

    const operation = offlineMode.operations[conflict.operation];
    if (!operation) {
      await removeConflict(conflictId, current);
      return;
    }
    if (!operation.conflictHandling) {
      await removeConflict(conflictId, current);
      return;
    }

    const result = await operation.conflictHandling.resolveConflict({
      input: conflict.input,
      conflict: conflict.conflict,
      enqueuedAt: conflict.enqueuedAt,
      updatedAt: conflict.updatedAt,
      resolution,
    });

    await removeConflict(conflictId, current);

    const typedResult: OfflineResolveConflictResult<unknown> = result;
    if (!typedResult) return;

    const requeue = typedResult.requeue;

    if (requeue) {
      await queuePreparedMutations({
        currentSessionKey: current.sessionKey,
        mutations: [
          prepareMutationWithSession(current, {
            operation: __LEGIT_CAST__<keyof TOperations & string, string>(
              conflict.operation,
            ),
            input: requeue.input,
            tempId: conflict.tempId,
            entityRefs: conflict.entityRefs,
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
    getOfflineConflicts,
    resolveOfflineConflict,
    prepareForFetch,
    getSessionStatus,
    evaluateOfflineFetchError,
    ensureReplayScheduled,
  };
}
