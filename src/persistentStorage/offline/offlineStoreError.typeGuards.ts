import type { StoreError } from '../../utils/storeShared';
import type { OfflineStoreError } from './fetchRuntime';

/**
 * Whether `error` is the error TSDF reports for a fetch that could not
 * complete because the offline session is in offline mode (the request is not
 * sent while offline).
 *
 * TSDF only exposes it on reads that have nothing cached to return
 * (`status: 'error'`): a document, item or query that is returning cached data
 * stays `success` with `error: null` while offline, so this is the state the
 * app has to explain to the user ("not available offline").
 *
 * Accepts the `error` of hooks and state getters and the `StoreFetchError` of
 * the `awaitFetch` methods. The error is matched by its whole shape, not only
 * by `id`, so an app error whose `errorNormalizer` happens to use the
 * `'offline'` id is not mistaken for it.
 *
 * @example
 * ```tsx
 * const { data, error } = store.useDocument();
 *
 * if (isOfflineStoreError(error)) return <NotAvailableOffline />;
 * if (error) return <ErrorMessage error={error} />;
 * ```
 */
export function isOfflineStoreError(
  error: StoreError | null | undefined,
): error is OfflineStoreError {
  return (
    !!error &&
    error.id === 'offline' &&
    error.code === 0 &&
    error.message === 'Offline'
  );
}
