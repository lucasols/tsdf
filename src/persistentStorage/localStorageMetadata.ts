import { isObject } from '@ls-stack/utils/typeGuards';
import {
  rc_array,
  rc_number,
  rc_object,
  rc_parse,
  rc_parse_json,
  rc_unknown,
  type RcType,
} from 'runcheck';
import {
  type CompactListQueryLocalStorageEntry,
  createCompactListQueryLocalStorageEntry,
  isCompactListQueryLocalStorageKey,
  parseCompactListQueryLocalStorageEntry,
} from './compactListQueryLocalStorageEntry';

import { ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY } from './asyncStorageAdapter';

const METADATA_KEY_PREFIX = 'tsdf._m.';
const GLOBAL_MAINTENANCE_KEY = `${METADATA_KEY_PREFIX}g`;
const MANIFEST_KEY_PREFIX = `${METADATA_KEY_PREFIX}r.`;
const MANIFEST_KEY_SUFFIX = '.m';
const SINGLE_MANIFEST_KEY_PREFIX = `${MANIFEST_KEY_PREFIX}s:`;
const NAMESPACE_MANIFEST_KEY_PREFIX = `${MANIFEST_KEY_PREFIX}n:`;

export const DEFAULT_LOCAL_STORAGE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_LOCAL_STORAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const maintenanceCallbacks = new Map<string, () => Promise<void>>();

type ManagedLocalStorageRuntimeConfig = {
  cleanupIntervalMs: number;
  maxAgeMs: number;
};

const defaultManagedLocalStorageRuntimeConfig: ManagedLocalStorageRuntimeConfig =
  {
    cleanupIntervalMs: DEFAULT_LOCAL_STORAGE_CLEANUP_INTERVAL_MS,
    maxAgeMs: DEFAULT_LOCAL_STORAGE_MAX_AGE_MS,
  };

let managedLocalStorageRuntimeConfig = {
  ...defaultManagedLocalStorageRuntimeConfig,
};

export type ManagedLocalStorageIo = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  listKeys(): string[];
  queueManifestWrite?(key: string, value: string | null): void;
};

export const directManagedLocalStorageIo: ManagedLocalStorageIo = {
  getItem(key) {
    return localStorage.getItem(key);
  },
  setItem(key, value) {
    localStorage.setItem(key, value);
  },
  removeItem(key) {
    localStorage.removeItem(key);
  },
  listKeys() {
    const keys: string[] = [];

    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key !== null) {
        keys.push(key);
      }
    }

    return keys;
  },
};

export function getManagedLocalStorageRuntimeConfig(): ManagedLocalStorageRuntimeConfig {
  return managedLocalStorageRuntimeConfig;
}

export function setManagedLocalStorageRuntimeConfigForTests(
  nextConfig: Partial<ManagedLocalStorageRuntimeConfig>,
): void {
  managedLocalStorageRuntimeConfig = {
    ...managedLocalStorageRuntimeConfig,
    ...nextConfig,
  };
}

const managedLocalStorageManifestSchema = rc_object({
  e: rc_array(rc_unknown),
});

const managedLocalStorageGlobalMaintenanceSchema = rc_object({
  lca: rc_number.orNull(),
});

function readCompactListQueryEntry(
  payloadKey: string,
  io: ManagedLocalStorageIo,
) {
  return parseCompactListQueryLocalStorageEntry(io.getItem(payloadKey));
}

function writeCompactListQueryOfflineProtection(
  payloadKey: string,
  entry: CompactListQueryLocalStorageEntry,
  offlineProtected: boolean,
  io: ManagedLocalStorageIo,
): void {
  writeMetadataJson(
    payloadKey,
    createCompactListQueryLocalStorageEntry({ ...entry, offlineProtected }),
    io,
  );
}

function readParsedMetadataJson<T>(
  key: string,
  schema: RcType<T>,
  io: ManagedLocalStorageIo,
): T | null {
  const raw = io.getItem(key);
  if (raw === null) return null;

  const parsedRaw = rc_parse_json(raw, rc_unknown).unwrapOrNull();
  if (parsedRaw === null) return null;

  return rc_parse(parsedRaw, schema).unwrapOrNull();
}

function writeMetadataJson(
  key: string,
  value: unknown,
  io: ManagedLocalStorageIo,
): void {
  io.setItem(key, JSON.stringify(value));
}

function removeMetadataJson(key: string, io: ManagedLocalStorageIo): void {
  io.removeItem(key);
}

function writeManifestJson(
  manifestKey: string,
  value: unknown,
  io: ManagedLocalStorageIo,
): void {
  const rawValue = JSON.stringify(value);

  if (io.queueManifestWrite) {
    io.queueManifestWrite(manifestKey, rawValue);
    return;
  }

  io.setItem(manifestKey, rawValue);
}

function removeManifestJson(
  manifestKey: string,
  io: ManagedLocalStorageIo,
): void {
  if (io.queueManifestWrite) {
    io.queueManifestWrite(manifestKey, null);
    return;
  }

  io.removeItem(manifestKey);
}

function normalizeRootIdentityValue(value: string): string {
  return value.startsWith('tsdf.') ? value.slice('tsdf.'.length) : value;
}

const COMPRESSED_NAMESPACE_ROOT_SUFFIXES = [
  ['.ci.', '.ci'],
  ['.li.', '.li'],
  ['.lq.', '.lq'],
  ['.oq.', '.oq'],
  ['.oc.', '.oc'],
  ['.oe.', '.oe'],
] as const;

function compactNamespaceRootIdentityValue(storagePrefix: string): string {
  const normalized = normalizeRootIdentityValue(storagePrefix);

  for (const [suffix, compactSuffix] of COMPRESSED_NAMESPACE_ROOT_SUFFIXES) {
    if (normalized.endsWith(suffix)) {
      return `${normalized.slice(0, -suffix.length)}${compactSuffix}`;
    }
  }

  return normalized.endsWith('.') ? normalized.slice(0, -1) : normalized;
}

function expandNamespaceRootIdentityValue(compactIdentity: string): string {
  for (const [suffix, compactSuffix] of COMPRESSED_NAMESPACE_ROOT_SUFFIXES) {
    if (compactIdentity.endsWith(compactSuffix)) {
      return `tsdf.${compactIdentity.slice(0, -compactSuffix.length)}${suffix}`;
    }
  }

  return `tsdf.${compactIdentity}.`;
}

export function getManagedLocalStorageManifestKeyForSingle(
  storageKey: string,
): string {
  return `${SINGLE_MANIFEST_KEY_PREFIX}${normalizeRootIdentityValue(storageKey)}${MANIFEST_KEY_SUFFIX}`;
}

export function getManagedLocalStorageManifestKeyForPrefix(
  storagePrefix: string,
): string {
  return `${NAMESPACE_MANIFEST_KEY_PREFIX}${compactNamespaceRootIdentityValue(storagePrefix)}${MANIFEST_KEY_SUFFIX}`;
}

type ManagedLocalStorageManifestLocation =
  | { kind: 'single'; manifestKey: string; payloadKey: string }
  | { kind: 'namespace'; manifestKey: string; storagePrefix: string };

function parseManagedLocalStorageManifestKey(
  manifestKey: string,
): ManagedLocalStorageManifestLocation | null {
  if (
    manifestKey.startsWith(SINGLE_MANIFEST_KEY_PREFIX) &&
    manifestKey.endsWith(MANIFEST_KEY_SUFFIX)
  ) {
    const identity = manifestKey.slice(
      SINGLE_MANIFEST_KEY_PREFIX.length,
      -MANIFEST_KEY_SUFFIX.length,
    );

    return { kind: 'single', manifestKey, payloadKey: `tsdf.${identity}` };
  }

  if (
    manifestKey.startsWith(NAMESPACE_MANIFEST_KEY_PREFIX) &&
    manifestKey.endsWith(MANIFEST_KEY_SUFFIX)
  ) {
    const identity = manifestKey.slice(
      NAMESPACE_MANIFEST_KEY_PREFIX.length,
      -MANIFEST_KEY_SUFFIX.length,
    );

    return {
      kind: 'namespace',
      manifestKey,
      storagePrefix: expandNamespaceRootIdentityValue(identity),
    };
  }

  return null;
}

function isManagedLocalStorageManifestKey(key: string): boolean {
  return parseManagedLocalStorageManifestKey(key) !== null;
}

type TsdfLocalStorageKeyClassification =
  | { kind: 'global-maintenance' }
  | { kind: 'async-global-maintenance' }
  | { kind: 'manifest'; manifestLocation: ManagedLocalStorageManifestLocation }
  | { kind: 'compact-list-query' }
  | { kind: 'manifest-backed-payload' }
  | { kind: 'unknown-tsdf' };

function classifyTsdfLocalStorageKey(
  key: string,
): TsdfLocalStorageKeyClassification | null {
  if (!key.startsWith('tsdf.')) return null;
  if (key === GLOBAL_MAINTENANCE_KEY) {
    return { kind: 'global-maintenance' };
  }

  if (key === ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY) {
    return { kind: 'async-global-maintenance' };
  }

  const manifestLocation = parseManagedLocalStorageManifestKey(key);
  if (manifestLocation !== null) {
    return { kind: 'manifest', manifestLocation };
  }

  if (key.startsWith(METADATA_KEY_PREFIX)) {
    return { kind: 'unknown-tsdf' };
  }

  if (isCompactListQueryLocalStorageKey(key)) {
    return { kind: 'compact-list-query' };
  }

  return { kind: 'manifest-backed-payload' };
}

function readStoredManifestEntryMeta(entry: Record<string, unknown>): unknown {
  if ('m' in entry) {
    return entry.m;
  }

  const { a: _lastAccessAt, k: _entryKey, ...meta } = entry;
  return Object.keys(meta).length === 0 ? undefined : meta;
}

type StoredManagedLocalStorageManifestEntry = {
  entryKey: string | undefined;
  lastAccessAt: number;
  meta?: unknown;
};

function serializeStoredManifestEntry(
  entry: StoredManagedLocalStorageManifestEntry,
): Record<string, unknown> {
  const serializedEntry: Record<string, unknown> = { a: entry.lastAccessAt };

  if (entry.entryKey !== undefined) {
    serializedEntry.k = entry.entryKey;
  }

  if (
    isObject(entry.meta) &&
    !Array.isArray(entry.meta) &&
    !('a' in entry.meta) &&
    !('k' in entry.meta) &&
    !('m' in entry.meta)
  ) {
    return { ...serializedEntry, ...entry.meta };
  }

  if (entry.meta !== undefined) {
    serializedEntry.m = entry.meta;
  }

  return serializedEntry;
}

type ManagedLocalStorageManifest = {
  entries: StoredManagedLocalStorageManifestEntry[];
};

function readParsedManifest(
  manifestKey: string,
  io: ManagedLocalStorageIo,
): ManagedLocalStorageManifest | null {
  const parsedManifest = readParsedMetadataJson(
    manifestKey,
    managedLocalStorageManifestSchema,
    io,
  );
  if (!parsedManifest) return null;

  const entries: StoredManagedLocalStorageManifestEntry[] = [];

  for (const rawEntry of parsedManifest.e) {
    if (
      !isObject(rawEntry) ||
      Array.isArray(rawEntry) ||
      typeof rawEntry.a !== 'number'
    ) {
      return null;
    }

    if (
      'k' in rawEntry &&
      rawEntry.k !== undefined &&
      typeof rawEntry.k !== 'string'
    ) {
      return null;
    }

    entries.push({
      entryKey: typeof rawEntry.k === 'string' ? rawEntry.k : undefined,
      lastAccessAt: rawEntry.a,
      meta: readStoredManifestEntryMeta(rawEntry),
    });
  }

  return { entries };
}

function readManifest(
  manifestKey: string,
  io: ManagedLocalStorageIo,
): ManagedLocalStorageManifest {
  return readParsedManifest(manifestKey, io) ?? { entries: [] };
}

function writeManifest(
  manifestKey: string,
  manifest: ManagedLocalStorageManifest,
  io: ManagedLocalStorageIo,
): void {
  if (manifest.entries.length === 0) {
    removeManifestJson(manifestKey, io);
    return;
  }

  writeManifestJson(
    manifestKey,
    { e: manifest.entries.map(serializeStoredManifestEntry) },
    io,
  );
}

function getPayloadKeyForManifestEntry(
  manifestLocation: ManagedLocalStorageManifestLocation,
  entryKey: string | undefined,
): string | null {
  if (manifestLocation.kind === 'single') {
    return manifestLocation.payloadKey;
  }

  return entryKey === undefined
    ? null
    : `${manifestLocation.storagePrefix}${entryKey}`;
}

export type ManagedLocalStorageManifestEntry<TMeta = unknown> = {
  entryKey: string | undefined;
  payloadKey: string;
  lastAccessAt: number;
  meta?: TMeta;
};

function toManagedLocalStorageManifestEntry(
  manifestLocation: ManagedLocalStorageManifestLocation,
  entry: StoredManagedLocalStorageManifestEntry,
): ManagedLocalStorageManifestEntry | null {
  const payloadKey = getPayloadKeyForManifestEntry(
    manifestLocation,
    entry.entryKey,
  );
  if (payloadKey === null) return null;

  return { ...entry, payloadKey };
}

function readSingleManifestEntryByPayload(
  payloadKey: string,
  io: ManagedLocalStorageIo,
): { entry: ManagedLocalStorageManifestEntry; manifestKey: string } | null {
  const manifestKey = getManagedLocalStorageManifestKeyForSingle(payloadKey);
  const storedEntry =
    readManifest(manifestKey, io).entries.find(
      (candidate) => candidate.entryKey === undefined,
    ) ?? null;
  if (!storedEntry) return null;

  const entry = toManagedLocalStorageManifestEntry(
    { kind: 'single', manifestKey, payloadKey },
    storedEntry,
  );
  if (!entry) return null;

  return { entry, manifestKey };
}

function getNamespaceEntryKeyForPayload(
  payloadKey: string,
  storagePrefix: string,
): string | null {
  if (!payloadKey.startsWith(storagePrefix)) return null;
  return payloadKey.slice(storagePrefix.length);
}

function readNamespaceManifestEntryByPayload(
  payloadKey: string,
  storagePrefix: string,
  io: ManagedLocalStorageIo,
): { entry: ManagedLocalStorageManifestEntry; manifestKey: string } | null {
  const entryKey = getNamespaceEntryKeyForPayload(payloadKey, storagePrefix);
  if (entryKey === null) return null;

  const manifestKey = getManagedLocalStorageManifestKeyForPrefix(storagePrefix);
  const storedEntry =
    readManifest(manifestKey, io).entries.find(
      (candidate) => candidate.entryKey === entryKey,
    ) ?? null;
  if (!storedEntry) return null;

  const entry = toManagedLocalStorageManifestEntry(
    { kind: 'namespace', manifestKey, storagePrefix },
    storedEntry,
  );
  if (!entry) return null;

  return { entry, manifestKey };
}

export function listManagedLocalStorageKeysSync(
  prefix: string,
  io: ManagedLocalStorageIo = directManagedLocalStorageIo,
): string[] | null {
  const manifest = readParsedManifest(
    getManagedLocalStorageManifestKeyForPrefix(prefix),
    io,
  );
  if (!manifest) return null;

  return manifest.entries.flatMap((entry) =>
    entry.entryKey === undefined ? [] : [`${prefix}${entry.entryKey}`],
  );
}

export type ManagedLocalStorageNamespaceManifestEntry<TMeta = unknown> =
  ManagedLocalStorageManifestEntry<TMeta> & { entryKey: string };

export function readManagedLocalStorageManifestEntriesByPrefix(
  prefix: string,
  io: ManagedLocalStorageIo = directManagedLocalStorageIo,
): ManagedLocalStorageNamespaceManifestEntry[] {
  return readManifest(
    getManagedLocalStorageManifestKeyForPrefix(prefix),
    io,
  ).entries.flatMap((entry) => {
    if (entry.entryKey === undefined) return [];

    return [
      {
        ...entry,
        entryKey: entry.entryKey,
        payloadKey: `${prefix}${entry.entryKey}`,
      },
    ];
  });
}

export function readManagedLocalStorageSingleEntryByPayload(
  payloadKey: string,
  io: ManagedLocalStorageIo = directManagedLocalStorageIo,
): ManagedLocalStorageManifestEntry | null {
  return readSingleManifestEntryByPayload(payloadKey, io)?.entry ?? null;
}

export function readManagedLocalStorageNamespaceEntryByPayload(
  payloadKey: string,
  storagePrefix: string,
  io: ManagedLocalStorageIo = directManagedLocalStorageIo,
): ManagedLocalStorageManifestEntry | null {
  return (
    readNamespaceManifestEntryByPayload(payloadKey, storagePrefix, io)?.entry ??
    null
  );
}

export function isManagedLocalStorageEntryOfflineProtected(
  meta: unknown,
): boolean {
  return (
    typeof meta === 'object' &&
    meta !== null &&
    !Array.isArray(meta) &&
    'o' in meta &&
    meta.o === true
  );
}

export function setManagedLocalStorageEntryOfflineProtected(
  meta: unknown,
  offlineProtected: boolean,
): unknown {
  const baseMeta = Object.fromEntries(
    typeof meta === 'object' && meta !== null && !Array.isArray(meta)
      ? Object.entries(meta)
      : [],
  );

  if (offlineProtected) {
    return { ...baseMeta, o: true };
  }

  const { o: _ignored, ...nextMeta } = baseMeta;
  return Object.keys(nextMeta).length === 0 ? undefined : nextMeta;
}

export function readManagedLocalStorageProtectedKeys(
  sessionKey: string,
  io: ManagedLocalStorageIo = directManagedLocalStorageIo,
): Set<string> {
  const allKeys = io.listKeys();
  const knownKeys = new Set(allKeys);
  const protectedKeys = new Set<string>();

  for (const manifestKey of allKeys) {
    if (
      !isManagedLocalStorageManifestKey(manifestKey) ||
      !manifestBelongsToSession(manifestKey, sessionKey)
    ) {
      continue;
    }

    const manifestLocation = parseManagedLocalStorageManifestKey(manifestKey);
    const manifest = readParsedManifest(manifestKey, io);
    if (!manifestLocation || !manifest) continue;

    for (const entry of manifest.entries) {
      if (!isManagedLocalStorageEntryOfflineProtected(entry.meta)) continue;

      const payloadKey = getPayloadKeyForManifestEntry(
        manifestLocation,
        entry.entryKey,
      );
      if (payloadKey === null || !knownKeys.has(payloadKey)) continue;

      protectedKeys.add(payloadKey);
    }
  }

  const payloadPrefix = `tsdf.${sessionKey}.`;
  for (const payloadKey of allKeys) {
    if (!payloadKey.startsWith(payloadPrefix)) continue;
    if (isManagedLocalStorageManifestKey(payloadKey)) continue;
    if (!isCompactListQueryLocalStorageKey(payloadKey)) continue;

    if (readCompactListQueryEntry(payloadKey, io)?.offlineProtected === true) {
      protectedKeys.add(payloadKey);
    }
  }

  return protectedKeys;
}

export function syncManagedLocalStorageSessionProtection(
  sessionKey: string,
  protectedKeys: Iterable<string>,
  io: ManagedLocalStorageIo = directManagedLocalStorageIo,
): void {
  const nextProtectedKeys = new Set(protectedKeys);
  const allKeys = io.listKeys();

  for (const manifestKey of allKeys) {
    if (
      !isManagedLocalStorageManifestKey(manifestKey) ||
      !manifestBelongsToSession(manifestKey, sessionKey)
    ) {
      continue;
    }

    const manifestLocation = parseManagedLocalStorageManifestKey(manifestKey);
    const manifest = readParsedManifest(manifestKey, io);
    if (!manifestLocation || !manifest) continue;

    let manifestChanged = false;
    const nextEntries: StoredManagedLocalStorageManifestEntry[] = [];

    for (const entry of manifest.entries) {
      const payloadKey = getPayloadKeyForManifestEntry(
        manifestLocation,
        entry.entryKey,
      );
      if (payloadKey === null) {
        nextEntries.push(entry);
        continue;
      }

      const shouldProtect =
        !isOfflinePayloadKey(payloadKey) && nextProtectedKeys.has(payloadKey);
      if (
        isManagedLocalStorageEntryOfflineProtected(entry.meta) === shouldProtect
      ) {
        nextEntries.push(entry);
        continue;
      }

      manifestChanged = true;
      nextEntries.push({
        ...entry,
        meta: setManagedLocalStorageEntryOfflineProtected(
          entry.meta,
          shouldProtect,
        ),
      });
    }

    if (manifestChanged) {
      writeManifest(manifestKey, { entries: nextEntries }, io);
    }
  }

  const payloadPrefix = `tsdf.${sessionKey}.`;
  for (const payloadKey of allKeys) {
    if (!payloadKey.startsWith(payloadPrefix)) continue;
    if (!isCompactListQueryLocalStorageKey(payloadKey)) continue;

    const entry = readCompactListQueryEntry(payloadKey, io);
    if (entry === null) continue;

    const shouldProtect =
      !isOfflinePayloadKey(payloadKey) && nextProtectedKeys.has(payloadKey);
    if (entry.offlineProtected === shouldProtect) continue;

    writeCompactListQueryOfflineProtection(
      payloadKey,
      entry,
      shouldProtect,
      io,
    );
  }

  const legacyProtectedKeysStorageKey = `tsdf.${sessionKey}._o_.p`;
  io.removeItem(legacyProtectedKeysStorageKey);
  removeMetadataJson(
    getManagedLocalStorageManifestKeyForSingle(legacyProtectedKeysStorageKey),
    io,
  );
}

function upsertManifestEntry(
  manifestKey: string,
  entry: StoredManagedLocalStorageManifestEntry,
  io: ManagedLocalStorageIo,
): void {
  const manifest = readManifest(manifestKey, io);
  const existingIndex = manifest.entries.findIndex(
    (candidate) => candidate.entryKey === entry.entryKey,
  );

  if (existingIndex === -1) {
    manifest.entries.push(entry);
  } else {
    manifest.entries[existingIndex] = entry;
  }

  writeManifest(manifestKey, manifest, io);
}

function removeManifestEntry(
  manifestKey: string,
  entryKey: string | undefined,
  io: ManagedLocalStorageIo,
): void {
  const manifest = readManifest(manifestKey, io);
  const nextEntries = manifest.entries.filter(
    (entry) => entry.entryKey !== entryKey,
  );

  if (nextEntries.length === manifest.entries.length) return;

  writeManifest(manifestKey, { entries: nextEntries }, io);
}

type UpsertSingleEntryParams = {
  storageKey: string;
  lastAccessAt?: number;
  meta?: unknown;
};

export function upsertManagedLocalStorageSingleEntry(
  params: UpsertSingleEntryParams,
  io: ManagedLocalStorageIo = directManagedLocalStorageIo,
): string {
  const manifestKey = getManagedLocalStorageManifestKeyForSingle(
    params.storageKey,
  );

  upsertManifestEntry(
    manifestKey,
    {
      entryKey: undefined,
      lastAccessAt: params.lastAccessAt ?? Date.now(),
      meta: params.meta,
    },
    io,
  );

  return manifestKey;
}

type UpsertNamespaceEntryParams = {
  storagePrefix: string;
  entryKey: string;
  lastAccessAt?: number;
  meta?: unknown;
};

export function upsertManagedLocalStorageNamespaceEntry(
  params: UpsertNamespaceEntryParams,
  io: ManagedLocalStorageIo = directManagedLocalStorageIo,
): string {
  const manifestKey = getManagedLocalStorageManifestKeyForPrefix(
    params.storagePrefix,
  );

  upsertManifestEntry(
    manifestKey,
    {
      entryKey: params.entryKey,
      lastAccessAt: params.lastAccessAt ?? Date.now(),
      meta: params.meta,
    },
    io,
  );

  return manifestKey;
}

export function touchManagedLocalStorageNamespacePayload(
  payloadKey: string,
  storagePrefix: string,
  io: ManagedLocalStorageIo = directManagedLocalStorageIo,
): boolean {
  const current = readNamespaceManifestEntryByPayload(
    payloadKey,
    storagePrefix,
    io,
  );
  if (!current) return false;

  upsertManifestEntry(
    current.manifestKey,
    {
      entryKey: current.entry.entryKey,
      lastAccessAt: Date.now(),
      meta: current.entry.meta,
    },
    io,
  );

  return true;
}

export function touchManagedLocalStorageSinglePayload(
  payloadKey: string,
  io: ManagedLocalStorageIo = directManagedLocalStorageIo,
): boolean {
  const current = readSingleManifestEntryByPayload(payloadKey, io);
  if (!current) return false;

  upsertManifestEntry(
    current.manifestKey,
    {
      entryKey: current.entry.entryKey,
      lastAccessAt: Date.now(),
      meta: current.entry.meta,
    },
    io,
  );

  return true;
}

export function removeManagedLocalStorageNamespacePayload(
  payloadKey: string,
  storagePrefix: string,
  io: ManagedLocalStorageIo = directManagedLocalStorageIo,
): boolean {
  const current = readNamespaceManifestEntryByPayload(
    payloadKey,
    storagePrefix,
    io,
  );
  if (!current) return false;

  removeManifestEntry(current.manifestKey, current.entry.entryKey, io);
  return true;
}

export function removeManagedLocalStorageSinglePayload(
  payloadKey: string,
  io: ManagedLocalStorageIo = directManagedLocalStorageIo,
): boolean {
  const current = readSingleManifestEntryByPayload(payloadKey, io);
  if (!current) return false;

  removeManifestEntry(current.manifestKey, current.entry.entryKey, io);
  return true;
}

export function clearManagedLocalStorageManifest(
  manifestKey: string,
  io: ManagedLocalStorageIo = directManagedLocalStorageIo,
): void {
  const manifestLocation = parseManagedLocalStorageManifestKey(manifestKey);
  const manifest = readParsedManifest(manifestKey, io);

  if (manifestLocation && manifest) {
    for (const entry of manifest.entries) {
      const payloadKey = getPayloadKeyForManifestEntry(
        manifestLocation,
        entry.entryKey,
      );
      if (payloadKey !== null) {
        io.removeItem(payloadKey);
      }
    }
  }

  removeMetadataJson(manifestKey, io);
  maintenanceCallbacks.delete(manifestKey);
}

function manifestBelongsToSession(
  manifestKey: string,
  sessionKey: string,
): boolean {
  const sessionPrefix = `${sessionKey}.`;

  return (
    manifestKey.startsWith(`${SINGLE_MANIFEST_KEY_PREFIX}${sessionPrefix}`) ||
    manifestKey.startsWith(`${NAMESPACE_MANIFEST_KEY_PREFIX}${sessionPrefix}`)
  );
}

export function clearManagedLocalStorageSession(
  sessionKey: string,
  io: ManagedLocalStorageIo = directManagedLocalStorageIo,
): void {
  const payloadPrefix = `tsdf.${sessionKey}.`;

  for (const key of io.listKeys()) {
    if (key.startsWith(payloadPrefix)) {
      io.removeItem(key);
      continue;
    }

    if (manifestBelongsToSession(key, sessionKey)) {
      removeMetadataJson(key, io);
      maintenanceCallbacks.delete(key);
    }
  }
}

export function registerManagedLocalStorageMaintenanceCallback(
  manifestKey: string,
  callback: () => Promise<void>,
): void {
  maintenanceCallbacks.set(manifestKey, callback);
}

export function unregisterManagedLocalStorageMaintenanceCallback(
  manifestKey: string,
): void {
  maintenanceCallbacks.delete(manifestKey);
}

type ManagedLocalStorageGlobalMaintenance = { lastCleanupAt: number | null };

function readGlobalMaintenanceState(
  io: ManagedLocalStorageIo,
): ManagedLocalStorageGlobalMaintenance {
  const parsedState = readParsedMetadataJson(
    GLOBAL_MAINTENANCE_KEY,
    managedLocalStorageGlobalMaintenanceSchema,
    io,
  );

  if (parsedState === null) {
    return { lastCleanupAt: null };
  }

  return { lastCleanupAt: parsedState.lca };
}

function writeGlobalMaintenanceState(
  state: ManagedLocalStorageGlobalMaintenance,
  io: ManagedLocalStorageIo,
): void {
  writeMetadataJson(GLOBAL_MAINTENANCE_KEY, { lca: state.lastCleanupAt }, io);
}

function isMaintenanceDue(
  state: ManagedLocalStorageGlobalMaintenance,
): boolean {
  if (state.lastCleanupAt === null) return true;

  return (
    Date.now() - state.lastCleanupAt >=
    managedLocalStorageRuntimeConfig.cleanupIntervalMs
  );
}

function runStrictTsdfLocalStorageCleanup(io: ManagedLocalStorageIo): void {
  const tsdfKeys = io.listKeys().filter((key) => key.startsWith('tsdf.'));
  const manifestOwnedPayloadKeys = new Set<string>();
  const manifestBackedPayloadKeys: string[] = [];

  for (const key of tsdfKeys) {
    const classification = classifyTsdfLocalStorageKey(key);
    if (classification === null) continue;

    switch (classification.kind) {
      case 'global-maintenance': {
        if (
          readParsedMetadataJson(
            key,
            managedLocalStorageGlobalMaintenanceSchema,
            io,
          ) === null
        ) {
          removeMetadataJson(key, io);
        }
        break;
      }
      case 'async-global-maintenance': {
        if (
          readParsedMetadataJson(
            key,
            managedLocalStorageGlobalMaintenanceSchema,
            io,
          ) === null
        ) {
          removeMetadataJson(key, io);
        }
        break;
      }
      case 'manifest': {
        const manifest = readParsedManifest(key, io);
        if (manifest === null) {
          removeMetadataJson(key, io);
          break;
        }

        for (const entry of manifest.entries) {
          const payloadKey = getPayloadKeyForManifestEntry(
            classification.manifestLocation,
            entry.entryKey,
          );
          if (payloadKey !== null) {
            manifestOwnedPayloadKeys.add(payloadKey);
          }
        }
        break;
      }
      case 'compact-list-query': {
        if (readCompactListQueryEntry(key, io) === null) {
          io.removeItem(key);
        }
        break;
      }
      case 'manifest-backed-payload': {
        manifestBackedPayloadKeys.push(key);
        break;
      }
      case 'unknown-tsdf': {
        io.removeItem(key);
        break;
      }
    }
  }

  for (const payloadKey of manifestBackedPayloadKeys) {
    if (!manifestOwnedPayloadKeys.has(payloadKey)) {
      io.removeItem(payloadKey);
    }
  }
}

function collectManagedLocalStorageSweepTargets(io: ManagedLocalStorageIo): {
  manifestKeys: string[];
  knownKeys: Set<string>;
} {
  const allKeys = io.listKeys();
  const manifestKeys = allKeys.filter((key) => {
    if (!isManagedLocalStorageManifestKey(key)) return false;

    const manifestLocation = parseManagedLocalStorageManifestKey(key);
    if (
      manifestLocation?.kind === 'single' &&
      manifestLocation.payloadKey.includes('._o_.')
    ) {
      return false;
    }

    if (
      manifestLocation?.kind === 'namespace' &&
      (manifestLocation.storagePrefix.endsWith('.oq.') ||
        manifestLocation.storagePrefix.endsWith('.oc.') ||
        manifestLocation.storagePrefix.endsWith('.oe.'))
    ) {
      return false;
    }

    return true;
  });
  const knownKeys = new Set(allKeys);

  return { manifestKeys, knownKeys };
}

function isOfflinePayloadKey(payloadKey: string): boolean {
  return payloadKey.includes('._o_.');
}

function runGenericCleanupForManifest(
  manifestKey: string,
  knownKeys: Set<string> | null,
  io: ManagedLocalStorageIo,
): void {
  const manifestLocation = parseManagedLocalStorageManifestKey(manifestKey);
  if (!manifestLocation) {
    removeMetadataJson(manifestKey, io);
    return;
  }

  const manifest = readParsedManifest(manifestKey, io);
  if (!manifest) {
    if (io.getItem(manifestKey) !== null) {
      removeMetadataJson(manifestKey, io);
    }
    return;
  }

  const now = Date.now();
  const nextEntries: StoredManagedLocalStorageManifestEntry[] = [];

  for (const entry of manifest.entries) {
    const payloadKey = getPayloadKeyForManifestEntry(
      manifestLocation,
      entry.entryKey,
    );
    if (payloadKey === null) continue;

    if (knownKeys !== null && !knownKeys.has(payloadKey)) continue;

    if (
      !isOfflinePayloadKey(payloadKey) &&
      !isManagedLocalStorageEntryOfflineProtected(entry.meta) &&
      now - entry.lastAccessAt > managedLocalStorageRuntimeConfig.maxAgeMs
    ) {
      io.removeItem(payloadKey);
      continue;
    }

    nextEntries.push(entry);
  }

  if (nextEntries.length === manifest.entries.length) return;

  writeManifest(manifestKey, { entries: nextEntries }, io);
}

export async function runManagedLocalStorageMaintenance(
  io: ManagedLocalStorageIo = directManagedLocalStorageIo,
  { forceManifestKeys = [] }: { forceManifestKeys?: Iterable<string> } = {},
): Promise<void> {
  const forcedManifestKeys = new Set(forceManifestKeys);
  const runGlobalSweep = forcedManifestKeys.size === 0;
  if (runGlobalSweep && !isMaintenanceDue(readGlobalMaintenanceState(io))) {
    return;
  }

  if (runGlobalSweep) {
    runStrictTsdfLocalStorageCleanup(io);
  }

  const { manifestKeys, knownKeys } = runGlobalSweep
    ? collectManagedLocalStorageSweepTargets(io)
    : { manifestKeys: [...forcedManifestKeys], knownKeys: null };
  const invokedCallbacks = new Set<() => Promise<void>>();

  for (const manifestKey of manifestKeys) {
    runGenericCleanupForManifest(manifestKey, knownKeys, io);

    const callback = maintenanceCallbacks.get(manifestKey);
    if (!callback || invokedCallbacks.has(callback)) continue;

    invokedCallbacks.add(callback);
    await callback();
  }

  if (runGlobalSweep) {
    for (const callback of maintenanceCallbacks.values()) {
      if (invokedCallbacks.has(callback)) continue;

      invokedCallbacks.add(callback);
      await callback();
    }

    writeGlobalMaintenanceState({ lastCleanupAt: Date.now() }, io);
  }
}

export function resetManagedLocalStorageState(): void {
  maintenanceCallbacks.clear();
  managedLocalStorageRuntimeConfig = {
    ...defaultManagedLocalStorageRuntimeConfig,
  };
}
