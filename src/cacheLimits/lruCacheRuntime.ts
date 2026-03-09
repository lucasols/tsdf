export type LruCacheRuntime = {
  touch(keys: string[], isPresent: (key: string) => boolean): boolean;
  registerActive(keys: string[]): () => void;
  isActive(key: string): boolean;
  getLastUsed(key: string): number;
  clear(key: string): void;
  clearAll(): void;
};

export function createLruCacheRuntime(): LruCacheRuntime {
  const lastUsed = new Map<string, number>();
  const activeRefs = new Map<string, number>();
  let clock = 0;

  return {
    touch(keys, isPresent) {
      let someKeyWasTouched = false;

      for (const key of keys) {
        if (!isPresent(key)) continue;

        lastUsed.set(key, ++clock);
        someKeyWasTouched = true;
      }

      return someKeyWasTouched;
    },

    registerActive(keys) {
      if (keys.length === 0) return () => {};

      for (const key of keys) {
        activeRefs.set(key, (activeRefs.get(key) ?? 0) + 1);
      }

      return () => {
        for (const key of keys) {
          const nextCount = (activeRefs.get(key) ?? 0) - 1;
          if (nextCount > 0) {
            activeRefs.set(key, nextCount);
          } else {
            activeRefs.delete(key);
          }
        }
      };
    },

    isActive(key) {
      return activeRefs.has(key);
    },

    getLastUsed(key) {
      return lastUsed.get(key) ?? 0;
    },

    clear(key) {
      lastUsed.delete(key);
    },

    clearAll() {
      lastUsed.clear();
    },
  };
}
