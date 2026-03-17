import { createMockOpfsStorageAdapter } from '../mocks/mockOpfsStorageAdapter';

function stripScopePrefix(
  storeName: string,
  sessionKey: string,
  key: string,
): string {
  const documentKey = `tsdf.${sessionKey}.${storeName}`;
  if (key === documentKey) return storeName;

  const prefix = `${documentKey}.`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

export type PersistentStorageReadBreakdown = {
  metadataReads: string[];
  scopedPayloadReads: string[];
  externalPayloadReads: string[];
  payloadBatchReads: string[][];
  legacyFallbackReads: string[];
};

export type PersistentStorageOperationSummary = {
  breakdown: PersistentStorageReadBreakdown;
  operations: string[];
};

export type PersistentStorageOperationCapture = {
  finish: () => PersistentStorageOperationSummary;
};

export function startOpfsPersistentStorageOperationCapture(
  mockAdapter: ReturnType<typeof createMockOpfsStorageAdapter>,
  args: { storeName: string; sessionKey: string },
): PersistentStorageOperationCapture {
  const scopedPrefix = `tsdf.${args.sessionKey}.${args.storeName}.`;
  const protectedRegistryKey = `tsdf.${args.sessionKey}.__offline__.protected`;

  function getFlatKey(
    scope: {
      sessionKey: string;
      storeName: string;
      kind:
        | 'document'
        | 'collection.item'
        | 'listQuery.item'
        | 'listQuery.query'
        | 'offline.queue'
        | 'offline.conflict'
        | 'offline.entity'
        | '__internal.protected';
    },
    key: string,
  ): string {
    switch (scope.kind) {
      case 'document':
        return scope.storeName === '__offline__' && key === 'session'
          ? `tsdf.${scope.sessionKey}.__offline__.session`
          : `tsdf.${scope.sessionKey}.${scope.storeName}`;
      case 'collection.item':
        return `tsdf.${scope.sessionKey}.${scope.storeName}.collection.item.${key}`;
      case 'listQuery.item':
        return `tsdf.${scope.sessionKey}.${scope.storeName}.listQuery.item.${key}`;
      case 'listQuery.query':
        return `tsdf.${scope.sessionKey}.${scope.storeName}.listQuery.query.${key}`;
      case 'offline.queue':
        return `tsdf.${scope.sessionKey}.${scope.storeName}.offline.queue.${key}`;
      case 'offline.conflict':
        return `tsdf.${scope.sessionKey}.${scope.storeName}.offline.conflict.${key}`;
      case 'offline.entity':
        return `tsdf.${scope.sessionKey}.${scope.storeName}.offline.entity.${key}`;
      case '__internal.protected':
        return `tsdf.${scope.sessionKey}.__offline__.protected`;
    }
  }

  function formatCursor(cursor: string | null): string {
    return cursor === null ? 'null' : JSON.stringify(cursor);
  }

  function formatScope(scope: {
    sessionKey: string;
    storeName: string;
    kind: string;
  }): string {
    return `${scope.sessionKey}/${scope.storeName}/${scope.kind}`;
  }

  function formatPayloadKey(key: string): {
    scope: 'scoped' | 'external';
    value: string;
  } {
    if (key === protectedRegistryKey) {
      return {
        scope: 'external',
        value: `${key} (protected registry payload)`,
      };
    }

    if (key === `tsdf.${args.sessionKey}.${args.storeName}`) {
      return { scope: 'scoped', value: 'document payload' };
    }

    if (key.startsWith(scopedPrefix)) {
      return {
        scope: 'scoped',
        value: `${stripScopePrefix(args.storeName, args.sessionKey, key)} (payload)`,
      };
    }

    return { scope: 'external', value: `${key} (payload)` };
  }

  function formatScopedStorageKey(
    scope: {
      sessionKey: string;
      storeName: string;
      kind:
        | 'document'
        | 'collection.item'
        | 'listQuery.item'
        | 'listQuery.query'
        | 'offline.queue'
        | 'offline.conflict'
        | 'offline.entity'
        | '__internal.protected';
    },
    key: string,
  ): string {
    return formatPayloadKey(getFlatKey(scope, key)).value;
  }

  mockAdapter.clearInstrumentation();

  return {
    finish() {
      const payloadReads = mockAdapter.payloadGetRequests.map(formatPayloadKey);

      return {
        breakdown: {
          metadataReads: mockAdapter.metadataListRequests.map((request) => {
            const limit = request.limit ?? 'default';

            return (
              `${request.scope.sessionKey}/${request.scope.storeName}/${request.scope.kind} ` +
              `(metadata order=${request.order} cursor=${formatCursor(request.cursor)} limit=${limit})`
            );
          }),
          scopedPayloadReads: payloadReads
            .filter((entry) => entry.scope === 'scoped')
            .map((entry) => entry.value),
          externalPayloadReads: payloadReads
            .filter((entry) => entry.scope === 'external')
            .map((entry) => entry.value),
          payloadBatchReads: mockAdapter.payloadGetManyRequests.map((keys) =>
            keys.map((key) => formatPayloadKey(key).value),
          ),
          legacyFallbackReads: [...mockAdapter.legacyListKeysFallbackRequests],
        },
        operations: [
          ...mockAdapter.operations.map((operation) => {
            switch (operation.type) {
              case 'get':
                return `📖 ${operation.exists ? '✅' : '❌'} ${formatPayloadKey(operation.flatKey).value} | touch=${operation.touch}`;
              case 'getMany':
                return `📚 ${formatScope(operation.scope)} | touch=${operation.touch} | hits=${operation.hitCount}/${operation.keys.length} | ${JSON.stringify(
                  operation.flatKeys.map((key) => formatPayloadKey(key).value),
                )}`;
              case 'commit':
                return `✍️ ${formatScope(operation.scope)} upserts=${JSON.stringify(
                  operation.upserts.map((key) =>
                    formatScopedStorageKey(operation.scope, key),
                  ),
                )} removes=${JSON.stringify(
                  operation.removes.map((key) =>
                    formatScopedStorageKey(operation.scope, key),
                  ),
                )} touches=${JSON.stringify(
                  operation.touches.map((touch) => ({
                    key: formatScopedStorageKey(operation.scope, touch.key),
                    lastAccessAt: touch.lastAccessAt,
                  })),
                )}`;
              case 'listMetadata':
                return `📇 ${formatScope(operation.scope)} (metadata order=${operation.order} cursor=${formatCursor(
                  operation.cursor,
                )} limit=${operation.limit ?? 'default'} resultCount=${operation.resultCount} nextCursor=${formatCursor(
                  operation.nextCursor,
                )})`;
              case 'clear':
                return `🧹 ${formatScope(operation.scope)} removes=${JSON.stringify(
                  operation.removedKeys.map((key) =>
                    formatScopedStorageKey(operation.scope, key),
                  ),
                )}`;
              case 'readMaintenanceState':
                return '🧰 maintenance.read';
              case 'tryAcquireStartupCleanupLease':
                return `🔒 ${operation.acquired ? '✅' : '❌'} startupCleanupLease holder=${operation.holderId} ttlMs=${operation.ttlMs}`;
              case 'finishStartupCleanup':
                return `🏁 startupCleanupLease holder=${operation.holderId} finishedAt=${operation.finishedAt}`;
            }
          }),
          ...mockAdapter.legacyListKeysFallbackRequests.map(
            (prefix) => `🗂️ legacyListKeys ${prefix}`,
          ),
        ],
      };
    },
  };
}

export function startOpfsPersistentStorageReadCapture(
  mockAdapter: ReturnType<typeof createMockOpfsStorageAdapter>,
  args: { storeName: string; sessionKey: string },
): { finish: () => PersistentStorageReadBreakdown } {
  const capture = startOpfsPersistentStorageOperationCapture(mockAdapter, args);

  return {
    finish() {
      return capture.finish().breakdown;
    },
  };
}
