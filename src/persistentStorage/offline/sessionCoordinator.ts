import { deepEqual } from '@ls-stack/utils/deepEqual';
import { useCallback, useMemo } from 'react';
import {
  rc_literals,
  rc_number,
  rc_object,
  rc_parse,
  rc_string,
} from 'runcheck';
import { Store } from 't-state';

import type { BrowserTabsTabStatusMessage } from '../../utils/browserTabsPriority';
import {
  createBrowserTabsCoordinatorWithPriority,
  type BrowserTabsMessageMeta,
} from '../../utils/browserTabsSync';
import {
  createCompactLocalStorageEntry,
  parseCompactLocalStorageEntry,
} from '../compactLocalStorageEntry';
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
  OfflineFailureClassification,
  GlobalOfflineEntity,
  GlobalOfflineStatus,
  OfflineFailureContext,
  OfflineModeConfig,
  OfflineNetworkModeConfig,
  OfflineRecoveryProbeConfig,
  OfflineOperationSchemaShape,
  OfflineOutageModeConfig,
} from './types';
import { globalOfflineStatusSchema } from './types';

type SessionStoreState = {
  status: GlobalOfflineStatus;
  entities: GlobalOfflineEntity[];
  resolutions: unknown[];
};

type SessionSnapshotMessage = BrowserTabsMessageMeta & {
  kind: 'offline-session-snapshot';
  status: GlobalOfflineStatus;
  entities: GlobalOfflineEntity[];
  resolutions: unknown[];
};

type OfflineSessionMessage =
  | SessionSnapshotMessage
  | (BrowserTabsMessageMeta & BrowserTabsTabStatusMessage);

type SessionStoreContribution = {
  entities: GlobalOfflineEntity[];
  resolutions: unknown[];
  protectedKeys: string[];
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
  config?: OfflineModeConfig<Record<string, OfflineOperationSchemaShape>>;
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
const OFFLINE_STATUS_BOOTSTRAP_STORAGE_KEY_PREFIX = 'tsdf-os:';
const LEGACY_OFFLINE_STATUS_BOOTSTRAP_STORAGE_KEY_PREFIX =
  'tsdf-offline-status:';
const COMPACT_FLAG = 1 as const;
const compactOfflineStatusModeStateSchema = rc_object({
  e: rc_literals(COMPACT_FLAG).optionalKey(),
  a: rc_literals(COMPACT_FLAG).optionalKey(),
});
const compactOfflineStatusSnapshotSchema = rc_object({
  s: rc_string,
  n: compactOfflineStatusModeStateSchema.optionalKey(),
  o: compactOfflineStatusModeStateSchema.optionalKey(),
  u: rc_number.optionalKey(),
  lf: rc_number.optionalKey(),
  lr: rc_number.optionalKey(),
});

function createDefaultStatus(sessionKey: string): GlobalOfflineStatus {
  return {
    sessionKey,
    network: { enabled: false, active: false },
    outage: { enabled: false, active: false },
    effectiveMode: 'online',
    effectiveOffline: false,
    isLeader: true,
    updatedAt: Date.now(),
    lastFailureAt: null,
    lastRecoveryCheckAt: null,
  };
}

function getOfflineStatusBootstrapStorageKey(
  sessionKey: string,
  prefix = OFFLINE_STATUS_BOOTSTRAP_STORAGE_KEY_PREFIX,
): string {
  return `${prefix}${sessionKey}`;
}

function normalizeCompactModeState(value: { e?: 1; a?: 1 } | undefined): {
  enabled: boolean;
  active: boolean;
} {
  return {
    enabled: value?.e === COMPACT_FLAG,
    active: value?.a === COMPACT_FLAG,
  };
}

function serializeOfflineStatusSnapshot(status: GlobalOfflineStatus) {
  return {
    s: status.sessionKey,
    n:
      status.network.enabled || status.network.active
        ? {
            ...(status.network.enabled ? { e: COMPACT_FLAG } : {}),
            ...(status.network.active ? { a: COMPACT_FLAG } : {}),
          }
        : undefined,
    o:
      status.outage.enabled || status.outage.active
        ? {
            ...(status.outage.enabled ? { e: COMPACT_FLAG } : {}),
            ...(status.outage.active ? { a: COMPACT_FLAG } : {}),
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
  if (compactStatus?.s === sessionKey) {
    const network = normalizeCompactModeState(compactStatus.n);
    const outage = normalizeCompactModeState(compactStatus.o);
    const effectiveOffline = network.active || outage.active;

    return {
      sessionKey,
      network,
      outage,
      effectiveMode: effectiveOffline ? 'offline' : 'online',
      effectiveOffline,
      isLeader: true,
      updatedAt:
        typeof compactStatus.u === 'number' ? compactStatus.u : Date.now(),
      lastFailureAt:
        typeof compactStatus.lf === 'number' ? compactStatus.lf : null,
      lastRecoveryCheckAt:
        typeof compactStatus.lr === 'number' ? compactStatus.lr : null,
    };
  }

  const persistedStatus = rc_parse(
    rawStatus,
    globalOfflineStatusSchema,
  ).unwrapOrNull();
  if (persistedStatus === null || persistedStatus.sessionKey !== sessionKey) {
    return null;
  }

  const effectiveOffline =
    persistedStatus.effectiveOffline ||
    persistedStatus.network.active ||
    persistedStatus.outage.active;

  return {
    sessionKey,
    network: persistedStatus.network,
    outage: persistedStatus.outage,
    effectiveMode: effectiveOffline ? 'offline' : 'online',
    effectiveOffline,
    isLeader: true,
    updatedAt: persistedStatus.updatedAt,
    lastFailureAt: persistedStatus.lastFailureAt,
    lastRecoveryCheckAt: persistedStatus.lastRecoveryCheckAt,
  };
}

function readPersistedOfflineStatusSnapshot(
  sessionKey: string,
): GlobalOfflineStatus | null {
  if (!isWindowAvailable()) return null;

  try {
    const keys = [
      getOfflineStatusBootstrapStorageKey(sessionKey),
      getOfflineStatusBootstrapStorageKey(
        sessionKey,
        LEGACY_OFFLINE_STATUS_BOOTSTRAP_STORAGE_KEY_PREFIX,
      ),
      `tsdf.${sessionKey}._o_.s`,
    ];

    for (const key of keys) {
      const entry = parseCompactLocalStorageEntry(localStorage.getItem(key));
      if (!entry) continue;

      const rawStatus = entry.value.d ?? null;
      const normalized = normalizePersistedOfflineStatus(sessionKey, rawStatus);
      if (normalized !== null) return normalized;
    }
  } catch {
    // Ignore read failures so offline coordination continues to work
    // even when localStorage is unavailable.
  }

  return null;
}

function clearPersistedOfflineStatusSnapshot(sessionKey: string): void {
  if (!isWindowAvailable()) return;

  try {
    localStorage.removeItem(getOfflineStatusBootstrapStorageKey(sessionKey));
    localStorage.removeItem(
      getOfflineStatusBootstrapStorageKey(
        sessionKey,
        LEGACY_OFFLINE_STATUS_BOOTSTRAP_STORAGE_KEY_PREFIX,
      ),
    );
  } catch {
    // Ignore bootstrap snapshot clear failures so offline coordination
    // continues to work even when localStorage is unavailable or full.
  }
}

function syncPersistedOfflineStatusSnapshot(status: GlobalOfflineStatus): void {
  if (!status.effectiveOffline) {
    clearPersistedOfflineStatusSnapshot(status.sessionKey);
    return;
  }

  if (!isWindowAvailable()) return;

  try {
    localStorage.setItem(
      getOfflineStatusBootstrapStorageKey(status.sessionKey),
      JSON.stringify(
        createCompactLocalStorageEntry(
          { d: serializeOfflineStatusSnapshot(status) },
          undefined,
        ),
      ),
    );
  } catch {
    // Ignore bootstrap snapshot write failures so offline coordination
    // continues to work even when localStorage is unavailable or full.
  }
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
  networkEnabled: boolean;
  networkListenToBrowserEvents: boolean;
  getIsOffline?: () => boolean | Promise<boolean>;
  networkRecoveryCheck?: OfflineNetworkModeConfig['recoveryCheck'];
  networkRecoveryProbe: Required<OfflineRecoveryProbeConfig>;
  outageEnabled: boolean;
  classifyFailure?: OfflineModeConfig<
    Record<string, OfflineOperationSchemaShape>
  >['classifyFailure'];
  outageRecoveryCheck?: OfflineOutageModeConfig['recoveryCheck'];
  outageRecoveryProbe: Required<OfflineRecoveryProbeConfig>;
};

function toCanonicalConfig(
  adapter: StorageAdapter | null,
  config:
    | OfflineModeConfig<Record<string, OfflineOperationSchemaShape>>
    | undefined,
): SessionCanonicalConfig {
  return {
    adapter,
    networkEnabled: config?.network?.enabled ?? false,
    networkListenToBrowserEvents:
      config?.network?.listenToBrowserEvents ?? true,
    getIsOffline: config?.network?.getIsOffline,
    networkRecoveryCheck: config?.network?.recoveryCheck,
    networkRecoveryProbe: normalizeRecoveryProbe(
      config?.network?.recoveryProbe,
      DEFAULT_NETWORK_RECOVERY_PROBE,
    ),
    outageEnabled: config?.outage?.enabled ?? false,
    classifyFailure: config?.classifyFailure,
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
    left.networkEnabled === right.networkEnabled &&
    left.networkListenToBrowserEvents === right.networkListenToBrowserEvents &&
    left.getIsOffline === right.getIsOffline &&
    left.networkRecoveryCheck === right.networkRecoveryCheck &&
    sameProbeConfig(left.networkRecoveryProbe, right.networkRecoveryProbe) &&
    left.outageEnabled === right.outageEnabled &&
    left.classifyFailure === right.classifyFailure &&
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

  return createPersistentStorageHandle<GlobalOfflineStatus>({
    storeName: '_o_.s',
    adapter: args.adapter,
    getSessionKey: () => args.sessionKey,
    onPersistentStorageError: args.onPersistentStorageError,
  });
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
  #networkStateToken = 0;
  #lastRemoteSnapshotAt = 0;
  #recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  #scheduledRecoveryMode: SessionRecoveryMode | null = null;
  #recoveryAttempt = 0;
  #classifiedNetworkActive = false;
  #hydrated = false;
  #hydrationToken = 0;
  #protectedKeys: string[] = [];

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
      const hydratedStatus = {
        ...persistedStatus,
        isLeader: this.isLeader(),
        updatedAt: Date.now(),
      };

      this.store.setPartialState(
        { status: hydratedStatus },
        { action: 'offline-session-hydrate' },
      );
      this.#syncClassifiedNetworkStateFromStatus(hydratedStatus);
      this.#syncRecoveryProbe();
      syncPersistedOfflineStatusSnapshot(hydratedStatus);
    }

    this.#protectedKeys = [...protectedKeys].sort();
    setSessionProtectedKeysSnapshot(this.sessionKey, this.#protectedKeys);
  }

  configure(options: {
    adapter?: StorageAdapter;
    onPersistentStorageError?: (error: unknown) => void;
    config?: OfflineModeConfig<Record<string, OfflineOperationSchemaShape>>;
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
        `[tsdf] Incompatible offlineMode configuration for session "${this.sessionKey}"`,
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
    this.#registrations.set(registration.storeName, registration);
    this.#refreshLeadership();

    return () => {
      this.#registrations.delete(registration.storeName);
      this.#storeContributions.delete(registration.storeName);
      this.#refreshAggregates();
      if (this.#registrations.size === 0) {
        this.#stopRecoveryProbe();
      }
    };
  }

  syncStoreData(
    storeName: string,
    contribution: SessionStoreContribution,
  ): void {
    this.#storeContributions.set(storeName, contribution);
    this.#refreshAggregates();
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

  getStatus(): GlobalOfflineStatus {
    return this.store.state.status;
  }

  getEntities(): GlobalOfflineEntity[] {
    return this.store.state.entities;
  }

  getResolutions(): unknown[] {
    return this.store.state.resolutions;
  }

  isLeader(): boolean {
    return this.#browserTabs.priority.getPriorityRank() <= 1;
  }

  #browserReportsOnline(): boolean {
    return !isWindowAvailable() || navigator.onLine !== false;
  }

  #syncClassifiedNetworkStateFromStatus(status: GlobalOfflineStatus): void {
    this.#classifiedNetworkActive =
      status.network.active && this.#browserReportsOnline();
  }

  #handleConnectivityChange(wasEffectivelyOffline: boolean): void {
    this.#syncRecoveryProbe();

    if (!wasEffectivelyOffline && this.store.state.status.effectiveOffline) {
      this.#notifyOfflineCycle();
      return;
    }

    if (wasEffectivelyOffline && !this.store.state.status.effectiveOffline) {
      this.#notifyGreenCycle();
    }
  }

  async refreshNetworkState(): Promise<boolean> {
    if (!this.#canonicalConfig.networkEnabled) {
      this.setNetworkActive(false, { classified: false });
      return false;
    }

    const token = ++this.#networkStateToken;
    const detectedOffline = await this.#getCurrentOfflineState();
    if (token !== this.#networkStateToken) {
      return this.store.state.status.network.active;
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
    const wasEffectivelyOffline = this.store.state.status.effectiveOffline;
    this.#classifiedNetworkActive = active
      ? (options.classified ?? this.#classifiedNetworkActive)
      : false;

    this.#updateStatus((current) => ({
      ...current,
      network: { enabled: this.#canonicalConfig.networkEnabled, active },
      lastFailureAt:
        active && options.recordFailureAt ? Date.now() : current.lastFailureAt,
      lastRecoveryCheckAt:
        options.recoveryCheckAt ?? current.lastRecoveryCheckAt,
    }));
    this.#handleConnectivityChange(wasEffectivelyOffline);
  }

  setOutageActive(
    active: boolean,
    options: { recoveryCheckAt?: number } = {},
  ): void {
    const wasEffectivelyOffline = this.store.state.status.effectiveOffline;

    this.#updateStatus((current) => ({
      ...current,
      outage: { enabled: this.#canonicalConfig.outageEnabled, active },
      lastFailureAt: active ? Date.now() : current.lastFailureAt,
      lastRecoveryCheckAt:
        options.recoveryCheckAt ?? current.lastRecoveryCheckAt,
    }));
    this.#handleConnectivityChange(wasEffectivelyOffline);
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
      if (!this.#canonicalConfig.outageEnabled) return 'ignore';
      this.setOutageActive(true);
      return 'outage';
    }

    if (result === 'network') {
      if (!this.#canonicalConfig.networkEnabled) return 'ignore';
      this.setNetworkActive(true, { classified: true, recordFailureAt: true });
      return 'network';
    }

    return 'ignore';
  }

  #notifyGreenCycle(): void {
    if (this.store.state.status.effectiveOffline || !this.isLeader()) return;
    for (const registration of this.#registrations.values()) {
      registration.onGreenCycle?.();
    }
  }

  #notifyOfflineCycle(): void {
    if (!this.store.state.status.effectiveOffline || !this.isLeader()) return;
    for (const registration of this.#registrations.values()) {
      registration.onOfflineCycle?.();
    }
  }

  #syncNetworkListeners(): void {
    this.#cleanupNetworkListeners?.();
    this.#cleanupNetworkListeners = null;

    if (
      !this.#canonicalConfig.networkEnabled ||
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
    if (!this.#canonicalConfig.networkEnabled) return;

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
    const effectiveOffline = status.network.active || status.outage.active;

    return this.#stampLocalStatus({
      ...status,
      effectiveOffline,
      effectiveMode: effectiveOffline ? 'offline' : 'online',
    });
  }

  #updateStatus(
    updater: (status: GlobalOfflineStatus) => GlobalOfflineStatus,
  ): void {
    const derived = this.#deriveLocalStatus(updater(this.store.state.status));

    this.store.setPartialState(
      { status: derived },
      { action: 'offline-session-status' },
    );
    syncPersistedOfflineStatusSnapshot(derived);
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
        status: this.#stampLocalStatus(message.status),
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

    if (leadershipChanged && !this.store.state.status.effectiveOffline) {
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
      this.#canonicalConfig.networkEnabled &&
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
      this.#canonicalConfig.outageEnabled &&
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
