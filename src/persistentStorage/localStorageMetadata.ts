import {
  rc_array,
  rc_boolean,
  rc_discriminated_union,
  rc_literals,
  rc_null,
  rc_number,
  rc_object,
  rc_parse,
  rc_parse_json,
  rc_string,
  rc_unknown,
  type RcInferType,
  type RcType,
} from 'runcheck';
import { scheduleIdleCleanup } from './scheduleIdleCleanup';

const METADATA_VERSION = 1;

const METADATA_KEY_PREFIX = 'tsdf._m.';
const CATALOG_KEY = `${METADATA_KEY_PREFIX}c`;
const ROOT_KEY_PREFIX = `${METADATA_KEY_PREFIX}r.`;

export const DEFAULT_LOCAL_STORAGE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

let maintenanceScheduled = false;
let maintenanceScheduleVersion = 0;
const maintenanceCallbacks = new Map<string, () => Promise<void>>();

const managedLocalStorageRootSharedShape = {
  version: rc_literals(METADATA_VERSION),
  sessionKey: rc_string,
  storeName: rc_string,
  cleanupIntervalMs: rc_number,
  lastCleanupAt: rc_number.orNull(),
  needsMaintenance: rc_boolean,
  maxAgeMs: rc_number,
  protectedKeys: rc_array(rc_string).withFallback([]).optionalKey(),
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

const managedLocalStorageCatalogRootEntrySchema = rc_object({
  rootKey: rc_string,
  root: managedLocalStorageRootSchema,
});

const managedLocalStorageCatalogSchema = rc_object({
  version: rc_literals(METADATA_VERSION),
  roots: rc_array(managedLocalStorageCatalogRootEntrySchema),
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

const protectedKeysMetaSchema = rc_object({
  keys: rc_array(rc_string).withFallback([]).optionalKey(),
});

function readParsedJson<T>(key: string, schema: RcType<T>): T | null {
  const raw = localStorage.getItem(key);
  return raw === null ? null : rc_parse_json(raw, schema).unwrapOrNull();
}

function writeJson(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

function getManifestKey(rootKey: string): string {
  return `${rootKey}.m`;
}

function normalizeRootIdentityValue(value: string): string {
  return value.startsWith('tsdf.') ? value.slice('tsdf.'.length) : value;
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
    ? `s:${normalizeRootIdentityValue(params.storageKey)}`
    : `n:${normalizeRootIdentityValue(params.storagePrefix)}`;
}

export function getManagedLocalStorageRootKeyForSingle(
  storageKey: string,
): string {
  return `${ROOT_KEY_PREFIX}${getRootIdentity({
    mode: 'single',
    storageKey,
    sessionKey: '',
    storeName: '',
    maxAgeMs: 0,
  })}`;
}

export function getManagedLocalStorageRootKeyForPrefix(
  storagePrefix: string,
): string {
  return `${ROOT_KEY_PREFIX}${getRootIdentity({
    mode: 'namespace',
    storagePrefix,
    sessionKey: '',
    storeName: '',
    maxAgeMs: 0,
  })}`;
}

function getManagedLocalStorageRootKey(params: RootParams): string {
  return `${ROOT_KEY_PREFIX}${getRootIdentity(params)}`;
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
      roots: [],
    }
  );
}

function writeCatalog(catalog: ManagedLocalStorageCatalog): void {
  if (catalog.roots.length === 0) {
    localStorage.removeItem(CATALOG_KEY);
    return;
  }

  writeJson(CATALOG_KEY, catalog);
}

function findCatalogRootIndex(
  catalog: ManagedLocalStorageCatalog,
  rootKey: string,
): number {
  return catalog.roots.findIndex((entry) => entry.rootKey === rootKey);
}

export type ManagedLocalStorageRoot = RcInferType<
  typeof managedLocalStorageRootSchema
>;

function upsertCatalogRoot(
  catalog: ManagedLocalStorageCatalog,
  rootKey: string,
  root: ManagedLocalStorageRoot,
): void {
  const index = findCatalogRootIndex(catalog, rootKey);
  if (index === -1) {
    catalog.roots.push({ rootKey, root });
    return;
  }

  catalog.roots[index] = { rootKey, root };
}

function removeRootKeyFromCatalog(rootKey: string): void {
  const catalog = readCatalog();
  const nextRoots = catalog.roots.filter((entry) => entry.rootKey !== rootKey);
  if (nextRoots.length === catalog.roots.length) return;

  writeCatalog({ version: METADATA_VERSION, roots: nextRoots });
}

export function readManagedLocalStorageRoot(
  rootKey: string,
): ManagedLocalStorageRoot | null {
  return (
    readCatalog().roots.find((entry) => entry.rootKey === rootKey)?.root ?? null
  );
}

function writeRoot(rootKey: string, root: ManagedLocalStorageRoot): void {
  const catalog = readCatalog();
  upsertCatalogRoot(catalog, rootKey, root);
  writeCatalog(catalog);
}

type ManagedLocalStorageCatalogRootEntry = {
  root: ManagedLocalStorageRoot;
  rootKey: string;
};

function readCatalogRoots(): ManagedLocalStorageCatalogRootEntry[] {
  return readCatalog().roots;
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
  const catalog = readCatalog();
  const cleanupIntervalMs = normalizeCleanupIntervalMs(
    params.cleanupIntervalMs,
  );
  const current = catalog.roots.find(
    (entry) => entry.rootKey === rootKey,
  )?.root;

  const rootBase: ManagedLocalStorageRootBase = {
    version: METADATA_VERSION,
    sessionKey: params.sessionKey,
    storeName: params.storeName,
    cleanupIntervalMs,
    lastCleanupAt: current?.lastCleanupAt ?? null,
    needsMaintenance: current?.needsMaintenance ?? false,
    maxAgeMs: params.maxAgeMs,
    protectedKeys: current?.protectedKeys,
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

  upsertCatalogRoot(catalog, rootKey, root);
  writeCatalog(catalog);

  return { rootKey, root };
}

type ManagedLocalStorageManifest = RcInferType<
  typeof managedLocalStorageManifestShardSchema
>;

function readManifest(rootKey: string): ManagedLocalStorageManifest {
  return (
    readParsedJson(
      getManifestKey(rootKey),
      managedLocalStorageManifestShardSchema,
    ) ?? { version: METADATA_VERSION, entries: [] }
  );
}

function writeManifest(
  rootKey: string,
  manifest: ManagedLocalStorageManifest,
): void {
  if (manifest.entries.length === 0) {
    localStorage.removeItem(getManifestKey(rootKey));
    return;
  }

  writeJson(getManifestKey(rootKey), manifest);
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
  return (
    readManifest(rootKey).entries.find(
      (entry) => entry.entryKey === entryKey,
    ) ?? null
  );
}

function upsertManifestEntry(
  rootKey: string,
  entry: ManagedLocalStorageManifestEntry,
): void {
  const manifest = readManifest(rootKey);
  const existingIndex = manifest.entries.findIndex(
    (candidate) => candidate.entryKey === entry.entryKey,
  );

  if (existingIndex === -1) {
    manifest.entries.push(entry);
  } else {
    manifest.entries[existingIndex] = entry;
  }

  writeManifest(rootKey, manifest);
}

function removeManifestEntry(rootKey: string, entryKey: string): void {
  const manifest = readManifest(rootKey);
  const nextEntries = manifest.entries.filter(
    (entry) => entry.entryKey !== entryKey,
  );

  if (nextEntries.length === manifest.entries.length) return;

  writeManifest(rootKey, { version: METADATA_VERSION, entries: nextEntries });
}

function listManifestEntries(
  rootKey: string,
  _root_: ManagedLocalStorageRoot,
): ManagedLocalStorageManifestEntry[] {
  return readManifest(rootKey).entries;
}

type PayloadLocation = {
  rootKey: string;
  root: ManagedLocalStorageRoot;
  entryKey: string;
} | null;

function findPayloadLocation(payloadKey: string): PayloadLocation {
  const catalogRoots = readCatalogRoots();
  const exactRootKey = getManagedLocalStorageRootKeyForSingle(payloadKey);
  const exactRoot =
    catalogRoots.find((entry) => entry.rootKey === exactRootKey)?.root ?? null;
  if (exactRoot?.mode === 'single' && exactRoot.storageKey === payloadKey) {
    return { rootKey: exactRootKey, root: exactRoot, entryKey: '' };
  }

  for (const { rootKey, root } of catalogRoots) {
    if (root.mode !== 'namespace') continue;

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
  const { rootKey, root } = ensureRoot({
    sessionKey: params.sessionKey,
    storeName: params.storeName,
    mode: 'single',
    storageKey: params.storageKey,
    cleanupIntervalMs: params.cleanupIntervalMs,
    maxAgeMs: params.maxAgeMs,
  });

  if (params.storeName === '__offline__.protected') {
    root.protectedKeys = rc_parse(
      params.meta ?? {},
      protectedKeysMetaSchema,
    ).unwrapOr({ keys: [] }).keys;
    writeRoot(rootKey, root);
  }

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

  localStorage.removeItem(getManifestKey(rootKey));

  removeRootKeyFromCatalog(rootKey);
  maintenanceCallbacks.delete(rootKey);
}

export function clearManagedLocalStorageSession(sessionKey: string): void {
  for (const { rootKey, root } of readCatalogRoots()) {
    if (root.sessionKey !== sessionKey) continue;

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

function readProtectedKeysBySession(
  catalogRoots: ManagedLocalStorageCatalogRootEntry[] = readCatalogRoots(),
): Map<string, Set<string>> {
  const protectedKeysBySession = new Map<string, Set<string>>();

  for (const { root } of catalogRoots) {
    if (root.mode !== 'single' || root.storeName !== '__offline__.protected') {
      continue;
    }

    protectedKeysBySession.set(
      root.sessionKey,
      new Set(root.protectedKeys ?? []),
    );
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
  if (offlineRoot) return;

  const manifest = readManifest(rootKey);
  const nextEntries: ManagedLocalStorageManifestEntry[] = [];

  for (const entry of manifest.entries) {
    if (
      protectedKeys.has(entry.payloadKey) ||
      now - entry.lastAccessAt <= root.maxAgeMs
    ) {
      nextEntries.push(entry);
      continue;
    }

    localStorage.removeItem(entry.payloadKey);
  }

  if (nextEntries.length === manifest.entries.length) return;

  writeManifest(rootKey, { version: METADATA_VERSION, entries: nextEntries });
}

export function scheduleManagedLocalStorageMaintenance(): void {
  if (maintenanceScheduled) return;

  maintenanceScheduled = true;
  const scheduledVersion = ++maintenanceScheduleVersion;
  scheduleIdleCleanup(() => {
    if (scheduledVersion !== maintenanceScheduleVersion) return;

    maintenanceScheduled = false;
    void runManagedLocalStorageMaintenance();
  });
}

export async function runManagedLocalStorageMaintenance(): Promise<void> {
  maintenanceScheduled = false;
  maintenanceScheduleVersion++;

  const catalog = readCatalog();
  const catalogRoots = catalog.roots;
  const protectedKeysBySession = readProtectedKeysBySession(catalogRoots);
  const invokedCallbacks = new Set<() => Promise<void>>();
  let catalogChanged = false;

  for (const { rootKey, root } of catalogRoots) {
    if (!isMaintenanceDue(root)) continue;

    runGenericCleanupForRoot(
      rootKey,
      root,
      protectedKeysBySession.get(root.sessionKey) ?? new Set<string>(),
    );

    const callback = maintenanceCallbacks.get(rootKey);
    if (callback) {
      if (!invokedCallbacks.has(callback)) {
        invokedCallbacks.add(callback);
        await callback();
      }

      const latestRoot =
        catalog.roots.find((entry) => entry.rootKey === rootKey)?.root ?? root;
      latestRoot.lastCleanupAt = Date.now();
      latestRoot.needsMaintenance = false;
      upsertCatalogRoot(catalog, rootKey, latestRoot);
      catalogChanged = true;
      continue;
    }

    root.lastCleanupAt = Date.now();
    root.needsMaintenance = false;
    catalogChanged = true;
  }

  if (catalogChanged) {
    writeCatalog(catalog);
  }
}

export function readManagedLocalStorageProtectedKeys(
  sessionKey: string,
): Set<string> {
  return readProtectedKeysBySession().get(sessionKey) ?? new Set<string>();
}

export function resetManagedLocalStorageState(): void {
  maintenanceScheduled = false;
  maintenanceScheduleVersion = 0;
  maintenanceCallbacks.clear();
}
