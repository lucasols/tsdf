import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import type { StorageAdapter } from '../../src/persistentStorage/types';

export function createMockOpfsStorageAdapter({
  readDelayMs = 0,
}: { readDelayMs?: number } = {}) {
  const storage = new Map<string, string>();

  async function waitForReadDelay() {
    if (readDelayMs <= 0) return;

    await new Promise<void>((resolve) => {
      setTimeout(resolve, readDelayMs);
    });
  }

  const adapter: StorageAdapter = {
    async read<T>(key: string): Promise<T | null> {
      try {
        await waitForReadDelay();

        const raw = storage.get(key);
        if (!raw) return null;

        return __LEGIT_CAST__<T, unknown>(JSON.parse(raw));
      } catch {
        return null;
      }
    },

    write<T>(key: string, value: T): Promise<void> {
      storage.set(key, JSON.stringify(value));
      return Promise.resolve();
    },

    remove(key: string): Promise<void> {
      storage.delete(key);
      return Promise.resolve();
    },

    removeByPrefix(prefix: string): Promise<void> {
      for (const key of [...storage.keys()]) {
        if (key.startsWith(prefix)) storage.delete(key);
      }

      return Promise.resolve();
    },

    listKeys(prefix: string): Promise<string[]> {
      return Promise.resolve(
        [...storage.keys()].filter((key) => key.startsWith(prefix)),
      );
    },
  };

  return {
    adapter,
    getRaw(key: string) {
      return storage.get(key) ?? null;
    },
    has(key: string) {
      return storage.has(key);
    },
    setRaw(key: string, raw: string) {
      storage.set(key, raw);
    },
    setValue<T>(key: string, value: T) {
      storage.set(key, JSON.stringify(value));
    },
  };
}
