import { deepEqual } from '@ls-stack/utils/deepEqual';
import { useCallback, useMemo } from 'react';
import { Store } from 't-state';

import type { BrowserTabsTabStatusMessage } from '../../utils/browserTabsPriority';
import {
  createBrowserTabsCoordinatorWithPriority,
  type BrowserTabsMessageMeta,
} from '../../utils/browserTabsSync';
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
  OfflineFailureContext,
  OfflineModeConfig,
  OfflineOperationSchemaShape,
  OfflineOutageModeConfig,
  OfflineRecoveryProbeConfig,
} from './types';

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
};

const DEFAULT_RECOVERY_PROBE: Required<OfflineRecoveryProbeConfig> = {
  intervalMs: 5_000,
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
    effectiveMode: 'online',
    effectiveOffline: false,
    isLeader: true,
    updatedAt: Date.now(),
    lastFailureAt: null,
    lastRecoveryCheckAt: null,
  };
}

function resolveDefaultStatus(sessionKey: string): GlobalOfflineStatus {
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
): Required<OfflineRecoveryProbeConfig> {
  return {
    intervalMs: config?.intervalMs ?? DEFAULT_RECOVERY_PROBE.intervalMs,
    maxIntervalMs:
      config?.maxIntervalMs ?? DEFAULT_RECOVERY_PROBE.maxIntervalMs,
    backoffMultiplier:
      config?.backoffMultiplier ?? DEFAULT_RECOVERY_PROBE.backoffMultiplier,
    jitterRatio: config?.jitterRatio ?? DEFAULT_RECOVERY_PROBE.jitterRatio,
  };
}

type SessionCanonicalConfig = {
  adapter: StorageAdapter | null;
  networkEnabled: boolean;
  networkListenToBrowserEvents: boolean;
  getIsOffline?: () => boolean | Promise<boolean>;
  outageEnabled: boolean;
  classifyFailure?: OfflineOutageModeConfig['classifyFailure'];
  recoveryCheck?: OfflineOutageModeConfig['recoveryCheck'];
  recoveryProbe: Required<OfflineRecoveryProbeConfig>;
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
    outageEnabled: config?.outage?.enabled ?? false,
    classifyFailure: config?.outage?.classifyFailure,
    recoveryCheck: config?.outage?.recoveryCheck,
    recoveryProbe: normalizeRecoveryProbe(config?.outage?.recoveryProbe),
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

function sameCanonicalConfig(
  left: SessionCanonicalConfig,
  right: SessionCanonicalConfig,
): boolean {
  return (
    left.adapter === right.adapter &&
    left.networkEnabled === right.networkEnabled &&
    left.networkListenToBrowserEvents === right.networkListenToBrowserEvents &&
    left.getIsOffline === right.getIsOffline &&
    left.outageEnabled === right.outageEnabled &&
    left.classifyFailure === right.classifyFailure &&
    left.recoveryCheck === right.recoveryCheck &&
    left.recoveryProbe.intervalMs === right.recoveryProbe.intervalMs &&
    left.recoveryProbe.maxIntervalMs === right.recoveryProbe.maxIntervalMs &&
    left.recoveryProbe.backoffMultiplier ===
      right.recoveryProbe.backoffMultiplier &&
    left.recoveryProbe.jitterRatio === right.recoveryProbe.jitterRatio
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
  #recoveryAttempt = 0;
  #hydrated = false;
  #hydrationToken = 0;
  #protectedKeys: string[] = [];

  constructor({
    sessionKey,
    adapter,
    onPersistentStorageError,
    config,
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
        status: resolveDefaultStatus(sessionKey),
        entities: [],
        resolutions: [],
      }),
    });

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
    this.#refreshNetworkConfig();
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
      this.store.setPartialState(
        {
          status: {
            ...persistedStatus,
            isLeader: this.isLeader(),
            updatedAt: Date.now(),
          },
        },
        { action: 'offline-session-hydrate' },
      );
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
    this.#maybeStartRecoveryProbe();

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

  async refreshNetworkState(): Promise<boolean> {
    if (!this.#canonicalConfig.networkEnabled) {
      this.#updateStatus((current) => ({
        ...current,
        network: { enabled: false, active: false },
      }));
      return false;
    }

    const token = ++this.#networkStateToken;
    const next = await this.#getCurrentOfflineState();
    if (token !== this.#networkStateToken) {
      return this.store.state.status.network.active;
    }
    this.setNetworkActive(next);
    return next;
  }

  setNetworkActive(active: boolean): void {
    const wasEffectivelyOffline = this.store.state.status.effectiveOffline;

    this.#updateStatus((current) => ({
      ...current,
      network: { enabled: this.#canonicalConfig.networkEnabled, active },
    }));

    if (active) {
      this.#stopRecoveryProbe();
      if (!wasEffectivelyOffline && this.store.state.status.effectiveOffline) {
        this.#notifyOfflineCycle();
      }
      return;
    }

    this.#maybeStartRecoveryProbe();
    this.#notifyGreenCycle();
  }

  setOutageActive(active: boolean): void {
    const wasEffectivelyOffline = this.store.state.status.effectiveOffline;

    this.#updateStatus((current) => ({
      ...current,
      outage: { enabled: this.#canonicalConfig.outageEnabled, active },
      lastFailureAt: active ? Date.now() : current.lastFailureAt,
    }));

    if (active) {
      this.#maybeStartRecoveryProbe();
      if (!wasEffectivelyOffline && this.store.state.status.effectiveOffline) {
        this.#notifyOfflineCycle();
      }
      return;
    }

    this.#stopRecoveryProbe();
    this.#notifyGreenCycle();
  }

  async classifyFailure(
    error: unknown,
    ctx: OfflineFailureContext,
  ): Promise<'outage' | 'ignore'> {
    if (
      !this.#canonicalConfig.outageEnabled ||
      !this.#canonicalConfig.classifyFailure
    ) {
      return 'ignore';
    }

    const token = this.getClassificationToken();
    const result = await this.#canonicalConfig.classifyFailure(error, ctx);

    if (!this.isCurrentClassificationToken(token)) {
      return 'ignore';
    }

    if (result === 'outage') {
      this.setOutageActive(true);
    }

    return result;
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
      this.setNetworkActive(initial);
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

    this.#maybeStartRecoveryProbe();
  }

  #getRecoveryProbeDelay(): number {
    const probeConfig = this.#canonicalConfig.recoveryProbe;
    const baseDelay = Math.min(
      probeConfig.intervalMs *
        Math.max(1, probeConfig.backoffMultiplier ** this.#recoveryAttempt),
      probeConfig.maxIntervalMs,
    );
    const jitter = baseDelay * probeConfig.jitterRatio;

    return Math.max(
      0,
      Math.round(baseDelay + (Math.random() * jitter * 2 - jitter)),
    );
  }

  #scheduleRecoveryProbe(): void {
    this.#recoveryTimer = setTimeout(async () => {
      this.#recoveryTimer = null;

      if (
        !this.store.state.status.outage.active ||
        this.store.state.status.network.active ||
        !this.isLeader()
      ) {
        return;
      }

      let recovered = false;

      try {
        recovered =
          (await this.#canonicalConfig.recoveryCheck?.({
            sessionKey: this.sessionKey,
          })) ?? false;
      } catch {
        recovered = false;
      }

      this.#updateStatus((current: GlobalOfflineStatus) => ({
        ...current,
        lastRecoveryCheckAt: Date.now(),
      }));

      if (recovered) {
        this.#recoveryAttempt = 0;
        this.setOutageActive(false);
        return;
      }

      this.#recoveryAttempt += 1;
      this.#scheduleRecoveryProbe();
    }, this.#getRecoveryProbeDelay());
  }

  #maybeStartRecoveryProbe(): void {
    if (
      !this.#canonicalConfig.outageEnabled ||
      !this.#canonicalConfig.recoveryCheck ||
      !this.store.state.status.outage.active ||
      this.store.state.status.network.active ||
      !this.isLeader() ||
      this.#registrations.size === 0 ||
      this.#recoveryTimer !== null
    ) {
      return;
    }

    this.#scheduleRecoveryProbe();
  }

  #stopRecoveryProbe(): void {
    if (this.#recoveryTimer !== null) {
      clearTimeout(this.#recoveryTimer);
      this.#recoveryTimer = null;
    }
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
    registry.get(sessionKey)?.getStatus() ?? resolveDefaultStatus(sessionKey)
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
): SessionOfflineCoordinator {
  return useMemo(
    () =>
      registry.get(sessionKey) ??
      getOrCreateSessionOfflineCoordinator(sessionKey),
    [sessionKey],
  );
}

/**
 * React hook that subscribes to the offline status stream for a session.
 */
export function useGlobalOfflineStatus(
  sessionKey: string,
): GlobalOfflineStatus {
  const coordinator = useSessionOfflineCoordinator(sessionKey);
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
  const coordinator = useSessionOfflineCoordinator(sessionKey);
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
