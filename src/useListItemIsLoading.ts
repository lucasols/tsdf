import { useEffect, useRef, useState } from 'react';
import { useTimeout } from './utils/useTimeout';

/** Use to detect if a item of a list may be loading in cases which there is no
 * clear indication of the status of individual items, ex: an item in a document collection that is loaded on demand */
export function useListItemIsLoading({
  isLoading,
  isRefetching,
  isNotFound,
}: {
  isRefetching: boolean;
  isLoading: boolean;
  isNotFound: boolean;
}): boolean {
  const [willBeRefetched, setWillBeRefetched] = useState(isNotFound);

  const timeout = useTimeout(1000);

  const ignoreSetWillBeRefetched = useRef(false);

  if (isNotFound && !willBeRefetched && !ignoreSetWillBeRefetched.current) {
    setWillBeRefetched(true);
  }

  useEffect(() => {
    if (willBeRefetched) {
      timeout.call(() => {
        ignoreSetWillBeRefetched.current = true;
        setWillBeRefetched(false);

        setTimeout(() => {
          ignoreSetWillBeRefetched.current = false;
        }, 20);
      });
    }

    return () => timeout.clear();
  }, [timeout, willBeRefetched]);

  return isLoading || (isNotFound && (isRefetching || !!willBeRefetched));
}
