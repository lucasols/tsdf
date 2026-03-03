import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import type { Store } from 't-state';
import type {
  TSDFItemQuery,
  TSFDListQuery,
  TSFDListQueryState,
} from '../listQueryStore/types';
import type { ValidPayload, ValidStoreState } from '../utils/storeShared';
import {
  createPersistentStorageHandle,
  getStorageKeyForStore,
} from './persistentStorageManager';
import type {
  ListQueryPersistentStorageConfig,
  PersistedListQueryData,
  PersistedQuery,
  StorageAdapter,
} from './types';
import { validateWithSchema } from './validateWithSchema';

const DEFAULT_MAX_ITEMS = 100;
const DEFAULT_MAX_QUERIES = 20;

/**
 * Synchronously reads persisted list query data from localStorage.
 */
function readListQueryFromLocalStorageSync(
  key: string,
  version: number,
): PersistedListQueryData<unknown> | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;

    const entry: unknown = JSON.parse(raw);

    if (
      !entry ||
      typeof entry !== 'object' ||
      !('version' in entry) ||
      !('data' in entry)
    ) {
      return null;
    }

    const typedEntry = __LEGIT_CAST__<
      { version: unknown; data: unknown },
      object
    >(entry);

    if (typedEntry.version !== version) return null;

    const data = typedEntry.data;

    if (
      !data ||
      typeof data !== 'object' ||
      !('items' in data) ||
      !('queries' in data)
    ) {
      return null;
    }

    return __LEGIT_CAST__<PersistedListQueryData<unknown>, object>(data);
  } catch {
    return null;
  }
}

/**
 * Validates persisted items and reconstructs ListQueryStore state.
 */
function validatePersistedListQueryData<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
>(
  persisted: PersistedListQueryData<unknown>,
  config: ListQueryPersistentStorageConfig<ItemState>,
): TSFDListQueryState<ItemState, QueryPayload, ItemPayload> | null {
  const items: Record<string, ItemState | null> = {};
  const queries: Record<string, TSFDListQuery<QueryPayload>> = {};
  const itemQueries: Record<string, TSDFItemQuery<ItemPayload> | null> = {};
  let hasValidData = false;

  // Validate items
  for (const [itemKey, itemData] of Object.entries(persisted.items)) {
    const validated = validateWithSchema(config.schema, itemData);
    if (validated === null) continue;

    items[itemKey] = validated;
    hasValidData = true;

    // Reconstruct item query from persisted itemPayloads
    const itemPayload = persisted.itemPayloads[itemKey];
    if (itemPayload !== undefined) {
      itemQueries[itemKey] = {
        error: null,
        status: 'success',
        wasLoaded: true,
        refetchOnMount: 'lowPriority',
        payload: __LEGIT_CAST__<ItemPayload, unknown>(itemPayload),
      };
    }
  }

  // Reconstruct queries
  for (const [queryKey, query] of Object.entries(persisted.queries)) {
    // Only include queries whose items all exist in the validated items
    const validItems = query.items.filter((itemKey) => itemKey in items);

    queries[queryKey] = {
      error: null,
      status: 'success',
      payload: __LEGIT_CAST__<QueryPayload, unknown>(query.payload),
      hasMore: query.hasMore,
      wasLoaded: true,
      refetchOnMount: 'lowPriority',
      items: validItems,
    };
    hasValidData = true;
  }

  if (!hasValidData) return null;

  return {
    items,
    queries,
    itemQueries,
    // Fields start empty — will be repopulated on refetch
    itemLoadedFields: {},
    itemFieldInvalidationFields: {},
  };
}

/**
 * Applies eviction limits to queries and items before saving.
 */
function evictListQueryData<State>(
  data: PersistedListQueryData<State>,
  maxQueries: number,
  maxItems: number,
  pinnedQueries: Set<string>,
  pinnedItems: Set<string>,
): PersistedListQueryData<State> {
  // Evict queries: pinned first, then most recent
  const queryEntries = Object.entries(data.queries);

  let keptQueries: [string, PersistedQuery][];

  if (queryEntries.length <= maxQueries) {
    keptQueries = queryEntries;
  } else {
    queryEntries.sort(([keyA], [keyB]) => {
      const aPinned = pinnedQueries.has(keyA);
      const bPinned = pinnedQueries.has(keyB);

      if (aPinned && !bPinned) return -1;
      if (!aPinned && bPinned) return 1;

      return 0;
    });

    keptQueries = queryEntries.slice(0, maxQueries);
  }

  const evictedQueries: Record<string, PersistedQuery> = {};
  const referencedItems = new Set<string>();

  for (const [key, query] of keptQueries) {
    evictedQueries[key] = query;

    for (const itemKey of query.items) {
      referencedItems.add(itemKey);
    }
  }

  // Evict items: query-referenced items first, then pinned, then rest
  const itemEntries = Object.entries(data.items);

  let keptItems: [string, State][];

  if (itemEntries.length <= maxItems) {
    keptItems = itemEntries;
  } else {
    itemEntries.sort(([keyA], [keyB]) => {
      const aReferenced = referencedItems.has(keyA);
      const bReferenced = referencedItems.has(keyB);

      if (aReferenced && !bReferenced) return -1;
      if (!aReferenced && bReferenced) return 1;

      const aPinned = pinnedItems.has(keyA);
      const bPinned = pinnedItems.has(keyB);

      if (aPinned && !bPinned) return -1;
      if (!aPinned && bPinned) return 1;

      return 0;
    });

    keptItems = itemEntries.slice(0, maxItems);
  }

  const evictedItems: Record<string, State> = {};
  const keptItemKeys = new Set<string>();

  for (const [key, item] of keptItems) {
    evictedItems[key] = item;
    keptItemKeys.add(key);
  }

  // Filter itemPayloads to only include kept items
  const evictedItemPayloads: Record<string, unknown> = {};

  for (const [key, payload] of Object.entries(data.itemPayloads)) {
    if (keptItemKeys.has(key)) {
      evictedItemPayloads[key] = payload;
    }
  }

  // Update query items to only reference kept items
  for (const [key, query] of Object.entries(evictedQueries)) {
    evictedQueries[key] = {
      ...query,
      items: query.items.filter((itemKey) => keptItemKeys.has(itemKey)),
    };
  }

  return {
    items: evictedItems,
    queries: evictedQueries,
    itemPayloads: evictedItemPayloads,
  };
}

export type ListQueryPersistenceSetup<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = {
  /** Initial state from synchronous localStorage read. Null if not available. */
  initialState: TSFDListQueryState<ItemState, QueryPayload, ItemPayload> | null;
  /** Attach to the store to enable async hydration and save subscriptions. */
  attach(
    store: Store<TSFDListQueryState<ItemState, QueryPayload, ItemPayload>>,
  ): void;
  /** Dispose subscriptions and cancel pending saves. */
  dispose(): void;
  /** Clear persisted data. */
  clear(): Promise<void>;
};

/**
 * Sets up persistent storage for a ListQueryStore.
 */
export function setupListQueryPersistence<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
>(
  config: ListQueryPersistentStorageConfig<ItemState> & {
    getSessionKey: () => string | false;
  },
  options: {
    adapter?: StorageAdapter;
  } = {},
): ListQueryPersistenceSetup<ItemState, QueryPayload, ItemPayload> {
  type State = TSFDListQueryState<ItemState, QueryPayload, ItemPayload>;

  const version = config.version ?? 1;
  const backend = config.backend ?? 'opfs';
  const maxItems = config.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxQueries = config.maxQueries ?? DEFAULT_MAX_QUERIES;
  const pinnedItems = new Set(config.pinnedItems ?? []);
  const pinnedQueries = new Set(config.pinnedQueries ?? []);

  const handle = createPersistentStorageHandle<
    PersistedListQueryData<ItemState>
  >(config, { adapter: options.adapter });

  // Synchronous initial state (localStorage only)
  let initialState: ListQueryPersistenceSetup<
    ItemState,
    QueryPayload,
    ItemPayload
  >['initialState'] = null;

  if (backend === 'localStorage') {
    const sessionKey = config.getSessionKey();

    if (sessionKey !== false) {
      const key = getStorageKeyForStore(sessionKey, config.storeName);
      const persisted = readListQueryFromLocalStorageSync(key, version);

      if (persisted) {
        initialState = validatePersistedListQueryData<
          ItemState,
          QueryPayload,
          ItemPayload
        >(persisted, config);
      }
    }
  }

  let unsubscribe: (() => void) | null = null;
  let disposed = false;

  function attach(store: Store<State>): void {
    // Async hydration for OPFS
    if (backend === 'opfs') {
      void handle.load().then((cached) => {
        if (!cached || disposed) return;

        const currentState = store.state;
        const hasExistingData =
          Object.keys(currentState.items).length > 0 ||
          Object.keys(currentState.queries).length > 0;
        if (hasExistingData) return;

        const validated = validatePersistedListQueryData<
          ItemState,
          QueryPayload,
          ItemPayload
        >(cached, config);

        if (!validated) return;

        store.setPartialState(validated, {
          action: 'persistent-storage-hydrate',
        });
      });
    }

    // Subscribe to state changes for saving
    unsubscribe = store.subscribe(({ current }) => {
      handle.scheduleSave(() => {
        const stateToSave = store.state;
        const persistedItems: Record<string, ItemState> = {};
        const persistedQueries: Record<string, PersistedQuery> = {};
        const persistedItemPayloads: Record<string, unknown> = {};

        // Collect items
        for (const [itemKey, itemData] of Object.entries(stateToSave.items)) {
          if (itemData !== null) {
            persistedItems[itemKey] = itemData;
          }
        }

        // Collect item payloads from itemQueries
        for (const [itemKey, itemQuery] of Object.entries(
          stateToSave.itemQueries,
        )) {
          if (itemQuery) {
            persistedItemPayloads[itemKey] = itemQuery.payload;
          }
        }

        // Collect queries
        for (const [queryKey, query] of Object.entries(stateToSave.queries)) {
          if (query.status === 'success' || query.wasLoaded) {
            persistedQueries[queryKey] = {
              payload: query.payload,
              items: query.items,
              hasMore: query.hasMore,
            };
          }
        }

        const data: PersistedListQueryData<ItemState> = {
          items: persistedItems,
          queries: persistedQueries,
          itemPayloads: persistedItemPayloads,
        };

        return evictListQueryData(
          data,
          maxQueries,
          maxItems,
          pinnedQueries,
          pinnedItems,
        );
      });

      // Suppress unused variable warning
      void current;
    });
  }

  function dispose(): void {
    disposed = true;
    unsubscribe?.();
    unsubscribe = null;
    handle.dispose();
  }

  async function clear(): Promise<void> {
    await handle.clear();
  }

  return { initialState, attach, dispose, clear };
}
