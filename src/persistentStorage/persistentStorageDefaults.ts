import type { AsyncStorageNamespaceKind, StorageAdapter } from './types';

type DefaultMaxBytesProfile = 'localSync' | 'async';
type DefaultMaxBytesKind = 'collection' | 'listItem' | 'listQuery';

const defaultMaxBytes: Record<
  DefaultMaxBytesProfile,
  Record<DefaultMaxBytesKind, number>
> = {
  localSync: {
    collection: 64 * 1024,
    listItem: 64 * 1024,
    listQuery: 32 * 1024,
  },
  async: { collection: 128 * 1024, listItem: 128 * 1024, listQuery: 64 * 1024 },
};

function getDefaultMaxBytesProfile(
  adapter: StorageAdapter | DefaultMaxBytesProfile,
): DefaultMaxBytesProfile {
  return adapter === 'local-sync' || adapter === 'localSync'
    ? 'localSync'
    : 'async';
}

function getDefaultMaxBytesKindForScope(
  scopeKind: Extract<
    AsyncStorageNamespaceKind,
    'collection.item' | 'listQuery.item' | 'listQuery.query'
  >,
): DefaultMaxBytesKind {
  switch (scopeKind) {
    case 'collection.item':
      return 'collection';
    case 'listQuery.item':
      return 'listItem';
    case 'listQuery.query':
      return 'listQuery';
  }
}

function getDefaultMaxBytesForAdapter(
  adapter: StorageAdapter | DefaultMaxBytesProfile,
  kind: DefaultMaxBytesKind,
): number {
  return defaultMaxBytes[getDefaultMaxBytesProfile(adapter)][kind];
}

export function getDefaultMaxBytesForScope(
  adapter: StorageAdapter | DefaultMaxBytesProfile,
  scopeKind: Extract<
    AsyncStorageNamespaceKind,
    'collection.item' | 'listQuery.item' | 'listQuery.query'
  >,
): number {
  return getDefaultMaxBytesForAdapter(
    adapter,
    getDefaultMaxBytesKindForScope(scopeKind),
  );
}
