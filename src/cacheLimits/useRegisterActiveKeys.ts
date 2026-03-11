import { useEffect } from 'react';

export function useRegisterActiveKeys(
  keys: string[],
  registerActiveKeys: (keys: string[]) => () => void,
  touchKeys: (keys: string[]) => void,
): void {
  useEffect(() => {
    if (keys.length === 0) return;

    touchKeys(keys);
    return registerActiveKeys(keys);
  }, [keys, registerActiveKeys, touchKeys]);
}
