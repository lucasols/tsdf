import { createAsyncQueue } from '@ls-stack/utils/asyncQueue';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import type { ValidPayload } from '../../utils/storeShared';
import { getStoragePrefixForStoreNamespace } from '../persistentStorageManager';
import { createStorageAdapter, isAsyncStorageAdapter } from '../storageAdapter';
import type {
  AsyncStorageNamespaceHandle,
  StorageAdapter,
  StorageBackend,
  StorageCacheEntry,
  SyncStorageAdapter,
} from '../types';
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
  backend?: StorageBackend;
  getSessionKey: () => string | false;
  onPersistentStorageError?: (error: unknown) => void;
  adapter?: StorageAdapter;
  offlineMode: OfflineModeConfig<TOperations>;
  storeAdapter: OfflineStoreAdapter<THelpers, TMutationPayload>;
};

type OfflineNamespaceHandle<T> = {
  get: (key: string) => Promise<T | null>;
  getMany: (keys: string[]) => Promise<Array<T | null>>;
  commit: (args: {
    upserts?: Array<{ key: string; value: T }>;
    removes?: string[];
  }) => Promise<void>;
  listPage: (
    cursor?: string | null,
  ) => Promise<{ keys: string[]; cursor: string | null }>;
  clear: () => Promise<void>;
};

type ActiveSessionState = {
  sessionKey: string;
  session: ReturnType<typeof getOrCreateSessionOfflineCoordinator>;
  unregister: (() => void) | null;
  queueNamespace: OfflineNamespaceHandle<OfflineQueueEntry>;
  conflictNamespace: OfflineNamespaceHandle<OfflineConflictRecord>;
  entityNamespace: OfflineNamespaceHandle<GlobalOfflineEntity>;
};

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

function encodePageCursor(offset: number): string {
  return JSON.stringify({ offset });
}

function decodePageCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;

  try {
    const parsed: unknown = JSON.parse(cursor);
    if (
      parsed &&
      typeof parsed === 'object' &&
      'offset' in parsed &&
      typeof parsed.offset === 'number'
    ) {
      return parsed.offset;
    }
  } catch {
    // Ignore malformed cursors and restart from the beginning.
  }

  return 0;
}

function createLocalNamespaceHandle<T>(args: {
  adapter: SyncStorageAdapter;
  sessionKey: string;
  storeName: string;
  entryPrefix: string;
  version: number;
}): OfflineNamespaceHandle<T> {
  const prefix = getStoragePrefixForStoreNamespace(
    args.sessionKey,
    args.storeName,
    args.entryPrefix,
  );

  async function readOne(key: string): Promise<T | null> {
    const entry = await args.adapter.read<StorageCacheEntry<T>>(
      `${prefix}${key}`,
    );
    if (!entry || entry.version !== args.version) return null;
    return entry.data;
  }

  return {
    get: readOne,
    async getMany(keys: string[]): Promise<Array<T | null>> {
      return Promise.all(keys.map((key) => readOne(key)));
    },
    async commit({
      upserts = [],
      removes = [],
    }: {
      upserts?: Array<{ key: string; value: T }>;
      removes?: string[];
    }): Promise<void> {
      const now = Date.now();
      await Promise.all([
        ...upserts.map((entry) =>
          args.adapter.write(`${prefix}${entry.key}`, {
            data: entry.value,
            timestamp: now,
            version: args.version,
          } satisfies StorageCacheEntry<T>),
        ),
        ...removes.map((key) => args.adapter.remove(`${prefix}${key}`)),
      ]);
    },
    async listPage(
      cursor?: string | null,
    ): Promise<{ keys: string[]; cursor: string | null }> {
      const offset = decodePageCursor(cursor);
      const keys = (await args.adapter.listKeys(prefix))
        .map((key) => key.slice(prefix.length))
        .sort();
      const page = keys.slice(offset, offset + 100);

      return {
        keys: page,
        cursor:
          offset + page.length >= keys.length
            ? null
            : encodePageCursor(offset + page.length),
      };
    },
    clear(): Promise<void> {
      return args.adapter.removeByPrefix(prefix);
    },
  };
}

function createAsyncNamespaceHandle<T>(args: {
  namespace: AsyncStorageNamespaceHandle<T>;
}): OfflineNamespaceHandle<T> {
  return {
    async get(key: string): Promise<T | null> {
      const entry = await args.namespace.get(key, { touch: 'never' });
      return entry?.value ?? null;
    },
    async getMany(keys: string[]): Promise<Array<T | null>> {
      const entries = await args.namespace.getMany(keys, { touch: 'never' });
      return entries.map((entry) => entry?.value ?? null);
    },
    commit({
      upserts = [],
      removes = [],
    }: {
      upserts?: Array<{ key: string; value: T }>;
      removes?: string[];
    }): Promise<void> {
      return args.namespace.commit({
        upserts: upserts.map((entry) => ({
          key: entry.key,
          value: entry.value,
          version: 1,
        })),
        removes,
      });
    },
    async listPage(
      cursor?: string | null,
    ): Promise<{ keys: string[]; cursor: string | null }> {
      const page = await args.namespace.listMetadata({
        cursor,
        limit: 100,
        order: 'key',
      });

      return {
        keys: page.entries.map((entry) => entry.key),
        cursor: page.cursor,
      };
    },
    clear(): Promise<void> {
      return args.namespace.clear();
    },
  };
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
  backend = 'opfs',
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
      backend,
      adapter,
      onPersistentStorageError,
      config: __LEGIT_CAST__<
        OfflineModeConfig<Record<string, OfflineOperationSchemaShape>>,
        OfflineModeConfig<TOperations>
      >(offlineMode),
    });

    const resolvedAdapter = adapter ?? createStorageAdapter(backend);
    const queueNamespace = isAsyncStorageAdapter(resolvedAdapter)
      ? createAsyncNamespaceHandle({
          namespace: resolvedAdapter.openNamespace<OfflineQueueEntry>({
            sessionKey,
            storeName,
            kind: 'offline.queue',
          }),
        })
      : createLocalNamespaceHandle<OfflineQueueEntry>({
          adapter: resolvedAdapter,
          sessionKey,
          storeName,
          entryPrefix: 'offline.queue',
          version: 1,
        });
    const conflictNamespace = isAsyncStorageAdapter(resolvedAdapter)
      ? createAsyncNamespaceHandle({
          namespace: resolvedAdapter.openNamespace<OfflineConflictRecord>({
            sessionKey,
            storeName,
            kind: 'offline.conflict',
          }),
        })
      : createLocalNamespaceHandle<OfflineConflictRecord>({
          adapter: resolvedAdapter,
          sessionKey,
          storeName,
          entryPrefix: 'offline.conflict',
          version: 1,
        });
    const entityNamespace = isAsyncStorageAdapter(resolvedAdapter)
      ? createAsyncNamespaceHandle({
          namespace: resolvedAdapter.openNamespace<GlobalOfflineEntity>({
            sessionKey,
            storeName,
            kind: 'offline.entity',
          }),
        })
      : createLocalNamespaceHandle<GlobalOfflineEntity>({
          adapter: resolvedAdapter,
          sessionKey,
          storeName,
          entryPrefix: 'offline.entity',
          version: 1,
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
      const loadedQueueEntries = new Map<string, OfflineQueueEntry>();
      const loadedConflictEntries = new Map<string, OfflineConflictRecord>();
      let queueCursor: string | null = null;
      let conflictCursor: string | null = null;

      do {
        const page = await current.queueNamespace.listPage(queueCursor);
        const entries = await current.queueNamespace.getMany(page.keys);
        for (const entry of entries) {
          if (!entry) continue;
          loadedQueueEntries.set(entry.id, entry);
        }
        queueCursor = page.cursor;
      } while (queueCursor !== null);

      do {
        const page = await current.conflictNamespace.listPage(conflictCursor);
        const entries = await current.conflictNamespace.getMany(page.keys);
        for (const conflict of entries) {
          if (!conflict) continue;
          loadedConflictEntries.set(conflict.id, conflict);
        }
        conflictCursor = page.cursor;
      } while (conflictCursor !== null);

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
    const currentSession = current ?? ensureActiveSession();
    if (!currentSession || !isActiveSessionState(currentSession)) return;

    const entitiesByKey = new Map<string, GlobalOfflineEntity>();

    for (const entry of queueEntries.values()) {
      for (const ref of entry.entityRefs) {
        const id = buildEntityId(
          currentSession.sessionKey,
          storeName,
          ref.entityKey,
        );
        const existing = entitiesByKey.get(ref.entityKey);
        entitiesByKey.set(ref.entityKey, {
          id,
          sessionKey: currentSession.sessionKey,
          storeName,
          storeType,
          entityKey: ref.entityKey,
          entityKind: ref.entityKind,
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
        const id = buildEntityId(
          currentSession.sessionKey,
          storeName,
          ref.entityKey,
        );
        const existing = entitiesByKey.get(ref.entityKey);
        entitiesByKey.set(ref.entityKey, {
          id,
          sessionKey: currentSession.sessionKey,
          storeName,
          storeType,
          entityKey: ref.entityKey,
          entityKind: ref.entityKind,
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

    currentSession.session.syncStoreData(storeName, {
      entities,
      conflicts: [...conflicts.values()],
      protectedKeys,
    });

    void syncEntityNamespace(currentSession, entities);
  }

  async function syncEntityNamespace(
    current: ActiveSessionState,
    entities: GlobalOfflineEntity[],
  ): Promise<void> {
    const nextKeys = new Set(entities.map((entity) => entity.entityKey));
    const existingKeys: string[] = [];
    let cursor: string | null = null;

    do {
      const page = await current.entityNamespace.listPage(cursor);
      existingKeys.push(...page.keys);
      cursor = page.cursor;
    } while (cursor !== null);

    await current.entityNamespace.commit({
      upserts: entities.map((entity) => ({
        key: entity.entityKey,
        value: entity,
      })),
      removes: existingKeys.filter((key) => !nextKeys.has(key)),
    });
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
    await session.queueNamespace.commit({
      upserts: [{ key: entry.id, value: entry }],
    });
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
    await session.queueNamespace.commit({ removes: [entryId] });
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
    await session.conflictNamespace.commit({
      upserts: [{ key: conflict.id, value: conflict }],
    });
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
    await session.conflictNamespace.commit({ removes: [conflictId] });
    if (isActiveSessionState(session)) {
      refreshDerivedState(session);
    }
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
        if (shouldConfirmBeforeRetry && operation.confirmRemoteOutcome) {
          const confirmed = await operation.confirmRemoteOutcome({
            sessionKey: current.sessionKey,
            helpers,
            input: entryToUse.input,
            mutationPayload: __LEGIT_CAST__<
              TMutationPayload | undefined,
              unknown
            >(entryToUse.mutationPayload),
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

            if (
              conflictHandling.schema &&
              validateWithSchema(
                conflictHandling.schema,
                confirmed.conflict,
              ) === null
            ) {
              throw new Error(
                `Invalid offline conflict payload for operation "${entryToUse.operation}"`,
              );
            }

            await persistConflict(
              buildConflictRecord(current, entryToUse, confirmed.conflict),
              current,
            );
            await removeEntry(entryToUse.id, current);
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
          mutationPayload: __LEGIT_CAST__<
            TMutationPayload | undefined,
            unknown
          >(entryToUse.mutationPayload),
        });
        const conflict = conflictHandling
          ? await conflictHandling.detectConflict({
              sessionKey: current.sessionKey,
              helpers,
              input: entryToUse.input,
              mutationPayload: __LEGIT_CAST__<
                TMutationPayload | undefined,
                unknown
              >(entryToUse.mutationPayload),
              result,
            })
          : false;

        if (conflict) {
          if (
            conflictHandling?.schema &&
            validateWithSchema(conflictHandling.schema, conflict) === null
          ) {
            throw new Error(
              `Invalid offline conflict payload for operation "${entryToUse.operation}"`,
            );
          }

          await persistConflict(
            buildConflictRecord(current, entryToUse, conflict),
            current,
          );
          await removeEntry(entryToUse.id, current);
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
