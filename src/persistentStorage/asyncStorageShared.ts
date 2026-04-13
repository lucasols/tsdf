import { rc_parse_json, rc_string, rc_tuple } from 'runcheck';
import type {
  AsyncStorageEntryMetadata,
  AsyncStorageMetadataOrder,
  AsyncStorageNamespaceKind,
  AsyncStorageNamespaceScope,
  AsyncStorageNamespaceStaticPolicy,
  AsyncStorageProtectedEntryRef,
} from './types';

export const PAYLOAD_RECORD_PREFIX = '__tsdf_payload__:';
export const ASYNC_NAMESPACE_INDEX_RECORD_KEY = '_i';

export function getNamespaceId(scope: AsyncStorageNamespaceScope): string {
  return JSON.stringify([scope.sessionKey, scope.storeName, scope.kind]);
}

type PersistedAsyncNamespaceKindAlias =
  | 'd'
  | 'ci'
  | 'li'
  | 'lq'
  | 'oq'
  | 'oc'
  | 'oe'
  | 'ip';

export function encodePersistedAsyncNamespaceKind(
  kind: AsyncStorageNamespaceKind,
): PersistedAsyncNamespaceKindAlias {
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

export function parsePersistedAsyncNamespaceKind(
  value: string,
): AsyncStorageNamespaceKind | null {
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

export function getPersistedNamespaceId(
  scope: AsyncStorageNamespaceScope,
): string {
  return JSON.stringify([
    scope.sessionKey,
    scope.storeName,
    encodePersistedAsyncNamespaceKind(scope.kind),
  ]);
}

export function getPayloadRecordKey(key: string): string {
  return `${PAYLOAD_RECORD_PREFIX}${key}`;
}

export function serializeProtectedRef(
  ref: AsyncStorageProtectedEntryRef,
): string {
  return JSON.stringify([
    ref.sessionKey,
    ref.storeName,
    encodePersistedAsyncNamespaceKind(ref.kind),
    ref.key,
  ]);
}

export function parseProtectedRef(
  value: string,
): AsyncStorageProtectedEntryRef | null {
  const parsed = rc_parse_json(
    value,
    rc_tuple([rc_string, rc_string, rc_string, rc_string]),
  ).unwrapOrNull();
  if (parsed === null) return null;

  const [sessionKey, storeName, rawKind, key] = parsed;
  const kind = parsePersistedAsyncNamespaceKind(rawKind);
  if (kind === null) return null;

  return { sessionKey, storeName, kind, key };
}

export function parseAsyncStorageRecordKey(
  key: string,
):
  | { recordKind: 'payload'; userKey: string }
  | { rawKey: string; recordKind: 'raw' } {
  if (key.startsWith(PAYLOAD_RECORD_PREFIX)) {
    return {
      recordKind: 'payload',
      userKey: key.slice(PAYLOAD_RECORD_PREFIX.length),
    };
  }

  return { rawKey: key, recordKind: 'raw' };
}

export function normalizeStaticPolicy(
  policy: AsyncStorageNamespaceStaticPolicy | null | undefined,
): AsyncStorageNamespaceStaticPolicy | null {
  if (policy === undefined || policy === null) return null;

  const maxBytes =
    typeof policy.maxBytes === 'number' &&
    Number.isInteger(policy.maxBytes) &&
    policy.maxBytes >= 0
      ? policy.maxBytes
      : undefined;
  const pinnedKeys = Array.isArray(policy.pinnedKeys)
    ? [...new Set(policy.pinnedKeys)].sort((left, right) =>
        left.localeCompare(right),
      )
    : [];

  if (maxBytes === undefined && pinnedKeys.length === 0) {
    return null;
  }

  return {
    ...(maxBytes !== undefined ? { maxBytes } : {}),
    ...(pinnedKeys.length > 0 ? { pinnedKeys } : {}),
  };
}

export function compareMetadata(
  left: AsyncStorageEntryMetadata<Record<string, unknown>>,
  right: AsyncStorageEntryMetadata<Record<string, unknown>>,
  order: AsyncStorageMetadataOrder,
): number {
  if (order === 'key') {
    return left.key.localeCompare(right.key);
  }

  if (left.lastAccessAt !== right.lastAccessAt) {
    return order === 'lru-asc'
      ? left.lastAccessAt - right.lastAccessAt
      : right.lastAccessAt - left.lastAccessAt;
  }

  return left.key.localeCompare(right.key);
}
