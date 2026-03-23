import { createCache, type Cache } from '@ls-stack/utils/cache';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import {
  buildFileName,
  decodePathSegment,
  encodePathSegment,
  joinPath,
  METADATA_RECORD_PREFIX,
  OPFS_ROOT_DIR,
  parseFileName,
} from './opfsFileNaming';
import type {
  AsyncStorageDiscoveredScope,
  AsyncStorageDriver,
  AsyncStorageDriverSetEntry,
  AsyncStorageNamespaceScope,
} from './types';

const OPFS_DIR_HANDLE_CACHE_MAX_SIZE = 500;
const OPFS_FILE_HANDLE_CACHE_MAX_SIZE = 10_000;
const OPFS_MISSING_HANDLE_CACHE_DURATION = { seconds: 5 } as const;

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

type OpfsDirectoryCache = Cache<FileSystemDirectoryHandle | null>;
type OpfsFileCache = Cache<FileSystemFileHandle | null>;

type OpfsCleanupKnowledge = {
  knownRemainingEntryCountByStorePath: Map<string, number>;
  knownStorePathsBySessionPath: Map<string, Set<string>>;
};

type OpfsCacheContext = {
  cleanupKnowledge: OpfsCleanupKnowledge | null;
  dirCache: OpfsDirectoryCache;
  fileCache: OpfsFileCache;
};

type ScopedDirectoryEntry = { fileName: string; key: string };

type DiscoveredScopeEntry = {
  metadataRecordKeys: string[];
  scope: AsyncStorageNamespaceScope;
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

function getNamespaceId(scope: AsyncStorageNamespaceScope): string {
  return JSON.stringify([scope.sessionKey, scope.storeName, scope.kind]);
}

export class OpfsAsyncStorageDriver implements AsyncStorageDriver {
  #rootDirPromise: Promise<FileSystemDirectoryHandle> | null = null;
  readonly #mainCacheContext: OpfsCacheContext = {
    cleanupKnowledge: null,
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

  async listScopesWithMetadataKeys(
    sessionKey?: string,
  ): Promise<AsyncStorageDiscoveredScope[]> {
    return this.#listDiscoveredScopesWithContext(
      sessionKey,
      this.#mainCacheContext,
    );
  }

  async withIsolatedCleanupDriver<T>(
    callback: (driver: AsyncStorageDriver) => Promise<T>,
  ): Promise<T> {
    const cleanupCacheContext: OpfsCacheContext = {
      cleanupKnowledge: {
        knownRemainingEntryCountByStorePath: new Map(),
        knownStorePathsBySessionPath: new Map(),
      },
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
      listScopesWithMetadataKeys: (currentSessionKey) =>
        this.#listDiscoveredScopesWithContext(currentSessionKey, cacheContext),
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

    await Promise.all(
      entries.map((entry) =>
        this.#writeEntryWithRetry(scope, entry, cacheContext),
      ),
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

    const removeResults = await Promise.all(
      keys.map(async (key) => {
        const fileName = buildFileName(scope, key);
        try {
          await storeDir.removeEntry(fileName);
          return true;
        } catch {
          // Ignore missing records.
          return false;
        } finally {
          this.#invalidateFileHandle(scope, key, cacheContext);
        }
      }),
    );
    this.#decrementKnownStoreEntryCount(
      this.#getStoreDirPath(scope),
      cacheContext,
      removeResults.filter(Boolean).length,
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

    const removeResults = await Promise.all(
      scopedEntries.map(async (entry) => {
        try {
          await storeDir.removeEntry(entry.fileName);
          return true;
        } catch {
          // Ignore missing records.
          return false;
        } finally {
          this.#invalidateFileHandle(scope, entry.key, cacheContext);
        }
      }),
    );
    this.#decrementKnownStoreEntryCount(
      this.#getStoreDirPath(scope),
      cacheContext,
      removeResults.filter(Boolean).length,
    );

    await this.#pruneEmptyDirectories(scope, cacheContext);
  }

  async #listScopesWithContext(
    sessionKey: string | undefined,
    cacheContext: OpfsCacheContext,
  ): Promise<AsyncStorageNamespaceScope[]> {
    const sessionEntries = await this.#getSessionEntries(
      sessionKey,
      cacheContext,
    );
    const discoveredScopes = new Map<string, AsyncStorageNamespaceScope>();

    for (const sessionEntry of sessionEntries) {
      if (sessionEntry.handle === null) continue;

      this.#setKnownSessionStorePaths(
        sessionEntry.path,
        cacheContext,
        new Set(),
      );

      const decodedSessionKey = decodePathSegment(sessionEntry.name);
      const storeEntries = await this.#listDirectoryEntries(
        sessionEntry.handle,
        sessionEntry.path,
        cacheContext,
      );
      this.#setKnownSessionStorePaths(
        sessionEntry.path,
        cacheContext,
        new Set(storeEntries.map((storeEntry) => storeEntry.path)),
      );

      for (const storeEntry of storeEntries) {
        const decodedStoreName = decodePathSegment(storeEntry.name);
        const seenKinds = new Set<AsyncStorageNamespaceScope['kind']>();

        for await (const fileName of storeEntry.handle.keys()) {
          const parsed = parseFileName(fileName);
          if (parsed === null || seenKinds.has(parsed.kind)) continue;

          seenKinds.add(parsed.kind);
          const scope = {
            sessionKey: decodedSessionKey,
            storeName: decodedStoreName,
            kind: parsed.kind,
          } satisfies AsyncStorageNamespaceScope;
          discoveredScopes.set(getNamespaceId(scope), scope);
        }
      }
    }

    return [...discoveredScopes.values()];
  }

  async #listDiscoveredScopesWithContext(
    sessionKey: string | undefined,
    cacheContext: OpfsCacheContext,
  ): Promise<AsyncStorageDiscoveredScope[]> {
    const sessionEntries = await this.#getSessionEntries(
      sessionKey,
      cacheContext,
    );
    const discoveredScopes = new Map<string, DiscoveredScopeEntry>();

    for (const sessionEntry of sessionEntries) {
      if (sessionEntry.handle === null) continue;
      const sessionDir = sessionEntry.handle;

      this.#setKnownSessionStorePaths(
        sessionEntry.path,
        cacheContext,
        new Set(),
      );
      const decodedSessionKey = decodePathSegment(sessionEntry.name);
      const storeEntries = await this.#listDirectoryEntries(
        sessionDir,
        sessionEntry.path,
        cacheContext,
      );
      const storeScanResults = await Promise.all(
        storeEntries.map(async (storeEntry) => {
          const decodedStoreName = decodePathSegment(storeEntry.name);
          const invalidEntryNames: string[] = [];
          let knownEntryCount = 0;
          const discoveredStoreScopes = new Map<string, DiscoveredScopeEntry>();

          for await (const fileName of storeEntry.handle.keys()) {
            const parsed = parseFileName(fileName);
            if (parsed === null) {
              invalidEntryNames.push(fileName);
              continue;
            }
            knownEntryCount += 1;

            const scope = {
              sessionKey: decodedSessionKey,
              storeName: decodedStoreName,
              kind: parsed.kind,
            } satisfies AsyncStorageNamespaceScope;
            const scopeId = getNamespaceId(scope);
            const metadataRecordKey = parsed.key.startsWith(
              METADATA_RECORD_PREFIX,
            )
              ? parsed.key
              : null;
            const existing = discoveredStoreScopes.get(scopeId);
            if (existing !== undefined) {
              if (metadataRecordKey !== null) {
                existing.metadataRecordKeys.push(metadataRecordKey);
              }
              continue;
            }

            discoveredStoreScopes.set(scopeId, {
              metadataRecordKeys:
                metadataRecordKey === null ? [] : [metadataRecordKey],
              scope,
            });
          }

          return {
            scopeEntries: [...discoveredStoreScopes.values()],
            invalidEntryNames,
            knownEntryCount,
            storeEntry,
          };
        }),
      );
      const knownNonEmptyStorePaths = new Set<string>();

      for (const {
        storeEntry,
        invalidEntryNames,
        knownEntryCount,
        scopeEntries,
      } of storeScanResults) {
        await this.#removeInvalidEntries(
          storeEntry.handle,
          invalidEntryNames,
          cacheContext,
        );

        if (knownEntryCount > 0) {
          knownNonEmptyStorePaths.add(storeEntry.path);
        } else if (
          cacheContext.cleanupKnowledge !== null &&
          invalidEntryNames.length > 0
        ) {
          try {
            await sessionDir.removeEntry(storeEntry.name, { recursive: true });
            this.#invalidateDirectory(storeEntry.path, cacheContext);
          } catch {
            // Ignore missing or concurrently changed directories.
          }
        }
        cacheContext.cleanupKnowledge?.knownRemainingEntryCountByStorePath.set(
          storeEntry.path,
          knownEntryCount,
        );

        for (const scopeEntry of scopeEntries) {
          const scopeId = getNamespaceId(scopeEntry.scope);
          const existing = discoveredScopes.get(scopeId);
          if (existing !== undefined) {
            existing.metadataRecordKeys.push(...scopeEntry.metadataRecordKeys);
            continue;
          }

          discoveredScopes.set(scopeId, scopeEntry);
        }
      }
      this.#setKnownSessionStorePaths(
        sessionEntry.path,
        cacheContext,
        knownNonEmptyStorePaths,
      );
      if (
        cacheContext.cleanupKnowledge !== null &&
        knownNonEmptyStorePaths.size === 0
      ) {
        try {
          const root = await this.#getRootDir();
          await root.removeEntry(sessionEntry.name, { recursive: true });
          this.#invalidateDirectory(sessionEntry.path, cacheContext);
          this.#clearKnownSessionStores(sessionEntry.path, cacheContext);
        } catch {
          // Ignore missing or concurrently changed directories.
        }
      }
    }

    const results = [...discoveredScopes.values()];

    for (const entry of results) {
      entry.metadataRecordKeys.sort((left, right) => left.localeCompare(right));
    }

    return results.sort((left, right) => {
      const sessionComparison = left.scope.sessionKey.localeCompare(
        right.scope.sessionKey,
      );
      if (sessionComparison !== 0) return sessionComparison;

      const storeComparison = left.scope.storeName.localeCompare(
        right.scope.storeName,
      );
      if (storeComparison !== 0) return storeComparison;

      return left.scope.kind.localeCompare(right.scope.kind);
    });
  }

  async #getSessionEntries(
    sessionKey: string | undefined,
    cacheContext: OpfsCacheContext,
  ): Promise<
    Array<{
      handle: FileSystemDirectoryHandle | null;
      name: string;
      path: string;
    }>
  > {
    const root = await this.#getRootDir();
    return sessionKey === undefined
      ? await this.#listDirectoryEntries(root, OPFS_ROOT_DIR, cacheContext)
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
  }

  async #getRootDir(): Promise<FileSystemDirectoryHandle> {
    if (this.#rootDirPromise === null) {
      this.#rootDirPromise = (async () => {
        const navigatorRoot = await getNavigatorStorageDirectory();
        return navigatorRoot.getDirectoryHandle(OPFS_ROOT_DIR, {
          create: true,
        });
      })();
    }

    return this.#rootDirPromise;
  }

  #getSessionDirPath(sessionKey: string): string {
    return joinPath(OPFS_ROOT_DIR, encodePathSegment(sessionKey));
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
    return joinPath(this.#getStoreDirPath(scope), buildFileName(scope, key));
  }

  async #getSessionDir(
    sessionKey: string,
    options: { cacheContext: OpfsCacheContext; create: boolean },
  ): Promise<FileSystemDirectoryHandle | null> {
    const root = await this.#getRootDir();
    const sessionDirPath = this.#getSessionDirPath(sessionKey);
    const encodedSessionKey = encodePathSegment(sessionKey);

    if (options.create) {
      const cachedSessionDir = await this.#getCachedHandleForCreate(
        options.cacheContext.dirCache,
        sessionDirPath,
      );
      if (cachedSessionDir !== undefined) return cachedSessionDir;

      return options.cacheContext.dirCache.getOrInsertAsync(
        sessionDirPath,
        async () =>
          root.getDirectoryHandle(encodedSessionKey, { create: true }),
      );
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
      const cachedStoreDir = await this.#getCachedHandleForCreate(
        options.cacheContext.dirCache,
        storeDirPath,
      );
      if (cachedStoreDir !== undefined) return cachedStoreDir;

      return options.cacheContext.dirCache.getOrInsertAsync(
        storeDirPath,
        async () =>
          sessionDir.getDirectoryHandle(encodedStoreName, { create: true }),
      );
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
    const fileName = buildFileName(scope, key);
    const filePath = joinPath(this.#getStoreDirPath(scope), fileName);

    if (options.create) {
      const cachedFileHandle = await this.#getCachedHandleForCreate(
        options.cacheContext.fileCache,
        filePath,
      );
      if (cachedFileHandle !== undefined) return cachedFileHandle;

      return options.cacheContext.fileCache.getOrInsertAsync(
        filePath,
        async () => options.storeDir.getFileHandle(fileName, { create: true }),
      );
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
      const parsed = parseFileName(entry.name);
      if (parsed === null || parsed.kind !== scope.kind) continue;

      scopedEntries.push({ fileName: entry.name, key: parsed.key });
    }

    return scopedEntries.sort((left, right) =>
      left.key.localeCompare(right.key),
    );
  }

  async #getCachedHandleForCreate<THandle extends FileSystemHandle>(
    cache: Cache<THandle | null>,
    path: string,
  ): Promise<THandle | undefined> {
    const cachedHandle = await cache.getAsync(path);
    if (cachedHandle === undefined) return undefined;
    // A cached null means a prior read (create: false) cached a "not found" result.
    // Evict it so the subsequent getOrInsertAsync will create the handle.
    if (cachedHandle === null) {
      cache.delete(path);
      return undefined;
    }

    return cachedHandle;
  }

  async #writeEntryWithRetry(
    scope: AsyncStorageNamespaceScope,
    entry: AsyncStorageDriverSetEntry,
    cacheContext: OpfsCacheContext,
  ): Promise<void> {
    let firstError: unknown;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const storeDir = await this.#getStoreDir(scope, {
          create: true,
          cacheContext,
        });
        if (storeDir === null) {
          throw new Error('[TSDF] Failed to open OPFS store directory.');
        }

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
        return;
      } catch (error) {
        if (attempt > 0) {
          throw firstError;
        }

        firstError = error;
        this.#invalidateFileHandle(scope, entry.key, cacheContext);
        this.#invalidateDirectory(this.#getStoreDirPath(scope), cacheContext);
        this.#invalidateDirectory(
          this.#getSessionDirPath(scope.sessionKey),
          cacheContext,
        );
      }
    }
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

    const knownStoreEntryCount =
      cacheContext.cleanupKnowledge?.knownRemainingEntryCountByStorePath.get(
        storeDirPath,
      );
    if (knownStoreEntryCount !== undefined && knownStoreEntryCount > 0) return;

    let removedStoreDir = false;
    try {
      await sessionDir.removeEntry(encodePathSegment(scope.storeName), {
        recursive: cacheContext.cleanupKnowledge !== null,
      });
      removedStoreDir = true;
    } catch {
      // Ignore missing or non-empty directories.
    } finally {
      if (removedStoreDir) {
        this.#invalidateDirectory(storeDirPath, cacheContext);
        cacheContext.cleanupKnowledge?.knownStorePathsBySessionPath
          .get(sessionDirPath)
          ?.delete(storeDirPath);
        cacheContext.cleanupKnowledge?.knownRemainingEntryCountByStorePath.delete(
          storeDirPath,
        );
      }
    }
    if (!removedStoreDir) return;

    const knownStorePaths =
      cacheContext.cleanupKnowledge?.knownStorePathsBySessionPath.get(
        sessionDirPath,
      );
    if (knownStorePaths !== undefined && knownStorePaths.size > 0) return;

    let removedSessionDir = false;
    try {
      await root.removeEntry(encodePathSegment(scope.sessionKey), {
        recursive: cacheContext.cleanupKnowledge !== null,
      });
      removedSessionDir = true;
    } catch {
      // Ignore missing or non-empty directories.
    } finally {
      if (removedSessionDir) {
        this.#invalidateDirectory(sessionDirPath, cacheContext);
        this.#clearKnownSessionStores(sessionDirPath, cacheContext);
      }
    }
  }

  #setKnownSessionStorePaths(
    sessionDirPath: string,
    cacheContext: OpfsCacheContext,
    storePaths: Set<string>,
  ): void {
    cacheContext.cleanupKnowledge?.knownStorePathsBySessionPath.set(
      sessionDirPath,
      storePaths,
    );
  }

  #decrementKnownStoreEntryCount(
    storeDirPath: string,
    cacheContext: OpfsCacheContext,
    removedEntryCount: number,
  ): void {
    if (removedEntryCount === 0) return;

    const cleanupKnowledge = cacheContext.cleanupKnowledge;
    if (cleanupKnowledge === null) return;

    const knownEntryCount =
      cleanupKnowledge.knownRemainingEntryCountByStorePath.get(storeDirPath);
    if (knownEntryCount === undefined) return;

    cleanupKnowledge.knownRemainingEntryCountByStorePath.set(
      storeDirPath,
      Math.max(0, knownEntryCount - removedEntryCount),
    );
  }

  #clearKnownSessionStores(
    sessionDirPath: string,
    cacheContext: OpfsCacheContext,
  ): void {
    cacheContext.cleanupKnowledge?.knownStorePathsBySessionPath.delete(
      sessionDirPath,
    );
  }

  async #removeInvalidEntries(
    dir: FileSystemDirectoryHandle,
    invalidEntryNames: string[],
    cacheContext: OpfsCacheContext,
  ): Promise<void> {
    if (
      cacheContext.cleanupKnowledge === null ||
      invalidEntryNames.length === 0
    ) {
      return;
    }

    await Promise.all(
      invalidEntryNames.map(async (entryName) => {
        try {
          await dir.removeEntry(entryName, { recursive: true });
        } catch {
          // Ignore missing or concurrently changed entries.
        }
      }),
    );
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
    const invalidEntryNames: string[] = [];

    for await (const entry of dir.values()) {
      if (entry.kind !== 'directory') {
        invalidEntryNames.push(entry.name);
        continue;
      }
      const dirHandle = __LEGIT_CAST__<
        FileSystemDirectoryHandle,
        FileSystemHandle
      >(entry);
      const path = joinPath(parentPath, entry.name);
      cacheContext.dirCache.set(path, dirHandle);
      entries.push({ handle: dirHandle, name: entry.name, path });
    }

    await this.#removeInvalidEntries(dir, invalidEntryNames, cacheContext);

    entries.sort((left, right) => left.name.localeCompare(right.name));
    return entries;
  }
}
