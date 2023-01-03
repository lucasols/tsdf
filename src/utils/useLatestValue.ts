import { useLayoutEffect, useRef } from 'react';

export function useLatestValue<T>(value: T) {
  const ref = useRef<{
    insideEffect: T;
    insideMemo: T;
  }>({ insideEffect: value, insideMemo: value });

  ref.current.insideMemo = value;

  useLayoutEffect(() => {
    ref.current.insideEffect = value;
  });

  return ref.current;
}
