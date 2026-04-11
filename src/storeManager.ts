import { createOfflineSession } from './persistentStorage/offline/sessionCoordinator';
import type {
  OfflineSession,
  OfflineSessionConfig,
} from './persistentStorage/offline/types';
import type { StoreError } from './utils/storeShared';

export type StoreManager = {
  /** Returns the active shared session / tenant key. */
  getSessionKey: () => string | false;
  /** Normalizes raw exceptions into the shared StoreError shape. */
  errorNormalizer: (exception: Error) => StoreError;
  /** Returns the shared offline session, when configured. */
  getOfflineSession: () => OfflineSession | undefined;
  /** Returns the unique ids of all currently registered store instances. */
  getAllStoreIds: () => string[];
  /** Resets all registered stores except the ignored logical ids. */
  resetAll: (ignoreStores: string[]) => void;
};

type RegisteredStore = { id: string; reset: () => void };

type StoreManagerRegistry = {
  nextStoreRegistrationId: number;
  stores: Map<number, RegisteredStore>;
};

const storeManagerRegistry = new WeakMap<StoreManager, StoreManagerRegistry>();

type ManagerOwnedOfflineSessionConfig = OfflineSessionConfig & {
  [K in keyof OfflineSession]?: never;
};

export type CreateStoreManagerOptions = {
  /**
   * Returns the current authenticated session / tenant key shared by all
   * stores attached to this manager. Return `false` to disable session-scoped
   * behavior while no account is loaded.
   */
  getSessionKey: () => string | false;
  /** Normalizes raw exceptions into the shared StoreError shape. */
  errorNormalizer: (exception: Error) => StoreError;
  /** Optional shared offline session config owned by this store manager. */
  offlineSession?: ManagerOwnedOfflineSessionConfig;
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

  const registry: StoreManagerRegistry = {
    nextStoreRegistrationId: 0,
    stores: new Map(),
  };

  const storeManager: StoreManager = {
    getSessionKey: options.getSessionKey,
    errorNormalizer: options.errorNormalizer,
    getOfflineSession: () => resolvedOfflineSession,
    getAllStoreIds: () => Array.from(registry.stores.values(), ({ id }) => id),
    resetAll: (ignoreStores) => {
      const ignoredStoreIds = new Set(ignoreStores);

      for (const registeredStore of [...registry.stores.values()]) {
        if (ignoredStoreIds.has(registeredStore.id)) continue;
        registeredStore.reset();
      }
    },
  };

  storeManagerRegistry.set(storeManager, registry);

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
  const offlineSession = args.storeManager.getOfflineSession();
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
