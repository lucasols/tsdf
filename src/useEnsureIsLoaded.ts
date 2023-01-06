import { useMemo, useState } from 'react';
import { useOnChange } from './utils/hooks';

export function useEnsureIsLoaded<
  T extends { isLoading: boolean; status: string },
>(
  ensureIsLoaded: boolean | undefined,
  enabled: boolean,
  isNotLoading: boolean,
  forceFetch: () => void,
  result: T,
): T {
  const [isForceLoading, setIsForceLoading] = useState(true);

  useOnChange(ensureIsLoaded && enabled, () => {
    if (ensureIsLoaded && enabled) {
      forceFetch();
    }
  });

  useOnChange(ensureIsLoaded && result.status, () => {
    if (ensureIsLoaded && isForceLoading && isNotLoading) {
      setIsForceLoading(false);
    }
  });

  return useMemo(() => {
    if (ensureIsLoaded) {
      return {
        ...result,
        isLoading: isForceLoading,
      };
    }

    return result;
  }, [ensureIsLoaded, isForceLoading, result]);
}
