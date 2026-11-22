import { createAsyncQueue } from '@ls-stack/utils/asyncQueue';
import { deepEqual } from '@ls-stack/utils/deepEqual';
import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_ANY__, __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { isObject, isPromise } from '@ls-stack/utils/typeGuards';
import {
  rc_array,
  rc_literals,
  rc_number,
  rc_object,
  rc_parse,
  rc_record,
  rc_string,
  rc_unknown,
} from 'runcheck';
import { Result, unknownToError } from 't-result';
import type { TSDFDebugLogger } from '../../debug';
import type {
  ItemLoadedFields,
  ListQueryAddItemToQueries,
} from '../../listQueryStore/types';
import type { BlockWindowCloseHandler } from '../../utils/performMutation';
import type { ValidPayload } from '../../utils/storeShared';
import {
  getNavigatorLockManager,
  warnIfNavigatorLockUnavailable,
} from '../navigatorLocks';
import type {
  OfflineAttachedUploadIds,
  OfflineDirectMutationContext,
  OfflineMutationUploadsInput,
} from '../offlineUploadTypes';
import { createPersistentStorageNamespaceHandle } from '../persistentStorageManager';
import {
  OFFLINE_CONFLICT_STORAGE_ENTRY_PREFIX,
  OFFLINE_ENTITY_STORAGE_ENTRY_PREFIX,
  OFFLINE_QUEUE_STORAGE_ENTRY_PREFIX,
} from '../storageEntryPrefixes';
import type { StorageAdapter } from '../types';
import { parseWithSchema, validateWithSchema } from '../validateWithSchema';
import {
  getOfflineStoreEntityLookup,
  toItemOfflineState,
} from './entityMetadata';
import {
  createDirectMutationContext,
  type OfflineAwareMutationController,
  type PreparedOfflineMutation,
} from './mutationRuntime';
import {
  getOfflineSessionAppVersion,
  getOfflineSessionUploadsConfig,
  getOrCreateSessionOfflineCoordinator,
} from './sessionCoordinator';
import {
  OfflineResolutionConflictParseError,
  offlineItemEntityRefSchema,
  offlineResolutionRecordSchema,
  type AnyOfflineOperationDefinition,
  type OfflineEntityMutationKind,
  type OfflineStoreFailureContext,
  type GlobalOfflineEntity,
  type InternalGlobalOfflineEntity,
  type ItemOfflineState,
  type OfflineMutationInput,
  type OfflineMutationQueueingCause,
  type OfflineMutationQueueingPolicy,
  type OfflineOperationKind,
  type OfflineOperationSchemaShape,
  type OfflineQueueEntry,
  type OfflineResolutionActionForOperation,
  type OfflineResolutionGenericAction,
  type OfflineResolutionGenericActionFailure,
  type OfflineResolutionRecordForStore,
  type OfflineEntityRef,
  type OfflineSession,
  type OfflineStoreType,
  type OperationConflict,
  type ParsedOfflineResolutionConflictResultForOperation,
  type PersistedOfflineResolutionRecord,
} from './types';

const DEFAULT_REPLAY_RETRY_MAX_FAILURES = 3;
const DEFAULT_REPLAY_RETRY_INTERVAL_MS = 5_000;
/**
 * Time given to a tab to learn about the queue changes of the tab that just
 * replayed, before it may replay itself.
 */
const REPLAY_HANDOFF_SETTLE_MS = 500;
const REPLAY_LOCK_UNAVAILABLE_WARNING =
  '[TSDF] navigator.locks is unavailable; with several tabs open, a queued offline mutation can be sent more than once.';
const BLOCKED_DEPENDENCY_RESOLUTION_MESSAGE =
  'Blocked by unresolved dependency';
/** Temp ref -> final ref remaps kept per store for the session lifetime. */
const MAX_RESOLVED_ENTITY_REFS = 1000;

/**
 * List-query placement declared for a pending temp entity. Stores without
 * queries never receive it.
 */
type PendingTempEntityListOptions<TQueryPayload extends ValidPayload> = {
  addToQueries?: ListQueryAddItemToQueries<TQueryPayload, ValidPayload>;
  loadedFields?: ItemLoadedFields;
};

type OfflineStoreAdapter<TQueryPayload extends ValidPayload> = {
  getEntityRefs?: (args: {
    operationName: string;
    input: unknown;
  }) => unknown[];
  normalizeEntityRefs?: (entityRefs: unknown[]) => OfflineEntityRef[];
  getProtectedCacheKeys: (entityRefs: OfflineEntityRef[]) => string[];
  applyPendingEntity?: (
    args: {
      operationName: string;
      input: unknown;
      tempId: ValidPayload;
      pendingEntity: unknown;
    } & PendingTempEntityListOptions<TQueryPayload>,
  ) => void;
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
  /**
   * Loads the temp items and the queries they are declared into that are only
   * in persistent storage (after a restart), so `applyPendingEntity` and
   * `reconcileTempEntity` reach them in memory. Returns `undefined` when
   * everything is already in memory.
   */
  loadTempEntities?: (
    tempIds: ValidPayload[],
    addToQueries: ListQueryAddItemToQueries<TQueryPayload, ValidPayload>[],
  ) => Promise<unknown> | undefined;
  /**
   * Another tab reconciled a temp entity of the store. This tab replaces its
   * own copy of the temp item (also where it sits in its lists), with
   * `finalData` when the sender had it, and notifies listeners. The store's
   * tab sync then brings the item snapshots of the sender.
   */
  applyTempReconciliationFromAnotherTab?: (
    tempId: ValidPayload,
    finalPayload: ValidPayload,
    finalData: unknown,
  ) => void;
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
    entities: InternalGlobalOfflineEntity[];
  }) => void;
  /**
   * The server saved these items created with a client-generated id. Called
   * before the creation's `onSuccessExecute`, so that invalidations it makes
   * refetch them: the entities are only synced again after it.
   */
  confirmClientIdCreations?: (entityKeys: string[]) => void;
  /**
   * A queued mutation for these entities was discarded. Its optimistic
   * changes are still applied to the store and no baseline exists to roll
   * them back to, so the store refetches the entities from the server.
   * `payload` is the item payload the operation referenced, if any: the
   * store may have no state left to read it from (an item deleted locally).
   * Entities other changes still wait for a manual resolution on are left
   * out: a refetch would replace those changes. `hasPendingResolutions` is `true` while other changes of the store still
   * wait for a manual resolution: a broad refetch (e.g. of lists) would
   * replace them, so the store should limit itself to the discarded entities.
   */
  revalidateDiscardedEntities?: (
    entities: (OfflineEntityRef & { payload: ValidPayload | undefined })[],
    hasPendingResolutions: boolean,
  ) => void;
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
    typeof createPersistentStorageNamespaceHandle<InternalGlobalOfflineEntity>
  >;
};

type NamespacePersistenceHandle<T> = Pick<
  ReturnType<typeof createPersistentStorageNamespaceHandle<T>>,
  'load' | 'listKeys' | 'remove' | 'save'
>;

const compactOfflineEntitySchema = rc_object({
  k: rc_string,
  g: rc_literals('d', 'i', 'q'),
  h: rc_literals('c', 'cu', 'u', 'x'),
  p: rc_number.optionalKey(),
  s: rc_literals('p', 's', 'n', 'r'),
  b: rc_array(rc_string).optionalKey(),
  c: rc_array(rc_string).optionalKey(),
  a: rc_number,
  u: rc_number,
  t: rc_unknown.optionalKey(),
  // Not `v`: local-sync reserves it for the entry version.
  y: rc_unknown.optionalKey(),
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
  z: rc_record(rc_string).optionalKey(),
  k: rc_array(rc_string).optionalKey(),
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

/**
 * An entity with several queued mutations reports the most urgent state among
 * them, so it shows `syncing` while any of its mutations is being sent.
 */
const entitySyncStatePriority: Record<
  GlobalOfflineEntity['syncState'],
  number
> = {
  pending: 0,
  syncing: 1,
  'needs-confirmation': 2,
  'resolution-required': 3,
};

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

function toCompactOfflineEntityMutationKind(
  kind: OfflineEntityMutationKind,
): 'c' | 'cu' | 'u' | 'x' {
  switch (kind) {
    case 'create':
      return 'c';
    case 'createAndUpdate':
      return 'cu';
    case 'update':
      return 'u';
    case 'delete':
      return 'x';
  }
}

function fromCompactOfflineEntityMutationKind(
  kind: 'c' | 'cu' | 'u' | 'x',
): OfflineEntityMutationKind {
  switch (kind) {
    case 'c':
      return 'create';
    case 'cu':
      return 'createAndUpdate';
    case 'u':
      return 'update';
    case 'x':
      return 'delete';
  }
}

function reduceOfflineEntityKind(
  current: OfflineEntityMutationKind | undefined,
  next: OfflineOperationKind,
): OfflineEntityMutationKind {
  switch (next) {
    case 'delete':
      return 'delete';
    case 'create':
      return 'create';
    case 'update':
      switch (current) {
        case 'create':
        case 'createAndUpdate':
          return 'createAndUpdate';
        case 'update':
          return 'update';
        case 'delete':
        case undefined:
          return 'update';
      }
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

function getQueueOrder(entry: {
  queueOrder?: number;
  createdAt: number;
}): number {
  return typeof entry.queueOrder === 'number'
    ? entry.queueOrder
    : entry.createdAt;
}

export class OfflineSessionUnavailableError extends Error {
  readonly code = 460;
  readonly id = 'offline-session-unavailable' as const;

  constructor() {
    super('Offline session unavailable');
    this.name = 'OfflineSessionUnavailableError';
  }
}

function normalizeEntityRefs(entityRefs: OfflineEntityRef[]): string {
  return JSON.stringify(
    entityRefs
      .map((ref) => `${ref.entityKind}:${ref.entityKey}`)
      .sort((left, right) => left.localeCompare(right)),
  );
}

function formatPayloadForError(value: ValidPayload): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Runs store code that calls the app's listeners after the server already
 * applied a replayed mutation. A listener that throws must not fail the replay
 * (the mutation would be sent again), so its error is thrown later, out of the
 * replay, where the app's error reporting still sees it.
 */
function runWithoutFailingReplay(run: () => void): void {
  try {
    run();
  } catch (error) {
    setTimeout(() => {
      throw error;
    }, 0);
  }
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

function compareResolutionRecords(
  left: PersistedOfflineResolutionRecord,
  right: PersistedOfflineResolutionRecord,
): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  if (left.enqueuedAt !== right.enqueuedAt) {
    return left.enqueuedAt - right.enqueuedAt;
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
  dispose: () => void;
  hydrateIfNeeded: () => Promise<void>;
  canQueueMutation: () => boolean;
  prepareForMutation: <TName extends keyof TOperations & string>(args: {
    offline: OfflineMutationInput<TOperations, TName>;
    upload?: OfflineMutationUploadsInput;
  }) => Promise<PreparedOfflineMutation>;
  runUnqueuedMutation: OfflineAwareMutationController<TOperations>['runUnqueuedMutation'];
  queueMutation: <TName extends keyof TOperations & string>(args: {
    offline: OfflineMutationInput<TOperations, TName>;
    upload?: OfflineMutationUploadsInput;
  }) => Promise<void>;
  getOfflineEntities: () => GlobalOfflineEntity[];
  getItemOfflineState: (itemKey: string) => ItemOfflineState | null;
  /**
   * Latest known final ref of an entity created offline, or the ref itself
   * while it was not reconciled (by this tab or another one) in this session.
   */
  resolveEntityRef: <TRef extends ValidPayload>(entityRef: TRef) => TRef;
  getOfflineResolutions: () => OfflineResolutionRecordForStore<TOperations>[];
  parseOfflineResolutionConflict: <TName extends keyof TOperations & string>(
    resolution: OfflineResolutionRecordForStore<TOperations, TName>,
  ) => ParsedOfflineResolutionConflictResultForOperation<TOperations, TName>;
  resolveOfflineResolution: <TName extends keyof TOperations & string>(
    resolutionId: string,
    operationName: TName,
    resolution: OfflineResolutionActionForOperation<TOperations, TName>,
  ) => Promise<void>;
  /**
   * Applies a generic `retry` / `discard` action without the caller knowing
   * the operation. Returns why the action was not applied, or `undefined` when
   * it was applied.
   */
  resolveOfflineResolutionWithGenericAction: (
    resolutionId: string,
    action: OfflineResolutionGenericAction,
  ) => Promise<OfflineResolutionGenericActionFailure | undefined>;
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
  TOperations extends Record<
    string,
    AnyOfflineOperationDefinition<__LEGIT_ANY__>
  >,
  TQueryPayload extends ValidPayload = ValidPayload,
>(
  storeName: string,
  storeType: OfflineStoreType,
  getSessionKey: () => string | false,
  onPersistentStorageError: ((error: unknown) => void) | undefined,
  debugLogger: TSDFDebugLogger | undefined,
  adapter: StorageAdapter,
  storeAdapter: OfflineStoreAdapter<TQueryPayload>,
  offlineSession: OfflineSession,
  operations: TOperations,
  blockWindowClose: BlockWindowCloseHandler | null,
): OfflineStoreController<TOperations> {
  const sessionConfig = offlineSession.getConfig();
  const appVersion = getOfflineSessionAppVersion(offlineSession);
  const activeDebugLogger = import.meta.env.DEV ? debugLogger : undefined;
  const replayQueue = createAsyncQueue({ concurrency: 1, autoStart: true });
  let isDisposed = false;
  let activeSession: ActiveSessionState | null = null;
  let replayScheduled = false;
  let replayRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let hydratedSessionKey: string | null = null;
  let hydratedPromise: Promise<void> | null = null;
  let releaseReplayLock: (() => void) | null = null;
  let heldReplayLockName: string | null = null;
  let replayLockReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  let nextQueueOrder = 0;
  // Ids of the resolutions the creations of this store wait for, as last
  // reported to the session (see `refreshDerivedState`).
  let publishedCreationResolutionIds = '';
  // Ids of the resolutions being queued again (see `requeueResolutions`).
  const requeuingResolutionIds = new Set<string>();
  const replayRetryMaxFailures =
    sessionConfig.replayRetry?.maxFailures ?? DEFAULT_REPLAY_RETRY_MAX_FAILURES;
  const replayRetryIntervalMs =
    sessionConfig.replayRetry?.intervalMs ?? DEFAULT_REPLAY_RETRY_INTERVAL_MS;
  const queueEntries = new Map<string, OfflineQueueEntry>();
  const resolutions = new Map<string, PersistedOfflineResolutionRecord>();
  const hasCancelledWithOperations = Object.values(operations).some(
    (operation) => operation.cancelledWith !== undefined,
  );
  // Uploads of stored records whose operation this deploy doesn't define
  // (written by a newer deploy), by record. This tab ignores those records
  // but leaves them in storage for a deploy that defines them, so their
  // uploads must not be cleaned up either.
  const unknownOperationUploadIds = new Map<string, string[]>();

  function trackUnknownOperationUploads(
    recordKey: string,
    record: OfflineQueueEntry | PersistedOfflineResolutionRecord | null,
  ): void {
    const uploadIds = record
      ? [
          ...Object.values(record.attachedUploadIds ?? {}),
          ...(record.dependencyUploadIds ?? []),
        ]
      : [];
    if (uploadIds.length > 0) {
      unknownOperationUploadIds.set(recordKey, uploadIds);
    } else {
      unknownOperationUploadIds.delete(recordKey);
    }
  }
  const countedReplayFailures = new Map<string, number>();
  // Queue entries another tab wrote. Another tab may be merging into them at
  // the same moment, so this tab never accumulates into them: both merges
  // would save the same entry id and one tab's input would be lost.
  const entryIdsFromAnotherTab = new Set<string>();
  // Mutations of this tab not in the queue yet (checking the connection, or
  // sent as a direct request), by the queue position reserved when they were
  // called. Queued, they go at that position, so no newer mutation is merged
  // into older work across them.
  const reservedMutations = new Map<number, PreparedQueuedMutation>();
  // Queue entries (`q:` keys) and resolution records (`r:` keys) whose last
  // write failed: this tab only holds them in memory, so a reload loses them.
  const inMemoryOnlyRecordKeys = new Set<string>();
  let unblockWindowCloseForInMemoryOnlyRecords: (() => void) | null = null;
  let isRetryingInMemoryOnlyRecords = false;
  const resolvedEntityRefBySerializedRef = new Map<string, ValidPayload>();

  type InternalQueuedMutationArgs<TName extends keyof TOperations & string> = {
    operation: TName;
    input: unknown;
    upload?: OfflineMutationUploadsInput;
    /** Already stored direct uploads reused instead of `upload` (requeue). */
    attachedUploadIds?: OfflineAttachedUploadIds;
    tempIds?: ValidPayload[];
    entityRefs?: OfflineEntityRef[];
  };

  type PendingTempEntity = {
    tempId: ValidPayload;
    pendingEntity: unknown;
  } & PendingTempEntityListOptions<TQueryPayload>;

  type PreparedQueuedMutation = {
    currentSessionKey: string;
    operationName: string;
    operation: AnyOfflineOperationDefinition;
    validatedInput: unknown;
    dependencyUploadIds: string[];
    upload?: OfflineMutationUploadsInput;
    attachedUploadIds?: OfflineAttachedUploadIds;
    tempIds?: ValidPayload[];
    entityRefs?: OfflineEntityRef[];
    /**
     * Queued after an earlier request of the same mutation may have reached
     * the server: its direct online request failed, or it replaces a conflict
     * the user sent again.
     */
    mayHaveBeenApplied?: boolean;
    /**
     * Queue position reserved when the mutation was called, so that a direct
     * request that falls back to the queue goes before the work queued while
     * it was in flight.
     */
    queueOrder?: number;
  };

  type PlannedQueuedMutation = {
    operationName: string;
    validatedInput: unknown;
    tempIds?: ValidPayload[];
    pendingEntities: PendingTempEntity[];
    nextEntry?: OfflineQueueEntry;
    removedEntries: OfflineQueueEntry[];
    /** Held work (see `findHeldWorkResolutions`) merged or superseded */
    removedResolutions?: PersistedOfflineResolutionRecord[];
    /** Held work the mutation merges into, and that stays held */
    replacedResolution?: PersistedOfflineResolutionRecord;
    /**
     * Unsent creations pruned by an operation that dropped itself: their
     * whole lifecycle is cancelled once the plan is applied.
     */
    cancelledTempCreates?: (
      | OfflineQueueEntry
      | PersistedOfflineResolutionRecord
    )[];
    /** The queued entry `nextEntry` merges into, when accumulating */
    accumulatedEntry?: OfflineQueueEntry;
    /** The held work merged into, when accumulating */
    accumulatedResolution?: PersistedOfflineResolutionRecord;
  };

  type AppliedQueuedMutation = PlannedQueuedMutation & {
    removedEntriesApplied: OfflineQueueEntry[];
    removedResolutionsApplied: PersistedOfflineResolutionRecord[];
    touchedNextEntry: boolean;
    touchedReplacedResolution: boolean;
  };

  /**
   * Reads the session gate (`offlineSession.enabled`). `'replay-only'` keeps it
   * open: the session disallows the queueing instead.
   */
  function isSessionEnabled(): boolean {
    return sessionConfig.enabled?.() !== false;
  }

  function shouldTreatFutureOperationsAsOffline(
    current: ActiveSessionState,
  ): boolean {
    return current.session.getActiveOfflineCause() !== null;
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

  function getOperationRawEntityRefs(
    operation: AnyOfflineOperationDefinition,
    operationName: string,
    validatedInput: unknown,
  ): unknown[] {
    return typeof operation.getEntityRefs === 'function'
      ? operation.getEntityRefs({ input: validatedInput })
      : (storeAdapter.getEntityRefs?.({
          operationName,
          input: validatedInput,
        }) ?? []);
  }

  /**
   * Whether mutations queued earlier for the entities this mutation affects
   * or depends on (`dependsOn`), or that depend on an entity this mutation
   * affects, are still waiting to reach the server (queued, replaying or
   * unconfirmed), or the creation of one of those entities waits for a manual
   * resolution, or the creation of an entity of another store the mutation
   * is declared `cancelledWith` is still queued or waits for one.
   */
  function hasQueuedWorkForSameEntities(
    prepared: PreparedQueuedMutation,
  ): boolean {
    if (
      queueEntries.size === 0 &&
      resolutions.size === 0 &&
      !prepared.operation.cancelledWith
    ) {
      return false;
    }

    const affectedEntityRefs = getPreparedEntityRefs(prepared);
    const entityRefs = [
      ...affectedEntityRefs,
      ...(prepared.operation.dependsOn
        ? resolveNormalizedRefs(
            prepared.operation.dependsOn({ input: prepared.validatedInput }),
          )
        : []),
    ];

    for (const entry of queueEntries.values()) {
      for (const queuedEntityRef of entry.entityRefs) {
        if (
          entityRefs.some((entityRef) =>
            isSameEntityRef(entityRef, queuedEntityRef),
          )
        ) {
          return true;
        }
      }

      // A queued mutation that depends on an entity this one changes (e.g. a
      // queued child creation and an online delete of its parent) must reach
      // the server first.
      const queuedDependencyKeys = getDependencyBlockerEntityKeys(entry);
      if (
        affectedEntityRefs.some((entityRef) =>
          queuedDependencyKeys.has(entityRef.entityKey),
        )
      ) {
        return true;
      }
    }

    // Held work of the entity would be replayed over the mutation once the
    // creation it waits for is retried. Queued, the mutation merges into or
    // supersedes that work instead.
    if (
      (prepared.operation.accumulation || prepared.operation.supersedes) &&
      findHeldWorkResolutions((resolution) =>
        resolution.entityRefs.some((resolutionRef) =>
          affectedEntityRefs.some((entityRef) =>
            isSameEntityRef(entityRef, resolutionRef),
          ),
        ),
      ).length > 0
    ) {
      return true;
    }

    if (
      isHeldBehindTempCreateResolution({
        operation: prepared.operationName,
        input: prepared.validatedInput,
        entityRefs,
        tempIds: prepared.tempIds,
      })
    ) {
      return true;
    }

    // The creation of an entity of another store the mutation belongs to is
    // still queued (e.g. a comment on a task whose creation is being
    // replayed): sent on its own, the mutation would reach the server before
    // that entity exists there. Queued, it is replayed after the creation,
    // and held behind it if it ends up waiting for a manual resolution.
    const current = activeSession;
    return (
      current !== null &&
      prepared.operation.cancelledWith !== undefined &&
      prepared.operation
        .cancelledWith({ input: prepared.validatedInput })
        .some(
          (externalEntityRef) =>
            externalEntityRef.storeName !== storeName &&
            current.session.hasQueuedCreation(
              externalEntityRef.storeName,
              externalEntityRef.entityRef,
            ),
        )
    );
  }

  /** The entities the mutation affects (`getEntityRefs`). */
  function getPreparedEntityRefs(
    prepared: PreparedQueuedMutation,
  ): OfflineEntityRef[] {
    return (
      prepared.entityRefs ??
      resolveNormalizedRefs(
        getOperationRawEntityRefs(
          prepared.operation,
          prepared.operationName,
          prepared.validatedInput,
        ),
      )
    );
  }

  function getInitialOfflineMutationAction(
    current: ActiveSessionState,
    prepared: PreparedQueuedMutation,
  ): PreparedOfflineMutation['initialAction'] {
    const cause = current.session.getStatus().isOfflineMode
      ? current.session.getActiveOfflineCause()
      : null;
    if (cause !== null && isMutationQueueingAllowed(cause)) return 'queue';

    // Sent on its own, a mutation would reach the server before the older
    // mutations still queued for the same entities, which would then
    // overwrite it (or it would target an entity that does not exist there
    // yet). It joins the queue to keep the order the user made them, also
    // when new offline work is not queued: in offline mode the server may
    // already be reachable (e.g. an outage that ended before the next
    // recovery check), and the direct run succeeding would replay the older
    // work over it.
    return hasQueuedWorkForSameEntities(prepared) ? 'queue' : 'run';
  }

  async function clearOfflineStatusOnSuccess(
    currentSessionKey: string,
  ): Promise<void> {
    const current = ensureActiveSession();
    if (!current || current.sessionKey !== currentSessionKey) {
      throw new OfflineSessionUnavailableError();
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
      // Same key as the stores' item keys: object payloads match whatever the
      // order of their keys
      const serializedRef = getCompositeKey(currentRef);
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
      getCompositeKey(previousRef),
      resolveEntityRef(nextRef),
    );

    // The table lives as long as the session: drop the oldest remaps so it
    // cannot grow without bound in a long session.
    if (resolvedEntityRefBySerializedRef.size > MAX_RESOLVED_ENTITY_REFS) {
      for (const oldestSerializedRef of resolvedEntityRefBySerializedRef.keys()) {
        resolvedEntityRefBySerializedRef.delete(oldestSerializedRef);
        break;
      }
    }
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

  /**
   * Whether the app still uses the session of `current`. Unlike
   * `isActiveSessionState`, it reads the session key again, so it notices an
   * in-place switch (e.g. to another org) that nothing reported yet.
   */
  function isSessionStillActive(current: ActiveSessionState): boolean {
    return ensureActiveSession()?.sessionKey === current.sessionKey;
  }

  function teardownActiveSession(): void {
    activeSession?.unregister?.();
    activeSession = null;
    resetReplayRetryState();
    // A running drain may still be sending an entry: it releases the lock
    // itself once that request settles, so another tab cannot send it too.
    if (!replayScheduled) releaseHeldReplayLock();
    resolvedEntityRefBySerializedRef.clear();
    queueEntries.clear();
    entryIdsFromAnotherTab.clear();
    resolutions.clear();
    // Work only held in memory is dropped with the session's records
    inMemoryOnlyRecordKeys.clear();
    syncInMemoryOnlyWindowCloseBlock();
    unknownOperationUploadIds.clear();
    nextQueueOrder = 0;
    publishedCreationResolutionIds = '';
    hydratedSessionKey = null;
    hydratedPromise = null;
  }

  function dispose(): void {
    if (isDisposed) return;

    isDisposed = true;
    teardownActiveSession();
    resetReplayRetryState();
    replayQueue.clear();
  }

  function ensureActiveSession(): ActiveSessionState | null {
    if (isDisposed) return null;

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
      ...(appVersion !== undefined ? { appVersion } : undefined),
      adapter,
      onPersistentStorageError,
      ...(import.meta.env.DEV ? { debugLogger: activeDebugLogger } : undefined),
      config: sessionConfig,
      uploads: getOfflineSessionUploadsConfig(offlineSession),
    });

    const queueNamespace =
      createPersistentStorageNamespaceHandle<OfflineQueueEntry>(
        {
          storeName,
          adapter,
          getSessionKey: () => targetSessionKey,
          onPersistentStorageError,
          ...(import.meta.env.DEV
            ? { debugLogger: activeDebugLogger }
            : undefined),
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
                ...(entry.attachedUploadIds !== undefined
                  ? { z: entry.attachedUploadIds }
                  : {}),
                ...(entry.dependencyUploadIds !== undefined
                  ? { k: entry.dependencyUploadIds }
                  : {}),
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
                ...(compactEntry.z !== undefined
                  ? { attachedUploadIds: compactEntry.z }
                  : {}),
                ...(compactEntry.k !== undefined
                  ? { dependencyUploadIds: compactEntry.k }
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
        ...(import.meta.env.DEV
          ? { debugLogger: activeDebugLogger }
          : undefined),
        entryPrefix: OFFLINE_CONFLICT_STORAGE_ENTRY_PREFIX,
      });
    const entityNamespace =
      createPersistentStorageNamespaceHandle<InternalGlobalOfflineEntity>(
        {
          storeName,
          adapter,
          getSessionKey: () => targetSessionKey,
          onPersistentStorageError,
          ...(import.meta.env.DEV
            ? { debugLogger: activeDebugLogger }
            : undefined),
          entryPrefix: OFFLINE_ENTITY_STORAGE_ENTRY_PREFIX,
        },
        {
          valueCodec: {
            serialize(entity) {
              return {
                k: entity.entityKey,
                g: toCompactOfflineEntityKind(entity.entityKind),
                h: toCompactOfflineEntityMutationKind(entity.kind),
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
                ...(entity.payload !== undefined ? { y: entity.payload } : {}),
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
                kind: fromCompactOfflineEntityMutationKind(compactEntity.h),
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
                ...(compactEntity.y !== undefined
                  ? {
                      // WORKAROUND: Derived item payloads are persisted as unknown JSON values and are narrowed back to ValidPayload when hydrating the internal entity cache.
                      payload: __LEGIT_CAST__<ValidPayload, unknown>(
                        compactEntity.y,
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
      onEntitiesCancelled: hasCancelledWithOperations
        ? discardWorkCancelledWithExternalEntities
        : undefined,
      findCreationResolutionId,
      hasQueuedCreation,
      onCreationsReleased: hasCancelledWithOperations
        ? requeueWorkHeldBehindExternalCreations
        : undefined,
      onCreationResolutionsChanged: hasCancelledWithOperations
        ? refreshExternalCreationBlockers
        : undefined,
      onRemoteQueueEntryChange: (entryId, entry) => {
        applyRecordChangeFromAnotherTab(() => {
          if (entry) {
            nextQueueOrder = Math.max(nextQueueOrder, getQueueOrder(entry) + 1);
            // Queued by a tab running a newer deploy of the app: this tab
            // cannot replay it, and must not drop it (or its uploads) either
            if (!operations[entry.operation]) {
              trackUnknownOperationUploads(`q:${entryId}`, entry);
              return;
            }

            queueEntries.set(entryId, entry);
            entryIdsFromAnotherTab.add(entryId);
            return;
          }

          trackUnknownOperationUploads(`q:${entryId}`, null);
          queueEntries.delete(entryId);
          entryIdsFromAnotherTab.delete(entryId);
          // This tab may be writing it again (see
          // `persistInMemoryOnlyRecords`): removed after that write, so an
          // entry another tab replayed is not stored again.
          if (forgetInMemoryOnlyRecord(`q:${entryId}`)) {
            void queueNamespace.remove(entryId);
          }
          countedReplayFailures.delete(entryId);
          if (queueEntries.size === 0) clearReplayRetryTimer();
        });
      },
      onRemoteResolutionChange: (resolutionId, resolution) => {
        applyRecordChangeFromAnotherTab(() => {
          const parsedResolution =
            resolution && rc_parse(resolution, offlineResolutionRecordSchema).ok
              ? resolution
              : null;
          if (parsedResolution && operations[parsedResolution.operation]) {
            resolutions.set(resolutionId, parsedResolution);
          } else {
            resolutions.delete(resolutionId);
            // See the queue entries above
            if (forgetInMemoryOnlyRecord(`r:${resolutionId}`)) {
              void resolutionNamespace.remove(resolutionId);
            }
          }
          // One a newer deploy wrote keeps its uploads
          trackUnknownOperationUploads(
            `r:${resolutionId}`,
            parsedResolution && !operations[parsedResolution.operation]
              ? parsedResolution
              : null,
          );
        });
      },
      onRemoteWorkDiscarded: (discardedWork, removedEntityKeys) => {
        // Sent after the removals of the discarded records, so this tab's
        // remaining resolutions already exclude them
        applyRecordChangeFromAnotherTab(() => {
          revalidateDiscardedWork(discardedWork, new Set(removedEntityKeys));
        });
      },
      onRemoteTempReconciled: (tempId, finalPayload, finalData) => {
        // Sent before the replaying tab rewrites the queued records that
        // reference the temp entity (those reach this tab in later messages):
        // this tab maps the temp payload and replaces its own copy of the
        // temp entity
        rememberResolvedEntityRef(tempId, finalPayload);
        storeAdapter.applyTempReconciliationFromAnotherTab?.(
          tempId,
          finalPayload,
          finalData,
        );
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
      entryIdsFromAnotherTab.clear();
      resolutions.clear();
      inMemoryOnlyRecordKeys.clear();
      syncInMemoryOnlyWindowCloseBlock();
      unknownOperationUploadIds.clear();
      // Records of an operation this deploy doesn't define were written by a
      // newer deploy: they stay in storage, with their uploads, for a deploy
      // that can send or resolve them, and this tab neither lists nor
      // replays them.
      for (const entry of loadedQueueEntries.values()) {
        if (operations[entry.operation]) {
          queueEntries.set(entry.id, entry);
        } else {
          trackUnknownOperationUploads(`q:${entry.id}`, entry);
        }
      }
      for (const resolution of loadedResolutionEntries.values()) {
        const parsed = rc_parse(resolution, offlineResolutionRecordSchema);
        if (!parsed.ok) {
          void current.resolutionNamespace.remove(resolution.id);
          continue;
        }
        if (operations[resolution.operation]) {
          resolutions.set(resolution.id, resolution);
        } else {
          trackUnknownOperationUploads(`r:${resolution.id}`, resolution);
        }
      }
      // Skipped entries keep their place in the queue order
      nextQueueOrder = getNextQueueOrder(loadedQueueEntries.values());
      hydratedSessionKey = current.sessionKey;
      refreshDerivedState(current);
    })().finally(() => {
      hydratedPromise = null;
    });

    return hydratedPromise;
  }

  /**
   * Applies to this tab's in-memory queue a record change made by another tab,
   * so the leader replays entries queued by any tab and every tab stops
   * showing (and can never replay) an entry another tab already replayed.
   */
  function applyRecordChangeFromAnotherTab(
    applyChange: () => void,
    changeSession: ActiveSessionState | null = activeSession,
  ): void {
    const current = activeSession;
    // A change deferred behind hydration belongs to the session it came from
    if (!current || current !== changeSession) return;

    if (hydratedPromise) {
      // The hydration in flight may have read the records before the change
      const applyAfterHydration = (): void => {
        applyRecordChangeFromAnotherTab(applyChange, current);
      };
      void hydratedPromise.then(applyAfterHydration, applyAfterHydration);
      return;
    }
    // Not hydrated yet: the eventual hydration reads the current records
    if (hydratedSessionKey !== current.sessionKey) return;

    applyChange();
    refreshDerivedState(current, true);
  }

  function parseConflictPayloadForOperation<
    TName extends keyof TOperations & string,
  >(
    operationName: TName,
    conflict: unknown,
  ): ParsedOfflineResolutionConflictResultForOperation<TOperations, TName> {
    // Looked up by the untyped name, the operation may not be registered.
    const registeredName: string = operationName;
    const operation = operations[registeredName];
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

  function getOperationLifecycleKind(
    operationName: string,
  ): OfflineOperationKind {
    return operations[operationName]?.kind ?? 'update';
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

  function getDependencyUploadIds(args: {
    operationName: string;
    input: unknown;
  }): string[] {
    const operation = operations[args.operationName];
    if (!operation?.dependsOnUploads) return [];

    return [...new Set(operation.dependsOnUploads({ input: args.input }))].sort(
      (left, right) => left.localeCompare(right),
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
      for (const entityKey of getCreatedEntityKeys(entry)) {
        dependencySourcesByEntityKey.set(entityKey, {
          entityKey,
          sourceType: 'queue',
        });
      }
    }

    for (const resolution of resolutions.values()) {
      for (const entityKey of getCreatedEntityKeys(resolution)) {
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

    // Work held behind the creation of an entity of another store (see
    // `getExternalCreationResolutionIds`).
    if (hasCancelledWithOperations) {
      for (const resolution of resolutions.values()) {
        for (const blockerId of getExternalCreationResolutionIds(resolution)) {
          getOrCreateSet(blockedResolutionIdsByResolutionId, resolution.id).add(
            blockerId,
          );
          getOrCreateSet(
            blockedByResolutionIdsByResolutionId,
            resolution.id,
          ).add(blockerId);
          for (const entityRef of resolution.entityRefs) {
            getOrCreateSet(
              blockedByResolutionIdsByEntityKey,
              entityRef.entityKey,
            ).add(blockerId);
          }
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
        .sort(compareResolutionRecords),
    );
  }

  function refreshDerivedState(
    current?: ActiveSessionState,
    isRemoteChange?: boolean,
  ): void {
    const session = current ?? ensureActiveSession();
    if (!session || !isActiveSessionState(session)) return;
    const sessionState = session;
    const dependencySnapshot = createResolutionDependencySnapshot();
    const entitiesByKey = new Map<string, InternalGlobalOfflineEntity>();
    // Unsent creations (temp entities, or items created with a
    // client-generated id) whose creation is not "never sent" anymore. Kept
    // out of the entities so that hooks reading them do not re-render when a
    // creation starts being sent.
    const attemptedCreationEntityKeys = new Set<string>();
    let creationResolutionIds = '';
    const hasInMemoryOnlyRecords = inMemoryOnlyRecordKeys.size > 0;

    function createEntityBase(
      ref: OfflineEntityRef,
    ): Pick<
      InternalGlobalOfflineEntity,
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
      const operationKind = getOperationLifecycleKind(entry.operation);
      const clientIdCreatedEntityKeys = getClientIdCreatedEntityKeys(entry);
      for (const ref of entry.entityRefs) {
        const existing = entitiesByKey.get(ref.entityKey);
        const childResolutionIds =
          dependencySnapshot.childResolutionIdsByEntityKey.get(ref.entityKey) ??
          [];
        const blockedByResolutionIds =
          dependencySnapshot.blockedByResolutionIdsByEntityKey.get(
            ref.entityKey,
          ) ?? [];
        const tempId = getTempIdForEntityRef({
          entityRefs: entry.entityRefs,
          tempIds: entry.tempIds,
          entityKey: ref.entityKey,
        });
        const isClientIdCreation = clientIdCreatedEntityKeys.includes(
          ref.entityKey,
        );
        const isInMemoryOnly =
          existing?.isInMemoryOnly ??
          (hasInMemoryOnlyRecords &&
            inMemoryOnlyRecordKeys.has(`q:${entry.id}`));

        entitiesByKey.set(ref.entityKey, {
          ...createEntityBase(ref),
          kind: reduceOfflineEntityKind(existing?.kind, operationKind),
          pendingMutations: (existing?.pendingMutations ?? 0) + 1,
          syncState:
            existing &&
            entitySyncStatePriority[existing.syncState] >
              entitySyncStatePriority[entry.syncState]
              ? existing.syncState
              : entry.syncState,
          requiresResolution: existing?.requiresResolution ?? false,
          blockedByResolutionIds,
          childResolutionIds,
          blockedResolutionCount: blockedByResolutionIds.length,
          childResolutionCount: childResolutionIds.length,
          createdAt: existing?.createdAt ?? entry.createdAt,
          updatedAt: entry.updatedAt,
          tempId: tempId ?? existing?.tempId,
          payload:
            getPayloadForEntityRef({
              operationName: entry.operation,
              input: entry.input,
              entityKey: ref.entityKey,
            }) ?? existing?.payload,
          ...(isClientIdCreation || existing?.isClientIdCreation
            ? { isClientIdCreation: true }
            : {}),
          ...(isInMemoryOnly ? { isInMemoryOnly: true } : {}),
        });

        if (
          (tempId !== undefined || isClientIdCreation) &&
          !isUnsentQueueEntry(entry)
        ) {
          attemptedCreationEntityKeys.add(ref.entityKey);
        }
      }
    }

    for (const resolution of resolutions.values()) {
      const operationKind = getOperationLifecycleKind(resolution.operation);
      const clientIdCreatedEntityKeys =
        getClientIdCreatedEntityKeys(resolution);
      if (
        clientIdCreatedEntityKeys.length > 0 ||
        getTempLifecycleEntityKeys(resolution).length > 0
      ) {
        creationResolutionIds += `${resolution.id}\n`;
      }
      for (const ref of resolution.entityRefs) {
        const existing = entitiesByKey.get(ref.entityKey);
        const childResolutionIds =
          dependencySnapshot.childResolutionIdsByEntityKey.get(ref.entityKey) ??
          [];
        const blockedByResolutionIds =
          dependencySnapshot.blockedByResolutionIdsByEntityKey.get(
            ref.entityKey,
          ) ?? [];
        const tempId = getTempIdForEntityRef({
          entityRefs: resolution.entityRefs,
          tempIds: resolution.tempIds,
          entityKey: ref.entityKey,
        });
        const isClientIdCreation = clientIdCreatedEntityKeys.includes(
          ref.entityKey,
        );
        const isInMemoryOnly =
          existing?.isInMemoryOnly ??
          (hasInMemoryOnlyRecords &&
            inMemoryOnlyRecordKeys.has(`r:${resolution.id}`));

        entitiesByKey.set(ref.entityKey, {
          ...createEntityBase(ref),
          kind: reduceOfflineEntityKind(existing?.kind, operationKind),
          pendingMutations: existing?.pendingMutations ?? 0,
          syncState: 'resolution-required',
          requiresResolution: true,
          blockedByResolutionIds,
          childResolutionIds,
          blockedResolutionCount: blockedByResolutionIds.length,
          childResolutionCount: childResolutionIds.length,
          createdAt: existing?.createdAt ?? resolution.createdAt,
          updatedAt: resolution.updatedAt,
          tempId: tempId ?? existing?.tempId,
          payload:
            getPayloadForEntityRef({
              operationName: resolution.operation,
              input: resolution.input,
              entityKey: ref.entityKey,
            }) ?? existing?.payload,
          ...(isClientIdCreation || existing?.isClientIdCreation
            ? { isClientIdCreation: true }
            : {}),
          ...(isInMemoryOnly ? { isInMemoryOnly: true } : {}),
        });

        // A creation held for a manual resolution cannot be cancelled
        // locally anymore, whether or not it reached the server. One held
        // behind another creation waiting for a decision was never sent: a
        // delete still cancels it (see `findHeldWorkResolutions`).
        if (
          (tempId !== undefined || isClientIdCreation) &&
          !isHeldWorkResolution(resolution, dependencySnapshot)
        ) {
          attemptedCreationEntityKeys.add(ref.entityKey);
        }
      }
    }

    const entities = [...entitiesByKey.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    const derivedResolutions =
      buildDerivedResolutionRecords(dependencySnapshot);
    const referencedUploadIds = [
      ...new Set([
        ...[...queueEntries.values(), ...resolutions.values()].flatMap(
          (entry) => [
            ...Object.values(entry.attachedUploadIds ?? {}),
            ...(entry.dependencyUploadIds ?? []),
          ],
        ),
        ...[...unknownOperationUploadIds.values()].flat(),
      ]),
    ].sort((left, right) => left.localeCompare(right));
    const protectedKeys = storeAdapter.getProtectedCacheKeys(
      entities.map((entity) => ({
        entityKey: entity.entityKey,
        entityKind: entity.entityKind,
      })),
    );
    const nextReplayEntry = getSortedEntries()[0] ?? null;

    // Before publishing to the session: publishing can make the store
    // recover and revalidate, which must already see the store's current
    // entities (e.g. a creation that is no longer local-only).
    storeAdapter.syncEntityOverlays?.({
      sessionKey: sessionState.sessionKey,
      entities,
    });
    sessionState.session.syncStoreData(
      storeName,
      {
        adapter,
        entities,
        attemptedCreationEntityIds: entities
          .filter((entity) => attemptedCreationEntityKeys.has(entity.entityKey))
          .map((entity) => entity.id),
        resolutions: derivedResolutions,
        referencedUploadIds,
        protectedKeys,
        inMemoryOnlyRecordCount: inMemoryOnlyRecordKeys.size,
        replayHead:
          nextReplayEntry === null
            ? null
            : {
                storeName,
                entryId: nextReplayEntry.id,
                queueOrder: getQueueOrder(nextReplayEntry),
                createdAt: nextReplayEntry.createdAt,
              },
      },
      isRemoteChange,
    );

    // The tab that made the change already persisted the derived entities
    if (!isRemoteChange) void syncEntityNamespace(sessionState, entities);

    // The other stores report which of these resolutions their work declared
    // `cancelledWith` an entity of this store is held behind (see
    // `getExternalCreationResolutionIds`): they report it again when a
    // creation of this store starts or stops waiting for one, whatever
    // changed it (a decision, a replay, another tab, the hydration).
    if (creationResolutionIds !== publishedCreationResolutionIds) {
      publishedCreationResolutionIds = creationResolutionIds;
      sessionState.session.notifyCreationResolutionsChanged(
        storeName,
        isRemoteChange,
      );
    }
  }

  async function syncEntityNamespace(
    current: ActiveSessionState,
    entities: GlobalOfflineEntity[],
  ): Promise<void> {
    await current.entityNamespace.replaceAll(
      entities.map((entity) => ({ data: entity, key: entity.entityKey })),
    );
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

  function previewQueueOrders(
    count: number,
    minQueueOrder = 0,
  ): { queueOrders: number[]; nextQueueOrderValue: number } {
    const baseQueueOrder = Math.max(nextQueueOrder, Date.now(), minQueueOrder);
    const queueOrders = Array.from({ length: count }, (_, index) => {
      return baseQueueOrder + index;
    });

    return { queueOrders, nextQueueOrderValue: baseQueueOrder + count };
  }

  function buildAttachedUploadIds(
    entryId: string,
    upload: OfflineMutationUploadsInput | undefined,
  ): OfflineAttachedUploadIds | undefined {
    if (!upload) return undefined;

    return Object.fromEntries(
      Object.keys(upload)
        .sort((left, right) => left.localeCompare(right))
        .map((uploadId) => [uploadId, `${entryId}:${uploadId}`]),
    );
  }

  function buildFreshQueueEntry(args: {
    current: ActiveSessionState;
    operation: string;
    input: unknown;
    entityRefs: OfflineEntityRef[];
    queueOrder: number;
    attachedUploads?: OfflineMutationUploadsInput;
    attachedUploadIds?: OfflineAttachedUploadIds;
    dependencyUploadIds?: string[];
    tempIds?: ValidPayload[];
  }): OfflineQueueEntry {
    const now = Date.now();
    const entryId = `${storeName}:${now}:${Math.random().toString(36).slice(2, 10)}`;
    const attachedUploadIds =
      args.attachedUploadIds ??
      buildAttachedUploadIds(entryId, args.attachedUploads);

    return {
      id: entryId,
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
      attachedUploadIds,
      dependencyUploadIds: args.dependencyUploadIds,
      tempIds: args.tempIds,
    };
  }

  function findAccumulationCandidate(args: {
    operationName: string;
    entityRefs: OfflineEntityRef[];
    /**
     * The queue order of the incoming mutation. Entries ordered after it come
     * from mutations made after it (queued while it was planned), so they are
     * neither merged into nor block a merge: they are sent after it anyway.
     */
    queueOrder: number;
    entries?: Iterable<OfflineQueueEntry>;
  }): OfflineQueueEntry | null {
    const normalizedEntityRefs = normalizeEntityRefs(args.entityRefs);
    let candidate: OfflineQueueEntry | null = null;
    let newestEntityEntry: OfflineQueueEntry | null = null;

    for (const entry of args.entries ?? queueEntries.values()) {
      if (getQueueOrder(entry) > args.queueOrder) continue;

      if (
        entry.entityRefs.some((entryRef) =>
          args.entityRefs.some((entityRef) =>
            isSameEntityRef(entityRef, entryRef),
          ),
        ) &&
        (!newestEntityEntry ||
          compareQueueEntries(entry, newestEntityEntry) > 0)
      ) {
        newestEntityEntry = entry;
      }

      if (entry.operation !== args.operationName) continue;
      if (!isUnsentQueueEntry(entry)) continue;
      if (entryIdsFromAnotherTab.has(entry.id)) continue;
      if (entry.tempIds && entry.tempIds.length > 0) continue;
      if (normalizeEntityRefs(entry.entityRefs) !== normalizedEntityRefs) {
        continue;
      }

      // The newest one: merging into an older one would send the incoming
      // change before the newer queued work of the entity, which could then
      // overwrite it (e.g. held work queued again after another edit).
      if (!candidate || compareQueueEntries(entry, candidate) > 0) {
        candidate = entry;
      }
    }

    // Newer queued work of the entity (of another operation, from another
    // tab, or not mergeable) is sent after the candidate and could overwrite
    // the incoming change merged into it, so the mutation is queued after it.
    return candidate &&
      (!newestEntityEntry ||
        compareQueueEntries(newestEntityEntry, candidate) <= 0)
      ? candidate
      : null;
  }

  /**
   * Whether the entry was never sent: only then can it be dropped or merged
   * without the server possibly having applied it.
   */
  function isUnsentQueueEntry(entry: OfflineQueueEntry): boolean {
    return entry.syncState === 'pending' && entry.attempts === 0;
  }

  function hasReservedMutationBetween(
    sessionKey: string,
    afterQueueOrder: number,
    beforeQueueOrder: number,
    entityRefs: OfflineEntityRef[],
  ): boolean {
    for (const [queueOrder, prepared] of reservedMutations) {
      // A mutation of a session the app switched away from is never queued
      // in this one
      if (
        prepared.currentSessionKey !== sessionKey ||
        queueOrder <= afterQueueOrder ||
        queueOrder >= beforeQueueOrder
      ) {
        continue;
      }
      const runEntityRefs = getPreparedEntityRefs(prepared);
      if (
        entityRefs.some((ref) =>
          runEntityRefs.some((runRef) => isSameEntityRef(ref, runRef)),
        )
      ) {
        return true;
      }
    }
    return false;
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
          isUnsentQueueEntry(entry) &&
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
      attachedUploadIds: entry.attachedUploadIds,
      dependencyUploadIds: entry.dependencyUploadIds,
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
      getCreatedEntityKeys(args.workItem).includes(
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

  function getPayloadForEntityRef(args: {
    entityKey: string;
    input: unknown;
    operationName: string;
  }): ValidPayload | undefined {
    const operation = operations[args.operationName];
    const rawEntityRefs =
      operation && typeof operation.getEntityRefs === 'function'
        ? operation.getEntityRefs({ input: args.input })
        : (storeAdapter.getEntityRefs?.({
            operationName: args.operationName,
            input: args.input,
          }) ?? []);
    if (rawEntityRefs.length === 0) return undefined;

    const resolvedEntityRefs = resolveNormalizedRefs(rawEntityRefs);
    for (const [index, ref] of resolvedEntityRefs.entries()) {
      if (ref.entityKind !== 'item' || ref.entityKey !== args.entityKey) {
        continue;
      }

      const rawEntityRef = rawEntityRefs[index];
      if (offlineItemEntityRefSchema.parse(rawEntityRef).unwrapOrNull()) {
        return undefined;
      }

      // WORKAROUND: Offline queue entity refs are typed as unknown at the
      // shared controller boundary, so list-query item payloads must be
      // narrowed back to ValidPayload after confirming the ref is not already a
      // normalized `{ entityKey, entityKind }` object.
      return __LEGIT_CAST__<ValidPayload, unknown>(rawEntityRef);
    }

    return undefined;
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

  async function buildOperationExecuteContext(args: {
    current: ActiveSessionState;
    entry: Pick<
      OfflineQueueEntry | PersistedOfflineResolutionRecord,
      'input' | 'createdAt' | 'updatedAt' | 'attachedUploadIds'
    >;
    resolvedRefsById: Record<string, ValidPayload>;
  }) {
    const fileEntries = await Promise.all(
      Object.entries(args.entry.attachedUploadIds ?? {}).map(
        async ([uploadId, storedUploadId]) => {
          const file = await args.current.session.loadUpload(storedUploadId);
          if (!file) {
            throw new Error(`Missing offline upload "${storedUploadId}"`);
          }
          return [uploadId, file] as const;
        },
      ),
    );
    const filesById: Record<string, File> = Object.fromEntries(fileEntries);

    return {
      ...buildOperationBaseContext({
        input: args.entry.input,
        enqueuedAt: args.entry.createdAt,
        updatedAt: args.entry.updatedAt,
      }),
      uploads: { filesById, resolvedRefsById: args.resolvedRefsById },
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
      args.current.session.publishResolutionChange(
        storeName,
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
    const reconcileTempEntity = storeAdapter.reconcileTempEntity;
    if (!reconcileTempEntity) return;

    // The server already applied the mutation, so a failed storage read, or a
    // throwing `addToQueries` filter, must not fail the replay: the temp items
    // are then reconciled from memory.
    try {
      await storeAdapter.loadTempEntities?.(
        args.tempIds,
        getReplayedTempEntityQueries(tempEntity, args.input, args.tempIds),
      );
    } catch {
      // ignored, see above
    }

    if (tempEntity) {
      const tempId = args.tempIds[0];
      if (tempId === undefined) return;

      const reconciliation = tempEntity.reconcileServerEntity(
        args.result,
        tempId,
      );
      // Sent first so the other tabs move the temp item before the store's
      // tab sync tells them it was deleted
      args.current.session.publishTempReconciled(
        storeName,
        tempId,
        reconciliation.finalPayload,
        reconciliation.finalData,
      );
      // Mapped before the store emits `tempEntityReconciled`, so a listener
      // can already resolve the temp payload, as in the other tabs. Not when
      // the session changed while the request was running: the mapping
      // belongs to the session that created the entity.
      if (isActiveSessionState(args.current)) {
        rememberResolvedEntityRef(tempId, reconciliation.finalPayload);
      }
      runWithoutFailingReplay(() => {
        reconcileTempEntity({
          operationName: args.operationName,
          input: args.input,
          tempId,
          result: args.result,
          reconciliation,
        });
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
      args.current.session.publishTempReconciled(
        storeName,
        reconciliation.tempId,
        reconciliation.finalPayload,
        reconciliation.finalData,
      );
      if (isActiveSessionState(args.current)) {
        rememberResolvedEntityRef(
          reconciliation.tempId,
          reconciliation.finalPayload,
        );
      }
      runWithoutFailingReplay(() => {
        reconcileTempEntity({
          operationName: args.operationName,
          input: args.input,
          tempId: reconciliation.tempId,
          result: args.result,
          reconciliation,
        });
      });
      await rebindQueuedEntriesAfterTempReconciliation({
        current: args.current,
        entryIdToSkip: args.entryIdToSkip,
        tempId: reconciliation.tempId,
        finalPayload: reconciliation.finalPayload,
      });
    }
  }

  /**
   * The queries a replayed temp entity was declared into, so the lists that
   * are only in persistent storage are loaded and receive the final entity.
   * Only a `tempEntity` declaration is computed again, never the batch
   * builder: the server already applied the mutation, so app code must not
   * run (or throw) again here.
   */
  function getReplayedTempEntityQueries(
    tempEntity: AnyOfflineOperationDefinition['tempEntity'],
    input: unknown,
    tempIds: ValidPayload[],
  ): ListQueryAddItemToQueries<TQueryPayload, ValidPayload>[] {
    const tempId = tempIds[0];
    if (!tempEntity?.addToQueries || tempId === undefined) return [];
    try {
      const addToQueries =
        typeof tempEntity.addToQueries === 'function'
          ? tempEntity.addToQueries(input, tempId)
          : tempEntity.addToQueries;
      return addToQueries ? [addToQueries] : [];
    } catch {
      return [];
    }
  }

  /**
   * Loads the queries the pending entities are declared into that are only in
   * persistent storage, so they receive the entities. Returns `undefined`
   * when there is nothing to load.
   */
  function loadPendingEntityQueries(
    pendingEntities: PendingTempEntity[],
  ): Promise<unknown> | undefined {
    const addToQueries = pendingEntities.flatMap((pendingEntity) =>
      pendingEntity.addToQueries ? [pendingEntity.addToQueries] : [],
    );
    if (addToQueries.length === 0) return undefined;
    // The lists only show the entity: a failed read must not fail the
    // mutation
    return storeAdapter.loadTempEntities?.([], addToQueries)?.catch(() => {});
  }

  /**
   * Records whether the last write of a queue entry (`q:` key) or resolution
   * record (`r:` key) reached storage. One whose write failed is only held in
   * memory, and keeps the window close blocked, until a later write of it
   * succeeds or it leaves this tab's records.
   */
  function setRecordPersisted(
    recordKey: string,
    persisted: boolean,
    isStillHeld: boolean,
  ): void {
    if (persisted || !isStillHeld) {
      inMemoryOnlyRecordKeys.delete(recordKey);
    } else {
      inMemoryOnlyRecordKeys.add(recordKey);
    }
    syncInMemoryOnlyWindowCloseBlock();
  }

  /** Returns whether the record was only held in memory */
  function forgetInMemoryOnlyRecord(recordKey: string): boolean {
    if (!inMemoryOnlyRecordKeys.delete(recordKey)) return false;
    syncInMemoryOnlyWindowCloseBlock();
    return true;
  }

  function syncInMemoryOnlyWindowCloseBlock(): void {
    if (inMemoryOnlyRecordKeys.size > 0) {
      unblockWindowCloseForInMemoryOnlyRecords ??=
        blockWindowClose?.().unblock ?? null;
      return;
    }

    const unblock = unblockWindowCloseForInMemoryOnlyRecords;
    unblockWindowCloseForInMemoryOnlyRecords = null;
    unblock?.();
  }

  /**
   * Writes the records only held in memory again after a write of this
   * store's records succeeded: storage works again (e.g. the browser accepted
   * a new IndexedDB connection), so they can survive a reload too.
   */
  function persistInMemoryOnlyRecords(current: ActiveSessionState): void {
    if (isRetryingInMemoryOnlyRecords || inMemoryOnlyRecordKeys.size === 0) {
      return;
    }
    isRetryingInMemoryOnlyRecords = true;

    let persistedAny = false;
    const writes = [...inMemoryOnlyRecordKeys].map(async (recordKey) => {
      const recordId = recordKey.slice(2);
      const isQueueEntry = recordKey.startsWith('q:');
      const records = isQueueEntry ? queueEntries : resolutions;
      let write: Promise<boolean> | undefined;
      if (isQueueEntry) {
        const entry = queueEntries.get(recordId);
        if (entry) write = current.queueNamespace.save(recordId, entry);
      } else {
        const resolution = resolutions.get(recordId);
        if (resolution) {
          write = current.resolutionNamespace.save(recordId, resolution);
        }
      }
      if (!write) return;

      const persisted = await write;
      if (!isActiveSessionState(current)) return;
      if (persisted) persistedAny = true;
      setRecordPersisted(recordKey, persisted, records.has(recordId));
    });

    void Promise.all(writes).finally(() => {
      isRetryingInMemoryOnlyRecords = false;
      if (persistedAny && isActiveSessionState(current)) {
        refreshDerivedState(current);
      }
    });
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
    const persisted = await session.queueNamespace.save(entry.id, entry);
    session.session.publishQueueEntryChange(storeName, entry.id, entry);
    if (!isActiveSessionState(session)) return;
    setRecordPersisted(`q:${entry.id}`, persisted, queueEntries.has(entry.id));
    if (persisted) persistInMemoryOnlyRecords(session);
    if (!skipRefresh) refreshDerivedState(session);
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
      entryIdsFromAnotherTab.delete(entryId);
      countedReplayFailures.delete(entryId);
      forgetInMemoryOnlyRecord(`q:${entryId}`);
      if (queueEntries.size === 0) {
        clearReplayRetryTimer();
      }
    }
    // Announced before the storage write: an entry that was replayed must
    // leave the other tabs' queues as early as possible.
    session.session.publishQueueEntryChange(storeName, entryId, null);
    const removed = await session.queueNamespace.remove(entryId);
    if (!isActiveSessionState(session)) return;
    if (removed) persistInMemoryOnlyRecords(session);
    if (!skipRefresh) refreshDerivedState(session);
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
    const persisted = await session.resolutionNamespace.save(
      resolution.id,
      resolution,
    );
    session.session.publishResolutionChange(
      storeName,
      resolution.id,
      resolution,
    );
    if (!isActiveSessionState(session)) return;
    setRecordPersisted(
      `r:${resolution.id}`,
      persisted,
      resolutions.has(resolution.id),
    );
    if (persisted) persistInMemoryOnlyRecords(session);
    if (!skipRefresh) refreshDerivedState(session);
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
      forgetInMemoryOnlyRecord(`r:${resolutionId}`);
    }
    const removed = await session.resolutionNamespace.remove(resolutionId);
    session.session.publishResolutionChange(storeName, resolutionId, null);
    if (!isActiveSessionState(session)) return;
    if (removed) persistInMemoryOnlyRecords(session);
    if (!skipRefresh) refreshDerivedState(session);
  }

  /**
   * Deletes the staged uploads that work items depended on, after those items
   * left the queue for good (replayed, discarded, superseded, cancelled).
   *
   * Call it after `refreshDerivedState`, which reports the references that
   * remain: the session keeps every upload a queue entry or resolution record
   * of any store still needs. Attached uploads need no call, the session drops
   * them as soon as nothing references them.
   */
  async function deleteOrphanedDependencyUploads(
    current: ActiveSessionState,
    removedWorkItems: Pick<OfflineQueueEntry, 'dependencyUploadIds'>[],
  ): Promise<void> {
    if (!isActiveSessionState(current)) return;

    const uploadIds = removedWorkItems.flatMap(
      (workItem) => workItem.dependencyUploadIds ?? [],
    );
    if (uploadIds.length === 0) return;

    await current.session.deleteUnreferencedUploads(uploadIds);
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
    const sortedEntries = getSortedEntries();

    while (pendingEntityKeys.length > 0) {
      const entityKey = pendingEntityKeys.shift();
      if (!entityKey) continue;
      const dependencySource = sourcesByEntityKey.get(entityKey);
      if (!dependencySource) continue;

      for (const entry of sortedEntries) {
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
        for (const descendantEntityKey of getCreatedEntityKeys(entry)) {
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
        for (const descendantEntityKey of getCreatedEntityKeys(resolution)) {
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
      resolutions: [...descendantResolutions.values()].sort(
        compareResolutionRecords,
      ),
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

  /**
   * Whether the work targets or depends on an entity whose creation (temp
   * entity or client-generated id) is held in a manual resolution, or is
   * declared `cancelledWith` such an entity of another store. Such work cannot
   * be sent (the server does not know the entity) until that resolution is
   * decided.
   */
  function isHeldBehindTempCreateResolution(
    workItem: Pick<
      OfflineQueueEntry,
      'entityRefs' | 'input' | 'operation' | 'tempIds'
    >,
  ): boolean {
    for (const resolution of resolutions.values()) {
      for (const entityKey of getCreatedEntityKeys(resolution)) {
        if (
          workItemDependsOnDependencySource({
            workItem,
            dependencySource: {
              entityKey,
              resolutionId: resolution.id,
              sourceType: 'resolution',
            },
          })
        ) {
          return true;
        }
      }
    }

    return getExternalCreationResolutionIds(workItem).length > 0;
  }

  /**
   * Ids of the manual resolutions that the creations of the entities of other
   * stores the work is declared `cancelledWith` wait for. Sent now, the work
   * would reach the server before those entities exist, so it is held behind
   * them like the work on an entity of this store. Only the stores attached
   * in this tab are known.
   */
  function getExternalCreationResolutionIds(
    workItem: Pick<OfflineQueueEntry, 'operation' | 'input'>,
  ): string[] {
    if (!hasCancelledWithOperations || !activeSession) return [];

    const externalEntityRefs = operations[workItem.operation]?.cancelledWith?.({
      input: workItem.input,
    });
    if (!externalEntityRefs) return [];

    const resolutionIds: string[] = [];
    for (const externalEntityRef of externalEntityRefs) {
      if (externalEntityRef.storeName === storeName) continue;

      const resolutionId = activeSession.session.findCreationResolutionId(
        externalEntityRef.storeName,
        externalEntityRef.entityRef,
      );
      if (resolutionId !== undefined) resolutionIds.push(resolutionId);
    }

    return resolutionIds;
  }

  /**
   * Id of the manual resolution the creation of an entity of this store
   * waits for, if any. Lets the other stores hold their work declared
   * `cancelledWith` that entity (see `getExternalCreationResolutionIds`).
   */
  function findCreationResolutionId(
    entityRef: ValidPayload,
  ): string | undefined {
    if (resolutions.size === 0) return undefined;

    const entityKey = getEntityKeyOfPayload(entityRef);
    if (entityKey === undefined) return undefined;

    for (const resolution of resolutions.values()) {
      if (getCreatedEntityKeys(resolution).includes(entityKey)) {
        return resolution.id;
      }
    }

    return undefined;
  }

  /**
   * Whether the creation of an entity of this store is still queued. Lets
   * the other stores queue their online work declared `cancelledWith` that
   * entity behind it (see `hasQueuedWorkForSameEntities`).
   */
  function hasQueuedCreation(entityRef: ValidPayload): boolean {
    if (queueEntries.size === 0) return false;

    const entityKey = getEntityKeyOfPayload(entityRef);
    if (entityKey === undefined) return false;

    for (const entry of queueEntries.values()) {
      if (getCreatedEntityKeys(entry).includes(entityKey)) return true;
    }

    return false;
  }

  /**
   * Another store of the session sent again, or kept, creations that waited
   * for a manual resolution: queues again, after them, the held work of this
   * store declared `cancelledWith` one of them that waits for nothing else,
   * with the work held behind it.
   */
  async function requeueWorkHeldBehindExternalCreations(
    sourceStoreName: string,
    releasedEntityKeys: ReadonlySet<string>,
    getSourceEntityKey: (entityRef: ValidPayload) => string | undefined,
    minQueueOrder: number,
  ): Promise<number> {
    await hydrateIfNeeded();
    const current = ensureActiveSession();
    if (!current || resolutions.size === 0) return minQueueOrder;

    const dependencySnapshot = createResolutionDependencySnapshot();
    const releasedWork = new Map<string, PersistedOfflineResolutionRecord>();
    for (const resolution of [...resolutions.values()].sort(
      compareResolutionRecords,
    )) {
      if (
        releasedWork.has(resolution.id) ||
        !isBlockedDependencyResolution(resolution) ||
        dependencySnapshot.blockedByResolutionIdsByResolutionId.has(
          resolution.id,
        ) ||
        !isCancelledWithExternalEntity(
          resolution,
          sourceStoreName,
          releasedEntityKeys,
          getSourceEntityKey,
        )
      ) {
        continue;
      }

      for (const workItem of collectRetryResolutionChain({
        resolution,
        scope: 'self-and-descendants',
      })) {
        releasedWork.set(workItem.id, workItem);
      }
    }
    if (releasedWork.size === 0) return minQueueOrder;

    const requeuedWork = [...releasedWork.values()];
    await requeueResolutions(current, requeuedWork, undefined, minQueueOrder);
    // The work other stores held behind the creations queued again follows
    // them in turn (e.g. the reactions to a comment held behind its task).
    return notifyCreationsReleased(current, requeuedWork);
  }

  /**
   * The creations of another store that wait for a manual resolution
   * changed: reports again which of them the resolutions of this store are
   * held behind (see `getExternalCreationResolutionIds`). Like that change,
   * it is not published or persisted again when another tab made it
   * (`isRemoteChange`).
   */
  function refreshExternalCreationBlockers(isRemoteChange?: boolean): void {
    const current = activeSession;
    if (
      !current ||
      hydratedSessionKey !== current.sessionKey ||
      resolutions.size === 0
    ) {
      return;
    }

    refreshDerivedState(current, isRemoteChange);
  }

  /**
   * Lets the other stores of the session queue again the work they held
   * behind the creations of `releasedWork`, which was just queued again or
   * kept (see `requeueWorkHeldBehindExternalCreations`). Resolves to the
   * queue order that follows this work and the work they queued again.
   */
  async function notifyCreationsReleased(
    current: ActiveSessionState,
    releasedWork: readonly PersistedOfflineResolutionRecord[],
  ): Promise<number> {
    const releasedEntityKeys = new Set(
      releasedWork.flatMap((workItem) => getCreatedEntityKeys(workItem)),
    );
    if (releasedEntityKeys.size === 0) return nextQueueOrder;

    return current.session.notifyCreationsReleased(
      storeName,
      releasedEntityKeys,
      getEntityKeyOfPayload,
      nextQueueOrder,
    );
  }

  /** Work held behind a creation waiting for a decision, never sent. */
  function isBlockedDependencyResolution(
    resolution: PersistedOfflineResolutionRecord,
  ): boolean {
    return (
      resolution.kind === 'retry-exhausted' &&
      resolution.lastReplayError.message ===
        BLOCKED_DEPENDENCY_RESOLUTION_MESSAGE
    );
  }

  /**
   * Whether the work is declared `cancelledWith` one of the `entityKeys` of
   * store `sourceStoreName`, keyed by `getSourceEntityKey` like that store's
   * own entity refs: equivalent payloads match whatever their shape.
   */
  function isCancelledWithExternalEntity(
    workItem: Pick<
      OfflineQueueEntry | PersistedOfflineResolutionRecord,
      'input' | 'operation'
    >,
    sourceStoreName: string,
    entityKeys: ReadonlySet<string>,
    getSourceEntityKey: (entityRef: ValidPayload) => string | undefined,
  ): boolean {
    const externalEntityRefs = operations[workItem.operation]?.cancelledWith?.({
      input: workItem.input,
    });

    return (
      externalEntityRefs !== undefined &&
      externalEntityRefs.some((externalEntityRef) => {
        if (externalEntityRef.storeName !== sourceStoreName) return false;
        const entityKey = getSourceEntityKey(externalEntityRef.entityRef);
        return entityKey !== undefined && entityKeys.has(entityKey);
      })
    );
  }

  /**
   * The resolutions holding work behind a temp creation that waits for a
   * manual resolution, among those `matches` accepts. That work was never sent
   * (it waits for the creation), so like an unsent queue entry it can still be
   * merged into or superseded by a later mutation of the same entity.
   * Otherwise the later mutation would be sent first, and the held work
   * replayed over it once the creation is retried.
   */
  function findHeldWorkResolutions(
    matches: (resolution: PersistedOfflineResolutionRecord) => boolean,
    excludedResolutionId?: string,
  ): PersistedOfflineResolutionRecord[] {
    if (resolutions.size === 0) return [];

    const heldResolutions: PersistedOfflineResolutionRecord[] = [];
    for (const resolution of resolutions.values()) {
      if (
        resolution.id === excludedResolutionId ||
        !matches(resolution) ||
        !isHeldWorkResolution(resolution)
      ) {
        continue;
      }
      heldResolutions.push(resolution);
    }

    return heldResolutions.sort(compareResolutionRecords);
  }

  /**
   * Work held behind a temp creation waiting for a decision, never sent. A
   * `dependencySnapshot` of the current resolutions answers it without
   * scanning them again.
   */
  function isHeldWorkResolution(
    resolution: PersistedOfflineResolutionRecord,
    dependencySnapshot?: ResolutionDependencySnapshot,
  ): boolean {
    if (!isBlockedDependencyResolution(resolution)) return false;

    return dependencySnapshot
      ? dependencySnapshot.blockedByResolutionIdsByResolutionId.has(
          resolution.id,
        )
      : isHeldBehindTempCreateResolution(resolution);
  }

  /**
   * Removes the items a discarded `create` without temp entity (the app
   * generated the id on the client) added to the store, like the rollback of a
   * temp create, and adds their keys to `removedEntityKeys`. Like removed temp
   * entities, they are not refetched: the server most likely never got them.
   * If an earlier replay attempt did create one, the store's list
   * revalidation brings it back.
   */
  function rollbackClientIdCreatedItems(
    workItem: Pick<
      OfflineQueueEntry | PersistedOfflineResolutionRecord,
      'operation' | 'input' | 'entityRefs'
    >,
    removedEntityKeys: Set<string>,
    droppedEntityKeys: ReadonlySet<string>,
    cancelledEntityKeys: Set<string>,
  ): void {
    for (const entityKey of getClientIdCreatedEntityKeys(workItem)) {
      const payload = getPayloadForEntityRef({
        operationName: workItem.operation,
        input: workItem.input,
        entityKey,
      });
      if (payload === undefined) continue;

      storeAdapter.rollbackPendingEntity?.({
        operationName: workItem.operation,
        input: workItem.input,
        tempId: payload,
        pendingEntity: undefined,
      });
      removedEntityKeys.add(entityKey);
      // Like a temp entity, an item whose creation was never sent, or was
      // discarded while it waited for a decision, will not get the work of
      // other stores on it: that work is dropped too.
      if (droppedEntityKeys.has(entityKey)) {
        cancelledEntityKeys.add(entityKey);
      }
    }
  }

  /**
   * Keys of the items a `create` without temp entity adds to the store with
   * a client-generated id.
   */
  function getClientIdCreatedEntityKeys(
    workItem: Pick<
      OfflineQueueEntry | PersistedOfflineResolutionRecord,
      'operation' | 'entityRefs'
    >,
  ): string[] {
    if (
      getOperationLifecycleKind(workItem.operation) !== 'create' ||
      isTempCreateOperation(workItem.operation)
    ) {
      return [];
    }

    return workItem.entityRefs
      .filter((entityRef) => entityRef.entityKind === 'item')
      .map((entityRef) => entityRef.entityKey);
  }

  /**
   * Keys of the items a creation adds to the store before the server has
   * them: its temp entities, or the items a `create` without temp entity adds
   * with a client-generated id. Work on them waits for that creation.
   */
  function getCreatedEntityKeys(
    workItem: Pick<
      OfflineQueueEntry | PersistedOfflineResolutionRecord,
      'operation' | 'tempIds' | 'entityRefs'
    >,
  ): string[] {
    const tempEntityKeys = getTempLifecycleEntityKeys(workItem);
    return tempEntityKeys.length > 0
      ? tempEntityKeys
      : getClientIdCreatedEntityKeys(workItem);
  }

  async function promoteBlockedTempCreateDescendants(args: {
    current: ActiveSessionState;
    parentEntry: OfflineQueueEntry;
    parentResolutionId: string;
  }): Promise<void> {
    const descendantQueueEntries = new Map<string, OfflineQueueEntry>();

    for (const entityKey of getCreatedEntityKeys(args.parentEntry)) {
      const descendants = collectTempCreateDescendants({
        parentEntityKey: entityKey,
        parentResolutionId: args.parentResolutionId,
      });

      for (const entry of descendants.queueEntries) {
        descendantQueueEntries.set(entry.id, entry);
      }
    }

    for (const dependentEntry of descendantQueueEntries.values()) {
      await persistResolution(
        buildRetryExhaustedResolutionRecord(args.current, dependentEntry, {
          message: BLOCKED_DEPENDENCY_RESOLUTION_MESSAGE,
        }),
        args.current,
        true,
      );
      await removeEntry(dependentEntry.id, args.current, true);
    }
  }

  async function persistManualResolutionChain(args: {
    current: ActiveSessionState;
    parentEntry: OfflineQueueEntry;
    parentResolution: PersistedOfflineResolutionRecord;
  }): Promise<void> {
    // Replay will not upload these again on its own, so an upload left waiting
    // on an earlier failure must not keep reporting an automatic retry.
    await args.current.session.markUploadsFailed(
      args.parentEntry.dependencyUploadIds ?? [],
    );
    // The resolution is saved before the entry is removed: the other tabs
    // apply each change as it arrives, and in between they would see the
    // store with nothing left to replay or decide on, and revalidate it over
    // the change that now waits for the user's decision.
    await persistResolution(args.parentResolution, args.current, true);
    await removeEntry(args.parentEntry.id, args.current, true);
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

  /**
   * Drops everything that only made sense with temp entities that will never
   * exist on the server, because their creation (`tempCreates`, already
   * removed by the caller) was cancelled before being sent or discarded:
   *
   * - the queued work and manual resolutions of this store that target or
   *   depend on those entities, or on the items an unsent or discarded
   *   creation added with a client-generated id, recursively
   * - the temp entities themselves, and the items the dropped work created
   *   with a client-generated id
   * - the work of other stores declared as `cancelledWith` those entities,
   *   or the items unsent or discarded creations added with a
   *   client-generated id
   *
   * The server entities the dropped work changed optimistically are
   * refetched, and the staged uploads only the dropped work and `tempCreates`
   * depended on are deleted.
   */
  async function discardTempLifecycles(
    current: ActiveSessionState,
    tempCreates: readonly (
      | OfflineQueueEntry
      | PersistedOfflineResolutionRecord
    )[],
  ): Promise<void> {
    const descendantQueueEntries = new Map<string, OfflineQueueEntry>();
    const descendantResolutions = new Map<
      string,
      PersistedOfflineResolutionRecord
    >();

    // The descendants of temp entities are collected recursively. An item
    // created with a client-generated id by a creation that was never sent is
    // dropped as well, so the work queued on it is collected the same way. A
    // queued creation that was sent may exist on the server: the work queued
    // on its item is not dropped with it. A dropped creation resolution holds
    // the work on its item (see `isHeldBehindTempCreateResolution`), which
    // goes with it.
    const parentEntityKeys: string[] = [];
    // Items created with a client-generated id that are dropped with the
    // work held behind them, here and in other stores.
    const droppedClientIdEntityKeys = new Set<string>();
    function addDroppedClientIdCreation(
      workItem: OfflineQueueEntry | PersistedOfflineResolutionRecord,
    ): void {
      for (const entityKey of getClientIdCreatedEntityKeys(workItem)) {
        parentEntityKeys.push(entityKey);
        droppedClientIdEntityKeys.add(entityKey);
      }
    }

    for (const tempCreate of tempCreates) {
      parentEntityKeys.push(...getTempLifecycleEntityKeys(tempCreate));
      // A queue entry still unsent, or any creation resolution: one waiting
      // for a decision holds the work on its item, which goes with it.
      if (!('syncState' in tempCreate) || isUnsentQueueEntry(tempCreate)) {
        addDroppedClientIdCreation(tempCreate);
      }
    }

    for (const entityKey of parentEntityKeys) {
      const descendants = collectTempCreateDescendants({
        parentEntityKey: entityKey,
      });

      for (const queueEntry of descendants.queueEntries) {
        if (descendantQueueEntries.has(queueEntry.id)) continue;
        descendantQueueEntries.set(queueEntry.id, queueEntry);
        if (isUnsentQueueEntry(queueEntry)) {
          addDroppedClientIdCreation(queueEntry);
        }
      }
      for (const resolution of descendants.resolutions) {
        if (descendantResolutions.has(resolution.id)) continue;
        descendantResolutions.set(resolution.id, resolution);
        // Work on an entity whose creation never succeeded waits behind that
        // creation, so a descendant resolution was never sent.
        addDroppedClientIdCreation(resolution);
      }
    }

    for (const queueEntry of descendantQueueEntries.values()) {
      await removeEntry(queueEntry.id, current, true);
    }

    for (const resolution of descendantResolutions.values()) {
      await removeResolution(resolution.id, current, true);
    }

    const droppedDescendants = [
      ...descendantQueueEntries.values(),
      ...descendantResolutions.values(),
    ];
    // The temp entities and the items created with a client-generated id are
    // removed, not refetched: the server most likely never got them.
    const removedEntityKeys = new Set<string>();
    // Keys of the entities that will never exist on the server, as this store
    // keys its entity refs: the other stores match their `cancelledWith` refs
    // against them through `getEntityKeyOfPayload`.
    const cancelledEntityKeys = new Set<string>();

    for (const workItem of [...droppedDescendants, ...tempCreates]) {
      rollbackClientIdCreatedItems(
        workItem,
        removedEntityKeys,
        droppedClientIdEntityKeys,
        cancelledEntityKeys,
      );
      for (const entityKey of getTempLifecycleEntityKeys(workItem)) {
        removedEntityKeys.add(entityKey);
        cancelledEntityKeys.add(entityKey);
      }

      if (!workItem.tempIds || !isTempCreateOperation(workItem.operation)) {
        continue;
      }

      rollbackTempCreatePendingEntity(workItem);
    }

    refreshDerivedState(current);

    // The dropped work may also have changed entities that exist on the
    // server (e.g. moved an item into the cancelled one), and work without a
    // temp entity to roll back keeps its optimistic change applied: those
    // entities are refetched.
    const discardedWork: (
      | OfflineQueueEntry
      | PersistedOfflineResolutionRecord
    )[] = [...droppedDescendants];
    for (const tempCreate of tempCreates) {
      if (getTempLifecycleEntityKeys(tempCreate).length === 0) {
        discardedWork.push(tempCreate);
      }
    }
    revalidateDiscardedWorkInEveryTab(
      current,
      discardedWork,
      removedEntityKeys,
    );
    await deleteOrphanedDependencyUploads(current, [
      ...tempCreates,
      ...droppedDescendants,
    ]);

    if (cancelledEntityKeys.size > 0) {
      await current.session.notifyEntitiesCancelled(
        storeName,
        cancelledEntityKeys,
        getEntityKeyOfPayload,
      );
    }
  }

  async function discardTempCreateResolutionChain(args: {
    current: ActiveSessionState;
    resolution: PersistedOfflineResolutionRecord;
  }): Promise<void> {
    await removeResolution(args.resolution.id, args.current, true);
    await discardTempLifecycles(args.current, [args.resolution]);
  }

  /**
   * A `kind: 'delete'` operation of this store succeeded: the other stores of
   * the session drop their work declared `cancelledWith` one of the entities
   * it references (`getEntityRefs`), as for a cancelled creation (see
   * `discardWorkCancelledWithExternalEntities`). Only the stores attached
   * in this tab are notified.
   *
   * An entity this store still has a creation for, queued or waiting for a
   * manual resolution, is left out: it was created again after the delete
   * (same client-generated id), so the work of the other stores follows that
   * creation instead.
   */
  async function notifyEntitiesDeleted(
    current: ActiveSessionState,
    deletedEntityRefs: readonly OfflineEntityRef[],
  ): Promise<void> {
    if (deletedEntityRefs.length === 0) return;

    const deletedEntityKeys = new Set(
      deletedEntityRefs.map((entityRef) => entityRef.entityKey),
    );
    for (const entry of queueEntries.values()) {
      for (const entityKey of getCreatedEntityKeys(entry)) {
        deletedEntityKeys.delete(entityKey);
      }
    }
    for (const resolution of resolutions.values()) {
      for (const entityKey of getCreatedEntityKeys(resolution)) {
        deletedEntityKeys.delete(entityKey);
      }
    }
    if (deletedEntityKeys.size === 0) return;

    await current.session.notifyEntitiesCancelled(
      storeName,
      deletedEntityKeys,
      getEntityKeyOfPayload,
    );
  }

  /** Key of an entity payload of this store, as its entity refs hold it. */
  function getEntityKeyOfPayload(entityRef: ValidPayload): string | undefined {
    return resolveNormalizedRefs([entityRef])[0]?.entityKey;
  }

  /**
   * Another store of the session reported entities created offline that will
   * never exist on the server, or entities a delete removed from it: drops
   * the work of this store declared as `cancelledWith` one of them, with its
   * own temp lifecycles.
   */
  async function discardWorkCancelledWithExternalEntities(
    sourceStoreName: string,
    cancelledEntityKeys: ReadonlySet<string>,
    getSourceEntityKey: (entityRef: ValidPayload) => string | undefined,
  ): Promise<void> {
    await hydrateIfNeeded();
    const current = ensureActiveSession();
    if (!current) return;

    function isCancelled(
      workItem: Pick<
        OfflineQueueEntry | PersistedOfflineResolutionRecord,
        'input' | 'operation'
      >,
    ): boolean {
      return isCancelledWithExternalEntity(
        workItem,
        sourceStoreName,
        cancelledEntityKeys,
        getSourceEntityKey,
      );
    }

    // A request in flight cannot be taken back: its outcome is handled by
    // the replay as usual.
    const cancelledQueueEntries = [...queueEntries.values()].filter(
      (entry) => entry.syncState !== 'syncing' && isCancelled(entry),
    );
    const cancelledResolutions = [...resolutions.values()].filter(isCancelled);
    if (
      cancelledQueueEntries.length === 0 &&
      cancelledResolutions.length === 0
    ) {
      return;
    }

    for (const queueEntry of cancelledQueueEntries) {
      await removeEntry(queueEntry.id, current, true);
    }
    for (const resolution of cancelledResolutions) {
      await removeResolution(resolution.id, current, true);
    }

    await discardTempLifecycles(current, [
      ...cancelledQueueEntries,
      ...cancelledResolutions,
    ]);
  }

  /**
   * {@link revalidateDiscardedWork} in this tab and in the other tabs with the
   * store: each one may show the discarded optimistic changes.
   */
  function revalidateDiscardedWorkInEveryTab(
    current: ActiveSessionState,
    discardedWork: Pick<
      OfflineQueueEntry | PersistedOfflineResolutionRecord,
      'operation' | 'input' | 'entityRefs'
    >[],
    removedEntityKeys: ReadonlySet<string>,
  ): void {
    revalidateDiscardedWork(discardedWork, removedEntityKeys);

    if (!discardedWork.some((workItem) => workItem.entityRefs.length > 0)) {
      return;
    }
    current.session.publishWorkDiscarded(
      storeName,
      discardedWork.map(({ operation, input, entityRefs }) => ({
        operation,
        input,
        entityRefs,
      })),
      [...removedEntityKeys],
    );
  }

  /**
   * Refetches the entities discarded queued work referenced (its optimistic
   * changes cannot be rolled back locally), except the entities the discard
   * removed (temp entities and items of discarded creations) and the
   * entities other changes still wait for a decision on: a refetch
   * would replace those changes. The recovery revalidation refetches them
   * once the last one is handled.
   */
  function revalidateDiscardedWork(
    discardedWork: Pick<
      OfflineQueueEntry | PersistedOfflineResolutionRecord,
      'operation' | 'input' | 'entityRefs'
    >[],
    removedEntityKeys: ReadonlySet<string>,
  ): void {
    const entities: (OfflineEntityRef & {
      payload: ValidPayload | undefined;
    })[] = [];
    const skippedEntityKeys = new Set(removedEntityKeys);
    for (const resolution of resolutions.values()) {
      for (const ref of resolution.entityRefs) {
        skippedEntityKeys.add(ref.entityKey);
      }
    }

    for (const workItem of discardedWork) {
      for (const ref of workItem.entityRefs) {
        if (skippedEntityKeys.has(ref.entityKey)) continue;
        skippedEntityKeys.add(ref.entityKey);

        entities.push({
          ...ref,
          payload: getPayloadForEntityRef({
            operationName: workItem.operation,
            input: workItem.input,
            entityKey: ref.entityKey,
          }),
        });
      }
    }

    if (entities.length === 0) return;

    storeAdapter.revalidateDiscardedEntities?.(entities, resolutions.size > 0);
  }

  /**
   * Queues `resolutionsToRequeue` again, in order, and removes them.
   * `sentResolutionId` is the resolution whose attempts were exhausted: the
   * server may have applied it. `minQueueOrder` queues them after the work
   * of another store they must follow.
   */
  async function requeueResolutions(
    current: ActiveSessionState,
    resolutionsToRequeue: PersistedOfflineResolutionRecord[],
    sentResolutionId: string | undefined,
    minQueueOrder?: number,
  ): Promise<void> {
    // A resolution is only removed once its entry is saved: until then, a
    // decision or a release made at the same time (e.g. a "retry all" action
    // deciding the two creations some work waits for) still finds it, and
    // must not queue it a second time.
    const unclaimedResolutions = resolutionsToRequeue.filter(
      (resolution) => !requeuingResolutionIds.has(resolution.id),
    );
    if (unclaimedResolutions.length === 0) return;

    for (const resolution of unclaimedResolutions) {
      requeuingResolutionIds.add(resolution.id);
    }
    try {
      await requeueClaimedResolutions(
        current,
        unclaimedResolutions,
        sentResolutionId,
        minQueueOrder,
      );
    } finally {
      for (const resolution of unclaimedResolutions) {
        requeuingResolutionIds.delete(resolution.id);
      }
    }
  }

  async function requeueClaimedResolutions(
    current: ActiveSessionState,
    resolutionsToRequeue: PersistedOfflineResolutionRecord[],
    sentResolutionId: string | undefined,
    minQueueOrder?: number,
  ): Promise<void> {
    const { queueOrders, nextQueueOrderValue } = previewQueueOrders(
      resolutionsToRequeue.length,
      minQueueOrder,
    );
    nextQueueOrder = nextQueueOrderValue;

    const nextEntries = resolutionsToRequeue.map((resolution, index) => {
      const queueOrder = queueOrders[index];
      if (queueOrder === undefined) {
        throw new Error('Missing queue order for replay resolution requeue');
      }

      const entry = operations[resolution.operation]
        ? buildFreshQueueEntry({
            current,
            operation: resolution.operation,
            input: resolution.input,
            entityRefs: resolution.entityRefs,
            queueOrder,
            attachedUploadIds: resolution.attachedUploadIds,
            dependencyUploadIds: resolution.dependencyUploadIds,
            tempIds: resolution.tempIds,
          })
        : null;

      // The resolution being retried exhausted its attempts, so the server
      // may have applied it: its entry must not look "never sent", or it
      // could be dropped or merged locally (see `isUnsentQueueEntry`). Work
      // blocked behind a dependency was never sent.
      if (
        entry &&
        resolution.id === sentResolutionId &&
        !isBlockedDependencyResolution(resolution)
      ) {
        entry.attempts = 1;
      }

      return { resolution, entry };
    });
    // Queued before the resolutions are removed, for the other tabs (see
    // `persistManualResolutionChain`). This also keeps the attached files
    // referenced the whole time, so cleanup never sees them unused.
    for (const nextEntry of nextEntries) {
      if (!nextEntry.entry) continue;
      await persistEntry(nextEntry.entry, current, true);
    }

    for (const resolution of resolutionsToRequeue) {
      await removeResolution(resolution.id, current, true);
    }

    storeAdapter.captureQueuedMutationOverlays?.({
      sessionKey: current.sessionKey,
      entityRefs: nextEntries.flatMap((nextEntry) => {
        return nextEntry.entry?.entityRefs ?? [];
      }),
    });

    refreshDerivedState(current);
    // Resolutions of operations the app no longer registers were dropped
    // instead of requeued.
    await deleteOrphanedDependencyUploads(
      current,
      nextEntries.flatMap((nextEntry) =>
        nextEntry.entry ? [] : [nextEntry.resolution],
      ),
    );
    await ensureReplayScheduled();
  }

  /**
   * Removes from `descendants` the ones that also wait for a creation still
   * held in a resolution outside them (other than `decidedResolutionId`),
   * directly or behind one such descendant: they cannot be sent yet and go
   * with the decision about that creation.
   */
  function dropDescendantsHeldElsewhere(
    descendants: Map<string, PersistedOfflineResolutionRecord>,
    dependencySnapshot: ResolutionDependencySnapshot,
    decidedResolutionId: string | undefined,
  ): void {
    let removedHeldDescendant = true;
    while (removedHeldDescendant) {
      removedHeldDescendant = false;
      for (const resolution of descendants.values()) {
        const blockers =
          dependencySnapshot.blockedByResolutionIdsByResolutionId.get(
            resolution.id,
          ) ?? [];
        if (
          blockers.some(
            (blockerId) =>
              blockerId !== decidedResolutionId && !descendants.has(blockerId),
          )
        ) {
          descendants.delete(resolution.id);
          removedHeldDescendant = true;
        }
      }
    }
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

    for (const entityKey of getCreatedEntityKeys(args.resolution)) {
      const descendants = collectTempCreateDescendants({
        parentEntityKey: entityKey,
        parentResolutionId: args.resolution.id,
      });

      for (const resolution of descendants.resolutions) {
        if (resolution.kind !== 'retry-exhausted') continue;
        descendantResolutions.set(resolution.id, resolution);
      }
    }

    dropDescendantsHeldElsewhere(
      descendantResolutions,
      dependencySnapshot,
      args.resolution.id,
    );

    const orderedDescendants: PersistedOfflineResolutionRecord[] = [];
    const remainingDescendants = [...descendantResolutions.values()].sort(
      compareResolutionRecords,
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
    const operationName: string = args.operation;
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
      dependencyUploadIds: getDependencyUploadIds({
        operationName,
        input: validatedInput,
      }),
      upload: args.upload,
      attachedUploadIds: args.attachedUploadIds,
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
    /** A resolution this mutation replaces, removed once it is queued */
    replacedResolutionId: string | undefined;
  }): Promise<PlannedQueuedMutation> {
    const {
      current,
      preparedMutation: {
        operation,
        operationName,
        validatedInput,
        dependencyUploadIds,
        upload,
        attachedUploadIds,
        tempIds: preparedTempIds,
        entityRefs: preparedEntityRefs,
        mayHaveBeenApplied,
      },
      queueOrder,
      workingQueue,
      replacedResolutionId,
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
    if (
      operation.accumulation &&
      (upload !== undefined || attachedUploadIds !== undefined)
    ) {
      throw new Error(
        `Offline operation "${operationName}" cannot configure direct uploads together with accumulation`,
      );
    }

    const rawEntityRefs = getOperationRawEntityRefs(
      operation,
      operationName,
      validatedInput,
    );
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
        resolutionEntries: replacedResolutionId
          ? [...resolutions.values()].filter(
              (resolution) => resolution.id !== replacedResolutionId,
            )
          : resolutions.values(),
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
              addToQueries:
                typeof tempEntity.addToQueries === 'function'
                  ? tempEntity.addToQueries(validatedInput, tempIds[0])
                  : tempEntity.addToQueries,
              loadedFields: tempEntity.loadedFields,
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
                  addToQueries: entry.addToQueries,
                  loadedFields: entry.loadedFields,
                })),
            })
          : [];

    if (operation.accumulation && (!tempIds || tempIds.length === 0)) {
      const normalizedEntityRefs = normalizeEntityRefs(entityRefs);
      // Held work is newer than the queued work of the entity it was not
      // merged into, so the incoming mutation merges into it.
      const heldResolution = findHeldWorkResolutions(
        (resolution) =>
          resolution.operation === operationName &&
          (resolution.tempIds?.length ?? 0) === 0 &&
          normalizeEntityRefs(resolution.entityRefs) === normalizedEntityRefs,
        replacedResolutionId,
      ).at(-1);
      const candidateEntry = heldResolution
        ? undefined
        : findAccumulationCandidate({
            operationName,
            entityRefs,
            queueOrder,
            entries: workingQueue.values(),
          });
      // Merged, the input is replayed at the candidate's place. A mutation
      // called between the candidate and this one but not queued yet (checking
      // the connection, or sent as a direct request that can fall back to the
      // queue) would then be replayed after it, out of call order, so this
      // mutation keeps its own entry instead.
      const existingEntry =
        candidateEntry &&
        !hasReservedMutationBetween(
          current.sessionKey,
          getQueueOrder(candidateEntry),
          queueOrder,
          entityRefs,
        )
          ? candidateEntry
          : undefined;
      const existingWork = heldResolution ?? existingEntry;
      const mergeContext = existingWork && {
        sessionKey: current.sessionKey,
        existingInput: existingWork.input,
        incomingInput: validatedInput,
      };

      // A refused merge queues the incoming mutation as a separate entry
      // after the existing work. Refused against held work, it is sent first
      // unless it is held behind the same creation, like a mutation of an
      // operation without `accumulation`.
      if (
        mergeContext &&
        operation.accumulation.canMerge?.(mergeContext) !== false
      ) {
        const mergedInput =
          await operation.accumulation.mergeInput(mergeContext);
        const validatedMergedInput = validateWithSchema(
          operation.inputSchema,
          mergedInput,
        );

        if (validatedMergedInput === null) {
          throw new Error(
            `Invalid accumulated offline operation input for "${operationName}"`,
          );
        }

        // The merged input can reference uploads neither entry declared on
        // its own (e.g. files added by the incoming edit).
        const mergedDependencyUploadIds = getDependencyUploadIds({
          operationName,
          input: validatedMergedInput,
        });
        const dependencyUploadIdsOfMerge =
          mergedDependencyUploadIds.length > 0
            ? mergedDependencyUploadIds
            : undefined;

        if (heldResolution) {
          const nextResolution: PersistedOfflineResolutionRecord = {
            ...heldResolution,
            input: validatedMergedInput,
            dependencyUploadIds: dependencyUploadIdsOfMerge,
            updatedAt: now,
          };

          if (isHeldBehindTempCreateResolution(nextResolution)) {
            return {
              operationName,
              validatedInput,
              tempIds,
              pendingEntities,
              removedEntries: [],
              replacedResolution: nextResolution,
              accumulatedResolution: heldResolution,
            };
          }

          // The incoming mutation removed what held the work (e.g. moved the
          // task back under a task the server has): the merged work is queued.
          const nextEntry = buildFreshQueueEntry({
            current,
            operation: operationName,
            input: validatedMergedInput,
            queueOrder,
            entityRefs: heldResolution.entityRefs,
            dependencyUploadIds: dependencyUploadIdsOfMerge,
          });
          workingQueue.set(nextEntry.id, nextEntry);

          return {
            operationName,
            validatedInput,
            tempIds,
            pendingEntities,
            nextEntry,
            removedEntries: [],
            removedResolutions: [heldResolution],
            accumulatedResolution: heldResolution,
          };
        }

        if (existingEntry) {
          const nextEntry = {
            ...existingEntry,
            input: validatedMergedInput,
            dependencyUploadIds: dependencyUploadIdsOfMerge,
            updatedAt: now,
          };

          // Merged work held behind a temp creation would leave the existing
          // entry queued with its old input, and replay that input again
          // after the later edits once the creation is retried: only the
          // incoming mutation is held, in a fresh entry.
          if (!isHeldBehindTempCreateResolution(nextEntry)) {
            workingQueue.set(nextEntry.id, nextEntry);

            return {
              operationName,
              validatedInput,
              tempIds,
              pendingEntities,
              nextEntry,
              removedEntries: [existingEntry],
              accumulatedEntry: existingEntry,
            };
          }
        }
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
    const supersedes = operation.supersedes;
    const supersededResolutions = supersedes
      ? findHeldWorkResolutions(
          (resolution) =>
            resolution.entityRefs.length === 1 &&
            isSameEntityRef(resolution.entityRefs[0], entityRefs[0]) &&
            matchesSupersededOperation({
              candidateOperationName: resolution.operation,
              operationName,
              supersedes,
            }),
          replacedResolutionId,
        )
      : [];

    for (const entry of supersededEntries) {
      workingQueue.delete(entry.id);
    }

    // A creation never sent, of a temp entity or of an item with an id the
    // app generated, is cancelled with everything that depends on it.
    const cancelledTempCreates = supersedes?.dropSelfIfTempLifecycleCancelled
      ? [...supersededEntries, ...supersededResolutions].filter(
          (workItem) =>
            (workItem.tempIds?.length ?? 0) > 0 ||
            getClientIdCreatedEntityKeys(workItem).length > 0,
        )
      : [];

    if (cancelledTempCreates.length > 0) {
      return {
        operationName,
        validatedInput,
        tempIds,
        pendingEntities,
        removedEntries: supersededEntries,
        removedResolutions: supersededResolutions,
        cancelledTempCreates,
      };
    }

    const nextEntry = buildFreshQueueEntry({
      current,
      operation: operationName,
      input: validatedInput,
      queueOrder,
      entityRefs,
      attachedUploads: upload,
      attachedUploadIds,
      dependencyUploadIds:
        dependencyUploadIds.length > 0 ? dependencyUploadIds : undefined,
      tempIds,
    });
    // The server may have created the item in an earlier request: a delete
    // must not cancel the creation locally, since the item has the id the
    // delete targets. A temp entity has no such id, so this only applies to
    // an id the app generated.
    if (
      mayHaveBeenApplied &&
      getClientIdCreatedEntityKeys(nextEntry).length > 0
    ) {
      nextEntry.attempts = 1;
    }
    workingQueue.set(nextEntry.id, nextEntry);

    return {
      operationName,
      validatedInput,
      tempIds,
      pendingEntities,
      nextEntry,
      removedEntries: supersededEntries,
      removedResolutions: supersededResolutions,
    };
  }

  /**
   * Resolves with whether the work the mutation was queued in is only held in
   * memory, because writing it to storage failed.
   */
  async function queuePreparedMutations(
    preparedMutation: PreparedQueuedMutation,
    replacedResolutionId?: string,
  ): Promise<boolean> {
    const current = ensureActiveSession();
    if (!current || current.sessionKey !== preparedMutation.currentSessionKey) {
      throw new OfflineSessionUnavailableError();
    }

    const reservedQueueOrder = preparedMutation.queueOrder;
    const { queueOrders, nextQueueOrderValue } =
      reservedQueueOrder === undefined
        ? previewQueueOrders(1)
        : { queueOrders: [reservedQueueOrder], nextQueueOrderValue: null };
    const queueOrder = queueOrders[0];
    if (queueOrder === undefined) {
      throw new Error('Missing queue order for prepared offline mutation');
    }
    // Reserved right away: a mutation made while this one is planned is
    // queued after it, in the order the user made them. A reserved order was
    // already taken when the mutation was called.
    if (nextQueueOrderValue !== null) nextQueueOrder = nextQueueOrderValue;
    let plannedMutation: PlannedQueuedMutation;
    let pendingEntityQueriesLoaded = false;
    for (;;) {
      plannedMutation = await planPreparedMutation({
        current,
        preparedMutation,
        queueOrder,
        workingQueue: new Map(queueEntries),
        replacedResolutionId,
      });
      // The queue may change while the lists of the pending entities are
      // loaded, so the mutation is planned again after it.
      if (!pendingEntityQueriesLoaded) {
        pendingEntityQueriesLoaded = true;
        const loading = loadPendingEntityQueries(
          plannedMutation.pendingEntities,
        );
        if (loading) {
          await loading;
          continue;
        }
      }
      // An async accumulation merge lets the replay pick up or send the entry
      // being merged into before it is committed. Merging into it then would
      // drop the incoming input or send the existing one twice, so the
      // mutation is planned again. The same applies to held work merged into
      // when it changes meanwhile, and to an entry that is no longer the
      // newest candidate (e.g. an earlier concurrent mutation whose merge was
      // refused queued a newer one, which merging into the older entry would
      // send after it). The check runs with no `await` before the commit
      // below.
      if (
        (!plannedMutation.accumulatedEntry ||
          findAccumulationCandidate({
            operationName: plannedMutation.operationName,
            entityRefs: plannedMutation.accumulatedEntry.entityRefs,
            queueOrder,
          }) === plannedMutation.accumulatedEntry) &&
        (!plannedMutation.accumulatedResolution ||
          resolutions.get(plannedMutation.accumulatedResolution.id) ===
            plannedMutation.accumulatedResolution)
      ) {
        break;
      }
    }

    // Work for a temp entity whose creation already waits for a manual
    // resolution joins the descendants that were blocked when the creation
    // failed, instead of the queue: it is retried or discarded with it.
    const blockedResolution =
      plannedMutation.nextEntry &&
      isHeldBehindTempCreateResolution(plannedMutation.nextEntry)
        ? buildRetryExhaustedResolutionRecord(
            current,
            plannedMutation.nextEntry,
            { message: BLOCKED_DEPENDENCY_RESOLUTION_MESSAGE },
          )
        : undefined;

    const persistedMutations: AppliedQueuedMutation[] = [];
    const persistedUploadIds: string[] = [];
    const appliedPendingMutations: Array<{
      operationName: string;
      validatedInput: unknown;
      pendingEntities: PendingTempEntity[];
    }> = [];

    try {
      const appliedMutation: AppliedQueuedMutation = {
        ...plannedMutation,
        removedEntriesApplied: [],
        removedResolutionsApplied: [],
        touchedNextEntry: false,
        touchedReplacedResolution: false,
      };
      persistedMutations.push(appliedMutation);

      if (preparedMutation.upload && plannedMutation.nextEntry) {
        const uploadPayload = preparedMutation.upload;
        const uploadEntries = Object.entries(
          plannedMutation.nextEntry.attachedUploadIds ?? {},
        );
        await Promise.all(
          uploadEntries.map(([uploadId, storedUploadId]) => {
            const file = uploadPayload[uploadId];
            if (!file) {
              throw new Error(
                `Missing direct upload payload "${uploadId}" for queued mutation`,
              );
            }
            persistedUploadIds.push(storedUploadId);
            return current.session.saveUpload({
              id: storedUploadId,
              file,
              source: 'mutation',
              storeName,
            });
          }),
        );
      }

      for (const removedEntry of plannedMutation.removedEntries) {
        if (plannedMutation.nextEntry?.id === removedEntry.id) {
          continue;
        }

        appliedMutation.removedEntriesApplied.push(removedEntry);
        await removeEntry(removedEntry.id, current, true);
      }

      if (plannedMutation.nextEntry) {
        appliedMutation.touchedNextEntry = true;
        if (blockedResolution) {
          await persistResolution(blockedResolution, current, true);
        } else {
          await persistEntry(plannedMutation.nextEntry, current, true);
        }
      }

      if (plannedMutation.replacedResolution) {
        appliedMutation.touchedReplacedResolution = true;
        await persistResolution(
          plannedMutation.replacedResolution,
          current,
          true,
        );
      }

      // Removed after the merged work is queued, for the other tabs (see
      // `persistManualResolutionChain`).
      for (const removedResolution of plannedMutation.removedResolutions ??
        []) {
        appliedMutation.removedResolutionsApplied.push(removedResolution);
        await removeResolution(removedResolution.id, current, true);
      }

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
            addToQueries: pendingEntity.addToQueries,
            loadedFields: pendingEntity.loadedFields,
          });
        }

        appliedPendingMutations.push({
          operationName: plannedMutation.operationName,
          validatedInput: plannedMutation.validatedInput,
          pendingEntities: plannedMutation.pendingEntities,
        });
      }

      // Held work merged into keeps showing the merged change too.
      const queuedWork =
        plannedMutation.nextEntry ?? plannedMutation.replacedResolution;
      if (queuedWork) {
        storeAdapter.captureQueuedMutationOverlays?.({
          sessionKey: current.sessionKey,
          entityRefs: queuedWork.entityRefs,
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

      for (const uploadId of persistedUploadIds.reverse()) {
        try {
          await current.session.deleteUpload(uploadId);
        } catch {
          // Best-effort cleanup; the original error takes priority.
        }
      }

      for (const mutation of persistedMutations.reverse()) {
        const nextEntryReplacesRemovedEntry =
          mutation.nextEntry !== undefined &&
          mutation.removedEntries.some(
            (removedEntry) => removedEntry.id === mutation.nextEntry?.id,
          );

        if (mutation.touchedNextEntry && mutation.nextEntry) {
          if (blockedResolution) {
            await removeResolution(blockedResolution.id, current, true);
          } else if (!nextEntryReplacesRemovedEntry) {
            await removeEntry(mutation.nextEntry.id, current, true);
          }
        }

        for (const removedEntry of nextEntryReplacesRemovedEntry
          ? [...mutation.removedEntries].reverse()
          : [...mutation.removedEntriesApplied].reverse()) {
          await persistEntry(removedEntry, current, true);
        }

        if (
          mutation.touchedReplacedResolution &&
          mutation.accumulatedResolution
        ) {
          await persistResolution(
            mutation.accumulatedResolution,
            current,
            true,
          );
        }
        for (const removedResolution of [
          ...mutation.removedResolutionsApplied,
        ].reverse()) {
          await persistResolution(removedResolution, current, true);
        }
      }

      refreshDerivedState(current);

      throw error;
    }

    const { cancelledTempCreates } = plannedMutation;
    let supersededWork: (
      | OfflineQueueEntry
      | PersistedOfflineResolutionRecord
    )[] = [
      ...plannedMutation.removedEntries,
      ...(plannedMutation.removedResolutions ?? []),
    ];
    // The held work merged into may no longer need some of its uploads.
    if (
      plannedMutation.replacedResolution &&
      plannedMutation.accumulatedResolution
    ) {
      supersededWork.push(plannedMutation.accumulatedResolution);
    }
    if (cancelledTempCreates) {
      // Also deletes the uploads the cancelled creations depended on.
      await discardTempLifecycles(current, cancelledTempCreates);
      supersededWork = supersededWork.filter(
        (workItem) => !cancelledTempCreates.includes(workItem),
      );
    } else {
      refreshDerivedState(current);
    }
    // Superseded or cancelled work will never replay, so the uploads only it
    // depended on have no consumer left.
    if (supersededWork.length > 0) {
      await deleteOrphanedDependencyUploads(current, supersededWork);
    }
    await ensureReplayScheduled();

    const { nextEntry, replacedResolution } = plannedMutation;
    return (
      (nextEntry !== undefined &&
        inMemoryOnlyRecordKeys.has(
          blockedResolution ? `r:${blockedResolution.id}` : `q:${nextEntry.id}`,
        )) ||
      (replacedResolution !== undefined &&
        inMemoryOnlyRecordKeys.has(`r:${replacedResolution.id}`))
    );
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
    const replaySession = current;
    void replayQueue.resultifyAdd(async () => {
      try {
        await acquireReplayLock(replaySession);
        try {
          await drainReplay(replaySession);
        } finally {
          if (replaySession.session.hasOtherTabs()) {
            // Keep the lock while the other tabs catch up with what this tab
            // just replayed, so none of them can send the same entries again.
            replayLockReleaseTimer = setTimeout(
              releaseHeldReplayLock,
              REPLAY_HANDOFF_SETTLE_MS,
            );
          } else {
            releaseHeldReplayLock();
          }
        }
      } finally {
        replayScheduled = false;

        const nextEntry = getSortedEntries()[0];
        if (nextEntry?.syncState === 'needs-confirmation') {
          scheduleReplayRetry();
        }
        // The session changed while this drain was running or waiting
        if (!isActiveSessionState(replaySession)) void ensureReplayScheduled();
      }
    });
  }

  /**
   * Leadership is decided from tab presence messages, so for a moment two tabs
   * can both consider themselves the leader (e.g. while it moves to the tab
   * that just got focus). This cross-tab lock makes sure only one of them
   * replays this store's queue at a time.
   */
  async function acquireReplayLock(current: ActiveSessionState): Promise<void> {
    const lockManager = getNavigatorLockManager();
    if (lockManager === null) {
      if (current.session.hasOtherTabs()) {
        warnIfNavigatorLockUnavailable(REPLAY_LOCK_UNAVAILABLE_WARNING);
      }
      return;
    }

    if (replayLockReleaseTimer !== null) {
      clearTimeout(replayLockReleaseTimer);
      replayLockReleaseTimer = null;
    }

    const lockName = `tsdf:offline-replay:${current.sessionKey}:${storeName}`;
    if (heldReplayLockName === lockName) return;
    releaseHeldReplayLock();

    if (await requestReplayLock(lockManager, lockName, true)) return;

    // Another tab is replaying this queue or just did. Once it lets go, wait
    // for the queue changes it announced to arrive, so this tab does not send
    // what that tab already sent.
    await requestReplayLock(lockManager, lockName, false);
    await new Promise((resolve) => {
      setTimeout(resolve, REPLAY_HANDOFF_SETTLE_MS);
    });
  }

  /**
   * Resolves `true` once this tab holds the lock (until
   * `releaseHeldReplayLock`), or `false` when `ifAvailable` is set and another
   * tab holds it.
   */
  function requestReplayLock(
    lockManager: LockManager,
    lockName: string,
    ifAvailable: boolean,
  ): Promise<boolean> {
    return new Promise((onSettled) => {
      lockManager
        .request(lockName, { ifAvailable }, (lock) => {
          if (lock === null) {
            onSettled(false);
            return undefined;
          }

          return new Promise<void>((release) => {
            heldReplayLockName = lockName;
            releaseReplayLock = release;
            onSettled(true);
          });
        })
        // Replaying without the lock is better than never replaying
        .catch(() => {
          onSettled(true);
        });
    });
  }

  function releaseHeldReplayLock(): void {
    if (replayLockReleaseTimer !== null) {
      clearTimeout(replayLockReleaseTimer);
      replayLockReleaseTimer = null;
    }
    releaseReplayLock?.();
    releaseReplayLock = null;
    heldReplayLockName = null;
  }

  async function drainReplay(replaySession: ActiveSessionState): Promise<void> {
    while (true) {
      const current = ensureActiveSession();
      if (!current) return;
      // The lock held by this drain belongs to the session it started with
      if (current.sessionKey !== replaySession.sessionKey) return;
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
      // Entries of operations this deploy doesn't define are never loaded
      // into the queue, and must not be deleted if one ever gets here
      if (!operation) return;

      // Queued before the creation of an entity of another store it belongs
      // to failed: it waits for the decision about that creation, with the
      // work queued on top of it.
      if (
        operation.cancelledWith &&
        getExternalCreationResolutionIds(nextEntry).length > 0
      ) {
        const heldResolution = buildRetryExhaustedResolutionRecord(
          current,
          nextEntry,
          { message: BLOCKED_DEPENDENCY_RESOLUTION_MESSAGE },
        );
        await persistResolution(heldResolution, current, true);
        await removeEntry(nextEntry.id, current, true);
        await promoteBlockedTempCreateDescendants({
          current,
          parentEntry: nextEntry,
          parentResolutionId: heldResolution.id,
        });
        refreshDerivedState(current);
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
      // Set when the replay failed while resolving a dependency upload, which
      // means `execute` was never called for this attempt.
      let failedUploadId: string | undefined;
      let executeStarted = false;
      // The app can switch to another session (e.g. another org) without a
      // reload while the replay awaits: the work of the old session must not
      // be sent, nor judged by app callbacks, from the new one.
      const throwIfSessionChanged = (): void => {
        if (!isSessionStillActive(current)) {
          throw new OfflineSessionUnavailableError();
        }
      };

      try {
        throwIfSessionChanged();
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

        if (replayCheckCtx) throwIfSessionChanged();

        if (shouldCheckSkipBeforeRetry && operation.shouldSkipSync) {
          if (!replayCheckCtx) {
            throw new Error('Replay check context was not prepared');
          }
          const shouldSkip = await operation.shouldSkipSync(replayCheckCtx);
          throwIfSessionChanged();

          if (shouldSkip) {
            // The server already has the change: a delete is done.
            if (operation.kind === 'delete') {
              await notifyEntitiesDeleted(current, entryToUse.entityRefs);
            }
            await removeEntry(entryToUse.id, current);
            void deleteOrphanedDependencyUploads(current, [entryToUse]);
            continue;
          }
        }

        const conflict = conflictHandling
          ? await conflictHandling.detectConflict(
              replayCheckCtx ??
                ({ ...replayCheckBaseCtx, serverSnapshot: undefined } as const),
            )
          : false;
        if (conflictHandling) throwIfSessionChanged();

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

        const dependencyUploads = await current.session.resolveReplayUploadIds(
          entryToUse.dependencyUploadIds ?? [],
          () => isSessionStillActive(current),
        );
        if (dependencyUploads.failedUploadId !== undefined) {
          failedUploadId = dependencyUploads.failedUploadId;
          throw dependencyUploads.error;
        }

        // WORKAROUND: The shared replay builder returns the runtime upload-ref
        // shape, and each operation rebinds that same value to its own
        // compile-time execute-context generic at the call boundary.
        const executeContext = __LEGIT_CAST__<
          Parameters<typeof operation.execute>[0],
          Awaited<ReturnType<typeof buildOperationExecuteContext>>
        >(
          await buildOperationExecuteContext({
            current,
            entry: entryToUse,
            resolvedRefsById: dependencyUploads.refs,
          }),
        );
        throwIfSessionChanged();
        executeStarted = true;
        const result = await operation.execute(executeContext);

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

        const clientIdCreatedEntityKeys =
          getClientIdCreatedEntityKeys(entryToUse);
        if (clientIdCreatedEntityKeys.length > 0) {
          storeAdapter.confirmClientIdCreations?.(clientIdCreatedEntityKeys);
        }

        const successfulExecuteSync = runSuccessfulExecuteSync({
          operation,
          entry: entryToUse,
          result,
        });
        if (isPromise(successfulExecuteSync)) {
          await successfulExecuteSync;
        }
        // Before the replay head moves past the delete, so that the other
        // stores drop their work for the deleted entities before sending it.
        if (operation.kind === 'delete') {
          await notifyEntitiesDeleted(current, entryToUse.entityRefs);
        }

        refreshDerivedState(current);
        // The replayed entry consumed its uploads. Not awaited, so removing
        // the files does not hold back the next queued entry.
        void deleteOrphanedDependencyUploads(current, [entryToUse]);
      } catch (error) {
        // The session changed before the entry was sent: whatever failed
        // (the check above, or an upload sent before the switch) says nothing
        // about the entry, so it stays queued for its session as it was, to
        // be replayed once that session is active again.
        if (!executeStarted && !isSessionStillActive(current)) {
          await persistEntry(nextEntry, current, true);
          return;
        }

        const lastError = { message: unknownToError(error).message };
        const failureCtx: OfflineStoreFailureContext = {
          phase: 'sync',
          storeType,
          operationName: entryToUse.operation,
          sessionKey: current.sessionKey,
        };
        if (failedUploadId !== undefined) failureCtx.uploadId = failedUploadId;

        const classification = await current.session.classifyFailure(
          error,
          failureCtx,
        );
        // A session gate closed while the entry was in flight leaves the
        // failure unclassified: the entry stays queued as it was, to be
        // replayed once the gate reopens
        const sessionEnabled = isSessionEnabled();
        const allowReplayRetry =
          sessionEnabled &&
          classification === 'ignore' &&
          !current.session.getStatus().isOfflineMode
            ? await current.session.classifyRetriableFailure(error, failureCtx)
            : false;

        if (
          !sessionEnabled ||
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

        const retriesExhausted =
          allowReplayRetry && nextFailures >= replayRetryMaxFailures;
        // `execute` never ran when a dependency upload failed, so there is
        // nothing to confirm with the server: a failure that is not retried
        // automatically skips `needs-confirmation` and goes straight to manual
        // resolution. A retried one still waits in `needs-confirmation`, which
        // drives the retry schedule, so the next attempt runs the skip and
        // conflict checks before uploading again.
        const uploadWillNotBeRetried =
          failedUploadId !== undefined && !allowReplayRetry;

        if (retriesExhausted || uploadWillNotBeRetried) {
          await persistManualResolutionChain({
            current,
            parentEntry: entryToUse,
            parentResolution: buildRetryExhaustedResolutionRecord(
              current,
              entryToUse,
              lastError,
            ),
          });
          // The entry left the queue (with its dependents), so the entries
          // behind it are not waiting on it anymore: keep draining.
          continue;
        }

        await persistEntry(entryToUse, current);
        return;
      }
    }
  }

  async function queueMutation<TName extends keyof TOperations & string>(args: {
    offline: OfflineMutationInput<TOperations, TName>;
    upload?: OfflineMutationUploadsInput;
  }): Promise<void> {
    await hydrateIfNeeded();
    const current = ensureActiveSession();
    if (!current) {
      throw new OfflineSessionUnavailableError();
    }

    await queuePreparedMutations(
      prepareMutationWithSession(current, {
        operation: args.offline.operation,
        input: args.offline.input,
        upload: args.upload,
      }),
    );
  }

  async function prepareForMutation<
    TName extends keyof TOperations & string,
  >(args: {
    offline: OfflineMutationInput<TOperations, TName>;
    upload?: OfflineMutationUploadsInput;
  }): Promise<PreparedOfflineMutation> {
    await hydrateIfNeeded();
    const current = ensureActiveSession();
    if (!current) {
      throw new OfflineSessionUnavailableError();
    }

    const { nextQueueOrderValue } = previewQueueOrders(1);
    const reservedQueueOrder = nextQueueOrderValue - 1;
    const prepared: PreparedQueuedMutation = {
      ...prepareMutationWithSession(current, {
        operation: args.offline.operation,
        input: args.offline.input,
        upload: args.upload,
      }),
      // Reserved now: if the direct request falls back to the queue, it keeps
      // the place it had when called, before the mutations queued meanwhile.
      queueOrder: reservedQueueOrder,
    };
    nextQueueOrder = nextQueueOrderValue;
    // Before the connection check, which can settle after the one of a newer
    // mutation of the same entities
    reservedMutations.set(reservedQueueOrder, prepared);
    try {
      await current.session.refreshNetworkState();
    } catch (error) {
      reservedMutations.delete(reservedQueueOrder);
      throw error;
    }

    const { dependencyUploadIds } = prepared;
    const initialAction = getInitialOfflineMutationAction(current, prepared);

    return {
      initialAction,
      releaseQueueOrder: () => {
        reservedMutations.delete(reservedQueueOrder);
      },
      queueMutation: (afterDirectAttempt) =>
        queuePreparedMutations(
          afterDirectAttempt
            ? { ...prepared, mayHaveBeenApplied: true }
            : prepared,
        ),
      // Resolved like on replay: a failed upload stays `pending` until the
      // failure is classified, since it is retried if the mutation is queued.
      resolveDirectUploads:
        dependencyUploadIds.length > 0
          ? async () => {
              const resolution = await current.session.resolveReplayUploadIds(
                dependencyUploadIds,
                () => isSessionStillActive(current),
              );
              // The app switched to another session while the uploads were
              // sent: the request is not sent from the new session. Thrown
              // here, the run fails with this error (`classifyError` rejects
              // for a session that is no longer active), nothing is queued
              // and the uploads stay staged in their session.
              if (!isSessionStillActive(current)) {
                throw new OfflineSessionUnavailableError();
              }
              return resolution;
            }
          : null,
      // Like replay: the uploads that did not fail are left untouched.
      markUploadsFailed: () =>
        current.session.markUploadsFailed(dependencyUploadIds),
      handleDirectSuccess: async () => {
        // Before the offline status is cleared, which resumes the replay, so
        // that the other stores drop their work for the deleted entities
        // before sending it.
        if (prepared.operation.kind === 'delete') {
          const successCurrent = ensureActiveSession();
          if (successCurrent?.sessionKey === prepared.currentSessionKey) {
            await notifyEntitiesDeleted(
              successCurrent,
              getPreparedEntityRefs(prepared),
            );
          }
        }
        // The request consumed its uploads, as a replayed entry does. Not
        // awaited, so removing the files does not delay the result.
        if (dependencyUploadIds.length > 0) {
          void deleteOrphanedDependencyUploads(current, [
            { dependencyUploadIds },
          ]);
        }
        await clearOfflineStatusOnSuccess(prepared.currentSessionKey);
      },
      classifyError: async (error, uploadId) => {
        const preparedCurrent = ensureActiveSession();
        if (
          !preparedCurrent ||
          preparedCurrent.sessionKey !== prepared.currentSessionKey
        ) {
          throw new OfflineSessionUnavailableError();
        }

        const failureCtx: OfflineStoreFailureContext = {
          phase: 'mutation',
          storeType,
          operationName: prepared.operationName,
          sessionKey: preparedCurrent.sessionKey,
        };
        if (uploadId !== undefined) failureCtx.uploadId = uploadId;
        const activeCause =
          await preparedCurrent.session.classifyRequestFailure(
            error,
            failureCtx,
          );

        return activeCause ? isMutationQueueingAllowed(activeCause) : false;
      },
    };
  }

  async function runUnqueuedMutation<
    T,
    TName extends keyof TOperations & string,
  >(
    offline: OfflineMutationInput<TOperations, TName>,
    directMutation: (ctx: OfflineDirectMutationContext) => Promise<T>,
  ): Promise<T> {
    const operationName: string = offline.operation;
    const current = operations[operationName]?.dependsOnUploads
      ? ensureActiveSession()
      : null;
    const dependencyUploadIds = current
      ? prepareMutationWithSession(current, {
          operation: offline.operation,
          input: offline.input,
        }).dependencyUploadIds
      : [];
    if (!current || dependencyUploadIds.length === 0) {
      return directMutation(createDirectMutationContext({}));
    }

    // Nothing is queued, so a failed upload is `failed` right away, as with
    // `resolveOfflineUploads`.
    let resolvedRefsById: Record<string, ValidPayload>;
    try {
      resolvedRefsById = await current.session.resolveUploadIds(
        dependencyUploadIds,
        () => isSessionStillActive(current),
      );
    } catch (error) {
      if (!isSessionStillActive(current)) {
        throw new OfflineSessionUnavailableError();
      }
      throw error;
    }
    // As with a direct run that can be queued: the request is not sent from
    // a session the app switched to while the uploads were sent.
    if (!isSessionStillActive(current)) {
      throw new OfflineSessionUnavailableError();
    }
    const result = await directMutation(
      createDirectMutationContext(resolvedRefsById),
    );
    void deleteOrphanedDependencyUploads(current, [{ dependencyUploadIds }]);
    return result;
  }

  function getOfflineEntities(): GlobalOfflineEntity[] {
    const current = ensureActiveSession();
    if (!current) return [];
    return current.session
      .getEntities()
      .filter((entity) => entity.storeName === storeName);
  }

  function getItemOfflineState(itemKey: string): ItemOfflineState | null {
    const current = ensureActiveSession();
    if (!current) return null;
    const sessionState = current.session.store.state;
    return toItemOfflineState(
      getOfflineStoreEntityLookup(sessionState.entities, storeName).get(
        itemKey,
      ),
      sessionState.attemptedCreationEntityIds,
    );
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

    // Looked up by the untyped name, the operation may not be registered.
    const registeredName: string = operationName;
    const operation = operations[registeredName];
    if (!operation) {
      await removeResolution(resolutionId, current);
      await deleteOrphanedDependencyUploads(current, [resolutionRecord]);
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
      const retriedWork = collectRetryResolutionChain({
        resolution: resolutionRecord,
        scope,
      });
      await requeueResolutions(current, retriedWork, resolutionRecord.id);
      // Like the held work of this store, the work other stores held behind
      // these creations is sent after them, unless only the creation is sent.
      if (scope === 'self-and-descendants') {
        await notifyCreationsReleased(current, retriedWork);
      }
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

    // The work held behind a temp creation waiting for this decision is
    // collected before the decision rewrites or replaces the creation: it is
    // queued again once the entity is created or kept, like after a retry.
    const heldDescendantIds =
      (action === 'requeue' || action === 'commit') &&
      getCreatedEntityKeys(resolutionRecord).length > 0
        ? collectRetryResolutionChain({
            resolution: resolutionRecord,
            scope: 'self-and-descendants',
          })
            .slice(1)
            .map((descendant) => descendant.id)
        : [];
    const requeueHeldDescendants = async (): Promise<void> => {
      // Read again: the decision rewrote their temp refs.
      const heldDescendants = new Map<
        string,
        PersistedOfflineResolutionRecord
      >();
      for (const id of heldDescendantIds) {
        const descendant = resolutions.get(id);
        if (descendant) heldDescendants.set(id, descendant);
      }

      // A replacement creation held behind another creation waiting for a
      // decision still holds the work on its entity.
      if (heldDescendants.size > 0) {
        dropDescendantsHeldElsewhere(
          heldDescendants,
          createResolutionDependencySnapshot(),
          undefined,
        );
      }

      // Kept in the order collected, which sends parents first.
      if (heldDescendants.size > 0) {
        await requeueResolutions(
          current,
          [...heldDescendants.values()],
          undefined,
        );
      }
      // The work other stores held behind these creations follows them.
      await notifyCreationsReleased(current, [
        resolutionRecord,
        ...heldDescendants.values(),
      ]);
    };

    if (action === 'requeue') {
      // validated before the resolution is removed, so an invalid input
      // throws without losing the change the user still has to resolve
      const preparedMutation = prepareMutationWithSession(current, {
        operation: operationName,
        input: resolutionAction?.input,
        // The replacement is sent with the files attached to the original
        // mutation, which stay stored under their ids.
        attachedUploadIds: resolutionRecord.attachedUploadIds,
        tempIds: resolutionRecord.tempIds,
        entityRefs: resolutionRecord.entityRefs,
      });
      // Queued before the resolution is removed, for the other tabs (see
      // `persistManualResolutionChain`). This also keeps the attached files
      // referenced the whole time, so cleanup never sees them unused. The
      // conflicted mutation may have reached the server in an earlier
      // attempt (the conflict can come from that), so the replacement does
      // not count as never sent.
      await queuePreparedMutations(
        { ...preparedMutation, mayHaveBeenApplied: true },
        resolutionId,
      );
      await removeResolution(resolutionId, current);
      // The replacement input declared its own dependencies: uploads it kept
      // are still referenced, the ones it dropped are not.
      await deleteOrphanedDependencyUploads(current, [resolutionRecord]);
      // A replacement that creates another item (e.g. with a new
      // client-generated id after an "id taken" conflict) does not create the
      // one the held work targets: that work is not sent on its own, it is
      // left for the user to decide.
      const replacementEntityKeys = getClientIdCreatedEntityKeys({
        operation: operationName,
        entityRefs: resolveNormalizedRefs(
          getOperationRawEntityRefs(
            operation,
            operationName,
            preparedMutation.validatedInput,
          ),
        ),
      });
      if (
        getClientIdCreatedEntityKeys(resolutionRecord).every((entityKey) =>
          replacementEntityKeys.includes(entityKey),
        )
      ) {
        await requeueHeldDescendants();
      }
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
      await deleteOrphanedDependencyUploads(current, [resolutionRecord]);
      await requeueHeldDescendants();
      return;
    }

    throw new Error('Invalid offline resolution action');
  }

  async function resolveOfflineResolutionWithGenericAction(
    resolutionId: string,
    action: OfflineResolutionGenericAction,
  ): Promise<OfflineResolutionGenericActionFailure | undefined> {
    await hydrateIfNeeded();

    const resolutionRecord = ensureActiveSession()
      ? resolutions.get(resolutionId)
      : undefined;
    if (!resolutionRecord) return 'resolution-not-found';

    // Reported before the blocked state because it never changes for a record,
    // while a blocked record becomes actionable once its parents are resolved.
    if (action === 'retry' && resolutionRecord.kind !== 'retry-exhausted') {
      return 'retry-not-supported';
    }

    if (isPersistedResolutionBlocked(resolutionRecord)) {
      return 'resolution-blocked';
    }

    await resolveOfflineResolution(resolutionId, resolutionRecord.operation, {
      action,
    });
    return undefined;
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

    if (!isSessionEnabled()) {
      // The fetch runs online: the closed gate is applied to the status too,
      // for the fetches that read this without refreshing the network state
      // first (`loadMore`)
      void current.session.refreshNetworkState();
      return false;
    }

    return shouldTreatFutureOperationsAsOffline(current);
  }

  async function handleFetchSuccess(): Promise<void> {
    const current = ensureActiveSession();
    if (!current) return;

    await clearOfflineStatusOnSuccess(current.sessionKey);
  }

  function canQueueMutation(): boolean {
    if (isDisposed || getSessionKey() === false) return false;
    if (isSessionEnabled()) return true;

    // The mutation runs online: the closed gate is applied to the status
    // too, as before a fetch, so it stops reporting offline mode
    void ensureActiveSession()?.session.refreshNetworkState();
    return false;
  }

  async function prepareForFetch(): Promise<void> {
    await hydrateIfNeeded();
    const current = ensureActiveSession();
    if (!current) return;
    await current.session.refreshNetworkState();
  }

  return {
    dispose,
    hydrateIfNeeded,
    canQueueMutation,
    prepareForMutation,
    runUnqueuedMutation,
    queueMutation,
    getOfflineEntities,
    getItemOfflineState,
    resolveEntityRef: (entityRef) => {
      // The remaps belong to the session they were recorded in: this drops
      // them when the session changed since
      ensureActiveSession();
      return resolveEntityRef(entityRef);
    },
    getOfflineResolutions,
    parseOfflineResolutionConflict: parseConflictPayloadForResolution,
    resolveOfflineResolution,
    resolveOfflineResolutionWithGenericAction,
    prepareForFetch,
    getSessionStatus,
    shouldTreatFetchAsOffline,
    handleFetchSuccess,
    evaluateOfflineFetchError,
    ensureReplayScheduled,
  };
}
