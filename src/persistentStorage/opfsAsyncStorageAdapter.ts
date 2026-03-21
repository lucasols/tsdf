import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import type {
  AsyncStorageDriver,
  AsyncStorageDriverSetEntry,
  AsyncStorageNamespaceScope,
} from './types';

const OPFS_CACHE_DIR = 'tsdf';
const JSON_FILE_EXTENSION = '.json';

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function decodePathSegment(value: string): string {
  return decodeURIComponent(value);
}

async function getNavigatorStorageDirectory(): Promise<FileSystemDirectoryHandle> {
  const storage = __LEGIT_CAST__<
    | { getDirectory?: (() => Promise<FileSystemDirectoryHandle>) | undefined }
    | undefined,
    unknown
  >(globalThis.navigator.storage);
  if (storage?.getDirectory === undefined) {
    throw new Error('[TSDF] OPFS is unavailable in this environment.');
  }

  return storage.getDirectory();
}

async function getDirectoryHandleIfExists(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await parent.getDirectoryHandle(name);
  } catch {
    return null;
  }
}

async function getFileHandleIfExists(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemFileHandle | null> {
  try {
    return await parent.getFileHandle(name);
  } catch {
    return null;
  }
}

export class OpfsAsyncStorageDriver implements AsyncStorageDriver {
  private rootDirPromise: Promise<FileSystemDirectoryHandle> | null = null;

  async get(scope: AsyncStorageNamespaceScope, key: string): Promise<unknown> {
    const [value] = await this.getMany(scope, [key]);
    return value ?? null;
  }

  async set(
    scope: AsyncStorageNamespaceScope,
    key: string,
    value: unknown,
  ): Promise<void> {
    await this.setMany(scope, [{ key, value }]);
  }

  async remove(scope: AsyncStorageNamespaceScope, key: string): Promise<void> {
    await this.removeMany(scope, [key]);
  }

  async getMany(
    scope: AsyncStorageNamespaceScope,
    keys: string[],
  ): Promise<unknown[]> {
    if (keys.length === 0) return [];

    const scopeDir = await this.getScopeDir(scope, { create: false });
    if (scopeDir === null) {
      return keys.map(() => null);
    }

    return Promise.all(
      keys.map(async (key) => {
        const fileHandle = await getFileHandleIfExists(
          scopeDir,
          this.getFileNameForKey(key),
        );
        if (fileHandle === null) return null;

        try {
          const file = await fileHandle.getFile();
          const parsed: unknown = JSON.parse(await file.text());
          return parsed;
        } catch {
          return null;
        }
      }),
    );
  }

  async setMany(
    scope: AsyncStorageNamespaceScope,
    entries: AsyncStorageDriverSetEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;

    const scopeDir = await this.getScopeDir(scope, { create: true });
    if (scopeDir === null) {
      throw new Error('[TSDF] Failed to open OPFS scope directory.');
    }

    await Promise.all(
      entries.map(async (entry) => {
        const fileHandle = await scopeDir.getFileHandle(
          this.getFileNameForKey(entry.key),
          { create: true },
        );
        const writable = await fileHandle.createWritable();

        try {
          await writable.write(JSON.stringify(entry.value));
        } finally {
          await writable.close();
        }
      }),
    );
  }

  async removeMany(
    scope: AsyncStorageNamespaceScope,
    keys: string[],
  ): Promise<void> {
    if (keys.length === 0) return;

    const scopeDir = await this.getScopeDir(scope, { create: false });
    if (scopeDir === null) return;

    await Promise.all(
      keys.map(async (key) => {
        try {
          await scopeDir.removeEntry(this.getFileNameForKey(key));
        } catch {
          // Ignore missing records.
        }
      }),
    );
  }

  async listKeys(scope: AsyncStorageNamespaceScope): Promise<string[]> {
    const scopeDir = await this.getScopeDir(scope, { create: false });
    if (scopeDir === null) return [];

    const keys: string[] = [];
    for await (const entry of scopeDir.values()) {
      if (entry.kind !== 'file' || !entry.name.endsWith(JSON_FILE_EXTENSION)) {
        continue;
      }

      keys.push(
        decodePathSegment(entry.name.slice(0, -JSON_FILE_EXTENSION.length)),
      );
    }

    return keys.sort();
  }

  async clear(scope: AsyncStorageNamespaceScope): Promise<void> {
    const root = await this.getRootDir();
    const sessionDir = await getDirectoryHandleIfExists(
      root,
      encodePathSegment(scope.sessionKey),
    );
    if (sessionDir === null) return;

    const storeDir = await getDirectoryHandleIfExists(
      sessionDir,
      encodePathSegment(scope.storeName),
    );
    if (storeDir === null) return;

    try {
      await storeDir.removeEntry(encodePathSegment(scope.kind), {
        recursive: true,
      });
    } catch {
      // Ignore missing scopes.
    }
  }

  resetForTests(): void {
    this.rootDirPromise = null;
  }

  private getFileNameForKey(key: string): string {
    return `${encodePathSegment(key)}${JSON_FILE_EXTENSION}`;
  }

  private async getRootDir(): Promise<FileSystemDirectoryHandle> {
    if (this.rootDirPromise === null) {
      this.rootDirPromise = (async () => {
        const navigatorRoot = await getNavigatorStorageDirectory();
        return navigatorRoot.getDirectoryHandle(OPFS_CACHE_DIR, {
          create: true,
        });
      })();
    }

    return this.rootDirPromise;
  }

  private async getScopeDir(
    scope: AsyncStorageNamespaceScope,
    options: { create: boolean },
  ): Promise<FileSystemDirectoryHandle | null> {
    const root = await this.getRootDir();
    const sessionDir = options.create
      ? await root.getDirectoryHandle(encodePathSegment(scope.sessionKey), {
          create: true,
        })
      : await getDirectoryHandleIfExists(
          root,
          encodePathSegment(scope.sessionKey),
        );
    if (sessionDir === null) return null;

    const storeDir = options.create
      ? await sessionDir.getDirectoryHandle(
          encodePathSegment(scope.storeName),
          { create: true },
        )
      : await getDirectoryHandleIfExists(
          sessionDir,
          encodePathSegment(scope.storeName),
        );
    if (storeDir === null) return null;

    return options.create
      ? storeDir.getDirectoryHandle(encodePathSegment(scope.kind), {
          create: true,
        })
      : getDirectoryHandleIfExists(storeDir, encodePathSegment(scope.kind));
  }
}
