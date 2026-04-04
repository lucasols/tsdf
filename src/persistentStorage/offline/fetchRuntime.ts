export const offlineConnectivityError = {
  code: 0,
  id: 'offline',
  message: 'Offline',
} as const;

export function isOfflineConnectivityError(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    'code' in value &&
    'id' in value &&
    'message' in value &&
    value.code === offlineConnectivityError.code &&
    value.id === offlineConnectivityError.id &&
    value.message === offlineConnectivityError.message
  );
}

export type OfflineAwareFetchController = {
  prepareForFetch?: () => Promise<void>;
  getSessionStatus: () => { effectiveOffline: boolean } | null;
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

  if (controller?.getSessionStatus()?.effectiveOffline) {
    return { ok: false, offline: true };
  }

  try {
    const data = await fetcher();
    await controller?.handleFetchSuccess?.();
    return { ok: true, data };
  } catch (error) {
    await controller?.evaluateOfflineFetchError(error, operationName);

    if (controller?.getSessionStatus()?.effectiveOffline) {
      return { ok: false, offline: true };
    }

    return { ok: false, offline: false, error };
  }
}
