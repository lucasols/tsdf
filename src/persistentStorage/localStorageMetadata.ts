import {
  rc_array,
  rc_literals,
  rc_number,
  rc_object,
  rc_parse_json,
  rc_string,
  rc_unknown,
  type RcInferType,
  type RcType,
} from 'runcheck';

const METADATA_VERSION = 1;

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

const managedLocalStorageStoredManifestEntrySchema = rc_object({
  entryKey: rc_string.optionalKey(),
  lastAccessAt: rc_number,
  meta: rc_unknown.optionalKey(),
});

const managedLocalStorageManifestSchema = rc_object({
  version: rc_literals(METADATA_VERSION),
  entries: rc_array(managedLocalStorageStoredManifestEntrySchema),
});

const managedLocalStorageGlobalMaintenanceSchema = rc_object({
  v: rc_literals(METADATA_VERSION),
  lca: rc_number.orNull(),
});

const protectedKeysEntrySchema = rc_object({
  data: rc_object({ keys: rc_array(rc_string).withFallback([]).optionalKey() }),
});

function readParsedMetadataJson<T>(
  key: string,
  schema: RcType<T>,
  io: ManagedLocalStorageIo,
): T | null {
  const raw = io.getItem(key);
  return raw === null ? null : rc_parse_json(raw, schema).unwrapOrNull();
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

type StoredManagedLocalStorageManifestEntry = {
  entryKey: string | undefined;
  lastAccessAt: number;
  meta?: unknown;
};

type ManagedLocalStorageManifest = {
  version: RcInferType<typeof managedLocalStorageManifestSchema>['version'];
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

  return {
    version: parsedManifest.version,
    entries: parsedManifest.entries.map((entry) => ({
      entryKey: entry.entryKey,
      lastAccessAt: entry.lastAccessAt,
      meta: entry.meta,
    })),
  };
}

function readManifest(
  manifestKey: string,
  io: ManagedLocalStorageIo,
): ManagedLocalStorageManifest {
  return (
    readParsedManifest(manifestKey, io) ?? {
      version: METADATA_VERSION,
      entries: [],
    }
  );
}

function writeManifest(
  manifestKey: string,
  manifest: ManagedLocalStorageManifest,
  io: ManagedLocalStorageIo,
): void {
  if (manifest.entries.length === 0) {
    removeMetadataJson(manifestKey, io);
    return;
  }

  writeMetadataJson(manifestKey, manifest, io);
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

export function readManagedLocalStorageProtectedKeys(
  sessionKey: string,
  io: ManagedLocalStorageIo = directManagedLocalStorageIo,
): Set<string> {
  return new Set(
    readManagedLocalStorageProtectedKeysByStorageKey(
      `tsdf.${sessionKey}._o_.p`,
      io,
    ),
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

  writeManifest(
    manifestKey,
    { version: METADATA_VERSION, entries: nextEntries },
    io,
  );
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

type ManagedLocalStorageGlobalMaintenance = {
  version: typeof METADATA_VERSION;
  lastCleanupAt: number | null;
};

function readGlobalMaintenanceState(
  io: ManagedLocalStorageIo,
): ManagedLocalStorageGlobalMaintenance {
  const parsedState = readParsedMetadataJson(
    GLOBAL_MAINTENANCE_KEY,
    managedLocalStorageGlobalMaintenanceSchema,
    io,
  );

  if (parsedState === null) {
    return { version: METADATA_VERSION, lastCleanupAt: null };
  }

  return { version: parsedState.v, lastCleanupAt: parsedState.lca };
}

type ManagedLocalStorageGlobalMaintenanceRaw = RcInferType<
  typeof managedLocalStorageGlobalMaintenanceSchema
>;

function writeGlobalMaintenanceState(
  state: ManagedLocalStorageGlobalMaintenance,
  io: ManagedLocalStorageIo,
): void {
  const rawState: ManagedLocalStorageGlobalMaintenanceRaw = {
    v: state.version,
    lca: state.lastCleanupAt,
  };
  writeMetadataJson(GLOBAL_MAINTENANCE_KEY, rawState, io);
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

function readManagedLocalStorageProtectedKeysByStorageKey(
  storageKey: string,
  io: ManagedLocalStorageIo,
): string[] {
  return (
    readParsedMetadataJson(storageKey, protectedKeysEntrySchema, io)?.data
      .keys ?? []
  );
}

function collectProtectedKeysFromStorage(
  keys: Iterable<string>,
  io: ManagedLocalStorageIo,
): Set<string> {
  const protectedKeys = new Set<string>();

  for (const key of keys) {
    if (!key.endsWith('._o_.p')) continue;

    for (const protectedKey of readManagedLocalStorageProtectedKeysByStorageKey(
      key,
      io,
    )) {
      protectedKeys.add(protectedKey);
    }
  }

  return protectedKeys;
}

function collectManagedLocalStorageSweepTargets(io: ManagedLocalStorageIo): {
  manifestKeys: string[];
  protectedKeys: Set<string>;
} {
  const allKeys = io.listKeys();
  const manifestKeys = allKeys.filter(isManagedLocalStorageManifestKey);
  const protectedKeys = collectProtectedKeysFromStorage(allKeys, io);

  return { manifestKeys, protectedKeys };
}

function isOfflinePayloadKey(payloadKey: string): boolean {
  return payloadKey.includes('._o_.');
}

function runGenericCleanupForManifest(
  manifestKey: string,
  protectedKeys: Set<string>,
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

    const rawPayload = io.getItem(payloadKey);
    if (rawPayload === null) continue;

    if (
      !isOfflinePayloadKey(payloadKey) &&
      !protectedKeys.has(payloadKey) &&
      now - entry.lastAccessAt > managedLocalStorageRuntimeConfig.maxAgeMs
    ) {
      io.removeItem(payloadKey);
      continue;
    }

    nextEntries.push(entry);
  }

  if (nextEntries.length === manifest.entries.length) return;

  writeManifest(
    manifestKey,
    { version: METADATA_VERSION, entries: nextEntries },
    io,
  );
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

  const { manifestKeys, protectedKeys } = runGlobalSweep
    ? collectManagedLocalStorageSweepTargets(io)
    : {
        manifestKeys: [...forcedManifestKeys],
        protectedKeys: collectProtectedKeysFromStorage(io.listKeys(), io),
      };
  const invokedCallbacks = new Set<() => Promise<void>>();

  for (const manifestKey of manifestKeys) {
    runGenericCleanupForManifest(manifestKey, protectedKeys, io);

    const callback = maintenanceCallbacks.get(manifestKey);
    if (!callback || invokedCallbacks.has(callback)) continue;

    invokedCallbacks.add(callback);
    await callback();
  }

  if (runGlobalSweep) {
    writeGlobalMaintenanceState(
      { version: METADATA_VERSION, lastCleanupAt: Date.now() },
      io,
    );
  }
}

export function resetManagedLocalStorageState(): void {
  maintenanceCallbacks.clear();
  managedLocalStorageRuntimeConfig = {
    ...defaultManagedLocalStorageRuntimeConfig,
  };
}
