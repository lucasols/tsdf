import { filterAndMap } from '@ls-stack/utils/arrayUtils';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import {
  rc_number,
  rc_object,
  rc_parse,
  rc_parse_json,
  rc_unknown,
} from 'runcheck';
import {
  OpfsAsyncStorageAdapter,
  serializeProtectedRef,
} from './opfsAsyncStorageAdapter';
import { scheduleIdleCleanup } from './scheduleIdleCleanup';
import {
  createStorageAdapter,
  isAsyncStorageAdapter,
  isSyncStorageAdapter,
} from './storageAdapter';
import type {
  AsyncStorageAdapter,
  AsyncStorageEntryMetadata,
  AsyncStorageMetadataPage,
  AsyncStorageNamespaceGetResult,
  AsyncStorageNamespaceHandle,
  AsyncStorageNamespaceKind,
  AsyncStorageProtectedEntryRef,
  SyncStorageAdapter,
  PersistentStorageBaseConfig,
  PersistentStorageSchema,
  StorageAdapter,
  StorageBackend,
  StorageCacheEntry,
} from './types';
import { validateWithSchema } from './validateWithSchema';

const DEBOUNCE_MS = 1000;
const LOCAL_STORAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const scannedSyncBackends = new Set<StorageBackend>();

const cacheEntrySchema = rc_object({
  data: rc_unknown,
  timestamp: rc_number,
  version: rc_number,
});

const timestampSchema = rc_object({ timestamp: rc_number });

function getStorageKey(sessionKey: string, storeName: string): string {
  return `tsdf.${sessionKey}.${storeName}`;
}

function ensureSyncAdapter(
  adapter: StorageAdapter,
  backend: StorageBackend,
): SyncStorageAdapter {
  if (isSyncStorageAdapter(adapter)) return adapter;

  throw new Error(
    `[tsdf] Backend "${backend}" requires a sync storage adapter`,
  );
}

function ensureAsyncAdapter(
  adapter: StorageAdapter,
  backend: StorageBackend,
): AsyncStorageAdapter {
  if (isAsyncStorageAdapter(adapter)) return adapter;

  throw new Error(
    `[tsdf] Backend "${backend}" requires a namespace-native async storage adapter`,
  );
}

function scheduleLocalStorageExpirationScanIfNeeded(
  adapter: StorageAdapter,
  backend: StorageBackend,
  adapterOverride: boolean,
): void {
  if (backend !== 'localStorage') return;
  if (adapterOverride) return;
  if (scannedSyncBackends.has(backend)) return;

  scannedSyncBackends.add(backend);
  scheduleIdleCleanup(() => {
    void runLocalStorageExpirationScan(adapter);
  });
}

export type PersistentStorageHandle<T> = {
  load(): Promise<T | null>;
  scheduleSave(getData: () => T): void;
  saveNow(data: T): Promise<void>;
  clear(): Promise<void>;
  dispose(): void;
};

export function createPersistentStorageHandle<T>(
  config: Omit<PersistentStorageBaseConfig<never>, 'schema'> & {
    namespaceKind?: AsyncStorageNamespaceKind;
    entryKey?: string;
  },
  { adapter: adapterOverride }: { adapter?: StorageAdapter } = {},
): PersistentStorageHandle<T> {
  const version = config.version ?? 1;
  const backendKey: StorageBackend = config.backend ?? 'opfs';
  const entryKey = config.entryKey ?? 'document';
  const namespaceKind = config.namespaceKind ?? 'document';
  const adapter = adapterOverride ?? createStorageAdapter(backendKey);
  scheduleLocalStorageExpirationScanIfNeeded(
    adapter,
    backendKey,
    adapterOverride !== undefined,
  );

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  async function load(): Promise<T | null> {
    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return null;

    if (backendKey === 'localStorage') {
      const syncAdapter = ensureSyncAdapter(adapter, backendKey);
      const key = getStorageKey(sessionKey, config.storeName);
      const entry = await syncAdapter.read<StorageCacheEntry<T>>(key);
      if (!entry) return null;

      if (entry.version !== version) {
        scheduleIdleCleanup(() => void syncAdapter.remove(key));
        return null;
      }

      scheduleIdleCleanup(() => {
        void syncAdapter.write(key, { ...entry, timestamp: Date.now() });
      });
      return entry.data;
    }

    const asyncAdapter = ensureAsyncAdapter(adapter, backendKey);
    const namespace = asyncAdapter.openNamespace<T>({
      sessionKey,
      storeName: config.storeName,
      kind: namespaceKind,
    });
    const entry = await namespace.get(entryKey, { touch: 'coarse' });
    if (!entry) return null;
    if (entry.metadata.version !== version) {
      await namespace.commit({ removes: [entryKey] });
      return null;
    }
    return entry.value;
  }

  async function writeEntry(data: T): Promise<void> {
    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return;

    try {
      if (backendKey === 'localStorage') {
        const syncAdapter = ensureSyncAdapter(adapter, backendKey);
        await syncAdapter.write(getStorageKey(sessionKey, config.storeName), {
          data,
          timestamp: Date.now(),
          version,
        } satisfies StorageCacheEntry<T>);
        return;
      }

      const asyncAdapter = ensureAsyncAdapter(adapter, backendKey);
      const namespace = asyncAdapter.openNamespace<T>({
        sessionKey,
        storeName: config.storeName,
        kind: namespaceKind,
      });
      await namespace.commit({
        upserts: [{ key: entryKey, value: data, version }],
      });
    } catch (error) {
      config.onPersistentStorageError?.(error);
    }
  }

  function clearTimer(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function scheduleSave(getData: () => T): void {
    clearTimer();
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void writeEntry(getData());
    }, DEBOUNCE_MS);
  }

  async function saveNow(data: T): Promise<void> {
    clearTimer();
    await writeEntry(data);
  }

  async function clear(): Promise<void> {
    clearTimer();
    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return;

    if (backendKey === 'localStorage') {
      const syncAdapter = ensureSyncAdapter(adapter, backendKey);
      await syncAdapter.remove(getStorageKey(sessionKey, config.storeName));
      return;
    }

    const asyncAdapter = ensureAsyncAdapter(adapter, backendKey);
    const namespace = asyncAdapter.openNamespace<T>({
      sessionKey,
      storeName: config.storeName,
      kind: namespaceKind,
    });
    await namespace.commit({ removes: [entryKey] });
  }

  function dispose(): void {
    clearTimer();
  }

  return { load, scheduleSave, saveNow, clear, dispose };
}

export function openAsyncStorageNamespace<
  TValue,
  TCustomMetadata extends Record<string, unknown> = Record<string, never>,
>(
  config: Omit<PersistentStorageBaseConfig<never>, 'schema'> & {
    kind: AsyncStorageNamespaceKind;
  },
  { adapter: adapterOverride }: { adapter?: StorageAdapter } = {},
): AsyncStorageNamespaceHandle<TValue, TCustomMetadata> | null {
  const backend = config.backend ?? 'opfs';
  if (backend !== 'opfs') return null;

  const adapter = adapterOverride ?? createStorageAdapter(backend);
  const asyncAdapter = ensureAsyncAdapter(adapter, backend);

  const sessionKey = config.getSessionKey();
  if (sessionKey === false) return null;

  return asyncAdapter.openNamespace<TValue, TCustomMetadata>({
    sessionKey,
    storeName: config.storeName,
    kind: config.kind,
  });
}

export async function readAllAsyncStorageMetadata<
  TCustomMetadata extends Record<string, unknown> = Record<string, never>,
>(
  namespace: AsyncStorageNamespaceHandle<unknown, TCustomMetadata>,
  options: { order?: 'key' | 'lru-asc' | 'lru-desc'; limit?: number } = {},
): Promise<AsyncStorageEntryMetadata<TCustomMetadata>[]> {
  const entries: AsyncStorageEntryMetadata<TCustomMetadata>[] = [];
  let cursor: string | null = null;

  do {
    const page: AsyncStorageMetadataPage<TCustomMetadata> =
      await namespace.listMetadata({
        cursor,
        limit: options.limit,
        order: options.order,
      });
    entries.push(...page.entries);
    cursor = page.cursor;
  } while (cursor !== null);

  return entries;
}

export async function getManyFromAsyncStorageNamespace<
  TValue,
  TCustomMetadata extends Record<string, unknown> = Record<string, never>,
>(
  namespace: AsyncStorageNamespaceHandle<TValue, TCustomMetadata>,
  keys: string[],
  options?: { touch?: 'never' | 'coarse' | 'force' },
): Promise<
  Array<AsyncStorageNamespaceGetResult<TValue, TCustomMetadata> | null>
> {
  return namespace.getMany(keys, options);
}

export function createProtectedStorageRef(
  ref: AsyncStorageProtectedEntryRef,
): string {
  return serializeProtectedRef(ref);
}

export function createProtectedStorageKey(args: {
  backend?: StorageBackend;
  sessionKey: string;
  storeName: string;
  kind: AsyncStorageNamespaceKind;
  key: string;
}): string {
  if ((args.backend ?? 'opfs') === 'localStorage') {
    if (args.kind === 'document' && args.key === 'document') {
      return getStorageKeyForStore(args.sessionKey, args.storeName);
    }

    return `${getStoragePrefixForStoreNamespace(
      args.sessionKey,
      args.storeName,
      args.kind,
    )}${args.key}`;
  }

  return createProtectedStorageRef(args);
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

export function readLocalStorageNamespaceEntries<T>(
  prefix: string,
  version: number,
): Array<{ key: string; entry: StorageCacheEntry<T> }> {
  return filterAndMap(
    listLocalStorageKeysSync(prefix).map((storageKey) => {
      const key = storageKey.slice(prefix.length);
      const entry = readStorageEntryFromLocalStorageSync<T>(
        storageKey,
        version,
      );
      return entry ? { key, entry } : false;
    }),
    (entry) => entry,
  );
}

export async function readProtectedStorageKeys(
  adapter: StorageAdapter,
  sessionKey: string,
): Promise<Set<string>> {
  if (isSyncStorageAdapter(adapter)) {
    const entry = await adapter.read<StorageCacheEntry<{ keys: string[] }>>(
      `tsdf.${sessionKey}.__offline__.protected`,
    );
    return new Set(entry?.data.keys ?? []);
  }

  const namespace = adapter.openNamespace<{ keys: string[] }>({
    sessionKey,
    storeName: '__offline__',
    kind: '__internal.protected',
  });
  const entry = await namespace.get('registry', { touch: 'never' });
  return new Set(entry?.value.keys ?? []);
}

export function readFromLocalStorageSync<T>(
  key: string,
  version: number,
  schema: PersistentStorageSchema<T>,
): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;

    const entry = __LEGIT_CAST__<StorageCacheEntry<unknown>, unknown>(
      JSON.parse(raw),
    );

    if (entry.version !== version) {
      scheduleIdleCleanup(() => localStorage.removeItem(key));
      return null;
    }

    const validated = validateWithSchema(schema, entry.data);
    if (validated !== null) {
      scheduleIdleCleanup(() => refreshLocalStorageTimestamp(key));
    } else {
      scheduleIdleCleanup(() => localStorage.removeItem(key));
    }

    return validated;
  } catch {
    scheduleIdleCleanup(() => localStorage.removeItem(key));
    return null;
  }
}

export function readStorageEntryFromLocalStorageSync<T>(
  key: string,
  version: number,
): StorageCacheEntry<T> | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;

    const entry = __LEGIT_CAST__<StorageCacheEntry<T>, unknown>(
      JSON.parse(raw),
    );
    if (entry.version !== version) {
      scheduleIdleCleanup(() => localStorage.removeItem(key));
      return null;
    }

    return entry;
  } catch {
    scheduleIdleCleanup(() => localStorage.removeItem(key));
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

export function listLocalStorageKeysSync(prefix: string): string[] {
  const keys: string[] = [];

  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) {
      keys.push(key);
    }
  }

  return keys;
}

export async function clearSessionStorage(
  sessionKey: string,
  backend: StorageBackend,
): Promise<void> {
  const adapter = createStorageAdapter(backend);

  if (backend === 'localStorage') {
    const syncAdapter = ensureSyncAdapter(adapter, backend);
    await syncAdapter.removeByPrefix(`tsdf.${sessionKey}.`);
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
    clearSessionStorage(sessionKey, 'localStorage'),
    clearSessionStorage(sessionKey, 'opfs'),
  ]);
}

export function refreshLocalStorageTimestamp(key: string): void {
  const raw = localStorage.getItem(key);
  if (raw === null) return;

  const result = rc_parse_json(raw, cacheEntrySchema);
  if (!result.ok) return;

  localStorage.setItem(
    key,
    JSON.stringify({ ...result.value, timestamp: Date.now() }),
  );
}

async function runLocalStorageExpirationScan(
  adapter: StorageAdapter,
): Promise<void> {
  if (!isSyncStorageAdapter(adapter)) return;

  const prefix = 'tsdf.';
  const keys = await adapter.listKeys(prefix);
  const now = Date.now();
  const protectedKeys = new Set<string>();

  for (const key of keys) {
    if (!key.endsWith('.__offline__.protected')) continue;

    const entry = await adapter.read<StorageCacheEntry<{ keys: string[] }>>(
      key,
    );
    for (const protectedKey of entry?.data.keys ?? []) {
      protectedKeys.add(protectedKey);
    }
  }

  for (const key of keys) {
    if (key.includes('.__offline__.')) continue;
    if (protectedKeys.has(key)) continue;

    const raw = await adapter.read<unknown>(key);
    if (!raw) {
      await adapter.remove(key);
      continue;
    }

    const result = rc_parse(raw, timestampSchema);
    if (!result.ok || now - result.value.timestamp > LOCAL_STORAGE_MAX_AGE_MS) {
      await adapter.remove(key);
    }
  }
}

export function resetExpirationScanTracking(): void {
  scannedSyncBackends.clear();
}
