import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { murmur3 } from '@ls-stack/utils/hash';
import { isObject } from '@ls-stack/utils/typeGuards';
import {
  getNamespaceId as getNamespaceIdInternal,
  getPayloadRecordKey as getPayloadRecordKeyInternal,
  parseAsyncStorageRecordKey,
} from './asyncStorageShared';
import type { AsyncStorageNamespaceScope } from './types';

export const ASYNC_NAMESPACE_INDEX_RECORD_KEY = '_i';
export const PAYLOAD_RECORD_PREFIX = '__tsdf_payload__:';

export function getNamespaceId(scope: AsyncStorageNamespaceScope): string {
  return getNamespaceIdInternal(scope);
}

export function getPayloadRecordKey(key: string): string {
  return getPayloadRecordKeyInternal(key);
}

export const OPFS_ROOT_DIR = 'tsdf';
export const JSON_FILE_EXTENSION = '.json';

const OPFS_SINGLETON_ENTRY_TOKEN = 'e';
const HASHED_PAYLOAD_ENTRY_TOKEN_PREFIX = 'h~';

function shouldHashPayloadRecordForKind(
  kind: AsyncStorageNamespaceScope['kind'],
): boolean {
  switch (kind) {
    case 'collection.item':
    case 'listQuery.item':
    case 'listQuery.query':
      return true;
    default:
      return false;
  }
}

export function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

export function decodePathSegment(value: string): string {
  return decodeURIComponent(value);
}

export function encodeFileNameSegment(value: string): string {
  return encodePathSegment(value).replaceAll('.', '%2E');
}

export function joinPath(...segments: string[]): string {
  return segments.filter((segment) => segment.length > 0).join('/');
}

export function getFileNameKindAlias(
  kind: AsyncStorageNamespaceScope['kind'],
): string {
  switch (kind) {
    case 'document':
      return 'd';
    case 'collection.item':
      return 'ci';
    case 'listQuery.item':
      return 'li';
    case 'listQuery.query':
      return 'lq';
    case 'offline.queue':
      return 'oq';
    case 'offline.conflict':
      return 'oc';
    case 'offline.entity':
      return 'oe';
    case '__internal.protected':
      return 'ip';
  }
}

export function parseFileNameKindAlias(
  value: string,
): AsyncStorageNamespaceScope['kind'] | null {
  switch (value) {
    case 'd':
      return 'document';
    case 'ci':
      return 'collection.item';
    case 'li':
      return 'listQuery.item';
    case 'lq':
      return 'listQuery.query';
    case 'oq':
      return 'offline.queue';
    case 'oc':
      return 'offline.conflict';
    case 'oe':
      return 'offline.entity';
    case 'ip':
      return '__internal.protected';
    default:
      return null;
  }
}

export type OpfsRecordKind = 'payload' | 'raw';

export function getRecordKindAlias(kind: OpfsRecordKind): string {
  switch (kind) {
    case 'payload':
      return 'p';
    case 'raw':
      return 'r';
  }
}

export function parseRecordKindAlias(value: string): OpfsRecordKind | null {
  switch (value) {
    case 'p':
      return 'payload';
    case 'r':
      return 'raw';
    default:
      return null;
  }
}

export function getEntryToken(
  scope: AsyncStorageNamespaceScope,
  userKey: string,
): string {
  if (scope.kind === 'document' && userKey === 'document') {
    return OPFS_SINGLETON_ENTRY_TOKEN;
  }

  return encodeFileNameSegment(userKey);
}

export function parseEntryToken(
  scopeKind: AsyncStorageNamespaceScope['kind'],
  token: string,
): string {
  if (scopeKind === 'document' && token === OPFS_SINGLETON_ENTRY_TOKEN) {
    return 'document';
  }

  return decodePathSegment(token);
}

export function parseRecordKey(
  key: string,
):
  | { recordKind: 'payload'; userKey: string }
  | { rawKey: string; recordKind: 'raw' } {
  return parseAsyncStorageRecordKey(key);
}

export function toRecordKey(
  recordKind: OpfsRecordKind,
  userKey: string,
): string {
  switch (recordKind) {
    case 'payload':
      return getPayloadRecordKey(userKey);
    case 'raw':
      return userKey;
  }
}

export function buildFileName(
  scope: AsyncStorageNamespaceScope,
  key: string,
): string {
  const parsedRecordKey = parseRecordKey(key);
  const kindAlias = getFileNameKindAlias(scope.kind);

  if (parsedRecordKey.recordKind === 'raw') {
    return (
      [
        kindAlias,
        encodeFileNameSegment(parsedRecordKey.rawKey),
        getRecordKindAlias('raw'),
      ].join('.') + JSON_FILE_EXTENSION
    );
  }

  const entryToken = shouldHashPayloadRecordForKind(scope.kind)
    ? `${HASHED_PAYLOAD_ENTRY_TOKEN_PREFIX}${murmur3(key, 'uint32')}`
    : getEntryToken(scope, parsedRecordKey.userKey);

  return (
    [kindAlias, entryToken, getRecordKindAlias('payload')].join('.') +
    JSON_FILE_EXTENSION
  );
}

export function resolveHashedPayloadRecordKeyFromValue(
  scope: AsyncStorageNamespaceScope,
  value: unknown,
): string | null {
  if (!shouldHashPayloadRecordForKind(scope.kind)) return null;

  if (!isObject(value)) return null;

  const record = value;
  if (!('p' in record)) return null;

  switch (scope.kind) {
    case 'collection.item':
    case 'listQuery.item':
    case 'listQuery.query':
      return getPayloadRecordKey(getCompositeKey(record.p));
    default:
      return null;
  }
}

export type ParsedOpfsFileName = {
  isHashedPayload: boolean;
  key: string | null;
  kind: AsyncStorageNamespaceScope['kind'];
};

export function parseFileNameInfo(fileName: string): ParsedOpfsFileName | null {
  if (!fileName.endsWith(JSON_FILE_EXTENSION)) return null;

  const encoded = fileName.slice(0, -JSON_FILE_EXTENSION.length);
  const parts = encoded.split('.');
  if (parts.length !== 3) return null;

  const kindPart = parts[0] ?? '';
  const entryPart = parts[1] ?? '';
  const recordPart = parts[2] ?? '';

  const kind = parseFileNameKindAlias(kindPart);
  if (kind === null) return null;

  const recordKind = parseRecordKindAlias(recordPart);
  if (recordKind === null) return null;

  if (
    recordKind === 'payload' &&
    shouldHashPayloadRecordForKind(kind) &&
    entryPart.startsWith(HASHED_PAYLOAD_ENTRY_TOKEN_PREFIX)
  ) {
    return { kind, key: null, isHashedPayload: true };
  }

  return {
    kind,
    key:
      recordKind === 'raw'
        ? decodePathSegment(entryPart)
        : toRecordKey(recordKind, parseEntryToken(kind, entryPart)),
    isHashedPayload: false,
  };
}
