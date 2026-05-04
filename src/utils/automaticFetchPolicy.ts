import type { FetchType } from '../requestScheduler';
import type { TSDFStatus } from './storeShared';

export const AUTOMATIC_RETRY_LOCKOUT_MS = 10_000;

/**
 * Per-hook state used by `tryClaimAutomaticFetchSlot`.
 * Maps a resource signature to the last automatic attempt and whether a fast
 * error has locked that resource out.
 */
export type AutomaticFetchRetryState = Map<
  string,
  { attemptedAt: number; locked: boolean }
>;

type AutomaticFetchStatus = TSDFStatus | 'idle' | 'loadingMore' | undefined;

export function observeAutomaticFetchStatus(
  state: AutomaticFetchRetryState,
  signature: string,
  currentStatus: AutomaticFetchStatus,
): void {
  if (currentStatus === 'success') {
    state.delete(signature);
    return;
  }

  if (currentStatus !== 'error') return;

  const previous = state.get(signature);
  if (!previous) return;

  if (Date.now() - previous.attemptedAt <= AUTOMATIC_RETRY_LOCKOUT_MS) {
    previous.locked = true;
  }
}

/**
 * Decides whether an automatic, render-driven fetch should proceed.
 *
 * Returns `true` and records the attempt when allowed. Returns `false`
 * when the resource is locked after a fast error.
 *
 * Manual fetches (`scheduleFetch`, `invalidateData`, transport reconnect,
 * etc.) bypass this gate by calling the underlying scheduler directly.
 *
 * Lock state is maintained by `observeAutomaticFetchStatus`, which the
 * consuming hook runs in a status-tracking effect before this is called.
 */
export function tryClaimAutomaticFetchSlot(
  state: AutomaticFetchRetryState,
  signature: string,
  currentStatus: AutomaticFetchStatus,
): boolean {
  if (currentStatus === 'error' && state.get(signature)?.locked) return false;

  state.set(signature, { attemptedAt: Date.now(), locked: false });
  return true;
}

export function createFieldsResourceSignature(
  fields: '*' | readonly string[] | undefined,
): string {
  if (fields === '*') return '*';
  if (fields === undefined) return '';

  return JSON.stringify(Array.from(new Set(fields)).sort());
}

type AutomaticFetchPolicyOptions = {
  wasLoaded: boolean | undefined;
  shouldFetch: boolean;
  requiredFetch?: boolean;
  disableRefetches: boolean;
  disableRefetchOnMount: boolean;
  refetchOnMount?: false | FetchType;
  skipFreshFetch?: boolean;
};

export function shouldScheduleAutomaticFetch(
  options: AutomaticFetchPolicyOptions,
): boolean {
  const {
    wasLoaded,
    shouldFetch,
    disableRefetches,
    disableRefetchOnMount,
    skipFreshFetch = false,
  } = options;

  if (disableRefetches) return !wasLoaded;

  if (disableRefetchOnMount) return shouldFetch;

  if (skipFreshFetch && !shouldFetch) {
    return false;
  }

  return true;
}
