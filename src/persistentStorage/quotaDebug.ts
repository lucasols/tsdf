import {
  emitTSDFDebugLog,
  type TSDFDebugLogger,
  type TSDFDebugLogEntry,
} from '../debug';
import type { AsyncStorageNamespaceKind } from './types';

export type QuotaCleanupPhase = 'startup-cleanup' | 'maintenance' | 'flush';

export function logPersistentStorageQuotaCleanup(args: {
  adapter: 'async' | 'local-sync';
  logger: TSDFDebugLogger;
  evictedEntries: number;
  keptEntries: number;
  maxBytes: number;
  namespaceKind: AsyncStorageNamespaceKind;
  phase: QuotaCleanupPhase;
  quota: 'maxBytes' | 'maxItemBytes' | 'maxQueryBytes';
  storeName: string;
  totalEntries: number;
  unprotectedBytes: number;
}): void {
  emitTSDFDebugLog(args.logger, {
    area: 'persistent-storage',
    details: {
      adapter: args.adapter,
      evictedEntries: args.evictedEntries,
      keptEntries: args.keptEntries,
      maxBytes: args.maxBytes,
      namespaceKind: args.namespaceKind,
      phase: args.phase,
      quota: args.quota,
      status: 'success',
      storeName: args.storeName,
      totalEntries: args.totalEntries,
      unprotectedBytes: args.unprotectedBytes,
    },
    level: 'log',
    message: 'persistent storage quota-cleanup success',
    operation: 'quota-cleanup',
  } satisfies TSDFDebugLogEntry);
}
