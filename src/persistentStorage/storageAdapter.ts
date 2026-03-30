import { murmur3 } from '@ls-stack/utils/hash';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import {
  rc_array,
  rc_object,
  rc_parse_json,
  rc_string,
  rc_unknown,
} from 'runcheck';

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
      localStorage.setItem(key, JSON.stringify(value));
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

const OPFS_CACHE_DIR = 'tsdf-cache';

const opfsBucketEntrySchema = rc_object({ key: rc_string, value: rc_unknown });

const opfsBucketFileSchema = rc_object({
  entries: rc_array(opfsBucketEntrySchema),
});

type OpfsBucketEntry = { key: string; value: unknown };

type OpfsBucketFile = { entries: OpfsBucketEntry[] };

function createOpfsAdapter(): StorageAdapter {
  async function getCacheDir(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(OPFS_CACHE_DIR, { create: true });
  }

  function getFileName(key: string): string {
    return `${murmur3(key, 'uint32')}.json`;
  }

  function parseBucket(raw: string): OpfsBucketFile | null {
    const result = rc_parse_json(raw, opfsBucketFileSchema);
    return result.ok ? result.value : null;
  }

  async function readBucket(
    dir: FileSystemDirectoryHandle,
    key: string,
  ): Promise<OpfsBucketFile | null> {
    try {
      const fileHandle = await dir.getFileHandle(getFileName(key));
      const file = await fileHandle.getFile();
      return parseBucket(await file.text());
    } catch {
      return null;
    }
  }

  async function writeBucket(
    dir: FileSystemDirectoryHandle,
    key: string,
    bucket: OpfsBucketFile,
  ): Promise<void> {
    const fileHandle = await dir.getFileHandle(getFileName(key), {
      create: true,
    });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(bucket));
    await writable.close();
  }

  return {
    async read<T>(key: string): Promise<T | null> {
      try {
        const dir = await getCacheDir();
        const bucket = await readBucket(dir, key);
        const entry = bucket?.entries.find((item) => item.key === key);

        if (!entry) return null;
        return __LEGIT_CAST__<T, unknown>(entry.value);
      } catch {
        return null;
      }
    },

    async write<T>(key: string, value: T): Promise<void> {
      const dir = await getCacheDir();
      const bucket = (await readBucket(dir, key)) ?? { entries: [] };
      const nextEntry = { key, value };
      const existingIndex = bucket.entries.findIndex(
        (item) => item.key === key,
      );

      if (existingIndex === -1) {
        bucket.entries.push(nextEntry);
      } else {
        bucket.entries[existingIndex] = nextEntry;
      }

      await writeBucket(dir, key, bucket);
    },

    async remove(key: string): Promise<void> {
      try {
        const dir = await getCacheDir();
        const bucket = await readBucket(dir, key);
        if (!bucket) return;

        const nextEntries = bucket.entries.filter((item) => item.key !== key);
        if (nextEntries.length === bucket.entries.length) return;

        if (nextEntries.length === 0) {
          await dir.removeEntry(getFileName(key));
          return;
        }

        await writeBucket(dir, key, { entries: nextEntries });
      } catch {
        // Silently handle not-found errors
      }
    },

    async removeByPrefix(prefix: string): Promise<void> {
      try {
        const dir = await getCacheDir();

        for await (const [name] of dir.entries()) {
          if (!name.endsWith('.json')) continue;

          try {
            const fileHandle = await dir.getFileHandle(name);
            const file = await fileHandle.getFile();
            const bucket = parseBucket(await file.text());
            if (!bucket) continue;

            const nextEntries = bucket.entries.filter(
              (entry) => !entry.key.startsWith(prefix),
            );

            if (nextEntries.length === bucket.entries.length) continue;

            if (nextEntries.length === 0) {
              await dir.removeEntry(name);
            } else {
              const writable = await fileHandle.createWritable();
              await writable.write(JSON.stringify({ entries: nextEntries }));
              await writable.close();
            }
          } catch {
            // Ignore entries that can't be read or removed
          }
        }
      } catch {
        // Silently handle errors
      }
    },

    async listKeys(prefix: string): Promise<string[]> {
      try {
        const dir = await getCacheDir();
        const keys: string[] = [];

        for await (const [name] of dir.entries()) {
          if (!name.endsWith('.json')) continue;

          try {
            const fileHandle = await dir.getFileHandle(name);
            const file = await fileHandle.getFile();
            const bucket = parseBucket(await file.text());
            if (!bucket) continue;

            for (const entry of bucket.entries) {
              if (entry.key.startsWith(prefix)) {
                keys.push(entry.key);
              }
            }
          } catch {
            // Ignore entries that can't be decoded
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
