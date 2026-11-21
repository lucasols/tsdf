import { createAsyncQueue } from '@ls-stack/utils/asyncQueue';
import { deepEqual } from '@ls-stack/utils/deepEqual';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { rc_object, rc_parse } from 'runcheck';
import { unknownToError } from 't-result';
import { Store } from 't-state';
import {
  emitTSDFDebugLog,
  getTSDFDebugTimingMs,
  type TSDFDebugLogger,
} from '../../debug';
import type { BrowserTabsTabStatusMessage } from '../../utils/browserTabsPriority';
import {
  createBrowserTabsCoordinatorWithPriority,
  type BrowserTabsMessageMeta,
} from '../../utils/browserTabsSync';
import type { ValidPayload } from '../../utils/storeShared';
import { parseCompactLocalStorageEntry } from '../compactLocalStorageEntry';
import { registerOfflineUploadAdapterForSession } from '../offlineUploadRegistry';
import {
  applyRestoredUploadRef,
  createStoredUploadRecord,
  idleUploadFile,
  loadingUploadFile,
  missingUploadFile,
  parseRestoredUploadRef,
  stripStoredUploadFile,
} from '../offlineUploadsShared';
import type {
  OfflineSessionUploadsConfig,
  OfflineStoredUploadRecord,
  OfflineUpload,
  OfflineUploadFile,
  OfflineUploadProgress,
  OfflineUploadState,
} from '../offlineUploadTypes';
import {
  createPersistentStorageHandle,
  getLocalStorageAdapter,
  readProtectedStorageKeys,
  type PersistentStorageHandle,
} from '../persistentStorageManager';
import {
  getOfflineSessionStatusStorageKey,
  OFFLINE_SESSION_STATUS_STORE_NAME,
} from '../storageEntryPrefixes';
import type { StorageAdapter } from '../types';
import {
  getOfflineStoreEntityLookup,
  toItemOfflineState,
} from './entityMetadata';
import {
  clearSessionProtectedKeysSnapshot,
  setSessionProtectedKeysSnapshot,
} from './sessionProtectionRegistry';
import type {
  GlobalOfflineEntity,
  InternalGlobalOfflineEntity,
  GlobalOfflineStatus,
  ItemOfflineState,
  OfflineFailureClassification,
  OfflineFailureContext,
  OfflineHealthCheckConfig,
  OfflineHealthCheckResult,
  OfflineMutationQueueingPolicy,
  OfflineNetworkModeConfig,
  OfflineOutageModeConfig,
  OfflineQueueEntry,
  OfflineRecoveryProbeConfig,
  OfflineResolutionRecord,
  OfflineRuntimeConfig,
  OfflineRuntimeConfigUpdate,
  OfflineSession,
  OfflineSessionConfig,
  PersistedOfflineResolutionRecord,
} from './types';
import {
  COMPACT_OFFLINE_STATUS_FLAG,
  compactOfflineStatusSnapshotSchema,
  getIsOfflineModeFromStatus,
} from './types';

function stripInternalEntityPayload(
  entity: InternalGlobalOfflineEntity,
): GlobalOfflineEntity {
  if (!('payload' in entity) && !('isClientIdCreation' in entity)) {
    return entity;
  }
  const {
    payload: _payload,
    isClientIdCreation: _isClientIdCreation,
    ...publicEntity
  } = entity;
  return publicEntity;
}

type SessionSnapshotMessage = BrowserTabsMessageMeta & {
  kind: 'offline-session-snapshot';
  status: GlobalOfflineStatus;
  /**
   * The stores attached in the sending tab. `entities` and `resolutions` only
   * cover these stores: a tab never echoes what it learned from other tabs,
   * which may be outdated by the time it is sent again.
   */
  storeNames: string[];
  entities: InternalGlobalOfflineEntity[];
  /** Missing in snapshots sent by tabs running an older version. */
  attemptedCreationEntityIds?: string[];
  resolutions: OfflineResolutionRecord[];
  uploads: OfflineUpload[];
  /** The stores of `storeNames` that still have mutations in their queue. */
  queuedStoreNames: string[];
  /**
   * Present only on the snapshot published by the tab where forced offline
   * mode was toggled. Every other tab applies it, while the
   * `status.isForcedOffline` of regular snapshots is ignored: a stale snapshot
   * from a tab that has not seen the toggle yet cannot undo it.
   */
  forcedOffline?: boolean;
};

/**
 * A tab saved (`entry`) or removed (`null`) a queue entry of a store. Every
 * tab keeps its own in-memory copy of the queue, so the others apply the same
 * change: the leader replays entries queued by any tab, and no tab keeps an
 * entry that was already replayed.
 *
 * The record travels in the message because another tab's storage write is not
 * visible right away: each tab's process has its own copy of `localStorage`,
 * updated asynchronously, so re-reading storage could return the old record.
 */
type SessionQueueEntryMessage = BrowserTabsMessageMeta & {
  kind: 'offline-queue-entry';
  storeName: string;
  entryId: string;
  entry: OfflineQueueEntry | null;
};

/** Same as {@link SessionQueueEntryMessage}, for a resolution record. */
type SessionResolutionMessage = BrowserTabsMessageMeta & {
  kind: 'offline-resolution';
  storeName: string;
  resolutionId: string;
  resolution: PersistedOfflineResolutionRecord | null;
};

/**
 * A tab replayed the creation of a temp entity and the server assigned its
 * final payload. Sent before the replacement, so the other tabs replace the
 * temp item themselves (in their own lists too) before the store's tab sync
 * tells them it was deleted, map the temp payload to the final one, and emit
 * `tempEntityReconciled`, wherever the creation was queued.
 */
type SessionTempReconciledMessage = BrowserTabsMessageMeta & {
  kind: 'offline-temp-reconciled';
  storeName: string;
  tempId: ValidPayload;
  finalPayload: ValidPayload;
  /**
   * The saved item data, when the operation's reconciliation provides it.
   * Missing in messages sent by tabs running an older version.
   */
  finalData?: unknown;
};

/** Queued work the user discarded: what its refetch needs. */
type DiscardedOfflineWork = Pick<
  OfflineQueueEntry,
  'operation' | 'input' | 'entityRefs'
>;

/**
 * A tab discarded queued work of a store. Its optimistic changes cannot be
 * rolled back locally, so every tab with the store refetches the entities it
 * referenced, like the tab that discarded it. Sent after the removals of the
 * discarded records.
 */
type SessionWorkDiscardedMessage = BrowserTabsMessageMeta & {
  kind: 'offline-work-discarded';
  storeName: string;
  discardedWork: DiscardedOfflineWork[];
  /**
   * Entities the discard removed (temp entities and items of discarded
   * creations): there is nothing to refetch. The field keeps its old name so
   * tabs running another version of the app still read it.
   */
  removedTempEntityKeys: string[];
};

/**
 * A tab deleted stored uploads. Each tab keeps its own in-memory copy of the
 * upload records, so the others drop theirs: a stale copy would stay listed,
 * be saved back to storage by the retention stamp, or be uploaded again.
 * `releasedRefs` carries the server refs of uploads deleted after they were
 * sent, so ids still held by app data resolve in every open tab.
 */
type SessionUploadsRemovedMessage = BrowserTabsMessageMeta & {
  kind: 'offline-uploads-removed';
  ids: string[];
  releasedRefs: Array<[id: string, ref: ValidPayload]>;
};

type OfflineSessionMessage =
  | SessionSnapshotMessage
  | SessionQueueEntryMessage
  | SessionResolutionMessage
  | SessionTempReconciledMessage
  | SessionWorkDiscardedMessage
  | SessionUploadsRemovedMessage
  | (BrowserTabsMessageMeta & BrowserTabsTabStatusMessage);

type UploadFileEntry = {
  /** Change listeners of the hooks currently consuming this upload id. */
  listeners: Set<() => void>;
  value: OfflineUploadFile;
  /** Pending release, scheduled while no hook consumes the entry. */
  releaseTimer: ReturnType<typeof setTimeout> | undefined;
};

function noop(): void {}

type SessionReplayHead = {
  storeName: string;
  entryId: string;
  queueOrder: number;
  createdAt: number;
};

type SessionStoreContribution = {
  adapter: StorageAdapter;
  entities: InternalGlobalOfflineEntity[];
  attemptedCreationEntityIds: string[];
  resolutions: OfflineResolutionRecord[];
  referencedUploadIds: string[];
  protectedKeys: string[];
  replayHead: SessionReplayHead | null;
};

type SessionStoreItems = Pick<
  SessionStoreContribution,
  'entities' | 'attemptedCreationEntityIds' | 'resolutions'
> & {
  /** Whether the store still has mutations in its queue. */
  hasQueuedMutations: boolean;
};

type SessionRegistration = {
  storeName: string;
  onGreenCycle?: () => void;
  onOfflineCycle?: () => void;
  /**
   * Called when another store of the session cancelled or discarded entities
   * created offline that will never exist on the server. `cancelledEntityKeys`
   * holds their keys in the source store, and `getEntityKey` keys an entity
   * payload of that store the same way.
   * Only registered by stores with `cancelledWith` operations.
   */
  onTempEntitiesCancelled?: (
    sourceStoreName: string,
    cancelledEntityKeys: ReadonlySet<string>,
    getEntityKey: (entityRef: ValidPayload) => string | undefined,
  ) => Promise<void>;
  /**
   * Id of the manual resolution the creation of `entityRef` (an entity
   * payload of the store) waits for, if any: the other stores hold their work
   * declared as `cancelledWith` that entity behind it.
   */
  findCreationResolutionId?: (entityRef: ValidPayload) => string | undefined;
  /**
   * Called when another store of the session sent again, or kept, creations
   * that waited for a manual resolution. `releasedEntityKeys` holds their
   * keys in the source store, `getEntityKey` keys an entity payload of that
   * store the same way, and the work released after them must be queued
   * from `minQueueOrder` on. Only registered by stores with `cancelledWith`
   * operations.
   */
  onCreationsReleased?: (
    sourceStoreName: string,
    releasedEntityKeys: ReadonlySet<string>,
    getEntityKey: (entityRef: ValidPayload) => string | undefined,
    minQueueOrder: number,
  ) => Promise<void>;
  /** Another tab saved or removed (`null`) a queue entry of the store. */
  onRemoteQueueEntryChange?: (
    entryId: string,
    entry: OfflineQueueEntry | null,
  ) => void;
  /** Another tab saved or removed (`null`) a resolution of the store. */
  onRemoteResolutionChange?: (
    resolutionId: string,
    resolution: PersistedOfflineResolutionRecord | null,
  ) => void;
  /** Another tab reconciled a temp entity of the store to its final payload. */
  onRemoteTempReconciled?: (
    tempId: ValidPayload,
    finalPayload: ValidPayload,
    finalData: unknown,
  ) => void;
  /** Another tab discarded queued work of the store. */
  onRemoteWorkDiscarded?: (
    discardedWork: DiscardedOfflineWork[],
    removedEntityKeys: string[],
  ) => void;
};

type SessionCoordinatorOptions = {
  sessionKey: string;
  appVersion?: string;
  adapter?: StorageAdapter;
  onPersistentStorageError?: (error: unknown) => void;
  debugLogger?: TSDFDebugLogger;
  config?: OfflineSessionConfig;
  uploads?: OfflineSessionUploadsConfig;
  bootstrapStatusFromLocalStorage?: boolean;
};

const DEFAULT_OUTAGE_RECOVERY_PROBE: Required<OfflineRecoveryProbeConfig> = {
  initialIntervalMs: 30_000,
  maxIntervalMs: 300_000,
  backoffMultiplier: 2,
  jitterRatio: 0.2,
};
const DEFAULT_NETWORK_RECOVERY_PROBE: Required<OfflineRecoveryProbeConfig> = {
  initialIntervalMs: 5_000,
  maxIntervalMs: 60_000,
  backoffMultiplier: 2,
  jitterRatio: 0.2,
};
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 10_000;
const defaultGetIsOffline = () => !navigator.onLine;
const INACTIVE_MODE = { enabled: false, active: false } as const;

const defaultStatusBySession = new Map<string, GlobalOfflineStatus>();
const registry = new Map<string, SessionOfflineCoordinator>();
const uploadsConfigByOfflineSession = new WeakMap<
  OfflineSession,
  OfflineSessionUploadsConfig | undefined
>();
const appVersionByOfflineSession = new WeakMap<
  OfflineSession,
  string | undefined
>();
type OfflineRecoveryListener = (
  sessionKey: string,
  hasStoreRecovered: (storeName: string) => boolean,
) => void;

const offlineRecoveryListeners = new Set<OfflineRecoveryListener>();

type SessionStoreState = {
  status: GlobalOfflineStatus;
  entities: InternalGlobalOfflineEntity[];
  /**
   * Ids of the temp entities whose creation was already sent or waits for a
   * manual resolution (see `ItemOfflineState.creationAttempted`).
   */
  attemptedCreationEntityIds: string[];
  resolutions: OfflineResolutionRecord[];
  uploads: OfflineUpload[];
  /**
   * Whether any store of the session still has mutations in its queue,
   * including the ones that reference no entity (they have no entry in
   * `entities`).
   */
  hasQueuedMutations: boolean;
};

/**
 * The stores (by name) that cannot be revalidated against the server yet, or
 * `null` when no store of the session can:
 *
 * - offline, or with queued mutations still to replay: anything fetched now
 *   may predate the replayed mutations, in any store
 * - a store with changes waiting for a manual resolution: a refetch would
 *   replace the local changes the user still has to decide on
 */
function getStoresAwaitingRecovery(
  state: SessionStoreState,
): ReadonlySet<string> | null {
  if (state.status.isOfflineMode || state.hasQueuedMutations) return null;

  const storeNames = new Set<string>();

  for (const entity of state.entities) {
    if (entity.pendingMutations > 0) return null;
    if (entity.requiresResolution) storeNames.add(entity.storeName);
  }

  // Also from the resolutions: an operation may reference no entity
  for (const resolution of state.resolutions) {
    storeNames.add(resolution.storeName);
  }

  return storeNames;
}

/**
 * Subscribes to stores recovering in this tab (any session key; listeners
 * filter by the key they care about). A store recovers when its session is
 * back online with its queued mutations replayed and the store has no change
 * left waiting for a manual resolution: from then on its cached data can be
 * revalidated against the server.
 * @internal
 */
export function subscribeToOfflineRecovery(
  listener: OfflineRecoveryListener,
): () => void {
  offlineRecoveryListeners.add(listener);

  return () => {
    offlineRecoveryListeners.delete(listener);
  };
}

/**
 * Whether the session is in offline mode in this tab, without creating or
 * reconfiguring its coordinator (a session nothing tracks is online).
 *
 * While it is, also re-checks connectivity: callers ask on a hint that the
 * connection may be back (a transport reconnect, a window focus), and some
 * setups have nothing else that ends offline mode (a custom `getIsOffline`
 * without browser events, a classified network failure without a recovery
 * check). Leaving offline mode notifies the recovery listeners, which
 * revalidate the stores, so callers skip their own revalidation either way.
 * @internal
 */
export function recheckIsSessionInOfflineMode(
  sessionKey: string | false,
): boolean {
  if (sessionKey === false) return false;

  const coordinator = registry.get(sessionKey);
  if (!coordinator?.getStatus().isOfflineMode) return false;

  coordinator.recheckNetworkState();
  return true;
}

const DEFAULT_UPLOAD_CONCURRENCY = 3;
const OFFLINE_UPLOAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const OFFLINE_UPLOAD_RETENTION_STABLE_ONLINE_MS = 5_000;
const UPLOAD_FILE_RELEASE_DELAY_MS = 1_000;

export function createDefaultStatus(sessionKey: string): GlobalOfflineStatus {
  return {
    sessionKey,
    network: { enabled: false, active: false },
    outage: { enabled: false, active: false },
    isOfflineMode: false,
    isForcedOffline: false,
    isLeader: true,
    updatedAt: Date.now(),
    lastFailureAt: null,
    lastRecoveryCheckAt: null,
  };
}

function normalizeCompactModeState(value: { e?: 1; a?: 1 } | undefined): {
  enabled: boolean;
  active: boolean;
} {
  return {
    enabled: value?.e === COMPACT_OFFLINE_STATUS_FLAG,
    active: value?.a === COMPACT_OFFLINE_STATUS_FLAG,
  };
}

function serializeOfflineStatusSnapshot(status: GlobalOfflineStatus) {
  return {
    n:
      status.network.enabled || status.network.active
        ? {
            ...(status.network.enabled
              ? { e: COMPACT_OFFLINE_STATUS_FLAG }
              : {}),
            ...(status.network.active
              ? { a: COMPACT_OFFLINE_STATUS_FLAG }
              : {}),
          }
        : undefined,
    o:
      status.outage.enabled || status.outage.active
        ? {
            ...(status.outage.enabled
              ? { e: COMPACT_OFFLINE_STATUS_FLAG }
              : {}),
            ...(status.outage.active ? { a: COMPACT_OFFLINE_STATUS_FLAG } : {}),
          }
        : undefined,
    f: status.isForcedOffline ? COMPACT_OFFLINE_STATUS_FLAG : undefined,
    u: status.updatedAt,
    lf: status.lastFailureAt ?? undefined,
    lr: status.lastRecoveryCheckAt ?? undefined,
  };
}

function normalizePersistedOfflineStatus(
  sessionKey: string,
  rawStatus: unknown,
): GlobalOfflineStatus | null {
  const compactStatus = rc_parse(
    rawStatus,
    compactOfflineStatusSnapshotSchema,
  ).unwrapOrNull();
  if (compactStatus !== null) {
    const network = normalizeCompactModeState(compactStatus.n);
    const outage = normalizeCompactModeState(compactStatus.o);
    const isOfflineMode = getIsOfflineModeFromStatus({ network, outage });

    return {
      sessionKey,
      network,
      outage,
      isOfflineMode,
      isForcedOffline: compactStatus.f === COMPACT_OFFLINE_STATUS_FLAG,
      isLeader: true,
      updatedAt:
        typeof compactStatus.u === 'number' ? compactStatus.u : Date.now(),
      lastFailureAt:
        typeof compactStatus.lf === 'number' ? compactStatus.lf : null,
      lastRecoveryCheckAt:
        typeof compactStatus.lr === 'number' ? compactStatus.lr : null,
    };
  }

  return null;
}

type PersistedLocalSessionSnapshot = { status: GlobalOfflineStatus };

function readPersistedLocalSessionSnapshot(
  sessionKey: string,
): PersistedLocalSessionSnapshot | null {
  if (!isWindowAvailable()) return null;

  try {
    const entry = parseCompactLocalStorageEntry(
      localStorage.getItem(getOfflineSessionStatusStorageKey(sessionKey)),
    );
    if (!entry) return null;

    return normalizePersistedLocalSessionSnapshot(sessionKey, entry.value);
  } catch {
    // Ignore read failures so offline coordination continues to work
    // even when localStorage is unavailable.
  }

  return null;
}

function resolveDefaultStatus(
  sessionKey: string,
  options: { bootstrapStatusFromLocalStorage?: boolean } = {},
): GlobalOfflineStatus {
  if (options.bootstrapStatusFromLocalStorage) {
    const bootstrapped =
      readPersistedLocalSessionSnapshot(sessionKey)?.status ?? null;
    if (bootstrapped !== null) {
      defaultStatusBySession.set(sessionKey, bootstrapped);
      return bootstrapped;
    }
  }

  const existing = defaultStatusBySession.get(sessionKey);
  if (existing) return existing;

  const created = createDefaultStatus(sessionKey);
  defaultStatusBySession.set(sessionKey, created);
  return created;
}

function isWindowAvailable(): boolean {
  return typeof window !== 'undefined';
}

function resolveOfflineSessionScope(
  sessionKey: string | false,
  inactiveScope: string,
): string {
  return typeof sessionKey === 'string'
    ? sessionKey
    : `__inactive__:${inactiveScope}`;
}

function arraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function replayHeadsEqual(
  left: SessionReplayHead | null | undefined,
  right: SessionReplayHead | null | undefined,
): boolean {
  return (
    left?.storeName === right?.storeName &&
    left?.entryId === right?.entryId &&
    left?.queueOrder === right?.queueOrder &&
    left?.createdAt === right?.createdAt
  );
}

function compareReplayHeads(
  left: SessionReplayHead,
  right: SessionReplayHead,
): number {
  if (left.queueOrder !== right.queueOrder) {
    return left.queueOrder - right.queueOrder;
  }
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  if (left.storeName !== right.storeName) {
    return left.storeName.localeCompare(right.storeName);
  }

  return left.entryId.localeCompare(right.entryId);
}

function normalizeRecoveryProbe(
  config: OfflineRecoveryProbeConfig | undefined,
  defaults: Required<OfflineRecoveryProbeConfig>,
): Required<OfflineRecoveryProbeConfig> {
  return {
    initialIntervalMs: config?.initialIntervalMs ?? defaults.initialIntervalMs,
    maxIntervalMs: config?.maxIntervalMs ?? defaults.maxIntervalMs,
    backoffMultiplier: config?.backoffMultiplier ?? defaults.backoffMultiplier,
    jitterRatio: config?.jitterRatio ?? defaults.jitterRatio,
  };
}

type SessionRecoveryMode = 'network' | 'outage';

type SessionRecoveryTarget = {
  mode: SessionRecoveryMode;
  /** Probe of the mode itself. Without one the session health check is used. */
  recoveryCheck:
    | ((ctx: { sessionKey: string }) => Promise<boolean> | boolean)
    | undefined;
  recoveryProbe: Required<OfflineRecoveryProbeConfig>;
};

type SessionCanonicalConfig = {
  isSessionEnabled?: OfflineSessionConfig['enabled'];
  hasNetworkConfig: boolean;
  networkEnabledByDefault: boolean;
  networkListenToBrowserEvents: boolean;
  getIsOffline?: () => boolean | Promise<boolean>;
  networkRecoveryCheck?: OfflineNetworkModeConfig['recoveryCheck'];
  networkRecoveryProbe: Required<OfflineRecoveryProbeConfig>;
  hasOutageConfig: boolean;
  outageEnabledByDefault: boolean;
  mutationQueueingByDefault: {
    network: OfflineMutationQueueingPolicy;
    outage: OfflineMutationQueueingPolicy;
  };
  classifyFailure?: OfflineSessionConfig['classifyFailure'];
  classifyRetriableFailure?: OfflineSessionConfig['classifyRetryableFailure'];
  healthCheck?: OfflineHealthCheckConfig['check'];
  healthCheckTimeoutMs: number;
  healthCheckReuseUpForFailuresMs: number;
  outageRecoveryCheck?: OfflineOutageModeConfig['recoveryCheck'];
  outageRecoveryProbe: Required<OfflineRecoveryProbeConfig>;
};

function toCanonicalConfig(
  config: OfflineSessionConfig | undefined,
): SessionCanonicalConfig {
  return {
    isSessionEnabled: config?.enabled,
    hasNetworkConfig: config?.network !== undefined,
    networkEnabledByDefault: config?.network?.enabled ?? false,
    networkListenToBrowserEvents:
      config?.network?.listenToBrowserEvents ?? true,
    getIsOffline: config?.network?.getIsOffline,
    networkRecoveryCheck: config?.network?.recoveryCheck,
    networkRecoveryProbe: normalizeRecoveryProbe(
      config?.network?.recoveryProbe,
      DEFAULT_NETWORK_RECOVERY_PROBE,
    ),
    hasOutageConfig: config?.outage !== undefined,
    outageEnabledByDefault: config?.outage?.enabled ?? false,
    mutationQueueingByDefault: {
      network: config?.mutationQueueing?.network ?? 'allow',
      outage: config?.mutationQueueing?.outage ?? 'allow',
    },
    classifyFailure: config?.classifyFailure,
    classifyRetriableFailure: config?.classifyRetryableFailure,
    healthCheck: config?.healthCheck?.check,
    healthCheckTimeoutMs:
      config?.healthCheck?.timeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
    healthCheckReuseUpForFailuresMs:
      config?.healthCheck?.reuseUpForFailuresMs ?? 0,
    outageRecoveryCheck: config?.outage?.recoveryCheck,
    outageRecoveryProbe: normalizeRecoveryProbe(
      config?.outage?.recoveryProbe,
      DEFAULT_OUTAGE_RECOVERY_PROBE,
    ),
  };
}

function createNoopPersistentStorageHandle<T>(): PersistentStorageHandle<T> {
  return {
    load: () => Promise.resolve(null),
    scheduleSave: () => {},
    saveNow: () => Promise.resolve(),
    clear: () => Promise.resolve(),
    dispose: () => {},
  };
}

function sameProbeConfig(
  left: Required<OfflineRecoveryProbeConfig>,
  right: Required<OfflineRecoveryProbeConfig>,
): boolean {
  return (
    left.initialIntervalMs === right.initialIntervalMs &&
    left.maxIntervalMs === right.maxIntervalMs &&
    left.backoffMultiplier === right.backoffMultiplier &&
    left.jitterRatio === right.jitterRatio
  );
}

const persistedLocalSessionSnapshotSchema = rc_object({
  d: compactOfflineStatusSnapshotSchema,
});

function sameCanonicalConfig(
  left: SessionCanonicalConfig,
  right: SessionCanonicalConfig,
): boolean {
  return (
    left.isSessionEnabled === right.isSessionEnabled &&
    left.hasNetworkConfig === right.hasNetworkConfig &&
    left.networkEnabledByDefault === right.networkEnabledByDefault &&
    left.networkListenToBrowserEvents === right.networkListenToBrowserEvents &&
    left.getIsOffline === right.getIsOffline &&
    left.networkRecoveryCheck === right.networkRecoveryCheck &&
    sameProbeConfig(left.networkRecoveryProbe, right.networkRecoveryProbe) &&
    left.hasOutageConfig === right.hasOutageConfig &&
    left.outageEnabledByDefault === right.outageEnabledByDefault &&
    left.mutationQueueingByDefault.network ===
      right.mutationQueueingByDefault.network &&
    left.mutationQueueingByDefault.outage ===
      right.mutationQueueingByDefault.outage &&
    left.classifyFailure === right.classifyFailure &&
    left.classifyRetriableFailure === right.classifyRetriableFailure &&
    left.healthCheck === right.healthCheck &&
    left.healthCheckTimeoutMs === right.healthCheckTimeoutMs &&
    left.healthCheckReuseUpForFailuresMs ===
      right.healthCheckReuseUpForFailuresMs &&
    left.outageRecoveryCheck === right.outageRecoveryCheck &&
    sameProbeConfig(left.outageRecoveryProbe, right.outageRecoveryProbe)
  );
}

function sameUploadsConfig(
  left: OfflineSessionUploadsConfig | undefined,
  right: OfflineSessionUploadsConfig | undefined,
): boolean {
  return (
    left?.adapter === right?.adapter &&
    left?.upload === right?.upload &&
    left?.resolvedRefSchema === right?.resolvedRefSchema &&
    (left?.concurrency ?? DEFAULT_UPLOAD_CONCURRENCY) ===
      (right?.concurrency ?? DEFAULT_UPLOAD_CONCURRENCY)
  );
}

function castUploads<TUploadRef extends ValidPayload>(
  uploads: readonly OfflineUpload[],
): readonly OfflineUpload<TUploadRef>[] {
  // WORKAROUND: The coordinator is shared per session key, so it stores refs
  // as ValidPayload and the session API rebinds them to the caller's upload-ref
  // generic. Refs returned by the session transport have that type by
  // construction; refs restored from storage or received from other tabs are
  // parsed with `uploads.resolvedRefSchema` when they enter the coordinator,
  // and are only as trustworthy as the stored data when no schema is set.
  return __LEGIT_CAST__<
    readonly OfflineUpload<TUploadRef>[],
    readonly OfflineUpload[]
  >(uploads);
}

function castResolvedUploadRef<TUploadRef extends ValidPayload>(
  resolvedRef: ValidPayload,
): TUploadRef {
  // WORKAROUND: Same rebind as `castUploads`, for a single resolved ref.
  return __LEGIT_CAST__<TUploadRef, ValidPayload>(resolvedRef);
}

function castResolvedUploadRefs<TUploadRef extends ValidPayload>(
  resolvedRefsById: Record<string, ValidPayload>,
): Record<string, TUploadRef> {
  // WORKAROUND: Same rebind as `castUploads`, for a map of resolved refs.
  return __LEGIT_CAST__<
    Record<string, TUploadRef>,
    Record<string, ValidPayload>
  >(resolvedRefsById);
}

function normalizePersistedLocalSessionSnapshot(
  sessionKey: string,
  rawSnapshot: unknown,
): PersistedLocalSessionSnapshot | null {
  const persistedSnapshot = rc_parse(
    rawSnapshot,
    persistedLocalSessionSnapshotSchema,
  ).unwrapOrNull();
  if (persistedSnapshot === null) return null;

  const status = normalizePersistedOfflineStatus(
    sessionKey,
    persistedSnapshot.d,
  );
  if (status === null) return null;

  return { status };
}

function createSessionPersistenceHandle(
  sessionKey: string,
  enabled: boolean,
  onPersistentStorageError?: (error: unknown) => void,
  debugLogger?: TSDFDebugLogger,
): PersistentStorageHandle<PersistedLocalSessionSnapshot> {
  if (!enabled) return createNoopPersistentStorageHandle();

  return createPersistentStorageHandle<PersistedLocalSessionSnapshot>(
    {
      storeName: OFFLINE_SESSION_STATUS_STORE_NAME,
      adapter: 'local-sync',
      getSessionKey: () => sessionKey,
      onPersistentStorageError,
      ...(import.meta.env.DEV ? { debugLogger } : undefined),
    },
    {
      valueCodec: {
        serialize(snapshot) {
          return { d: serializeOfflineStatusSnapshot(snapshot.status) };
        },
        deserialize(raw) {
          return normalizePersistedLocalSessionSnapshot(sessionKey, raw);
        },
      },
    },
  );
}

function dedupeById<T extends { id: string }>(values: readonly T[]): T[] {
  const deduped = new Map<string, T>();
  for (const value of values) {
    deduped.set(value.id, value);
  }

  return [...deduped.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
}

/**
 * Internal coordinator that tracks offline/network state, queue health and conflict
 * aggregation for a session.
 *
 * Instances are shared per session key and reused through `getOrCreateSessionOfflineCoordinator`.
 * @internal
 */
class SessionOfflineCoordinator {
  readonly sessionKey: string;
  readonly store: Store<SessionStoreState>;

  readonly #registrations = new Map<string, SessionRegistration>();
  readonly #storeContributions = new Map<string, SessionStoreContribution>();
  /**
   * Latest entities and resolutions other tabs reported for their stores. Only
   * used for stores this tab has not attached, e.g. a store only another tab
   * created.
   */
  readonly #remoteStoreItems = new Map<string, SessionStoreItems>();
  readonly #adapters = new Set<StorageAdapter>();
  #sessionHandle: PersistentStorageHandle<PersistedLocalSessionSnapshot>;
  readonly #browserTabs;
  #onPersistentStorageError: ((error: unknown) => void) | undefined;
  #uploadsConfig: OfflineSessionUploadsConfig | undefined;
  #uploads = new Map<string, OfflineStoredUploadRecord>();
  #storedUploadsRestore: Promise<void> | null = null;
  /**
   * Ids other tabs deleted while this tab's stored uploads were being listed,
   * so the list result can't bring them back. `null` outside the listing.
   */
  #uploadsRemovedWhileListing: Set<string> | null = null;
  #referencedUploadIds = new Set<string>();
  #uploadQueue: ReturnType<typeof createAsyncQueue<ValidPayload>>;
  #uploadPromisesById = new Map<string, Promise<ValidPayload>>();
  /**
   * Validation outcome of the refs in the latest remote snapshot, so a ref
   * repeated across snapshots is parsed once per record version.
   */
  #remoteUploadRefValidations = new Map<
    string,
    { updatedAt: number; parsedRef: ValidPayload | undefined }
  >();
  /**
   * Uploads released by work that left the queue but not deleted yet: a store
   * had not reported its references, or the upload was still being sent.
   */
  #pendingUploadReleases = new Set<string>();
  /**
   * Files attached to a mutation that is still being queued: saved before the
   * queue entry that references them, so unused-mutation-upload cleanup must
   * skip them until a store reports that reference.
   */
  #stagedMutationUploadIds = new Set<string>();
  /**
   * Refs of uploads that were uploaded and then released, so data still
   * holding their ids (optimistic or draft state) resolves to the same ref
   * for the rest of the session instead of failing.
   */
  #releasedUploadRefs = new Map<string, ValidPayload>();
  /** Adapter removals in flight, awaited before the same id is read or saved. */
  #uploadRemovals = new Map<string, Promise<void>>();
  #uploadCleanupTimer: ReturnType<typeof setTimeout> | null = null;
  #uploadOnlineSessionStartedAt: number | null = null;
  #uploadOnlineSessionStabilizationTimer: ReturnType<typeof setTimeout> | null =
    null;
  #uploadRetentionToken = 0;
  readonly #uploadFiles = new Map<string, UploadFileEntry>();
  #cleanupNetworkListeners: (() => void) | null = null;
  #canonicalConfig: SessionCanonicalConfig;
  #hasCanonicalConfig: boolean;
  #classificationToken = 0;
  #retriableFailureToken = 0;
  #networkStateToken = 0;
  #isRecheckingNetworkState = false;
  #lastRemoteSnapshotAt = 0;
  #recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  #scheduledRecoveryMode: SessionRecoveryMode | null = null;
  #recoveryAttempt = 0;
  /** Health check in flight, shared by every caller asking meanwhile. */
  #healthCheckInFlight: Promise<OfflineHealthCheckResult | null> | null = null;
  /**
   * When failure classification last got `up` from the health check, while
   * `healthCheck.reuseUpForFailuresMs` lets later failures reuse it. Only
   * failure classification reads it: recovery checks never do.
   */
  #healthUpForFailuresAt: number | null = null;
  #classifiedNetworkActive = false;
  /**
   * Forced offline mode: network detection reports offline regardless of the
   * real connectivity. Read synchronously from the persisted status at boot so
   * the first operations after a reload are already treated as offline.
   */
  #forcedOffline = false;
  /** Last value of the session gate applied to the status. */
  #appliedSessionEnabled = true;
  /**
   * The gate reopened and no green cycle ran since: mutations queued before
   * it closed are waiting for one to be replayed.
   */
  #gateReopenedWithoutReplay = false;
  /** Tabs of this session that sent anything on the session channel. */
  #otherTabIds = new Set<string>();
  #networkEnabledOverride: boolean | undefined;
  #outageEnabledOverride: boolean | undefined;
  #mutationQueueingOverrides:
    | OfflineRuntimeConfigUpdate['mutationQueueing']
    | undefined;
  #hydrated = false;
  #hydrationToken = 0;
  #protectedKeys: string[] = [];
  #protectedKeysByAdapter = new Map<StorageAdapter, string[]>();
  #hasPersistedSessionSnapshot = false;
  #lastPersistedStatus: GlobalOfflineStatus | null = null;
  #disposed = false;
  #debugLogger: TSDFDebugLogger | undefined;
  readonly #bootstrapStatusFromLocalStorage: boolean;

  constructor(options: SessionCoordinatorOptions) {
    const {
      sessionKey,
      adapter,
      onPersistentStorageError,
      config,
      uploads,
      bootstrapStatusFromLocalStorage = false,
    } = options;
    const debugLogger = import.meta.env.DEV ? options.debugLogger : undefined;
    this.sessionKey = sessionKey;
    this.#bootstrapStatusFromLocalStorage = bootstrapStatusFromLocalStorage;
    if (adapter !== undefined) {
      this.#adapters.add(adapter);
    }
    this.#onPersistentStorageError = onPersistentStorageError;
    this.#debugLogger = debugLogger;
    this.#uploadsConfig = uploads;
    if (uploads) {
      registerOfflineUploadAdapterForSession(this.sessionKey, uploads.adapter);
    }
    this.#uploadQueue = createAsyncQueue<ValidPayload>({
      autoStart: true,
      concurrency: uploads?.concurrency ?? DEFAULT_UPLOAD_CONCURRENCY,
    });
    const shouldBootstrapFromStorage =
      config !== undefined || bootstrapStatusFromLocalStorage;
    const bootstrappedLocalSnapshot = shouldBootstrapFromStorage
      ? readPersistedLocalSessionSnapshot(sessionKey)
      : null;
    this.#sessionHandle = createSessionPersistenceHandle(
      sessionKey,
      shouldBootstrapFromStorage,
      onPersistentStorageError,
      debugLogger,
    );
    this.#canonicalConfig = toCanonicalConfig(config);
    this.#hasCanonicalConfig = config !== undefined;
    this.#hasPersistedSessionSnapshot = bootstrappedLocalSnapshot !== null;
    this.#lastPersistedStatus = bootstrappedLocalSnapshot?.status ?? null;
    this.#forcedOffline =
      bootstrappedLocalSnapshot?.status.isForcedOffline ?? false;
    setSessionProtectedKeysSnapshot(this.sessionKey, this.#protectedKeys);
    if (bootstrappedLocalSnapshot !== null) {
      defaultStatusBySession.set(sessionKey, bootstrappedLocalSnapshot.status);
    }
    this.store = new Store<SessionStoreState>({
      debugName: `tsdf-offline:${sessionKey}`,
      state: () => ({
        status:
          bootstrappedLocalSnapshot?.status ??
          resolveDefaultStatus(sessionKey, {
            bootstrapStatusFromLocalStorage: shouldBootstrapFromStorage,
          }),
        entities: [],
        attemptedCreationEntityIds: [],
        resolutions: [],
        uploads: [],
        hasQueuedMutations: false,
      }),
    });
    this.#syncClassifiedNetworkStateFromStatus(this.store.state.status);
    this.store.subscribe(({ prev, current }) => {
      if (
        prev.entities === current.entities &&
        prev.resolutions === current.resolutions &&
        prev.hasQueuedMutations === current.hasQueuedMutations &&
        prev.status.isOfflineMode === current.status.isOfflineMode
      ) {
        return;
      }

      const awaitingStores = getStoresAwaitingRecovery(current);
      if (awaitingStores === null) return;

      const prevAwaitingStores = getStoresAwaitingRecovery(prev);
      if (prevAwaitingStores?.size === 0) return;

      for (const listener of offlineRecoveryListeners) {
        listener(
          sessionKey,
          (storeName) =>
            !awaitingStores.has(storeName) &&
            (prevAwaitingStores === null || prevAwaitingStores.has(storeName)),
        );
      }
    });

    this.#browserTabs =
      createBrowserTabsCoordinatorWithPriority<OfflineSessionMessage>(
        'offline',
        `session:${sessionKey}`,
        () => this.sessionKey,
        (message) => {
          const isNewTab = !this.#otherTabIds.has(message.tabId);
          this.#otherTabIds.add(message.tabId);

          if (message.kind === 'tab-status') {
            this.#browserTabs.priority.onTabStatusMessage(
              message.tabId,
              message,
            );
            // Tabs only announce themselves when they open or change focus,
            // so answer a newcomer: otherwise it never learns about this tab
            // and can consider itself the leader alongside it, nor lists the
            // offline items of stores only this tab has attached.
            if (isNewTab) {
              this.#browserTabs.priority.publishLocalStatus();
              this.#publishSnapshot();
            }
            this.#refreshLeadership();
            return;
          }
          if (message.kind === 'offline-queue-entry') {
            this.#registrations
              .get(message.storeName)
              ?.onRemoteQueueEntryChange?.(message.entryId, message.entry);
            return;
          }
          if (message.kind === 'offline-resolution') {
            this.#registrations
              .get(message.storeName)
              ?.onRemoteResolutionChange?.(
                message.resolutionId,
                message.resolution,
              );
            return;
          }
          if (message.kind === 'offline-temp-reconciled') {
            this.#registrations
              .get(message.storeName)
              ?.onRemoteTempReconciled?.(
                message.tempId,
                message.finalPayload,
                message.finalData,
              );
            return;
          }
          if (message.kind === 'offline-work-discarded') {
            this.#registrations
              .get(message.storeName)
              ?.onRemoteWorkDiscarded?.(
                message.discardedWork,
                message.removedTempEntityKeys,
              );
            return;
          }
          if (message.kind === 'offline-uploads-removed') {
            this.#applyRemoteUploadsRemoved(message.ids, message.releasedRefs);
            return;
          }
          this.#applyRemoteSnapshot(message);
          // Applied after the snapshot so this tab re-detects its own network
          // state last, and regardless of snapshot staleness: it is an
          // explicit user action, not derived state.
          if (typeof message.forcedOffline === 'boolean') {
            void this.#applyForcedOffline(message.forcedOffline);
          }
        },
        undefined,
        undefined,
        import.meta.env.DEV ? debugLogger : undefined,
        () => !isWindowAvailable() || !document.hidden,
        (noteFocusChange) => {
          if (!isWindowAvailable()) return () => {};

          // Leadership follows the visible tab. Re-evaluate it here as well:
          // a tab that becomes the leader has to start replaying, and a tab
          // being closed or hidden has to hand leadership over.
          const onChange = (): void => {
            noteFocusChange();
            this.#refreshLeadership();
          };

          window.addEventListener('focus', onChange);
          window.addEventListener('blur', onChange);
          window.addEventListener('pagehide', onChange);
          document.addEventListener('visibilitychange', onChange);
          return () => {
            window.removeEventListener('focus', onChange);
            window.removeEventListener('blur', onChange);
            window.removeEventListener('pagehide', onChange);
            document.removeEventListener('visibilitychange', onChange);
          };
        },
        undefined,
        undefined,
        options.appVersion,
      );

    this.#refreshLeadership();
    if (shouldBootstrapFromStorage) {
      void this.hydrate();
    }
    if (this.#hasCanonicalConfig) {
      this.#refreshNetworkConfig();
    }
  }

  async hydrate(): Promise<void> {
    if (this.#hydrated) return;
    this.#hydrated = true;
    const hydrationToken = this.#hydrationToken;
    let persistedLocalSnapshot: PersistedLocalSessionSnapshot | null = null;

    try {
      persistedLocalSnapshot = await this.#sessionHandle.load({
        touch: 'never',
      });
    } catch (error) {
      this.#onPersistentStorageError?.(error);
    }

    if (hydrationToken !== this.#hydrationToken) return;

    if (persistedLocalSnapshot) {
      this.#hasPersistedSessionSnapshot = true;
      this.#lastPersistedStatus = persistedLocalSnapshot.status;
      const hydratedStatus = this.#restampHydratedStatus(
        persistedLocalSnapshot.status,
        { isLeader: this.isLeader(), updatedAt: Date.now() },
      );

      this.store.setPartialState(
        { status: hydratedStatus },
        { action: 'offline-session-hydrate' },
      );
      this.#syncClassifiedNetworkStateFromStatus(hydratedStatus);
      this.#syncRecoveryProbe();
    }

    const protectedKeys = new Set<string>();
    if (this.#adapters.size > 0) {
      const protectedKeySetResults = await Promise.allSettled(
        [...this.#adapters].map((adapter) =>
          readProtectedStorageKeys(adapter, this.sessionKey, this.#debugLogger),
        ),
      );
      for (const result of protectedKeySetResults) {
        if (result.status === 'rejected') {
          this.#onPersistentStorageError?.(result.reason);
          continue;
        }

        for (const key of result.value) {
          protectedKeys.add(key);
        }
      }
    }

    this.#protectedKeys = [...protectedKeys].sort();
    setSessionProtectedKeysSnapshot(this.sessionKey, this.#protectedKeys);
    if (this.#uploadsConfig) {
      await this.#restoreStoredUploads();
      if (hydrationToken === this.#hydrationToken) {
        this.#scheduleUploadOnlineSessionStabilization();
        void this.#refreshUploadRetention();
      }
    }
    void this.#persistSessionSnapshot();
  }

  configure(options: {
    adapter?: StorageAdapter;
    onPersistentStorageError?: (error: unknown) => void;
    debugLogger?: TSDFDebugLogger;
    config?: OfflineSessionConfig;
    uploads?: OfflineSessionUploadsConfig;
  }): void {
    if (options.adapter !== undefined) {
      this.#adapters.add(options.adapter);
    }
    if (options.onPersistentStorageError !== undefined) {
      this.#onPersistentStorageError = options.onPersistentStorageError;
    }
    if (import.meta.env.DEV && options.debugLogger !== undefined) {
      this.#debugLogger = options.debugLogger;
    }
    if (options.uploads !== undefined) {
      if (
        import.meta.env.DEV &&
        this.#uploadsConfig !== undefined &&
        !sameUploadsConfig(this.#uploadsConfig, options.uploads)
      ) {
        throw new Error(
          `[tsdf] Incompatible offline upload configuration for session "${this.sessionKey}"`,
        );
      }
      // Every manager call reconfigures the session, so the queue is only
      // recreated when the config changes; recreating it on each call would
      // let new uploads bypass the concurrency limit of the running ones.
      if (!sameUploadsConfig(this.#uploadsConfig, options.uploads)) {
        this.#uploadQueue = createAsyncQueue<ValidPayload>({
          autoStart: true,
          concurrency:
            options.uploads.concurrency ?? DEFAULT_UPLOAD_CONCURRENCY,
        });
      }
      this.#uploadsConfig = options.uploads;
      registerOfflineUploadAdapterForSession(
        this.sessionKey,
        options.uploads.adapter,
      );
      void this.hydrate();
    }

    if (!this.#hasCanonicalConfig && options.config) {
      this.#recreatePersistenceHandles({ enabled: true });
      this.#canonicalConfig = toCanonicalConfig(options.config);
      this.#hasCanonicalConfig = true;
      // The constructor only reads the persisted status when it bootstraps
      // from storage, so read the forced flag before the first network check.
      this.#forcedOffline =
        readPersistedLocalSessionSnapshot(this.sessionKey)?.status
          .isForcedOffline ?? false;
      void this.hydrate();
      this.#refreshNetworkConfig();
      return;
    }

    if (!this.#hasCanonicalConfig) return;

    if (options.onPersistentStorageError !== undefined) {
      this.#sessionHandle.dispose();
      this.#sessionHandle = createSessionPersistenceHandle(
        this.sessionKey,
        true,
        this.#onPersistentStorageError,
        this.#debugLogger,
      );
    }

    const nextConfig =
      options.config === undefined
        ? this.#canonicalConfig
        : toCanonicalConfig(options.config);

    if (
      import.meta.env.DEV &&
      !sameCanonicalConfig(this.#canonicalConfig, nextConfig)
    ) {
      throw new Error(
        `[tsdf] Incompatible offline session configuration for session "${this.sessionKey}"`,
      );
    }

    this.#refreshNetworkConfig();
  }

  #recreatePersistenceHandles(
    args: {
      enabled?: boolean;
      onPersistentStorageError?: (error: unknown) => void;
    } = {},
  ): void {
    this.#sessionHandle.dispose();
    this.#onPersistentStorageError =
      args.onPersistentStorageError ?? this.#onPersistentStorageError;
    this.#sessionHandle = createSessionPersistenceHandle(
      this.sessionKey,
      args.enabled ??
        (this.#hasCanonicalConfig || this.#bootstrapStatusFromLocalStorage),
      this.#onPersistentStorageError,
      this.#debugLogger,
    );
    this.#hasPersistedSessionSnapshot = false;
    this.#lastPersistedStatus = null;
    this.#hydrated = false;
    this.#hydrationToken += 1;
  }

  registerStore(registration: SessionRegistration): () => void {
    if (this.#disposed) {
      return () => {};
    }

    this.#registrations.set(registration.storeName, registration);
    this.#refreshLeadership();

    return () => {
      this.#registrations.delete(registration.storeName);
      this.#storeContributions.delete(registration.storeName);
      // Another tab's report for this store predates this tab's own records,
      // which were just dropped, so it must not come back in the lists.
      this.#remoteStoreItems.delete(registration.storeName);
      this.#refreshAggregates();
      this.#notifyGreenCycle();
      if (this.#registrations.size === 0) {
        this.#stopRecoveryProbe();
      }
    };
  }

  syncStoreData(
    storeName: string,
    contribution: SessionStoreContribution,
    isRemoteChange = false,
  ): void {
    if (this.#disposed) return;
    const previousContribution = this.#storeContributions.get(storeName);
    const replayHeadChanged = !replayHeadsEqual(
      previousContribution?.replayHead,
      contribution.replayHead,
    );
    this.#storeContributions.set(storeName, contribution);
    // A change made by another tab was already announced by that tab
    this.#refreshAggregates(!isRemoteChange);
    if (replayHeadChanged) {
      this.#notifyGreenCycle();
    }
  }

  /**
   * Lets the other stores of the session drop the queued work they declared
   * as `cancelledWith` entities of `sourceStoreName` that will never exist on
   * the server.
   */
  async notifyTempEntitiesCancelled(
    sourceStoreName: string,
    cancelledEntityKeys: ReadonlySet<string>,
    getEntityKey: (entityRef: ValidPayload) => string | undefined,
  ): Promise<void> {
    const pendingCleanups: Promise<void>[] = [];

    for (const registration of this.#registrations.values()) {
      if (
        registration.storeName === sourceStoreName ||
        !registration.onTempEntitiesCancelled
      ) {
        continue;
      }

      pendingCleanups.push(
        registration.onTempEntitiesCancelled(
          sourceStoreName,
          cancelledEntityKeys,
          getEntityKey,
        ),
      );
    }

    // The source store already applied the cancellation: a store that fails
    // to clean up its work is reported without failing it.
    for (const result of await Promise.allSettled(pendingCleanups)) {
      if (result.status === 'rejected') {
        this.#onPersistentStorageError?.(result.reason);
      }
    }
  }

  /**
   * Id of the manual resolution the creation of `entityRef` waits for in
   * store `storeName`, when that store is attached in this tab.
   */
  findCreationResolutionId(
    storeName: string,
    entityRef: ValidPayload,
  ): string | undefined {
    return this.#registrations
      .get(storeName)
      ?.findCreationResolutionId?.(entityRef);
  }

  /**
   * Lets the other stores of the session queue again the work they held
   * behind creations of `sourceStoreName` that waited for a manual
   * resolution, once those creations were sent again or kept.
   */
  async notifyCreationsReleased(
    sourceStoreName: string,
    releasedEntityKeys: ReadonlySet<string>,
    getEntityKey: (entityRef: ValidPayload) => string | undefined,
    minQueueOrder: number,
  ): Promise<void> {
    const pendingRequeues: Promise<void>[] = [];

    for (const registration of this.#registrations.values()) {
      if (
        registration.storeName === sourceStoreName ||
        !registration.onCreationsReleased
      ) {
        continue;
      }

      pendingRequeues.push(
        registration.onCreationsReleased(
          sourceStoreName,
          releasedEntityKeys,
          getEntityKey,
          minQueueOrder,
        ),
      );
    }

    // The source store already applied its decision: a store that fails to
    // queue its held work again is reported without failing it.
    for (const result of await Promise.allSettled(pendingRequeues)) {
      if (result.status === 'rejected') {
        this.#onPersistentStorageError?.(result.reason);
      }
    }
  }

  /** Tells the other tabs that this tab saved or removed (`null`) a queue entry. */
  publishQueueEntryChange(
    storeName: string,
    entryId: string,
    entry: OfflineQueueEntry | null,
  ): void {
    if (this.#disposed) return;

    this.#browserTabs.coordinator.publish({
      kind: 'offline-queue-entry',
      storeName,
      entryId,
      entry,
    });
  }

  /** Tells the other tabs that this tab saved or removed (`null`) a resolution. */
  publishResolutionChange(
    storeName: string,
    resolutionId: string,
    resolution: PersistedOfflineResolutionRecord | null,
  ): void {
    if (this.#disposed) return;

    this.#browserTabs.coordinator.publish({
      kind: 'offline-resolution',
      storeName,
      resolutionId,
      resolution,
    });
  }

  /** Tells the other tabs that this tab reconciled a temp entity. */
  publishTempReconciled(
    storeName: string,
    tempId: ValidPayload,
    finalPayload: ValidPayload,
    finalData: unknown,
  ): void {
    if (this.#disposed) return;

    this.#browserTabs.coordinator.publish({
      kind: 'offline-temp-reconciled',
      storeName,
      tempId,
      finalPayload,
      ...(finalData === undefined ? {} : { finalData }),
    });
  }

  /** Tells the other tabs that this tab discarded queued work of a store. */
  publishWorkDiscarded(
    storeName: string,
    discardedWork: DiscardedOfflineWork[],
    removedEntityKeys: string[],
  ): void {
    if (this.#disposed) return;

    this.#browserTabs.coordinator.publish({
      kind: 'offline-work-discarded',
      storeName,
      discardedWork,
      removedTempEntityKeys: removedEntityKeys,
    });
  }

  /**
   * Whether another tab of this session was seen. While `false`, this tab is
   * the only one changing the queue, so it can skip the cross-tab safeguards.
   */
  hasOtherTabs(): boolean {
    return this.#otherTabIds.size > 0;
  }

  canReplayEntry(args: {
    storeName: string;
    entryId: string;
    queueOrder: number;
    createdAt: number;
  }): boolean {
    const replayHeads = [...this.#storeContributions.values()]
      .map((contribution) => contribution.replayHead)
      .filter((head) => head !== null);
    const nextReplayHead = replayHeads.sort(compareReplayHeads)[0];

    if (!nextReplayHead) return true;

    return (
      nextReplayHead.storeName === args.storeName &&
      nextReplayHead.entryId === args.entryId &&
      nextReplayHead.queueOrder === args.queueOrder &&
      nextReplayHead.createdAt === args.createdAt
    );
  }

  getProtectedKeys(): string[] {
    return this.#protectedKeys;
  }

  isProtectedKey(key: string): boolean {
    return this.#protectedKeys.includes(key);
  }

  getClassificationToken(): number {
    this.#classificationToken += 1;
    return this.#classificationToken;
  }

  isCurrentClassificationToken(token: number): boolean {
    return token === this.#classificationToken;
  }

  getRetriableFailureToken(): number {
    this.#retriableFailureToken += 1;
    return this.#retriableFailureToken;
  }

  isCurrentRetriableFailureToken(token: number): boolean {
    return token === this.#retriableFailureToken;
  }

  getStatus(): GlobalOfflineStatus {
    return this.store.state.status;
  }

  getRuntimeConfig(): OfflineRuntimeConfig {
    return {
      network: { enabled: this.#isNetworkEnabled() },
      outage: { enabled: this.#isOutageEnabled() },
      mutationQueueing: {
        network: this.#resolveMutationQueueingPolicy('network'),
        outage: this.#resolveMutationQueueingPolicy('outage'),
      },
    };
  }

  getEntities(): GlobalOfflineEntity[] {
    return this.store.state.entities.map(stripInternalEntityPayload);
  }

  getResolutions(): OfflineResolutionRecord[] {
    return this.store.state.resolutions;
  }

  getUploads(): OfflineUpload[] {
    return this.store.state.uploads;
  }

  async saveUpload(args: {
    id: string;
    file: Blob | File;
    source?: 'manual' | 'mutation';
    metadata?: ValidPayload;
    /** Store whose queued mutation attaches the file. */
    storeName?: string;
  }): Promise<void> {
    if (!this.#uploadsConfig) {
      throw new Error(
        `[tsdf] Offline uploads are not configured for session "${this.sessionKey}"`,
      );
    }

    await this.#restoreStoredUploads();
    // Saving while the previous file of this id is being removed could let
    // the removal delete the new file. Waited here, before the check below,
    // so nothing yields between the check and publishing the new record.
    await this.#waitForUploadRemoval(args.id);

    // The queued or running transport marks the record as uploaded when it
    // finishes, so swapping the file under it would pair the new file with
    // the old ref.
    if (this.#uploadPromisesById.has(args.id)) {
      throw new Error(
        `Cannot change upload "${args.id}" while it is queued or uploading`,
      );
    }

    // A file staged again under a released id is a new upload.
    this.#pendingUploadReleases.delete(args.id);
    this.#releasedUploadRefs.delete(args.id);
    if (args.source === 'mutation') this.#stagedMutationUploadIds.add(args.id);

    const existing = this.#uploads.get(args.id);

    const nextRecord = createStoredUploadRecord(
      args.id,
      this.sessionKey,
      args.file,
      args.source ?? 'manual',
      undefined,
      existing?.createdAt,
      undefined,
      undefined,
      undefined,
      this.#getCurrentUploadOnlineSessionStartedAt(),
      args.metadata,
      args.storeName,
    );

    await this.#saveUploadRecord(nextRecord);
  }

  async replaceUpload(args: {
    id: string;
    file: Blob | File;
    metadata?: ValidPayload;
  }): Promise<void> {
    // Read through storage (waits for the stored uploads to be restored):
    // right after a restart the replacement must keep the persisted metadata.
    // Changing an upload that is queued or uploading is rejected by
    // `saveUpload`.
    const existing = await this.#getUploadRecord(args.id);

    await this.saveUpload({
      id: args.id,
      file: args.file,
      source: existing?.source ?? 'manual',
      metadata: args.metadata ?? existing?.metadata,
      storeName: existing?.storeName,
    });
  }

  async loadUpload(id: string): Promise<File | null> {
    const record = await this.#getUploadRecord(id);
    return record?.file ?? null;
  }

  /**
   * Latest staged file state for `id`. The first read (while rendering) starts
   * tracking the id, so a file the session already holds is returned right
   * away instead of going through a `loading` render.
   */
  getUploadFile(id: string): OfflineUploadFile {
    return this.#getUploadFileEntry(id).value;
  }

  /**
   * Registers a consumer of the staged file for `id`. Consumers of the same id
   * share one entry, so the file is read and its object URL is created once.
   */
  subscribeUploadFile(id: string, onChange: () => void): () => void {
    const entry = this.#getUploadFileEntry(id);
    const listener = (): void => onChange();

    clearTimeout(entry.releaseTimer);
    entry.listeners.add(listener);

    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0) {
        this.#scheduleUploadFileRelease(id, entry);
      }
    };
  }

  async deleteUpload(id: string): Promise<void> {
    await this.#restoreStoredUploads();
    if (this.#referencedUploadIds.has(id)) {
      throw new Error(
        `Cannot delete upload "${id}" while it is still referenced`,
      );
    }
    if (this.#uploadPromisesById.has(id)) {
      throw new Error(`Cannot delete upload "${id}" while it is uploading`);
    }
    this.#stagedMutationUploadIds.delete(id);
    this.#releasedUploadRefs.delete(id);
    await this.#removeUploads([id]);
  }

  /**
   * Deletes the given staged uploads unless queued work still needs them.
   *
   * Store controllers call this after a queue entry or resolution record left
   * the queue for good (replayed, discarded, superseded, cancelled), passing
   * the uploads that work depended on. It must run after the store synced its
   * remaining references: they are aggregated session-wide, so an upload is
   * kept while a queue entry or resolution record of any store references it.
   *
   * Uploads no queued work referenced are never passed here: the app stages a
   * file before it queues the mutation, so being unreferenced alone must not
   * delete an upload. Those are left to `deleteUpload` and to the retention
   * window.
   */
  async deleteUnreferencedUploads(uploadIds: readonly string[]): Promise<void> {
    if (this.#disposed) return;

    for (const id of uploadIds) this.#pendingUploadReleases.add(id);
    await this.#releasePendingUploads();
  }

  /**
   * Deletes the released uploads nothing references anymore. Runs again when
   * the last store reports its references and when a released upload that was
   * still being sent settles.
   */
  async #releasePendingUploads(): Promise<void> {
    if (this.#pendingUploadReleases.size === 0) return;

    // A released upload not restored from storage yet would be skipped below
    // and then listed back with nothing left to delete it.
    await this.#restoreStoredUploads();

    const cannotRelease = (): boolean =>
      this.#disposed ||
      this.#pendingUploadReleases.size === 0 ||
      // A store that has not reported its queue yet may reference the uploads.
      this.#storeContributions.size !== this.#registrations.size;
    if (cannotRelease()) return;

    // Uploads another tab staged after this tab listed the stored ones are
    // only in storage, e.g. when this tab discards work that tab queued.
    const missingIds = [...this.#pendingUploadReleases].filter(
      (id) => !this.#uploads.has(id) && !this.#uploadPromisesById.has(id),
    );
    if (missingIds.length > 0) {
      try {
        await Promise.all(missingIds.map((id) => this.#getUploadRecord(id)));
      } catch (error) {
        this.#onPersistentStorageError?.(error);
      }
      if (cannotRelease()) return;
    }

    const removableIds: string[] = [];
    for (const id of this.#pendingUploadReleases) {
      if (this.#uploadPromisesById.has(id)) continue;

      this.#pendingUploadReleases.delete(id);
      // An upload queued work references again is released again when that
      // work leaves the queue.
      const upload = this.#uploads.get(id);
      if (upload && !this.#referencedUploadIds.has(id)) {
        if (upload.state === 'uploaded' && upload.resolvedRef !== undefined) {
          this.#releasedUploadRefs.set(id, upload.resolvedRef);
        }
        removableIds.push(id);
      }
    }

    try {
      await this.#removeUploads(removableIds);
    } catch (error) {
      // The work that needed these uploads is already gone, so a failed
      // removal only leaves them to the retention window.
      this.#onPersistentStorageError?.(error);
    }
  }

  async resolveUploadIds(
    uploadIds: readonly string[],
  ): Promise<Record<string, ValidPayload>> {
    const entries = await Promise.all(
      uploadIds.map(async (id) => {
        const resolvedRef = await this.#ensureUploadResolved(id);
        return [id, resolvedRef] as const;
      }),
    );

    return Object.fromEntries(entries);
  }

  /**
   * Resolves the dependency uploads of a replaying operation. A failure is
   * returned with the id of the upload that caused it instead of thrown, and
   * leaves that upload `pending`: replay classifies the failure first and
   * calls `markUploadFailed` only when it gives up on the operation.
   */
  async resolveReplayUploadIds(
    uploadIds: readonly string[],
  ): Promise<
    | { failedUploadId?: undefined; refs: Record<string, ValidPayload> }
    | { failedUploadId: string; error: unknown }
  > {
    const failures: { failedUploadId: string; error: unknown }[] = [];

    // Rethrowing settles `Promise.all` on the first failure, so it is reported
    // without waiting for the uploads that are still running.
    const entries = await Promise.all(
      uploadIds.map(async (id) => {
        try {
          return [id, await this.#ensureUploadResolved(id, true)] as const;
        } catch (error) {
          failures.push({ failedUploadId: id, error });
          throw error;
        }
      }),
    ).catch(() => null);

    return failures[0] ?? { refs: Object.fromEntries(entries ?? []) };
  }

  /**
   * Marks the dependency uploads of an operation as `failed` after replay
   * moved it to manual resolution. Uploads still being sent are marked if
   * they fail too. Uploads that are not waiting on a failure (restarted or
   * uploaded meanwhile) are left untouched.
   *
   * Never rejects: the state only drives the upload UI, so a storage error is
   * reported instead of interrupting the replay.
   */
  async markUploadsFailed(ids: readonly string[]): Promise<void> {
    const reportError = (error: unknown) =>
      this.#onPersistentStorageError?.(error);

    const settledIds: string[] = [];
    for (const id of ids) {
      const inFlight = this.#uploadPromisesById.get(id);
      if (!inFlight) {
        settledIds.push(id);
        continue;
      }

      void inFlight.catch(() => this.#markUploadFailed(id)).catch(reportError);
    }

    await Promise.all(
      settledIds.map((id) => this.#markUploadFailed(id).catch(reportError)),
    );
  }

  async #markUploadFailed(id: string): Promise<void> {
    const record = this.#uploads.get(id);
    if (record?.state !== 'pending' || !record.lastError) return;

    await this.#updateUploadState({ id, state: 'failed' });
  }

  isLeader(): boolean {
    return this.#browserTabs.priority.getPriorityRank() <= 1;
  }

  isReplayBlocked(): boolean {
    // Queued mutations wait for the session gate to reopen. A closing noticed
    // here (e.g. between two replayed entries) is applied, so the reopen is
    // seen as one and resumes the replay
    if (!this.#syncSessionGate()) return true;
    if (this.store.state.status.isOfflineMode) return true;

    const { network, outage } = this.store.state.status;

    if (!outage.enabled && outage.active) {
      return true;
    }

    if (!network.enabled && network.active) {
      if (this.#classifiedNetworkActive) return true;

      return !this.#browserReportsOnline();
    }

    return false;
  }

  setRuntimeConfig(update: OfflineRuntimeConfigUpdate): void {
    if (update.network?.enabled !== undefined) {
      this.#setNetworkRuntimeEnabled(update.network.enabled);
    }

    if (update.outage?.enabled !== undefined) {
      this.#setOutageRuntimeEnabled(update.outage.enabled);
    }

    if (update.mutationQueueing !== undefined) {
      const nextOverrides = {
        ...(this.#mutationQueueingOverrides ?? {}),
        ...update.mutationQueueing,
      };

      this.#mutationQueueingOverrides =
        nextOverrides.network === undefined &&
        nextOverrides.outage === undefined
          ? undefined
          : nextOverrides;
    }
  }

  resetRuntimeConfig(): void {
    if (this.#networkEnabledOverride !== undefined) {
      this.#setNetworkRuntimeEnabled(undefined);
    }
    if (this.#outageEnabledOverride !== undefined) {
      this.#setOutageRuntimeEnabled(undefined);
    }
    this.#mutationQueueingOverrides = undefined;
  }

  /**
   * Turns forced offline mode on or off, shares it with the other tabs of the
   * session and resolves once it is persisted.
   */
  async setForcedOffline(forced: boolean): Promise<void> {
    if (!this.#canonicalConfig.hasNetworkConfig) {
      throw createForcedOfflineModeUnavailableError();
    }

    // Leaving re-detects the network, which can be async. The status is only
    // final, and safe to reload over, once that detection settled: a reload
    // before it would boot from a leftover "network down" status.
    await this.#applyForcedOffline(forced, true);
    await this.#persistSessionSnapshot();
  }

  #applyForcedOffline(
    forced: boolean,
    isLocalToggle = false,
  ): Promise<boolean> | undefined {
    if (this.#forcedOffline === forced) return undefined;

    this.#forcedOffline = forced;
    // A forced session is never "classified": recovery probes must not run
    // while forced, and leaving forced mode must re-detect right away instead
    // of waiting for a probe.
    this.#classifiedNetworkActive = false;
    this.store.setPartialState(
      { status: this.#deriveLocalStatus(this.store.state.status) },
      { action: 'offline-session-status' },
    );
    void this.#persistSessionSnapshot();
    // Only the tab where the toggle happened announces it. A tab applying a
    // remote toggle stays quiet until its own detection settles: its
    // in-between status could put a tab that already recovered back offline.
    if (isLocalToggle) this.#publishSnapshot(forced);
    // Entering reports offline synchronously. Leaving goes through the regular
    // detection, so it recovers and replays exactly like a real reconnect.
    return this.refreshNetworkState();
  }

  #browserReportsOnline(): boolean {
    return !isWindowAvailable() || navigator.onLine !== false;
  }

  /**
   * Reads the session gate (`offlineSession.enabled`): while it is closed the
   * session behaves as if no offline session existed.
   */
  #isSessionEnabled(): boolean {
    return this.#canonicalConfig.isSessionEnabled?.() ?? true;
  }

  #isNetworkEnabled(): boolean {
    return (
      this.#canonicalConfig.hasNetworkConfig &&
      (this.#networkEnabledOverride ??
        this.#canonicalConfig.networkEnabledByDefault) &&
      this.#isSessionEnabled()
    );
  }

  #isOutageEnabled(): boolean {
    return (
      this.#canonicalConfig.hasOutageConfig &&
      (this.#outageEnabledOverride ??
        this.#canonicalConfig.outageEnabledByDefault) &&
      this.#isSessionEnabled()
    );
  }

  /**
   * Applies a flip of the session gate to the status: closing it leaves
   * offline mode, whatever the cause. Returns whether the gate is open.
   *
   * Every status write runs it first, so the flip is applied whichever path
   * notices it (a fetch, a recovery check, another tab's snapshot...).
   */
  #syncSessionGate(): boolean {
    const enabled = this.#isSessionEnabled();
    if (enabled === this.#appliedSessionEnabled) return enabled;

    this.#appliedSessionEnabled = enabled;
    if (enabled) this.#gateReopenedWithoutReplay = true;

    const wasEffectivelyOffline = this.store.state.status.isOfflineMode;
    this.#updateStatus((current) => ({
      ...current,
      network: {
        enabled: this.#isNetworkEnabled(),
        active: current.network.active,
      },
      outage: {
        enabled: this.#isOutageEnabled(),
        active: current.outage.active,
      },
    }));
    this.#syncClassifiedNetworkStateFromStatus(this.store.state.status);
    this.#handleConnectivityChange(wasEffectivelyOffline, false);

    return enabled;
  }

  #assertModeIsConfigured(mode: 'network' | 'outage'): void {
    const isConfigured =
      mode === 'network'
        ? this.#canonicalConfig.hasNetworkConfig
        : this.#canonicalConfig.hasOutageConfig;
    if (isConfigured) return;

    throw new Error(
      `Offline runtime control "${mode}.enabled" is unavailable for session "${this.sessionKey}" because offlineSession.${mode} was not configured`,
    );
  }

  #resolveMutationQueueingPolicy(
    cause: 'network' | 'outage',
  ): OfflineMutationQueueingPolicy {
    return (
      this.#mutationQueueingOverrides?.[cause] ??
      this.#canonicalConfig.mutationQueueingByDefault[cause]
    );
  }

  #setNetworkRuntimeEnabled(enabled: boolean | undefined): void {
    if (enabled !== undefined) {
      this.#assertModeIsConfigured('network');
    }

    this.#networkEnabledOverride = enabled;

    const wasEffectivelyOffline = this.store.state.status.isOfflineMode;
    const wasReplayBlocked = this.isReplayBlocked();
    this.#updateStatus((current) => ({
      ...current,
      network: {
        enabled: this.#isNetworkEnabled(),
        active: current.network.active,
      },
    }));
    this.#handleConnectivityChange(wasEffectivelyOffline, wasReplayBlocked);
    this.#syncNetworkListeners();
    void this.refreshNetworkState().then((isOffline) => {
      if (!isOffline && !this.isReplayBlocked()) {
        this.#notifyGreenCycle();
      }
    });
  }

  #setOutageRuntimeEnabled(enabled: boolean | undefined): void {
    if (enabled !== undefined) {
      this.#assertModeIsConfigured('outage');
    }

    this.#outageEnabledOverride = enabled;

    const wasEffectivelyOffline = this.store.state.status.isOfflineMode;
    const wasReplayBlocked = this.isReplayBlocked();
    this.#updateStatus((current) => ({
      ...current,
      outage: {
        enabled: this.#isOutageEnabled(),
        active: current.outage.active,
      },
    }));
    this.#handleConnectivityChange(wasEffectivelyOffline, wasReplayBlocked);
  }

  #restampHydratedStatus(
    status: GlobalOfflineStatus,
    updates: Partial<Pick<GlobalOfflineStatus, 'isLeader' | 'updatedAt'>> = {},
  ): GlobalOfflineStatus {
    const networkEnabled = this.#isNetworkEnabled();
    const outageEnabled = this.#isOutageEnabled();

    return this.#deriveLocalStatus({
      ...status,
      network: {
        enabled: networkEnabled,
        // Persisted and remote snapshots cannot clear a forced network mode
        active:
          status.network.active || (networkEnabled && this.#forcedOffline),
      },
      outage: { enabled: outageEnabled, active: status.outage.active },
      isLeader: updates.isLeader ?? status.isLeader,
      updatedAt: updates.updatedAt ?? status.updatedAt,
    });
  }

  #syncClassifiedNetworkStateFromStatus(status: GlobalOfflineStatus): void {
    this.#classifiedNetworkActive =
      status.network.active &&
      !this.#forcedOffline &&
      this.#browserReportsOnline();
  }

  #handleConnectivityChange(
    wasEffectivelyOffline: boolean,
    wasReplayBlocked: boolean,
  ): void {
    this.#syncRecoveryProbe();

    if (!wasEffectivelyOffline && this.store.state.status.isOfflineMode) {
      // Going offline is news about the backend: an `up` from before it must
      // not explain the failures after the session is back
      this.#healthUpForFailuresAt = null;
      this.#uploadOnlineSessionStartedAt = null;
      this.#stopUploadCleanupTimer();
      this.#stopUploadOnlineSessionStabilization();
      this.#notifyOfflineCycle();
      return;
    }

    if (wasEffectivelyOffline && !this.store.state.status.isOfflineMode) {
      this.#uploadOnlineSessionStartedAt = null;
      this.#stopUploadOnlineSessionStabilization();
      this.#scheduleUploadOnlineSessionStabilization();
      this.#notifyGreenCycle();
      return;
    }

    if (!wasEffectivelyOffline && wasReplayBlocked && !this.isReplayBlocked()) {
      this.#notifyGreenCycle();
    }
  }

  #applyRefreshedNetworkState(
    token: number,
    detectedOffline: boolean,
  ): boolean {
    if (token !== this.#networkStateToken) {
      return this.store.state.status.network.active;
    }

    if (!this.#isNetworkEnabled()) {
      if (
        !detectedOffline &&
        this.store.state.status.network.active &&
        !this.#classifiedNetworkActive
      ) {
        this.setNetworkActive(false, { classified: false });
      }

      if (!detectedOffline && !this.isReplayBlocked()) {
        this.#notifyGreenCycle();
      }

      return detectedOffline;
    }

    if (detectedOffline) {
      this.setNetworkActive(true, { classified: false });
      return true;
    }

    if (
      this.#classifiedNetworkActive &&
      this.#browserReportsOnline() &&
      (this.#canonicalConfig.networkRecoveryCheck ||
        this.#canonicalConfig.healthCheck)
    ) {
      this.#syncRecoveryProbe();
      return true;
    }

    this.setNetworkActive(false, { classified: false });
    return false;
  }

  /**
   * Re-checks connectivity on a hint that it may be back. Hints from several
   * stores (e.g. their window-focus handlers) share a re-check still in flight
   * instead of calling `getIsOffline` once per store.
   */
  recheckNetworkState(): void {
    if (this.#isRecheckingNetworkState) return;

    this.#isRecheckingNetworkState = true;
    void this.refreshNetworkState().finally(() => {
      this.#isRecheckingNetworkState = false;
    });
  }

  async refreshNetworkState(): Promise<boolean> {
    const sessionEnabled = this.#syncSessionGate();
    const token = ++this.#networkStateToken;

    // A closed session gate ignores network detection
    if (!sessionEnabled) return false;

    const detectedOffline = this.#getCurrentOfflineState();
    const isOffline = this.#applyRefreshedNetworkState(
      token,
      typeof detectedOffline === 'boolean'
        ? detectedOffline
        : await detectedOffline,
    );

    // The gate has reopened: once the network detection confirms the session
    // is online, mutations queued before it closed can be replayed
    if (
      this.#gateReopenedWithoutReplay &&
      !isOffline &&
      !this.isReplayBlocked()
    ) {
      this.#notifyGreenCycle();
    }

    return isOffline;
  }

  setNetworkActive(
    active: boolean,
    options: {
      classified?: boolean;
      recordFailureAt?: boolean;
      recoveryCheckAt?: number;
    } = {},
  ): void {
    // Applied before the classification below is set: applying a flip
    // re-derives it from the status
    this.#syncSessionGate();
    const wasEffectivelyOffline = this.store.state.status.isOfflineMode;
    const wasReplayBlocked = this.isReplayBlocked();
    const nextEnabled = this.#isNetworkEnabled();
    // While forced, successful requests and recovery probes are not a
    // recovery signal: only turning forced mode off clears network mode.
    const nextActive = active || (nextEnabled && this.#forcedOffline);
    this.#classifiedNetworkActive =
      nextActive && !this.#forcedOffline
        ? (options.classified ?? this.#classifiedNetworkActive)
        : false;

    const currentStatus = this.store.state.status;
    // Every `configure` call (each status read through the session, each
    // fetch) re-primes the network state; when nothing changes, writing,
    // persisting and broadcasting the status again would only re-render
    // every status subscriber.
    if (
      currentStatus.network.enabled === nextEnabled &&
      currentStatus.network.active === nextActive &&
      !(nextActive && options.recordFailureAt) &&
      (options.recoveryCheckAt === undefined ||
        options.recoveryCheckAt === currentStatus.lastRecoveryCheckAt)
    ) {
      this.#handleConnectivityChange(wasEffectivelyOffline, wasReplayBlocked);
      return;
    }

    this.#updateStatus((current) => ({
      ...current,
      network: { enabled: nextEnabled, active: nextActive },
      lastFailureAt:
        nextActive && options.recordFailureAt
          ? Date.now()
          : current.lastFailureAt,
      lastRecoveryCheckAt:
        options.recoveryCheckAt ?? current.lastRecoveryCheckAt,
    }));
    this.#handleConnectivityChange(wasEffectivelyOffline, wasReplayBlocked);
  }

  setOutageActive(
    active: boolean,
    options: { recoveryCheckAt?: number } = {},
  ): void {
    // Applied before the previous state is read below
    this.#syncSessionGate();
    const wasEffectivelyOffline = this.store.state.status.isOfflineMode;
    const wasReplayBlocked = this.isReplayBlocked();
    const nextEnabled = this.#isOutageEnabled();
    const nextActive = active;

    this.#updateStatus((current) => ({
      ...current,
      outage: { enabled: nextEnabled, active: nextActive },
      lastFailureAt: nextActive ? Date.now() : current.lastFailureAt,
      lastRecoveryCheckAt:
        options.recoveryCheckAt ?? current.lastRecoveryCheckAt,
    }));
    this.#handleConnectivityChange(wasEffectivelyOffline, wasReplayBlocked);
  }

  async classifyFailure(
    error: unknown,
    ctx: OfflineFailureContext,
  ): Promise<OfflineFailureClassification> {
    if (!this.#canClassifyFailures()) return 'ignore';

    const { classifyFailure, healthCheck } = this.#canonicalConfig;
    let result: OfflineFailureClassification | 'unknown' = 'unknown';

    if (classifyFailure) {
      const token = this.getClassificationToken();
      result = await classifyFailure(error, ctx);

      // The gate may have closed while the classifier ran
      if (!this.#canClassifyFailures()) return 'ignore';

      // An explicit answer overtaken by a newer classification is dropped.
      // An `unknown` one decides nothing by itself: it goes on to the health
      // check, whose answer is shared by every failure waiting for it
      if (result !== 'unknown' && !this.isCurrentClassificationToken(token)) {
        return 'ignore';
      }
    }

    if (result === 'unknown') {
      if (!healthCheck) return 'ignore';

      // Already offline: the active mode explains the failure, and asking
      // "are we back?" is the job of the recovery checks
      if (this.store.state.status.outage.active) return 'outage';
      if (this.store.state.status.network.active) return 'network';

      const reuseUpMs = this.#canonicalConfig.healthCheckReuseUpForFailuresMs;
      if (
        this.#healthUpForFailuresAt !== null &&
        Date.now() - this.#healthUpForFailuresAt < reuseUpMs
      ) {
        return 'ignore';
      }

      const health = await this.#checkHealth(healthCheck);

      // Only an `up` received while the session is still online starts the
      // reuse window. The check only ran because no window was live, so any
      // other answer, or none, just drops the expired timestamp
      this.#healthUpForFailuresAt =
        reuseUpMs > 0 &&
        health === 'up' &&
        !this.store.state.status.isOfflineMode
          ? Date.now()
          : null;

      if (health === null || health === 'up') return 'ignore';

      result = health === 'outage' ? 'outage' : 'network';

      // Every failure that shared the check gets here; the first one has
      // already activated the mode
      if (this.store.state.status[result].active) return result;
    }

    if (result === 'outage') {
      if (!this.#isOutageEnabled() && !this.store.state.status.outage.active) {
        return 'ignore';
      }
      this.setOutageActive(true);
      return 'outage';
    }

    if (result === 'network') {
      if (
        !this.#isNetworkEnabled() &&
        !this.store.state.status.network.active
      ) {
        return 'ignore';
      }
      this.setNetworkActive(true, { classified: true, recordFailureAt: true });
      return 'network';
    }

    return 'ignore';
  }

  /**
   * Runs `offlineSession.healthCheck`. While a check is in flight every
   * caller (failing requests, a recovery tick) gets that same call instead of
   * starting its own. A finished answer is not kept here: an `up` reused for
   * a later failure could hide an outage that started right after it, so
   * only failure classification reuses one, when the app opts in with
   * `healthCheck.reuseUpForFailuresMs`.
   *
   * Resolves with `null` when the check gave no answer (it threw or timed
   * out), which callers treat as "nothing learned".
   */
  #checkHealth(
    check: OfflineHealthCheckConfig['check'],
  ): Promise<OfflineHealthCheckResult | null> {
    this.#healthCheckInFlight ??= this.#requestHealth(check).finally(() => {
      this.#healthCheckInFlight = null;
    });

    return this.#healthCheckInFlight;
  }

  async #requestHealth(
    check: OfflineHealthCheckConfig['check'],
  ): Promise<OfflineHealthCheckResult | null> {
    const abortController = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        check({ sessionKey: this.sessionKey, signal: abortController.signal }),
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => {
            abortController.abort();
            resolve(null);
          }, this.#canonicalConfig.healthCheckTimeoutMs);
        }),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Whether classifying a failure can change anything: the session gate has
   * to be open, with a mode enabled or still active (waiting to recover).
   */
  #canClassifyFailures(): boolean {
    if (!this.#isSessionEnabled()) return false;

    const { network, outage } = this.store.state.status;

    return (
      network.active ||
      outage.active ||
      this.#isNetworkEnabled() ||
      this.#isOutageEnabled()
    );
  }

  async classifyRetriableFailure(
    error: unknown,
    ctx: OfflineFailureContext,
  ): Promise<boolean> {
    if (!this.#canonicalConfig.classifyRetriableFailure) return false;

    const token = this.getRetriableFailureToken();
    const result = await this.#canonicalConfig.classifyRetriableFailure(
      error,
      ctx,
    );

    if (!this.isCurrentRetriableFailureToken(token)) {
      return false;
    }

    return result;
  }

  #notifyGreenCycle(): void {
    if (this.store.state.status.isOfflineMode || !this.isLeader()) {
      return;
    }
    this.#gateReopenedWithoutReplay = false;
    void this.#refreshUploadRetention();
    for (const registration of this.#registrations.values()) {
      registration.onGreenCycle?.();
    }
  }

  #notifyOfflineCycle(): void {
    if (!this.store.state.status.isOfflineMode || !this.isLeader()) {
      return;
    }
    void this.#refreshUploadRetention();
    for (const registration of this.#registrations.values()) {
      registration.onOfflineCycle?.();
    }
  }

  #syncNetworkListeners(): void {
    this.#cleanupNetworkListeners?.();
    this.#cleanupNetworkListeners = null;

    if (
      !this.#canonicalConfig.hasNetworkConfig ||
      !this.#canonicalConfig.networkListenToBrowserEvents ||
      !isWindowAvailable()
    ) {
      return;
    }

    const onChange = (): void => {
      void this.refreshNetworkState();
    };

    window.addEventListener('online', onChange);
    window.addEventListener('offline', onChange);
    this.#cleanupNetworkListeners = () => {
      window.removeEventListener('online', onChange);
      window.removeEventListener('offline', onChange);
    };
  }

  #refreshNetworkConfig(): void {
    this.#syncNetworkListeners();
    this.#primeNetworkState();
    void this.refreshNetworkState();
  }

  #getCurrentOfflineState(): boolean | Promise<boolean> {
    // Forced mode is a simulated network loss, so it only counts while network
    // mode is enabled. With the mode off the real detection is what lets a
    // session that was forced offline leave network mode.
    if (this.#forcedOffline && this.#isNetworkEnabled()) return true;

    return (this.#canonicalConfig.getIsOffline ?? defaultGetIsOffline)();
  }

  #primeNetworkState(): void {
    if (!this.#isNetworkEnabled()) return;
    if (this.store.state.status.network.active) return;

    const initial = this.#getCurrentOfflineState();

    if (typeof initial === 'boolean') {
      this.setNetworkActive(initial, { classified: false });
    }
  }

  /**
   * Lists the stored uploads into memory, once per coordinator. Every upload
   * operation that reads or changes a record waits for it first: the in-memory
   * map is only authoritative after the stored records are in it, and a list
   * result applied over newer changes would drop saved uploads and bring
   * deleted ones back.
   */
  #restoreStoredUploads(): Promise<void> | undefined {
    if (!this.#uploadsConfig) return undefined;

    return (this.#storedUploadsRestore ??= this.#listStoredUploads(
      this.#uploadsConfig,
    ));
  }

  async #listStoredUploads(
    uploadsConfig: OfflineSessionUploadsConfig,
  ): Promise<void> {
    const removedWhileListing = new Set<string>();
    this.#uploadsRemovedWhileListing = removedWhileListing;
    try {
      const uploads = await uploadsConfig.adapter.list(this.sessionKey);
      // Upload operations wait for this list, so nothing should have changed
      // the map meanwhile; if a record got in anyway, it was persisted after
      // the listed one and wins. Records another tab deleted during the list
      // were read before the removal and must not come back.
      this.#uploads = new Map([
        ...uploads
          .filter((upload) => !removedWhileListing.has(upload.id))
          .map(
            (upload) =>
              [upload.id, this.#validateRestoredUpload(upload)] as const,
          ),
        ...this.#uploads,
      ]);
      this.#syncUploadsState();
    } catch (error) {
      this.#onPersistentStorageError?.(error);
    } finally {
      this.#uploadsRemovedWhileListing = null;
    }
  }

  async #getUploadRecord(
    id: string,
  ): Promise<OfflineStoredUploadRecord | null> {
    const existing = this.#uploads.get(id);
    if (existing) return existing;
    if (!this.#uploadsConfig) return null;

    await this.#restoreStoredUploads();
    const restored = this.#uploads.get(id);
    if (restored) return restored;

    // A removal in flight could still let the load find the removed record.
    await this.#waitForUploadRemoval(id);
    const loaded = await this.#uploadsConfig.adapter.load(this.sessionKey, id);
    // A save during the load already persisted a newer record; keep it.
    const current = this.#uploads.get(id);
    if (current) return current;
    if (!loaded) return null;

    const validated = this.#validateRestoredUpload(loaded);
    this.#uploads.set(id, validated);
    this.#syncUploadsState();

    return validated;
  }

  /**
   * Checks the ref of an upload record restored from the adapter against the
   * configured `resolvedRefSchema`. Records enter `#uploads` once, so each
   * stored ref is parsed once.
   */
  #validateRestoredUpload(
    upload: OfflineStoredUploadRecord,
  ): OfflineStoredUploadRecord {
    const schema = this.#uploadsConfig?.resolvedRefSchema;
    if (schema === undefined || upload.resolvedRef === undefined) return upload;

    return applyRestoredUploadRef(
      upload,
      parseRestoredUploadRef(schema, upload.resolvedRef),
    );
  }

  /** Checks the refs published by another tab against `resolvedRefSchema`. */
  #validateRemoteUploads(uploads: OfflineUpload[]): OfflineUpload[] {
    const schema = this.#uploadsConfig?.resolvedRefSchema;
    if (schema === undefined) return uploads;

    const previousValidations = this.#remoteUploadRefValidations;
    this.#remoteUploadRefValidations = new Map();

    return uploads.map((upload) => {
      if (upload.resolvedRef === undefined) return upload;

      const previous = previousValidations.get(upload.id);
      const validation =
        previous?.updatedAt === upload.updatedAt
          ? previous
          : {
              updatedAt: upload.updatedAt,
              parsedRef: parseRestoredUploadRef(schema, upload.resolvedRef),
            };
      this.#remoteUploadRefValidations.set(upload.id, validation);

      return applyRestoredUploadRef(upload, validation.parsedRef);
    });
  }

  #getUploadFileEntry(id: string): UploadFileEntry {
    const existingEntry = this.#uploadFiles.get(id);
    if (existingEntry) return existingEntry;

    const entry: UploadFileEntry = {
      listeners: new Set(),
      value: loadingUploadFile,
      releaseTimer: undefined,
    };
    this.#uploadFiles.set(id, entry);
    if (!this.#syncUploadFile(id, entry)) {
      void this.#loadUploadFile(id, entry);
    }
    // Entries are created while rendering, so the ones whose render never
    // commits (and therefore never subscribes) have to be released as well.
    this.#scheduleUploadFileRelease(id, entry);

    return entry;
  }

  /**
   * Drops the file and revokes its object URL once no hook has consumed the
   * entry for a moment. The delay keeps the URL stable across StrictMode's
   * effect replay and components that remount right away.
   */
  #scheduleUploadFileRelease(id: string, entry: UploadFileEntry): void {
    entry.releaseTimer = setTimeout(() => {
      this.#uploadFiles.delete(id);
      this.#setUploadFile(entry, loadingUploadFile);
    }, UPLOAD_FILE_RELEASE_DELAY_MS);
  }

  #setUploadFile(entry: UploadFileEntry, value: OfflineUploadFile): void {
    const previousUrl = entry.value.url;
    entry.value = value;
    if (previousUrl !== null) URL.revokeObjectURL(previousUrl);

    for (const listener of entry.listeners) listener();
  }

  /**
   * Aligns a consumed upload file with the in-memory upload records. Returns
   * `false` when the session holds no record for the id.
   */
  #syncUploadFile(id: string, entry: UploadFileEntry): boolean {
    const file = this.#uploads.get(id)?.file;

    if (!file) {
      // The upload left the session: deleted, expired or consumed.
      if (entry.value.file) this.#setUploadFile(entry, missingUploadFile);
      return false;
    }

    if (entry.value.file !== file) {
      this.#setUploadFile(entry, {
        status: 'success',
        url: URL.createObjectURL(file),
        file,
        error: null,
      });
    }
    return true;
  }

  async #loadUploadFile(id: string, entry: UploadFileEntry): Promise<void> {
    let failure: Error | undefined;

    try {
      // Waits for the stored uploads list before reading the file on its own,
      // so a file staged before a reload is read once and never reported as
      // missing too early.
      await this.#getUploadRecord(id);
    } catch (error) {
      failure = unknownToError(error);
    }

    if (
      this.#uploadFiles.get(id) !== entry ||
      this.#syncUploadFile(id, entry) ||
      entry.value.status !== 'loading'
    ) {
      return;
    }

    this.#setUploadFile(
      entry,
      failure
        ? { status: 'error', url: null, file: null, error: failure }
        : missingUploadFile,
    );
  }

  async #waitForUploadRemoval(id: string): Promise<void> {
    let removal = this.#uploadRemovals.get(id);
    while (removal) {
      await removal;
      removal = this.#uploadRemovals.get(id);
    }
  }

  async #saveUploadRecord(record: OfflineStoredUploadRecord): Promise<void> {
    if (!this.#uploadsConfig) {
      throw new Error(
        `[tsdf] Offline uploads are not configured for session "${this.sessionKey}"`,
      );
    }

    // Saving while the previous file of this id is being removed could let
    // the removal delete the new file. Only yields when a removal is in
    // flight, so callers that checked the upload state just before still
    // publish the record before anything else runs.
    const removal = this.#uploadRemovals.get(record.id);
    if (removal) await removal;
    this.#uploads.set(record.id, record);
    await this.#uploadsConfig.adapter.save(this.sessionKey, record.id, record);
    this.#syncUploadsState();
    void this.#refreshUploadRetention();
  }

  #getCurrentUploadOnlineSessionStartedAt(): number | undefined {
    if (this.store.state.status.isOfflineMode) return undefined;

    return this.#uploadOnlineSessionStartedAt ?? undefined;
  }

  #getUploadRetentionCandidates(): OfflineStoredUploadRecord[] {
    return [...this.#uploads.values()].filter(
      (upload) =>
        !this.#referencedUploadIds.has(upload.id) &&
        !this.#uploadPromisesById.has(upload.id),
    );
  }

  #stopUploadCleanupTimer(): void {
    if (this.#uploadCleanupTimer !== null) {
      clearTimeout(this.#uploadCleanupTimer);
      this.#uploadCleanupTimer = null;
    }
  }

  #stopUploadOnlineSessionStabilization(): void {
    if (this.#uploadOnlineSessionStabilizationTimer !== null) {
      clearTimeout(this.#uploadOnlineSessionStabilizationTimer);
      this.#uploadOnlineSessionStabilizationTimer = null;
    }
  }

  #scheduleUploadOnlineSessionStabilization(): void {
    if (
      this.#uploadsConfig === undefined ||
      this.store.state.status.isOfflineMode ||
      !this.isLeader() ||
      this.#uploadOnlineSessionStartedAt !== null ||
      this.#uploadOnlineSessionStabilizationTimer !== null
    ) {
      return;
    }

    this.#uploadOnlineSessionStabilizationTimer = setTimeout(() => {
      this.#uploadOnlineSessionStabilizationTimer = null;
      if (
        this.#disposed ||
        this.#uploadsConfig === undefined ||
        this.store.state.status.isOfflineMode ||
        !this.isLeader()
      ) {
        return;
      }

      this.#uploadOnlineSessionStartedAt = Date.now();
      void this.#refreshUploadRetention().catch((error: unknown) => {
        this.#onPersistentStorageError?.(error);
      });
    }, OFFLINE_UPLOAD_RETENTION_STABLE_ONLINE_MS);
  }

  async #refreshUploadRetention(): Promise<void> {
    const uploadsConfig = this.#uploadsConfig;
    const token = ++this.#uploadRetentionToken;

    this.#stopUploadCleanupTimer();
    if (
      !uploadsConfig ||
      this.store.state.status.isOfflineMode ||
      !this.isLeader()
    ) {
      this.#uploadOnlineSessionStartedAt = null;
      return;
    }

    const onlineSessionStartedAt = this.#uploadOnlineSessionStartedAt;
    if (onlineSessionStartedAt === null) {
      this.#scheduleUploadOnlineSessionStabilization();
      return;
    }

    let didChange = false;

    const candidates = this.#getUploadRetentionCandidates();
    const stampUpdates: OfflineStoredUploadRecord[] = [];
    for (const upload of candidates) {
      if (upload.lastOnlineSessionStartedAt === onlineSessionStartedAt) {
        continue;
      }

      const nextRecord: OfflineStoredUploadRecord = {
        ...upload,
        lastOnlineSessionStartedAt: onlineSessionStartedAt,
        updatedAt: Date.now(),
      };
      this.#uploads.set(nextRecord.id, nextRecord);
      stampUpdates.push(nextRecord);
    }
    if (stampUpdates.length > 0) {
      await Promise.all(
        stampUpdates.map((record) =>
          uploadsConfig.adapter.save(this.sessionKey, record.id, record),
        ),
      );
      didChange = true;
    }

    if (token !== this.#uploadRetentionToken) return;

    const now = Date.now();
    // Re-read candidates from the map after stamping since lastOnlineSessionStartedAt changed.
    const stampedCandidates = didChange
      ? candidates
          .map((c) => this.#uploads.get(c.id))
          .filter((c) => c !== undefined)
      : candidates;
    const expiredIds = stampedCandidates
      .filter((upload) => {
        if (upload.lastOnlineSessionStartedAt === undefined) return false;

        return (
          now - upload.lastOnlineSessionStartedAt >= OFFLINE_UPLOAD_RETENTION_MS
        );
      })
      .map((upload) => upload.id);

    const expiredIdSet = new Set(expiredIds);
    if (expiredIdSet.size > 0) {
      for (const id of expiredIdSet) {
        this.#uploads.delete(id);
      }
      try {
        await Promise.all(
          expiredIds.map((id) => this.#removeStoredUpload(uploadsConfig, id)),
        );
      } finally {
        this.#publishUploadsRemoved(expiredIds);
      }
      didChange = true;
    }

    if (token !== this.#uploadRetentionToken || this.#disposed) return;

    if (didChange) {
      this.#syncUploadsState();
    }

    const remainingCandidates =
      expiredIdSet.size > 0
        ? stampedCandidates.filter((upload) => !expiredIdSet.has(upload.id))
        : stampedCandidates;
    const nextExpiryAt = Math.min(
      ...remainingCandidates.flatMap((upload) =>
        upload.lastOnlineSessionStartedAt === undefined
          ? []
          : [upload.lastOnlineSessionStartedAt + OFFLINE_UPLOAD_RETENTION_MS],
      ),
    );

    if (!Number.isFinite(nextExpiryAt)) return;

    this.#uploadCleanupTimer = setTimeout(
      () => {
        this.#uploadCleanupTimer = null;
        void this.#refreshUploadRetention().catch((error: unknown) => {
          this.#onPersistentStorageError?.(error);
        });
      },
      Math.max(0, nextExpiryAt - Date.now()),
    );
  }

  #syncUploadsState(): void {
    const uploads = [...this.#uploads.values()]
      .map(stripStoredUploadFile)
      .sort((left, right) => left.id.localeCompare(right.id));

    this.store.setPartialState(
      { uploads },
      { action: 'offline-session-uploads' },
    );
    this.#publishSnapshot();

    for (const [id, entry] of this.#uploadFiles) {
      this.#syncUploadFile(id, entry);
    }
  }

  #buildNextUploadRecord(
    current: OfflineStoredUploadRecord,
    args: {
      state: OfflineUploadState;
      resolvedRef?: ValidPayload;
      progress?: OfflineUploadProgress;
      lastError?: { message: string };
    },
  ): OfflineStoredUploadRecord {
    const nextRecord: OfflineStoredUploadRecord = {
      ...current,
      state: args.state,
      updatedAt: Date.now(),
      ...(args.resolvedRef !== undefined
        ? { resolvedRef: args.resolvedRef }
        : {}),
      ...(args.progress !== undefined ? { progress: args.progress } : {}),
      ...(args.lastError !== undefined ? { lastError: args.lastError } : {}),
    };

    // A successful upload no longer reports the failure of earlier attempts.
    if (args.state === 'uploaded') delete nextRecord.lastError;

    return nextRecord;
  }

  async #updateUploadState(args: {
    id: string;
    state: OfflineUploadState;
    resolvedRef?: ValidPayload;
    progress?: OfflineUploadProgress;
    lastError?: { message: string };
    /** When true, only update in-memory state and UI without persisting to storage. */
    skipPersist?: boolean;
  }): Promise<OfflineStoredUploadRecord | null> {
    const current = await this.#getUploadRecord(args.id);
    if (!current) return null;

    const nextRecord = this.#buildNextUploadRecord(current, args);

    if (args.skipPersist) {
      this.#uploads.set(nextRecord.id, nextRecord);
      this.#syncUploadsState();
    } else {
      await this.#saveUploadRecord(nextRecord);
    }
    return nextRecord;
  }

  async #ensureUploadResolved(
    id: string,
    /**
     * Replay decides what a transport failure means after classifying it, so
     * the upload keeps waiting (`pending`) instead of becoming `failed` here.
     */
    forReplay = false,
  ): Promise<ValidPayload> {
    const existingRecord = await this.#getUploadRecord(id);
    if (!existingRecord) {
      const releasedRef = this.#releasedUploadRefs.get(id);
      if (releasedRef !== undefined) return releasedRef;
      throw new Error(`Unknown offline upload "${id}"`);
    }
    if (
      existingRecord.state === 'uploaded' &&
      existingRecord.resolvedRef !== undefined
    ) {
      return existingRecord.resolvedRef;
    }

    const existingPromise = this.#uploadPromisesById.get(id);
    if (existingPromise) return existingPromise;
    if (!this.#uploadsConfig) {
      throw new Error(
        `[tsdf] Offline uploads are not configured for session "${this.sessionKey}"`,
      );
    }
    const uploadsConfig = this.#uploadsConfig;

    const uploadPromise = this.#uploadQueue
      .resultifyAdd(async () => {
        const queuedRecord = await this.#getUploadRecord(id);
        if (!queuedRecord) {
          const releasedRef = this.#releasedUploadRefs.get(id);
          if (releasedRef !== undefined) return releasedRef;
          throw new Error(`Unknown offline upload "${id}"`);
        }
        if (
          queuedRecord.state === 'uploaded' &&
          queuedRecord.resolvedRef !== undefined
        ) {
          return queuedRecord.resolvedRef;
        }

        const file = queuedRecord.file;
        await this.#updateUploadState({
          id,
          state: 'uploading',
          progress: {
            loadedBytes: 0,
            totalBytes: queuedRecord.sizeBytes,
            progress: 0,
          },
        });

        try {
          const resolvedRef = await uploadsConfig.upload({
            id,
            sessionKey: this.sessionKey,
            file,
            metadata: queuedRecord.metadata,
            onProgress: (progress) => {
              void this.#updateUploadState({
                id,
                state: 'uploading',
                progress,
                skipPersist: true,
              });
            },
          });

          await this.#updateUploadState({
            id,
            state: 'uploaded',
            resolvedRef,
            progress: {
              loadedBytes: queuedRecord.sizeBytes,
              totalBytes: queuedRecord.sizeBytes,
              progress: 1,
            },
          });

          return resolvedRef;
        } catch (error) {
          await this.#updateUploadState({
            id,
            state: forReplay ? 'pending' : 'failed',
            lastError: {
              message: error instanceof Error ? error.message : 'Upload failed',
            },
          });
          throw error;
        }
      })
      .then((result) => {
        if (!result.ok) throw result.error;
        return result.value;
      })
      .finally(() => {
        this.#uploadPromisesById.delete(id);
        if (this.#pendingUploadReleases.has(id)) {
          void this.#releasePendingUploads();
        }
      });

    this.#uploadPromisesById.set(id, uploadPromise);
    return uploadPromise;
  }

  async #cleanupUnusedMutationUploads(): Promise<void> {
    await this.#removeUploads(
      [...this.#uploads.values()]
        // Only files of stores created in this tab: the queue of a store that
        // isn't created yet (code-split screens, the app started on another
        // screen) is not loaded, so its files look unused.
        .filter(
          (upload) =>
            upload.source === 'mutation' &&
            (upload.storeName !== undefined
              ? this.#registrations.has(upload.storeName)
              : // Records persisted before `storeName` existed: mutation upload
                // ids start with the id of the queue entry, `${storeName}:…`.
                [...this.#registrations.keys()].some((storeName) =>
                  upload.id.startsWith(`${storeName}:`),
                )),
        )
        .map((upload) => upload.id)
        .filter(
          (id) =>
            !this.#referencedUploadIds.has(id) &&
            !this.#uploadPromisesById.has(id) &&
            !this.#stagedMutationUploadIds.has(id),
        ),
    );
  }

  async #removeUploads(ids: string[]): Promise<void> {
    const uploadsConfig = this.#uploadsConfig;
    if (!uploadsConfig || ids.length === 0) return;

    try {
      await Promise.all(
        ids.map((id) => {
          this.#uploads.delete(id);
          return this.#removeStoredUpload(uploadsConfig, id);
        }),
      );
    } finally {
      // The ids already left `#uploads`, so publish that even when a storage
      // removal failed.
      this.#syncUploadsState();
      this.#publishUploadsRemoved(ids);
    }
    void this.#refreshUploadRetention();
  }

  /** Tells the other tabs that this tab deleted these stored uploads. */
  #publishUploadsRemoved(ids: readonly string[]): void {
    // A tab opened later lists the stored uploads, so it has nothing to drop.
    if (this.#disposed || ids.length === 0 || !this.hasOtherTabs()) return;

    const releasedRefs: Array<[string, ValidPayload]> = [];
    for (const id of ids) {
      const ref = this.#releasedUploadRefs.get(id);
      if (ref !== undefined) releasedRefs.push([id, ref]);
    }
    this.#browserTabs.coordinator.publish({
      kind: 'offline-uploads-removed',
      ids: [...ids],
      releasedRefs,
    });
  }

  #applyRemoteUploadsRemoved(
    ids: readonly string[],
    releasedRefs: ReadonlyArray<readonly [string, ValidPayload]>,
  ): void {
    const removedIds = new Set(ids);
    for (const id of removedIds) {
      // An explicitly deleted upload carries no ref, so the id stops
      // resolving here too.
      this.#releasedUploadRefs.delete(id);
      this.#pendingUploadReleases.delete(id);
      this.#uploads.delete(id);
      this.#uploadsRemovedWhileListing?.add(id);
    }
    const schema = this.#uploadsConfig?.resolvedRefSchema;
    for (const [id, ref] of releasedRefs) {
      // A ref failing the schema can't be uploaded again, since its file is
      // deleted, so the id stays unknown here.
      const parsedRef =
        schema === undefined ? ref : parseRestoredUploadRef(schema, ref);
      if (parsedRef !== undefined) this.#releasedUploadRefs.set(id, parsedRef);
    }

    // The sender already published its uploads list. Rebuilding it from this
    // tab's records and publishing it would replace that list everywhere with
    // upload states this tab never received.
    const { uploads } = this.store.state;
    if (uploads.some((upload) => removedIds.has(upload.id))) {
      this.store.setPartialState(
        { uploads: uploads.filter((upload) => !removedIds.has(upload.id)) },
        { action: 'offline-session-uploads' },
      );
    }

    // Rendered files of the removed uploads become `missing` in this tab too.
    for (const id of removedIds) {
      const entry = this.#uploadFiles.get(id);
      if (entry) this.#syncUploadFile(id, entry);
    }
  }

  /**
   * Removes an upload from the adapter, tracking the removal so a save or
   * load of the same id waits for it.
   */
  #removeStoredUpload(
    uploadsConfig: OfflineSessionUploadsConfig,
    id: string,
  ): Promise<void> {
    const removal = uploadsConfig.adapter.remove(this.sessionKey, id);
    const settled = removal.then(
      () => {},
      () => {},
    );
    this.#uploadRemovals.set(id, settled);
    void settled.then(() => {
      if (this.#uploadRemovals.get(id) === settled) {
        this.#uploadRemovals.delete(id);
      }
    });
    return removal;
  }

  /**
   * The session-wide lists: this tab's own stores, plus what other tabs
   * reported for the stores this tab has not attached.
   */
  #buildItemLists(): SessionStoreItems {
    const allEntities: InternalGlobalOfflineEntity[] = [];
    const attemptedCreationEntityIds: string[] = [];
    const allResolutions: OfflineResolutionRecord[] = [];
    let hasQueuedMutations = false;
    for (const contribution of this.#storeContributions.values()) {
      if (contribution.replayHead !== null) hasQueuedMutations = true;
      allEntities.push(...contribution.entities);
      attemptedCreationEntityIds.push(
        ...contribution.attemptedCreationEntityIds,
      );
      allResolutions.push(...contribution.resolutions);
    }
    for (const [storeName, items] of this.#remoteStoreItems) {
      if (this.#storeContributions.has(storeName)) continue;
      if (items.hasQueuedMutations) hasQueuedMutations = true;
      allEntities.push(...items.entities);
      attemptedCreationEntityIds.push(...items.attemptedCreationEntityIds);
      allResolutions.push(...items.resolutions);
    }

    return {
      entities: dedupeById(allEntities),
      attemptedCreationEntityIds,
      resolutions: dedupeById(allResolutions),
      hasQueuedMutations,
    };
  }

  #refreshAggregates(publish = true): void {
    const referencedUploadIds = new Set<string>();
    const nextProtectedKeysByAdapter = new Map<StorageAdapter, string[]>();
    for (const contribution of this.#storeContributions.values()) {
      for (const uploadId of contribution.referencedUploadIds) {
        referencedUploadIds.add(uploadId);
      }
      const existing =
        nextProtectedKeysByAdapter.get(contribution.adapter) ?? [];
      existing.push(...contribution.protectedKeys);
      nextProtectedKeysByAdapter.set(contribution.adapter, existing);
    }
    const {
      entities,
      attemptedCreationEntityIds,
      resolutions,
      hasQueuedMutations,
    } = this.#buildItemLists();
    for (const [adapter, keys] of nextProtectedKeysByAdapter) {
      nextProtectedKeysByAdapter.set(adapter, [...new Set(keys)].sort());
    }

    const nextProtectedKeys = [
      ...new Set([...nextProtectedKeysByAdapter.values()].flat()),
    ].sort();
    // The tab that made a change already updated the stored protection. This
    // tab only knows its own stores, so syncing here would drop the
    // protection of stores attached only in other tabs.
    const adaptersToSync = publish
      ? new Set<StorageAdapter>([
          ...this.#protectedKeysByAdapter.keys(),
          ...nextProtectedKeysByAdapter.keys(),
        ])
      : new Set<StorageAdapter>();

    const debugLogger = this.#debugLogger;
    const sessionKey = this.sessionKey;
    const emitSyncProtectedKeysLog = (
      adapterKind: 'local-sync' | 'async',
      status: 'success' | 'error',
      count: number,
      startTime: number | null,
      error?: unknown,
    ): void => {
      if (!import.meta.env.DEV) return;
      if (!debugLogger) return;

      const details: Record<string, unknown> = {
        adapter: adapterKind,
        count,
        sessionKey,
        status,
        storeName: '_offline_',
      };
      if (startTime !== null) {
        details.durationMs = getTSDFDebugTimingMs() - startTime;
      }
      if (error !== undefined) {
        details.error = error;
      }

      emitTSDFDebugLog(debugLogger, {
        area: 'persistent-storage',
        level: status === 'error' ? 'error' : 'log',
        message: `persistent storage sync-protected-keys ${status}`,
        operation: 'sync-protected-keys',
        details,
      });
    };

    for (const adapter of adaptersToSync) {
      const previousProtectedKeys =
        this.#protectedKeysByAdapter.get(adapter) ?? [];
      const nextAdapterProtectedKeys =
        nextProtectedKeysByAdapter.get(adapter) ?? [];
      if (arraysEqual(previousProtectedKeys, nextAdapterProtectedKeys)) {
        continue;
      }

      const localStorageAdapter = getLocalStorageAdapter(adapter);
      if (localStorageAdapter !== null) {
        localStorageAdapter.syncSessionProtectedKeys(
          this.sessionKey,
          nextAdapterProtectedKeys,
        );
        if (import.meta.env.DEV) {
          emitSyncProtectedKeysLog(
            'local-sync',
            'success',
            nextAdapterProtectedKeys.length,
            null,
          );
        }
        continue;
      }

      if (adapter !== 'local-sync') {
        const startTime =
          import.meta.env.DEV && debugLogger ? getTSDFDebugTimingMs() : null;
        void adapter
          .syncSessionProtectedKeys(
            this.sessionKey,
            nextAdapterProtectedKeys,
            previousProtectedKeys,
          )
          .then(() => {
            if (import.meta.env.DEV) {
              emitSyncProtectedKeysLog(
                'async',
                'success',
                nextAdapterProtectedKeys.length,
                startTime,
              );
            }
          })
          .catch((error: unknown) => {
            if (import.meta.env.DEV) {
              emitSyncProtectedKeysLog(
                'async',
                'error',
                nextAdapterProtectedKeys.length,
                startTime,
                error,
              );
            }
            this.#onPersistentStorageError?.(error);
          });
      }
    }
    if (publish) this.#protectedKeysByAdapter = nextProtectedKeysByAdapter;
    this.#referencedUploadIds = referencedUploadIds;
    for (const id of this.#stagedMutationUploadIds) {
      if (referencedUploadIds.has(id)) this.#stagedMutationUploadIds.delete(id);
    }

    if (!arraysEqual(this.#protectedKeys, nextProtectedKeys)) {
      this.#protectedKeys = nextProtectedKeys;
      setSessionProtectedKeysSnapshot(this.sessionKey, nextProtectedKeys);
    }

    this.store.setPartialState(
      { entities, attemptedCreationEntityIds, resolutions, hasQueuedMutations },
      { action: 'offline-session-aggregate' },
    );
    void this.#persistSessionSnapshot();
    if (publish) this.#publishSnapshot();
    // Another tab's changes arrive one record at a time (e.g. a superseded
    // queue entry is removed before its replacement is saved), so an upload
    // can look unused in between. The tab that made the change cleans up.
    if (
      publish &&
      this.#uploadsConfig &&
      this.#storeContributions.size === this.#registrations.size
    ) {
      if (this.#uploads.size > 0) void this.#cleanupUnusedMutationUploads();
      // Released uploads may only be in storage (staged by another tab), so
      // this doesn't depend on the in-memory records.
      void this.#releasePendingUploads();
    }
  }

  #stampLocalStatus(status: GlobalOfflineStatus): GlobalOfflineStatus {
    return { ...status, isLeader: this.isLeader(), updatedAt: Date.now() };
  }

  #deriveLocalStatus(status: GlobalOfflineStatus): GlobalOfflineStatus {
    // A closed session gate drops every offline cause, wherever it comes from
    // (detection, classification, another tab or the persisted snapshot)
    const gatedStatus = this.#isSessionEnabled()
      ? status
      : { ...status, network: INACTIVE_MODE, outage: INACTIVE_MODE };
    const isOfflineMode = getIsOfflineModeFromStatus(gatedStatus);

    return this.#stampLocalStatus({
      ...gatedStatus,
      isOfflineMode,
      isForcedOffline: this.#forcedOffline,
    });
  }

  #updateStatus(
    updater: (status: GlobalOfflineStatus) => GlobalOfflineStatus,
  ): void {
    // The status is derived with the current gate: a flip nothing applied
    // yet has to be applied first, or it would be absorbed without its side
    // effects (the replay owed on reopen, the recovery probe stopped on close)
    this.#syncSessionGate();
    const derived = this.#deriveLocalStatus(updater(this.store.state.status));

    this.store.setPartialState(
      { status: derived },
      { action: 'offline-session-status' },
    );
    void this.#persistSessionSnapshot();
    this.#publishSnapshot();
  }

  #syncLeadershipState(): boolean {
    const nextIsLeader = this.isLeader();
    if (this.store.state.status.isLeader === nextIsLeader) return false;

    this.store.setPartialState(
      { status: this.#stampLocalStatus(this.store.state.status) },
      { action: 'offline-session-leadership' },
    );
    return true;
  }

  #publishSnapshot(forcedOfflineToggle?: boolean): void {
    if (this.#disposed) return;
    const status = this.store.state.status;
    const contributions = [...this.#storeContributions.values()];
    this.#browserTabs.coordinator.publish({
      kind: 'offline-session-snapshot',
      status,
      storeNames: [...this.#storeContributions.keys()],
      entities: contributions.flatMap((contribution) => contribution.entities),
      attemptedCreationEntityIds: contributions.flatMap(
        (contribution) => contribution.attemptedCreationEntityIds,
      ),
      resolutions: contributions.flatMap(
        (contribution) => contribution.resolutions,
      ),
      uploads: this.store.state.uploads,
      queuedStoreNames: [...this.#storeContributions]
        .filter(([, contribution]) => contribution.replayHead !== null)
        .map(([storeName]) => storeName),
      ...(forcedOfflineToggle !== undefined
        ? { forcedOffline: forcedOfflineToggle }
        : undefined),
    });
  }

  #applyRemoteSnapshot(message: SessionSnapshotMessage): void {
    // Each tab only reports its own stores, so their items always apply,
    // while the session-wide status and uploads follow the newest snapshot.
    const attemptedCreationEntityIds = message.attemptedCreationEntityIds;
    for (const storeName of message.storeNames) {
      const entities = message.entities.filter(
        (entity) => entity.storeName === storeName,
      );
      this.#remoteStoreItems.set(storeName, {
        entities,
        attemptedCreationEntityIds: attemptedCreationEntityIds
          ? entities
              .filter((entity) =>
                attemptedCreationEntityIds.includes(entity.id),
              )
              .map((entity) => entity.id)
          : [],
        resolutions: message.resolutions.filter(
          (resolution) => resolution.storeName === storeName,
        ),
        hasQueuedMutations: message.queuedStoreNames.includes(storeName),
      });
    }

    if (message.sentAt < this.#lastRemoteSnapshotAt) {
      this.store.setPartialState(this.#buildItemLists(), {
        action: 'offline-session-remote',
      });
      void this.#persistSessionSnapshot();
      return;
    }
    this.#lastRemoteSnapshotAt = message.sentAt;
    // The snapshot is derived with the current gate, like a local write
    this.#syncSessionGate();
    const wasEffectivelyOffline = this.store.state.status.isOfflineMode;
    const wasReplayBlocked = this.isReplayBlocked();

    // This tab's own detection wins over another tab saying the network is
    // back: tabs do not get the browser's online event at the same instant,
    // and replaying on another tab's word would send requests that fail.
    // Detected means offline without a classified request failure, so this
    // tab's own `getIsOffline` check put it there; that check is not called
    // again here, since it may be an async probe and would run on every
    // snapshot of every tab.
    const isDetectedOffline =
      this.#isNetworkEnabled() &&
      ((this.store.state.status.network.active &&
        !this.#classifiedNetworkActive) ||
        !this.#browserReportsOnline());

    this.store.setState(
      {
        status: this.#restampHydratedStatus(
          isDetectedOffline
            ? {
                ...message.status,
                network: { ...message.status.network, active: true },
              }
            : message.status,
          { isLeader: this.isLeader(), updatedAt: Date.now() },
        ),
        // Stores attached in this tab keep their own records: this tab's
        // queue already follows every tab's changes, while the other tab's
        // snapshot may have been taken before it saw this tab's latest one.
        // The snapshot only fills in stores this tab has not loaded.
        ...this.#buildItemLists(),
        uploads: this.#validateRemoteUploads(message.uploads),
      },
      { action: 'offline-session-remote' },
    );
    // A detected offline state stays this tab's own: classifying it would
    // run the network recovery probe for it, which only checks request
    // failures, not the app's connectivity check.
    if (!isDetectedOffline) {
      this.#syncClassifiedNetworkStateFromStatus(this.store.state.status);
    }
    void this.#persistSessionSnapshot();
    this.#refreshLeadership();
    // Another tab can report the recovery before this tab detects it. Without
    // this, the tab's own detection would then find nothing left to change
    // and its queued work would never be replayed.
    this.#handleConnectivityChange(wasEffectivelyOffline, wasReplayBlocked);
  }

  #shouldPersistSessionSnapshot(): boolean {
    return (
      this.#forcedOffline ||
      this.store.state.status.isOfflineMode ||
      this.store.state.entities.length > 0 ||
      this.store.state.resolutions.length > 0 ||
      this.#protectedKeys.length > 0
    );
  }

  async #persistSessionSnapshot(): Promise<void> {
    if (!this.#hasCanonicalConfig && !this.#bootstrapStatusFromLocalStorage) {
      return;
    }

    if (!this.#shouldPersistSessionSnapshot()) {
      if (!this.#hasPersistedSessionSnapshot) return;

      await this.#sessionHandle.clear();
      this.#hasPersistedSessionSnapshot = false;
      this.#lastPersistedStatus = null;
      return;
    }

    if (
      this.#hasPersistedSessionSnapshot &&
      this.#lastPersistedStatus !== null &&
      deepEqual(this.#lastPersistedStatus, this.store.state.status)
    ) {
      return;
    }

    // Also marked before the write settles: a status that stops needing
    // persistence while this write is still pending (e.g. forced offline mode
    // toggled on and off in a row) must still clear the snapshot afterwards.
    this.#hasPersistedSessionSnapshot = true;
    await this.#sessionHandle.saveNow({ status: this.store.state.status });
    this.#hasPersistedSessionSnapshot = true;
    this.#lastPersistedStatus = this.store.state.status;
  }

  #refreshLeadership(): void {
    const leadershipChanged = this.#syncLeadershipState();

    if (!this.isLeader()) {
      this.#stopRecoveryProbe();
      this.#stopUploadCleanupTimer();
      this.#stopUploadOnlineSessionStabilization();
      return;
    }

    if (leadershipChanged && !this.store.state.status.isOfflineMode) {
      this.#scheduleUploadOnlineSessionStabilization();
      this.#notifyGreenCycle();
    }

    this.#syncRecoveryProbe();
  }

  #getRecoveryProbeDelay(
    probeConfig: Required<OfflineRecoveryProbeConfig>,
  ): number {
    const baseDelay = Math.min(
      probeConfig.initialIntervalMs *
        Math.max(1, probeConfig.backoffMultiplier ** this.#recoveryAttempt),
      probeConfig.maxIntervalMs,
    );
    const jitter = baseDelay * probeConfig.jitterRatio;

    return Math.max(
      0,
      Math.round(baseDelay + (Math.random() * jitter * 2 - jitter)),
    );
  }

  #getDesiredRecoveryTarget(): SessionRecoveryTarget | null {
    if (this.#disposed || !this.isLeader() || this.#registrations.size === 0) {
      return null;
    }

    const { networkRecoveryCheck, outageRecoveryCheck, healthCheck } =
      this.#canonicalConfig;

    if (
      this.store.state.status.network.active &&
      this.#classifiedNetworkActive &&
      this.#browserReportsOnline() &&
      (networkRecoveryCheck || healthCheck)
    ) {
      return {
        mode: 'network',
        recoveryCheck: networkRecoveryCheck,
        recoveryProbe: this.#canonicalConfig.networkRecoveryProbe,
      };
    }

    if (
      this.store.state.status.outage.active &&
      !this.store.state.status.network.active &&
      (outageRecoveryCheck || healthCheck)
    ) {
      return {
        mode: 'outage',
        recoveryCheck: outageRecoveryCheck,
        recoveryProbe: this.#canonicalConfig.outageRecoveryProbe,
      };
    }

    return null;
  }

  #scheduleRecoveryProbe(target: SessionRecoveryTarget): void {
    // A probe may already be armed: the status can change while a recovery
    // check is in flight, which re-arms the probe before that check settles
    // and gets here too. Only one timer may survive, or each would keep its
    // own probe loop running
    if (this.#recoveryTimer !== null) clearTimeout(this.#recoveryTimer);

    this.#scheduledRecoveryMode = target.mode;
    this.#recoveryTimer = setTimeout(() => {
      this.#recoveryTimer = null;
      this.#scheduledRecoveryMode = null;
      void this.#runRecoveryProbe(target);
    }, this.#getRecoveryProbeDelay(target.recoveryProbe));
  }

  async #runRecoveryProbe(target: SessionRecoveryTarget): Promise<void> {
    // A gate closed since the probe was armed leaves offline mode, which
    // stops the probe before it calls the check
    this.#syncSessionGate();
    const nextTarget = this.#getDesiredRecoveryTarget();
    if (nextTarget === null || nextTarget.mode !== target.mode) {
      return;
    }

    const { healthCheck, outageRecoveryCheck } = this.#canonicalConfig;
    let recovered = false;
    // Answer of the session health check, when the mode has no probe of its
    // own
    let health: OfflineHealthCheckResult | null = null;

    if (nextTarget.recoveryCheck) {
      try {
        recovered = await nextTarget.recoveryCheck({
          sessionKey: this.sessionKey,
        });
      } catch {
        recovered = false;
      }
    } else if (healthCheck) {
      health = await this.#checkHealth(healthCheck);
      recovered = health === 'up';
    }

    // Disposed while the check was in flight: its answer must not touch the
    // status, wake up the stores or re-arm the probe timer
    if (this.#disposed) return;

    const recoveryCheckAt = Date.now();

    if (recovered) {
      this.#recoveryAttempt = 0;
      if (target.mode === 'network') {
        this.setNetworkActive(false, { classified: false, recoveryCheckAt });

        // A healthy backend also ends an outage that waits for the same
        // health check, without spending a second check on it
        if (
          health === 'up' &&
          !outageRecoveryCheck &&
          this.store.state.status.outage.active &&
          !this.store.state.status.network.active
        ) {
          this.setOutageActive(false, { recoveryCheckAt });
        }
        return;
      }

      this.setOutageActive(false, { recoveryCheckAt });
      return;
    }

    if (target.mode === 'network' && health === 'outage') {
      // The backend is reachable again but down: the network cause is over.
      // Outage mode takes over first (when it can be entered), so the
      // session is not seen as online in between
      if (!this.store.state.status.outage.active && this.#isOutageEnabled()) {
        this.setOutageActive(true, { recoveryCheckAt });
      }
      this.setNetworkActive(false, { classified: false, recoveryCheckAt });
      return;
    }

    if (
      target.mode === 'outage' &&
      health === 'unreachable' &&
      this.#isNetworkEnabled()
    ) {
      // Nothing can be said about the outage while the backend cannot be
      // reached: it is kept, and network mode leads the recovery from here
      this.setNetworkActive(true, {
        classified: true,
        recordFailureAt: true,
        recoveryCheckAt,
      });
      return;
    }

    this.#updateStatus((current: GlobalOfflineStatus) => ({
      ...current,
      lastRecoveryCheckAt: recoveryCheckAt,
    }));

    this.#recoveryAttempt += 1;
    const nextProbeTarget = this.#getDesiredRecoveryTarget();
    if (nextProbeTarget !== null && nextProbeTarget.mode === target.mode) {
      this.#scheduleRecoveryProbe(nextProbeTarget);
    }
  }

  #syncRecoveryProbe(): void {
    const target = this.#getDesiredRecoveryTarget();

    if (target === null) {
      this.#stopRecoveryProbe();
      return;
    }

    if (
      this.#recoveryTimer !== null &&
      this.#scheduledRecoveryMode === target.mode
    ) {
      return;
    }

    this.#stopRecoveryProbe();
    this.#scheduleRecoveryProbe(target);
  }

  #stopRecoveryProbe(): void {
    if (this.#recoveryTimer !== null) {
      clearTimeout(this.#recoveryTimer);
      this.#recoveryTimer = null;
    }
    this.#scheduledRecoveryMode = null;
    this.#recoveryAttempt = 0;
  }

  dispose(): void {
    this.#disposed = true;
    this.#stopRecoveryProbe();
    this.#stopUploadCleanupTimer();
    this.#stopUploadOnlineSessionStabilization();
    this.#cleanupNetworkListeners?.();
    this.#browserTabs.priority.close();
    this.#browserTabs.coordinator.close();
    this.#sessionHandle.dispose();
    clearSessionProtectedKeysSnapshot(this.sessionKey);
  }
}

export function createForcedOfflineModeUnavailableError(): Error {
  return new Error(
    '[tsdf] Forced offline mode requires an active session key and `offlineSession.network` to be configured',
  );
}

/**
 * Returns a session-scoped offline coordinator, creating it if needed.
 * Existing coordinators are reconfigured when adapter/configuration changes.
 */
export function getOrCreateSessionOfflineCoordinator(
  sessionKey: string,
  options: Omit<SessionCoordinatorOptions, 'sessionKey'> = {},
): SessionOfflineCoordinator {
  const existing = registry.get(sessionKey);
  if (existing) {
    existing.configure({
      adapter: options.adapter,
      onPersistentStorageError: options.onPersistentStorageError,
      ...(import.meta.env.DEV
        ? { debugLogger: options.debugLogger }
        : undefined),
      config: options.config,
      uploads: options.uploads,
    });
    return existing;
  }

  const created = new SessionOfflineCoordinator({
    sessionKey,
    ...(options.appVersion !== undefined
      ? { appVersion: options.appVersion }
      : undefined),
    adapter: options.adapter,
    onPersistentStorageError: options.onPersistentStorageError,
    ...(import.meta.env.DEV ? { debugLogger: options.debugLogger } : undefined),
    config: options.config,
    uploads: options.uploads,
    bootstrapStatusFromLocalStorage: options.bootstrapStatusFromLocalStorage,
  });
  registry.set(sessionKey, created);
  return created;
}

/**
 * Returns the latest offline status for a session. If the session has not been
 * initialized yet, this returns a default "online" status with empty recovery data.
 */
export function getGlobalOfflineStatus(
  sessionKey: string,
): GlobalOfflineStatus {
  return (
    registry.get(sessionKey)?.getStatus() ??
    resolveDefaultStatus(sessionKey, { bootstrapStatusFromLocalStorage: true })
  );
}

/**
 * Returns the latest list of offline entities for a session.
 * Useful to render pending sync state badges or pending-item indicators.
 */
export function getGlobalOfflineEntities(
  sessionKey: string,
): GlobalOfflineEntity[] {
  return registry.get(sessionKey)?.getEntities() ?? [];
}

/**
 * Returns the latest list of offline conflict/retry resolutions for a session.
 * Useful to render conflict-resolution trays or retry-required queues.
 */
export function getGlobalOfflineResolutions(
  sessionKey: string,
): OfflineResolutionRecord[] {
  return registry.get(sessionKey)?.getResolutions() ?? [];
}

/**
 * Test-only primitive for resetting just the offline session coordinator
 * registry.
 *
 * Prefer calling `resetSessionForTests()` from
 * `tests/utils/resetSessionForTests.ts` so restart-style tests reset the full
 * session/runtime boundary instead of invoking this low-level reset directly.
 */
export function __resetSessionOfflineCoordinatorRegistryForTests(): void {
  if (!import.meta.env.TEST) {
    throw new Error(
      '[tsdf] __resetSessionOfflineCoordinatorRegistryForTests is test-only',
    );
  }

  for (const coordinator of registry.values()) {
    coordinator.dispose();
  }
  registry.clear();
  defaultStatusBySession.clear();
}

export function getOfflineSessionUploadsConfig(
  session: OfflineSession,
): OfflineSessionUploadsConfig | undefined {
  return uploadsConfigByOfflineSession.get(session);
}

export function getOfflineSessionAppVersion(
  session: OfflineSession,
): string | undefined {
  return appVersionByOfflineSession.get(session);
}

export function createOfflineSession<
  TUploadRef extends ValidPayload = ValidPayload,
>(args: {
  config: OfflineSessionConfig<TUploadRef>;
  getSessionKey?: () => string | false;
  appVersion?: string;
  debugLogger?: TSDFDebugLogger;
}): OfflineSession<TUploadRef> {
  const getSessionKey = args.getSessionKey ?? (() => false);
  const { config } = args;
  const uploads = config.uploads;
  const inactiveScope = `offline-session:${Math.random().toString(36).slice(2)}`;
  const baseRuntimeConfig: OfflineRuntimeConfig = {
    network: { enabled: config.network?.enabled ?? false },
    outage: { enabled: config.outage?.enabled ?? false },
    mutationQueueing: {
      network: config.mutationQueueing?.network ?? 'allow',
      outage: config.mutationQueueing?.outage ?? 'allow',
    },
  };

  function getActiveCoordinator(
    bootstrapStatusFromLocalStorage = true,
  ): SessionOfflineCoordinator | null {
    const sessionKey = getSessionKey();
    if (sessionKey === false) return null;

    return getOrCreateSessionOfflineCoordinator(sessionKey, {
      config,
      ...(args.appVersion !== undefined
        ? { appVersion: args.appVersion }
        : undefined),
      ...(import.meta.env.DEV ? { debugLogger: args.debugLogger } : undefined),
      uploads,
      bootstrapStatusFromLocalStorage,
    });
  }

  function useSessionCoordinator(): SessionOfflineCoordinator {
    const activeSessionKey = getSessionKey();
    return useConfiguredSessionOfflineCoordinator(
      activeSessionKey === false
        ? resolveOfflineSessionScope(false, inactiveScope)
        : activeSessionKey,
      activeSessionKey === false ? undefined : config,
      activeSessionKey === false ? undefined : uploads,
      activeSessionKey !== false,
      import.meta.env.DEV ? args.debugLogger : undefined,
      args.appVersion,
    );
  }

  const session: OfflineSession<TUploadRef> = {
    getSessionKey,
    getConfig: () => config,
    getOfflineRuntimeConfig: () =>
      getActiveCoordinator()?.getRuntimeConfig() ?? baseRuntimeConfig,
    setOfflineRuntimeConfig: (update) => {
      getActiveCoordinator()?.setRuntimeConfig(update);
    },
    resetOfflineRuntimeConfig: () => {
      getActiveCoordinator()?.resetRuntimeConfig();
    },
    setForcedOfflineMode: async (forced) => {
      const coordinator = getActiveCoordinator();
      if (!coordinator) throw createForcedOfflineModeUnavailableError();

      await coordinator.setForcedOffline(forced);
    },
    getOfflineStatus: () => {
      const sessionKey = getSessionKey();
      if (sessionKey === false) {
        return resolveDefaultStatus(
          resolveOfflineSessionScope(false, inactiveScope),
        );
      }

      return (
        getActiveCoordinator()?.getStatus() ??
        getGlobalOfflineStatus(sessionKey)
      );
    },
    getOfflineEntities: () => {
      const sessionKey = getSessionKey();
      if (sessionKey === false) return [];

      return (
        getActiveCoordinator(false)?.getEntities() ??
        getGlobalOfflineEntities(sessionKey)
      );
    },
    getOfflineResolutions: () => {
      const sessionKey = getSessionKey();
      if (sessionKey === false) return [];

      return (
        getActiveCoordinator(false)?.getResolutions() ??
        getGlobalOfflineResolutions(sessionKey)
      );
    },
    getOfflineUploads: () => {
      const sessionKey = getSessionKey();
      if (sessionKey === false) return [];

      return castUploads<TUploadRef>(
        getActiveCoordinator(false)?.getUploads() ?? [],
      );
    },
    resolveOfflineUpload: async (id) => {
      const coordinator = getActiveCoordinator();
      if (!coordinator) {
        throw new Error(
          `[tsdf] Offline uploads are not configured for inactive session scope "${inactiveScope}"`,
        );
      }
      const resolvedRef = (await coordinator.resolveUploadIds([id]))[id];
      if (resolvedRef === undefined) {
        throw new Error(`Unknown offline upload "${id}"`);
      }
      return castResolvedUploadRef<TUploadRef>(resolvedRef);
    },
    resolveOfflineUploads: async (ids) => {
      const coordinator = getActiveCoordinator();
      if (!coordinator) {
        throw new Error(
          `[tsdf] Offline uploads are not configured for inactive session scope "${inactiveScope}"`,
        );
      }
      return castResolvedUploadRefs<TUploadRef>(
        await coordinator.resolveUploadIds(ids),
      );
    },
    saveOfflineUpload: ({ id, file, metadata }) => {
      const coordinator = getActiveCoordinator();
      if (!coordinator) return Promise.resolve();
      return coordinator.saveUpload({ id, file, metadata, source: 'manual' });
    },
    replaceOfflineUpload: ({ id, file, metadata }) => {
      const coordinator = getActiveCoordinator();
      if (!coordinator) return Promise.resolve();
      return coordinator.replaceUpload({ id, file, metadata });
    },
    loadOfflineUpload: (id) => {
      const coordinator = getActiveCoordinator();
      if (!coordinator) return Promise.resolve(null);
      return coordinator.loadUpload(id);
    },
    deleteOfflineUpload: (id) => {
      const coordinator = getActiveCoordinator();
      if (!coordinator) return Promise.resolve();
      return coordinator.deleteUpload(id);
    },
    useOfflineStatus: () => {
      const coordinator = useSessionCoordinator();
      const statusSelector = useCallback(
        (state: SessionStoreState) => state.status,
        [],
      );

      return coordinator.store.useSelector(statusSelector);
    },
    useOfflineEntities: () => {
      const coordinator = useSessionCoordinator();
      const entitiesSelector = useCallback(
        (state: SessionStoreState) =>
          state.entities.map(stripInternalEntityPayload),
        [],
      );

      return coordinator.store.useSelector(entitiesSelector, {
        equalityFn: deepEqual,
      });
    },
    useOfflineResolutions: () => {
      const coordinator = useSessionCoordinator();
      const resolutionsSelector = useCallback(
        (state: SessionStoreState) => state.resolutions,
        [],
      );

      return coordinator.store.useSelector(resolutionsSelector, {
        equalityFn: deepEqual,
      });
    },
    useOfflineUploads: () => {
      const coordinator = useSessionCoordinator();
      const uploadsSelector = useCallback(
        (state: SessionStoreState) => state.uploads,
        [],
      );

      return castUploads<TUploadRef>(
        coordinator.store.useSelector(uploadsSelector, {
          equalityFn: deepEqual,
        }),
      );
    },
    useOfflineUploadFile: (id) => {
      const coordinator = useSessionCoordinator();
      const subscribe = useCallback(
        (onChange: () => void) =>
          id ? coordinator.subscribeUploadFile(id, onChange) : noop,
        [coordinator, id],
      );
      const getSnapshot = useCallback(
        () => (id ? coordinator.getUploadFile(id) : idleUploadFile),
        [coordinator, id],
      );

      return useSyncExternalStore(subscribe, getSnapshot);
    },
  };

  // The upload ref type is only produced by a session and its uploads config,
  // never consumed, so typed ones are stored as their default-typed form.
  uploadsConfigByOfflineSession.set(session, uploads);
  appVersionByOfflineSession.set(session, args.appVersion);

  return session;
}

function useSessionOfflineCoordinator(
  sessionKey: string,
  bootstrapStatusFromLocalStorage = false,
): SessionOfflineCoordinator {
  return useMemo(
    () =>
      registry.get(sessionKey) ??
      getOrCreateSessionOfflineCoordinator(sessionKey, {
        bootstrapStatusFromLocalStorage,
      }),
    [bootstrapStatusFromLocalStorage, sessionKey],
  );
}

function useConfiguredSessionOfflineCoordinator(
  sessionKey: string,
  config: OfflineSessionConfig | undefined,
  uploads: OfflineSessionUploadsConfig | undefined,
  bootstrapStatusFromLocalStorage = false,
  debugLogger?: TSDFDebugLogger,
  appVersion?: string,
): SessionOfflineCoordinator {
  return useMemo(
    () =>
      getOrCreateSessionOfflineCoordinator(sessionKey, {
        config,
        ...(appVersion !== undefined ? { appVersion } : undefined),
        ...(import.meta.env.DEV ? { debugLogger } : undefined),
        uploads,
        bootstrapStatusFromLocalStorage,
      }),
    [
      appVersion,
      bootstrapStatusFromLocalStorage,
      config,
      debugLogger,
      sessionKey,
      uploads,
    ],
  );
}

/**
 * React hook that subscribes to the offline status stream for a session.
 */
export function useGlobalOfflineStatus(
  sessionKey: string,
): GlobalOfflineStatus {
  const coordinator = useSessionOfflineCoordinator(sessionKey, true);
  const statusSelector = useCallback(
    (state: SessionStoreState) => state.status,
    [],
  );

  return coordinator.store.useSelector(statusSelector);
}

/**
 * React hook that subscribes to the offline entities stream for a session.
 */
export function useGlobalOfflineEntities(
  sessionKey: string,
): readonly GlobalOfflineEntity[] {
  const coordinator = useSessionOfflineCoordinator(sessionKey, true);
  const entitiesSelector = useCallback(
    (state: SessionStoreState) =>
      state.entities.map(stripInternalEntityPayload),
    [],
  );

  return coordinator.store.useSelector(entitiesSelector, {
    equalityFn: deepEqual,
  });
}

/**
 * React hook returning global offline conflict/retry resolutions for a session.
 */
export function useGlobalOfflineResolutions(
  sessionKey: string,
): readonly OfflineResolutionRecord[] {
  const coordinator = useSessionOfflineCoordinator(sessionKey, true);
  const resolutionsSelector = useCallback(
    (state: SessionStoreState) => state.resolutions,
    [],
  );

  return coordinator.store.useSelector(resolutionsSelector, {
    equalityFn: deepEqual,
  });
}

/**
 * React hook returning offline entities for a specific store in a session.
 */
export function useOfflineStoreEntitiesWithPayload(args: {
  sessionKey: string | false;
  inactiveScope: string;
  storeName?: string;
}): readonly InternalGlobalOfflineEntity[] {
  const coordinator = useSessionOfflineCoordinator(
    resolveOfflineSessionScope(args.sessionKey, args.inactiveScope),
    false,
  );
  const entitiesSelector = useCallback(
    (state: SessionStoreState) => {
      if (!args.storeName) return [];

      return state.entities.filter(
        (entity) => entity.storeName === args.storeName,
      );
    },
    [args.storeName],
  );

  return coordinator.store.useSelector(entitiesSelector, {
    equalityFn: deepEqual,
  });
}

export function useOfflineStoreEntities(args: {
  sessionKey: string | false;
  inactiveScope: string;
  storeName?: string;
}): readonly GlobalOfflineEntity[] {
  const entities = useOfflineStoreEntitiesWithPayload(args);

  return useMemo(() => entities.map(stripInternalEntityPayload), [entities]);
}

/**
 * React hook returning the offline state of one item of a store, or `null`
 * when the item has no offline work. It reads the item through the keyed
 * lookup shared by all readers and keeps the previous result while the state
 * is unchanged, so a component re-renders only when its own item changes.
 */
export function useOfflineStoreItemState(
  sessionKey: string | false,
  inactiveScope: string,
  storeName: string | undefined,
  itemKey: string | null,
): ItemOfflineState | null {
  const coordinator = useSessionOfflineCoordinator(
    resolveOfflineSessionScope(sessionKey, inactiveScope),
    false,
  );
  const itemStateSelector = useCallback(
    (state: SessionStoreState) =>
      storeName === undefined || itemKey === null
        ? null
        : toItemOfflineState(
            getOfflineStoreEntityLookup(state.entities, storeName).get(itemKey),
            state.attemptedCreationEntityIds,
          ),
    [itemKey, storeName],
  );

  return coordinator.store.useSelector(itemStateSelector, {
    equalityFn: deepEqual,
  });
}

/**
 * React hook returning whether a session or inactive scope is in offline mode.
 * Only this flag is selected, so the other status changes (e.g. `updatedAt`)
 * don't re-render the store hooks using it.
 */
export function useOfflineStoreIsOfflineMode(args: {
  sessionKey: string | false;
  inactiveScope: string;
}): boolean {
  const coordinator = useSessionOfflineCoordinator(
    resolveOfflineSessionScope(args.sessionKey, args.inactiveScope),
    false,
  );

  return coordinator.store.useSelector(selectIsOfflineMode);
}

function selectIsOfflineMode(state: SessionStoreState): boolean {
  return state.status.isOfflineMode;
}

/**
 * React hook returning offline conflict/retry resolutions for a specific store in a session.
 */
export function useOfflineStoreResolutions(args: {
  sessionKey: string | false;
  inactiveScope: string;
  storeName?: string;
}): readonly OfflineResolutionRecord[] {
  const coordinator = useSessionOfflineCoordinator(
    resolveOfflineSessionScope(args.sessionKey, args.inactiveScope),
    false,
  );
  const resolutionsSelector = useCallback(
    (state: SessionStoreState) => {
      if (!args.storeName) return [];

      return state.resolutions.filter(
        (resolution) => resolution.storeName === args.storeName,
      );
    },
    [args.storeName],
  );

  return coordinator.store.useSelector(resolutionsSelector, {
    equalityFn: deepEqual,
  });
}
