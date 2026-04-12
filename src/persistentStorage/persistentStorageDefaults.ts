import type { AsyncStorageNamespaceKind, StorageAdapter } from './types';

export const defaultMaxBytes = {
  localSync: {
    collection: 64 * 1024,
    listItem: 64 * 1024,
    listQuery: 32 * 1024,
  },
  async: { collection: 128 * 1024, listItem: 128 * 1024, listQuery: 64 * 1024 },
} as const;

export type DefaultMaxBytesProfile = keyof typeof defaultMaxBytes;

function getDefaultMaxBytesProfile(
  adapter: StorageAdapter | DefaultMaxBytesProfile,
): DefaultMaxBytesProfile {
  return adapter === 'local-sync' || adapter === 'localSync'
    ? 'localSync'
    : 'async';
}

export type DefaultMaxBytesKind = keyof (typeof defaultMaxBytes)['localSync'];

export function getDefaultMaxBytesKindForScope(
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

export function getDefaultMaxBytesForAdapter(args: {
  adapter: StorageAdapter | DefaultMaxBytesProfile;
  kind: DefaultMaxBytesKind;
}): number {
  return defaultMaxBytes[getDefaultMaxBytesProfile(args.adapter)][args.kind];
}

export function getDefaultMaxBytesForScope(args: {
  adapter: StorageAdapter | DefaultMaxBytesProfile;
  scopeKind: Extract<
    AsyncStorageNamespaceKind,
    'collection.item' | 'listQuery.item' | 'listQuery.query'
  >;
}): number {
  return getDefaultMaxBytesForAdapter({
    adapter: args.adapter,
    kind: getDefaultMaxBytesKindForScope(args.scopeKind),
  });
}
