import { unknownToError } from 't-result';
import type { StoreError } from '../../utils/storeShared';

export const offlineConnectivityError = {
  code: 0,
  id: 'offline',
  message: 'Offline',
} as const;

export function normalizeFetchResultError(
  fetchResult: { offline: true } | { offline: false; error: unknown },
  errorNormalizer: (error: Error) => StoreError,
): StoreError {
  return fetchResult.offline
    ? offlineConnectivityError
    : errorNormalizer(unknownToError(fetchResult.error));
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

export type OfflineAwareFetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; offline: true }
  | { ok: false; offline: false; error: unknown };

export async function runOfflineAwareFetch<T>({
  controller,
  fetcher,
  operationName,
}: {
  controller?: OfflineAwareFetchController | null;
  fetcher: () => Promise<T>;
  operationName?: string;
}): Promise<OfflineAwareFetchResult<T>> {
  await controller?.prepareForFetch?.();

  const shouldTreatFetchAsOffline = () =>
    controller?.shouldTreatFetchAsOffline?.() ??
    controller?.getSessionStatus()?.isOfflineMode ??
    false;

  if (shouldTreatFetchAsOffline()) {
    return { ok: false, offline: true };
  }

  try {
    const data = await fetcher();
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
