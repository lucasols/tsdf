import {
  Result,
  type Result as ResultType,
  resultify,
  unknownToError,
} from 't-result';
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
import type { StoreError } from './utils/storeShared';

type StoreManagerOfflineApi = {
  /** Returns the shared offline config, when configured. */
  getOfflineConfig: () => OfflineSessionConfig | undefined;
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
  getOfflineUploads: () => readonly OfflineUpload[];
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
  useOfflineUploads: () => readonly OfflineUpload[];
};

export type StoreManager = {
  /** Returns the active shared session / tenant key. */
  getSessionKey: () => string | false;
  /** Normalizes raw exceptions into the shared StoreError shape. */
  errorNormalizer: (exception: Error) => StoreError;
  /** Returns the unique ids of all currently registered store instances. */
  getAllStoreIds: () => string[];
  /** Resets all registered stores except the ignored logical ids. */
  resetAll: (ignoreStores: string[]) => void;
} & StoreManagerOfflineApi;

type RegisteredStore = { id: string; reset: () => void };

type StoreManagerRegistry = {
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
const EMPTY_OFFLINE_UPLOADS: readonly OfflineUpload[] = [];
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

function createDisabledStoreManagerOfflineApi(
  getSessionKey: () => string | false,
): StoreManagerOfflineApi {
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
    getOfflineUploads: () => EMPTY_OFFLINE_UPLOADS,
    saveOfflineUpload: () => Promise.resolve(Result.ok(undefined)),
    replaceOfflineUpload: () => Promise.resolve(Result.ok(undefined)),
    loadOfflineUpload: () => Promise.resolve(Result.ok(null)),
    deleteOfflineUpload: () => Promise.resolve(Result.ok(undefined)),
    useOfflineStatus: getOfflineStatus,
    useOfflineEntities: () => EMPTY_OFFLINE_ENTITIES,
    useOfflineResolutions: () => EMPTY_OFFLINE_RESOLUTIONS,
    useOfflineUploads: () => EMPTY_OFFLINE_UPLOADS,
  };
}

export type CreateStoreManagerOptions = {
  /**
   * Returns the current authenticated session / tenant key shared by all
   * stores attached to this manager. Return `false` to disable session-scoped
   * behavior while no account is loaded.
   */
  getSessionKey: () => string | false;
  /** Normalizes raw exceptions into the shared StoreError shape. */
  errorNormalizer: (exception: Error) => StoreError;
  /** Optional shared offline session config for every attached store. */
  offlineSession?: OfflineSessionConfig;
};

export function createStoreManager(
  options: CreateStoreManagerOptions,
): StoreManager {
  const resolvedOfflineSession = options.offlineSession
    ? createOfflineSession({
        config: options.offlineSession,
        getSessionKey: options.getSessionKey,
      })
    : undefined;
  const offlineApi = resolvedOfflineSession
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
    : createDisabledStoreManagerOfflineApi(options.getSessionKey);

  const registry: StoreManagerRegistry = {
    nextStoreRegistrationId: 0,
    stores: new Map(),
  };

  const storeManager: StoreManager = {
    getSessionKey: options.getSessionKey,
    errorNormalizer: options.errorNormalizer,
    getAllStoreIds: () => Array.from(registry.stores.values(), ({ id }) => id),
    resetAll: (ignoreStores) => {
      const ignoredStoreIds = new Set(ignoreStores);

      for (const registeredStore of [...registry.stores.values()]) {
        if (ignoredStoreIds.has(registeredStore.id)) continue;
        registeredStore.reset();
      }
    },
    ...offlineApi,
  };

  storeManagerRegistry.set(storeManager, registry);
  storeManagerOfflineSessionRegistry.set(storeManager, resolvedOfflineSession);

  return storeManager;
}

export function registerStoreWithManager(
  storeManager: StoreManager,
  store: RegisteredStore,
): () => void {
  const registry = storeManagerRegistry.get(storeManager);
  if (!registry) {
    throw new Error(
      '[tsdf] storeManager must be created with createStoreManager(...)',
    );
  }

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
  };
}

export function resolveStoreManagerOfflineSession(args: {
  storeManager: StoreManager;
  storeName: string;
  usesOfflineStorage: boolean;
}): OfflineSession | null {
  const offlineSession = storeManagerOfflineSessionRegistry.get(
    args.storeManager,
  );
  if (!args.usesOfflineStorage) return null;

  if (!offlineSession) {
    throw new Error(
      `[tsdf] Store "${args.storeName}" has persistentStorage.offline configured but storeManager was created without offlineSession`,
    );
  }

  return offlineSession;
}

export function validateStoreManagerSessionConsistency(args: {
  storeManager: StoreManager;
  storeName: string;
  offlineSession: OfflineSession;
  getSessionKey: () => string | false;
}): string | false {
  const sessionKey = args.getSessionKey();
  const offlineSessionKey = args.offlineSession.getSessionKey();

  if (sessionKey !== offlineSessionKey) {
    throw new Error(
      `[tsdf] Store "${args.storeName}" is attached to offline session "${offlineSessionKey}" but storeManager.getSessionKey() returned "${sessionKey}"`,
    );
  }

  return sessionKey;
}
