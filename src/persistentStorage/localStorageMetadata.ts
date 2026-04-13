import { isObject } from '@ls-stack/utils/typeGuards';
import {
  rc_number,
  rc_object,
  rc_parse,
  rc_parse_json,
  rc_unknown,
  type RcType,
} from 'runcheck';
import { ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY } from './asyncStorageAdapter';
import {
  type CompactListQueryLocalStorageEntry,
  createCompactListQueryLocalStorageEntry,
  isCompactListQueryLocalStorageKey,
  parseCompactListQueryLocalStorageEntry,
} from './compactListQueryLocalStorageEntry';
import { parseCompactLocalStorageEntry } from './compactLocalStorageEntry';
import { DOCUMENT_PERSISTED_ENTRY_KEY } from './documentEntryKey';
import { isOfflineModeStatusValue } from './offline/types';

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

const managedLocalStorageManifestSchema = rc_object({ e: rc_unknown });

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

  const { a: _lastAccessAt, z: _sizeBytes, ...meta } = entry;
  return Object.keys(meta).length === 0 ? undefined : meta;
}

type StoredManagedLocalStorageManifestEntry = {
  entryKey: string | undefined;
  lastAccessAt: number;
  sizeBytes?: number;
  meta?: unknown;
};

function serializeStoredManifestEntry(
  entry: StoredManagedLocalStorageManifestEntry,
): Record<string, unknown> {
  const serializedEntry: Record<string, unknown> = {
    a: entry.lastAccessAt,
    ...(entry.sizeBytes !== undefined ? { z: entry.sizeBytes } : {}),
  };

  if (
    isObject(entry.meta) &&
    !('a' in entry.meta) &&
    !('m' in entry.meta) &&
    !('z' in entry.meta)
  ) {
    return { ...serializedEntry, ...entry.meta };
  }

  if (entry.meta !== undefined) {
    serializedEntry.m = entry.meta;
  }

  return serializedEntry;
}

type ManagedLocalStorageManifest = {
  entries: Map<string | undefined, StoredManagedLocalStorageManifestEntry>;
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

  const manifestLocation = parseManagedLocalStorageManifestKey(manifestKey);
  const rawEntries = parsedManifest.e;
  if (!manifestLocation || !isObject(rawEntries)) {
    return null;
  }

  const entries = new Map<
    string | undefined,
    StoredManagedLocalStorageManifestEntry
  >();

  for (const [storedEntryKey, rawEntry] of Object.entries(rawEntries)) {
    if (
      !isObject(rawEntry) ||
      typeof rawEntry.a !== 'number' ||
      ('z' in rawEntry &&
        rawEntry.z !== undefined &&
        typeof rawEntry.z !== 'number')
    ) {
      return null;
    }

    const entryKey =
      manifestLocation.kind === 'single'
        ? storedEntryKey === DOCUMENT_PERSISTED_ENTRY_KEY
          ? undefined
          : null
        : storedEntryKey;
    if (entryKey === null) return null;

    entries.set(entryKey, {
      entryKey,
      lastAccessAt: rawEntry.a,
      ...(typeof rawEntry.z === 'number' ? { sizeBytes: rawEntry.z } : {}),
      meta: readStoredManifestEntryMeta(rawEntry),
    });
  }

  return { entries };
}

function readManifest(
  manifestKey: string,
  io: ManagedLocalStorageIo,
): ManagedLocalStorageManifest {
  return readParsedManifest(manifestKey, io) ?? { entries: new Map() };
}

function writeManifest(
  manifestKey: string,
  manifest: ManagedLocalStorageManifest,
  io: ManagedLocalStorageIo,
): void {
  if (manifest.entries.size === 0) {
    removeManifestJson(manifestKey, io);
    return;
  }

  const manifestLocation = parseManagedLocalStorageManifestKey(manifestKey);
  if (!manifestLocation) {
    removeManifestJson(manifestKey, io);
    return;
  }

  const serializedEntries = Object.fromEntries(
    [...manifest.entries.values()].map((entry) => {
      const storedEntryKey =
        manifestLocation.kind === 'single'
          ? entry.entryKey === undefined
            ? DOCUMENT_PERSISTED_ENTRY_KEY
            : null
          : entry.entryKey;

      if (storedEntryKey === null) {
        throw new Error(
          `[TSDF] Invalid sync manifest entry key for "${manifestKey}".`,
        );
      }

      return [storedEntryKey, serializeStoredManifestEntry(entry)];
    }),
  );

  writeManifestJson(manifestKey, { e: serializedEntries }, io);
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
  sizeBytes?: number;
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
  const storedEntry = readManifest(manifestKey, io).entries.get(undefined);
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
  const storedEntry = readManifest(manifestKey, io).entries.get(entryKey);
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

  return [...manifest.entries.values()].flatMap((entry) =>
    entry.entryKey === undefined ? [] : [`${prefix}${entry.entryKey}`],
  );
}

export type ManagedLocalStorageNamespaceManifestEntry<TMeta = unknown> =
  ManagedLocalStorageManifestEntry<TMeta> & { entryKey: string };

export function readManagedLocalStorageManifestEntriesByPrefix(
  prefix: string,
  io: ManagedLocalStorageIo = directManagedLocalStorageIo,
): ManagedLocalStorageNamespaceManifestEntry[] {
  return [
    ...readManifest(
      getManagedLocalStorageManifestKeyForPrefix(prefix),
      io,
    ).entries.values(),
  ].flatMap((entry) => {
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

    for (const entry of manifest.entries.values()) {
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
    const nextEntries = new Map(manifest.entries);

    for (const entry of manifest.entries.values()) {
      const payloadKey = getPayloadKeyForManifestEntry(
        manifestLocation,
        entry.entryKey,
      );
      if (payloadKey === null) continue;

      const shouldProtect =
        !isOfflinePayloadKey(payloadKey) && nextProtectedKeys.has(payloadKey);
      if (
        isManagedLocalStorageEntryOfflineProtected(entry.meta) === shouldProtect
      ) {
        continue;
      }

      manifestChanged = true;
      nextEntries.set(entry.entryKey, {
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
}

function upsertManifestEntry(
  manifestKey: string,
  entry: StoredManagedLocalStorageManifestEntry & {
    clearSizeBytes?: boolean;
    mergeMeta?: (
      currentMeta: StoredManagedLocalStorageManifestEntry['meta'],
    ) => unknown;
  },
  io: ManagedLocalStorageIo,
): void {
  const manifest = readManifest(manifestKey, io);
  const currentEntry = manifest.entries.get(entry.entryKey);
  const nextEntries = new Map(manifest.entries);
  nextEntries.set(entry.entryKey, {
    entryKey: entry.entryKey,
    lastAccessAt: entry.lastAccessAt,
    ...(entry.clearSizeBytes
      ? {}
      : { sizeBytes: entry.sizeBytes ?? currentEntry?.sizeBytes }),
    meta: entry.mergeMeta ? entry.mergeMeta(currentEntry?.meta) : entry.meta,
  });
  writeManifest(manifestKey, { entries: nextEntries }, io);
}

function removeManifestEntry(
  manifestKey: string,
  entryKey: string | undefined,
  io: ManagedLocalStorageIo,
): void {
  const manifest = readManifest(manifestKey, io);
  if (!manifest.entries.has(entryKey)) return;

  const nextEntries = new Map(manifest.entries);
  nextEntries.delete(entryKey);
  writeManifest(manifestKey, { entries: nextEntries }, io);
}

type UpsertSingleEntryParams = {
  storageKey: string;
  lastAccessAt?: number;
  clearSizeBytes?: boolean;
  sizeBytes?: number;
  mergeMeta?: (
    currentMeta: StoredManagedLocalStorageManifestEntry['meta'],
  ) => unknown;
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
      clearSizeBytes: params.clearSizeBytes,
      sizeBytes: params.sizeBytes,
      mergeMeta: params.mergeMeta,
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
  sizeBytes?: number;
  mergeMeta?: (
    currentMeta: StoredManagedLocalStorageManifestEntry['meta'],
  ) => unknown;
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
      sizeBytes: params.sizeBytes,
      mergeMeta: params.mergeMeta,
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
      sizeBytes: current.entry.sizeBytes,
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
      clearSizeBytes: true,
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
    for (const entry of manifest.entries.values()) {
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

function getSessionKeyFromStorageIdentity(identity: string): string | null {
  if (!identity.startsWith('tsdf.')) return null;

  const withoutPrefix = identity.slice('tsdf.'.length);
  const lastDotIndex = withoutPrefix.lastIndexOf('.');
  if (lastDotIndex <= 0) return null;

  return withoutPrefix.slice(0, lastDotIndex);
}

function getSessionKeyForManifestLocation(
  manifestLocation: ManagedLocalStorageManifestLocation,
): string | null {
  if (manifestLocation.kind === 'single') {
    return getSessionKeyFromStorageIdentity(manifestLocation.payloadKey);
  }

  const trimmedPrefix = manifestLocation.storagePrefix.endsWith('.')
    ? manifestLocation.storagePrefix.slice(0, -1)
    : manifestLocation.storagePrefix;
  const namespaceRootEnd = trimmedPrefix.lastIndexOf('.');
  if (namespaceRootEnd === -1) return null;

  return getSessionKeyFromStorageIdentity(
    trimmedPrefix.slice(0, namespaceRootEnd),
  );
}

function getCachedOfflineStatus(
  sessionKey: string,
  io: ManagedLocalStorageIo,
  cache: Map<string, boolean>,
): boolean {
  const cached = cache.get(sessionKey);
  if (cached !== undefined) return cached;

  const result = isSessionOfflineDuringManagedCleanup(sessionKey, io);
  cache.set(sessionKey, result);
  return result;
}

function isSessionOfflineDuringManagedCleanup(
  sessionKey: string,
  io: ManagedLocalStorageIo,
): boolean {
  const statusEntry = parseCompactLocalStorageEntry(
    io.getItem(`tsdf.${sessionKey}._o_.s`),
  );
  const rawStatus: unknown = statusEntry?.value;
  const status =
    isObject(rawStatus) && isObject(rawStatus.d)
      ? rawStatus.d
      : (rawStatus ?? null);

  return isOfflineModeStatusValue(status);
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

        for (const entry of manifest.entries.values()) {
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
      manifestLocation.payloadKey.includes('._o_.') &&
      !manifestLocation.payloadKey.endsWith('._o_.s')
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
  return payloadKey.includes('._o_.') && !payloadKey.endsWith('._o_.s');
}

function runGenericCleanupForManifest(
  manifestKey: string,
  knownKeys: Set<string> | null,
  io: ManagedLocalStorageIo,
  offlineSessionCache: Map<string, boolean>,
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
  const sessionKey = getSessionKeyForManifestLocation(manifestLocation);
  const offlineStatusKey =
    sessionKey === null ? null : `tsdf.${sessionKey}._o_.s`;
  const skipExpiration =
    sessionKey !== null &&
    offlineStatusKey !== null &&
    knownKeys !== null &&
    knownKeys.has(offlineStatusKey) &&
    getCachedOfflineStatus(sessionKey, io, offlineSessionCache);
  const nextEntries = new Map<
    string | undefined,
    StoredManagedLocalStorageManifestEntry
  >();

  for (const entry of manifest.entries.values()) {
    const payloadKey = getPayloadKeyForManifestEntry(
      manifestLocation,
      entry.entryKey,
    );
    if (payloadKey === null) continue;

    if (knownKeys !== null && !knownKeys.has(payloadKey)) continue;

    if (
      !isOfflinePayloadKey(payloadKey) &&
      !isManagedLocalStorageEntryOfflineProtected(entry.meta) &&
      !skipExpiration &&
      now - entry.lastAccessAt > managedLocalStorageRuntimeConfig.maxAgeMs
    ) {
      io.removeItem(payloadKey);
      continue;
    }

    nextEntries.set(entry.entryKey, entry);
  }

  if (nextEntries.size === manifest.entries.size) return;

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
  const offlineSessionCache = new Map<string, boolean>();

  for (const manifestKey of manifestKeys) {
    runGenericCleanupForManifest(
      manifestKey,
      knownKeys,
      io,
      offlineSessionCache,
    );

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
