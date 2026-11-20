import type { StoreError } from '../../utils/storeShared';
import {
  normalizeStoreError,
  unwrapMaybeTSDFResult,
  type MaybeTSDFResult,
} from '../../utils/storeShared';

/**
 * The error TSDF reports for a fetch that could not complete because the
 * offline session is in offline mode. Use `isOfflineStoreError` to recognise
 * it.
 */
export type OfflineStoreError = StoreError & {
  code: 0;
  id: 'offline';
  message: 'Offline';
};

export const offlineConnectivityError: OfflineStoreError = {
  code: 0,
  id: 'offline',
  message: 'Offline',
};

export function normalizeFetchResultError(
  fetchResult: { offline: true } | { offline: false; error: unknown },
  errorNormalizer: (error: Error) => StoreError,
): StoreError {
  return fetchResult.offline
    ? offlineConnectivityError
    : normalizeStoreError(fetchResult.error, errorNormalizer);
}

export type OfflineAwareFetchController = {
  prepareForFetch?: () => Promise<void>;
  getSessionStatus: () => { isOfflineMode: boolean } | null;
  shouldTreatFetchAsOffline?: () => boolean;
  handleFetchSuccess?: () => Promise<void>;
  evaluateOfflineFetchError: (
    error: unknown,
    operationName?: string,
  ) => Promise<void>;
};

type OfflineAwareFetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; offline: true }
  | { ok: false; offline: false; error: unknown };

export async function runOfflineAwareFetch<T>(
  controller: OfflineAwareFetchController | null | undefined,
  fetcher: () => Promise<MaybeTSDFResult<T>>,
  operationName?: string,
): Promise<OfflineAwareFetchResult<T>> {
  await controller?.prepareForFetch?.();

  const shouldTreatFetchAsOffline = () =>
    controller?.shouldTreatFetchAsOffline?.() ??
    controller?.getSessionStatus()?.isOfflineMode ??
    false;

  if (shouldTreatFetchAsOffline()) {
    return { ok: false, offline: true };
  }

  try {
    const data = unwrapMaybeTSDFResult(await fetcher());
    await controller?.handleFetchSuccess?.();
    return { ok: true, data };
  } catch (error) {
    await controller?.evaluateOfflineFetchError(error, operationName);

    if (shouldTreatFetchAsOffline()) {
      return { ok: false, offline: true };
    }

    return { ok: false, offline: false, error };
  }
}
