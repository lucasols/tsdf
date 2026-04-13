import type {
  OfflineResolutionRecord,
  OfflineResolutionRecordForStore,
} from './types';

/** @internal */
export function isOfflineResolutionRecordForStore<
  TOperations extends Record<string, unknown>,
>(
  resolution: OfflineResolutionRecord,
  operations: TOperations,
): resolution is OfflineResolutionRecordForStore<TOperations> {
  return resolution.operation in operations;
}
