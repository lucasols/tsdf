import type { AsyncStorageNamespaceScope } from './types';

export const OPFS_ROOT_DIR = 'tsdf';
export const JSON_FILE_EXTENSION = '.json';
export const PAYLOAD_RECORD_PREFIX = '__tsdf_payload__:';
export const METADATA_RECORD_PREFIX = '__tsdf_meta__:';

const OPFS_SINGLETON_ENTRY_TOKEN = 'e';

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

export function getPayloadRecordKey(key: string): string {
  return `${PAYLOAD_RECORD_PREFIX}${key}`;
}

export function getMetadataRecordKey(key: string): string {
  return `${METADATA_RECORD_PREFIX}${key}`;
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

export type OpfsRecordKind = 'metadata' | 'payload' | 'raw';

export function getRecordKindAlias(kind: OpfsRecordKind): string {
  switch (kind) {
    case 'payload':
      return 'p';
    case 'metadata':
      return 'm';
    case 'raw':
      return 'r';
  }
}

export function parseRecordKindAlias(value: string): OpfsRecordKind | null {
  switch (value) {
    case 'p':
      return 'payload';
    case 'm':
      return 'metadata';
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
  | { recordKind: 'payload' | 'metadata'; userKey: string }
  | { rawKey: string; recordKind: 'raw' } {
  if (key.startsWith(PAYLOAD_RECORD_PREFIX)) {
    return {
      recordKind: 'payload',
      userKey: key.slice(PAYLOAD_RECORD_PREFIX.length),
    };
  }

  if (key.startsWith(METADATA_RECORD_PREFIX)) {
    return {
      recordKind: 'metadata',
      userKey: key.slice(METADATA_RECORD_PREFIX.length),
    };
  }

  return { rawKey: key, recordKind: 'raw' };
}

export function toRecordKey(
  recordKind: OpfsRecordKind,
  userKey: string,
): string {
  switch (recordKind) {
    case 'payload':
      return getPayloadRecordKey(userKey);
    case 'metadata':
      return getMetadataRecordKey(userKey);
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

  return (
    [
      kindAlias,
      getEntryToken(scope, parsedRecordKey.userKey),
      getRecordKindAlias(parsedRecordKey.recordKind),
    ].join('.') + JSON_FILE_EXTENSION
  );
}

export function parseFileName(
  fileName: string,
): { key: string; kind: AsyncStorageNamespaceScope['kind'] } | null {
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

  return {
    kind,
    key:
      recordKind === 'raw'
        ? decodePathSegment(entryPart)
        : toRecordKey(recordKind, parseEntryToken(kind, entryPart)),
  };
}
