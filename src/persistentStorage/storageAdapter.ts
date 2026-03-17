import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { OpfsAsyncStorageAdapter } from './opfsAsyncStorageAdapter';
import type {
  AsyncStorageAdapter,
  StorageAdapter,
  StorageBackend,
  SyncStorageAdapter,
} from './types';

export const localPersistentStorage: SyncStorageAdapter = {
  kind: 'sync',

  read<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return null;
      return __LEGIT_CAST__<T, unknown>(JSON.parse(raw));
    } catch {
      return null;
    }
  },

  write<T>(key: string, value: T): void {
    localStorage.setItem(key, JSON.stringify(value));
  },

  remove(key: string): void {
    localStorage.removeItem(key);
  },

  removeByPrefix(prefix: string): void {
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
  },

  listKeys(prefix: string): string[] {
    const keys: string[] = [];

    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix)) {
        keys.push(key);
      }
    }

    return keys;
  },
};

export const opfsPersistentStorage: AsyncStorageAdapter =
  new OpfsAsyncStorageAdapter();

export function isAsyncStorageAdapter(
  adapter: StorageAdapter,
): adapter is AsyncStorageAdapter {
  return adapter.kind === 'async';
}

export function isSyncStorageAdapter(
  adapter: StorageAdapter,
): adapter is SyncStorageAdapter {
  return adapter.kind === 'sync';
}

/** Creates a storage adapter for the specified backend. */
export function createStorageAdapter(backend: StorageBackend): StorageAdapter {
  switch (backend) {
    case 'localStorage':
      return localPersistentStorage;
    case 'opfs':
      return opfsPersistentStorage;
  }
}
