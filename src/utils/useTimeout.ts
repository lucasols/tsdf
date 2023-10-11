import { useCallback, useEffect, useMemo } from 'react';
import { useConst } from './hooks';

export function useTimeout(ms: number): {
  call: (cb: () => void, overrideMs?: number) => void;
  clear: () => void;
} {
  const timeoutsRef = useConst(() => new Set<number>());

  const callback = useCallback(
    (cb: () => void, overrideMs = ms) => {
      timeoutsRef.add(window.setTimeout(cb, overrideMs));
    },
    [ms, timeoutsRef],
  );

  const clear = useCallback(() => {
    for (const timeout of timeoutsRef) {
      clearTimeout(timeout);
    }
  }, [timeoutsRef]);

  useEffect(() => clear, [clear]);

  return useMemo(() => {
    return {
      call: callback,
      clear,
    };
  }, [callback, clear]);
}
