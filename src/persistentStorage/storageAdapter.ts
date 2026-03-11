import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { OpfsAsyncStorageAdapter } from './opfsAsyncStorageAdapter';
import type {
  AsyncStorageAdapter,
  StorageAdapter,
  StorageBackend,
  SyncStorageAdapter,
} from './types';

function createLocalStorageAdapter(): SyncStorageAdapter {
  return {
    read<T>(key: string): Promise<T | null> {
      try {
        const raw = localStorage.getItem(key);
        if (raw === null) return Promise.resolve(null);
        return Promise.resolve(__LEGIT_CAST__<T, unknown>(JSON.parse(raw)));
      } catch {
        return Promise.resolve(null);
      }
    },

    write<T>(key: string, value: T): Promise<void> {
      localStorage.setItem(key, JSON.stringify(value));
      return Promise.resolve();
    },

    remove(key: string): Promise<void> {
      localStorage.removeItem(key);
      return Promise.resolve();
    },

    removeByPrefix(prefix: string): Promise<void> {
      const keysToRemove: string[] = [];

      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (key?.startsWith(prefix)) {
          keysToRemove.push(key);
        }
      }

      for (const key of keysToRemove) {
        localStorage.removeItem(key);
      }

      return Promise.resolve();
    },

    listKeys(prefix: string): Promise<string[]> {
      const keys: string[] = [];

      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (key?.startsWith(prefix)) {
          keys.push(key);
        }
      }

      return Promise.resolve(keys);
    },
  };
}

export function isAsyncStorageAdapter(
  adapter: StorageAdapter,
): adapter is AsyncStorageAdapter {
  return 'openNamespace' in adapter;
}

export function isSyncStorageAdapter(
  adapter: StorageAdapter,
): adapter is SyncStorageAdapter {
  return 'removeByPrefix' in adapter;
}

/** Creates a storage adapter for the specified backend. */
export function createStorageAdapter(backend: StorageBackend): StorageAdapter {
  switch (backend) {
    case 'localStorage':
      return createLocalStorageAdapter();
    case 'opfs':
      return new OpfsAsyncStorageAdapter();
  }
}
