import { deepEqual } from '@ls-stack/utils/deepEqual';
import { useCallback, useMemo } from 'react';
import { rc_object, rc_parse } from 'runcheck';
import { Store } from 't-state';

import type { BrowserTabsTabStatusMessage } from '../../utils/browserTabsPriority';
import {
  createBrowserTabsCoordinatorWithPriority,
  type BrowserTabsMessageMeta,
} from '../../utils/browserTabsSync';
import { parseCompactLocalStorageEntry } from '../compactLocalStorageEntry';
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

type SessionStoreState = {
  status: GlobalOfflineStatus;
  entities: GlobalOfflineEntity[];
  resolutions: OfflineResolutionRecord[];
};

type SessionSnapshotMessage = BrowserTabsMessageMeta & {
  kind: 'offline-session-snapshot';
  status: GlobalOfflineStatus;
  entities: GlobalOfflineEntity[];
  resolutions: OfflineResolutionRecord[];
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
  entities: GlobalOfflineEntity[];
  resolutions: OfflineResolutionRecord[];
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

function readPersistedOfflineStatusSnapshot(
  sessionKey: string,
): GlobalOfflineStatus | null {
  if (!isWindowAvailable()) return null;

  try {
    const entry = parseCompactLocalStorageEntry(
      localStorage.getItem(getOfflineStatusStorageKey(sessionKey)),
    );
    if (!entry) return null;

    const rawStatus = entry.value.d ?? null;
    return normalizePersistedOfflineStatus(sessionKey, rawStatus);
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
    const bootstrapped = readPersistedOfflineStatusSnapshot(sessionKey);
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
  adapter: StorageAdapter | null;
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
  adapter: StorageAdapter | null,
  config: OfflineSessionConfig | undefined,
): SessionCanonicalConfig {
  return {
    adapter,
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

function sameCanonicalConfig(
  left: SessionCanonicalConfig,
  right: SessionCanonicalConfig,
): boolean {
  return (
    left.adapter === right.adapter &&
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

function createSessionPersistenceHandle(args: {
  sessionKey: string;
  adapter: StorageAdapter | null;
  onPersistentStorageError?: (error: unknown) => void;
}): PersistentStorageHandle<GlobalOfflineStatus> {
  if (args.adapter === null) return createNoopPersistentStorageHandle();

  return createPersistentStorageHandle<GlobalOfflineStatus>(
    {
      storeName: '_o_.s',
      adapter: 'local-sync',
      getSessionKey: () => args.sessionKey,
      onPersistentStorageError: args.onPersistentStorageError,
    },
    {
      valueCodec: {
        serialize(status) {
          return { d: serializeOfflineStatusSnapshot(status) };
        },
        deserialize(raw) {
          const compactStatus = rc_parse(
            raw,
            rc_object({ d: compactOfflineStatusSnapshotSchema }),
          ).unwrapOrNull();
          if (compactStatus === null) return null;

          return normalizePersistedOfflineStatus(
            args.sessionKey,
            compactStatus.d,
          );
        },
      },
    },
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
  #sessionHandle: PersistentStorageHandle<GlobalOfflineStatus>;
  readonly #browserTabs;
  #canonicalAdapter: StorageAdapter | null;
  #localStorageAdapter: ReturnType<typeof getLocalStorageAdapter>;
  #onPersistentStorageError: ((error: unknown) => void) | undefined;
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
  #disposed = false;

  constructor({
    sessionKey,
    adapter,
    onPersistentStorageError,
    config,
    bootstrapStatusFromLocalStorage = false,
  }: SessionCoordinatorOptions) {
    const resolvedAdapter = adapter ?? null;
    this.sessionKey = sessionKey;
    this.#canonicalAdapter = resolvedAdapter;
    this.#localStorageAdapter =
      resolvedAdapter !== null ? getLocalStorageAdapter(resolvedAdapter) : null;
    this.#onPersistentStorageError = onPersistentStorageError;
    this.#sessionHandle = createSessionPersistenceHandle({
      sessionKey,
      adapter: resolvedAdapter,
      onPersistentStorageError,
    });
    this.#canonicalConfig = toCanonicalConfig(resolvedAdapter, config);
    this.#hasCanonicalConfig = config !== undefined;
    setSessionProtectedKeysSnapshot(this.sessionKey, []);
    this.store = new Store<SessionStoreState>({
      debugName: `tsdf-offline:${sessionKey}`,
      state: () => ({
        status: resolveDefaultStatus(sessionKey, {
          bootstrapStatusFromLocalStorage:
            config !== undefined || bootstrapStatusFromLocalStorage,
        }),
        entities: [],
        resolutions: [],
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
    void this.hydrate();
    if (this.#hasCanonicalConfig) {
      this.#refreshNetworkConfig();
    }
  }

  async hydrate(): Promise<void> {
    if (this.#hydrated) return;
    this.#hydrated = true;
    const hydrationToken = this.#hydrationToken;

    const [persistedStatus, protectedKeys] = await Promise.all([
      this.#sessionHandle.load({ touch: 'never' }),
      this.#canonicalAdapter === null
        ? Promise.resolve(new Set<string>())
        : readProtectedStorageKeys(this.#canonicalAdapter, this.sessionKey),
    ]);

    if (hydrationToken !== this.#hydrationToken) return;

    if (persistedStatus) {
      const hydratedStatus = this.#restampHydratedStatus(persistedStatus, {
        isLeader: this.isLeader(),
        updatedAt: Date.now(),
      });

      this.store.setPartialState(
        { status: hydratedStatus },
        { action: 'offline-session-hydrate' },
      );
      this.#syncClassifiedNetworkStateFromStatus(hydratedStatus);
      this.#syncRecoveryProbe();
      void this.#sessionHandle.saveNow(hydratedStatus);
    }

    this.#protectedKeys = [...protectedKeys].sort();
    setSessionProtectedKeysSnapshot(this.sessionKey, this.#protectedKeys);
  }

  configure(options: {
    adapter?: StorageAdapter;
    onPersistentStorageError?: (error: unknown) => void;
    config?: OfflineSessionConfig;
  }): void {
    const nextAdapter = options.adapter ?? this.#canonicalAdapter;
    const nextConfig = toCanonicalConfig(nextAdapter, options.config);

    if (!this.#hasCanonicalConfig && options.config) {
      if (
        nextAdapter !== this.#canonicalAdapter ||
        options.adapter !== undefined ||
        options.onPersistentStorageError !== undefined
      ) {
        this.#recreatePersistenceHandles({
          adapter: nextAdapter,
          onPersistentStorageError:
            options.onPersistentStorageError ?? this.#onPersistentStorageError,
        });
      }
      this.#canonicalConfig = nextConfig;
      this.#hasCanonicalConfig = true;
      void this.hydrate();
      this.#refreshNetworkConfig();
      return;
    }

    if (!this.#hasCanonicalConfig) return;

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

  #recreatePersistenceHandles(args: {
    adapter: StorageAdapter | null;
    onPersistentStorageError?: (error: unknown) => void;
  }): void {
    this.#sessionHandle.dispose();
    this.#canonicalAdapter = args.adapter;
    this.#localStorageAdapter =
      args.adapter !== null ? getLocalStorageAdapter(args.adapter) : null;
    this.#onPersistentStorageError = args.onPersistentStorageError;
    this.#sessionHandle = createSessionPersistenceHandle({
      sessionKey: this.sessionKey,
      adapter: args.adapter,
      onPersistentStorageError: args.onPersistentStorageError,
    });
    this.#protectedKeys = [];
    setSessionProtectedKeysSnapshot(this.sessionKey, []);
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
    return this.store.state.entities;
  }

  getResolutions(): OfflineResolutionRecord[] {
    return this.store.state.resolutions;
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
      this.#notifyOfflineCycle();
      return;
    }

    if (wasEffectivelyOffline && !this.store.state.status.isOfflineMode) {
      this.#notifyGreenCycle();
      return;
    }

    if (!wasEffectivelyOffline && wasReplayBlocked && !this.isReplayBlocked()) {
      this.#notifyGreenCycle();
    }
  }

  async refreshNetworkState(): Promise<boolean> {
    const token = ++this.#networkStateToken;
    const detectedOffline = await this.#getCurrentOfflineState();
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
    for (const registration of this.#registrations.values()) {
      registration.onGreenCycle?.();
    }
  }

  #notifyOfflineCycle(): void {
    if (!this.store.state.status.isOfflineMode || !this.isLeader()) {
      return;
    }
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

  #refreshAggregates(): void {
    const entities = [...this.#storeContributions.values()]
      .flatMap((entry) => entry.entities)
      .sort((left, right) => left.id.localeCompare(right.id));
    const resolutions = [...this.#storeContributions.values()].flatMap(
      (entry) => entry.resolutions,
    );
    const nextProtectedKeys = [...this.#storeContributions.values()]
      .flatMap((entry) => entry.protectedKeys)
      .sort();

    if (!arraysEqual(this.#protectedKeys, nextProtectedKeys)) {
      const previousProtectedKeys = this.#protectedKeys;
      this.#protectedKeys = nextProtectedKeys;
      setSessionProtectedKeysSnapshot(this.sessionKey, nextProtectedKeys);
      if (this.#localStorageAdapter !== null) {
        this.#localStorageAdapter.syncSessionProtectedKeys(
          this.sessionKey,
          nextProtectedKeys,
        );
      } else if (
        this.#canonicalAdapter !== null &&
        this.#canonicalAdapter !== 'local-sync'
      ) {
        const asyncAdapter = this.#canonicalAdapter;
        void asyncAdapter
          .syncSessionProtectedKeys(
            this.sessionKey,
            nextProtectedKeys,
            previousProtectedKeys,
          )
          .catch((error: unknown) => {
            this.#onPersistentStorageError?.(error);
          });
      }
    }

    this.store.setPartialState(
      { entities, resolutions },
      { action: 'offline-session-aggregate' },
    );
    this.#publishSnapshot();
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
    void this.#sessionHandle.saveNow(derived);
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
      },
      { action: 'offline-session-remote' },
    );
    this.#syncClassifiedNetworkStateFromStatus(this.store.state.status);
    this.#refreshLeadership();
  }

  #refreshLeadership(): void {
    const leadershipChanged = this.#syncLeadershipState();

    if (!this.isLeader()) {
      this.#stopRecoveryProbe();
      return;
    }

    if (leadershipChanged && !this.store.state.status.isOfflineMode) {
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
    });
    return existing;
  }

  const created = new SessionOfflineCoordinator({
    sessionKey,
    adapter: options.adapter,
    onPersistentStorageError: options.onPersistentStorageError,
    config: options.config,
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

export function createOfflineSession(args: {
  getSessionKey: () => string | false;
  config: OfflineSessionConfig;
}): OfflineSession {
  const { getSessionKey, config } = args;
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
      activeSessionKey !== false,
    );
  }

  return {
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
        (state: SessionStoreState) => state.entities,
        [],
      );

      return coordinator.store.useSelectorRC(entitiesSelector);
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
  };
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
  bootstrapStatusFromLocalStorage = false,
): SessionOfflineCoordinator {
  return useMemo(
    () =>
      getOrCreateSessionOfflineCoordinator(sessionKey, {
        config,
        bootstrapStatusFromLocalStorage,
      }),
    [bootstrapStatusFromLocalStorage, config, sessionKey],
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
    (state: SessionStoreState) => state.entities,
    [],
  );

  return coordinator.store.useSelectorRC(entitiesSelector);
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
export function useOfflineStoreEntities(args: {
  sessionKey: string | false;
  inactiveScope: string;
  storeName?: string;
}): readonly GlobalOfflineEntity[] {
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
