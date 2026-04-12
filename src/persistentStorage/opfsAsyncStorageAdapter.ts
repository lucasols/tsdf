import { createCache, type Cache } from '@ls-stack/utils/cache';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { isObject } from '@ls-stack/utils/typeGuards';
import {
  ASYNC_NAMESPACE_INDEX_RECORD_KEY,
  getNamespaceId,
  getPayloadRecordKey,
} from './asyncStorageShared';
import {
  buildFileName,
  decodePathSegment,
  encodePathSegment,
  joinPath,
  OPFS_ROOT_DIR,
  parseFileNameInfo,
  resolveHashedPayloadRecordKeyFromValue,
} from './opfsFileNaming';
import {
  getDirectoryHandleIfExists,
  getFileHandleIfExists,
  getNavigatorStorageDirectory,
} from './opfsHelpers';
import type {
  AsyncStorageDiscoveredScope,
  AsyncStorageDriver,
  AsyncStorageDriverSetEntry,
  AsyncStorageNamespaceScope,
} from './types';

const OPFS_DIR_HANDLE_CACHE_MAX_SIZE = 500;
const OPFS_FILE_HANDLE_CACHE_MAX_SIZE = 10_000;

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
  readValueCache: Map<string, unknown> | null;
};

type ScopedDirectoryEntry = { fileName: string; key: string };

type DiscoveredScopeEntry = {
  knownRecordKeys: string[];
  scope: AsyncStorageNamespaceScope;
};

type ParsedScopedFileInfo = {
  fileHandle: FileSystemFileHandle;
  fileName: string;
  filePath: string;
  isHashedPayload: boolean;
  key: string | null;
};

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
    readValueCache: null,
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

  async listScopesWithKnownRecordKeys(
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
      // cloning cache instead of reusing because cleanup does a full scan of storage, which would populate the cache with items that might not be relevant to the current app usage
      dirCache: this.#mainCacheContext.dirCache.clone(),
      fileCache: this.#mainCacheContext.fileCache.clone(),
      readValueCache: new Map(),
    };

    return callback(this.#createScopedDriver(cleanupCacheContext));
  }

  async cleanupRemoveKnownRecords(
    scope: AsyncStorageNamespaceScope,
    keys: string[],
  ): Promise<string[]> {
    return this.#cleanupRemoveKnownRecordsWithContext(
      scope,
      keys,
      this.#mainCacheContext,
    );
  }

  async cleanupRemoveKnownStoreDir(
    scope: AsyncStorageNamespaceScope,
    keys: string[],
  ): Promise<boolean> {
    return this.#cleanupRemoveKnownStoreDirWithContext(
      scope,
      keys,
      this.#mainCacheContext,
    );
  }

  async cleanupRemoveKnownSessionDir(sessionKey: string): Promise<boolean> {
    return this.#cleanupRemoveKnownSessionDirWithContext(
      sessionKey,
      this.#mainCacheContext,
    );
  }

  cleanupFinalizeRemovedRecords(
    scope: AsyncStorageNamespaceScope,
    removedKeys: string[],
  ): void {
    this.#cleanupFinalizeRemovedRecordsWithContext(
      scope,
      removedKeys,
      this.#mainCacheContext,
    );
  }

  cleanupFinalizeRemovedStoreDir(
    scope: AsyncStorageNamespaceScope,
    removedKeys: string[],
  ): void {
    this.#cleanupFinalizeRemovedStoreDirWithContext(
      scope,
      removedKeys,
      this.#mainCacheContext,
    );
  }

  cleanupFinalizeRemovedSessionDir(sessionKey: string): void {
    this.#cleanupFinalizeRemovedSessionDirWithContext(
      sessionKey,
      this.#mainCacheContext,
    );
  }

  __resetForTests(): void {
    this.#rootDirPromise = null;
    this.#mainCacheContext.dirCache.clear();
    this.#mainCacheContext.fileCache.clear();
  }

  #createScopedDriver(cacheContext: OpfsCacheContext): AsyncStorageDriver {
    const scopedDriver = {
      cleanupFinalizeRemovedRecords: (
        scope: AsyncStorageNamespaceScope,
        removedKeys: string[],
      ) =>
        this.#cleanupFinalizeRemovedRecordsWithContext(
          scope,
          removedKeys,
          cacheContext,
        ),
      cleanupFinalizeRemovedSessionDir: (sessionKey: string) =>
        this.#cleanupFinalizeRemovedSessionDirWithContext(
          sessionKey,
          cacheContext,
        ),
      cleanupFinalizeRemovedStoreDir: (
        scope: AsyncStorageNamespaceScope,
        removedKeys: string[],
      ) =>
        this.#cleanupFinalizeRemovedStoreDirWithContext(
          scope,
          removedKeys,
          cacheContext,
        ),
      cleanupRemoveKnownRecords: (
        scope: AsyncStorageNamespaceScope,
        keys: string[],
      ) =>
        this.#cleanupRemoveKnownRecordsWithContext(scope, keys, cacheContext),
      cleanupRemoveKnownSessionDir: (sessionKey: string) =>
        this.#cleanupRemoveKnownSessionDirWithContext(sessionKey, cacheContext),
      cleanupRemoveKnownStoreDir: (
        scope: AsyncStorageNamespaceScope,
        keys: string[],
      ) =>
        this.#cleanupRemoveKnownStoreDirWithContext(scope, keys, cacheContext),
      get: (scope: AsyncStorageNamespaceScope, key: string) =>
        this.#getManyWithContext(scope, [key], cacheContext).then(
          ([value]) => value ?? null,
        ),
      set: (scope: AsyncStorageNamespaceScope, key: string, value: unknown) =>
        this.#setManyWithContext(scope, [{ key, value }], cacheContext),
      remove: (scope: AsyncStorageNamespaceScope, key: string) =>
        this.#removeManyWithContext(scope, [key], cacheContext),
      listKeys: (scope: AsyncStorageNamespaceScope) =>
        this.#listKeysWithContext(scope, cacheContext),
      clear: (scope: AsyncStorageNamespaceScope) =>
        this.#clearWithContext(scope, cacheContext),
      listScopes: (currentSessionKey?: string) =>
        this.#listScopesWithContext(currentSessionKey, cacheContext),
      listScopesWithKnownRecordKeys: (currentSessionKey?: string) =>
        this.#listDiscoveredScopesWithContext(currentSessionKey, cacheContext),
      getMany: (scope: AsyncStorageNamespaceScope, keys: string[]) =>
        this.#getManyWithContext(scope, keys, cacheContext),
      setMany: (
        scope: AsyncStorageNamespaceScope,
        entries: AsyncStorageDriverSetEntry[],
      ) => this.#setManyWithContext(scope, entries, cacheContext),
      removeMany: (scope: AsyncStorageNamespaceScope, keys: string[]) =>
        this.#removeManyWithContext(scope, keys, cacheContext),
    };
    return scopedDriver;
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
        return this.#readJsonFile(
          this.#getFilePath(scope, key),
          fileHandle,
          cacheContext,
        );
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
    const uniqueKeys = [...new Set(keys)];
    if (uniqueKeys.length === 0) return;

    const storeDir = await this.#getStoreDir(scope, {
      create: false,
      cacheContext,
    });
    if (storeDir === null) return;

    if (
      await this.#removeWholeStoreDirIfAllKnownEntriesAreBeingRemoved(
        scope,
        uniqueKeys,
        cacheContext,
      )
    ) {
      return;
    }

    const removeResults = await Promise.all(
      uniqueKeys.map(async (key) => {
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

    if (!this.#shouldPruneStoreDirAfterRemovingKeys(uniqueKeys, cacheContext)) {
      return;
    }

    await this.#pruneEmptyDirectories(scope, cacheContext);
  }

  async #listKeysWithContext(
    scope: AsyncStorageNamespaceScope,
    cacheContext: OpfsCacheContext,
  ): Promise<string[]> {
    const { resolvedEntries } = await this.#listScopedFiles(
      scope,
      cacheContext,
    );
    return resolvedEntries
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

    const { allFileNames, resolvedEntries } = await this.#listScopedFiles(
      scope,
      cacheContext,
    );
    const keys = resolvedEntries.map((entry) => entry.key);

    if (
      allFileNames.length === keys.length &&
      (await this.#removeWholeStoreDirIfAllKnownEntriesAreBeingRemoved(
        scope,
        keys,
        cacheContext,
      ))
    ) {
      return;
    }

    const storeDirPath = this.#getStoreDirPath(scope);
    const removeResults = await Promise.all(
      allFileNames.map(async (fileName) => {
        try {
          await storeDir.removeEntry(fileName);
          return true;
        } catch {
          // Ignore missing records.
          return false;
        } finally {
          this.#invalidateFilePath(
            joinPath(storeDirPath, fileName),
            cacheContext,
          );
        }
      }),
    );
    this.#decrementKnownStoreEntryCount(
      storeDirPath,
      cacheContext,
      removeResults.filter(Boolean).length,
    );

    await this.#pruneEmptyDirectories(scope, cacheContext);
  }

  async #listScopesWithContext(
    sessionKey: string | undefined,
    cacheContext: OpfsCacheContext,
  ): Promise<AsyncStorageNamespaceScope[]> {
    return (
      await this.#listDiscoveredScopesWithContext(sessionKey, cacheContext)
    ).map(({ scope }) => scope);
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
          return {
            ...(await this.#scanStoreScopeEntries(
              storeEntry.handle,
              decodedSessionKey,
              decodedStoreName,
              cacheContext,
            )),
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
            existing.knownRecordKeys.push(...scopeEntry.knownRecordKeys);
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
      entry.knownRecordKeys.sort((left, right) => left.localeCompare(right));
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

  async #scanStoreScopeEntries(
    storeDir: FileSystemDirectoryHandle,
    sessionKey: string,
    storeName: string,
    cacheContext: OpfsCacheContext,
  ): Promise<{
    invalidEntryNames: string[];
    knownEntryCount: number;
    scopeEntries: DiscoveredScopeEntry[];
  }> {
    const invalidEntryNames: string[] = [];
    const storeDirPath = this.#getStoreDirPath({ sessionKey, storeName });
    const filesByKind = new Map<
      AsyncStorageNamespaceScope['kind'],
      ParsedScopedFileInfo[]
    >();

    for await (const [fileName, entryHandle] of storeDir.entries()) {
      if (entryHandle.kind !== 'file') {
        invalidEntryNames.push(fileName);
        continue;
      }

      const parsed = parseFileNameInfo(fileName);
      if (parsed === null) {
        invalidEntryNames.push(fileName);
        continue;
      }

      const fileHandle =
        // WORKAROUND: This branch only keeps file handles, but the DOM iterator still exposes the broader FileSystemHandle union.
        __LEGIT_CAST__<FileSystemFileHandle, FileSystemHandle>(entryHandle);
      const nextEntries = filesByKind.get(parsed.kind) ?? [];
      nextEntries.push({
        fileHandle,
        fileName,
        filePath: joinPath(storeDirPath, fileName),
        isHashedPayload: parsed.isHashedPayload,
        key: parsed.key,
      });
      filesByKind.set(parsed.kind, nextEntries);
    }

    const scopeEntries: DiscoveredScopeEntry[] = [];
    let knownEntryCount = 0;

    for (const [kind, files] of filesByKind) {
      const scope = {
        sessionKey,
        storeName,
        kind,
      } satisfies AsyncStorageNamespaceScope;
      const knownRecordKeys: string[] = [];
      const hashedPayloadFiles = files.filter((file) => file.isHashedPayload);
      let scopeKnownEntryCount = 0;
      let indexFilePath: string | null = null;
      let indexHandle: FileSystemFileHandle | null = null;

      for (const file of files) {
        if (file.isHashedPayload || file.key === null) continue;

        knownRecordKeys.push(file.key);
        scopeKnownEntryCount += 1;

        if (file.key === ASYNC_NAMESPACE_INDEX_RECORD_KEY) {
          indexHandle = file.fileHandle;
          indexFilePath = file.filePath;
          cacheContext.fileCache.set(
            this.#getFilePath(scope, file.key),
            file.fileHandle,
          );
        }
      }

      if (hashedPayloadFiles.length > 0) {
        const resolvedHashedFiles = await this.#resolveHashedScopedFiles(
          scope,
          hashedPayloadFiles,
          indexHandle,
          indexFilePath,
          cacheContext,
        );
        knownRecordKeys.push(
          ...resolvedHashedFiles.resolvedEntries.map((entry) => entry.key),
        );
        scopeKnownEntryCount += resolvedHashedFiles.resolvedEntries.length;
        invalidEntryNames.push(...resolvedHashedFiles.invalidEntryNames);
      }

      if (scopeKnownEntryCount === 0) continue;

      knownEntryCount += scopeKnownEntryCount;
      knownRecordKeys.sort((left, right) => left.localeCompare(right));
      scopeEntries.push({ knownRecordKeys, scope });
    }

    return { invalidEntryNames, knownEntryCount, scopeEntries };
  }

  async #readHashedPayloadRecordKeyFromHandle(
    scope: AsyncStorageNamespaceScope,
    filePath: string,
    fileName: string,
    fileHandle: FileSystemFileHandle,
    cacheContext: OpfsCacheContext,
  ): Promise<string | null> {
    const value = await this.#readJsonFile(filePath, fileHandle, cacheContext);
    const resolvedKey =
      value === null
        ? null
        : resolveHashedPayloadRecordKeyFromValue(scope, value);
    return resolvedKey !== null &&
      buildFileName(scope, resolvedKey) === fileName
      ? resolvedKey
      : null;
  }

  async #readIndexedHashedPayloadRecordKeys(
    filePath: string | null,
    indexHandle: FileSystemFileHandle | null,
    cacheContext: OpfsCacheContext,
  ): Promise<string[] | null> {
    if (indexHandle === null || filePath === null) return null;

    const value = await this.#readJsonFile(filePath, indexHandle, cacheContext);
    if (!isObject(value)) return null;

    const record = value;
    const rawEntries = record.e;
    if (
      typeof rawEntries !== 'object' ||
      rawEntries === null ||
      Array.isArray(rawEntries)
    ) {
      return null;
    }

    return Object.keys(rawEntries).map((key) => getPayloadRecordKey(key));
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
      const cachedSessionDir =
        await options.cacheContext.dirCache.getAsync(sessionDirPath);
      if (cachedSessionDir !== undefined) return cachedSessionDir;

      return options.cacheContext.dirCache.getOrInsertAsync(
        sessionDirPath,
        async () =>
          root.getDirectoryHandle(encodedSessionKey, { create: true }),
      );
    }

    const cachedSessionDir =
      await options.cacheContext.dirCache.getAsync(sessionDirPath);
    if (cachedSessionDir !== undefined) return cachedSessionDir;

    return options.cacheContext.dirCache.getOrInsertAsync(
      sessionDirPath,
      async () => getDirectoryHandleIfExists(root, encodedSessionKey),
      { skipCachingWhen: (dir) => dir === null },
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
      const cachedStoreDir =
        await options.cacheContext.dirCache.getAsync(storeDirPath);
      if (cachedStoreDir !== undefined) return cachedStoreDir;

      return options.cacheContext.dirCache.getOrInsertAsync(
        storeDirPath,
        async () =>
          sessionDir.getDirectoryHandle(encodedStoreName, { create: true }),
      );
    }

    const cachedStoreDir =
      await options.cacheContext.dirCache.getAsync(storeDirPath);
    if (cachedStoreDir !== undefined) return cachedStoreDir;

    return options.cacheContext.dirCache.getOrInsertAsync(
      storeDirPath,
      async () => getDirectoryHandleIfExists(sessionDir, encodedStoreName),
      { skipCachingWhen: (dir) => dir === null },
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
      const cachedFileHandle =
        await options.cacheContext.fileCache.getAsync(filePath);
      if (cachedFileHandle !== undefined) return cachedFileHandle;

      return options.cacheContext.fileCache.getOrInsertAsync(
        filePath,
        async () => options.storeDir.getFileHandle(fileName, { create: true }),
      );
    }

    const cachedFileHandle =
      await options.cacheContext.fileCache.getAsync(filePath);
    if (cachedFileHandle !== undefined) return cachedFileHandle;

    return options.cacheContext.fileCache.getOrInsertAsync(
      filePath,
      async () => getFileHandleIfExists(options.storeDir, fileName),
      { skipCachingWhen: (fileHandle) => fileHandle === null },
    );
  }

  async #listScopedFiles(
    scope: AsyncStorageNamespaceScope,
    cacheContext: OpfsCacheContext,
  ): Promise<{
    allFileNames: string[];
    resolvedEntries: ScopedDirectoryEntry[];
  }> {
    const storeDir = await this.#getStoreDir(scope, {
      create: false,
      cacheContext,
    });
    if (storeDir === null) {
      return { allFileNames: [], resolvedEntries: [] };
    }

    const allFileNames: string[] = [];
    const resolvedEntries: ScopedDirectoryEntry[] = [];
    const hashedFiles: ParsedScopedFileInfo[] = [];
    let indexFilePath: string | null = null;
    let indexHandle: FileSystemFileHandle | null = null;
    const storeDirPath = this.#getStoreDirPath(scope);

    for await (const [fileName, entryHandle] of storeDir.entries()) {
      if (entryHandle.kind !== 'file') continue;

      const parsed = parseFileNameInfo(fileName);
      if (parsed === null || parsed.kind !== scope.kind) continue;

      allFileNames.push(fileName);
      const filePath = joinPath(storeDirPath, fileName);
      const fileHandle =
        // WORKAROUND: This branch only keeps file handles, but the DOM iterator still exposes the broader FileSystemHandle union.
        __LEGIT_CAST__<FileSystemFileHandle, FileSystemHandle>(entryHandle);

      if (parsed.isHashedPayload) {
        hashedFiles.push({
          fileHandle,
          fileName,
          filePath,
          isHashedPayload: true,
          key: null,
        });
        continue;
      }

      if (parsed.key !== null) {
        resolvedEntries.push({ fileName, key: parsed.key });
        if (parsed.key === ASYNC_NAMESPACE_INDEX_RECORD_KEY) {
          indexHandle = fileHandle;
          indexFilePath = filePath;
        }
      }
    }

    if (hashedFiles.length > 0) {
      resolvedEntries.push(
        ...(
          await this.#resolveHashedScopedFiles(
            scope,
            hashedFiles,
            indexHandle,
            indexFilePath,
            cacheContext,
          )
        ).resolvedEntries,
      );
    }

    resolvedEntries.sort((left, right) => left.key.localeCompare(right.key));

    return { allFileNames, resolvedEntries };
  }

  async #resolveHashedScopedFiles(
    scope: AsyncStorageNamespaceScope,
    hashedFiles: ParsedScopedFileInfo[],
    indexHandle: FileSystemFileHandle | null,
    indexFilePath: string | null,
    cacheContext: OpfsCacheContext,
  ): Promise<{
    invalidEntryNames: string[];
    resolvedEntries: ScopedDirectoryEntry[];
  }> {
    const hashedFilesByName = new Map(
      hashedFiles.map((file) => [file.fileName, file] as const),
    );
    const resolvedEntries: ScopedDirectoryEntry[] = [];
    const invalidEntryNames: string[] = [];
    const indexedPayloadRecordKeys =
      await this.#readIndexedHashedPayloadRecordKeys(
        indexFilePath,
        indexHandle,
        cacheContext,
      );

    if (indexedPayloadRecordKeys !== null) {
      const matchedFileNames = new Set<string>();

      const storeDirPath = this.#getStoreDirPath(scope);

      for (const key of indexedPayloadRecordKeys) {
        const expectedFileName = buildFileName(scope, key);
        const matchedFile = hashedFilesByName.get(expectedFileName);
        if (matchedFile === undefined) continue;

        matchedFileNames.add(expectedFileName);
        resolvedEntries.push({ fileName: matchedFile.fileName, key });
        cacheContext.fileCache.set(
          joinPath(storeDirPath, expectedFileName),
          matchedFile.fileHandle,
        );
      }

      invalidEntryNames.push(
        ...hashedFiles.flatMap((file) =>
          matchedFileNames.has(file.fileName) ? [] : [file.fileName],
        ),
      );
      return { invalidEntryNames, resolvedEntries };
    }

    const resolvedHashedEntries = await Promise.all(
      hashedFiles.map(async (file) => ({
        file,
        key: await this.#readHashedPayloadRecordKeyFromHandle(
          scope,
          file.filePath,
          file.fileName,
          file.fileHandle,
          cacheContext,
        ),
      })),
    );

    for (const { file, key } of resolvedHashedEntries) {
      if (key === null) {
        invalidEntryNames.push(file.fileName);
        continue;
      }

      resolvedEntries.push({ fileName: file.fileName, key });
      cacheContext.fileCache.set(file.filePath, file.fileHandle);
    }

    return { invalidEntryNames, resolvedEntries };
  }

  async #readJsonFile(
    filePath: string,
    fileHandle: FileSystemFileHandle,
    cacheContext: OpfsCacheContext,
  ): Promise<unknown> {
    const valueCache = cacheContext.readValueCache;
    if (valueCache?.has(filePath) === true) {
      return valueCache.get(filePath) ?? null;
    }

    try {
      const file = await fileHandle.getFile();
      const parsed: unknown = JSON.parse(await file.text());
      valueCache?.set(filePath, parsed);
      return parsed;
    } catch {
      valueCache?.set(filePath, null);
      return null;
    }
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
        cacheContext.readValueCache?.set(
          this.#getFilePath(scope, entry.key),
          entry.value,
        );
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

  async #cleanupRemoveKnownRecordsWithContext(
    scope: AsyncStorageNamespaceScope,
    keys: string[],
    cacheContext: OpfsCacheContext,
  ): Promise<string[]> {
    if (keys.length === 0) return [];

    const storeDir = await this.#getStoreDir(scope, {
      create: false,
      cacheContext,
    });
    if (storeDir === null) return [];

    const removeResults = await Promise.all(
      keys.map(async (key) => {
        const fileName = buildFileName(scope, key);
        try {
          await storeDir.removeEntry(fileName);
          return key;
        } catch {
          return null;
        }
      }),
    );

    return removeResults.flatMap((key) => (key === null ? [] : [key]));
  }

  async #cleanupRemoveKnownStoreDirWithContext(
    scope: AsyncStorageNamespaceScope,
    keys: string[],
    cacheContext: OpfsCacheContext,
  ): Promise<boolean> {
    const cleanupKnowledge = cacheContext.cleanupKnowledge;
    if (cleanupKnowledge === null) return false;

    const storeDirPath = this.#getStoreDirPath(scope);
    const knownStoreEntryCount =
      cleanupKnowledge.knownRemainingEntryCountByStorePath.get(storeDirPath);
    if (
      knownStoreEntryCount === undefined ||
      knownStoreEntryCount !== keys.length
    ) {
      return false;
    }

    const sessionDir = await this.#getSessionDir(scope.sessionKey, {
      create: false,
      cacheContext,
    });
    if (sessionDir === null) return false;

    try {
      await sessionDir.removeEntry(encodePathSegment(scope.storeName), {
        recursive: true,
      });
      return true;
    } catch {
      return false;
    }
  }

  async #cleanupRemoveKnownSessionDirWithContext(
    sessionKey: string,
    cacheContext: OpfsCacheContext,
  ): Promise<boolean> {
    if (cacheContext.cleanupKnowledge === null) return false;

    const sessionDirPath = this.#getSessionDirPath(sessionKey);
    const knownStorePaths =
      cacheContext.cleanupKnowledge.knownStorePathsBySessionPath.get(
        sessionDirPath,
      );
    if (knownStorePaths !== undefined && knownStorePaths.size > 0) return false;

    const root = await this.#getRootDir();
    try {
      await root.removeEntry(encodePathSegment(sessionKey), {
        recursive: true,
      });
      return true;
    } catch {
      return false;
    }
  }

  #cleanupFinalizeRemovedRecordsWithContext(
    scope: AsyncStorageNamespaceScope,
    removedKeys: string[],
    cacheContext: OpfsCacheContext,
  ): void {
    for (const key of removedKeys) {
      this.#invalidateFileHandle(scope, key, cacheContext);
    }
    this.#decrementKnownStoreEntryCount(
      this.#getStoreDirPath(scope),
      cacheContext,
      removedKeys.length,
    );
  }

  #cleanupFinalizeRemovedStoreDirWithContext(
    scope: AsyncStorageNamespaceScope,
    removedKeys: string[],
    cacheContext: OpfsCacheContext,
  ): void {
    for (const key of removedKeys) {
      this.#invalidateFileHandle(scope, key, cacheContext);
    }

    const sessionDirPath = this.#getSessionDirPath(scope.sessionKey);
    const storeDirPath = this.#getStoreDirPath(scope);
    this.#invalidateDirectory(storeDirPath, cacheContext);
    cacheContext.cleanupKnowledge?.knownStorePathsBySessionPath
      .get(sessionDirPath)
      ?.delete(storeDirPath);
    cacheContext.cleanupKnowledge?.knownRemainingEntryCountByStorePath.delete(
      storeDirPath,
    );
  }

  #cleanupFinalizeRemovedSessionDirWithContext(
    sessionKey: string,
    cacheContext: OpfsCacheContext,
  ): void {
    const sessionDirPath = this.#getSessionDirPath(sessionKey);
    this.#invalidateDirectory(sessionDirPath, cacheContext);
    this.#clearKnownSessionStores(sessionDirPath, cacheContext);
  }

  #invalidateFileHandle(
    scope: AsyncStorageNamespaceScope,
    key: string,
    cacheContext: OpfsCacheContext,
  ): void {
    const filePath = this.#getFilePath(scope, key);
    this.#invalidateFilePath(filePath, cacheContext);
  }

  #invalidateFilePath(path: string, cacheContext: OpfsCacheContext): void {
    cacheContext.fileCache.delete(path);
    cacheContext.readValueCache?.delete(path);
    if (cacheContext !== this.#mainCacheContext) {
      this.#mainCacheContext.fileCache.delete(path);
    }
  }

  #invalidateDirectory(path: string, cacheContext: OpfsCacheContext): void {
    cacheContext.dirCache.delete(path);
    if (cacheContext !== this.#mainCacheContext) {
      this.#mainCacheContext.dirCache.delete(path);
    }
  }

  #shouldPruneStoreDirAfterRemovingKeys(
    keys: string[],
    cacheContext: OpfsCacheContext,
  ): boolean {
    if (cacheContext.cleanupKnowledge !== null) return true;

    return keys.includes(ASYNC_NAMESPACE_INDEX_RECORD_KEY);
  }

  async #removeWholeStoreDirIfAllKnownEntriesAreBeingRemoved(
    scope: AsyncStorageNamespaceScope,
    keys: string[],
    cacheContext: OpfsCacheContext,
  ): Promise<boolean> {
    const cleanupKnowledge = cacheContext.cleanupKnowledge;
    if (cleanupKnowledge === null) return false;

    const storeDirPath = this.#getStoreDirPath(scope);
    const knownStoreEntryCount =
      cleanupKnowledge.knownRemainingEntryCountByStorePath.get(storeDirPath);
    if (
      knownStoreEntryCount === undefined ||
      knownStoreEntryCount !== keys.length
    ) {
      return false;
    }

    const sessionDir = await this.#getSessionDir(scope.sessionKey, {
      create: false,
      cacheContext,
    });
    if (sessionDir === null) return false;

    for (const key of keys) {
      this.#invalidateFileHandle(scope, key, cacheContext);
    }

    try {
      await sessionDir.removeEntry(encodePathSegment(scope.storeName), {
        recursive: true,
      });
    } catch {
      return false;
    }

    await this.#handleRemovedStoreDir(scope, cacheContext);
    return true;
  }

  async #handleRemovedStoreDir(
    scope: Pick<AsyncStorageNamespaceScope, 'sessionKey' | 'storeName'>,
    cacheContext: OpfsCacheContext,
  ): Promise<void> {
    const root = await this.#getRootDir();
    const sessionDirPath = this.#getSessionDirPath(scope.sessionKey);
    const storeDirPath = this.#getStoreDirPath(scope);

    this.#invalidateDirectory(storeDirPath, cacheContext);
    cacheContext.cleanupKnowledge?.knownStorePathsBySessionPath
      .get(sessionDirPath)
      ?.delete(storeDirPath);
    cacheContext.cleanupKnowledge?.knownRemainingEntryCountByStorePath.delete(
      storeDirPath,
    );

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

  async #pruneEmptyDirectories(
    scope: Pick<AsyncStorageNamespaceScope, 'sessionKey' | 'storeName'>,
    cacheContext: OpfsCacheContext,
  ): Promise<void> {
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
    }
    if (!removedStoreDir) return;
    await this.#handleRemovedStoreDir(scope, cacheContext);
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
      const dirHandle =
        // WORKAROUND: This branch only keeps directory handles, but the DOM iterator still exposes the broader FileSystemHandle union.
        __LEGIT_CAST__<FileSystemDirectoryHandle, FileSystemHandle>(entry);
      const path = joinPath(parentPath, entry.name);
      cacheContext.dirCache.set(path, dirHandle);
      entries.push({ handle: dirHandle, name: entry.name, path });
    }

    await this.#removeInvalidEntries(dir, invalidEntryNames, cacheContext);

    entries.sort((left, right) => left.name.localeCompare(right.name));
    return entries;
  }
}
