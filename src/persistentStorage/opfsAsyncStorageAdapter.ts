import { createCache, type Cache } from '@ls-stack/utils/cache';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import type {
  AsyncStorageDriver,
  AsyncStorageDriverSetEntry,
  AsyncStorageNamespaceScope,
} from './types';
import { parseAsyncStorageNamespaceKind } from './types';

const OPFS_CACHE_DIR = 'tsdf';
const JSON_FILE_EXTENSION = '.json';
const OPFS_FILE_NAME_KIND_SEPARATOR = '~';
const OPFS_DIR_HANDLE_CACHE_MAX_SIZE = 500;
const OPFS_FILE_HANDLE_CACHE_MAX_SIZE = 10_000;
const OPFS_MISSING_HANDLE_CACHE_DURATION = { seconds: 5 } as const;

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

function joinPath(...segments: string[]): string {
  return segments.filter((segment) => segment.length > 0).join('/');
}

type OpfsDirectoryCache = Cache<FileSystemDirectoryHandle | null>;
type OpfsFileCache = Cache<FileSystemFileHandle | null>;

type OpfsCacheContext = {
  dirCache: OpfsDirectoryCache;
  fileCache: OpfsFileCache;
};

type ScopedDirectoryEntry = {
  fileName: string;
  handle: FileSystemFileHandle;
  key: string;
};

type CacheUtilsWithExpiration<T> = {
  withExpiration: (
    value: T | null,
    expiration: typeof OPFS_MISSING_HANDLE_CACHE_DURATION,
  ) => unknown;
};

function withExpiringNull<T extends FileSystemHandle>(
  utils: CacheUtilsWithExpiration<T>,
): T | null {
  return __LEGIT_CAST__<T | null, unknown>(
    utils.withExpiration(null, OPFS_MISSING_HANDLE_CACHE_DURATION),
  );
}

export class OpfsAsyncStorageDriver implements AsyncStorageDriver {
  #rootDirPromise: Promise<FileSystemDirectoryHandle> | null = null;
  readonly #mainCacheContext: OpfsCacheContext = {
    dirCache: createCache<FileSystemDirectoryHandle | null>({
      maxCacheSize: OPFS_DIR_HANDLE_CACHE_MAX_SIZE,
    }),
    fileCache: createCache<FileSystemFileHandle | null>({
      maxCacheSize: OPFS_FILE_HANDLE_CACHE_MAX_SIZE,
    }),
  };

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
    return this.#getManyWithContext(scope, keys, this.#mainCacheContext);
  }

  async setMany(
    scope: AsyncStorageNamespaceScope,
    entries: AsyncStorageDriverSetEntry[],
  ): Promise<void> {
    await this.#setManyWithContext(scope, entries, this.#mainCacheContext);
  }

  async removeMany(
    scope: AsyncStorageNamespaceScope,
    keys: string[],
  ): Promise<void> {
    await this.#removeManyWithContext(scope, keys, this.#mainCacheContext);
  }

  async listKeys(scope: AsyncStorageNamespaceScope): Promise<string[]> {
    return this.#listKeysWithContext(scope, this.#mainCacheContext);
  }

  async clear(scope: AsyncStorageNamespaceScope): Promise<void> {
    await this.#clearWithContext(scope, this.#mainCacheContext);
  }

  async listScopes(sessionKey?: string): Promise<AsyncStorageNamespaceScope[]> {
    return this.#listScopesWithContext(sessionKey, this.#mainCacheContext);
  }

  async withIsolatedCleanupDriver<T>(
    callback: (driver: AsyncStorageDriver) => Promise<T>,
  ): Promise<T> {
    const cleanupCacheContext: OpfsCacheContext = {
      dirCache: this.#mainCacheContext.dirCache.clone(),
      fileCache: this.#mainCacheContext.fileCache.clone(),
    };

    return callback(this.#createScopedDriver(cleanupCacheContext));
  }

  resetForTests(): void {
    this.#rootDirPromise = null;
    this.#mainCacheContext.dirCache.clear();
    this.#mainCacheContext.fileCache.clear();
  }

  #createScopedDriver(cacheContext: OpfsCacheContext): AsyncStorageDriver {
    return {
      get: (scope, key) =>
        this.#getManyWithContext(scope, [key], cacheContext).then(
          ([value]) => value ?? null,
        ),
      set: (scope, key, value) =>
        this.#setManyWithContext(scope, [{ key, value }], cacheContext),
      remove: (scope, key) =>
        this.#removeManyWithContext(scope, [key], cacheContext),
      listKeys: (scope) => this.#listKeysWithContext(scope, cacheContext),
      clear: (scope) => this.#clearWithContext(scope, cacheContext),
      listScopes: (currentSessionKey) =>
        this.#listScopesWithContext(currentSessionKey, cacheContext),
      getMany: (scope, keys) =>
        this.#getManyWithContext(scope, keys, cacheContext),
      setMany: (scope, entries) =>
        this.#setManyWithContext(scope, entries, cacheContext),
      removeMany: (scope, keys) =>
        this.#removeManyWithContext(scope, keys, cacheContext),
    };
  }

  async #getManyWithContext(
    scope: AsyncStorageNamespaceScope,
    keys: string[],
    cacheContext: OpfsCacheContext,
  ): Promise<unknown[]> {
    if (keys.length === 0) return [];

    const storeDir = await this.#getStoreDir(scope, {
      create: false,
      cacheContext,
    });
    if (storeDir === null) {
      return keys.map(() => null);
    }

    return Promise.all(
      keys.map(async (key) => {
        const fileHandle = await this.#getFileHandle(scope, key, {
          create: false,
          cacheContext,
          storeDir,
        });
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

  async #setManyWithContext(
    scope: AsyncStorageNamespaceScope,
    entries: AsyncStorageDriverSetEntry[],
    cacheContext: OpfsCacheContext,
  ): Promise<void> {
    if (entries.length === 0) return;

    const storeDir = await this.#getStoreDir(scope, {
      create: true,
      cacheContext,
    });
    if (storeDir === null) {
      throw new Error('[TSDF] Failed to open OPFS store directory.');
    }

    await Promise.all(
      entries.map(async (entry) => {
        const fileHandle = await this.#getFileHandle(scope, entry.key, {
          create: true,
          cacheContext,
          storeDir,
        });
        if (fileHandle === null) {
          throw new Error('[TSDF] Failed to open OPFS file handle.');
        }
        const writable = await fileHandle.createWritable();

        try {
          await writable.write(JSON.stringify(entry.value));
        } finally {
          await writable.close();
        }
      }),
    );
  }

  async #removeManyWithContext(
    scope: AsyncStorageNamespaceScope,
    keys: string[],
    cacheContext: OpfsCacheContext,
  ): Promise<void> {
    if (keys.length === 0) return;

    const storeDir = await this.#getStoreDir(scope, {
      create: false,
      cacheContext,
    });
    if (storeDir === null) return;

    await Promise.all(
      keys.map(async (key) => {
        const fileName = this.#getFileNameForKey(scope, key);
        try {
          await storeDir.removeEntry(fileName);
        } catch {
          // Ignore missing records.
        } finally {
          this.#invalidateFileHandle(scope, key, cacheContext);
        }
      }),
    );

    await this.#pruneEmptyDirectories(scope, cacheContext);
  }

  async #listKeysWithContext(
    scope: AsyncStorageNamespaceScope,
    cacheContext: OpfsCacheContext,
  ): Promise<string[]> {
    const entries = await this.#listScopedFiles(scope, cacheContext);
    return entries
      .map((entry) => entry.key)
      .sort((left, right) => left.localeCompare(right));
  }

  async #clearWithContext(
    scope: AsyncStorageNamespaceScope,
    cacheContext: OpfsCacheContext,
  ): Promise<void> {
    const storeDir = await this.#getStoreDir(scope, {
      create: false,
      cacheContext,
    });
    if (storeDir === null) return;

    const scopedEntries = await this.#listScopedFiles(scope, cacheContext);

    await Promise.all(
      scopedEntries.map(async (entry) => {
        try {
          await storeDir.removeEntry(entry.fileName);
        } catch {
          // Ignore missing records.
        } finally {
          this.#invalidateFileHandle(scope, entry.key, cacheContext);
        }
      }),
    );

    await this.#pruneEmptyDirectories(scope, cacheContext);
  }

  async #listScopesWithContext(
    sessionKey: string | undefined,
    cacheContext: OpfsCacheContext,
  ): Promise<AsyncStorageNamespaceScope[]> {
    const root = await this.#getRootDir();
    const sessionEntries =
      sessionKey === undefined
        ? await this.#listDirectoryEntries(root, OPFS_CACHE_DIR, cacheContext)
        : [
            {
              handle: await this.#getSessionDir(sessionKey, {
                create: false,
                cacheContext,
              }),
              name: encodePathSegment(sessionKey),
              path: this.#getSessionDirPath(sessionKey),
            },
          ];
    const discoveredScopes = new Map<string, AsyncStorageNamespaceScope>();

    for (const sessionEntry of sessionEntries) {
      if (sessionEntry.handle === null) continue;

      const decodedSessionKey = decodePathSegment(sessionEntry.name);
      const storeEntries = await this.#listDirectoryEntries(
        sessionEntry.handle,
        sessionEntry.path,
        cacheContext,
      );

      for (const storeEntry of storeEntries) {
        const decodedStoreName = decodePathSegment(storeEntry.name);
        const seenKinds = new Set<AsyncStorageNamespaceScope['kind']>();

        for await (const entry of storeEntry.handle.values()) {
          if (entry.kind !== 'file') continue;
          const parsed = this.#parseFileName(entry.name);
          if (parsed === null || seenKinds.has(parsed.kind)) continue;

          seenKinds.add(parsed.kind);
          const scope = {
            sessionKey: decodedSessionKey,
            storeName: decodedStoreName,
            kind: parsed.kind,
          } satisfies AsyncStorageNamespaceScope;
          discoveredScopes.set(
            JSON.stringify([scope.sessionKey, scope.storeName, scope.kind]),
            scope,
          );
        }
      }
    }

    return [...discoveredScopes.values()];
  }

  #getFileNameForKey(scope: AsyncStorageNamespaceScope, key: string): string {
    return `${encodePathSegment(scope.kind)}${OPFS_FILE_NAME_KIND_SEPARATOR}${encodePathSegment(key)}${JSON_FILE_EXTENSION}`;
  }

  async #getRootDir(): Promise<FileSystemDirectoryHandle> {
    if (this.#rootDirPromise === null) {
      this.#rootDirPromise = (async () => {
        const navigatorRoot = await getNavigatorStorageDirectory();
        return navigatorRoot.getDirectoryHandle(OPFS_CACHE_DIR, {
          create: true,
        });
      })();
    }

    return this.#rootDirPromise;
  }

  #getSessionDirPath(sessionKey: string): string {
    return joinPath(OPFS_CACHE_DIR, encodePathSegment(sessionKey));
  }

  #getStoreDirPath(
    scope: Pick<AsyncStorageNamespaceScope, 'sessionKey' | 'storeName'>,
  ): string {
    return joinPath(
      this.#getSessionDirPath(scope.sessionKey),
      encodePathSegment(scope.storeName),
    );
  }

  #getFilePath(scope: AsyncStorageNamespaceScope, key: string): string {
    return joinPath(
      this.#getStoreDirPath(scope),
      this.#getFileNameForKey(scope, key),
    );
  }

  #parseFileName(
    fileName: string,
  ): { key: string; kind: AsyncStorageNamespaceScope['kind'] } | null {
    if (!fileName.endsWith(JSON_FILE_EXTENSION)) return null;

    const encoded = fileName.slice(0, -JSON_FILE_EXTENSION.length);
    const separatorIndex = encoded.indexOf(OPFS_FILE_NAME_KIND_SEPARATOR);
    if (separatorIndex <= 0) return null;

    const kind = parseAsyncStorageNamespaceKind(
      decodePathSegment(encoded.slice(0, separatorIndex)),
    );
    if (kind === null) return null;

    return {
      kind,
      key: decodePathSegment(
        encoded.slice(separatorIndex + OPFS_FILE_NAME_KIND_SEPARATOR.length),
      ),
    };
  }

  async #getSessionDir(
    sessionKey: string,
    options: { cacheContext: OpfsCacheContext; create: boolean },
  ): Promise<FileSystemDirectoryHandle | null> {
    const root = await this.#getRootDir();
    const sessionDirPath = this.#getSessionDirPath(sessionKey);
    const encodedSessionKey = encodePathSegment(sessionKey);

    if (options.create) {
      options.cacheContext.dirCache.delete(sessionDirPath);
      const sessionDir = await root.getDirectoryHandle(encodedSessionKey, {
        create: true,
      });
      options.cacheContext.dirCache.set(sessionDirPath, sessionDir);
      return sessionDir;
    }

    return options.cacheContext.dirCache.getOrInsertAsync(
      sessionDirPath,
      async (utils) => {
        const sessionDir = await getDirectoryHandleIfExists(
          root,
          encodedSessionKey,
        );
        return sessionDir ?? withExpiringNull<FileSystemDirectoryHandle>(utils);
      },
    );
  }

  async #getStoreDir(
    scope: Pick<AsyncStorageNamespaceScope, 'sessionKey' | 'storeName'>,
    options: { cacheContext: OpfsCacheContext; create: boolean },
  ): Promise<FileSystemDirectoryHandle | null> {
    const sessionDir = await this.#getSessionDir(scope.sessionKey, options);
    if (sessionDir === null) return null;

    const storeDirPath = this.#getStoreDirPath(scope);
    const encodedStoreName = encodePathSegment(scope.storeName);

    if (options.create) {
      options.cacheContext.dirCache.delete(storeDirPath);
      const storeDir = await sessionDir.getDirectoryHandle(encodedStoreName, {
        create: true,
      });
      options.cacheContext.dirCache.set(storeDirPath, storeDir);
      return storeDir;
    }

    return options.cacheContext.dirCache.getOrInsertAsync(
      storeDirPath,
      async (utils) => {
        const storeDir = await getDirectoryHandleIfExists(
          sessionDir,
          encodedStoreName,
        );
        return storeDir ?? withExpiringNull<FileSystemDirectoryHandle>(utils);
      },
    );
  }

  async #getFileHandle(
    scope: AsyncStorageNamespaceScope,
    key: string,
    options: {
      cacheContext: OpfsCacheContext;
      create: boolean;
      storeDir: FileSystemDirectoryHandle;
    },
  ): Promise<FileSystemFileHandle | null> {
    const filePath = this.#getFilePath(scope, key);
    const fileName = this.#getFileNameForKey(scope, key);

    if (options.create) {
      options.cacheContext.fileCache.delete(filePath);
      const fileHandle = await options.storeDir.getFileHandle(fileName, {
        create: true,
      });
      options.cacheContext.fileCache.set(filePath, fileHandle);
      return fileHandle;
    }

    return options.cacheContext.fileCache.getOrInsertAsync(
      filePath,
      async (utils) => {
        const fileHandle = await getFileHandleIfExists(
          options.storeDir,
          fileName,
        );
        return fileHandle ?? withExpiringNull<FileSystemFileHandle>(utils);
      },
    );
  }

  async #listScopedFiles(
    scope: AsyncStorageNamespaceScope,
    cacheContext: OpfsCacheContext,
  ): Promise<ScopedDirectoryEntry[]> {
    const storeDir = await this.#getStoreDir(scope, {
      create: false,
      cacheContext,
    });
    if (storeDir === null) return [];

    const scopedEntries: ScopedDirectoryEntry[] = [];
    for await (const entry of storeDir.values()) {
      if (entry.kind !== 'file') continue;
      const parsed = this.#parseFileName(entry.name);
      if (parsed === null || parsed.kind !== scope.kind) continue;

      const fileHandle = await this.#getFileHandle(scope, parsed.key, {
        create: false,
        cacheContext,
        storeDir,
      });
      if (fileHandle === null) continue;

      scopedEntries.push({
        fileName: entry.name,
        handle: fileHandle,
        key: parsed.key,
      });
    }

    return scopedEntries.sort((left, right) =>
      left.key.localeCompare(right.key),
    );
  }

  #invalidateFileHandle(
    scope: AsyncStorageNamespaceScope,
    key: string,
    cacheContext: OpfsCacheContext,
  ): void {
    const filePath = this.#getFilePath(scope, key);
    cacheContext.fileCache.delete(filePath);
    if (cacheContext !== this.#mainCacheContext) {
      this.#mainCacheContext.fileCache.delete(filePath);
    }
  }

  #invalidateDirectory(path: string, cacheContext: OpfsCacheContext): void {
    cacheContext.dirCache.delete(path);
    if (cacheContext !== this.#mainCacheContext) {
      this.#mainCacheContext.dirCache.delete(path);
    }
  }

  async #pruneEmptyDirectories(
    scope: Pick<AsyncStorageNamespaceScope, 'sessionKey' | 'storeName'>,
    cacheContext: OpfsCacheContext,
  ): Promise<void> {
    const root = await this.#getRootDir();
    const sessionDirPath = this.#getSessionDirPath(scope.sessionKey);
    const storeDirPath = this.#getStoreDirPath(scope);
    const sessionDir = await this.#getSessionDir(scope.sessionKey, {
      create: false,
      cacheContext,
    });
    if (sessionDir === null) return;

    const storeDir = await this.#getStoreDir(scope, {
      create: false,
      cacheContext,
    });
    if (storeDir !== null && (await this.#isDirectoryEmpty(storeDir))) {
      try {
        await sessionDir.removeEntry(encodePathSegment(scope.storeName));
      } catch {
        // Ignore missing or non-empty directories.
      } finally {
        this.#invalidateDirectory(storeDirPath, cacheContext);
      }
    }

    const refreshedSessionDir = await this.#getSessionDir(scope.sessionKey, {
      create: false,
      cacheContext,
    });
    if (
      refreshedSessionDir === null ||
      !(await this.#isDirectoryEmpty(refreshedSessionDir))
    ) {
      return;
    }

    try {
      await root.removeEntry(encodePathSegment(scope.sessionKey));
    } catch {
      // Ignore missing or non-empty directories.
    } finally {
      this.#invalidateDirectory(sessionDirPath, cacheContext);
    }
  }

  async #listDirectoryEntries(
    dir: FileSystemDirectoryHandle,
    parentPath: string,
    cacheContext: OpfsCacheContext,
  ): Promise<
    Array<{ handle: FileSystemDirectoryHandle; name: string; path: string }>
  > {
    const entries: Array<{
      handle: FileSystemDirectoryHandle;
      name: string;
      path: string;
    }> = [];

    for await (const entry of dir.values()) {
      if (entry.kind !== 'directory') continue;
      const path = joinPath(parentPath, entry.name);
      cacheContext.dirCache.set(path, entry);
      entries.push({ handle: entry, name: entry.name, path });
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    return entries;
  }

  async #isDirectoryEmpty(dir: FileSystemDirectoryHandle): Promise<boolean> {
    for await (const _entry of dir.values()) {
      return false;
    }

    return true;
  }
}
