import { createAsyncQueue } from '@ls-stack/utils/asyncQueue';
import { deepEqual } from '@ls-stack/utils/deepEqual';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { useCallback, useMemo } from 'react';
import { rc_object, rc_parse } from 'runcheck';
import { Store } from 't-state';
import type { BrowserTabsTabStatusMessage } from '../../utils/browserTabsPriority';
import {
  createBrowserTabsCoordinatorWithPriority,
  type BrowserTabsMessageMeta,
} from '../../utils/browserTabsSync';
import type { ValidPayload } from '../../utils/storeShared';
import { parseCompactLocalStorageEntry } from '../compactLocalStorageEntry';
import { registerOfflineUploadAdapterForSession } from '../offlineUploadRegistry';
import {
  createStoredUploadRecord,
  stripStoredUploadFile,
} from '../offlineUploadsShared';
import type {
  OfflineSessionUploadsConfig,
  OfflineStoredUploadRecord,
  OfflineUpload,
  OfflineUploadProgress,
  OfflineUploadState,
} from '../offlineUploadTypes';
import {
  createPersistentStorageHandle,
  getLocalStorageAdapter,
  readProtectedStorageKeys,
  type PersistentStorageHandle,
} from '../persistentStorageManager';
import type { StorageAdapter } from '../types';
import {
  clearSessionProtectedKeysSnapshot,
  setSessionProtectedKeysSnapshot,
} from './sessionProtectionRegistry';
import type {
  GlobalOfflineEntity,
  InternalGlobalOfflineEntity,
  GlobalOfflineStatus,
  OfflineFailureClassification,
  OfflineFailureContext,
  OfflineMutationQueueingPolicy,
  OfflineNetworkModeConfig,
  OfflineOutageModeConfig,
  OfflineRecoveryProbeConfig,
  OfflineResolutionRecord,
  OfflineRuntimeConfig,
  OfflineRuntimeConfigUpdate,
  OfflineSession,
  OfflineSessionConfig,
} from './types';
import {
  COMPACT_OFFLINE_STATUS_FLAG,
  compactOfflineStatusSnapshotSchema,
  getIsOfflineModeFromStatus,
} from './types';

function stripInternalEntityPayload(
  entity: InternalGlobalOfflineEntity,
): GlobalOfflineEntity {
  if (!('payload' in entity)) return entity;
  const { payload: _payload, ...publicEntity } = entity;
  return publicEntity;
}

type SessionStoreState = {
  status: GlobalOfflineStatus;
  entities: InternalGlobalOfflineEntity[];
  resolutions: OfflineResolutionRecord[];
  uploads: OfflineUpload[];
};

type SessionSnapshotMessage = BrowserTabsMessageMeta & {
  kind: 'offline-session-snapshot';
  status: GlobalOfflineStatus;
  entities: InternalGlobalOfflineEntity[];
  resolutions: OfflineResolutionRecord[];
  uploads: OfflineUpload[];
};

type OfflineSessionMessage =
  | SessionSnapshotMessage
  | (BrowserTabsMessageMeta & BrowserTabsTabStatusMessage);

type SessionReplayHead = {
  storeName: string;
  entryId: string;
  queueOrder: number;
  createdAt: number;
};

type SessionStoreContribution = {
  adapter: StorageAdapter;
  entities: InternalGlobalOfflineEntity[];
  resolutions: OfflineResolutionRecord[];
  referencedUploadIds: string[];
  protectedKeys: string[];
  replayHead: SessionReplayHead | null;
};

type SessionRegistration = {
  storeName: string;
  onGreenCycle?: () => void;
  onOfflineCycle?: () => void;
};

type SessionCoordinatorOptions = {
  sessionKey: string;
  adapter?: StorageAdapter;
  onPersistentStorageError?: (error: unknown) => void;
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
const defaultGetIsOffline = () => !navigator.onLine;

const defaultStatusBySession = new Map<string, GlobalOfflineStatus>();
const registry = new Map<string, SessionOfflineCoordinator>();
const uploadsConfigByOfflineSession = new WeakMap<
  OfflineSession,
  OfflineSessionUploadsConfig | undefined
>();
const DEFAULT_UPLOAD_CONCURRENCY = 3;
const OFFLINE_UPLOAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const OFFLINE_UPLOAD_RETENTION_STABLE_ONLINE_MS = 5_000;

function createDefaultStatus(sessionKey: string): GlobalOfflineStatus {
  return {
    sessionKey,
    network: { enabled: false, active: false },
    outage: { enabled: false, active: false },
    isOfflineMode: false,
    isLeader: true,
    updatedAt: Date.now(),
    lastFailureAt: null,
    lastRecoveryCheckAt: null,
  };
}

function getOfflineStatusStorageKey(sessionKey: string): string {
  return `tsdf.${sessionKey}._o_.s`;
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
      localStorage.getItem(getOfflineStatusStorageKey(sessionKey)),
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
  recoveryCheck: (ctx: { sessionKey: string }) => Promise<boolean> | boolean;
  recoveryProbe: Required<OfflineRecoveryProbeConfig>;
};

type SessionCanonicalConfig = {
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
  outageRecoveryCheck?: OfflineOutageModeConfig['recoveryCheck'];
  outageRecoveryProbe: Required<OfflineRecoveryProbeConfig>;
};

function toCanonicalConfig(
  config: OfflineSessionConfig | undefined,
): SessionCanonicalConfig {
  return {
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
    left?.onProgress === right?.onProgress &&
    (left?.concurrency ?? DEFAULT_UPLOAD_CONCURRENCY) ===
      (right?.concurrency ?? DEFAULT_UPLOAD_CONCURRENCY)
  );
}

function eraseOfflineSession<TUploadRef extends ValidPayload>(
  session: OfflineSession<TUploadRef>,
): OfflineSession {
  // WORKAROUND: Offline sessions are runtime-identical regardless of the
  // upload-ref generic, but the coordinator registry stores them behind a
  // single shared map keyed by session identity.
  return __LEGIT_CAST__<OfflineSession, OfflineSession<TUploadRef>>(session);
}

function eraseUploadsConfig<TUploadRef extends ValidPayload>(
  uploads: OfflineSessionUploadsConfig<TUploadRef> | undefined,
): OfflineSessionUploadsConfig | undefined {
  // WORKAROUND: The coordinator keeps one upload-config slot per session and
  // treats the upload-ref generic as compile-time only, so this boundary erases
  // the specific ref type when crossing into the shared runtime registry.
  return __LEGIT_CAST__<
    OfflineSessionUploadsConfig | undefined,
    OfflineSessionUploadsConfig<TUploadRef> | undefined
  >(uploads);
}

function castUploads<TUploadRef extends ValidPayload>(
  uploads: readonly OfflineUpload[],
): readonly OfflineUpload<TUploadRef>[] {
  // WORKAROUND: The coordinator stores uploads in one shared runtime shape, and
  // the session API rebinds that same data back to the caller's compile-time
  // upload-ref generic.
  return __LEGIT_CAST__<
    readonly OfflineUpload<TUploadRef>[],
    readonly OfflineUpload[]
  >(uploads);
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

function createSessionPersistenceHandle(args: {
  sessionKey: string;
  enabled: boolean;
  onPersistentStorageError?: (error: unknown) => void;
}): PersistentStorageHandle<PersistedLocalSessionSnapshot> {
  if (!args.enabled) return createNoopPersistentStorageHandle();

  return createPersistentStorageHandle<PersistedLocalSessionSnapshot>(
    {
      storeName: '_o_.s',
      adapter: 'local-sync',
      getSessionKey: () => args.sessionKey,
      onPersistentStorageError: args.onPersistentStorageError,
    },
    {
      valueCodec: {
        serialize(snapshot) {
          return { d: serializeOfflineStatusSnapshot(snapshot.status) };
        },
        deserialize(raw) {
          return normalizePersistedLocalSessionSnapshot(args.sessionKey, raw);
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
export class SessionOfflineCoordinator {
  readonly sessionKey: string;
  readonly store: Store<SessionStoreState>;

  readonly #registrations = new Map<string, SessionRegistration>();
  readonly #storeContributions = new Map<string, SessionStoreContribution>();
  readonly #adapters = new Set<StorageAdapter>();
  #sessionHandle: PersistentStorageHandle<PersistedLocalSessionSnapshot>;
  readonly #browserTabs;
  #onPersistentStorageError: ((error: unknown) => void) | undefined;
  #uploadsConfig: OfflineSessionUploadsConfig | undefined;
  #uploads = new Map<string, OfflineStoredUploadRecord>();
  #referencedUploadIds = new Set<string>();
  #uploadQueue: ReturnType<typeof createAsyncQueue<ValidPayload>>;
  #uploadPromisesById = new Map<string, Promise<ValidPayload>>();
  #uploadCleanupTimer: ReturnType<typeof setTimeout> | null = null;
  #uploadOnlineSessionStartedAt: number | null = null;
  #uploadOnlineSessionStabilizationTimer: ReturnType<typeof setTimeout> | null =
    null;
  #uploadRetentionToken = 0;
  #cleanupNetworkListeners: (() => void) | null = null;
  #canonicalConfig: SessionCanonicalConfig;
  #hasCanonicalConfig: boolean;
  #classificationToken = 0;
  #retriableFailureToken = 0;
  #networkStateToken = 0;
  #lastRemoteSnapshotAt = 0;
  #recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  #scheduledRecoveryMode: SessionRecoveryMode | null = null;
  #recoveryAttempt = 0;
  #classifiedNetworkActive = false;
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
  readonly #bootstrapStatusFromLocalStorage: boolean;

  constructor({
    sessionKey,
    adapter,
    onPersistentStorageError,
    config,
    uploads,
    bootstrapStatusFromLocalStorage = false,
  }: SessionCoordinatorOptions) {
    this.sessionKey = sessionKey;
    this.#bootstrapStatusFromLocalStorage = bootstrapStatusFromLocalStorage;
    if (adapter !== undefined) {
      this.#adapters.add(adapter);
    }
    this.#onPersistentStorageError = onPersistentStorageError;
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
    this.#sessionHandle = createSessionPersistenceHandle({
      sessionKey,
      enabled: shouldBootstrapFromStorage,
      onPersistentStorageError,
    });
    this.#canonicalConfig = toCanonicalConfig(config);
    this.#hasCanonicalConfig = config !== undefined;
    this.#hasPersistedSessionSnapshot = bootstrappedLocalSnapshot !== null;
    this.#lastPersistedStatus = bootstrappedLocalSnapshot?.status ?? null;
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
        resolutions: [],
        uploads: [],
      }),
    });
    this.#syncClassifiedNetworkStateFromStatus(this.store.state.status);

    this.#browserTabs =
      createBrowserTabsCoordinatorWithPriority<OfflineSessionMessage>({
        storeType: 'offline',
        storeKey: `session:${sessionKey}`,
        getSessionKey: () => this.sessionKey,
        getWindowIsFocused: () => !isWindowAvailable() || !document.hidden,
        onMessage: (message) => {
          if (message.kind === 'tab-status') {
            this.#browserTabs.priority.onTabStatusMessage(
              message.tabId,
              message,
            );
            this.#refreshLeadership();
            return;
          }
          this.#applyRemoteSnapshot(message);
        },
      });

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
          readProtectedStorageKeys(adapter, this.sessionKey),
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
      try {
        const uploads = await this.#uploadsConfig.adapter.list(this.sessionKey);
        if (hydrationToken === this.#hydrationToken) {
          this.#uploads = new Map(uploads.map((upload) => [upload.id, upload]));
          this.#syncUploadsState();
          this.#scheduleUploadOnlineSessionStabilization();
          void this.#refreshUploadRetention();
        }
      } catch (error) {
        this.#onPersistentStorageError?.(error);
      }
    }
    void this.#persistSessionSnapshot();
  }

  configure(options: {
    adapter?: StorageAdapter;
    onPersistentStorageError?: (error: unknown) => void;
    config?: OfflineSessionConfig;
    uploads?: OfflineSessionUploadsConfig;
  }): void {
    if (options.adapter !== undefined) {
      this.#adapters.add(options.adapter);
    }
    if (options.onPersistentStorageError !== undefined) {
      this.#onPersistentStorageError = options.onPersistentStorageError;
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
      this.#uploadsConfig = options.uploads;
      registerOfflineUploadAdapterForSession(
        this.sessionKey,
        options.uploads.adapter,
      );
      this.#uploadQueue = createAsyncQueue<ValidPayload>({
        autoStart: true,
        concurrency: options.uploads.concurrency ?? DEFAULT_UPLOAD_CONCURRENCY,
      });
      void this.hydrate();
    }

    if (!this.#hasCanonicalConfig && options.config) {
      this.#recreatePersistenceHandles({ enabled: true });
      this.#canonicalConfig = toCanonicalConfig(options.config);
      this.#hasCanonicalConfig = true;
      void this.hydrate();
      this.#refreshNetworkConfig();
      return;
    }

    if (!this.#hasCanonicalConfig) return;

    if (options.onPersistentStorageError !== undefined) {
      this.#sessionHandle.dispose();
      this.#sessionHandle = createSessionPersistenceHandle({
        sessionKey: this.sessionKey,
        enabled: true,
        onPersistentStorageError: this.#onPersistentStorageError,
      });
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
    this.#sessionHandle = createSessionPersistenceHandle({
      sessionKey: this.sessionKey,
      enabled:
        args.enabled ??
        (this.#hasCanonicalConfig || this.#bootstrapStatusFromLocalStorage),
      onPersistentStorageError: this.#onPersistentStorageError,
    });
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
  ): void {
    if (this.#disposed) return;
    const previousContribution = this.#storeContributions.get(storeName);
    const replayHeadChanged = !replayHeadsEqual(
      previousContribution?.replayHead,
      contribution.replayHead,
    );
    this.#storeContributions.set(storeName, contribution);
    this.#refreshAggregates();
    if (replayHeadChanged) {
      this.#notifyGreenCycle();
    }
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
  }): Promise<void> {
    if (!this.#uploadsConfig) {
      throw new Error(
        `[tsdf] Offline uploads are not configured for session "${this.sessionKey}"`,
      );
    }

    const existing = this.#uploads.get(args.id);
    const nextRecord = createStoredUploadRecord({
      id: args.id,
      sessionKey: this.sessionKey,
      file: args.file,
      source: args.source ?? 'manual',
      createdAt: existing?.createdAt,
      lastOnlineSessionStartedAt:
        this.#getCurrentUploadOnlineSessionStartedAt(),
    });

    await this.#saveUploadRecord(nextRecord);
  }

  async replaceUpload(args: { id: string; file: Blob | File }): Promise<void> {
    const existing = this.#uploads.get(args.id);
    if (existing?.state === 'uploading') {
      throw new Error(`Cannot replace upload "${args.id}" while uploading`);
    }

    await this.saveUpload({
      id: args.id,
      file: args.file,
      source: existing?.source ?? 'manual',
    });
  }

  async loadUpload(id: string): Promise<File | null> {
    const record = await this.#getUploadRecord(id);
    return record?.file ?? null;
  }

  async deleteUpload(id: string): Promise<void> {
    if (this.#referencedUploadIds.has(id)) {
      throw new Error(
        `Cannot delete upload "${id}" while it is still referenced`,
      );
    }
    if (this.#uploadPromisesById.has(id)) {
      throw new Error(`Cannot delete upload "${id}" while it is uploading`);
    }
    if (!this.#uploadsConfig) return;

    this.#uploads.delete(id);
    await this.#uploadsConfig.adapter.remove(this.sessionKey, id);
    this.#syncUploadsState();
    void this.#refreshUploadRetention();
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

  isLeader(): boolean {
    return this.#browserTabs.priority.getPriorityRank() <= 1;
  }

  isReplayBlocked(): boolean {
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

  #browserReportsOnline(): boolean {
    return !isWindowAvailable() || navigator.onLine !== false;
  }

  #isNetworkEnabled(): boolean {
    return (
      this.#canonicalConfig.hasNetworkConfig &&
      (this.#networkEnabledOverride ??
        this.#canonicalConfig.networkEnabledByDefault)
    );
  }

  #isOutageEnabled(): boolean {
    return (
      this.#canonicalConfig.hasOutageConfig &&
      (this.#outageEnabledOverride ??
        this.#canonicalConfig.outageEnabledByDefault)
    );
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
      network: { enabled: networkEnabled, active: status.network.active },
      outage: { enabled: outageEnabled, active: status.outage.active },
      isLeader: updates.isLeader ?? status.isLeader,
      updatedAt: updates.updatedAt ?? status.updatedAt,
    });
  }

  #syncClassifiedNetworkStateFromStatus(status: GlobalOfflineStatus): void {
    this.#classifiedNetworkActive =
      status.network.active && this.#browserReportsOnline();
  }

  #handleConnectivityChange(
    wasEffectivelyOffline: boolean,
    wasReplayBlocked: boolean,
  ): void {
    this.#syncRecoveryProbe();

    if (!wasEffectivelyOffline && this.store.state.status.isOfflineMode) {
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
      this.#canonicalConfig.networkRecoveryCheck
    ) {
      this.#syncRecoveryProbe();
      return true;
    }

    this.setNetworkActive(false, { classified: false });
    return false;
  }

  async refreshNetworkState(): Promise<boolean> {
    const token = ++this.#networkStateToken;
    const detectedOffline = this.#getCurrentOfflineState();

    if (typeof detectedOffline === 'boolean') {
      return Promise.resolve(
        this.#applyRefreshedNetworkState(token, detectedOffline),
      );
    }

    const resolvedDetectedOffline = await Promise.resolve(detectedOffline);
    return this.#applyRefreshedNetworkState(token, resolvedDetectedOffline);
  }

  setNetworkActive(
    active: boolean,
    options: {
      classified?: boolean;
      recordFailureAt?: boolean;
      recoveryCheckAt?: number;
    } = {},
  ): void {
    const wasEffectivelyOffline = this.store.state.status.isOfflineMode;
    const wasReplayBlocked = this.isReplayBlocked();
    const nextEnabled = this.#isNetworkEnabled();
    const nextActive = active;
    this.#classifiedNetworkActive = nextActive
      ? (options.classified ?? this.#classifiedNetworkActive)
      : false;

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
    if (!this.#canonicalConfig.classifyFailure) return 'ignore';

    const token = this.getClassificationToken();
    const result = await this.#canonicalConfig.classifyFailure(error, ctx);

    if (!this.isCurrentClassificationToken(token)) {
      return 'ignore';
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

  async #getUploadRecord(
    id: string,
  ): Promise<OfflineStoredUploadRecord | null> {
    const existing = this.#uploads.get(id);
    if (existing) return existing;
    if (!this.#uploadsConfig) return null;

    const loaded = await this.#uploadsConfig.adapter.load(this.sessionKey, id);
    if (loaded) {
      this.#uploads.set(id, loaded);
      this.#syncUploadsState();
    }

    return loaded;
  }

  async #saveUploadRecord(record: OfflineStoredUploadRecord): Promise<void> {
    if (!this.#uploadsConfig) {
      throw new Error(
        `[tsdf] Offline uploads are not configured for session "${this.sessionKey}"`,
      );
    }

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
      await Promise.all(
        expiredIds.map((id) =>
          uploadsConfig.adapter.remove(this.sessionKey, id),
        ),
      );
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
    return {
      ...current,
      state: args.state,
      updatedAt: Date.now(),
      ...(args.resolvedRef !== undefined
        ? { resolvedRef: args.resolvedRef }
        : {}),
      ...(args.progress !== undefined ? { progress: args.progress } : {}),
      ...(args.lastError !== undefined ? { lastError: args.lastError } : {}),
    };
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
    if (nextRecord.progress && this.#uploadsConfig?.onProgress) {
      this.#uploadsConfig.onProgress({
        upload: stripStoredUploadFile(nextRecord),
        progress: nextRecord.progress,
      });
    }
    return nextRecord;
  }

  async #ensureUploadResolved(id: string): Promise<ValidPayload> {
    const existingRecord = await this.#getUploadRecord(id);
    if (!existingRecord) {
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
            state: 'failed',
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
      });

    this.#uploadPromisesById.set(id, uploadPromise);
    return uploadPromise;
  }

  async #cleanupUnusedMutationUploads(): Promise<void> {
    const uploadsConfig = this.#uploadsConfig;
    if (!uploadsConfig) return;

    const removableIds = [...this.#uploads.values()]
      .filter((upload) => upload.source === 'mutation')
      .map((upload) => upload.id)
      .filter(
        (id) =>
          !this.#referencedUploadIds.has(id) &&
          !this.#uploadPromisesById.has(id),
      );

    if (removableIds.length === 0) return;

    for (const id of removableIds) {
      this.#uploads.delete(id);
    }
    await Promise.all(
      removableIds.map((id) =>
        uploadsConfig.adapter.remove(this.sessionKey, id),
      ),
    );
    this.#syncUploadsState();
    void this.#refreshUploadRetention();
  }

  #refreshAggregates(): void {
    const allEntities: InternalGlobalOfflineEntity[] = [];
    const allResolutions: OfflineResolutionRecord[] = [];
    const referencedUploadIds = new Set<string>();
    const nextProtectedKeysByAdapter = new Map<StorageAdapter, string[]>();
    for (const contribution of this.#storeContributions.values()) {
      allEntities.push(...contribution.entities);
      allResolutions.push(...contribution.resolutions);
      for (const uploadId of contribution.referencedUploadIds) {
        referencedUploadIds.add(uploadId);
      }
      const existing =
        nextProtectedKeysByAdapter.get(contribution.adapter) ?? [];
      existing.push(...contribution.protectedKeys);
      nextProtectedKeysByAdapter.set(contribution.adapter, existing);
    }
    const entities = dedupeById(allEntities);
    const resolutions = dedupeById(allResolutions);
    for (const [adapter, keys] of nextProtectedKeysByAdapter) {
      nextProtectedKeysByAdapter.set(adapter, [...new Set(keys)].sort());
    }

    const nextProtectedKeys = [
      ...new Set([...nextProtectedKeysByAdapter.values()].flat()),
    ].sort();
    const adaptersToSync = new Set<StorageAdapter>([
      ...this.#protectedKeysByAdapter.keys(),
      ...nextProtectedKeysByAdapter.keys(),
    ]);
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
        continue;
      }

      if (adapter !== 'local-sync') {
        void adapter
          .syncSessionProtectedKeys(
            this.sessionKey,
            nextAdapterProtectedKeys,
            previousProtectedKeys,
          )
          .catch((error: unknown) => {
            this.#onPersistentStorageError?.(error);
          });
      }
    }
    this.#protectedKeysByAdapter = nextProtectedKeysByAdapter;
    this.#referencedUploadIds = referencedUploadIds;

    if (!arraysEqual(this.#protectedKeys, nextProtectedKeys)) {
      this.#protectedKeys = nextProtectedKeys;
      setSessionProtectedKeysSnapshot(this.sessionKey, nextProtectedKeys);
    }

    this.store.setPartialState(
      { entities, resolutions },
      { action: 'offline-session-aggregate' },
    );
    void this.#persistSessionSnapshot();
    this.#publishSnapshot();
    if (
      this.#uploadsConfig &&
      this.#uploads.size > 0 &&
      this.#storeContributions.size === this.#registrations.size
    ) {
      void this.#cleanupUnusedMutationUploads();
    }
  }

  #stampLocalStatus(status: GlobalOfflineStatus): GlobalOfflineStatus {
    return { ...status, isLeader: this.isLeader(), updatedAt: Date.now() };
  }

  #deriveLocalStatus(status: GlobalOfflineStatus): GlobalOfflineStatus {
    const isOfflineMode = getIsOfflineModeFromStatus(status);

    return this.#stampLocalStatus({ ...status, isOfflineMode });
  }

  #updateStatus(
    updater: (status: GlobalOfflineStatus) => GlobalOfflineStatus,
  ): void {
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

  #publishSnapshot(): void {
    if (this.#disposed) return;
    const status = this.store.state.status;
    this.#browserTabs.coordinator.publish({
      kind: 'offline-session-snapshot',
      status,
      entities: this.store.state.entities,
      resolutions: this.store.state.resolutions,
      uploads: this.store.state.uploads,
    });
  }

  #applyRemoteSnapshot(message: SessionSnapshotMessage): void {
    if (message.sentAt < this.#lastRemoteSnapshotAt) return;
    this.#lastRemoteSnapshotAt = message.sentAt;

    this.store.setState(
      {
        status: this.#restampHydratedStatus(message.status, {
          isLeader: this.isLeader(),
          updatedAt: Date.now(),
        }),
        entities: message.entities,
        resolutions: message.resolutions,
        uploads: message.uploads,
      },
      { action: 'offline-session-remote' },
    );
    this.#syncClassifiedNetworkStateFromStatus(this.store.state.status);
    void this.#persistSessionSnapshot();
    this.#refreshLeadership();
  }

  #shouldPersistSessionSnapshot(): boolean {
    return (
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
    if (!this.isLeader() || this.#registrations.size === 0) {
      return null;
    }

    if (
      this.store.state.status.network.active &&
      this.#classifiedNetworkActive &&
      this.#browserReportsOnline() &&
      this.#canonicalConfig.networkRecoveryCheck
    ) {
      return {
        mode: 'network',
        recoveryCheck: this.#canonicalConfig.networkRecoveryCheck,
        recoveryProbe: this.#canonicalConfig.networkRecoveryProbe,
      };
    }

    if (
      this.store.state.status.outage.active &&
      !this.store.state.status.network.active &&
      this.#canonicalConfig.outageRecoveryCheck
    ) {
      return {
        mode: 'outage',
        recoveryCheck: this.#canonicalConfig.outageRecoveryCheck,
        recoveryProbe: this.#canonicalConfig.outageRecoveryProbe,
      };
    }

    return null;
  }

  #scheduleRecoveryProbe(target: SessionRecoveryTarget): void {
    this.#scheduledRecoveryMode = target.mode;
    this.#recoveryTimer = setTimeout(async () => {
      this.#recoveryTimer = null;
      this.#scheduledRecoveryMode = null;

      const nextTarget = this.#getDesiredRecoveryTarget();
      if (nextTarget === null || nextTarget.mode !== target.mode) {
        return;
      }

      let recovered = false;

      try {
        recovered = await nextTarget.recoveryCheck({
          sessionKey: this.sessionKey,
        });
      } catch {
        recovered = false;
      }

      const recoveryCheckAt = Date.now();

      if (recovered) {
        this.#recoveryAttempt = 0;
        if (target.mode === 'network') {
          this.setNetworkActive(false, { classified: false, recoveryCheckAt });
          return;
        }

        this.setOutageActive(false, { recoveryCheckAt });
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
    }, this.#getRecoveryProbeDelay(target.recoveryProbe));
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
      config: options.config,
      uploads: options.uploads,
    });
    return existing;
  }

  const created = new SessionOfflineCoordinator({
    sessionKey,
    adapter: options.adapter,
    onPersistentStorageError: options.onPersistentStorageError,
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

export function getOfflineSessionUploadsConfig<TUploadRef extends ValidPayload>(
  session: OfflineSession<TUploadRef>,
): OfflineSessionUploadsConfig<TUploadRef> | undefined {
  // WORKAROUND: Reading from the shared weak map loses the compile-time upload
  // ref generic, so the session API rebinds the stored config to the caller's
  // known upload-ref type.
  return __LEGIT_CAST__<
    OfflineSessionUploadsConfig<TUploadRef> | undefined,
    unknown
  >(uploadsConfigByOfflineSession.get(eraseOfflineSession(session)));
}

export function createOfflineSession<
  TUploadRef extends ValidPayload = ValidPayload,
>(args: {
  config: OfflineSessionConfig;
  getSessionKey?: () => string | false;
  uploads?: OfflineSessionUploadsConfig<TUploadRef>;
}): OfflineSession<TUploadRef> {
  const getSessionKey = args.getSessionKey ?? (() => false);
  const { config, uploads } = args;
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
      uploads: eraseUploadsConfig(uploads),
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
      eraseUploadsConfig(activeSessionKey === false ? undefined : uploads),
      activeSessionKey !== false,
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
    saveOfflineUpload: ({ id, file }) => {
      const coordinator = getActiveCoordinator();
      if (!coordinator) return Promise.resolve();
      return coordinator.saveUpload({ id, file, source: 'manual' });
    },
    replaceOfflineUpload: ({ id, file }) => {
      const coordinator = getActiveCoordinator();
      if (!coordinator) return Promise.resolve();
      return coordinator.replaceUpload({ id, file });
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

      return coordinator.store.useSelectorRC(statusSelector);
    },
    useOfflineEntities: () => {
      const coordinator = useSessionCoordinator();
      const entitiesSelector = useCallback(
        (state: SessionStoreState) =>
          state.entities.map(stripInternalEntityPayload),
        [],
      );

      return coordinator.store.useSelectorRC(entitiesSelector, {
        equalityFn: deepEqual,
      });
    },
    useOfflineResolutions: () => {
      const coordinator = useSessionCoordinator();
      const resolutionsSelector = useCallback(
        (state: SessionStoreState) => state.resolutions,
        [],
      );

      return coordinator.store.useSelectorRC(resolutionsSelector, {
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
        coordinator.store.useSelectorRC(uploadsSelector, {
          equalityFn: deepEqual,
        }),
      );
    },
  };

  uploadsConfigByOfflineSession.set(
    eraseOfflineSession(session),
    eraseUploadsConfig(uploads),
  );

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
): SessionOfflineCoordinator {
  return useMemo(
    () =>
      getOrCreateSessionOfflineCoordinator(sessionKey, {
        config,
        uploads,
        bootstrapStatusFromLocalStorage,
      }),
    [bootstrapStatusFromLocalStorage, config, sessionKey, uploads],
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

  return coordinator.store.useSelectorRC(statusSelector);
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

  return coordinator.store.useSelectorRC(entitiesSelector, {
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

  return coordinator.store.useSelectorRC(resolutionsSelector, {
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

  return coordinator.store.useSelectorRC(entitiesSelector, {
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
 * React hook returning offline status for a session or inactive scope.
 */
export function useOfflineStoreStatus(args: {
  sessionKey: string | false;
  inactiveScope: string;
}): GlobalOfflineStatus {
  const coordinator = useSessionOfflineCoordinator(
    resolveOfflineSessionScope(args.sessionKey, args.inactiveScope),
    false,
  );
  const statusSelector = useCallback(
    (state: SessionStoreState) => state.status,
    [],
  );

  return coordinator.store.useSelectorRC(statusSelector);
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

  return coordinator.store.useSelectorRC(resolutionsSelector, {
    equalityFn: deepEqual,
  });
}
