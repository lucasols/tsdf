export function shouldScheduleAutomaticFetch({
  wasLoaded,
  shouldFetch,
  disableRefetches,
  disableRefetchOnMount,
  skipFreshFetch = false,
}: {
  wasLoaded: boolean | undefined;
  shouldFetch: boolean;
  disableRefetches: boolean;
  disableRefetchOnMount: boolean;
  skipFreshFetch?: boolean;
}): boolean {
  if (disableRefetches) return !wasLoaded;

  if (disableRefetchOnMount) return shouldFetch;

  if (skipFreshFetch && !shouldFetch) {
    return false;
  }

  return true;
}
