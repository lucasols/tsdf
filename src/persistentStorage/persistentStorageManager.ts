import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { rc_number, rc_object, rc_parse_json, rc_unknown } from 'runcheck';
import {
  clearManagedLocalStorageRoot,
  clearManagedLocalStorageSession,
  getManagedLocalStorageRootKeyForPrefix,
  getManagedLocalStorageRootKeyForSingle,
  listManagedLocalStorageKeysSync,
  readManagedLocalStorageEntryByPayload,
  registerManagedLocalStorageRoot,
  removeManagedLocalStoragePayload,
  resetManagedLocalStorageState,
  runManagedLocalStorageMaintenance,
  touchManagedLocalStoragePayload,
  upsertManagedLocalStorageNamespaceEntry,
  upsertManagedLocalStorageSingleEntry,
} from './localStorageMetadata';
import {
  OpfsAsyncStorageAdapter,
  serializeProtectedRef,
} from './opfsAsyncStorageAdapter';
import { scheduleIdleCleanup } from './scheduleIdleCleanup';
import {
  isAsyncStorageAdapter,
  localPersistentStorage,
  opfsPersistentStorage,
} from './storageAdapter';
import type {
  AsyncStorageMetadataOrder,
  AsyncStorageNamespaceKind,
  AsyncStorageNamespaceScope,
  AsyncStorageProtectedEntryRef,
  PersistentStorageBaseConfig,
  PersistentStorageSchema,
  StorageAdapter,
  StorageCacheEntry,
} from './types';
import { validateWithSchema } from './validateWithSchema';

const DEBOUNCE_MS = 1000;
const LOCAL_STORAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ASYNC_STORAGE_METADATA_PAGE_LIMIT = 100;

const cacheEntrySchema = rc_object({
  data: rc_unknown,
  timestamp: rc_number,
  version: rc_number,
});

let scannedAdapters = new WeakSet<StorageAdapter>();

function getStorageKey(sessionKey: string, storeName: string): string {
  return `tsdf.${sessionKey}.${storeName}`;
}

function registerManagedSingleRoot(
  adapter: StorageAdapter,
  config: Omit<PersistentStorageBaseConfig<never>, 'schema'>,
  key: string,
): void {
  if (adapter !== localPersistentStorage) return;

  const sessionKey = config.getSessionKey();
  if (sessionKey === false) return;

  registerManagedLocalStorageRoot({
    sessionKey,
    storeName: config.storeName,
    mode: 'single',
    storageKey: key,
    cleanupIntervalMs: config.cleanupIntervalMs,
    maxAgeMs: LOCAL_STORAGE_MAX_AGE_MS,
  });
}

function registerManagedNamespaceRoot(
  adapter: StorageAdapter,
  config: Omit<PersistentStorageBaseConfig<never>, 'schema'>,
  prefix: string,
): void {
  if (adapter !== localPersistentStorage) return;

  const sessionKey = config.getSessionKey();
  if (sessionKey === false) return;

  registerManagedLocalStorageRoot({
    sessionKey,
    storeName: config.storeName,
    mode: 'namespace',
    storagePrefix: prefix,
    cleanupIntervalMs: config.cleanupIntervalMs,
    maxAgeMs: LOCAL_STORAGE_MAX_AGE_MS,
  });
}

function scheduleLocalStorageExpirationScanIfNeeded(adapter: StorageAdapter) {
  if (adapter !== localPersistentStorage) return;
  if (scannedAdapters.has(adapter)) return;

  scannedAdapters.add(adapter);
  scheduleIdleCleanup(() => {
    void runManagedLocalStorageMaintenance();
  });
}

function ensureAsyncNamespaceKind(
  entryPrefix: string,
): AsyncStorageNamespaceKind {
  switch (entryPrefix) {
    case 'document':
    case 'collection.item':
    case 'listQuery.item':
    case 'listQuery.query':
    case 'offline.queue':
    case 'offline.conflict':
    case 'offline.entity':
    case '__internal.protected':
      return entryPrefix;
    default:
      throw new Error(
        `[tsdf] Unsupported async namespace kind: ${entryPrefix}`,
      );
  }
}

export type PersistentStorageHandle<T> = {
  load(): Promise<T | null>;
  scheduleSave(getData: () => T): void;
  saveNow(data: T): Promise<void>;
  clear(): Promise<void>;
  dispose(): void;
};

export function createPersistentStorageHandle<T>(
  config: Omit<PersistentStorageBaseConfig<never>, 'schema'>,
  {
    getManifestMeta,
    asyncNamespace,
  }: {
    getManifestMeta?: (data: T) => Record<string, unknown> | undefined;
    asyncNamespace?: {
      storeName?: string;
      kind?: AsyncStorageNamespaceKind;
      entryKey?: string;
    };
  } = {},
): PersistentStorageHandle<T> {
  const version = config.version ?? 1;
  const adapter = config.adapter;
  const asyncEntryKey = asyncNamespace?.entryKey ?? 'document';
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function getKey(): string | false {
    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return false;

    const key = getStorageKey(sessionKey, config.storeName);
    registerManagedSingleRoot(adapter, config, key);
    return key;
  }

  function getAsyncNamespace() {
    if (!isAsyncStorageAdapter(adapter)) return null;

    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return null;

    const scope: AsyncStorageNamespaceScope = {
      sessionKey,
      storeName: asyncNamespace?.storeName ?? config.storeName,
      kind: asyncNamespace?.kind ?? 'document',
    };

    return adapter.openNamespace<T, Record<string, unknown>>(scope);
  }

  if (isAsyncStorageAdapter(adapter)) {
    void getAsyncNamespace();
  } else if (adapter === localPersistentStorage) {
    scheduleLocalStorageExpirationScanIfNeeded(adapter);
    void getKey();
  }

  function clearTimer(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  async function load(): Promise<T | null> {
    try {
      if (isAsyncStorageAdapter(adapter)) {
        const namespace = getAsyncNamespace();
        if (!namespace) return null;

        const entry = await namespace.get(asyncEntryKey, { touch: 'coarse' });
        if (!entry) return null;

        if (entry.metadata.version !== version) {
          await namespace.commit({ removes: [asyncEntryKey] });
          return null;
        }

        return entry.value;
      }

      const key = getKey();
      if (key === false) return null;
      if (readManagedLocalStorageEntryByPayload(key) === null) return null;

      const entry = adapter.read<StorageCacheEntry<T>>(key);
      if (!entry) return null;

      if (entry.version !== version) {
        scheduleIdleCleanup(() => {
          adapter.remove(key);
          removeManagedLocalStoragePayload(key);
        });
        return null;
      }

      scheduleIdleCleanup(() => refreshLocalStorageTimestamp(key));
      return entry.data;
    } catch (error) {
      config.onPersistentStorageError?.(error);
      return null;
    }
  }

  async function writeEntry(data: T): Promise<void> {
    try {
      if (isAsyncStorageAdapter(adapter)) {
        const namespace = getAsyncNamespace();
        if (!namespace) return;

        await namespace.commit({
          upserts: [
            {
              key: asyncEntryKey,
              value: data,
              version,
              metadata: getManifestMeta?.(data),
            },
          ],
        });
        return;
      }

      const key = getKey();
      if (key === false) return;

      const entry: StorageCacheEntry<T> = {
        data,
        timestamp: Date.now(),
        version,
      };
      adapter.write(key, entry);

      const sessionKey = config.getSessionKey();
      if (sessionKey !== false) {
        upsertManagedLocalStorageSingleEntry({
          sessionKey,
          storeName: config.storeName,
          storageKey: key,
          cleanupIntervalMs: config.cleanupIntervalMs,
          maxAgeMs: LOCAL_STORAGE_MAX_AGE_MS,
          lastAccessAt: entry.timestamp,
          meta: getManifestMeta?.(data),
        });
      }
    } catch (error) {
      config.onPersistentStorageError?.(error);
    }
  }

  function scheduleSave(getData: () => T): void {
    clearTimer();
    debounceTimer = setTimeout(() => {
      debounceTimer = null;

      try {
        void writeEntry(getData());
      } catch (error) {
        config.onPersistentStorageError?.(error);
      }
    }, DEBOUNCE_MS);
  }

  async function saveNow(data: T): Promise<void> {
    clearTimer();
    await writeEntry(data);
  }

  async function clear(): Promise<void> {
    clearTimer();

    try {
      if (isAsyncStorageAdapter(adapter)) {
        const namespace = getAsyncNamespace();
        if (!namespace) return;
        await namespace.commit({ removes: [asyncEntryKey] });
        return;
      }

      const key = getKey();
      if (key === false) return;
      adapter.remove(key);
      clearManagedLocalStorageRoot(getManagedLocalStorageRootKeyForSingle(key));
    } catch (error) {
      config.onPersistentStorageError?.(error);
    }
  }

  function dispose(): void {
    clearTimer();
  }

  return { load, scheduleSave, saveNow, clear, dispose };
}

export type PersistentStorageNamespaceMetadata<
  TMetadata extends Record<string, unknown>,
> = TMetadata & {
  key: string;
  lastAccessAt: number;
  writtenAt: number;
  version: number;
};

export type PersistentStorageNamespaceHandle<
  T,
  TMetadata extends Record<string, unknown> = Record<string, never>,
> = {
  readEntry(entryKey: string): Promise<StorageCacheEntry<T> | null>;
  load(entryKey: string): Promise<T | null>;
  loadMany(entryKeys: string[]): Promise<Array<T | null>>;
  save(entryKey: string, data: T): Promise<void>;
  remove(entryKey: string): Promise<void>;
  listKeys(): Promise<string[]>;
  listMetadata(args?: {
    cursor?: string | null;
    limit?: number;
    order?: AsyncStorageMetadataOrder;
  }): Promise<{
    entries: PersistentStorageNamespaceMetadata<TMetadata>[];
    cursor: string | null;
  }>;
  clear(): Promise<void>;
  dispose(): void;
};

export async function listAllPersistentStorageNamespaceMetadata<
  T,
  TMetadata extends Record<string, unknown> = Record<string, never>,
>(
  namespace: PersistentStorageNamespaceHandle<T, TMetadata>,
  args: { order?: AsyncStorageMetadataOrder; limit?: number } = {},
): Promise<PersistentStorageNamespaceMetadata<TMetadata>[]> {
  const entries: PersistentStorageNamespaceMetadata<TMetadata>[] = [];
  const limit = Math.max(1, args.limit ?? ASYNC_STORAGE_METADATA_PAGE_LIMIT);
  let cursor: string | null = null;

  do {
    const page = await namespace.listMetadata({
      cursor,
      limit,
      order: args.order,
    });

    entries.push(...page.entries);
    cursor = page.cursor;
  } while (cursor !== null);

  return entries;
}

export function createPersistentStorageNamespaceHandle<
  T,
  TMetadata extends Record<string, unknown> = Record<string, never>,
>(
  config: Omit<PersistentStorageBaseConfig<never>, 'schema'> & {
    entryPrefix: string;
  },
  {
    getManifestMeta,
  }: {
    getManifestMeta?: (data: T, entryKey: string) => TMetadata | undefined;
  } = {},
): PersistentStorageNamespaceHandle<T, TMetadata> {
  const version = config.version ?? 1;
  const adapter = config.adapter;
  const asyncNamespaceKind = ensureAsyncNamespaceKind(config.entryPrefix);

  function getPrefix(): string | false {
    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return false;

    const prefix = `${getStorageKey(sessionKey, config.storeName)}.${config.entryPrefix}.`;
    registerManagedNamespaceRoot(adapter, config, prefix);
    return prefix;
  }

  function getKey(entryKey: string): string | false {
    const prefix = getPrefix();
    if (prefix === false) return false;
    return `${prefix}${entryKey}`;
  }

  function getAsyncNamespace() {
    if (!isAsyncStorageAdapter(adapter)) return null;

    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return null;

    return adapter.openNamespace<T, TMetadata>({
      sessionKey,
      storeName: config.storeName,
      kind: asyncNamespaceKind,
    });
  }

  if (isAsyncStorageAdapter(adapter)) {
    void getAsyncNamespace();
  } else if (adapter === localPersistentStorage) {
    scheduleLocalStorageExpirationScanIfNeeded(adapter);
    void getPrefix();
  }

  async function readEntry(
    entryKey: string,
  ): Promise<StorageCacheEntry<T> | null> {
    try {
      if (isAsyncStorageAdapter(adapter)) {
        const namespace = getAsyncNamespace();
        if (!namespace) return null;

        const entry = await namespace.get(entryKey, { touch: 'never' });
        if (!entry) return null;

        if (entry.metadata.version !== version) {
          await namespace.commit({ removes: [entryKey] });
          return null;
        }

        return {
          data: entry.value,
          timestamp: entry.metadata.lastAccessAt,
          version: entry.metadata.version,
        };
      }

      const key = getKey(entryKey);
      if (key === false) return null;
      if (readManagedLocalStorageEntryByPayload(key) === null) return null;

      const entry = adapter.read<StorageCacheEntry<T>>(key);
      if (!entry) return null;

      if (entry.version !== version) {
        scheduleIdleCleanup(() => {
          adapter.remove(key);
          removeManagedLocalStoragePayload(key);
        });
        return null;
      }

      return entry;
    } catch (error) {
      config.onPersistentStorageError?.(error);
      return null;
    }
  }

  async function load(entryKey: string): Promise<T | null> {
    try {
      if (isAsyncStorageAdapter(adapter)) {
        const namespace = getAsyncNamespace();
        if (!namespace) return null;

        const entry = await namespace.get(entryKey, { touch: 'coarse' });
        if (!entry) return null;

        if (entry.metadata.version !== version) {
          await namespace.commit({ removes: [entryKey] });
          return null;
        }

        return entry.value;
      }

      const key = getKey(entryKey);
      const entry = await readEntry(entryKey);
      if (!key || !entry) return null;

      scheduleIdleCleanup(() => refreshLocalStorageTimestamp(key));
      return entry.data;
    } catch (error) {
      config.onPersistentStorageError?.(error);
      return null;
    }
  }

  async function loadMany(entryKeys: string[]): Promise<Array<T | null>> {
    if (entryKeys.length === 0) return [];

    try {
      if (isAsyncStorageAdapter(adapter)) {
        const namespace = getAsyncNamespace();
        if (!namespace) return entryKeys.map(() => null);

        const entries = await namespace.getMany(entryKeys, { touch: 'coarse' });
        const staleKeys: string[] = [];

        const values = entries.map((entry, index) => {
          if (!entry) return null;
          if (entry.metadata.version !== version) {
            const key = entryKeys[index];
            if (key !== undefined) {
              staleKeys.push(key);
            }
            return null;
          }
          return entry.value;
        });

        if (staleKeys.length > 0) {
          await namespace.commit({ removes: staleKeys });
        }

        return values;
      }

      return Promise.all(entryKeys.map((entryKey) => load(entryKey)));
    } catch (error) {
      config.onPersistentStorageError?.(error);
      return entryKeys.map(() => null);
    }
  }

  async function save(entryKey: string, data: T): Promise<void> {
    try {
      if (isAsyncStorageAdapter(adapter)) {
        const namespace = getAsyncNamespace();
        if (!namespace) return;

        await namespace.commit({
          upserts: [
            {
              key: entryKey,
              value: data,
              version,
              metadata: getManifestMeta?.(data, entryKey),
            },
          ],
        });
        return;
      }

      const key = getKey(entryKey);
      const prefix = getPrefix();
      if (key === false || prefix === false) return;

      const entry: StorageCacheEntry<T> = {
        data,
        timestamp: Date.now(),
        version,
      };
      adapter.write(key, entry);

      const sessionKey = config.getSessionKey();
      if (sessionKey !== false) {
        upsertManagedLocalStorageNamespaceEntry({
          sessionKey,
          storeName: config.storeName,
          storagePrefix: prefix,
          entryKey,
          payloadKey: key,
          cleanupIntervalMs: config.cleanupIntervalMs,
          maxAgeMs: LOCAL_STORAGE_MAX_AGE_MS,
          lastAccessAt: entry.timestamp,
          meta: getManifestMeta?.(data, entryKey),
        });
      }
    } catch (error) {
      config.onPersistentStorageError?.(error);
    }
  }

  async function remove(entryKey: string): Promise<void> {
    try {
      if (isAsyncStorageAdapter(adapter)) {
        const namespace = getAsyncNamespace();
        if (!namespace) return;
        await namespace.commit({ removes: [entryKey] });
        return;
      }

      const key = getKey(entryKey);
      if (key === false) return;
      adapter.remove(key);
      removeManagedLocalStoragePayload(key);
    } catch (error) {
      config.onPersistentStorageError?.(error);
    }
  }

  async function listMetadata(
    args: {
      cursor?: string | null;
      limit?: number;
      order?: AsyncStorageMetadataOrder;
    } = {},
  ): Promise<{
    entries: PersistentStorageNamespaceMetadata<TMetadata>[];
    cursor: string | null;
  }> {
    try {
      if (isAsyncStorageAdapter(adapter)) {
        const namespace = getAsyncNamespace();
        if (!namespace) {
          return { entries: [], cursor: null };
        }

        return namespace.listMetadata(args);
      }

      const prefix = getPrefix();
      if (prefix === false) {
        return { entries: [], cursor: null };
      }

      const order = args.order ?? 'key';
      const limit = Math.max(1, args.limit ?? 100);
      const offset =
        args.cursor === null || args.cursor === undefined
          ? 0
          : Number(args.cursor) || 0;

      const sortedEntries =
        listManagedLocalStorageKeysSync(prefix)
          ?.map((storageKey) => ({
            key: storageKey.slice(prefix.length),
            manifest: readManagedLocalStorageEntryByPayload(storageKey),
          }))
          .filter((entry) => entry.manifest !== null)
          .sort((left, right) => {
            if (order === 'key') {
              return left.key.localeCompare(right.key);
            }

            const direction = order === 'lru-asc' ? 1 : -1;
            const leftLastAccessAt = left.manifest?.lastAccessAt ?? 0;
            const rightLastAccessAt = right.manifest?.lastAccessAt ?? 0;

            if (leftLastAccessAt !== rightLastAccessAt) {
              return direction * (leftLastAccessAt - rightLastAccessAt);
            }

            return left.key.localeCompare(right.key);
          }) ?? [];

      const pageEntries = sortedEntries
        .slice(offset, offset + limit)
        .map(({ key, manifest }) => ({
          ...(manifest?.meta
            ? __LEGIT_CAST__<TMetadata, unknown>(manifest.meta)
            : __LEGIT_CAST__<TMetadata, Record<string, never>>({})),
          key,
          lastAccessAt: manifest?.lastAccessAt ?? 0,
          writtenAt: manifest?.lastAccessAt ?? 0,
          version,
        }));

      return {
        entries: pageEntries,
        cursor:
          offset + pageEntries.length >= sortedEntries.length
            ? null
            : String(offset + pageEntries.length),
      };
    } catch (error) {
      config.onPersistentStorageError?.(error);
      return { entries: [], cursor: null };
    }
  }

  async function listKeys(): Promise<string[]> {
    const entries: PersistentStorageNamespaceMetadata<TMetadata>[] = [];
    let cursor: string | null = null;

    do {
      const page = await listMetadata({
        cursor,
        limit: ASYNC_STORAGE_METADATA_PAGE_LIMIT,
        order: 'key',
      });
      entries.push(...page.entries);
      cursor = page.cursor;
    } while (cursor !== null);

    return entries.map((entry) => entry.key);
  }

  async function clear(): Promise<void> {
    try {
      if (isAsyncStorageAdapter(adapter)) {
        const namespace = getAsyncNamespace();
        if (!namespace) return;
        await namespace.clear();
        return;
      }

      const prefix = getPrefix();
      if (prefix === false) return;
      clearManagedLocalStorageRoot(
        getManagedLocalStorageRootKeyForPrefix(prefix),
      );
    } catch (error) {
      config.onPersistentStorageError?.(error);
    }
  }

  function dispose(): void {
    // No-op for namespaced handles.
  }

  return {
    readEntry,
    load,
    loadMany,
    save,
    remove,
    listKeys,
    listMetadata,
    clear,
    dispose,
  };
}

export function readFromLocalStorageSync<T>(
  key: string,
  version: number,
  schema: PersistentStorageSchema<T>,
): T | null {
  if (readManagedLocalStorageEntryByPayload(key) === null) {
    return null;
  }

  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;

    const entryResult = rc_parse_json(raw, cacheEntrySchema);
    if (!entryResult.ok) {
      scheduleIdleCleanup(() => localStorage.removeItem(key));
      return null;
    }

    const entry = entryResult.value;
    if (entry.version !== version) {
      scheduleIdleCleanup(() => {
        localStorage.removeItem(key);
        removeManagedLocalStoragePayload(key);
      });
      return null;
    }

    const validated = validateWithSchema(schema, entry.data);
    if (validated !== null) {
      scheduleIdleCleanup(() => refreshLocalStorageTimestamp(key));
    } else {
      scheduleIdleCleanup(() => {
        localStorage.removeItem(key);
        removeManagedLocalStoragePayload(key);
      });
    }

    return validated;
  } catch {
    scheduleIdleCleanup(() => {
      localStorage.removeItem(key);
      removeManagedLocalStoragePayload(key);
    });
    return null;
  }
}

export function readStorageEntryFromLocalStorageSync<T = unknown>(
  key: string,
  version: number,
): StorageCacheEntry<T> | null {
  if (readManagedLocalStorageEntryByPayload(key) === null) {
    return null;
  }

  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;

    const result = rc_parse_json(raw, cacheEntrySchema);
    if (!result.ok) {
      scheduleIdleCleanup(() => localStorage.removeItem(key));
      return null;
    }

    const entry = result.value;
    if (entry.version !== version) {
      scheduleIdleCleanup(() => {
        localStorage.removeItem(key);
        removeManagedLocalStoragePayload(key);
      });
      return null;
    }

    return __LEGIT_CAST__<StorageCacheEntry<T>, StorageCacheEntry<unknown>>(
      entry,
    );
  } catch {
    scheduleIdleCleanup(() => {
      localStorage.removeItem(key);
      removeManagedLocalStoragePayload(key);
    });
    return null;
  }
}

export function getStorageKeyForStore(
  sessionKey: string,
  storeName: string,
): string {
  return getStorageKey(sessionKey, storeName);
}

export function getStoragePrefixForStoreNamespace(
  sessionKey: string,
  storeName: string,
  entryPrefix: string,
): string {
  return `${getStorageKey(sessionKey, storeName)}.${entryPrefix}.`;
}

export function createProtectedStorageKey(args: {
  backend?: 'localStorage' | 'opfs';
  sessionKey: string;
  storeName: string;
  kind: string;
  key: string;
}): string {
  if ((args.backend ?? 'localStorage') === 'localStorage') {
    if (args.kind === 'document' && args.key === 'document') {
      return getStorageKeyForStore(args.sessionKey, args.storeName);
    }

    return `${getStoragePrefixForStoreNamespace(
      args.sessionKey,
      args.storeName,
      args.kind,
    )}${args.key}`;
  }

  return serializeProtectedRef({
    sessionKey: args.sessionKey,
    storeName: args.storeName,
    kind: ensureAsyncNamespaceKind(args.kind),
    key: args.key,
  });
}

export function listProtectedLocalStorageNamespaceKeys(
  protectedStorageKeys: Set<string>,
  prefix: string,
): Set<string> {
  return new Set(
    [...protectedStorageKeys]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length)),
  );
}

function parseProtectedAsyncStorageKey(
  protectedStorageKey: string,
): AsyncStorageProtectedEntryRef | null {
  try {
    const parsed = JSON.parse(protectedStorageKey);
    if (!Array.isArray(parsed) || parsed.length !== 4) {
      return null;
    }

    const [sessionKey, storeName, kind, key] = parsed;
    if (
      typeof sessionKey !== 'string' ||
      typeof storeName !== 'string' ||
      typeof kind !== 'string' ||
      typeof key !== 'string'
    ) {
      return null;
    }

    return { sessionKey, storeName, kind: ensureAsyncNamespaceKind(kind), key };
  } catch {
    return null;
  }
}

export function listLocalStorageNamespaceEntryKeys(prefix: string): string[] {
  return listLocalStorageKeysSync(prefix).map((storageKey) =>
    storageKey.slice(prefix.length),
  );
}

export function readLocalStorageNamespaceEntries<T>(
  prefix: string,
  version: number,
): Array<{ key: string; entry: StorageCacheEntry<T> }> {
  const entries: Array<{ key: string; entry: StorageCacheEntry<T> }> = [];

  for (const storageKey of listLocalStorageKeysSync(prefix)) {
    const entry = readStorageEntryFromLocalStorageSync<T>(storageKey, version);
    if (!entry) continue;
    entries.push({ key: storageKey.slice(prefix.length), entry });
  }

  return entries;
}

export function listLocalStorageKeysSync(prefix: string): string[] {
  return listManagedLocalStorageKeysSync(prefix) ?? [];
}

export async function clearSessionStorage(
  sessionKey: string,
  adapter: StorageAdapter,
): Promise<void> {
  if (adapter === localPersistentStorage) {
    clearManagedLocalStorageSession(sessionKey);
    return;
  }

  if (adapter instanceof OpfsAsyncStorageAdapter) {
    await adapter.clearSession(sessionKey);
  }
}

export async function clearAllSessionStorage(
  sessionKey: string,
): Promise<void> {
  await Promise.all([
    clearSessionStorage(sessionKey, localPersistentStorage),
    clearSessionStorage(sessionKey, opfsPersistentStorage),
  ]);
}

export function refreshLocalStorageTimestamp(key: string): void {
  if (touchManagedLocalStoragePayload(key)) return;

  const raw = localStorage.getItem(key);
  if (raw === null) return;

  const result = rc_parse_json(raw, cacheEntrySchema);
  if (!result.ok) return;

  localStorage.setItem(
    key,
    JSON.stringify({ ...result.value, timestamp: Date.now() }),
  );
}

export function resetExpirationScanTracking(): void {
  scannedAdapters = new WeakSet<StorageAdapter>();
  resetManagedLocalStorageState();
  if (opfsPersistentStorage instanceof OpfsAsyncStorageAdapter) {
    opfsPersistentStorage.resetForTests();
  }
}

export async function readProtectedStorageKeys(
  adapter: StorageAdapter,
  sessionKey: string,
): Promise<Set<string>> {
  if (isAsyncStorageAdapter(adapter)) {
    const namespace = adapter.openNamespace<{ keys: string[] }>({
      sessionKey,
      storeName: '__offline__',
      kind: '__internal.protected',
    });
    const entry = await namespace.get('registry', { touch: 'never' });
    return new Set(entry?.value.keys ?? []);
  }

  const entry = adapter.read<StorageCacheEntry<{ keys: string[] }>>(
    `tsdf.${sessionKey}.__offline__.protected`,
  );
  return new Set(entry?.data.keys ?? []);
}

export async function readProtectedStorageNamespaceKeys(
  adapter: StorageAdapter,
  sessionKey: string | false,
  args: {
    localStoragePrefix?: string | false | null;
    asyncScope?: AsyncStorageNamespaceScope | null;
  },
): Promise<Set<string>> {
  if (sessionKey === false) {
    return new Set<string>();
  }

  const protectedStorageKeys = await readProtectedStorageKeys(
    adapter,
    sessionKey,
  );
  if (isAsyncStorageAdapter(adapter)) {
    const scope = args.asyncScope;
    if (!scope) return new Set<string>();

    const namespaceKeys = new Set<string>();

    for (const protectedStorageKey of protectedStorageKeys) {
      const ref = parseProtectedAsyncStorageKey(protectedStorageKey);
      if (
        ref?.sessionKey === scope.sessionKey &&
        ref.storeName === scope.storeName &&
        ref.kind === scope.kind
      ) {
        namespaceKeys.add(ref.key);
      }
    }

    return namespaceKeys;
  }

  if (typeof args.localStoragePrefix !== 'string') {
    return new Set<string>();
  }

  return listProtectedLocalStorageNamespaceKeys(
    protectedStorageKeys,
    args.localStoragePrefix,
  );
}
