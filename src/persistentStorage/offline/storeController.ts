import { createAsyncQueue } from '@ls-stack/utils/asyncQueue';
import { deepEqual } from '@ls-stack/utils/deepEqual';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { isObject, isPromise } from '@ls-stack/utils/typeGuards';
import {
  rc_array,
  rc_literals,
  rc_number,
  rc_object,
  rc_parse,
  rc_string,
  rc_unknown,
} from 'runcheck';
import { Result } from 't-result';

import type { ValidPayload } from '../../utils/storeShared';
import { createPersistentStorageNamespaceHandle } from '../persistentStorageManager';
import {
  OFFLINE_CONFLICT_STORAGE_ENTRY_PREFIX,
  OFFLINE_ENTITY_STORAGE_ENTRY_PREFIX,
  OFFLINE_QUEUE_STORAGE_ENTRY_PREFIX,
} from '../storageEntryPrefixes';
import type { StorageAdapter } from '../types';
import { parseWithSchema, validateWithSchema } from '../validateWithSchema';
import type { PreparedOfflineMutation } from './mutationRuntime';
import { getOrCreateSessionOfflineCoordinator } from './sessionCoordinator';
import {
  isModeEffectivelyActive,
  OfflineResolutionConflictParseError,
  offlineResolutionRecordSchema,
  type AnyOfflineOperationDefinition,
  type GlobalOfflineEntity,
  type OfflineMutationInput,
  type OfflineMutationQueueingCause,
  type OfflineMutationQueueingPolicy,
  type OfflineOperationSchemaShape,
  type OfflineQueueEntry,
  type OfflineResolutionActionForOperation,
  type OfflineResolutionRecordForStore,
  type OfflineSession,
  type OfflineStoreType,
  type OperationConflict,
  type ParsedOfflineResolutionConflictResultForOperation,
  type PersistedOfflineResolutionRecord,
} from './types';

const DEFAULT_REPLAY_RETRY_MAX_FAILURES = 3;
const DEFAULT_REPLAY_RETRY_INTERVAL_MS = 5_000;
const BLOCKED_DEPENDENCY_RESOLUTION_MESSAGE =
  'Blocked by unresolved dependency';

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
  rebindQueuedMutationOverlays?: (args: {
    sessionKey: string;
    itemKeyRewrites: { previousItemKey: string; nextItemKey: string }[];
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
  storeAdapter: OfflineStoreAdapter;
  offlineSession: OfflineSession;
  operations: TOperations;
};

type ActiveSessionState = {
  sessionKey: string;
  session: ReturnType<typeof getOrCreateSessionOfflineCoordinator>;
  unregister: (() => void) | null;
  queueNamespace: ReturnType<
    typeof createPersistentStorageNamespaceHandle<OfflineQueueEntry>
  >;
  resolutionNamespace: ReturnType<
    typeof createPersistentStorageNamespaceHandle<PersistedOfflineResolutionRecord>
  >;
  entityNamespace: ReturnType<
    typeof createPersistentStorageNamespaceHandle<GlobalOfflineEntity>
  >;
};

type NamespacePersistenceHandle<T> = Pick<
  ReturnType<typeof createPersistentStorageNamespaceHandle<T>>,
  'load' | 'listKeys' | 'remove' | 'save'
>;

const compactOfflineEntitySchema = rc_object({
  k: rc_string,
  g: rc_literals('d', 'i', 'q'),
  p: rc_number.optionalKey(),
  s: rc_literals('p', 's', 'n', 'r'),
  b: rc_array(rc_string).optionalKey(),
  c: rc_array(rc_string).optionalKey(),
  a: rc_number,
  u: rc_number,
  t: rc_unknown.optionalKey(),
});
const compactOfflineQueueEntrySchema = rc_object({
  d: rc_string,
  w: rc_literals('d', 'c', 'l'),
  o: rc_string,
  i: rc_unknown,
  q: rc_number.optionalKey(),
  e: rc_array(rc_string),
  t: rc_number.optionalKey(),
  a: rc_number,
  u: rc_number,
  l: rc_number.optionalKey(),
  s: rc_literals('p', 's', 'n'),
  x: rc_array(rc_unknown).optionalKey(),
  m: rc_string.optionalKey(),
  y: rc_literals(0, 1).optionalKey(),
  f: rc_unknown.optionalKey(),
});

function toCompactOfflineEntityKind(
  kind: GlobalOfflineEntity['entityKind'],
): 'd' | 'i' | 'q' {
  switch (kind) {
    case 'document':
      return 'd';
    case 'item':
      return 'i';
    case 'query':
      return 'q';
  }
}

function fromCompactOfflineEntityKind(
  kind: 'd' | 'i' | 'q',
): GlobalOfflineEntity['entityKind'] {
  switch (kind) {
    case 'd':
      return 'document';
    case 'i':
      return 'item';
    case 'q':
      return 'query';
  }
}

function serializeCompactOfflineEntityRef(ref: OfflineEntityRef): string {
  return `${toCompactOfflineEntityKind(ref.entityKind)}:${ref.entityKey}`;
}

function deserializeCompactOfflineEntityRef(
  value: string,
): OfflineEntityRef | null {
  const separatorIndex = value.indexOf(':');
  if (separatorIndex <= 0) return null;

  const compactKind = value.slice(0, separatorIndex);
  const entityKey = value.slice(separatorIndex + 1);
  if (entityKey.length === 0) return null;
  if (compactKind !== 'd' && compactKind !== 'i' && compactKind !== 'q') {
    return null;
  }

  return { entityKey, entityKind: fromCompactOfflineEntityKind(compactKind) };
}

function toCompactOfflineEntitySyncState(
  state: GlobalOfflineEntity['syncState'],
): 'p' | 's' | 'n' | 'r' {
  switch (state) {
    case 'pending':
      return 'p';
    case 'syncing':
      return 's';
    case 'needs-confirmation':
      return 'n';
    case 'resolution-required':
      return 'r';
  }
}

function toCompactOfflineStoreType(type: OfflineStoreType): 'd' | 'c' | 'l' {
  switch (type) {
    case 'document':
      return 'd';
    case 'collection':
      return 'c';
    case 'listQuery':
      return 'l';
  }
}

function fromCompactOfflineStoreType(type: 'd' | 'c' | 'l'): OfflineStoreType {
  switch (type) {
    case 'd':
      return 'document';
    case 'c':
      return 'collection';
    case 'l':
      return 'listQuery';
  }
}

function fromCompactOfflineEntitySyncState(
  state: 'p' | 's' | 'n' | 'r',
): GlobalOfflineEntity['syncState'] {
  switch (state) {
    case 'p':
      return 'pending';
    case 's':
      return 'syncing';
    case 'n':
      return 'needs-confirmation';
    case 'r':
      return 'resolution-required';
  }
}

function toCompactOfflineQueueSyncState(
  state: OfflineQueueEntry['syncState'],
): 'p' | 's' | 'n' {
  switch (state) {
    case 'pending':
      return 'p';
    case 'syncing':
      return 's';
    case 'needs-confirmation':
      return 'n';
  }
}

function fromCompactOfflineQueueSyncState(
  state: 'p' | 's' | 'n',
): OfflineQueueEntry['syncState'] {
  switch (state) {
    case 'p':
      return 'pending';
    case 's':
      return 'syncing';
    case 'n':
      return 'needs-confirmation';
  }
}

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

function serializePayload(value: ValidPayload): string {
  return JSON.stringify(value);
}

function formatPayloadForError(value: ValidPayload): string {
  return typeof value === 'string' ? value : serializePayload(value);
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

type TempLifecycleDependencySource = {
  entityKey: string;
  resolutionId?: string;
  sourceType: 'queue' | 'resolution';
};

type ResolutionDependencySnapshot = {
  blockedByResolutionIdsByResolutionId: Map<string, string[]>;
  childResolutionIdsByResolutionId: Map<string, string[]>;
  blockedByResolutionIdsByEntityKey: Map<string, string[]>;
  childResolutionIdsByEntityKey: Map<string, string[]>;
  blockedResolutionIdsByResolutionId: Map<string, Set<string>>;
};

type TempCreateDescendantCollection = {
  queueEntries: OfflineQueueEntry[];
  resolutions: PersistedOfflineResolutionRecord[];
};

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
  getOfflineResolutions: () => OfflineResolutionRecordForStore<TOperations>[];
  parseOfflineResolutionConflict: <TName extends keyof TOperations & string>(
    resolution: OfflineResolutionRecordForStore<TOperations, TName>,
  ) => ParsedOfflineResolutionConflictResultForOperation<TOperations, TName>;
  resolveOfflineResolution: <TName extends keyof TOperations & string>(
    resolutionId: string,
    operationName: TName,
    resolution: OfflineResolutionActionForOperation<TOperations, TName>,
  ) => Promise<void>;
  prepareForFetch: () => Promise<void>;
  getSessionStatus: () => { isOfflineMode: boolean } | null;
  shouldTreatFetchAsOffline: () => boolean;
  handleFetchSuccess: () => Promise<void>;
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
  storeAdapter,
  offlineSession,
  operations,
}: CreateOfflineStoreControllerOptions<TOperations>): OfflineStoreController<TOperations> {
  const sessionConfig = offlineSession.getConfig();
  const replayQueue = createAsyncQueue({ concurrency: 1, autoStart: true });
  let activeSession: ActiveSessionState | null = null;
  let replayScheduled = false;
  let replayRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let hydratedSessionKey: string | null = null;
  let hydratedPromise: Promise<void> | null = null;
  let nextQueueOrder = 0;
  const replayRetryMaxFailures =
    sessionConfig.replayRetry?.maxFailures ?? DEFAULT_REPLAY_RETRY_MAX_FAILURES;
  const replayRetryIntervalMs =
    sessionConfig.replayRetry?.intervalMs ?? DEFAULT_REPLAY_RETRY_INTERVAL_MS;
  const queueEntries = new Map<string, OfflineQueueEntry>();
  const resolutions = new Map<string, PersistedOfflineResolutionRecord>();
  const countedReplayFailures = new Map<string, number>();
  const resolvedEntityRefBySerializedRef = new Map<string, ValidPayload>();

  type InternalQueuedMutationArgs<TName extends keyof TOperations & string> = {
    operation: TName;
    input: unknown;
    tempIds?: ValidPayload[];
    entityRefs?: OfflineEntityRef[];
  };

  type PendingTempEntity = { tempId: ValidPayload; pendingEntity: unknown };

  type PreparedQueuedMutation = {
    currentSessionKey: string;
    operationName: string;
    operation: AnyOfflineOperationDefinition;
    validatedInput: unknown;
    tempIds?: ValidPayload[];
    entityRefs?: OfflineEntityRef[];
  };

  type PlannedQueuedMutation = {
    operationName: string;
    validatedInput: unknown;
    tempIds?: ValidPayload[];
    pendingEntities: PendingTempEntity[];
    nextEntry?: OfflineQueueEntry;
    removedEntries: OfflineQueueEntry[];
  };

  type AppliedQueuedMutation = PlannedQueuedMutation & {
    removedEntriesApplied: OfflineQueueEntry[];
    touchedNextEntry: boolean;
  };

  function getActiveMutationQueueingCause(
    current: ActiveSessionState,
  ): OfflineMutationQueueingCause | null {
    const status = current.session.getStatus();

    if (isModeEffectivelyActive(status.network)) return 'network';

    if (isModeEffectivelyActive(status.outage)) return 'outage';

    return null;
  }

  function shouldTreatFutureOperationsAsOffline(
    current: ActiveSessionState,
  ): boolean {
    return getActiveMutationQueueingCause(current) !== null;
  }

  function isMutationQueueingAllowed(
    cause: OfflineMutationQueueingCause,
  ): boolean {
    return resolveMutationQueueingPolicy(cause) !== 'disallow';
  }

  function resolveMutationQueueingPolicy(
    cause: OfflineMutationQueueingCause,
  ): OfflineMutationQueueingPolicy {
    const current = ensureActiveSession();
    return (
      current?.session.getRuntimeConfig().mutationQueueing[cause] ?? 'allow'
    );
  }

  function getInitialOfflineMutationAction(
    current: ActiveSessionState,
  ): PreparedOfflineMutation['initialAction'] {
    const status = current.session.getStatus();

    if (!status.isOfflineMode) return 'run';

    const cause = getActiveMutationQueueingCause(current);
    if (cause === null) return 'run';

    if (isMutationQueueingAllowed(cause)) return 'queue';

    return 'run';
  }

  async function clearOfflineStatusOnSuccess(
    currentSessionKey: string,
  ): Promise<void> {
    const current = ensureActiveSession();
    if (!current || current.sessionKey !== currentSessionKey) {
      throw offlineSessionUnavailableError;
    }

    const status = current.session.getStatus();
    if (!status.network.active && !status.outage.active) return;

    await current.session.refreshNetworkState();

    const statusAfterRefresh = current.session.getStatus();
    if (
      navigator.onLine !== false &&
      statusAfterRefresh.network.enabled &&
      statusAfterRefresh.network.active
    ) {
      current.session.setNetworkActive(false, { classified: false });
    }

    const statusAfterNetworkClear = current.session.getStatus();
    if (
      statusAfterNetworkClear.outage.enabled &&
      statusAfterNetworkClear.outage.active &&
      !statusAfterNetworkClear.network.active
    ) {
      current.session.setOutageActive(false);
    }
  }

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

  const resolveEntityRef = <TRef extends ValidPayload>(
    entityRef: TRef,
  ): TRef => {
    let currentRef: ValidPayload = entityRef;
    const seen = new Set<string>();

    while (true) {
      const serializedRef = serializePayload(currentRef);
      if (seen.has(serializedRef)) {
        // WORKAROUND: The resolver preserves the caller's entity-ref payload shape,
        // but the remap table stores refs behind the shared ValidPayload boundary.
        return __LEGIT_CAST__<TRef, ValidPayload>(currentRef);
      }

      seen.add(serializedRef);
      const nextRef = resolvedEntityRefBySerializedRef.get(serializedRef);
      if (nextRef === undefined || deepEqual(nextRef, currentRef)) {
        // WORKAROUND: Same ValidPayload-to-TRef boundary as above.
        return __LEGIT_CAST__<TRef, ValidPayload>(currentRef);
      }

      currentRef = nextRef;
    }
  };

  function rememberResolvedEntityRef(
    previousRef: ValidPayload,
    nextRef: ValidPayload,
  ): void {
    resolvedEntityRefBySerializedRef.set(
      serializePayload(previousRef),
      resolveEntityRef(nextRef),
    );
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
    resolvedEntityRefBySerializedRef.clear();
    queueEntries.clear();
    resolutions.clear();
    nextQueueOrder = 0;
    hydratedSessionKey = null;
    hydratedPromise = null;
  }

  function ensureActiveSession(): ActiveSessionState | null {
    const sessionKey = getSessionKey();
    const targetSessionKey = offlineSession.getSessionKey();

    if (sessionKey !== targetSessionKey) {
      throw new Error(
        `[tsdf] Store "${storeName}" is attached to offline session "${targetSessionKey}" but getSessionKey() returned "${sessionKey}"`,
      );
    }

    if (targetSessionKey === false) {
      if (activeSession) {
        teardownActiveSession();
      }
      return null;
    }

    if (activeSession?.sessionKey === targetSessionKey) return activeSession;

    teardownActiveSession();

    const session = getOrCreateSessionOfflineCoordinator(targetSessionKey, {
      adapter,
      onPersistentStorageError,
      config: sessionConfig,
    });

    const queueNamespace =
      createPersistentStorageNamespaceHandle<OfflineQueueEntry>(
        {
          storeName,
          adapter,
          getSessionKey: () => targetSessionKey,
          onPersistentStorageError,
          entryPrefix: OFFLINE_QUEUE_STORAGE_ENTRY_PREFIX,
        },
        {
          valueCodec: {
            serialize(entry) {
              return {
                d: entry.id,
                w: toCompactOfflineStoreType(entry.storeType),
                o: entry.operation,
                i: entry.input,
                ...(entry.queueOrder !== entry.createdAt
                  ? { q: entry.queueOrder }
                  : {}),
                e: entry.entityRefs.map(serializeCompactOfflineEntityRef),
                ...(entry.attempts !== 0 ? { t: entry.attempts } : {}),
                a: entry.createdAt,
                u: entry.updatedAt,
                ...(entry.lastAttemptAt !== null
                  ? { l: entry.lastAttemptAt }
                  : {}),
                s: toCompactOfflineQueueSyncState(entry.syncState),
                ...(entry.tempIds !== undefined ? { x: entry.tempIds } : {}),
                ...(entry.lastError ? { m: entry.lastError.message } : {}),
                ...(entry.allowReplayRetry !== undefined
                  ? { y: entry.allowReplayRetry ? 1 : 0 }
                  : {}),
                ...(entry.pendingConflict !== undefined
                  ? { f: entry.pendingConflict }
                  : {}),
              };
            },
            deserialize(raw) {
              const compactEntry = rc_parse(
                raw,
                compactOfflineQueueEntrySchema,
              ).unwrapOrNull();
              if (compactEntry === null) return null;

              const entityRefs = compactEntry.e
                .map(deserializeCompactOfflineEntityRef)
                .filter((ref) => ref !== null);
              if (entityRefs.length !== compactEntry.e.length) return null;

              return {
                id: compactEntry.d,
                sessionKey: targetSessionKey,
                storeName,
                storeType: fromCompactOfflineStoreType(compactEntry.w),
                operation: compactEntry.o,
                input: compactEntry.i,
                queueOrder: compactEntry.q ?? compactEntry.a,
                entityRefs,
                attempts: compactEntry.t ?? 0,
                createdAt: compactEntry.a,
                updatedAt: compactEntry.u,
                lastAttemptAt: compactEntry.l ?? null,
                syncState: fromCompactOfflineQueueSyncState(compactEntry.s),
                ...(compactEntry.x !== undefined
                  ? {
                      // WORKAROUND: Compact queue payloads persist temp ids as unknown JSON values, and the controller rebinds that validated payload back to ValidPayload[] when hydrating.
                      tempIds: __LEGIT_CAST__<ValidPayload[], unknown[]>(
                        compactEntry.x,
                      ),
                    }
                  : {}),
                ...(compactEntry.m !== undefined
                  ? { lastError: { message: compactEntry.m } }
                  : {}),
                ...(compactEntry.y !== undefined
                  ? { allowReplayRetry: compactEntry.y === 1 }
                  : {}),
                ...(compactEntry.f !== undefined
                  ? { pendingConflict: compactEntry.f }
                  : {}),
              };
            },
          },
        },
      );
    const resolutionNamespace =
      createPersistentStorageNamespaceHandle<PersistedOfflineResolutionRecord>({
        storeName,
        adapter,
        getSessionKey: () => targetSessionKey,
        onPersistentStorageError,
        entryPrefix: OFFLINE_CONFLICT_STORAGE_ENTRY_PREFIX,
      });
    const entityNamespace =
      createPersistentStorageNamespaceHandle<GlobalOfflineEntity>(
        {
          storeName,
          adapter,
          getSessionKey: () => targetSessionKey,
          onPersistentStorageError,
          entryPrefix: OFFLINE_ENTITY_STORAGE_ENTRY_PREFIX,
        },
        {
          valueCodec: {
            serialize(entity) {
              return {
                k: entity.entityKey,
                g: toCompactOfflineEntityKind(entity.entityKind),
                ...(entity.pendingMutations !== 0
                  ? { p: entity.pendingMutations }
                  : {}),
                s: toCompactOfflineEntitySyncState(entity.syncState),
                ...(entity.blockedByResolutionIds.length > 0
                  ? { b: entity.blockedByResolutionIds }
                  : {}),
                ...(entity.childResolutionIds.length > 0
                  ? { c: entity.childResolutionIds }
                  : {}),
                a: entity.createdAt,
                u: entity.updatedAt,
                ...(entity.tempId !== undefined ? { t: entity.tempId } : {}),
              };
            },
            deserialize(raw) {
              const compactEntity = rc_parse(
                raw,
                compactOfflineEntitySchema,
              ).unwrapOrNull();
              if (compactEntity === null) return null;

              const blockedByResolutionIds = compactEntity.b ?? [];
              const childResolutionIds = compactEntity.c ?? [];
              const syncState = fromCompactOfflineEntitySyncState(
                compactEntity.s,
              );

              return {
                id: buildEntityId(targetSessionKey, storeName, compactEntity.k),
                sessionKey: targetSessionKey,
                storeName,
                storeType,
                entityKey: compactEntity.k,
                entityKind: fromCompactOfflineEntityKind(compactEntity.g),
                pendingMutations: compactEntity.p ?? 0,
                syncState,
                requiresResolution: syncState === 'resolution-required',
                blockedByResolutionIds,
                childResolutionIds,
                blockedResolutionCount: blockedByResolutionIds.length,
                childResolutionCount: childResolutionIds.length,
                createdAt: compactEntity.a,
                updatedAt: compactEntity.u,
                ...(compactEntity.t !== undefined
                  ? {
                      // WORKAROUND: Compact entity payloads persist temp ids as unknown JSON values, and the controller rebinds that validated payload back to ValidPayload when hydrating.
                      tempId: __LEGIT_CAST__<ValidPayload, unknown>(
                        compactEntity.t,
                      ),
                    }
                  : {}),
              };
            },
          },
        },
      );

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
      sessionKey: targetSessionKey,
      session,
      unregister,
      queueNamespace,
      resolutionNamespace,
      entityNamespace,
    };

    if (!session.getStatus().isOfflineMode && session.isLeader()) {
      void ensureReplayScheduled();
    }

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
        const operation = operations[resolution.operation];
        if (!operation) {
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

  function parseConflictPayloadForOperation<
    TName extends keyof TOperations & string,
  >(
    operationName: TName,
    conflict: unknown,
  ): ParsedOfflineResolutionConflictResultForOperation<TOperations, TName> {
    const operation = operations[operationName];
    if (!operation) {
      return Result.err(
        new OfflineResolutionConflictParseError({
          code: 'operation-not-found',
          operation: operationName,
        }),
      );
    }

    const conflictHandling = operation.conflictHandling;
    if (!conflictHandling) {
      return Result.err(
        new OfflineResolutionConflictParseError({
          code: 'conflict-handling-missing',
          operation: operationName,
        }),
      );
    }

    const parsedConflict = parseWithSchema<
      OperationConflict<TOperations, TName>
    >(conflictHandling.schema, conflict);
    if (!parsedConflict.ok) {
      return Result.err(
        new OfflineResolutionConflictParseError({
          code: 'invalid-conflict-payload',
          operation: operationName,
          rawValue: conflict,
          validationError: parsedConflict.error,
        }),
      );
    }

    return Result.ok(parsedConflict.value);
  }

  function parseConflictPayloadForResolution<
    TName extends keyof TOperations & string,
  >(
    resolution: OfflineResolutionRecordForStore<TOperations, TName>,
  ): ParsedOfflineResolutionConflictResultForOperation<TOperations, TName> {
    if (resolution.kind !== 'conflict') {
      return Result.err(
        new OfflineResolutionConflictParseError({
          code: 'not-conflict',
          kind: resolution.kind,
          operation: resolution.operation,
        }),
      );
    }

    return parseConflictPayloadForOperation(
      resolution.operation,
      resolution.conflict,
    );
  }

  function getOrCreateSet(
    map: Map<string, Set<string>>,
    key: string,
  ): Set<string> {
    const existing = map.get(key);
    if (existing) return existing;

    const created = new Set<string>();
    map.set(key, created);
    return created;
  }

  function toSortedArrayMap(
    source: Map<string, Set<string>>,
  ): Map<string, string[]> {
    return new Map(
      [...source.entries()].map(([key, values]) => [
        key,
        [...values].sort((left, right) => left.localeCompare(right)),
      ]),
    );
  }

  function isTempCreateOperation(operationName: string): boolean {
    const operation = operations[operationName];
    return (
      operation?.tempEntity !== undefined ||
      operation?.tempEntities !== undefined
    );
  }

  function resolveNormalizedRefs(rawRefs: unknown[]): OfflineEntityRef[] {
    if (rawRefs.length === 0) return [];

    if (storeAdapter.normalizeEntityRefs) {
      return storeAdapter.normalizeEntityRefs(rawRefs);
    }

    // WORKAROUND: When no normalizer is provided, the operation already
    // returned normalized refs and the controller preserves that runtime shape.
    return __LEGIT_CAST__<OfflineEntityRef[], unknown[]>(rawRefs);
  }

  function getTempLifecycleEntityKeys(
    workItem: Pick<
      OfflineQueueEntry | PersistedOfflineResolutionRecord,
      'operation' | 'tempIds' | 'entityRefs'
    >,
  ): string[] {
    if (!workItem.tempIds || workItem.tempIds.length === 0) return [];
    if (!isTempCreateOperation(workItem.operation)) return [];

    return workItem.entityRefs
      .filter((entityRef) => entityRef.entityKind === 'item')
      .map((entityRef) => entityRef.entityKey);
  }

  function getDependencyBlockerEntityKeys(
    workItem: Pick<
      OfflineQueueEntry | PersistedOfflineResolutionRecord,
      'input' | 'operation'
    >,
  ): Set<string> {
    const operation = operations[workItem.operation];
    if (!operation?.dependsOn) return new Set();

    return new Set(
      resolveNormalizedRefs(operation.dependsOn({ input: workItem.input })).map(
        (entityRef) => entityRef.entityKey,
      ),
    );
  }

  function getTempIdForEntityRef(args: {
    entityRefs: OfflineEntityRef[];
    tempIds?: ValidPayload[];
    entityKey: string;
  }): ValidPayload | undefined {
    if (!args.tempIds || args.tempIds.length === 0) return undefined;

    let itemIndex = 0;
    for (const entityRef of args.entityRefs) {
      if (entityRef.entityKind !== 'item') continue;

      const tempId = args.tempIds[itemIndex];
      itemIndex += 1;

      if (entityRef.entityKey === args.entityKey) return tempId;
    }

    return undefined;
  }

  function castTempLifecyclePayload(value: unknown): ValidPayload {
    // WORKAROUND: Temp ids and reconciled payloads cross the generic offline controller as unknown values until the store-specific adapter restores the concrete payload type.
    return __LEGIT_CAST__<ValidPayload, unknown>(value);
  }

  function createResolutionDependencySnapshot(): ResolutionDependencySnapshot {
    const dependencySourcesByEntityKey = new Map<
      string,
      TempLifecycleDependencySource
    >();
    const blockedByResolutionIdsByResolutionId = new Map<string, Set<string>>();
    const childResolutionIdsByResolutionId = new Map<string, Set<string>>();
    const blockedByResolutionIdsByEntityKey = new Map<string, Set<string>>();
    const childResolutionIdsByEntityKey = new Map<string, Set<string>>();
    const blockedResolutionIdsByResolutionId = new Map<string, Set<string>>();

    for (const entry of queueEntries.values()) {
      for (const entityKey of getTempLifecycleEntityKeys(entry)) {
        dependencySourcesByEntityKey.set(entityKey, {
          entityKey,
          sourceType: 'queue',
        });
      }
    }

    for (const resolution of resolutions.values()) {
      for (const entityKey of getTempLifecycleEntityKeys(resolution)) {
        dependencySourcesByEntityKey.set(entityKey, {
          entityKey,
          resolutionId: resolution.id,
          sourceType: 'resolution',
        });
      }
    }

    for (const resolution of resolutions.values()) {
      for (const dependencySource of dependencySourcesByEntityKey.values()) {
        if (
          !workItemDependsOnDependencySource({
            workItem: resolution,
            dependencySource,
          })
        ) {
          continue;
        }
        getOrCreateSet(blockedResolutionIdsByResolutionId, resolution.id).add(
          dependencySource.sourceType === 'resolution' &&
            dependencySource.resolutionId
            ? dependencySource.resolutionId
            : `queue:${dependencySource.entityKey}`,
        );
        getOrCreateSet(
          childResolutionIdsByEntityKey,
          dependencySource.entityKey,
        ).add(resolution.id);

        if (
          dependencySource.sourceType !== 'resolution' ||
          !dependencySource.resolutionId
        ) {
          continue;
        }

        getOrCreateSet(blockedByResolutionIdsByResolutionId, resolution.id).add(
          dependencySource.resolutionId,
        );
        getOrCreateSet(
          childResolutionIdsByResolutionId,
          dependencySource.resolutionId,
        ).add(resolution.id);
        for (const entityRef of resolution.entityRefs) {
          getOrCreateSet(
            blockedByResolutionIdsByEntityKey,
            entityRef.entityKey,
          ).add(dependencySource.resolutionId);
        }
      }
    }

    return {
      blockedByResolutionIdsByResolutionId: toSortedArrayMap(
        blockedByResolutionIdsByResolutionId,
      ),
      childResolutionIdsByResolutionId: toSortedArrayMap(
        childResolutionIdsByResolutionId,
      ),
      blockedByResolutionIdsByEntityKey: toSortedArrayMap(
        blockedByResolutionIdsByEntityKey,
      ),
      childResolutionIdsByEntityKey: toSortedArrayMap(
        childResolutionIdsByEntityKey,
      ),
      blockedResolutionIdsByResolutionId,
    };
  }

  function buildDerivedResolutionRecords(
    dependencySnapshot?: ResolutionDependencySnapshot,
  ): OfflineResolutionRecordForStore<TOperations>[] {
    const snapshot = dependencySnapshot ?? createResolutionDependencySnapshot();

    // WORKAROUND: Resolution records are hydrated with `operation: string`, so
    // the derived in-memory list needs one cast back to the operation-aware
    // union exposed by the typed controller and store APIs.
    return __LEGIT_CAST__<
      OfflineResolutionRecordForStore<TOperations>[],
      unknown
    >(
      [...resolutions.values()]
        .map((resolution) => {
          const blockedByResolutionIds =
            snapshot.blockedByResolutionIdsByResolutionId.get(resolution.id) ??
            [];
          const childResolutionIds =
            snapshot.childResolutionIdsByResolutionId.get(resolution.id) ?? [];

          return {
            ...resolution,
            blockedByResolutionIds,
            childResolutionIds,
            blockedResolutionCount:
              snapshot.blockedResolutionIdsByResolutionId.get(resolution.id)
                ?.size ?? 0,
            childResolutionCount: childResolutionIds.length,
          };
        })
        .sort((left, right) => {
          if (left.createdAt !== right.createdAt) {
            return left.createdAt - right.createdAt;
          }
          if (left.enqueuedAt !== right.enqueuedAt) {
            return left.enqueuedAt - right.enqueuedAt;
          }
          return left.id.localeCompare(right.id);
        }),
    );
  }

  function refreshDerivedState(current?: ActiveSessionState): void {
    const session = current ?? ensureActiveSession();
    if (!session || !isActiveSessionState(session)) return;
    const sessionState = session;
    const dependencySnapshot = createResolutionDependencySnapshot();
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
        const childResolutionIds =
          dependencySnapshot.childResolutionIdsByEntityKey.get(ref.entityKey) ??
          [];
        const blockedByResolutionIds =
          dependencySnapshot.blockedByResolutionIdsByEntityKey.get(
            ref.entityKey,
          ) ?? [];

        entitiesByKey.set(ref.entityKey, {
          ...createEntityBase(ref),
          pendingMutations: (existing?.pendingMutations ?? 0) + 1,
          syncState:
            existing?.syncState === 'needs-confirmation'
              ? existing.syncState
              : entry.syncState,
          requiresResolution: existing?.requiresResolution ?? false,
          blockedByResolutionIds,
          childResolutionIds,
          blockedResolutionCount: blockedByResolutionIds.length,
          childResolutionCount: childResolutionIds.length,
          createdAt: existing?.createdAt ?? entry.createdAt,
          updatedAt: entry.updatedAt,
          tempId:
            getTempIdForEntityRef({
              entityRefs: entry.entityRefs,
              tempIds: entry.tempIds,
              entityKey: ref.entityKey,
            }) ?? existing?.tempId,
        });
      }
    }

    for (const resolution of resolutions.values()) {
      for (const ref of resolution.entityRefs) {
        const existing = entitiesByKey.get(ref.entityKey);
        const childResolutionIds =
          dependencySnapshot.childResolutionIdsByEntityKey.get(ref.entityKey) ??
          [];
        const blockedByResolutionIds =
          dependencySnapshot.blockedByResolutionIdsByEntityKey.get(
            ref.entityKey,
          ) ?? [];

        entitiesByKey.set(ref.entityKey, {
          ...createEntityBase(ref),
          pendingMutations: existing?.pendingMutations ?? 0,
          syncState: 'resolution-required',
          requiresResolution: true,
          blockedByResolutionIds,
          childResolutionIds,
          blockedResolutionCount: blockedByResolutionIds.length,
          childResolutionCount: childResolutionIds.length,
          createdAt: existing?.createdAt ?? resolution.createdAt,
          updatedAt: resolution.updatedAt,
          tempId:
            getTempIdForEntityRef({
              entityRefs: resolution.entityRefs,
              tempIds: resolution.tempIds,
              entityKey: ref.entityKey,
            }) ?? existing?.tempId,
        });
      }
    }

    const entities = [...entitiesByKey.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    const derivedResolutions =
      buildDerivedResolutionRecords(dependencySnapshot);
    const protectedKeys = storeAdapter.getProtectedCacheKeys(
      entities.map((entity) => ({
        entityKey: entity.entityKey,
        entityKind: entity.entityKind,
      })),
    );
    const nextReplayEntry = getSortedEntries()[0] ?? null;

    sessionState.session.syncStoreData(storeName, {
      adapter,
      entities,
      resolutions: derivedResolutions,
      protectedKeys,
      replayHead:
        nextReplayEntry === null
          ? null
          : {
              storeName,
              entryId: nextReplayEntry.id,
              queueOrder: getQueueOrder(nextReplayEntry),
              createdAt: nextReplayEntry.createdAt,
            },
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
    tempIds?: ValidPayload[];
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
      tempIds: args.tempIds,
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
      if (entry.tempIds && entry.tempIds.length > 0) continue;
      if (normalizeEntityRefs(entry.entityRefs) !== normalizedEntityRefs) {
        continue;
      }

      if (!candidate || compareQueueEntries(entry, candidate) < 0) {
        candidate = entry;
      }
    }

    return candidate;
  }

  function isSameEntityRef(
    left: OfflineEntityRef | undefined,
    right: OfflineEntityRef | undefined,
  ): boolean {
    return (
      left?.entityKind === right?.entityKind &&
      left?.entityKey === right?.entityKey
    );
  }

  function findDuplicatePendingTempLifecycleTempId(args: {
    entityRefs: OfflineEntityRef[];
    tempIds?: readonly ValidPayload[];
    entries?: Iterable<OfflineQueueEntry>;
    resolutionEntries?: Iterable<PersistedOfflineResolutionRecord>;
  }): string | null {
    for (const [index, entityRef] of args.entityRefs.entries()) {
      if (entityRef.entityKind !== 'item') continue;
      const tempId = args.tempIds?.[index];
      const formattedTempId =
        tempId === undefined
          ? entityRef.entityKey
          : formatPayloadForError(tempId);

      for (const entry of args.entries ?? queueEntries.values()) {
        if (!entry.tempIds || entry.tempIds.length === 0) continue;
        if (
          entry.entityRefs.some((candidate) =>
            isSameEntityRef(candidate, entityRef),
          )
        ) {
          return formattedTempId;
        }
      }

      for (const resolution of args.resolutionEntries ?? resolutions.values()) {
        if (!resolution.tempIds || resolution.tempIds.length === 0) continue;
        if (
          resolution.entityRefs.some((candidate) =>
            isSameEntityRef(candidate, entityRef),
          )
        ) {
          return formattedTempId;
        }
      }
    }

    return null;
  }

  function matchesSupersededOperation(args: {
    candidateOperationName: string;
    operationName: string;
    supersedes: NonNullable<AnyOfflineOperationDefinition['supersedes']>;
  }): boolean {
    const { candidateOperationName, operationName, supersedes } = args;
    const operationFilter = supersedes.operations;

    if (operationFilter === undefined) return true;
    if (operationFilter === 'self') {
      return candidateOperationName === operationName;
    }

    return operationFilter.includes(candidateOperationName);
  }

  function findSupersededEntries(args: {
    operationName: string;
    entityRefs: OfflineEntityRef[];
    queueOrder: number;
    supersedes: NonNullable<AnyOfflineOperationDefinition['supersedes']>;
    entries?: Iterable<OfflineQueueEntry>;
  }): OfflineQueueEntry[] {
    if (args.entityRefs.length !== 1) {
      throw new Error(
        `Superseding offline operation "${args.operationName}" must resolve exactly one entity ref`,
      );
    }

    const targetRef = args.entityRefs[0];
    if (!targetRef) {
      throw new Error(
        `Superseding offline operation "${args.operationName}" is missing its entity ref`,
      );
    }

    return [...(args.entries ?? queueEntries.values())]
      .filter((entry) => {
        return (
          entry.syncState === 'pending' &&
          entry.attempts === 0 &&
          entry.entityRefs.length === 1 &&
          getQueueOrder(entry) < args.queueOrder &&
          matchesSupersededOperation({
            candidateOperationName: entry.operation,
            operationName: args.operationName,
            supersedes: args.supersedes,
          }) &&
          isSameEntityRef(entry.entityRefs[0], targetRef)
        );
      })
      .sort(compareQueueEntries);
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
      tempIds: entry.tempIds,
    };
  }

  function buildConflictResolutionRecord(
    current: ActiveSessionState,
    entry: OfflineQueueEntry,
    conflict: unknown,
  ): PersistedOfflineResolutionRecord {
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
  ): PersistedOfflineResolutionRecord {
    return {
      ...buildResolutionRecordBase(current, entry),
      id: `retry-exhausted:${entry.id}`,
      kind: 'retry-exhausted',
      lastReplayError,
    };
  }

  function workItemDependsOnDependencySource(args: {
    workItem: Pick<
      OfflineQueueEntry | PersistedOfflineResolutionRecord,
      'entityRefs' | 'input' | 'operation' | 'tempIds'
    >;
    dependencySource: TempLifecycleDependencySource;
  }): boolean {
    if (
      getTempLifecycleEntityKeys(args.workItem).includes(
        args.dependencySource.entityKey,
      )
    ) {
      return false;
    }

    if (
      args.workItem.entityRefs.some(
        (entityRef) => entityRef.entityKey === args.dependencySource.entityKey,
      )
    ) {
      return true;
    }

    return getDependencyBlockerEntityKeys(args.workItem).has(
      args.dependencySource.entityKey,
    );
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

    let nextValue: Record<string, unknown> | undefined;

    for (const [key, entryValue] of Object.entries(value)) {
      const replacedValue = replacePayloadReferences(
        entryValue,
        tempId,
        finalPayload,
      );
      if (replacedValue !== entryValue) {
        nextValue ??= { ...value };
        nextValue[key] = replacedValue;
      }
    }

    return nextValue ?? value;
  }

  function resolveEntityRefsForInput(
    operationName: string,
    input: unknown,
    fallbackEntityRefs: OfflineEntityRef[],
  ): OfflineEntityRef[] {
    const operation = operations[operationName];
    if (!operation) return fallbackEntityRefs;

    const rawEntityRefs =
      typeof operation.getEntityRefs === 'function'
        ? operation.getEntityRefs({ input })
        : (storeAdapter.getEntityRefs?.({ operationName, input }) ?? []);

    if (rawEntityRefs.length === 0) return fallbackEntityRefs;
    return resolveNormalizedRefs(rawEntityRefs);
  }

  function buildOperationBaseContext(args: {
    input: unknown;
    enqueuedAt: number;
    updatedAt: number;
  }) {
    return {
      input: args.input,
      enqueuedAt: args.enqueuedAt,
      updatedAt: args.updatedAt,
      resolveEntityRef,
    };
  }

  function rewriteEntryInput(
    entry: {
      input: unknown;
      operation: string;
      entityRefs: OfflineEntityRef[];
    },
    tempId: ValidPayload,
    finalPayload: ValidPayload,
  ): { input: unknown; entityRefs: OfflineEntityRef[] } | null {
    const rewrittenInput = replacePayloadReferences(
      entry.input,
      tempId,
      finalPayload,
    );
    if (rewrittenInput === entry.input) return null;

    const operation = operations[entry.operation];
    if (!operation) return null;

    const validatedInput = validateWithSchema(
      operation.inputSchema,
      rewrittenInput,
    );
    if (validatedInput === null) return null;

    return {
      input: validatedInput,
      entityRefs: resolveEntityRefsForInput(
        entry.operation,
        validatedInput,
        entry.entityRefs,
      ),
    };
  }

  async function rebindQueuedEntriesAfterTempReconciliation(args: {
    current: ActiveSessionState;
    entryIdToSkip?: string;
    tempId: ValidPayload;
    finalPayload: ValidPayload;
  }): Promise<void> {
    rememberResolvedEntityRef(args.tempId, args.finalPayload);
    const changedQueueEntries: OfflineQueueEntry[] = [];
    const entityRefRewrites: Array<{
      previousEntityRefs: OfflineEntityRef[];
      nextEntityRefs: OfflineEntityRef[];
    }> = [];

    for (const entry of queueEntries.values()) {
      if (args.entryIdToSkip && entry.id === args.entryIdToSkip) continue;

      const rewrite = rewriteEntryInput(entry, args.tempId, args.finalPayload);
      if (!rewrite) continue;

      const rewrittenEntry = { ...entry, ...rewrite };
      await persistEntry(rewrittenEntry, args.current, true);
      changedQueueEntries.push(rewrittenEntry);
      entityRefRewrites.push({
        previousEntityRefs: entry.entityRefs,
        nextEntityRefs: rewrittenEntry.entityRefs,
      });
    }

    for (const resolution of resolutions.values()) {
      const rewrite = rewriteEntryInput(
        resolution,
        args.tempId,
        args.finalPayload,
      );
      if (!rewrite) continue;

      const rewrittenResolution = { ...resolution, ...rewrite };
      resolutions.set(rewrittenResolution.id, rewrittenResolution);
      await args.current.resolutionNamespace.save(
        rewrittenResolution.id,
        rewrittenResolution,
      );
      entityRefRewrites.push({
        previousEntityRefs: resolution.entityRefs,
        nextEntityRefs: rewrittenResolution.entityRefs,
      });
    }

    if (entityRefRewrites.length > 0) {
      if (storeAdapter.rebindQueuedMutationOverlays) {
        const itemKeyRewrites: {
          previousItemKey: string;
          nextItemKey: string;
        }[] = [];

        for (const {
          previousEntityRefs,
          nextEntityRefs,
        } of entityRefRewrites) {
          for (const [index, previousRef] of previousEntityRefs.entries()) {
            const nextRef = nextEntityRefs[index];

            if (
              previousRef.entityKind !== 'item' ||
              nextRef?.entityKind !== 'item'
            ) {
              continue;
            }

            itemKeyRewrites.push({
              previousItemKey: previousRef.entityKey,
              nextItemKey: nextRef.entityKey,
            });
          }
        }

        storeAdapter.rebindQueuedMutationOverlays({
          sessionKey: args.current.sessionKey,
          itemKeyRewrites,
        });
      } else if (changedQueueEntries.length > 0) {
        storeAdapter.captureQueuedMutationOverlays?.({
          sessionKey: args.current.sessionKey,
          entityRefs: changedQueueEntries.flatMap((entry) => entry.entityRefs),
        });
      }
    }

    refreshDerivedState(args.current);
  }

  async function reconcileTempEntitiesFromResult(args: {
    current: ActiveSessionState;
    operationName: string;
    input: unknown;
    tempIds: ValidPayload[];
    result: unknown;
    entryIdToSkip?: string;
  }): Promise<void> {
    const operation = operations[args.operationName];
    if (!operation) return;

    const tempEntity = operation.tempEntity;
    const tempEntities = operation.tempEntities;
    if (!tempEntity && !tempEntities) return;
    if (!storeAdapter.reconcileTempEntity) return;

    if (tempEntity) {
      const tempId = args.tempIds[0];
      if (tempId === undefined) return;

      const reconciliation = tempEntity.reconcileServerEntity(
        args.result,
        tempId,
      );
      storeAdapter.reconcileTempEntity({
        operationName: args.operationName,
        input: args.input,
        tempId,
        result: args.result,
        reconciliation,
      });
      await rebindQueuedEntriesAfterTempReconciliation({
        current: args.current,
        entryIdToSkip: args.entryIdToSkip,
        tempId,
        finalPayload: reconciliation.finalPayload,
      });
      return;
    }

    if (!tempEntities) return;

    const reconciliations = orderByTempIds<{
      tempId: ValidPayload;
      finalPayload: ValidPayload;
      finalData?: unknown;
    }>({
      operationName: args.operationName,
      label: 'Temp reconciliations',
      tempIds: args.tempIds,
      items: tempEntities
        .reconcileServerEntities(args.result, args.tempIds)
        .map((reconciliation) => ({
          tempId: castTempLifecyclePayload(reconciliation.tempId),
          finalPayload: castTempLifecyclePayload(reconciliation.finalPayload),
          finalData: reconciliation.finalData,
        })),
    });

    for (const reconciliation of reconciliations) {
      storeAdapter.reconcileTempEntity({
        operationName: args.operationName,
        input: args.input,
        tempId: reconciliation.tempId,
        result: args.result,
        reconciliation,
      });
      await rebindQueuedEntriesAfterTempReconciliation({
        current: args.current,
        entryIdToSkip: args.entryIdToSkip,
        tempId: reconciliation.tempId,
        finalPayload: reconciliation.finalPayload,
      });
    }
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

  function runSuccessfulExecuteSync(args: {
    operation: AnyOfflineOperationDefinition;
    entry: OfflineQueueEntry;
    result: unknown;
  }): Promise<void> | void {
    if (!args.operation.onSuccessExecute) return;

    return args.operation.onSuccessExecute({
      input: args.entry.input,
      enqueuedAt: args.entry.createdAt,
      updatedAt: args.entry.updatedAt,
      resolveEntityRef,
      result: args.result,
    });
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
    resolution: PersistedOfflineResolutionRecord,
    current?: ActiveSessionState,
    skipRefresh?: boolean,
  ): Promise<void> {
    const session = current ?? ensureActiveSession();
    if (!session) return;
    if (isActiveSessionState(session)) {
      resolutions.set(resolution.id, resolution);
    }
    await session.resolutionNamespace.save(resolution.id, resolution);
    if (!skipRefresh && isActiveSessionState(session)) {
      refreshDerivedState(session);
    }
  }

  async function removeResolution(
    resolutionId: string,
    current?: ActiveSessionState,
    skipRefresh?: boolean,
  ): Promise<void> {
    const session = current ?? ensureActiveSession();
    if (!session) return;
    if (isActiveSessionState(session)) {
      resolutions.delete(resolutionId);
    }
    await session.resolutionNamespace.remove(resolutionId);
    if (!skipRefresh && isActiveSessionState(session)) {
      refreshDerivedState(session);
    }
  }

  function collectTempCreateDescendants(args: {
    parentEntityKey: string;
    parentEntryId?: string;
    parentResolutionId?: string;
  }): TempCreateDescendantCollection {
    const sourcesByEntityKey = new Map<string, TempLifecycleDependencySource>([
      [
        args.parentEntityKey,
        {
          entityKey: args.parentEntityKey,
          resolutionId: args.parentResolutionId,
          sourceType: args.parentResolutionId ? 'resolution' : 'queue',
        },
      ],
    ]);
    const pendingEntityKeys = [args.parentEntityKey];
    const seenEntityKeys = new Set(pendingEntityKeys);
    const descendantQueueEntries = new Map<string, OfflineQueueEntry>();
    const descendantResolutions = new Map<
      string,
      PersistedOfflineResolutionRecord
    >();

    while (pendingEntityKeys.length > 0) {
      const entityKey = pendingEntityKeys.shift();
      if (!entityKey) continue;
      const dependencySource = sourcesByEntityKey.get(entityKey);
      if (!dependencySource) continue;

      for (const entry of getSortedEntries()) {
        if (
          entry.id === args.parentEntryId ||
          descendantQueueEntries.has(entry.id)
        ) {
          continue;
        }
        if (
          !workItemDependsOnDependencySource({
            workItem: entry,
            dependencySource,
          })
        ) {
          continue;
        }

        descendantQueueEntries.set(entry.id, entry);
        for (const descendantEntityKey of getTempLifecycleEntityKeys(entry)) {
          if (seenEntityKeys.has(descendantEntityKey)) continue;

          seenEntityKeys.add(descendantEntityKey);
          pendingEntityKeys.push(descendantEntityKey);
          sourcesByEntityKey.set(descendantEntityKey, {
            entityKey: descendantEntityKey,
            sourceType: 'queue',
          });
        }
      }

      for (const resolution of resolutions.values()) {
        if (
          resolution.id === args.parentResolutionId ||
          descendantResolutions.has(resolution.id)
        ) {
          continue;
        }
        if (
          !workItemDependsOnDependencySource({
            workItem: resolution,
            dependencySource,
          })
        ) {
          continue;
        }

        descendantResolutions.set(resolution.id, resolution);
        for (const descendantEntityKey of getTempLifecycleEntityKeys(
          resolution,
        )) {
          if (seenEntityKeys.has(descendantEntityKey)) continue;

          seenEntityKeys.add(descendantEntityKey);
          pendingEntityKeys.push(descendantEntityKey);
          sourcesByEntityKey.set(descendantEntityKey, {
            entityKey: descendantEntityKey,
            resolutionId: resolution.id,
            sourceType: 'resolution',
          });
        }
      }
    }

    return {
      queueEntries: [...descendantQueueEntries.values()].sort(
        compareQueueEntries,
      ),
      resolutions: [...descendantResolutions.values()].sort((left, right) => {
        if (left.createdAt !== right.createdAt) {
          return left.createdAt - right.createdAt;
        }
        if (left.enqueuedAt !== right.enqueuedAt) {
          return left.enqueuedAt - right.enqueuedAt;
        }
        return left.id.localeCompare(right.id);
      }),
    };
  }

  function rollbackTempCreatePendingEntity(
    workItem: Pick<
      OfflineQueueEntry | PersistedOfflineResolutionRecord,
      'operation' | 'input' | 'tempIds'
    >,
  ): void {
    if (!workItem.tempIds || !isTempCreateOperation(workItem.operation)) {
      return;
    }

    for (const tempId of workItem.tempIds) {
      storeAdapter.rollbackPendingEntity?.({
        operationName: workItem.operation,
        input: workItem.input,
        tempId,
        pendingEntity: undefined,
      });
    }
  }

  async function promoteBlockedTempCreateDescendants(args: {
    current: ActiveSessionState;
    parentEntry: OfflineQueueEntry;
    parentResolutionId: string;
  }): Promise<void> {
    const descendantQueueEntries = new Map<string, OfflineQueueEntry>();

    for (const entityKey of getTempLifecycleEntityKeys(args.parentEntry)) {
      const descendants = collectTempCreateDescendants({
        parentEntityKey: entityKey,
        parentResolutionId: args.parentResolutionId,
      });

      for (const entry of descendants.queueEntries) {
        descendantQueueEntries.set(entry.id, entry);
      }
    }

    for (const dependentEntry of descendantQueueEntries.values()) {
      await removeEntry(dependentEntry.id, args.current, true);
      await persistResolution(
        buildRetryExhaustedResolutionRecord(args.current, dependentEntry, {
          message: BLOCKED_DEPENDENCY_RESOLUTION_MESSAGE,
        }),
        args.current,
        true,
      );
    }
  }

  async function persistManualResolutionChain(args: {
    current: ActiveSessionState;
    parentEntry: OfflineQueueEntry;
    parentResolution: PersistedOfflineResolutionRecord;
  }): Promise<void> {
    await removeEntry(args.parentEntry.id, args.current, true);
    await persistResolution(args.parentResolution, args.current, true);
    await promoteBlockedTempCreateDescendants({
      current: args.current,
      parentEntry: args.parentEntry,
      parentResolutionId: args.parentResolution.id,
    });
    refreshDerivedState(args.current);
  }

  function isPersistedResolutionBlocked(
    resolution: PersistedOfflineResolutionRecord,
  ): boolean {
    const snapshot = createResolutionDependencySnapshot();
    return (
      (snapshot.blockedResolutionIdsByResolutionId.get(resolution.id)?.size ??
        0) > 0
    );
  }

  async function discardTempCreateResolutionChain(args: {
    current: ActiveSessionState;
    resolution: PersistedOfflineResolutionRecord;
  }): Promise<void> {
    await removeResolution(args.resolution.id, args.current, true);

    const parentEntityKeys = getTempLifecycleEntityKeys(args.resolution);
    if (parentEntityKeys.length === 0) {
      refreshDerivedState(args.current);
      return;
    }

    const descendantQueueEntries = new Map<string, OfflineQueueEntry>();
    const descendantResolutions = new Map<
      string,
      PersistedOfflineResolutionRecord
    >();

    for (const entityKey of parentEntityKeys) {
      const descendants = collectTempCreateDescendants({
        parentEntityKey: entityKey,
        parentResolutionId: args.resolution.id,
      });

      for (const queueEntry of descendants.queueEntries) {
        descendantQueueEntries.set(queueEntry.id, queueEntry);
      }
      for (const resolution of descendants.resolutions) {
        descendantResolutions.set(resolution.id, resolution);
      }
    }

    for (const queueEntry of descendantQueueEntries.values()) {
      await removeEntry(queueEntry.id, args.current, true);
    }

    for (const resolution of descendantResolutions.values()) {
      await removeResolution(resolution.id, args.current, true);
    }

    for (const queueEntry of descendantQueueEntries.values()) {
      rollbackTempCreatePendingEntity(queueEntry);
    }
    for (const resolution of descendantResolutions.values()) {
      rollbackTempCreatePendingEntity(resolution);
    }
    rollbackTempCreatePendingEntity(args.resolution);

    refreshDerivedState(args.current);
  }

  function collectRetryResolutionChain(args: {
    resolution: PersistedOfflineResolutionRecord;
    scope: 'self' | 'self-and-descendants';
  }): PersistedOfflineResolutionRecord[] {
    if (args.scope === 'self') {
      return [args.resolution];
    }

    const dependencySnapshot = createResolutionDependencySnapshot();
    const descendantResolutions = new Map<
      string,
      PersistedOfflineResolutionRecord
    >();

    for (const entityKey of getTempLifecycleEntityKeys(args.resolution)) {
      const descendants = collectTempCreateDescendants({
        parentEntityKey: entityKey,
        parentResolutionId: args.resolution.id,
      });

      for (const resolution of descendants.resolutions) {
        if (resolution.kind !== 'retry-exhausted') continue;
        descendantResolutions.set(resolution.id, resolution);
      }
    }

    const orderedDescendants: PersistedOfflineResolutionRecord[] = [];
    const remainingDescendants = [...descendantResolutions.values()].sort(
      (left, right) => {
        if (left.createdAt !== right.createdAt) {
          return left.createdAt - right.createdAt;
        }
        if (left.enqueuedAt !== right.enqueuedAt) {
          return left.enqueuedAt - right.enqueuedAt;
        }
        return left.id.localeCompare(right.id);
      },
    );
    const orderedIds = new Set<string>();

    while (remainingDescendants.length > 0) {
      const nextIndex = remainingDescendants.findIndex((resolution) => {
        const blockers =
          dependencySnapshot.blockedByResolutionIdsByResolutionId.get(
            resolution.id,
          ) ?? [];

        return blockers.every(
          (blockerId) =>
            blockerId === args.resolution.id ||
            !descendantResolutions.has(blockerId) ||
            orderedIds.has(blockerId),
        );
      });

      if (nextIndex === -1) {
        // Cycle-break: append remaining in timestamp order when no resolution
        // has all blockers satisfied (unexpected state, e.g. data corruption).
        orderedDescendants.push(...remainingDescendants);
        break;
      }

      const [nextResolution] = remainingDescendants.splice(nextIndex, 1);
      if (!nextResolution) continue;

      orderedDescendants.push(nextResolution);
      orderedIds.add(nextResolution.id);
    }

    return [args.resolution, ...orderedDescendants];
  }

  async function persistValidatedConflictResolution(args: {
    current: ActiveSessionState;
    entry: OfflineQueueEntry;
    conflict: unknown;
    conflictHandling: NonNullable<
      AnyOfflineOperationDefinition['conflictHandling']
    >;
  }): Promise<void> {
    const validatedConflict = validateWithSchema(
      args.conflictHandling.schema,
      args.conflict,
    );
    if (validatedConflict === null) {
      throw new Error(
        `Invalid offline conflict payload for operation "${args.entry.operation}"`,
      );
    }

    await persistManualResolutionChain({
      current: args.current,
      parentEntry: args.entry,
      parentResolution: buildConflictResolutionRecord(
        args.current,
        args.entry,
        validatedConflict,
      ),
    });
  }

  function prepareMutationWithSession<TName extends keyof TOperations & string>(
    current: ActiveSessionState,
    args: InternalQueuedMutationArgs<TName>,
  ): PreparedQueuedMutation {
    const operationName = String(args.operation);
    const operation = operations[operationName];
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
      tempIds: args.tempIds,
      entityRefs: args.entityRefs,
    };
  }

  function findTempIdIndex(
    tempIds: readonly ValidPayload[],
    tempId: ValidPayload,
  ): number {
    return tempIds.findIndex((candidate) => deepEqual(candidate, tempId));
  }

  function orderByTempIds<T extends { tempId: ValidPayload }>(args: {
    operationName: string;
    label: string;
    tempIds: readonly ValidPayload[];
    items: readonly T[];
  }): T[] {
    const ordered: Array<T | undefined> = args.tempIds.map(() => undefined);

    for (const item of args.items) {
      const index = findTempIdIndex(args.tempIds, item.tempId);
      if (index === -1) {
        throw new Error(
          `${args.label} for "${args.operationName}" must match the resolved temp ids`,
        );
      }
      if (ordered[index] !== undefined) {
        throw new Error(
          `${args.label} for "${args.operationName}" must not contain duplicate temp ids`,
        );
      }

      ordered[index] = item;
    }

    const result: T[] = [];
    for (const item of ordered) {
      if (!item) {
        throw new Error(
          `${args.label} for "${args.operationName}" must match the resolved temp ids`,
        );
      }
      result.push(item);
    }

    return result;
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
        tempIds: preparedTempIds,
        entityRefs: preparedEntityRefs,
      },
      queueOrder,
      workingQueue,
    } = args;

    const tempEntity = operation.tempEntity;
    const tempEntities = operation.tempEntities;
    if (operation.accumulation && operation.supersedes) {
      throw new Error(
        `Offline operation "${operationName}" cannot configure accumulation and supersedes together`,
      );
    }
    if (tempEntity && tempEntities) {
      throw new Error(
        `Offline operation "${operationName}" cannot configure tempEntity and tempEntities together`,
      );
    }
    if (storeType === 'document' && (tempEntity || tempEntities)) {
      throw new Error(
        `Document offline operation "${operationName}" does not support tempEntity or tempEntities`,
      );
    }
    if ((tempEntity || tempEntities) && 'onSuccessExecute' in operation) {
      throw new Error(
        `Offline operation "${operationName}" cannot configure onSuccessExecute when tempEntity or tempEntities is present`,
      );
    }

    const rawEntityRefs =
      typeof operation.getEntityRefs === 'function'
        ? operation.getEntityRefs({ input: validatedInput })
        : (storeAdapter.getEntityRefs?.({
            operationName,
            input: validatedInput,
          }) ?? []);
    const resolvedEntityRefs = resolveNormalizedRefs(rawEntityRefs);
    const hasTempLifecycle =
      tempEntity !== undefined || tempEntities !== undefined;
    const entityRefs =
      hasTempLifecycle &&
      preparedTempIds !== undefined &&
      preparedEntityRefs !== undefined
        ? preparedEntityRefs
        : resolvedEntityRefs;
    const tempIds = hasTempLifecycle
      ? (preparedTempIds ??
        rawEntityRefs.map((entityRef) => castTempLifecyclePayload(entityRef)))
      : preparedTempIds;

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
      if (
        entityRefs.length !== 1 ||
        entityRefs[0]?.entityKind !== 'item' ||
        tempIds?.length !== 1
      ) {
        throw new Error(
          `Temp entity operation "${operationName}" must preserve exactly one item ref`,
        );
      }
    }

    if (tempEntities) {
      if (rawEntityRefs.length === 0) {
        throw new Error(
          `Temp entities operation "${operationName}" must resolve at least one entity ref`,
        );
      }
      if (
        resolvedEntityRefs.length !== rawEntityRefs.length ||
        resolvedEntityRefs.some((entityRef) => entityRef.entityKind !== 'item')
      ) {
        throw new Error(
          `Temp entities operation "${operationName}" must resolve only item refs`,
        );
      }
      if (
        entityRefs.length !== tempIds?.length ||
        entityRefs.some((entityRef) => entityRef.entityKind !== 'item')
      ) {
        throw new Error(
          `Temp entities operation "${operationName}" must preserve the resolved item refs`,
        );
      }
    }

    if (hasTempLifecycle) {
      const duplicateTempEntityKey = findDuplicatePendingTempLifecycleTempId({
        entityRefs,
        tempIds,
        entries: workingQueue.values(),
        resolutionEntries: resolutions.values(),
      });

      if (duplicateTempEntityKey !== null) {
        throw new Error(
          `Offline operation "${operationName}" cannot queue temp entity "${duplicateTempEntityKey}" more than once while it is still pending`,
        );
      }
    }

    const now = Date.now();
    const pendingEntities = !storeAdapter.applyPendingEntity
      ? []
      : tempEntity && tempIds?.[0] !== undefined
        ? [
            {
              tempId: tempIds[0],
              pendingEntity: tempEntity.buildPendingEntity(
                validatedInput,
                tempIds[0],
              ),
            },
          ]
        : tempEntities && tempIds
          ? orderByTempIds({
              operationName,
              label: 'Temp entities',
              tempIds,
              items: tempEntities
                .buildPendingEntities(validatedInput, tempIds)
                .map((entry) => ({
                  tempId: castTempLifecyclePayload(entry.tempId),
                  pendingEntity: entry.pendingEntity,
                })),
            })
          : [];

    if (operation.accumulation && (!tempIds || tempIds.length === 0)) {
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
          tempIds,
          pendingEntities,
          nextEntry,
          removedEntries: [existingEntry],
        };
      }
    }

    const supersededEntries = operation.supersedes
      ? findSupersededEntries({
          operationName,
          entityRefs,
          queueOrder,
          supersedes: operation.supersedes,
          entries: workingQueue.values(),
        })
      : [];

    for (const entry of supersededEntries) {
      workingQueue.delete(entry.id);
    }

    if (
      operation.supersedes?.dropSelfIfTempLifecycleCancelled &&
      supersededEntries.some(
        (entry) => entry.tempIds !== undefined && entry.tempIds.length > 0,
      )
    ) {
      return {
        operationName,
        validatedInput,
        tempIds,
        pendingEntities,
        removedEntries: supersededEntries,
      };
    }

    const nextEntry = buildFreshQueueEntry({
      current,
      operation: operationName,
      input: validatedInput,
      queueOrder,
      entityRefs,
      tempIds,
    });
    workingQueue.set(nextEntry.id, nextEntry);

    return {
      operationName,
      validatedInput,
      tempIds,
      pendingEntities,
      nextEntry,
      removedEntries: supersededEntries,
    };
  }

  async function queuePreparedMutations(
    preparedMutation: PreparedQueuedMutation,
  ): Promise<void> {
    const current = ensureActiveSession();
    if (!current || current.sessionKey !== preparedMutation.currentSessionKey) {
      throw offlineSessionUnavailableError;
    }

    const { queueOrders, nextQueueOrderValue } = previewQueueOrders(1);
    const queueOrder = queueOrders[0];
    if (queueOrder === undefined) {
      throw new Error('Missing queue order for prepared offline mutation');
    }
    const workingQueue = new Map(queueEntries);
    const plannedMutation = await planPreparedMutation({
      current,
      preparedMutation,
      queueOrder,
      workingQueue,
    });

    const persistedMutations: AppliedQueuedMutation[] = [];
    const appliedPendingMutations: Array<{
      operationName: string;
      validatedInput: unknown;
      pendingEntities: PendingTempEntity[];
    }> = [];
    const previousNextQueueOrder = nextQueueOrder;

    try {
      const appliedMutation: AppliedQueuedMutation = {
        ...plannedMutation,
        removedEntriesApplied: [],
        touchedNextEntry: false,
      };
      persistedMutations.push(appliedMutation);

      for (const removedEntry of plannedMutation.removedEntries) {
        if (plannedMutation.nextEntry?.id === removedEntry.id) {
          continue;
        }

        appliedMutation.removedEntriesApplied.push(removedEntry);
        await removeEntry(removedEntry.id, current, true);
      }

      if (plannedMutation.nextEntry) {
        appliedMutation.touchedNextEntry = true;
        await persistEntry(plannedMutation.nextEntry, current, true);
      }

      nextQueueOrder = nextQueueOrderValue;

      if (
        storeAdapter.applyPendingEntity &&
        plannedMutation.pendingEntities.length > 0
      ) {
        for (const pendingEntity of plannedMutation.pendingEntities) {
          storeAdapter.applyPendingEntity({
            operationName: plannedMutation.operationName,
            input: plannedMutation.validatedInput,
            tempId: pendingEntity.tempId,
            pendingEntity: pendingEntity.pendingEntity,
          });
        }

        appliedPendingMutations.push({
          operationName: plannedMutation.operationName,
          validatedInput: plannedMutation.validatedInput,
          pendingEntities: plannedMutation.pendingEntities,
        });
      }

      if (plannedMutation.nextEntry) {
        storeAdapter.captureQueuedMutationOverlays?.({
          sessionKey: current.sessionKey,
          entityRefs: plannedMutation.nextEntry.entityRefs,
        });
      }
    } catch (error) {
      for (const mutation of appliedPendingMutations.reverse()) {
        for (const pendingEntity of [...mutation.pendingEntities].reverse()) {
          storeAdapter.rollbackPendingEntity?.({
            operationName: mutation.operationName,
            input: mutation.validatedInput,
            tempId: pendingEntity.tempId,
            pendingEntity: pendingEntity.pendingEntity,
          });
        }
      }

      for (const mutation of persistedMutations.reverse()) {
        const nextEntryReplacesRemovedEntry =
          mutation.nextEntry !== undefined &&
          mutation.removedEntries.some(
            (removedEntry) => removedEntry.id === mutation.nextEntry?.id,
          );

        if (mutation.touchedNextEntry && mutation.nextEntry) {
          if (!nextEntryReplacesRemovedEntry) {
            await removeEntry(mutation.nextEntry.id, current, true);
          }
        }

        for (const removedEntry of nextEntryReplacesRemovedEntry
          ? [...mutation.removedEntries].reverse()
          : [...mutation.removedEntriesApplied].reverse()) {
          await persistEntry(removedEntry, current, true);
        }
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
      current.session.getStatus().isOfflineMode ||
      current.session.isReplayBlocked() ||
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
        current.session.getStatus().isOfflineMode ||
        current.session.isReplayBlocked() ||
        !current.session.isLeader()
      ) {
        return;
      }

      const nextEntry = getSortedEntries()[0];
      if (!nextEntry) return;
      if (
        !current.session.canReplayEntry({
          storeName,
          entryId: nextEntry.id,
          queueOrder: getQueueOrder(nextEntry),
          createdAt: nextEntry.createdAt,
        })
      ) {
        return;
      }

      const operation = operations[nextEntry.operation];
      if (!operation) {
        await removeEntry(nextEntry.id, current);
        continue;
      }

      const shouldCheckSkipBeforeRetry =
        nextEntry.syncState === 'needs-confirmation';
      const conflictHandling = operation.conflictHandling;
      const replayCheckBaseCtx = buildOperationBaseContext({
        input: nextEntry.input,
        enqueuedAt: nextEntry.createdAt,
        updatedAt: nextEntry.updatedAt,
      });
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

        if (
          shouldCheckSkipBeforeRetry &&
          entryToUse.allowReplayRetry !== true
        ) {
          await persistManualResolutionChain({
            current,
            parentEntry: entryToUse,
            parentResolution: buildRetryExhaustedResolutionRecord(
              current,
              entryToUse,
              entryToUse.lastError ?? {
                message: 'Replay retry is not allowed for this failure',
              },
            ),
          });
          continue;
        }

        const result = await operation.execute(
          buildOperationBaseContext({
            input: entryToUse.input,
            enqueuedAt: entryToUse.createdAt,
            updatedAt: entryToUse.updatedAt,
          }),
        );

        if (entryToUse.tempIds) {
          await reconcileTempEntitiesFromResult({
            current,
            operationName: entryToUse.operation,
            input: entryToUse.input,
            tempIds: entryToUse.tempIds,
            result,
            entryIdToSkip: entryToUse.id,
          });
        }

        await removeEntry(entryToUse.id, current, true);

        const successfulExecuteSync = runSuccessfulExecuteSync({
          operation,
          entry: entryToUse,
          result,
        });
        if (isPromise(successfulExecuteSync)) {
          await successfulExecuteSync;
        }

        refreshDerivedState(current);
      } catch (error) {
        const lastError = { message: toMessage(error) };
        const classification = await current.session.classifyFailure(error, {
          phase: 'sync',
          storeType,
          operationName: entryToUse.operation,
          sessionKey: current.sessionKey,
        });
        const allowReplayRetry =
          classification === 'ignore' &&
          !current.session.getStatus().isOfflineMode
            ? await current.session.classifyRetriableFailure(error, {
                phase: 'sync',
                storeType,
                operationName: entryToUse.operation,
                sessionKey: current.sessionKey,
              })
            : false;

        if (
          classification !== 'ignore' ||
          current.session.getStatus().isOfflineMode
        ) {
          entryToUse = {
            ...entryToUse,
            attempts: entryToUse.attempts + 1,
            updatedAt: Date.now(),
            lastAttemptAt: Date.now(),
            syncState: 'pending',
            lastError,
            allowReplayRetry: undefined,
          };
          await persistEntry(entryToUse, current);
          return;
        }

        const nextFailures = allowReplayRetry
          ? (countedReplayFailures.get(entryToUse.id) ?? 0) + 1
          : 0;

        if (allowReplayRetry) {
          countedReplayFailures.set(entryToUse.id, nextFailures);
        } else {
          countedReplayFailures.delete(entryToUse.id);
        }

        entryToUse = {
          ...entryToUse,
          attempts: entryToUse.attempts + 1,
          updatedAt: Date.now(),
          lastAttemptAt: Date.now(),
          syncState: 'needs-confirmation',
          lastError,
          allowReplayRetry,
        };

        if (allowReplayRetry && nextFailures >= replayRetryMaxFailures) {
          await persistManualResolutionChain({
            current,
            parentEntry: entryToUse,
            parentResolution: buildRetryExhaustedResolutionRecord(
              current,
              entryToUse,
              lastError,
            ),
          });
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
      prepareMutationWithSession(current, {
        operation: args.operation,
        input: args.input,
      }),
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

    const prepared = prepareMutationWithSession(current, {
      operation: args.operation,
      input: args.input,
    });
    await current.session.refreshNetworkState();

    return {
      initialAction: getInitialOfflineMutationAction(current),
      queueMutation: () => queuePreparedMutations(prepared),
      handleDirectSuccess: () =>
        clearOfflineStatusOnSuccess(prepared.currentSessionKey),
      classifyError: async (error) => {
        const preparedCurrent = ensureActiveSession();
        if (
          !preparedCurrent ||
          preparedCurrent.sessionKey !== prepared.currentSessionKey
        ) {
          throw offlineSessionUnavailableError;
        }

        await preparedCurrent.session.refreshNetworkState();
        const activeCauseAfterRefresh =
          getActiveMutationQueueingCause(preparedCurrent);
        if (activeCauseAfterRefresh) {
          return isMutationQueueingAllowed(activeCauseAfterRefresh);
        }

        await preparedCurrent.session.classifyFailure(error, {
          phase: 'mutation',
          storeType,
          operationName: prepared.operationName,
          sessionKey: preparedCurrent.sessionKey,
        });

        const activeCauseAfterClassification =
          getActiveMutationQueueingCause(preparedCurrent);

        return activeCauseAfterClassification
          ? isMutationQueueingAllowed(activeCauseAfterClassification)
          : false;
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

  function getOfflineResolutions(): OfflineResolutionRecordForStore<TOperations>[] {
    return buildDerivedResolutionRecords();
  }

  async function resolveOfflineResolution<
    TName extends keyof TOperations & string,
  >(
    resolutionId: string,
    operationName: TName,
    resolution: OfflineResolutionActionForOperation<TOperations, TName>,
  ): Promise<void> {
    await hydrateIfNeeded();
    const current = ensureActiveSession();
    if (!current) return;

    const resolutionRecord = resolutions.get(resolutionId);
    if (!resolutionRecord) return;

    if (resolutionRecord.operation !== operationName) {
      throw new Error(
        `Offline resolution operation mismatch: expected "${resolutionRecord.operation}" but received "${operationName}"`,
      );
    }

    const operation = operations[operationName];
    if (!operation) {
      await removeResolution(resolutionId, current);
      return;
    }

    if (isPersistedResolutionBlocked(resolutionRecord)) {
      throw new Error(
        'Cannot resolve a blocked offline resolution before its blocking dependencies are cleared',
      );
    }

    if (resolutionRecord.kind === 'retry-exhausted') {
      const resolutionAction = isObject(resolution) ? resolution : null;
      const action = resolutionAction?.action;

      if (action !== 'retry' && action !== 'discard') {
        throw new Error('Invalid offline resolution action');
      }

      if (action === 'discard') {
        await discardTempCreateResolutionChain({
          current,
          resolution: resolutionRecord,
        });
        return;
      }

      const scope = resolutionAction?.scope ?? 'self-and-descendants';
      const resolutionsToRetry = collectRetryResolutionChain({
        resolution: resolutionRecord,
        scope,
      });
      const { queueOrders, nextQueueOrderValue } = previewQueueOrders(
        resolutionsToRetry.length,
      );
      nextQueueOrder = nextQueueOrderValue;

      const nextEntries = resolutionsToRetry.map((retryResolution, index) => {
        const queueOrder = queueOrders[index];
        if (queueOrder === undefined) {
          throw new Error('Missing queue order for replay resolution requeue');
        }

        const entry = operations[retryResolution.operation]
          ? buildFreshQueueEntry({
              current,
              operation: retryResolution.operation,
              input: retryResolution.input,
              entityRefs: retryResolution.entityRefs,
              queueOrder,
              tempIds: retryResolution.tempIds,
            })
          : null;

        return { resolution: retryResolution, entry };
      });
      for (const retryResolution of resolutionsToRetry) {
        await removeResolution(retryResolution.id, current, true);
      }

      for (const nextEntry of nextEntries) {
        if (!nextEntry.entry) continue;
        await persistEntry(nextEntry.entry, current, true);
      }

      storeAdapter.captureQueuedMutationOverlays?.({
        sessionKey: current.sessionKey,
        entityRefs: nextEntries.flatMap((nextEntry) => {
          return nextEntry.entry?.entityRefs ?? [];
        }),
      });

      refreshDerivedState(current);
      await ensureReplayScheduled();
      return;
    }

    const resolutionAction = isObject(resolution) ? resolution : null;
    const action = resolutionAction?.action;

    if (action === 'discard') {
      await discardTempCreateResolutionChain({
        current,
        resolution: resolutionRecord,
      });
      return;
    }

    if (action === 'requeue') {
      await removeResolution(resolutionId, current, true);
      await queuePreparedMutations(
        prepareMutationWithSession(current, {
          operation: operationName,
          input: resolutionAction?.input,
          tempIds: resolutionRecord.tempIds,
          entityRefs: resolutionRecord.entityRefs,
        }),
      );
      return;
    }

    if (action === 'commit') {
      const committedResult = resolutionAction?.result;
      if (
        (operation.tempEntity || operation.tempEntities) &&
        committedResult === undefined
      ) {
        throw new Error(
          `Offline resolution "${resolutionRecord.operation}" requires a result when committing a temp-entity conflict`,
        );
      }

      if (committedResult !== undefined && resolutionRecord.tempIds) {
        await reconcileTempEntitiesFromResult({
          current,
          operationName: resolutionRecord.operation,
          input: resolutionRecord.input,
          tempIds: resolutionRecord.tempIds,
          result: committedResult,
        });
      }
      await removeResolution(resolutionId, current);
      return;
    }

    throw new Error('Invalid offline resolution action');
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

  function shouldTreatFetchAsOffline(): boolean {
    const current = ensureActiveSession();
    if (!current) return false;

    return shouldTreatFutureOperationsAsOffline(current);
  }

  async function handleFetchSuccess(): Promise<void> {
    const current = ensureActiveSession();
    if (!current) return;

    await clearOfflineStatusOnSuccess(current.sessionKey);
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
    parseOfflineResolutionConflict: parseConflictPayloadForResolution,
    resolveOfflineResolution,
    prepareForFetch,
    getSessionStatus,
    shouldTreatFetchAsOffline,
    handleFetchSuccess,
    evaluateOfflineFetchError,
    ensureReplayScheduled,
  };
}
