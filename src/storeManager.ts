import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import {
  Result,
  type Result as ResultType,
  resultify,
  unknownToError,
} from 't-result';
import {
  resolveTSDFLogger,
  type TSDFDebugLogger,
  type TSDFLoggerOptions,
} from './debug';
import {
  createDefaultStatus,
  createOfflineSession,
} from './persistentStorage/offline/sessionCoordinator';
import type {
  GlobalOfflineEntity,
  GlobalOfflineStatus,
  OfflineResolutionRecord,
  OfflineRuntimeConfig,
  OfflineRuntimeConfigUpdate,
  OfflineSession,
  OfflineSessionConfig,
} from './persistentStorage/offline/types';
import { defaultOfflineRuntimeConfig } from './persistentStorage/offline/types';
import type { OfflineUpload } from './persistentStorage/offlineUploadTypes';
import type { PersistentStorageErrorHandler } from './persistentStorage/types';
import type { BrowserTabsPriorityTimings } from './utils/browserTabsPriority';
import {
  createBrowserTabsPresencePriority,
  type BrowserTabsPresencePriority,
  type BrowserTabsTransportFactory,
} from './utils/browserTabsSync';
import type { BlockWindowCloseHandler } from './utils/performMutation';
import type {
  StoreError,
  StoreMutationErrorOptions,
  ValidPayload,
} from './utils/storeShared';

const DEFAULT_LOW_PRIORITY_THROTTLE_MS = 40 * 60 * 1_000;
const DEFAULT_BASE_COALESCING_WINDOW_MS = 16;
const DEFAULT_BACKGROUND_COALESCING_DELAY_MS = 3_000;

export type DynamicRealtimeThrottleMs = (params: {
  readonly lastFetchDuration: number;
  readonly windowIsNotFocused: boolean;
}) => number;

export type StoreManagerStoreDefaults = {
  /** Default minimum interval between low-priority fetches for attached stores. */
  readonly lowPriorityThrottleMs: number;
  /** Default coalescing window used by attached stores when they do not override it. */
  readonly baseCoalescingWindowMs: number;
  /** Extra browser-tab coalescing delay applied only while a tab is in the background. */
  readonly backgroundCoalescingDelayMs: number;
  /** Default adaptive throttle for real-time updates in attached stores. */
  readonly dynamicRealtimeThrottleMs: DynamicRealtimeThrottleMs;
  /** Shared window-close blocker used by mutations in attached stores. */
  readonly blockWindowClose: BlockWindowCloseHandler | null;
  /** Default focus revalidation policy for attached stores. */
  readonly revalidateOnWindowFocus: boolean | (() => boolean) | undefined;
};

function defaultDynamicRealtimeThrottleMs({
  windowIsNotFocused,
}: Parameters<DynamicRealtimeThrottleMs>[0]): number {
  return windowIsNotFocused ? 1_000 : 100;
}

export type StoreManagerMutationErrorHandler = (
  error: unknown,
  options: StoreMutationErrorOptions,
) => void;

type StoreManagerOfflineApi<TUploadRef extends ValidPayload = ValidPayload> = {
  /** Returns the shared offline config, when configured. */
  getOfflineConfig: () => OfflineSessionConfig<TUploadRef> | undefined;
  /** Latest effective runtime config for this manager's offline session. */
  getOfflineRuntimeConfig: () => OfflineRuntimeConfig;
  /** Updates runtime controls for this manager's offline session. */
  setOfflineRuntimeConfig: (
    update: OfflineRuntimeConfigUpdate,
  ) => ResultType<void, Error>;
  /** Resets runtime controls back to the static session config. */
  resetOfflineRuntimeConfig: () => void;
  /** Returns the latest aggregated offline status for this manager. */
  getOfflineStatus: () => GlobalOfflineStatus;
  /** Returns the latest aggregated offline entities for this manager. */
  getOfflineEntities: () => readonly GlobalOfflineEntity[];
  /** Returns the latest aggregated offline resolutions for this manager. */
  getOfflineResolutions: () => readonly OfflineResolutionRecord[];
  /** Returns the latest session-scoped offline uploads for this manager. */
  getOfflineUploads: () => readonly OfflineUpload<TUploadRef>[];
  /** Resolves a staged upload id to its latest final ref, uploading first if needed. */
  resolveOfflineUpload: (id: string) => Promise<ResultType<TUploadRef, Error>>;
  /** Resolves multiple staged upload ids to their latest final refs. */
  resolveOfflineUploads: (
    ids: readonly string[],
  ) => Promise<ResultType<Record<string, TUploadRef>, Error>>;
  /** Saves a session-scoped upload locally for later dependency resolution. */
  saveOfflineUpload: (args: {
    id: string;
    file: Blob | File;
  }) => Promise<ResultType<void, Error>>;
  /** Replaces a previously stored session-scoped upload. */
  replaceOfflineUpload: (args: {
    id: string;
    file: Blob | File;
  }) => Promise<ResultType<void, Error>>;
  /** Loads a previously stored session-scoped upload. */
  loadOfflineUpload: (id: string) => Promise<ResultType<File | null, Error>>;
  /** Deletes a stored upload when it is no longer referenced. */
  deleteOfflineUpload: (id: string) => Promise<ResultType<void, Error>>;
  /** React hook subscribing to the manager's aggregated offline status. */
  useOfflineStatus: () => GlobalOfflineStatus;
  /** React hook subscribing to the manager's aggregated offline entities. */
  useOfflineEntities: () => readonly GlobalOfflineEntity[];
  /** React hook subscribing to the manager's aggregated offline resolutions. */
  useOfflineResolutions: () => readonly OfflineResolutionRecord[];
  /** React hook subscribing to the manager's aggregated offline uploads. */
  useOfflineUploads: () => readonly OfflineUpload<TUploadRef>[];
};

/** Shared coordinator passed to every TSDF store instance in an app/session. */
export type StoreManager<TUploadRef extends ValidPayload = ValidPayload> = {
  /** Returns the active shared session / tenant key. */
  getSessionKey: () => string | false;
  /** Shared debug logger for browser-tab sync, focus lifecycle, and persistent storage internals. */
  debugLogger?: TSDFDebugLogger;
  /** Shared logger for low-volume production signals. */
  logger?: TSDFDebugLogger;
  /** Normalizes raw exceptions into the shared StoreError shape. */
  errorNormalizer: (exception: Error) => StoreError;
  /** Global fallback for persistent storage failures in attached stores. */
  onPersistentStorageError: PersistentStorageErrorHandler | undefined;
  /** Global fallback for mutation failures in attached stores. */
  onMutationError: StoreManagerMutationErrorHandler | undefined;
  /** Shared defaults used by attached stores unless a store-level override exists. */
  storeDefaults: StoreManagerStoreDefaults;
  /** Returns the unique ids of all currently registered store instances. */
  getAllStoreIds: () => string[];
  /** Resets all registered stores except the ignored logical ids. */
  resetAll: (ignoreStores: string[]) => void;
  /** Signals a shared real-time transport reconnect to all registered stores. */
  onTransportReconnect: () => void;
} & StoreManagerOfflineApi<TUploadRef>;

type RegisteredStore = {
  id: string;
  reset: () => void;
  onTransportReconnect: () => void;
};

type StoreManagerRegistry = {
  browserTabsPresence: BrowserTabsPresencePriority | undefined;
  nextStoreRegistrationId: number;
  stores: Map<number, RegisteredStore>;
};

const storeManagerRegistry = new WeakMap<StoreManager, StoreManagerRegistry>();
const storeManagerOfflineSessionRegistry = new WeakMap<
  StoreManager,
  OfflineSession | undefined
>();

const EMPTY_OFFLINE_ENTITIES: readonly GlobalOfflineEntity[] = [];
const EMPTY_OFFLINE_RESOLUTIONS: readonly OfflineResolutionRecord[] = [];
const INACTIVE_SESSION_KEY = '__inactive__';

function normalizeStoreManagerOfflineError(error: unknown): Error {
  const normalizedError = unknownToError(error);

  if (
    import.meta.env.DEV &&
    normalizedError.message.startsWith('[tsdf] Incompatible offline ')
  ) {
    throw normalizedError;
  }

  return normalizedError;
}

function createDisabledStoreManagerOfflineApi<
  TUploadRef extends ValidPayload = ValidPayload,
>(getSessionKey: () => string | false): StoreManagerOfflineApi<TUploadRef> {
  const emptyUploads: readonly OfflineUpload<TUploadRef>[] = [];
  let cachedStatus: GlobalOfflineStatus | null = null;
  let cachedStatusSessionKey: string | null = null;

  const getOfflineStatus = () => {
    const sessionKey = getSessionKey();
    const resolvedSessionKey =
      typeof sessionKey === 'string' ? sessionKey : INACTIVE_SESSION_KEY;

    if (cachedStatusSessionKey === resolvedSessionKey && cachedStatus) {
      return cachedStatus;
    }

    cachedStatusSessionKey = resolvedSessionKey;
    cachedStatus = createDefaultStatus(resolvedSessionKey);
    return cachedStatus;
  };

  return {
    getOfflineConfig: () => undefined,
    getOfflineRuntimeConfig: () => defaultOfflineRuntimeConfig,
    setOfflineRuntimeConfig: () => Result.ok(undefined),
    resetOfflineRuntimeConfig: () => {},
    getOfflineStatus,
    getOfflineEntities: () => EMPTY_OFFLINE_ENTITIES,
    getOfflineResolutions: () => EMPTY_OFFLINE_RESOLUTIONS,
    getOfflineUploads: () => emptyUploads,
    resolveOfflineUpload: () =>
      Promise.resolve(
        Result.err(
          new Error(
            '[tsdf] Offline uploads are not configured for this manager',
          ),
        ),
      ),
    resolveOfflineUploads: () =>
      Promise.resolve(
        Result.err(
          new Error(
            '[tsdf] Offline uploads are not configured for this manager',
          ),
        ),
      ),
    saveOfflineUpload: () => Promise.resolve(Result.ok(undefined)),
    replaceOfflineUpload: () => Promise.resolve(Result.ok(undefined)),
    loadOfflineUpload: () => Promise.resolve(Result.ok(null)),
    deleteOfflineUpload: () => Promise.resolve(Result.ok(undefined)),
    useOfflineStatus: getOfflineStatus,
    useOfflineEntities: () => EMPTY_OFFLINE_ENTITIES,
    useOfflineResolutions: () => EMPTY_OFFLINE_RESOLUTIONS,
    useOfflineUploads: () => emptyUploads,
  };
}

/** Options used to create a shared TSDF store manager. */
export type CreateStoreManagerOptions<
  TUploadRef extends ValidPayload = ValidPayload,
> = {
  /**
   * Returns the current authenticated session / tenant key shared by all
   * stores attached to this manager. Return `false` to disable session-scoped
   * behavior while no account is loaded.
   */
  getSessionKey: () => string | false;
  /** Normalizes raw exceptions into the shared StoreError shape. */
  errorNormalizer: (exception: Error) => StoreError;
  /** Default minimum interval between low-priority fetches for attached stores. Defaults to 40 minutes. */
  lowPriorityThrottleMs?: number;
  /** Default coalescing window for attached stores. Defaults to 16ms. */
  baseCoalescingWindowMs?: number;
  /** Extra browser-tab coalescing delay applied only while a tab is in the background. Defaults to 3000ms. */
  backgroundCoalescingDelayMs?: number;
  /** Default adaptive throttle for real-time updates in attached stores. Store-level values override it. */
  dynamicRealtimeThrottleMs?: DynamicRealtimeThrottleMs;
  /** Shared window-close blocker used by mutations in attached stores. Pass `null` to disable. */
  blockWindowClose?: BlockWindowCloseHandler | null;
  /** Global fallback for persistent storage failures when a store does not provide its own handler. */
  onPersistentStorageError?: PersistentStorageErrorHandler;
  /** Global fallback for mutation failures when a store does not provide its own handler. */
  onMutationError?: StoreManagerMutationErrorHandler;
  /** Default focus revalidation policy for attached stores. Store-level values override it. */
  revalidateOnWindowFocus?: boolean | (() => boolean);
  /** Enables verbose development-only logs. Pass `true` to use console logging, or pass a logger function. */
  debugLogger?: TSDFLoggerOptions;
  /** Enables low-volume production-safe logs. Defaults to console logging; pass `false` to disable. */
  logger?: TSDFLoggerOptions;
  /** Optional shared offline session config for every attached store. */
  offlineSession?: OfflineSessionConfig<TUploadRef>;
};

export function createStoreManager<
  TUploadRef extends ValidPayload = ValidPayload,
>(options: CreateStoreManagerOptions<TUploadRef>): StoreManager<TUploadRef> {
  const debugLogger = import.meta.env.DEV
    ? resolveTSDFLogger(options.debugLogger)
    : undefined;
  const logger = resolveTSDFLogger(options.logger ?? true);
  let resolvedOfflineSession: OfflineSession<TUploadRef> | undefined;
  if (options.offlineSession) {
    const createOfflineSessionOptions: Parameters<
      typeof createOfflineSession<TUploadRef>
    >[0] = {
      config: options.offlineSession,
      getSessionKey: options.getSessionKey,
    };
    if (debugLogger !== undefined) {
      createOfflineSessionOptions.debugLogger = debugLogger;
    }
    resolvedOfflineSession = createOfflineSession<TUploadRef>(
      createOfflineSessionOptions,
    );
  }
  const offlineApi: StoreManagerOfflineApi<TUploadRef> = resolvedOfflineSession
    ? {
        getOfflineConfig: () => resolvedOfflineSession.getConfig(),
        getOfflineRuntimeConfig: () =>
          resolvedOfflineSession.getOfflineRuntimeConfig(),
        setOfflineRuntimeConfig: (update: OfflineRuntimeConfigUpdate) =>
          resultify(() => {
            resolvedOfflineSession.setOfflineRuntimeConfig(update);
          }, normalizeStoreManagerOfflineError),
        resetOfflineRuntimeConfig: () => {
          resolvedOfflineSession.resetOfflineRuntimeConfig();
        },
        getOfflineStatus: () => resolvedOfflineSession.getOfflineStatus(),
        getOfflineEntities: () => resolvedOfflineSession.getOfflineEntities(),
        getOfflineResolutions: () =>
          resolvedOfflineSession.getOfflineResolutions(),
        getOfflineUploads: () => resolvedOfflineSession.getOfflineUploads(),
        resolveOfflineUpload: (id: string) =>
          resultify(
            () => resolvedOfflineSession.resolveOfflineUpload(id),
            normalizeStoreManagerOfflineError,
          ),
        resolveOfflineUploads: (ids: readonly string[]) =>
          resultify(
            () => resolvedOfflineSession.resolveOfflineUploads(ids),
            normalizeStoreManagerOfflineError,
          ),
        saveOfflineUpload: (args: { id: string; file: Blob | File }) =>
          resultify(
            () => resolvedOfflineSession.saveOfflineUpload(args),
            normalizeStoreManagerOfflineError,
          ),
        replaceOfflineUpload: (args: { id: string; file: Blob | File }) =>
          resultify(
            () => resolvedOfflineSession.replaceOfflineUpload(args),
            normalizeStoreManagerOfflineError,
          ),
        loadOfflineUpload: (id: string) =>
          resultify(
            () => resolvedOfflineSession.loadOfflineUpload(id),
            normalizeStoreManagerOfflineError,
          ),
        deleteOfflineUpload: (id: string) =>
          resultify(
            () => resolvedOfflineSession.deleteOfflineUpload(id),
            normalizeStoreManagerOfflineError,
          ),
        useOfflineStatus: () => resolvedOfflineSession.useOfflineStatus(),
        useOfflineEntities: () => resolvedOfflineSession.useOfflineEntities(),
        useOfflineResolutions: () =>
          resolvedOfflineSession.useOfflineResolutions(),
        useOfflineUploads: () => resolvedOfflineSession.useOfflineUploads(),
      }
    : createDisabledStoreManagerOfflineApi<TUploadRef>(options.getSessionKey);

  const registry: StoreManagerRegistry = {
    browserTabsPresence: undefined,
    nextStoreRegistrationId: 0,
    stores: new Map(),
  };

  const storeManager: StoreManager<TUploadRef> = {
    getSessionKey: options.getSessionKey,
    errorNormalizer: options.errorNormalizer,
    onPersistentStorageError: options.onPersistentStorageError,
    onMutationError: options.onMutationError,
    storeDefaults: Object.freeze({
      lowPriorityThrottleMs:
        options.lowPriorityThrottleMs ?? DEFAULT_LOW_PRIORITY_THROTTLE_MS,
      baseCoalescingWindowMs:
        options.baseCoalescingWindowMs ?? DEFAULT_BASE_COALESCING_WINDOW_MS,
      backgroundCoalescingDelayMs:
        options.backgroundCoalescingDelayMs ??
        DEFAULT_BACKGROUND_COALESCING_DELAY_MS,
      dynamicRealtimeThrottleMs:
        options.dynamicRealtimeThrottleMs ?? defaultDynamicRealtimeThrottleMs,
      blockWindowClose: options.blockWindowClose ?? null,
      revalidateOnWindowFocus: options.revalidateOnWindowFocus,
    }),
    getAllStoreIds: () => Array.from(registry.stores.values(), ({ id }) => id),
    resetAll: (ignoreStores) => {
      const ignoredStoreIds = new Set(ignoreStores);

      for (const registeredStore of [...registry.stores.values()]) {
        if (ignoredStoreIds.has(registeredStore.id)) continue;
        registeredStore.reset();
      }
    },
    onTransportReconnect: () => {
      for (const registeredStore of [...registry.stores.values()]) {
        registeredStore.onTransportReconnect();
      }
    },
    ...offlineApi,
  };
  storeManager.debugLogger = debugLogger;
  storeManager.logger = logger;

  storeManagerRegistry.set(storeManager, registry);
  storeManagerOfflineSessionRegistry.set(storeManager, resolvedOfflineSession);

  return storeManager;
}

function getRegistryOrThrow(storeManager: StoreManager): StoreManagerRegistry {
  const registry = storeManagerRegistry.get(storeManager);
  if (!registry) {
    throw new Error(
      '[tsdf] storeManager must be created with createStoreManager(...)',
    );
  }
  return registry;
}

export function registerStoreWithManager(
  storeManager: StoreManager,
  store: RegisteredStore,
): () => void {
  const registry = getRegistryOrThrow(storeManager);

  let hasDuplicateId = false;
  for (const registeredStore of registry.stores.values()) {
    if (registeredStore.id === store.id) {
      hasDuplicateId = true;
      break;
    }
  }

  if (hasDuplicateId) {
    throw new Error(
      `[tsdf] Duplicate store id "${store.id}" created in the same storeManager. Store ids must be unique per manager so global operations like resetAll(...) stay unambiguous.`,
    );
  }

  const registrationId = registry.nextStoreRegistrationId;
  registry.nextStoreRegistrationId += 1;
  registry.stores.set(registrationId, store);

  return () => {
    registry.stores.delete(registrationId);
    if (registry.stores.size === 0) {
      registry.browserTabsPresence?.close();
      registry.browserTabsPresence = undefined;
    }
  };
}

export function getOrCreateStoreManagerBrowserTabsPresence(
  storeManager: StoreManager,
  options: {
    getWindowIsFocused: () => boolean;
    onWindowFocusChange?: (handler: () => void) => () => void;
    transportFactory?: BrowserTabsTransportFactory;
    priorityTimings?: BrowserTabsPriorityTimings;
  },
): {
  priority: { getCoalescingWindowMs: (baseMs: number) => number };
  tabId: string;
} {
  const registry = getRegistryOrThrow(storeManager);

  const presence = (registry.browserTabsPresence ??=
    createBrowserTabsPresencePriority({
      getSessionKey: storeManager.getSessionKey,
      getWindowIsFocused: options.getWindowIsFocused,
      onWindowFocusChange: options.onWindowFocusChange,
      transportFactory: options.transportFactory,
      ...(import.meta.env.DEV
        ? { debugLogger: storeManager.debugLogger }
        : undefined),
      priorityTimings: {
        backgroundCoalescingDelayMs:
          storeManager.storeDefaults.backgroundCoalescingDelayMs,
        ...options.priorityTimings,
      },
    }));

  return { priority: presence.priority, tabId: presence.tabId };
}

export function resolveStoreManagerOfflineSession<
  TUploadRef extends ValidPayload = ValidPayload,
>(
  storeManager: StoreManager<TUploadRef>,
  storeName: string,
  usesOfflineStorage: boolean,
): OfflineSession<TUploadRef> | null {
  // WORKAROUND: The manager registry stores sessions behind a shared
  // non-generic weak map, and this rebind restores the caller's known upload-ref
  // type when reading its own session back out.
  const offlineSession = __LEGIT_CAST__<
    OfflineSession<TUploadRef> | undefined,
    OfflineSession | undefined
  >(storeManagerOfflineSessionRegistry.get(storeManager));
  if (!usesOfflineStorage) return null;

  if (!offlineSession) {
    throw new Error(
      `[tsdf] Store "${storeName}" has persistentStorage.offline configured but storeManager was created without offlineSession`,
    );
  }

  return offlineSession;
}

export function validateStoreManagerSessionConsistency(
  storeName: string,
  offlineSession: OfflineSession,
  getSessionKey: () => string | false,
): string | false {
  const sessionKey = getSessionKey();
  const offlineSessionKey = offlineSession.getSessionKey();

  if (sessionKey !== offlineSessionKey) {
    throw new Error(
      `[tsdf] Store "${storeName}" is attached to offline session "${offlineSessionKey}" but storeManager.getSessionKey() returned "${sessionKey}"`,
    );
  }

  return sessionKey;
}
