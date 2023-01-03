import { Emitter } from 'mitt';
import { useEffect } from 'react';
import { useLatestValue } from './useLatestValue';

export function useOnMittEvent<
  T extends Record<string, any>,
  E extends keyof T,
>(mitt: Emitter<T>, event: E, callback: (payload: T[E]) => void) {
  const latestCallback = useLatestValue(callback);

  useEffect(() => {
    mitt.on(event, latestCallback.insideEffect);

    return () => {
      mitt.off(event, latestCallback.insideEffect);
    };
  }, [mitt, event]);
}
