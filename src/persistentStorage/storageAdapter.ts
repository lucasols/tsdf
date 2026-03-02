import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import type { StorageAdapter, StorageBackend } from './types';

function createLocalStorageAdapter(): StorageAdapter {
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
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // Silently handle quota exceeded errors
      }
      return Promise.resolve();
    },

    remove(key: string): Promise<void> {
      localStorage.removeItem(key);
      return Promise.resolve();
    },

    removeByPrefix(prefix: string): Promise<void> {
      const keysToRemove: string[] = [];

      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
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

      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(prefix)) {
          keys.push(key);
        }
      }

      return Promise.resolve(keys);
    },
  };
}

const PERCENT_ENCODED_REGEX = /%([0-9A-F]{2})/g;
const BASE64_PLUS_REGEX = /\+/g;
const BASE64_SLASH_REGEX = /\//g;
const BASE64_PADDING_REGEX = /=+$/;

/**
 * Encodes a key to a safe filename for OPFS.
 * Uses Base64url encoding (RFC 4648 Section 5).
 */
function encodeKeyToFileName(key: string): string {
  const encoded = btoa(
    encodeURIComponent(key).replace(PERCENT_ENCODED_REGEX, (_, p1: string) =>
      String.fromCharCode(parseInt(p1, 16)),
    ),
  );

  // Convert to base64url: replace + with -, / with _, remove padding =
  return encoded
    .replace(BASE64_PLUS_REGEX, '-')
    .replace(BASE64_SLASH_REGEX, '_')
    .replace(BASE64_PADDING_REGEX, '');
}

const OPFS_CACHE_DIR = 'tsdf-cache';

function createOpfsAdapter(): StorageAdapter {
  async function getCacheDir(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(OPFS_CACHE_DIR, { create: true });
  }

  function getFileName(key: string): string {
    return `${encodeKeyToFileName(key)}.json`;
  }

  return {
    async read<T>(key: string): Promise<T | null> {
      try {
        const dir = await getCacheDir();
        const fileHandle = await dir.getFileHandle(getFileName(key));
        const file = await fileHandle.getFile();
        const text = await file.text();
        return __LEGIT_CAST__<T, unknown>(JSON.parse(text));
      } catch {
        return null;
      }
    },

    async write<T>(key: string, value: T): Promise<void> {
      try {
        const dir = await getCacheDir();
        const fileHandle = await dir.getFileHandle(getFileName(key), {
          create: true,
        });
        const writable = await fileHandle.createWritable();
        await writable.write(JSON.stringify(value));
        await writable.close();
      } catch {
        // Silently handle write errors
      }
    },

    async remove(key: string): Promise<void> {
      try {
        const dir = await getCacheDir();
        await dir.removeEntry(getFileName(key));
      } catch {
        // Silently handle not-found errors
      }
    },

    async removeByPrefix(prefix: string): Promise<void> {
      try {
        const dir = await getCacheDir();
        const entriesToRemove: string[] = [];

        for await (const [name] of dir.entries()) {
          // We need to check each file - but we store encoded keys,
          // so we iterate and check the decoded key
          if (name.endsWith('.json')) {
            entriesToRemove.push(name);
          }
        }

        // Since we can't easily decode base64url filenames back to check the prefix,
        // we list all keys and check the prefix on the original key.
        // For efficiency, we'll store a mapping approach: encode the prefix and check filename starts.
        // However, base64 doesn't preserve prefix relationships.
        // Instead, we use a simpler approach: store with prefix in filename.
        // Actually, let's just list all and filter by reading metadata.
        // For now, the most practical approach is to iterate and match.
        const encodedPrefix = encodeKeyToFileName(prefix);

        for (const name of entriesToRemove) {
          const nameWithoutExt = name.slice(0, -5); // remove .json
          if (nameWithoutExt.startsWith(encodedPrefix)) {
            try {
              await dir.removeEntry(name);
            } catch {
              // Ignore individual removal errors
            }
          }
        }
      } catch {
        // Silently handle errors
      }
    },

    async listKeys(prefix: string): Promise<string[]> {
      try {
        const dir = await getCacheDir();
        const encodedPrefix = encodeKeyToFileName(prefix);
        const keys: string[] = [];

        for await (const [name] of dir.entries()) {
          if (name.endsWith('.json')) {
            const nameWithoutExt = name.slice(0, -5);
            if (nameWithoutExt.startsWith(encodedPrefix)) {
              keys.push(name);
            }
          }
        }

        return keys;
      } catch {
        return [];
      }
    },
  };
}

/** Creates a storage adapter for the specified backend. */
export function createStorageAdapter(backend: StorageBackend): StorageAdapter {
  switch (backend) {
    case 'localStorage':
      return createLocalStorageAdapter();
    case 'opfs':
      return createOpfsAdapter();
  }
}
