import { murmur3 } from '@ls-stack/utils/hash';
import {
  rc_array,
  rc_boolean,
  rc_discriminated_union,
  rc_literals,
  rc_null,
  rc_number,
  rc_object,
  rc_parse_json,
  rc_string,
  rc_unknown,
  type RcInferType,
  type RcType,
} from 'runcheck';
import { scheduleIdleCleanup } from './scheduleIdleCleanup';

const METADATA_VERSION = 1;
const MANIFEST_SHARD_COUNT = 8;
const LEASE_TTL_MS = 10_000;

const METADATA_KEY_PREFIX = 'tsdf.__lsm__.';
const CATALOG_KEY = `${METADATA_KEY_PREFIX}c`;
const LEASE_KEY = `${METADATA_KEY_PREFIX}l`;
const ROOT_KEY_PREFIX = `${METADATA_KEY_PREFIX}r.`;

export const DEFAULT_LOCAL_STORAGE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const runtimeOwnerId = `runtime-${Math.random().toString(36).slice(2)}`;

let maintenanceScheduled = false;
const maintenanceCallbacks = new Map<string, () => Promise<void>>();

const managedLocalStorageCatalogSchema = rc_object({
  version: rc_literals(METADATA_VERSION),
  rootKeys: rc_array(rc_string),
});

const managedLocalStorageRootSharedShape = {
  version: rc_literals(METADATA_VERSION),
  sessionKey: rc_string,
  storeName: rc_string,
  cleanupIntervalMs: rc_number,
  lastCleanupAt: rc_number.orNull(),
  needsMaintenance: rc_boolean,
  maxAgeMs: rc_number,
  shardCount: rc_number,
};

const managedLocalStorageRootSchema = rc_discriminated_union('mode', {
  single: {
    ...managedLocalStorageRootSharedShape,
    storageKey: rc_string,
    storagePrefix: rc_null,
  },
  namespace: {
    ...managedLocalStorageRootSharedShape,
    storageKey: rc_null,
    storagePrefix: rc_string,
  },
});

const managedLocalStorageManifestEntrySchema = rc_object({
  entryKey: rc_string,
  payloadKey: rc_string,
  lastAccessAt: rc_number,
  meta: rc_unknown.optionalKey(),
});

const managedLocalStorageManifestShardSchema = rc_object({
  version: rc_literals(METADATA_VERSION),
  entries: rc_array(managedLocalStorageManifestEntrySchema),
});

const protectedKeysStorageSchema = rc_object({
  data: rc_object({ keys: rc_array(rc_string) }),
});

const cacheEntryTimestampSchema = rc_object({
  data: rc_unknown,
  timestamp: rc_number,
  version: rc_unknown,
});

const managedLocalStorageLeaseSchema = rc_object({
  ownerId: rc_string,
  expiresAt: rc_number,
});

function readParsedJson<T>(key: string, schema: RcType<T>): T | null {
  const raw = localStorage.getItem(key);
  return raw === null ? null : rc_parse_json(raw, schema).unwrapOrNull();
}

function writeJson(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

function getManifestShardKey(rootKey: string, shardIndex: number): string {
  return `${rootKey}.manifest.${shardIndex}`;
}

function getManifestShardIndex(entryKey: string): number {
  return murmur3(entryKey, 'uint32') % MANIFEST_SHARD_COUNT;
}

type RootParams = {
  sessionKey: string;
  storeName: string;
  cleanupIntervalMs?: number;
  maxAgeMs: number;
} & (
  | { mode: 'single'; storageKey: string; storagePrefix?: never }
  | { mode: 'namespace'; storagePrefix: string; storageKey?: never }
);

function getRootIdentity(params: RootParams): string {
  return params.mode === 'single'
    ? `single:${params.storageKey}`
    : `namespace:${params.storagePrefix}`;
}

export function getManagedLocalStorageRootKeyForSingle(
  storageKey: string,
): string {
  return `${ROOT_KEY_PREFIX}${encodeURIComponent(`single:${storageKey}`)}`;
}

export function getManagedLocalStorageRootKeyForPrefix(
  storagePrefix: string,
): string {
  return `${ROOT_KEY_PREFIX}${encodeURIComponent(`namespace:${storagePrefix}`)}`;
}

function getManagedLocalStorageRootKey(params: RootParams): string {
  return `${ROOT_KEY_PREFIX}${encodeURIComponent(getRootIdentity(params))}`;
}

export function normalizeCleanupIntervalMs(
  cleanupIntervalMs: number | undefined,
): number {
  if (
    typeof cleanupIntervalMs !== 'number' ||
    !Number.isFinite(cleanupIntervalMs) ||
    cleanupIntervalMs < 0
  ) {
    return DEFAULT_LOCAL_STORAGE_CLEANUP_INTERVAL_MS;
  }

  return cleanupIntervalMs;
}

type ManagedLocalStorageCatalog = RcInferType<
  typeof managedLocalStorageCatalogSchema
>;

function readCatalog(): ManagedLocalStorageCatalog {
  return (
    readParsedJson(CATALOG_KEY, managedLocalStorageCatalogSchema) ?? {
      version: METADATA_VERSION,
      rootKeys: [],
    }
  );
}

function writeCatalog(catalog: ManagedLocalStorageCatalog): void {
  if (catalog.rootKeys.length === 0) {
    localStorage.removeItem(CATALOG_KEY);
    return;
  }

  writeJson(CATALOG_KEY, catalog);
}

function addRootKeyToCatalog(rootKey: string): void {
  const catalog = readCatalog();
  if (catalog.rootKeys.includes(rootKey)) return;

  catalog.rootKeys.push(rootKey);
  writeCatalog(catalog);
}

function removeRootKeyFromCatalog(rootKey: string): void {
  const catalog = readCatalog();
  const nextKeys = catalog.rootKeys.filter((key) => key !== rootKey);
  if (nextKeys.length === catalog.rootKeys.length) return;

  writeCatalog({ version: METADATA_VERSION, rootKeys: nextKeys });
}

export type ManagedLocalStorageRoot = RcInferType<
  typeof managedLocalStorageRootSchema
>;

export function readManagedLocalStorageRoot(
  rootKey: string,
): ManagedLocalStorageRoot | null {
  return readParsedJson(rootKey, managedLocalStorageRootSchema);
}

function writeRoot(rootKey: string, root: ManagedLocalStorageRoot): void {
  writeJson(rootKey, root);
}

type ManagedLocalStorageRootBase = Omit<
  ManagedLocalStorageRoot,
  'mode' | 'storageKey' | 'storagePrefix'
>;

function ensureRoot(params: RootParams): {
  rootKey: string;
  root: ManagedLocalStorageRoot;
} {
  const rootKey = getManagedLocalStorageRootKey(params);
  const cleanupIntervalMs = normalizeCleanupIntervalMs(
    params.cleanupIntervalMs,
  );
  const current = readManagedLocalStorageRoot(rootKey);

  const rootBase: ManagedLocalStorageRootBase = {
    version: METADATA_VERSION,
    sessionKey: params.sessionKey,
    storeName: params.storeName,
    cleanupIntervalMs,
    lastCleanupAt: current?.lastCleanupAt ?? null,
    needsMaintenance: current?.needsMaintenance ?? false,
    maxAgeMs: params.maxAgeMs,
    shardCount: MANIFEST_SHARD_COUNT,
  };

  const root: ManagedLocalStorageRoot =
    params.mode === 'single'
      ? {
          ...rootBase,
          mode: 'single',
          storageKey: params.storageKey,
          storagePrefix: null,
        }
      : {
          ...rootBase,
          mode: 'namespace',
          storageKey: null,
          storagePrefix: params.storagePrefix,
        };

  writeRoot(rootKey, root);
  addRootKeyToCatalog(rootKey);

  return { rootKey, root };
}

type ManagedLocalStorageManifestShard = RcInferType<
  typeof managedLocalStorageManifestShardSchema
>;

function readManifestShard(
  rootKey: string,
  shardIndex: number,
): ManagedLocalStorageManifestShard {
  return (
    readParsedJson(
      getManifestShardKey(rootKey, shardIndex),
      managedLocalStorageManifestShardSchema,
    ) ?? { version: METADATA_VERSION, entries: [] }
  );
}

function writeManifestShard(
  rootKey: string,
  shardIndex: number,
  shard: ManagedLocalStorageManifestShard,
): void {
  const shardKey = getManifestShardKey(rootKey, shardIndex);
  if (shard.entries.length === 0) {
    localStorage.removeItem(shardKey);
    return;
  }

  writeJson(shardKey, shard);
}

export type ManagedLocalStorageManifestEntry<TMeta = unknown> = {
  entryKey: string;
  payloadKey: string;
  lastAccessAt: number;
  meta?: TMeta;
};

function readManifestEntry(
  rootKey: string,
  entryKey: string,
): ManagedLocalStorageManifestEntry | null {
  const shardIndex = getManifestShardIndex(entryKey);
  const shard = readManifestShard(rootKey, shardIndex);

  return shard.entries.find((entry) => entry.entryKey === entryKey) ?? null;
}

function upsertManifestEntry(
  rootKey: string,
  entry: ManagedLocalStorageManifestEntry,
): void {
  const shardIndex = getManifestShardIndex(entry.entryKey);
  const shard = readManifestShard(rootKey, shardIndex);
  const existingIndex = shard.entries.findIndex(
    (candidate) => candidate.entryKey === entry.entryKey,
  );

  if (existingIndex === -1) {
    shard.entries.push(entry);
  } else {
    shard.entries[existingIndex] = entry;
  }

  writeManifestShard(rootKey, shardIndex, shard);
}

function removeManifestEntry(rootKey: string, entryKey: string): void {
  const shardIndex = getManifestShardIndex(entryKey);
  const shard = readManifestShard(rootKey, shardIndex);
  const nextEntries = shard.entries.filter(
    (entry) => entry.entryKey !== entryKey,
  );

  if (nextEntries.length === shard.entries.length) return;

  writeManifestShard(rootKey, shardIndex, {
    version: METADATA_VERSION,
    entries: nextEntries,
  });
}

function listManifestEntries(
  rootKey: string,
  root: ManagedLocalStorageRoot,
): ManagedLocalStorageManifestEntry[] {
  const entries: ManagedLocalStorageManifestEntry[] = [];

  for (let shardIndex = 0; shardIndex < root.shardCount; shardIndex++) {
    entries.push(...readManifestShard(rootKey, shardIndex).entries);
  }

  return entries;
}

type PayloadLocation = {
  rootKey: string;
  root: ManagedLocalStorageRoot;
  entryKey: string;
} | null;

function findPayloadLocation(payloadKey: string): PayloadLocation {
  const exactRootKey = getManagedLocalStorageRootKeyForSingle(payloadKey);
  const exactRoot = readManagedLocalStorageRoot(exactRootKey);
  if (exactRoot?.mode === 'single' && exactRoot.storageKey === payloadKey) {
    return { rootKey: exactRootKey, root: exactRoot, entryKey: '' };
  }

  for (const rootKey of readCatalog().rootKeys) {
    const root = readManagedLocalStorageRoot(rootKey);
    if (!root || root.mode !== 'namespace') {
      continue;
    }

    if (!payloadKey.startsWith(root.storagePrefix)) continue;

    return {
      rootKey,
      root,
      entryKey: payloadKey.slice(root.storagePrefix.length),
    };
  }

  return null;
}

export function listManagedLocalStorageKeysSync(
  prefix: string,
): string[] | null {
  const rootKey = getManagedLocalStorageRootKeyForPrefix(prefix);
  const root = readManagedLocalStorageRoot(rootKey);
  if (!root || root.mode !== 'namespace') return null;

  return listManifestEntries(rootKey, root).map((entry) => entry.payloadKey);
}

export function readManagedLocalStorageManifestEntriesByPrefix(
  prefix: string,
): ManagedLocalStorageManifestEntry[] {
  const rootKey = getManagedLocalStorageRootKeyForPrefix(prefix);
  const root = readManagedLocalStorageRoot(rootKey);
  if (!root || root.mode !== 'namespace') return [];

  return listManifestEntries(rootKey, root);
}

export function readManagedLocalStorageEntryByPayload(
  payloadKey: string,
): ManagedLocalStorageManifestEntry | null {
  const location = findPayloadLocation(payloadKey);
  if (!location) return null;

  return readManifestEntry(location.rootKey, location.entryKey);
}

export function registerManagedLocalStorageRoot(params: RootParams): string {
  const { rootKey, root } = ensureRoot(params);
  if (isMaintenanceDue(root)) {
    scheduleManagedLocalStorageMaintenance();
  }

  return rootKey;
}

type UpsertSingleEntryParams = {
  sessionKey: string;
  storeName: string;
  storageKey: string;
  maxAgeMs: number;
  cleanupIntervalMs?: number;
  lastAccessAt?: number;
  meta?: unknown;
};

export function upsertManagedLocalStorageSingleEntry(
  params: UpsertSingleEntryParams,
): string {
  const { rootKey } = ensureRoot({
    sessionKey: params.sessionKey,
    storeName: params.storeName,
    mode: 'single',
    storageKey: params.storageKey,
    cleanupIntervalMs: params.cleanupIntervalMs,
    maxAgeMs: params.maxAgeMs,
  });

  upsertManifestEntry(rootKey, {
    entryKey: '',
    payloadKey: params.storageKey,
    lastAccessAt: params.lastAccessAt ?? Date.now(),
    meta: params.meta,
  });

  return rootKey;
}

type UpsertNamespaceEntryParams = {
  sessionKey: string;
  storeName: string;
  storagePrefix: string;
  entryKey: string;
  payloadKey: string;
  maxAgeMs: number;
  cleanupIntervalMs?: number;
  lastAccessAt?: number;
  meta?: unknown;
};

export function upsertManagedLocalStorageNamespaceEntry(
  params: UpsertNamespaceEntryParams,
): string {
  const { rootKey } = ensureRoot({
    sessionKey: params.sessionKey,
    storeName: params.storeName,
    mode: 'namespace',
    storagePrefix: params.storagePrefix,
    cleanupIntervalMs: params.cleanupIntervalMs,
    maxAgeMs: params.maxAgeMs,
  });

  upsertManifestEntry(rootKey, {
    entryKey: params.entryKey,
    payloadKey: params.payloadKey,
    lastAccessAt: params.lastAccessAt ?? Date.now(),
    meta: params.meta,
  });

  return rootKey;
}

export function touchManagedLocalStoragePayload(payloadKey: string): boolean {
  const location = findPayloadLocation(payloadKey);
  if (!location) return false;

  const current = readManifestEntry(location.rootKey, location.entryKey);
  if (!current) return false;

  upsertManifestEntry(location.rootKey, {
    ...current,
    lastAccessAt: Date.now(),
  });

  return true;
}

export function removeManagedLocalStoragePayload(payloadKey: string): boolean {
  const location = findPayloadLocation(payloadKey);
  if (!location) return false;

  removeManifestEntry(location.rootKey, location.entryKey);
  return true;
}

export function clearManagedLocalStorageRoot(rootKey: string): void {
  const root = readManagedLocalStorageRoot(rootKey);
  if (!root) {
    removeRootKeyFromCatalog(rootKey);
    return;
  }

  for (const entry of listManifestEntries(rootKey, root)) {
    localStorage.removeItem(entry.payloadKey);
  }

  for (let shardIndex = 0; shardIndex < root.shardCount; shardIndex++) {
    localStorage.removeItem(getManifestShardKey(rootKey, shardIndex));
  }

  localStorage.removeItem(rootKey);
  removeRootKeyFromCatalog(rootKey);
  maintenanceCallbacks.delete(rootKey);
}

export function clearManagedLocalStorageSession(sessionKey: string): void {
  for (const rootKey of readCatalog().rootKeys) {
    const root = readManagedLocalStorageRoot(rootKey);
    if (!root || root.sessionKey !== sessionKey) continue;

    clearManagedLocalStorageRoot(rootKey);
  }
}

export function setManagedLocalStorageRootNeedsMaintenance(
  rootKey: string,
  needsMaintenance: boolean,
): void {
  const root = readManagedLocalStorageRoot(rootKey);
  if (!root) return;

  root.needsMaintenance = needsMaintenance;
  writeRoot(rootKey, root);

  if (needsMaintenance) {
    scheduleManagedLocalStorageMaintenance();
  }
}

export function registerManagedLocalStorageMaintenanceCallback(
  rootKey: string,
  callback: () => Promise<void>,
): void {
  maintenanceCallbacks.set(rootKey, callback);
}

export function unregisterManagedLocalStorageMaintenanceCallback(
  rootKey: string,
): void {
  maintenanceCallbacks.delete(rootKey);
}

function isMaintenanceDue(root: ManagedLocalStorageRoot): boolean {
  if (root.needsMaintenance) return true;
  if (root.lastCleanupAt === null) return true;
  return Date.now() - root.lastCleanupAt >= root.cleanupIntervalMs;
}

function readProtectedKeysBySession(): Map<string, Set<string>> {
  const protectedKeysBySession = new Map<string, Set<string>>();

  for (const rootKey of readCatalog().rootKeys) {
    const root = readManagedLocalStorageRoot(rootKey);
    if (
      !root ||
      root.mode !== 'single' ||
      root.storeName !== '__offline__.protected'
    ) {
      continue;
    }

    const raw = readParsedJson(root.storageKey, protectedKeysStorageSchema);
    if (!raw) continue;

    protectedKeysBySession.set(root.sessionKey, new Set(raw.data.keys));
  }

  return protectedKeysBySession;
}

function isOfflineRoot(root: ManagedLocalStorageRoot): boolean {
  return (
    root.storeName.startsWith('__offline__.') ||
    root.storageKey?.includes('.__offline__.') === true ||
    root.storagePrefix?.includes('.__offline__.') === true
  );
}

function runGenericCleanupForRoot(
  rootKey: string,
  root: ManagedLocalStorageRoot,
  protectedKeys: Set<string>,
): void {
  const now = Date.now();
  const offlineRoot = isOfflineRoot(root);

  for (const entry of listManifestEntries(rootKey, root)) {
    const raw = localStorage.getItem(entry.payloadKey);
    if (raw === null) {
      removeManifestEntry(rootKey, entry.entryKey);
      continue;
    }

    const cacheEntry = rc_parse_json(
      raw,
      cacheEntryTimestampSchema,
    ).unwrapOrNull();
    if (cacheEntry === null) {
      localStorage.removeItem(entry.payloadKey);
      removeManifestEntry(rootKey, entry.entryKey);
      continue;
    }

    if (offlineRoot || protectedKeys.has(entry.payloadKey)) continue;

    if (now - entry.lastAccessAt > root.maxAgeMs) {
      localStorage.removeItem(entry.payloadKey);
      removeManifestEntry(rootKey, entry.entryKey);
    }
  }
}

type ManagedLocalStorageLease = RcInferType<
  typeof managedLocalStorageLeaseSchema
>;

function readLease(): ManagedLocalStorageLease | null {
  return readParsedJson(LEASE_KEY, managedLocalStorageLeaseSchema);
}

function acquireMaintenanceLease(): boolean {
  const currentLease = readLease();
  if (
    currentLease &&
    currentLease.ownerId !== runtimeOwnerId &&
    currentLease.expiresAt > Date.now()
  ) {
    return false;
  }

  writeJson(LEASE_KEY, {
    ownerId: runtimeOwnerId,
    expiresAt: Date.now() + LEASE_TTL_MS,
  });

  return readLease()?.ownerId === runtimeOwnerId;
}

function releaseMaintenanceLease(): void {
  if (readLease()?.ownerId === runtimeOwnerId) {
    localStorage.removeItem(LEASE_KEY);
  }
}

export function scheduleManagedLocalStorageMaintenance(): void {
  if (maintenanceScheduled) return;

  maintenanceScheduled = true;
  scheduleIdleCleanup(() => {
    maintenanceScheduled = false;
    void runManagedLocalStorageMaintenance();
  });
}

export async function runManagedLocalStorageMaintenance(): Promise<void> {
  if (!acquireMaintenanceLease()) return;

  try {
    const protectedKeysBySession = readProtectedKeysBySession();

    for (const rootKey of readCatalog().rootKeys) {
      const root = readManagedLocalStorageRoot(rootKey);
      if (!root || !isMaintenanceDue(root)) continue;

      runGenericCleanupForRoot(
        rootKey,
        root,
        protectedKeysBySession.get(root.sessionKey) ?? new Set<string>(),
      );

      const callback = maintenanceCallbacks.get(rootKey);
      if (callback) {
        await callback();
      }

      const latestRoot = readManagedLocalStorageRoot(rootKey);
      if (!latestRoot) continue;

      latestRoot.lastCleanupAt = Date.now();
      latestRoot.needsMaintenance = false;
      writeRoot(rootKey, latestRoot);
    }
  } finally {
    releaseMaintenanceLease();
  }
}

export function resetManagedLocalStorageState(): void {
  maintenanceScheduled = false;
  maintenanceCallbacks.clear();
}
