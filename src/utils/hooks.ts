import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { deepEqual, shallowEqual } from 't-state';

function useDeepCompareMemoize(value: any, equalityFn = deepEqual) {
  const ref = useRef<any>();
  const signalRef = useRef<number>(0);

  if (!equalityFn(value, ref.current)) {
    ref.current = value;
    signalRef.current += 1;
  }

  return [signalRef.current];
}

export function useDeepMemo<T>(callback: () => T, deeps: any[]): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(callback, useDeepCompareMemoize(deeps));
}

export function useShallowMemo<T>(callback: () => T, deeps: any[]): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(callback, useDeepCompareMemoize(deeps, shallowEqual));
}

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

function usePrevious<T>(value: T, initial?: T): T | undefined {
  const ref = useRef<T | undefined>(initial);
  useEffect(() => {
    ref.current = value;
  });
  return ref.current;
}

type EqualityFn = (a: any, b: any) => boolean;
type CleanupFn = () => void;

type OnChangeOptions = {
  equalityFn?: EqualityFn;
  callOnMount?: boolean;
  layoutEffect?: boolean;
};

/**
 * A replacement to useEffect that not need an array of dependencies.
 * PS: by default the callback is not called on mount, to change this use the
 * callOnMount option.
 */
export function useOnChange<T>(
  value: T,
  callBack: (values: { prev: T | undefined; current: T }) => void | CleanupFn,
  {
    equalityFn: areEqual = shallowEqual,
    callOnMount,
    layoutEffect,
  }: OnChangeOptions = {},
) {
  const useEffectFn = layoutEffect ? useLayoutEffect : useEffect;

  const prev = usePrevious(value, !callOnMount ? value : undefined);
  useEffectFn(() => {
    if (!areEqual(value, prev)) {
      return callBack({ prev, current: value });
    }
  });
}

export function useConst<T>(getValue: () => T) {
  const store = useRef<T>();

  if (store.current === undefined) {
    store.current = getValue();
  }

  return store.current;
}
