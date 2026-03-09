export const offlineConnectivityError = {
  code: 0,
  id: 'offline',
  message: 'Offline',
} as const;

export type OfflineAwareFetchController = {
  prepareForFetch?: () => Promise<void>;
  getSessionStatus: () => { effectiveOffline: boolean } | null;
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

  if (controller?.getSessionStatus()?.effectiveOffline) {
    return { ok: false, offline: true };
  }

  try {
    return { ok: true, data: await fetcher() };
  } catch (error) {
    await controller?.evaluateOfflineFetchError(error, operationName);

    if (controller?.getSessionStatus()?.effectiveOffline) {
      return { ok: false, offline: true };
    }

    return { ok: false, offline: false, error };
  }
}
