import { deepEqual } from '@ls-stack/utils/deepEqual';
import { useRef } from 'react';

export function useDeepStableValue<T>(value: T): T {
  const stableValueRef = useRef(value);

  if (!deepEqual(stableValueRef.current, value)) {
    stableValueRef.current = value;
  }

  return stableValueRef.current;
}
