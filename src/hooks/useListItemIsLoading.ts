import { useConst } from '@ls-stack/react-utils/useConst';
import { useLatestValue } from '@ls-stack/react-utils/useLatestValue';
import { useTimeout } from '@ls-stack/react-utils/useTimeout';
import { useEffect, useRef, useState } from 'react';

/** Detects if a list item may be loading when there is no clear indication of
 * the status of individual items (e.g. an item in a document collection that is
 * loaded on demand). If the item is not found and no refetch is in progress,
 * calls `loadItemFallback` after a short timeout. */
export function useListItemIsLoading({
  listIsLoading,
  isRefetching,
  itemExists,
  loadItemFallback,
  itemId,
}: {
  /** Unique identifier of the item. Pass `null` or `false` to disable. */
  itemId: string | null | false;
  /** Whether the parent list/collection is currently refetching */
  isRefetching: boolean;
  /** Whether the parent list/collection is in the initial loading state */
  listIsLoading: boolean;
  /** Whether the item exists in the current data — if the list hasn't loaded yet, the item won't exist in memory */
  itemExists: boolean;
  /** Called after a timeout if the item is still missing and no refetch is in progress */
  loadItemFallback: () => void;
}): boolean {
  const isNotFound = !itemExists;

  const [willBeRefetched, setWillBeRefetched] = useState(isNotFound);

  const resetWillBeRefetchedTimeout = useTimeout(1000);
  const callFallbackLoadItemTimeout = useTimeout(100);

  const ignoreSetWillBeRefetched = useRef(false);
  const itemWasRefetched = useConst(() => new Set<string>());

  if (
    isNotFound &&
    !isRefetching &&
    !willBeRefetched &&
    !ignoreSetWillBeRefetched.current &&
    itemId &&
    !itemWasRefetched.has(itemId)
  ) {
    setWillBeRefetched(true);
  }

  const latestIsLoadingOrRefetching = useLatestValue(
    listIsLoading || isRefetching,
  );
  const latestLoadItemFallback = useLatestValue(loadItemFallback);

  useEffect(() => {
    if (isRefetching) {
      if (itemId) itemWasRefetched.add(itemId);

      resetWillBeRefetchedTimeout.clear();
      callFallbackLoadItemTimeout.clear();
      setWillBeRefetched(false);
    }
  }, [
    callFallbackLoadItemTimeout,
    isRefetching,
    itemId,
    itemWasRefetched,
    resetWillBeRefetchedTimeout,
  ]);

  useEffect(() => {
    if (willBeRefetched) {
      callFallbackLoadItemTimeout.call(() => {
        if (!latestIsLoadingOrRefetching.insideEffect) {
          latestLoadItemFallback.insideEffect();

          return;
        }
      });

      resetWillBeRefetchedTimeout.call(() => {
        ignoreSetWillBeRefetched.current = true;
        setWillBeRefetched(false);

        setTimeout(() => {
          ignoreSetWillBeRefetched.current = false;
        }, 20);
      });
    }

    return () => {
      resetWillBeRefetchedTimeout.clear();
      callFallbackLoadItemTimeout.clear();
    };
  }, [
    resetWillBeRefetchedTimeout,
    willBeRefetched,
    latestIsLoadingOrRefetching,
    latestLoadItemFallback,
    callFallbackLoadItemTimeout,
  ]);

  return listIsLoading || (isNotFound && (isRefetching || !!willBeRefetched));
}
