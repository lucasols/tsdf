import { describe, expect, test } from 'vitest';
import {
  encodePersistedAsyncNamespaceKind,
  parsePersistedAsyncNamespaceKind,
  parseProtectedRef,
  serializeProtectedRef,
} from '../../src/persistentStorage/asyncStorageShared';
import { parseAsyncStorageNamespaceKind } from '../../src/persistentStorage/types';

describe('async storage shared persisted kind codec', () => {
  test('round-trips every persisted async namespace kind alias', () => {
    expect({
      ci: parsePersistedAsyncNamespaceKind('ci'),
      d: parsePersistedAsyncNamespaceKind('d'),
      ip: parsePersistedAsyncNamespaceKind('ip'),
      li: parsePersistedAsyncNamespaceKind('li'),
      lq: parsePersistedAsyncNamespaceKind('lq'),
      oc: parsePersistedAsyncNamespaceKind('oc'),
      oe: parsePersistedAsyncNamespaceKind('oe'),
      oq: parsePersistedAsyncNamespaceKind('oq'),
    }).toMatchInlineSnapshot(`
      ci: 'collection.item'
      d: 'document'
      ip: '__internal.protected'
      li: 'listQuery.item'
      lq: 'listQuery.query'
      oc: 'offline.conflict'
      oe: 'offline.entity'
      oq: 'offline.queue'
    `);
    expect({
      internalProtected: encodePersistedAsyncNamespaceKind(
        '__internal.protected',
      ),
      offlineConflict: encodePersistedAsyncNamespaceKind('offline.conflict'),
      offlineEntity: encodePersistedAsyncNamespaceKind('offline.entity'),
      offlineQueue: encodePersistedAsyncNamespaceKind('offline.queue'),
      collectionItem: encodePersistedAsyncNamespaceKind('collection.item'),
      document: encodePersistedAsyncNamespaceKind('document'),
      listQueryItem: encodePersistedAsyncNamespaceKind('listQuery.item'),
      listQueryQuery: encodePersistedAsyncNamespaceKind('listQuery.query'),
    }).toMatchInlineSnapshot(`
      collectionItem: 'ci'
      document: 'd'
      internalProtected: 'ip'
      listQueryItem: 'li'
      listQueryQuery: 'lq'
      offlineConflict: 'oc'
      offlineEntity: 'oe'
      offlineQueue: 'oq'
    `);
  });

  test('protected refs persist compact kind aliases while runtime parsing stays semantic-only', () => {
    const serialized = serializeProtectedRef({
      key: 'users||1',
      kind: 'listQuery.item',
      sessionKey: 'sess1',
      storeName: 'users',
    });

    expect(serialized).toBe('["sess1","users","li","users||1"]');
    expect(parseProtectedRef(serialized)).toMatchInlineSnapshot(`
      key: 'users||1'
      kind: 'listQuery.item'
      sessionKey: 'sess1'
      storeName: 'users'
    `);
    expect(parseAsyncStorageNamespaceKind('li')).toBeNull();
  });
});
