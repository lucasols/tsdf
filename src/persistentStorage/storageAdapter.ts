import { murmur3 } from '@ls-stack/utils/hash';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import {
  rc_array,
  rc_object,
  rc_parse_json,
  rc_string,
  rc_unknown,
} from 'runcheck';
import type { AsyncStorageAdapter, SyncStorageAdapter } from './types';

export const localPersistentStorage: SyncStorageAdapter = {
  /** Identifier for adapter type and sync runtime behavior. */
  kind: 'sync',
  /**
   * Reads a value from `localStorage` for this exact key.
   * Returns `null` when the key does not exist or parsing fails.
   */
  read<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return null;
      return __LEGIT_CAST__<T, unknown>(JSON.parse(raw));
    } catch {
      return null;
    }
  },

  /**
   * Stores a value in `localStorage` using `JSON.stringify` for persistence.
   */
  write<T>(key: string, value: T): void {
    localStorage.setItem(key, JSON.stringify(value));
  },

  /**
   * Removes a single cache entry from `localStorage`.
   */
  remove(key: string): void {
    localStorage.removeItem(key);
  },

  /**
   * Removes all keys beginning with the provided prefix from `localStorage`.
   */
  removeByPrefix(prefix: string): void {
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
  },

  /**
   * Returns all keys in `localStorage` that start with the provided prefix.
   */
  listKeys(prefix: string): string[] {
    const keys: string[] = [];

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) {
        keys.push(key);
      }
    }

    return keys;
  },
};

const OPFS_CACHE_DIR = 'tsdf-cache';

const opfsBucketEntrySchema = rc_object({ key: rc_string, value: rc_unknown });

const opfsBucketFileSchema = rc_object({
  entries: rc_array(opfsBucketEntrySchema),
});

async function getOpfsCacheDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_CACHE_DIR, { create: true });
}

function getOpfsFileName(key: string): string {
  return `${murmur3(key, 'uint32')}.json`;
}

type OpfsBucketEntry = { key: string; value: unknown };

type OpfsBucketFile = { entries: OpfsBucketEntry[] };

function parseOpfsBucket(raw: string): OpfsBucketFile | null {
  const result = rc_parse_json(raw, opfsBucketFileSchema);
  return result.ok ? result.value : null;
}

async function readOpfsBucket(
  dir: FileSystemDirectoryHandle,
  key: string,
): Promise<OpfsBucketFile | null> {
  try {
    const fileHandle = await dir.getFileHandle(getOpfsFileName(key));
    const file = await fileHandle.getFile();
    return parseOpfsBucket(await file.text());
  } catch {
    return null;
  }
}

async function writeOpfsBucket(
  dir: FileSystemDirectoryHandle,
  key: string,
  bucket: OpfsBucketFile,
): Promise<void> {
  const fileHandle = await dir.getFileHandle(getOpfsFileName(key), {
    create: true,
  });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(bucket));
  await writable.close();
}

export const opfsPersistentStorage: AsyncStorageAdapter = {
  /** Identifier for adapter type and async runtime behavior. */
  kind: 'async',

  /**
   * Reads a typed value from OPFS bucket storage. Returns `null` when missing.
   */
  async read<T>(key: string): Promise<T | null> {
    try {
      const dir = await getOpfsCacheDir();
      const bucket = await readOpfsBucket(dir, key);
      const entry = bucket?.entries.find((item) => item.key === key);

      if (!entry) return null;
      return __LEGIT_CAST__<T, unknown>(entry.value);
    } catch {
      return null;
    }
  },

  /**
   * Writes a typed value into OPFS bucket storage, creating files as needed.
   */
  async write<T>(key: string, value: T): Promise<void> {
    const dir = await getOpfsCacheDir();
    const bucket = (await readOpfsBucket(dir, key)) ?? { entries: [] };
    const nextEntry = { key, value };
    const existingIndex = bucket.entries.findIndex((item) => item.key === key);

    if (existingIndex === -1) {
      bucket.entries.push(nextEntry);
    } else {
      bucket.entries[existingIndex] = nextEntry;
    }

    await writeOpfsBucket(dir, key, bucket);
  },

  /**
   * Removes a cached OPFS bucket entry by exact key.
   */
  async remove(key: string): Promise<void> {
    try {
      const dir = await getOpfsCacheDir();
      const bucket = await readOpfsBucket(dir, key);
      if (!bucket) return;

      const nextEntries = bucket.entries.filter((item) => item.key !== key);
      if (nextEntries.length === bucket.entries.length) return;

      if (nextEntries.length === 0) {
        await dir.removeEntry(getOpfsFileName(key));
        return;
      }

      await writeOpfsBucket(dir, key, { entries: nextEntries });
    } catch {
      // Silently handle not-found errors
    }
  },

  /**
   * Removes all OPFS entries whose keys match the provided prefix.
   */
  async removeByPrefix(prefix: string): Promise<void> {
    try {
      const dir = await getOpfsCacheDir();

      for await (const [name] of dir.entries()) {
        if (!name.endsWith('.json')) continue;

        try {
          const fileHandle = await dir.getFileHandle(name);
          const file = await fileHandle.getFile();
          const bucket = parseOpfsBucket(await file.text());
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

  /**
   * Returns all keys in OPFS storage matching the provided prefix.
   */
  async listKeys(prefix: string): Promise<string[]> {
    try {
      const dir = await getOpfsCacheDir();
      const keys: string[] = [];

      for await (const [name] of dir.entries()) {
        if (!name.endsWith('.json')) continue;

        try {
          const fileHandle = await dir.getFileHandle(name);
          const file = await fileHandle.getFile();
          const bucket = parseOpfsBucket(await file.text());
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
