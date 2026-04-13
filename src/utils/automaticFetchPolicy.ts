import type { FetchType } from '../requestScheduler';

export function shouldScheduleAutomaticFetch({
  wasLoaded,
  shouldFetch,
  requiredFetch = false,
  disableRefetches,
  disableRefetchOnMount,
  refetchOnMount = false,
  skipFreshFetch = false,
}: {
  wasLoaded: boolean | undefined;
  shouldFetch: boolean;
  requiredFetch?: boolean;
  disableRefetches: boolean;
  disableRefetchOnMount: boolean;
  refetchOnMount?: false | FetchType;
  skipFreshFetch?: boolean;
}): boolean {
  if (disableRefetches) return !wasLoaded;

  if (disableRefetchOnMount) {
    if (requiredFetch) return true;

    return refetchOnMount !== false && refetchOnMount !== 'lowPriority';
  }

  if (skipFreshFetch && !shouldFetch) {
    return false;
  }

  return true;
}
