import { createAsyncQueue } from '@ls-stack/utils/asyncQueue';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import type { ValidPayload } from '../../utils/storeShared';
import { createPersistentStorageNamespaceHandle } from '../persistentStorageManager';
import type { StorageAdapter } from '../types';
import { validateWithSchema } from '../validateWithSchema';
import { getOrCreateSessionOfflineCoordinator } from './sessionCoordinator';
import type {
  AnyOfflineOperationDefinition,
  GlobalOfflineEntity,
  OfflineConflictRecord,
  OfflineEntityRef,
  OfflineModeConfig,
  OperationInput,
  OfflineOperationSchemaShape,
  OfflineQueueEntry,
  OfflineStoreType,
} from './types';

const NEEDS_CONFIRMATION_RETRY_MS = 250;

type OfflineStoreAdapter<THelpers, TMutationPayload> = {
  getHelpers: () => THelpers;
  getEntityRefs: (args: {
    operationName: string;
    input: unknown;
    mutationPayload?: TMutationPayload;
    tempId?: string;
  }) => OfflineEntityRef[];
  getProtectedCacheKeys: (entityRefs: OfflineEntityRef[]) => string[];
  applyPendingEntity?: (args: {
    operationName: string;
    input: unknown;
    tempId: string;
    pendingEntity: unknown;
  }) => void;
  reconcileTempEntity?: (args: {
    operationName: string;
    input: unknown;
    tempId: string;
    result: unknown;
    reconciliation: { finalPayload: ValidPayload; finalData?: unknown };
  }) => void;
};

type CreateOfflineStoreControllerOptions<
  TOperations extends Record<string, AnyOfflineOperationDefinition>,
  THelpers,
  TMutationPayload,
> = {
  storeName: string;
  storeType: OfflineStoreType;
  getSessionKey: () => string | false;
  onPersistentStorageError?: (error: unknown) => void;
  adapter: StorageAdapter;
  offlineMode: OfflineModeConfig<TOperations>;
  storeAdapter: OfflineStoreAdapter<THelpers, TMutationPayload>;
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
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  return left.id.localeCompare(right.id);
}

export type OfflineStoreController<
  TOperations extends Record<string, OfflineOperationSchemaShape>,
  TMutationPayload = unknown,
> = {
  hydrateIfNeeded: () => Promise<void>;
  canQueueMutation: () => boolean;
  queueMutation: <TName extends keyof TOperations>(args: {
    operationName: TName;
    input: OperationInput<TOperations, TName>;
    mutationPayload?: TMutationPayload;
  }) => Promise<void>;
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
  THelpers,
  TMutationPayload,
>({
  storeName,
  storeType,
  getSessionKey,
  onPersistentStorageError,
  adapter,
  offlineMode,
  storeAdapter,
}: CreateOfflineStoreControllerOptions<
  TOperations,
  THelpers,
  TMutationPayload
>): OfflineStoreController<TOperations, TMutationPayload> {
  const replayQueue = createAsyncQueue({ concurrency: 1, autoStart: true });
  let activeSession: ActiveSessionState | null = null;
  let replayScheduled = false;
  let replayRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let hydratedSessionKey: string | null = null;
  let hydratedPromise: Promise<void> | null = null;
  const queueEntries = new Map<string, OfflineQueueEntry>();
  const conflicts = new Map<string, OfflineConflictRecord>();
  const confirmationRetriesConsumed = new Set<string>();
  const resolvedAdapter = adapter;

  async function loadNamespaceRecords<T extends { id: string }>(
    namespace: NamespacePersistenceHandle<T>,
  ): Promise<Map<string, T>> {
    const keys = await namespace.listKeys();
    const records = await Promise.all(keys.map((key) => namespace.load(key)));
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

  function ensureActiveSession(): ActiveSessionState | null {
    const sessionKey = getSessionKey();
    if (sessionKey === false) return null;

    if (activeSession?.sessionKey === sessionKey) return activeSession;

    activeSession?.unregister?.();
    activeSession = null;
    resetConfirmationRetries();
    queueEntries.clear();
    conflicts.clear();
    hydratedSessionKey = null;
    hydratedPromise = null;

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
        adapter: resolvedAdapter,
        getSessionKey: () => sessionKey,
        onPersistentStorageError,
        entryPrefix: 'offline.queue',
      });
    const conflictNamespace =
      createPersistentStorageNamespaceHandle<OfflineConflictRecord>({
        storeName,
        adapter: resolvedAdapter,
        getSessionKey: () => sessionKey,
        onPersistentStorageError,
        entryPrefix: 'offline.conflict',
      });
    const entityNamespace =
      createPersistentStorageNamespaceHandle<GlobalOfflineEntity>({
        storeName,
        adapter: resolvedAdapter,
        getSessionKey: () => sessionKey,
        onPersistentStorageError,
        entryPrefix: 'offline.entity',
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
      entities.flatMap((entity) => ({
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

  function findAccumulationCandidate(args: {
    operationName: string;
    entityRefs: OfflineEntityRef[];
  }): OfflineQueueEntry | null {
    const normalizedEntityRefs = normalizeEntityRefs(args.entityRefs);
    let candidate: OfflineQueueEntry | null = null;

    for (const entry of queueEntries.values()) {
      if (entry.operation !== args.operationName) continue;
      if (entry.syncState !== 'pending') continue;
      if (entry.attempts > 0) continue;
      if (entry.tempId) continue;
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
      mutationPayload: entry.mutationPayload,
      entityRefs: entry.entityRefs,
      createdAt: now,
      updatedAt: now,
      tempId: entry.tempId,
    };
  }

  async function persistEntry(
    entry: OfflineQueueEntry,
    current?: ActiveSessionState,
  ): Promise<void> {
    const session = current ?? ensureActiveSession();
    if (!session) return;
    if (isActiveSessionState(session)) {
      queueEntries.set(entry.id, entry);
    }
    await session.queueNamespace.save(entry.id, entry);
    if (isActiveSessionState(session)) {
      refreshDerivedState(session);
    }
  }

  async function removeEntry(
    entryId: string,
    current?: ActiveSessionState,
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
    if (isActiveSessionState(session)) {
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
      AnyOfflineOperationDefinition<
        THelpers,
        TMutationPayload
      >['conflictHandling']
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

  async function queueMutationWithSession<TName extends keyof TOperations>(
    current: ActiveSessionState,
    args: {
      operationName: TName;
      input: unknown;
      mutationPayload?: TMutationPayload;
    },
  ): Promise<void> {
    const operationName = String(args.operationName);
    const helpers = storeAdapter.getHelpers();
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

    const tempEntity = operation.tempEntity;
    const tempId = tempEntity?.createTempId(validatedInput);
    if (tempId && tempEntity && storeAdapter.applyPendingEntity) {
      const pendingEntity = tempEntity.buildPendingEntity(
        validatedInput,
        tempId,
      );
      storeAdapter.applyPendingEntity({
        operationName,
        input: validatedInput,
        tempId,
        pendingEntity,
      });
    }

    const entityRefs = storeAdapter.getEntityRefs({
      operationName,
      input: validatedInput,
      mutationPayload: args.mutationPayload,
      tempId,
    });
    const now = Date.now();

    if (operation.accumulation && !tempId) {
      const existingEntry = findAccumulationCandidate({
        operationName,
        entityRefs,
      });

      if (existingEntry) {
        const mergedInput = await operation.accumulation.mergeInput({
          sessionKey: current.sessionKey,
          helpers,
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

        await persistEntry(
          { ...existingEntry, input: validatedMergedInput, updatedAt: now },
          current,
        );
        await ensureReplayScheduled();
        return;
      }
    }

    await persistEntry(
      {
        id: `${storeName}:${now}:${Math.random().toString(36).slice(2, 10)}`,
        sessionKey: current.sessionKey,
        storeName,
        storeType,
        operation: operationName,
        input: validatedInput,
        mutationPayload: args.mutationPayload,
        entityRefs,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        lastAttemptAt: null,
        syncState: 'pending',
        tempId,
      },
      current,
    );

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

      const shouldConfirmBeforeRetry =
        nextEntry.syncState === 'needs-confirmation';
      const helpers = storeAdapter.getHelpers();
      const conflictHandling = operation.conflictHandling;
      const tempEntity = operation.tempEntity;
      let entryToUse: OfflineQueueEntry = {
        ...nextEntry,
        syncState: 'syncing',
        updatedAt: Date.now(),
        lastAttemptAt: Date.now(),
      };
      await persistEntry(entryToUse, current);

      try {
        const mutationPayload = __LEGIT_CAST__<
          TMutationPayload | undefined,
          unknown
        >(entryToUse.mutationPayload);

        if (shouldConfirmBeforeRetry && operation.confirmRemoteOutcome) {
          const confirmed = await operation.confirmRemoteOutcome({
            sessionKey: current.sessionKey,
            helpers,
            input: entryToUse.input,
            mutationPayload,
          });

          if (confirmed.type === 'applied') {
            await removeEntry(entryToUse.id, current);
            continue;
          }

          if (confirmed.type === 'conflict') {
            if (!conflictHandling) {
              throw new Error(
                `Operation "${entryToUse.operation}" returned a conflict without conflictHandling configured`,
              );
            }

            await persistValidatedConflict({
              current,
              entry: entryToUse,
              conflict: confirmed.conflict,
              conflictHandling,
            });
            continue;
          }

          if (confirmed.type === 'unknown') {
            entryToUse = {
              ...entryToUse,
              syncState: 'needs-confirmation',
              updatedAt: Date.now(),
            };
            await persistEntry(entryToUse, current);
            scheduleReplayRetry(entryToUse.id);
            return;
          }
        }

        const result = await operation.execute({
          sessionKey: current.sessionKey,
          helpers,
          input: entryToUse.input,
          mutationPayload,
        });
        const conflict = conflictHandling
          ? await conflictHandling.detectConflict({
              sessionKey: current.sessionKey,
              helpers,
              input: entryToUse.input,
              mutationPayload,
              result,
            })
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

        if (
          entryToUse.tempId &&
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
          syncState: operation.confirmRemoteOutcome
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
        if (operation.confirmRemoteOutcome) {
          scheduleReplayRetry(entryToUse.id);
        }
        return;
      }
    }
  }

  async function queueMutation<TName extends keyof TOperations>(args: {
    operationName: TName;
    input: unknown;
    mutationPayload?: TMutationPayload;
  }): Promise<void> {
    await hydrateIfNeeded();
    const current = ensureActiveSession();
    if (!current) {
      throw offlineSessionUnavailableError;
    }

    await queueMutationWithSession(current, args);
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
      sessionKey: current.sessionKey,
      helpers: storeAdapter.getHelpers(),
      input: conflict.input,
      conflict: conflict.conflict,
      mutationPayload: __LEGIT_CAST__<TMutationPayload | undefined, unknown>(
        conflict.mutationPayload,
      ),
      resolution,
    });

    await removeConflict(conflictId, current);

    if (result?.requeue) {
      await queueMutationWithSession(current, {
        operationName: __LEGIT_CAST__<keyof TOperations, string>(
          conflict.operation,
        ),
        input: result.requeue.input,
        mutationPayload: __LEGIT_CAST__<TMutationPayload | undefined, unknown>(
          conflict.mutationPayload,
        ),
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
