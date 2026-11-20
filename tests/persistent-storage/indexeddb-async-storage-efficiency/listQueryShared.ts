import {
  getIndexedDbNamespaceSnapshot,
  getIndexedDbPayloadSnapshot,
} from '../../utils/indexedDbPersistentStorageOptimizationTestUtils';
import { createIndexedDbPersistentStorageTestStore } from '../../utils/indexedDbPersistentStorageTestStore';

export function stripTimelineDurations(timeline: string): string {
  return timeline.replace(/^\s*\d+(?:\.\d+)?(?:ms|s)\s+\| /gm, '| ');
}

export async function readListQueryItemNamespaceSnapshot(args: {
  mockAdapter: ReturnType<typeof createIndexedDbPersistentStorageTestStore>;
  sessionKey: string;
  storeName: string;
}) {
  const scope = args.mockAdapter.scope(args.storeName, args.sessionKey);
  return getIndexedDbNamespaceSnapshot(
    args.mockAdapter,
    scope.listQuery.itemNamespace,
  );
}

export async function readListQueryQueryNamespaceSnapshot(args: {
  mockAdapter: ReturnType<typeof createIndexedDbPersistentStorageTestStore>;
  sessionKey: string;
  storeName: string;
}) {
  const scope = args.mockAdapter.scope(args.storeName, args.sessionKey);
  return getIndexedDbNamespaceSnapshot(
    args.mockAdapter,
    scope.listQuery.queryNamespace,
  );
}

export async function readListQueryItemPayloadSnapshot(args: {
  id: number | string;
  mockAdapter: ReturnType<typeof createIndexedDbPersistentStorageTestStore>;
  sessionKey: string;
  storeName: string;
  tableId: string;
}) {
  const scope = args.mockAdapter.scope(args.storeName, args.sessionKey);
  return getIndexedDbPayloadSnapshot(args.mockAdapter, {
    key: scope.listQuery.itemKey(args.tableId, args.id),
    scope: scope.listQuery.itemNamespace,
  });
}

export async function readListQueryQueryPayloadSnapshot(args: {
  mockAdapter: ReturnType<typeof createIndexedDbPersistentStorageTestStore>;
  params: unknown;
  sessionKey: string;
  storeName: string;
}) {
  const scope = args.mockAdapter.scope(args.storeName, args.sessionKey);
  return getIndexedDbPayloadSnapshot(args.mockAdapter, {
    key: scope.listQuery.queryKey(args.params),
    scope: scope.listQuery.queryNamespace,
  });
}
