/* eslint-disable @typescript-eslint/consistent-type-assertions, @typescript-eslint/require-await, @ls-stack/use-top-level-regex -- test helper intentionally optimizes for compact fixture code. */
import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { createAsyncStorageAdapter } from '../../src/persistentStorage/asyncStorageAdapter';
import type {
  AsyncStorageAdapter,
  AsyncStorageDriver,
  AsyncStorageNamespaceScope,
  PersistedCollectionItemData,
  PersistedDocumentData,
  PersistedListQueryData,
  PersistedListQueryItemData,
  StorageCacheEntry,
} from '../../src/persistentStorage/types';

const PAYLOAD_RECORD_PREFIX = '__tsdf_payload__:';
const METADATA_RECORD_PREFIX = '__tsdf_meta__:';
const INTERNAL_REGISTRY_KEY = 'registry';
const INTERNAL_ASYNC_SCOPE: AsyncStorageNamespaceScope = {
  sessionKey: '__tsdf_async__',
  storeName: '__tsdf_async__',
  kind: '__internal.protected',
};

type MockOpfsStorageAdapterOptions = {
  readDelayMs?: number;
  storeName?: string;
  sessionKey?: string;
  initialState?: {
    document?: { data: unknown; timestamp?: number; version?: number };
    collection?: Array<{
      payload: string;
      data: unknown;
      timestamp?: number;
      version?: number;
    }>;
    listQuery?: {
      items?: Array<{
        tableId: string;
        id: number | string;
        data: unknown;
        timestamp?: number;
        version?: number;
      }>;
      queries?: Array<{
        params: unknown;
        items: Array<{ tableId: string; id: number | string }>;
        hasMore?: boolean;
        timestamp?: number;
        version?: number;
      }>;
    };
    rawEntries?: Record<string, unknown>;
  };
};

type RecordKind = 'payload' | 'metadata' | 'internal';

type InstrumentedRecord = {
  key: string;
  logicalKey: string | null;
  recordKind: RecordKind;
};

export type MockOpfsOperation =
  | {
      type: 'get';
      exists: boolean;
      record: InstrumentedRecord;
      scope: AsyncStorageNamespaceScope;
    }
  | {
      type: 'getMany';
      hitCount: number;
      records: InstrumentedRecord[];
      scope: AsyncStorageNamespaceScope;
    }
  | {
      type: 'set';
      record: InstrumentedRecord;
      scope: AsyncStorageNamespaceScope;
    }
  | {
      type: 'setMany';
      records: InstrumentedRecord[];
      scope: AsyncStorageNamespaceScope;
    }
  | {
      type: 'remove';
      record: InstrumentedRecord;
      scope: AsyncStorageNamespaceScope;
    }
  | {
      type: 'removeMany';
      records: InstrumentedRecord[];
      scope: AsyncStorageNamespaceScope;
    }
  | { type: 'listKeys'; keys: string[]; scope: AsyncStorageNamespaceScope }
  | { type: 'clear'; removedKeys: string[]; scope: AsyncStorageNamespaceScope };

type MockStorageEntry = { value: unknown };

function getNamespaceId(scope: AsyncStorageNamespaceScope): string {
  return JSON.stringify([scope.sessionKey, scope.storeName, scope.kind]);
}

function getPayloadRecordKey(key: string): string {
  return `${PAYLOAD_RECORD_PREFIX}${key}`;
}

function getMetadataRecordKey(key: string): string {
  return `${METADATA_RECORD_PREFIX}${key}`;
}

function getRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  return __LEGIT_CAST__<Record<string, unknown>, unknown>(value);
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function itemKey(payload: string): string {
  return getCompositeKey(payload);
}

function listQueryItemKey(tableId: string, id: number | string): string {
  return getCompositeKey(`${tableId}||${id}`);
}

function listQueryQueryKey(params: unknown): string {
  return getCompositeKey(params);
}

function getLogicalStorageKey(
  scope: AsyncStorageNamespaceScope,
  key: string,
): string {
  switch (scope.kind) {
    case 'document':
      return scope.storeName === '__offline__'
        ? `tsdf.${scope.sessionKey}.__offline__.session`
        : `tsdf.${scope.sessionKey}.${scope.storeName}`;
    case 'collection.item':
      return `tsdf.${scope.sessionKey}.${scope.storeName}.ci.${key}`;
    case 'listQuery.item':
      return `tsdf.${scope.sessionKey}.${scope.storeName}.li.${key}`;
    case 'listQuery.query':
      return `tsdf.${scope.sessionKey}.${scope.storeName}.lq.${key}`;
    case 'offline.queue':
      return `tsdf.${scope.sessionKey}.${scope.storeName}.oq.${key}`;
    case 'offline.conflict':
      return `tsdf.${scope.sessionKey}.${scope.storeName}.oc.${key}`;
    case 'offline.entity':
      return `tsdf.${scope.sessionKey}.${scope.storeName}.oe.${key}`;
    case '__internal.protected':
      return `tsdf.${scope.sessionKey}._o_.p`;
  }
}

type ParsedFlatKey = { scope: AsyncStorageNamespaceScope; key: string };

function parseFlatStorageKey(key: string): ParsedFlatKey | null {
  let match =
    /^tsdf\.([^.]+)\.(.+?)\.ci\.(.+)$/.exec(key) ??
    /^tsdf\.([^.]+)\.(.+?)\.li\.(.+)$/.exec(key) ??
    /^tsdf\.([^.]+)\.(.+?)\.lq\.(.+)$/.exec(key) ??
    /^tsdf\.([^.]+)\.(.+?)\.oq\.(.+)$/.exec(key) ??
    /^tsdf\.([^.]+)\.(.+?)\.oc\.(.+)$/.exec(key) ??
    /^tsdf\.([^.]+)\.(.+?)\.oe\.(.+)$/.exec(key);

  if (match?.[1] && match[2] && match[3]) {
    const [, sessionKey, storeName, entryKey] = match;
    const suffix = key.includes('.ci.')
      ? 'collection.item'
      : key.includes('.li.')
        ? 'listQuery.item'
        : key.includes('.lq.')
          ? 'listQuery.query'
          : key.includes('.oq.')
            ? 'offline.queue'
            : key.includes('.oc.')
              ? 'offline.conflict'
              : 'offline.entity';

    return {
      scope: {
        sessionKey,
        storeName,
        kind: __LEGIT_CAST__<AsyncStorageNamespaceScope['kind'], string>(
          suffix,
        ),
      },
      key: entryKey,
    };
  }

  match = /^tsdf\.([^.]+)\._o_\.p$/.exec(key);
  if (match?.[1]) {
    return {
      scope: { sessionKey: match[1], storeName: '_o_.p', kind: 'document' },
      key: 'document',
    };
  }

  match = /^tsdf\.([^.]+)\.__offline__\.session$/.exec(key);
  if (match?.[1]) {
    return {
      scope: {
        sessionKey: match[1],
        storeName: '__offline__',
        kind: 'document',
      },
      key: 'session',
    };
  }

  match = /^tsdf\.([^.]+)\.(.+)$/.exec(key);
  if (match?.[1] && match[2]) {
    return {
      scope: { sessionKey: match[1], storeName: match[2], kind: 'document' },
      key: 'document',
    };
  }

  return null;
}

type LogicalRecordLocation = {
  metadataRecordKey: string;
  payloadRecordKey: string;
  scope: AsyncStorageNamespaceScope;
};

function getLogicalRecordLocation(key: string): LogicalRecordLocation | null {
  const parsed = parseFlatStorageKey(key);
  if (parsed === null) return null;

  return {
    scope: parsed.scope,
    payloadRecordKey: getPayloadRecordKey(parsed.key),
    metadataRecordKey: getMetadataRecordKey(parsed.key),
  };
}

function buildCustomMetadata(
  scope: AsyncStorageNamespaceScope,
  data: unknown,
): Record<string, unknown> {
  const record = getRecord(data);
  if (record === null) return {};

  switch (scope.kind) {
    case 'collection.item':
    case 'listQuery.item':
      return typeof record.payload === 'string'
        ? { p: record.payload }
        : typeof record.p === 'string'
          ? { p: record.p }
          : {};
    case 'listQuery.query':
      return {
        ...(typeof record.payload === 'object' ||
        typeof record.payload === 'string'
          ? { p: record.payload }
          : 'p' in record
            ? { p: record.p }
            : {}),
        ...(Array.isArray(record.items)
          ? { i: record.items }
          : Array.isArray(record.i)
            ? { i: record.i }
            : {}),
        ...(record.hasMore === true || record.h === true ? { h: true } : {}),
      };
    default:
      return {};
  }
}

function createManagedMetadataRecord(
  scope: AsyncStorageNamespaceScope,
  key: string,
  entry: StorageCacheEntry<unknown>,
): Record<string, unknown> {
  const raw = safeStringify(entry.data);
  return {
    key,
    writtenAt: entry.timestamp,
    lastAccessAt: entry.timestamp,
    version: entry.version ?? 1,
    ...(raw !== null ? { sizeBytes: raw.length } : {}),
    customMetadata: buildCustomMetadata(scope, entry.data),
  };
}

function normalizeLogicalPayload(
  scope: AsyncStorageNamespaceScope,
  value: unknown,
): unknown {
  const record = getRecord(value);
  if (record === null) return value;

  switch (scope.kind) {
    case 'document':
      return 'd' in record ? { data: record.d } : value;
    case 'collection.item':
      return 'd' in record && 'p' in record
        ? { data: record.d, payload: record.p }
        : value;
    case 'listQuery.item':
      return 'd' in record && 'p' in record
        ? {
            data: record.d,
            payload: record.p,
            ...('lf' in record && Array.isArray(record.lf)
              ? { loadedFields: record.lf }
              : {}),
          }
        : value;
    case 'listQuery.query':
      return 'p' in record && 'i' in record && Array.isArray(record.i)
        ? { payload: record.p, items: record.i, hasMore: record.h === true }
        : value;
    default:
      return value;
  }
}

function parseManagedMetadataRecord(
  value: unknown,
): {
  customMetadata: Record<string, unknown>;
  key: string;
  lastAccessAt: number;
  sizeBytes?: number;
  version: number;
  writtenAt: number;
} | null {
  const record = getRecord(value);
  if (
    record === null ||
    typeof record.key !== 'string' ||
    typeof record.writtenAt !== 'number' ||
    typeof record.lastAccessAt !== 'number' ||
    typeof record.version !== 'number'
  ) {
    return null;
  }

  return {
    key: record.key,
    writtenAt: record.writtenAt,
    lastAccessAt: record.lastAccessAt,
    version: record.version,
    ...(typeof record.sizeBytes === 'number'
      ? { sizeBytes: record.sizeBytes }
      : {}),
    customMetadata: getRecord(record.customMetadata) ?? {},
  };
}

function createStorageCacheEntry<T>(
  data: T,
  options: { timestamp?: number; version?: number } = {},
): StorageCacheEntry<T> {
  return {
    data,
    timestamp: options.timestamp ?? Date.now(),
    version: options.version ?? 1,
  };
}

export function createMockOpfsStorageAdapter(
  options: MockOpfsStorageAdapterOptions = {},
): {
  adapter: AsyncStorageAdapter;
  storage: {
    getRaw: (key: string) => string | null;
    has: (key: string) => boolean;
    readEntry: <T>(key: string) => StorageCacheEntry<T> | null;
    readMetadata: (
      key: string,
    ) => {
      customMetadata: Record<string, unknown>;
      key: string;
      lastAccessAt: number;
      sizeBytes?: number;
      version: number;
      writtenAt: number;
    } | null;
    writeRaw: (key: string, raw: string) => void;
    writeValue: <T>(key: string, value: T) => void;
    writePayload: (key: string, value: unknown) => void;
    writeMetadata: (key: string, value: unknown) => void;
    removePayload: (key: string) => void;
    removeMetadata: (key: string) => void;
  };
  scope?: never;
  payloadGetRequests: string[];
  payloadGetManyRequests: string[][];
  listKeysRequests: AsyncStorageNamespaceScope[];
  legacyListKeysFallbackRequests: string[];
  operations: MockOpfsOperation[];
  scopeReadRequests: () => string[];
  clearReadRequests: () => void;
  clearInstrumentation: () => void;
  getRaw: (key: string) => string | null;
  has: (key: string) => boolean;
  registerNamespace: (scope: AsyncStorageNamespaceScope) => void;
  setRaw: (key: string, raw: string) => void;
  setValue: <T>(key: string, value: T) => void;
  setPayload: (key: string, value: unknown) => void;
  setMetadata: (key: string, value: unknown) => void;
  readMetadata: (
    key: string,
  ) => {
    customMetadata: Record<string, unknown>;
    key: string;
    lastAccessAt: number;
    sizeBytes?: number;
    version: number;
    writtenAt: number;
  } | null;
  removePayload: (key: string) => void;
  removeMetadata: (key: string) => void;
  rawNamespace: {
    get: (scope: AsyncStorageNamespaceScope, key: string) => unknown;
    listKeys: (scope: AsyncStorageNamespaceScope) => string[];
    remove: (scope: AsyncStorageNamespaceScope, key: string) => void;
    set: (
      scope: AsyncStorageNamespaceScope,
      key: string,
      value: unknown,
    ) => void;
  };
  document: { storageKey: () => string; readData: <T>() => T | null };
  collection: {
    itemStorageKey: (payload: string) => string;
    readItemData: <T>(payload: string) => T | null;
  };
  listQuery: {
    itemKey: (tableId: string, id: number | string) => string;
    itemStorageKey: (tableId: string, id: number | string) => string;
    queryStorageKey: (params: unknown) => string;
    readItemData: <T>(tableId: string, id: number | string) => T | null;
    readQueryEntry: (
      params: unknown,
    ) => StorageCacheEntry<PersistedListQueryData>;
    seedItem: (tableId: string, id: number | string, data: unknown) => void;
  };
} {
  const namespaceStore = new Map<string, Map<string, MockStorageEntry>>();
  const payloadGetRequests: string[] = [];
  const payloadGetManyRequests: string[][] = [];
  const listKeysRequests: AsyncStorageNamespaceScope[] = [];
  const legacyListKeysFallbackRequests: string[] = [];
  const operations: MockOpfsOperation[] = [];
  const readDelayMs = options.readDelayMs ?? 0;

  function getNamespace(
    scope: AsyncStorageNamespaceScope,
  ): Map<string, MockStorageEntry> {
    const namespaceId = getNamespaceId(scope);
    let namespace = namespaceStore.get(namespaceId);
    if (!namespace) {
      namespace = new Map();
      namespaceStore.set(namespaceId, namespace);
    }
    return namespace;
  }

  function setNamespaceValue(
    scope: AsyncStorageNamespaceScope,
    key: string,
    value: unknown,
  ): void {
    getNamespace(scope).set(key, { value });
  }

  function getNamespaceValue(
    scope: AsyncStorageNamespaceScope,
    key: string,
  ): unknown {
    return getNamespace(scope).get(key)?.value ?? null;
  }

  function removeNamespaceValue(
    scope: AsyncStorageNamespaceScope,
    key: string,
  ): void {
    const namespace = getNamespace(scope);
    namespace.delete(key);
    if (namespace.size === 0) {
      namespaceStore.delete(getNamespaceId(scope));
    }
  }

  function readRegisteredNamespaces(): AsyncStorageNamespaceScope[] {
    const record = getNamespaceValue(
      INTERNAL_ASYNC_SCOPE,
      INTERNAL_REGISTRY_KEY,
    );
    const parsed = getRecord(record);
    if (parsed === null || !Array.isArray(parsed.namespaces)) {
      return [];
    }

    const namespaces: AsyncStorageNamespaceScope[] = [];
    for (const entry of parsed.namespaces) {
      const namespace = getRecord(entry);
      if (
        namespace === null ||
        typeof namespace.sessionKey !== 'string' ||
        typeof namespace.storeName !== 'string' ||
        typeof namespace.kind !== 'string'
      ) {
        continue;
      }

      namespaces.push({
        sessionKey: namespace.sessionKey,
        storeName: namespace.storeName,
        kind: __LEGIT_CAST__<AsyncStorageNamespaceScope['kind'], string>(
          namespace.kind,
        ),
      });
    }

    return namespaces;
  }

  function writeRegisteredNamespaces(
    namespaces: AsyncStorageNamespaceScope[],
  ): void {
    setNamespaceValue(INTERNAL_ASYNC_SCOPE, INTERNAL_REGISTRY_KEY, {
      namespaces,
    });
  }

  function ensureNamespaceRegistered(scope: AsyncStorageNamespaceScope): void {
    if (
      scope.sessionKey === INTERNAL_ASYNC_SCOPE.sessionKey &&
      scope.storeName === INTERNAL_ASYNC_SCOPE.storeName &&
      scope.kind === INTERNAL_ASYNC_SCOPE.kind
    ) {
      return;
    }

    const existing = readRegisteredNamespaces();
    if (
      existing.some(
        (entry) =>
          entry.sessionKey === scope.sessionKey &&
          entry.storeName === scope.storeName &&
          entry.kind === scope.kind,
      )
    ) {
      return;
    }

    writeRegisteredNamespaces([...existing, scope]);
  }

  async function waitForReadDelay(): Promise<void> {
    if (readDelayMs <= 0) return;

    await new Promise<void>((resolve) => {
      setTimeout(resolve, readDelayMs);
    });
  }

  function getInstrumentedRecord(
    scope: AsyncStorageNamespaceScope,
    key: string,
  ): InstrumentedRecord {
    if (key.startsWith(PAYLOAD_RECORD_PREFIX)) {
      const userKey = key.slice(PAYLOAD_RECORD_PREFIX.length);
      return {
        key,
        logicalKey: getLogicalStorageKey(scope, userKey),
        recordKind: 'payload',
      };
    }

    if (key.startsWith(METADATA_RECORD_PREFIX)) {
      const userKey = key.slice(METADATA_RECORD_PREFIX.length);
      return {
        key,
        logicalKey: getLogicalStorageKey(scope, userKey),
        recordKind: 'metadata',
      };
    }

    return { key, logicalKey: null, recordKind: 'internal' };
  }

  const driver: AsyncStorageDriver = {
    async get(scope, key) {
      const namespace = getNamespace(scope);
      const record = getInstrumentedRecord(scope, key);
      if (record.recordKind === 'payload') {
        await waitForReadDelay();
      }
      if (record.recordKind === 'payload' && record.logicalKey !== null) {
        payloadGetRequests.push(record.logicalKey);
      }

      const entry = namespace.get(key);
      operations.push({
        type: 'get',
        scope,
        record,
        exists: entry !== undefined,
      });
      return entry?.value ?? null;
    },
    async set(scope, key, value) {
      const namespace = getNamespace(scope);
      namespace.set(key, { value });
      operations.push({
        type: 'set',
        scope,
        record: getInstrumentedRecord(scope, key),
      });
    },
    async remove(scope, key) {
      const namespace = getNamespace(scope);
      namespace.delete(key);
      if (namespace.size === 0) {
        namespaceStore.delete(getNamespaceId(scope));
      }
      operations.push({
        type: 'remove',
        scope,
        record: getInstrumentedRecord(scope, key),
      });
    },
    async listKeys(scope) {
      const keys = [...getNamespace(scope).keys()].sort(compareStrings);
      listKeysRequests.push(scope);
      operations.push({ type: 'listKeys', scope, keys: [...keys] });
      return keys;
    },
    async clear(scope) {
      const namespace = getNamespace(scope);
      const removedKeys = [...namespace.keys()].sort(compareStrings);
      namespaceStore.delete(getNamespaceId(scope));
      operations.push({ type: 'clear', scope, removedKeys });
    },
    async getMany(scope, keys) {
      const namespace = getNamespace(scope);
      const records = keys.map((key) => getInstrumentedRecord(scope, key));
      if (records.some((record) => record.recordKind === 'payload')) {
        await waitForReadDelay();
      }
      const payloadLogicalKeys = records.flatMap((record) =>
        record.recordKind === 'payload' && record.logicalKey !== null
          ? [record.logicalKey]
          : [],
      );
      if (payloadLogicalKeys.length > 0) {
        payloadGetRequests.push(...payloadLogicalKeys);
        payloadGetManyRequests.push(payloadLogicalKeys);
      }

      const values = keys.map((key) => namespace.get(key)?.value ?? null);
      operations.push({
        type: 'getMany',
        scope,
        records,
        hitCount: values.filter((value) => value !== null).length,
      });
      return values;
    },
    async setMany(scope, entries) {
      const namespace = getNamespace(scope);
      for (const entry of entries) {
        namespace.set(entry.key, { value: entry.value });
      }
      operations.push({
        type: 'setMany',
        scope,
        records: entries.map((entry) =>
          getInstrumentedRecord(scope, entry.key),
        ),
      });
    },
    async removeMany(scope, keys) {
      const namespace = getNamespace(scope);
      for (const key of keys) {
        namespace.delete(key);
      }
      if (namespace.size === 0) {
        namespaceStore.delete(getNamespaceId(scope));
      }
      operations.push({
        type: 'removeMany',
        scope,
        records: keys.map((key) => getInstrumentedRecord(scope, key)),
      });
    },
    resetForTests() {
      namespaceStore.clear();
    },
  };

  const adapter = createAsyncStorageAdapter(driver);

  function writeLogicalStorageEntry(flatKey: string, value: unknown): void {
    const parsed = parseFlatStorageKey(flatKey);
    if (parsed === null) return;

    const entry = __LEGIT_CAST__<StorageCacheEntry<unknown>, unknown>(value);
    getNamespace(parsed.scope).set(getPayloadRecordKey(parsed.key), {
      value: entry.data,
    });
    getNamespace(parsed.scope).set(getMetadataRecordKey(parsed.key), {
      value: createManagedMetadataRecord(parsed.scope, parsed.key, entry),
    });
  }

  function readLogicalStorageEntry<T>(
    flatKey: string,
  ): StorageCacheEntry<T> | null {
    const parsed = parseFlatStorageKey(flatKey);
    if (parsed === null) return null;

    const namespace = getNamespace(parsed.scope);
    const payload = namespace.get(getPayloadRecordKey(parsed.key))?.value;
    const metadata = parseManagedMetadataRecord(
      namespace.get(getMetadataRecordKey(parsed.key))?.value ?? null,
    );
    if (payload === undefined || metadata === null) {
      return null;
    }

    return {
      data: __LEGIT_CAST__<T, unknown>(
        normalizeLogicalPayload(parsed.scope, payload),
      ),
      timestamp: metadata.lastAccessAt,
      version: metadata.version,
    };
  }

  function hasLogicalStorageEntry(flatKey: string): boolean {
    return readLogicalStorageEntry(flatKey) !== null;
  }

  function setValue<T>(key: string, value: T): void {
    writeLogicalStorageEntry(key, value);
  }

  function setPayloadValue(key: string, value: unknown): void {
    const location = getLogicalRecordLocation(key);
    if (location === null) return;

    setNamespaceValue(location.scope, location.payloadRecordKey, value);
  }

  function setMetadataValue(key: string, value: unknown): void {
    const location = getLogicalRecordLocation(key);
    if (location === null) return;

    setNamespaceValue(location.scope, location.metadataRecordKey, value);
  }

  function removePayloadValue(key: string): void {
    const location = getLogicalRecordLocation(key);
    if (location === null) return;

    removeNamespaceValue(location.scope, location.payloadRecordKey);
  }

  function removeMetadataValue(key: string): void {
    const location = getLogicalRecordLocation(key);
    if (location === null) return;

    removeNamespaceValue(location.scope, location.metadataRecordKey);
  }

  function readLogicalMetadata(key: string) {
    const location = getLogicalRecordLocation(key);
    if (location === null) return null;

    return parseManagedMetadataRecord(
      getNamespaceValue(location.scope, location.metadataRecordKey),
    );
  }

  function setRaw(key: string, raw: string): void {
    const parsed = parseJson<unknown>(raw);
    if (parsed !== null) {
      writeLogicalStorageEntry(key, parsed);
    }
  }

  function getRaw(key: string): string | null {
    const value = readLogicalStorageEntry(key);
    return value === null ? null : JSON.stringify(value);
  }

  function seedInitialState(): void {
    const storeName = options.storeName;
    const sessionKey = options.sessionKey;
    if (storeName === undefined || sessionKey === undefined) {
      for (const [key, value] of Object.entries(
        options.initialState?.rawEntries ?? {},
      )) {
        if (typeof value === 'string') {
          setRaw(key, value);
        } else {
          setValue(key, value);
        }
      }
      return;
    }

    const documentKey = `tsdf.${sessionKey}.${storeName}`;
    const documentState = options.initialState?.document;
    if (documentState) {
      setValue(
        documentKey,
        createStorageCacheEntry(
          { d: documentState.data },
          {
            timestamp: documentState.timestamp,
            version: documentState.version,
          },
        ),
      );
    }

    for (const item of options.initialState?.collection ?? []) {
      setValue(
        `tsdf.${sessionKey}.${storeName}.ci.${itemKey(item.payload)}`,
        createStorageCacheEntry(
          { d: item.data, p: item.payload },
          { timestamp: item.timestamp, version: item.version },
        ),
      );
    }

    for (const item of options.initialState?.listQuery?.items ?? []) {
      const payload = listQueryItemKey(item.tableId, item.id);
      setValue(
        `tsdf.${sessionKey}.${storeName}.li.${payload}`,
        createStorageCacheEntry(
          { d: item.data, p: `${item.tableId}||${item.id}` },
          { timestamp: item.timestamp, version: item.version },
        ),
      );
    }

    for (const query of options.initialState?.listQuery?.queries ?? []) {
      setValue(
        `tsdf.${sessionKey}.${storeName}.lq.${listQueryQueryKey(query.params)}`,
        createStorageCacheEntry(
          {
            p: query.params,
            i: query.items.map((item) =>
              listQueryItemKey(item.tableId, item.id),
            ),
            ...(query.hasMore === true ? { h: true } : {}),
          },
          { timestamp: query.timestamp, version: query.version },
        ),
      );
    }

    for (const [key, value] of Object.entries(
      options.initialState?.rawEntries ?? {},
    )) {
      if (typeof value === 'string') {
        setRaw(key, value);
      } else {
        setValue(key, value);
      }
    }
  }

  seedInitialState();
  const scopePrefix =
    options.storeName !== undefined && options.sessionKey !== undefined
      ? `tsdf.${options.sessionKey}.${options.storeName}.`
      : null;

  return {
    adapter,
    storage: {
      getRaw,
      has: hasLogicalStorageEntry,
      readEntry: readLogicalStorageEntry,
      readMetadata: readLogicalMetadata,
      writeRaw: setRaw,
      writeValue: setValue,
      writePayload: setPayloadValue,
      writeMetadata: setMetadataValue,
      removePayload: removePayloadValue,
      removeMetadata: removeMetadataValue,
    },
    payloadGetRequests,
    payloadGetManyRequests,
    listKeysRequests,
    legacyListKeysFallbackRequests,
    operations,
    scopeReadRequests() {
      if (scopePrefix === null) {
        return [...payloadGetRequests];
      }

      return payloadGetRequests.map((key) =>
        key.startsWith(scopePrefix) ? key.slice(scopePrefix.length) : key,
      );
    },
    clearReadRequests() {
      payloadGetRequests.length = 0;
      payloadGetManyRequests.length = 0;
    },
    clearInstrumentation() {
      payloadGetRequests.length = 0;
      payloadGetManyRequests.length = 0;
      listKeysRequests.length = 0;
      legacyListKeysFallbackRequests.length = 0;
      operations.length = 0;
    },
    getRaw,
    has: hasLogicalStorageEntry,
    registerNamespace: ensureNamespaceRegistered,
    setRaw,
    setValue,
    setPayload: setPayloadValue,
    setMetadata: setMetadataValue,
    readMetadata: readLogicalMetadata,
    removePayload: removePayloadValue,
    removeMetadata: removeMetadataValue,
    rawNamespace: {
      get: getNamespaceValue,
      listKeys(scope) {
        return [...getNamespace(scope).keys()].sort(compareStrings);
      },
      remove: removeNamespaceValue,
      set: setNamespaceValue,
    },
    document: {
      storageKey() {
        const storeName = options.storeName ?? 'store';
        const sessionKey = options.sessionKey ?? 'session';
        return `tsdf.${sessionKey}.${storeName}`;
      },
      readData<T>() {
        return (
          readLogicalStorageEntry<PersistedDocumentData<T>>(
            `tsdf.${options.sessionKey ?? 'session'}.${options.storeName ?? 'store'}`,
          )?.data.data ?? null
        );
      },
    },
    collection: {
      itemStorageKey(payload: string) {
        const storeName = options.storeName ?? 'store';
        const sessionKey = options.sessionKey ?? 'session';
        return `tsdf.${sessionKey}.${storeName}.ci.${itemKey(payload)}`;
      },
      readItemData<T>(payload: string) {
        return (
          readLogicalStorageEntry<PersistedCollectionItemData<T>>(
            `tsdf.${options.sessionKey ?? 'session'}.${options.storeName ?? 'store'}.ci.${itemKey(
              payload,
            )}`,
          )?.data.data ?? null
        );
      },
    },
    listQuery: {
      itemKey: listQueryItemKey,
      itemStorageKey(tableId: string, id: number | string) {
        const storeName = options.storeName ?? 'store';
        const sessionKey = options.sessionKey ?? 'session';
        return `tsdf.${sessionKey}.${storeName}.li.${listQueryItemKey(tableId, id)}`;
      },
      queryStorageKey(params: unknown) {
        const storeName = options.storeName ?? 'store';
        const sessionKey = options.sessionKey ?? 'session';
        return `tsdf.${sessionKey}.${storeName}.lq.${listQueryQueryKey(params)}`;
      },
      readItemData<T>(tableId: string, id: number | string) {
        return (
          readLogicalStorageEntry<PersistedListQueryItemData<T>>(
            `tsdf.${options.sessionKey ?? 'session'}.${options.storeName ?? 'store'}.li.${listQueryItemKey(
              tableId,
              id,
            )}`,
          )?.data.data ?? null
        );
      },
      readQueryEntry(params: unknown) {
        const entry = readLogicalStorageEntry<PersistedListQueryData>(
          `tsdf.${options.sessionKey ?? 'session'}.${options.storeName ?? 'store'}.lq.${listQueryQueryKey(
            params,
          )}`,
        );
        if (entry === null) {
          throw new Error('Expected persisted query entry to exist.');
        }
        return entry;
      },
      seedItem(tableId: string, id: number | string, data: unknown) {
        setValue(
          `tsdf.${options.sessionKey ?? 'session'}.${options.storeName ?? 'store'}.li.${listQueryItemKey(
            tableId,
            id,
          )}`,
          createStorageCacheEntry({ d: data, p: `${tableId}||${id}` }),
        );
      },
    },
  };
}
