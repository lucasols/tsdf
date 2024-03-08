import { useEffect, useRef, useState } from 'react';
import { useTimeout } from './utils/useTimeout';
import { useConst, useLatestValue } from './utils/hooks';

/** Use to detect if a item of a list may be loading in cases which there is no
 * clear indication of the status of individual items, ex: an item in a document collection that is loaded on demand */
export function useListItemIsLoading({
  listIsLoading,
  isRefetching,
  itemExists,
  loadItemFallback,
  itemId,
}: {
  itemId: string | null | false;
  isRefetching: boolean;
  listIsLoading: boolean;
  /** true if item exists in any condition, ex: if list is not loaded item not exists in memory yet */
  itemExists: boolean;
  loadItemFallback: () => void;
}): boolean {
  const isNotFound = !itemExists;

  const [willBeRefetched, setWillBeRefetched] = useState(isNotFound);

  const resetWillBeRefechedTimeout = useTimeout(1000);
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

      resetWillBeRefechedTimeout.clear();
      callFallbackLoadItemTimeout.clear();
      setWillBeRefetched(false);
    }
  }, [
    callFallbackLoadItemTimeout,
    isRefetching,
    itemId,
    itemWasRefetched,
    resetWillBeRefechedTimeout,
  ]);

  useEffect(() => {
    if (willBeRefetched) {
      callFallbackLoadItemTimeout.call(() => {
        if (!latestIsLoadingOrRefetching.insideEffect) {
          latestLoadItemFallback.insideEffect();

          return;
        }
      });

      resetWillBeRefechedTimeout.call(() => {
        ignoreSetWillBeRefetched.current = true;
        setWillBeRefetched(false);

        setTimeout(() => {
          ignoreSetWillBeRefetched.current = false;
        }, 20);
      });
    }

    return () => {
      resetWillBeRefechedTimeout.clear();
      callFallbackLoadItemTimeout.clear();
    };
  }, [
    resetWillBeRefechedTimeout,
    willBeRefetched,
    latestIsLoadingOrRefetching,
    latestLoadItemFallback,
    callFallbackLoadItemTimeout,
  ]);

  return (
    listIsLoading || (isNotFound && (isRefetching || !!willBeRefetched))
  );
}
