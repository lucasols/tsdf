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
  type OfflineMutationQueueingCause,
  type OfflineMutationQueueingPolicy,
  type OfflineMutationInput,
  type OfflineOperationSchemaShape,
  type OfflineQueueEntry,
  type OfflineResolutionRecord,
  type OfflineResolveConflictResult,
  type OfflineSession,
  type OfflineStoreType,
  type PersistedOfflineResolutionRecord,
} from './types';

const DEFAULT_REPLAY_RETRY_MAX_FAILURES = 5;
const DEFAULT_REPLAY_RETRY_INTERVAL_MS = 5_000;
const BLOCKED_TEMP_CREATE_RESOLUTION_MESSAGE =
  'Blocked by unresolved temp create dependency';

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

type TempCreateDependencySource = {
  entityKey: string;
  tempId?: ValidPayload;
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

    if (status.network.active) return 'network';

    if (status.outage.active) return 'outage';

    return null;
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

    if (!status.effectiveOffline) return 'run';

    const cause = getActiveMutationQueueingCause(current);
    if (cause === null) return 'run';

    if (isMutationQueueingAllowed(cause)) return 'queue';

    if (cause === 'network' && navigator.onLine === false) {
      return 'reject-offline';
    }

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

    if (
      navigator.onLine !== false &&
      current.session.getStatus().network.active
    ) {
      current.session.setNetworkActive(false, { classified: false });
    }

    if (
      current.session.getStatus().outage.active &&
      !current.session.getStatus().network.active
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
      createPersistentStorageNamespaceHandle<OfflineQueueEntry>({
        storeName,
        adapter,
        getSessionKey: () => targetSessionKey,
        onPersistentStorageError,
        entryPrefix: OFFLINE_QUEUE_STORAGE_ENTRY_PREFIX,
      });
    const resolutionNamespace =
      createPersistentStorageNamespaceHandle<PersistedOfflineResolutionRecord>({
        storeName,
        adapter,
        getSessionKey: () => targetSessionKey,
        onPersistentStorageError,
        entryPrefix: OFFLINE_CONFLICT_STORAGE_ENTRY_PREFIX,
      });
    const entityNamespace =
      createPersistentStorageNamespaceHandle<GlobalOfflineEntity>({
        storeName,
        adapter,
        getSessionKey: () => targetSessionKey,
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
      sessionKey: targetSessionKey,
      session,
      unregister,
      queueNamespace,
      resolutionNamespace,
      entityNamespace,
    };

    if (!session.getStatus().effectiveOffline && session.isLeader()) {
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

  function getTempCreateDependencySources(
    workItem: Pick<
      OfflineQueueEntry | PersistedOfflineResolutionRecord,
      'operation' | 'tempIds' | 'entityRefs'
    >,
  ): TempCreateDependencySource[] {
    if (!workItem.tempIds || workItem.tempIds.length === 0) return [];
    if (!isTempCreateOperation(workItem.operation)) return [];

    const itemEntityRefs = workItem.entityRefs.filter(
      (entityRef) => entityRef.entityKind === 'item',
    );

    return itemEntityRefs.flatMap((entityRef, index) => {
      const tempId = workItem.tempIds?.[index];
      return tempId === undefined
        ? []
        : [{ entityKey: entityRef.entityKey, tempId, sourceType: 'queue' }];
    });
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
    const tempDependencySourcesByEntityKey = new Map<
      string,
      TempCreateDependencySource
    >();
    const blockedByResolutionIdsByResolutionId = new Map<string, Set<string>>();
    const childResolutionIdsByResolutionId = new Map<string, Set<string>>();
    const blockedByResolutionIdsByEntityKey = new Map<string, Set<string>>();
    const childResolutionIdsByEntityKey = new Map<string, Set<string>>();
    const blockedResolutionIdsByResolutionId = new Map<string, Set<string>>();

    for (const entry of queueEntries.values()) {
      for (const source of getTempCreateDependencySources(entry)) {
        tempDependencySourcesByEntityKey.set(source.entityKey, {
          ...source,
          sourceType: 'queue',
        });
      }
    }

    for (const resolution of resolutions.values()) {
      for (const source of getTempCreateDependencySources(resolution)) {
        tempDependencySourcesByEntityKey.set(source.entityKey, {
          ...source,
          resolutionId: resolution.id,
          sourceType: 'resolution',
        });
      }
    }

    for (const resolution of resolutions.values()) {
      for (const dependencySource of tempDependencySourcesByEntityKey.values()) {
        if (
          !workItemDependsOnTempCreateSource({
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
  ): OfflineResolutionRecord[] {
    const snapshot = dependencySnapshot ?? createResolutionDependencySnapshot();

    return [...resolutions.values()]
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
      });
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

    sessionState.session.syncStoreData(storeName, {
      entities,
      resolutions: derivedResolutions,
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

  function hasPayloadReference(value: unknown, target: ValidPayload): boolean {
    if (deepEqual(value, target)) return true;
    if (!Array.isArray(value) && !isObject(value)) return false;

    if (Array.isArray(value)) {
      return value.some((entryValue) =>
        hasPayloadReference(entryValue, target),
      );
    }

    return Object.values(value).some((entryValue) =>
      hasPayloadReference(entryValue, target),
    );
  }

  function workItemDependsOnTempCreateSource(args: {
    workItem: Pick<
      OfflineQueueEntry | PersistedOfflineResolutionRecord,
      'entityRefs' | 'input' | 'operation' | 'tempIds'
    >;
    dependencySource: TempCreateDependencySource;
  }): boolean {
    if (
      getTempCreateDependencySources(args.workItem).some(
        (source) => source.entityKey === args.dependencySource.entityKey,
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

    return (
      args.dependencySource.tempId !== undefined &&
      hasPayloadReference(args.workItem.input, args.dependencySource.tempId)
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

    if (storeAdapter.normalizeEntityRefs) {
      return storeAdapter.normalizeEntityRefs(rawEntityRefs);
    }

    // WORKAROUND: Custom store adapters can return a concrete payload-key array
    // shape that is structurally compatible with OfflineEntityRef[], but TypeScript
    // cannot connect that erased generic to this controller-level union.
    return __LEGIT_CAST__<OfflineEntityRef[], unknown[]>(rawEntityRefs);
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
    entryIdToSkip: string;
    tempId: ValidPayload;
    finalPayload: ValidPayload;
  }): Promise<void> {
    const changedQueueEntries: OfflineQueueEntry[] = [];

    for (const entry of queueEntries.values()) {
      if (entry.id === args.entryIdToSkip) continue;

      const rewrite = rewriteEntryInput(entry, args.tempId, args.finalPayload);
      if (!rewrite) continue;

      const rewrittenEntry = { ...entry, ...rewrite };
      await persistEntry(rewrittenEntry, args.current, true);
      changedQueueEntries.push(rewrittenEntry);
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
    }

    if (changedQueueEntries.length > 0) {
      storeAdapter.captureQueuedMutationOverlays?.({
        sessionKey: args.current.sessionKey,
        entityRefs: changedQueueEntries.flatMap((entry) => entry.entityRefs),
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
    parentTempId?: ValidPayload;
    parentEntryId?: string;
    parentResolutionId?: string;
  }): TempCreateDescendantCollection {
    const sourcesByEntityKey = new Map<string, TempCreateDependencySource>([
      [
        args.parentEntityKey,
        {
          entityKey: args.parentEntityKey,
          tempId: args.parentTempId,
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
          !workItemDependsOnTempCreateSource({
            workItem: entry,
            dependencySource,
          })
        ) {
          continue;
        }

        descendantQueueEntries.set(entry.id, entry);
        for (const descendantSource of getTempCreateDependencySources(entry)) {
          if (seenEntityKeys.has(descendantSource.entityKey)) continue;

          seenEntityKeys.add(descendantSource.entityKey);
          pendingEntityKeys.push(descendantSource.entityKey);
          sourcesByEntityKey.set(descendantSource.entityKey, {
            ...descendantSource,
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
          !workItemDependsOnTempCreateSource({
            workItem: resolution,
            dependencySource,
          })
        ) {
          continue;
        }

        descendantResolutions.set(resolution.id, resolution);
        for (const descendantSource of getTempCreateDependencySources(
          resolution,
        )) {
          if (seenEntityKeys.has(descendantSource.entityKey)) continue;

          seenEntityKeys.add(descendantSource.entityKey);
          pendingEntityKeys.push(descendantSource.entityKey);
          sourcesByEntityKey.set(descendantSource.entityKey, {
            ...descendantSource,
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

    for (const source of getTempCreateDependencySources(args.parentEntry)) {
      const descendants = collectTempCreateDescendants({
        parentEntityKey: source.entityKey,
        parentTempId: source.tempId,
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
          message: BLOCKED_TEMP_CREATE_RESOLUTION_MESSAGE,
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

    const parentSources = getTempCreateDependencySources(args.resolution);
    if (parentSources.length === 0) {
      refreshDerivedState(args.current);
      return;
    }

    const descendantQueueEntries = new Map<string, OfflineQueueEntry>();
    const descendantResolutions = new Map<
      string,
      PersistedOfflineResolutionRecord
    >();

    for (const source of parentSources) {
      const descendants = collectTempCreateDescendants({
        parentEntityKey: source.entityKey,
        parentTempId: source.tempId,
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

    await persistManualResolutionChain({
      current: args.current,
      parentEntry: args.entry,
      parentResolution: buildConflictResolutionRecord(
        args.current,
        args.entry,
        args.conflict,
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
      current.session.getStatus().effectiveOffline ||
      current.session.isReplaySuppressed() ||
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
        current.session.isReplaySuppressed() ||
        !current.session.isLeader()
      ) {
        return;
      }

      const nextEntry = getSortedEntries()[0];
      if (!nextEntry) return;

      const operation = operations[nextEntry.operation];
      if (!operation) {
        await removeEntry(nextEntry.id, current);
        continue;
      }

      const shouldCheckSkipBeforeRetry =
        nextEntry.syncState === 'needs-confirmation';
      const conflictHandling = operation.conflictHandling;
      const tempEntity = operation.tempEntity;
      const tempEntities = operation.tempEntities;
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
          entryToUse.tempIds?.[0] !== undefined &&
          tempEntity &&
          storeAdapter.reconcileTempEntity
        ) {
          const reconciliation = tempEntity.reconcileServerEntity(
            result,
            entryToUse.tempIds[0],
          );
          storeAdapter.reconcileTempEntity({
            operationName: entryToUse.operation,
            input: entryToUse.input,
            tempId: entryToUse.tempIds[0],
            result,
            reconciliation,
          });
          await rebindQueuedEntriesAfterTempReconciliation({
            current,
            entryIdToSkip: entryToUse.id,
            tempId: entryToUse.tempIds[0],
            finalPayload: reconciliation.finalPayload,
          });
        }

        if (
          entryToUse.tempIds &&
          tempEntities &&
          storeAdapter.reconcileTempEntity
        ) {
          const reconciliations = orderByTempIds<{
            tempId: ValidPayload;
            finalPayload: ValidPayload;
            finalData?: unknown;
          }>({
            operationName: entryToUse.operation,
            label: 'Temp reconciliations',
            tempIds: entryToUse.tempIds,
            items: tempEntities
              .reconcileServerEntities(result, entryToUse.tempIds)
              .map((reconciliation) => ({
                tempId: castTempLifecyclePayload(reconciliation.tempId),
                finalPayload: castTempLifecyclePayload(
                  reconciliation.finalPayload,
                ),
                finalData: reconciliation.finalData,
              })),
          });

          for (const reconciliation of reconciliations) {
            storeAdapter.reconcileTempEntity({
              operationName: entryToUse.operation,
              input: entryToUse.input,
              tempId: reconciliation.tempId,
              result,
              reconciliation,
            });
            await rebindQueuedEntriesAfterTempReconciliation({
              current,
              entryIdToSkip: entryToUse.id,
              tempId: reconciliation.tempId,
              finalPayload: reconciliation.finalPayload,
            });
          }
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
          classification !== 'ignore' ||
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

  function getOfflineResolutions(): OfflineResolutionRecord[] {
    return buildDerivedResolutionRecords();
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

    const operation = operations[resolutionRecord.operation];
    if (!operation) {
      await removeResolution(resolutionId, current);
      return;
    }

    if (isPersistedResolutionBlocked(resolutionRecord)) {
      throw new Error(
        'Cannot resolve a blocked offline resolution before its parent temp create is cleared',
      );
    }

    if (resolutionRecord.kind === 'retry-exhausted') {
      const action = isObject(resolution) ? resolution.action : undefined;

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
        tempIds: resolutionRecord.tempIds,
      });
      await removeResolution(resolutionId, current, true);
      await persistEntry(nextEntry, current, true);
      refreshDerivedState(current);
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

    const typedResult: OfflineResolveConflictResult<unknown> = result;
    if (!typedResult) {
      await discardTempCreateResolutionChain({
        current,
        resolution: resolutionRecord,
      });
      return;
    }

    const requeue = typedResult.requeue;

    if (requeue) {
      await removeResolution(resolutionId, current, true);
      await queuePreparedMutations(
        prepareMutationWithSession(current, {
          // WORKAROUND: Resolution records persist operation names as plain strings, and requeueing needs to rebind the validated name to the operation-map key type.
          operation: __LEGIT_CAST__<keyof TOperations & string, string>(
            resolutionRecord.operation,
          ),
          input: requeue.input,
          tempIds: resolutionRecord.tempIds,
          entityRefs: resolutionRecord.entityRefs,
        }),
      );
      return;
    }

    await discardTempCreateResolutionChain({
      current,
      resolution: resolutionRecord,
    });
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
