import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { sleep } from '@ls-stack/utils/sleep';

type MockBrowserOpfsBaseOperation = {
  path: string;
  startedTime: number;
  time: number;
};

type MockBrowserOpfsScopeOperation = MockBrowserOpfsBaseOperation & {
  created: boolean;
  exists: boolean;
  type: 'ensureDir' | 'openDir';
};

type MockBrowserOpfsFileOperation = MockBrowserOpfsBaseOperation & {
  created: boolean;
  exists: boolean;
  type: 'ensureFile' | 'openFile';
};

type MockBrowserOpfsReadWriteOperation = MockBrowserOpfsBaseOperation &
  (
    | { readRaw: string; type: 'readFile'; valueByteSize: number }
    | {
        writeRaw: string;
        type: 'writeFile';
        valueChanged: boolean;
        valueByteSizeAfter: number;
        valueByteSizeBefore: number;
      }
    | {
        errorName: string;
        phase: 'close' | 'createWritable';
        type: 'writeFileFailed';
      }
  );

type MockBrowserOpfsDeleteFileOperation = MockBrowserOpfsBaseOperation & {
  exists: boolean;
  type: 'deleteFile';
};

type MockBrowserOpfsListDirOperation = MockBrowserOpfsBaseOperation & {
  entries: string[];
  method: 'entries' | 'keys' | 'values';
  type: 'listDir';
};

type MockBrowserOpfsDeleteDirOperation = MockBrowserOpfsBaseOperation & {
  deleted: boolean;
  exists: boolean;
  recursive: boolean;
  type: 'deleteDir';
};

type MockFileNode = {
  bytes: Uint8Array;
  kind: 'file';
  name: string;
  raw: string;
  version: number;
};

type MockDirectoryNode = {
  directories: Map<string, MockDirectoryNode>;
  files: Map<string, MockFileNode>;
  kind: 'directory';
  name: string;
};

function createDirectoryNode(name: string): MockDirectoryNode {
  return { kind: 'directory', name, directories: new Map(), files: new Map() };
}

type ReadyAtRef = { value: number };

function cloneReadyAtRef(readyAtRef: ReadyAtRef): ReadyAtRef {
  return { value: readyAtRef.value };
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function normalizePath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

function splitPath(path: string): string[] {
  const normalizedPath = normalizePath(path);
  return normalizedPath === '' ? [] : normalizedPath.split('/');
}

function joinPath(pathSegments: string[], name?: string): string {
  const parts = name === undefined ? pathSegments : [...pathSegments, name];
  return parts.join('/');
}

function getStringByteSize(value: string): number {
  return value.length * 2;
}

function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function stringToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function normalizeWritableData(
  data: Blob | BufferSource | string,
): Promise<{ bytes: Uint8Array; raw: string }> {
  if (typeof data === 'string') {
    return { bytes: stringToBytes(data), raw: data };
  }

  let bytes: Uint8Array;
  if (data instanceof Blob) {
    bytes = new Uint8Array(await data.arrayBuffer());
  } else if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data.slice(0));
  } else {
    bytes = new Uint8Array(
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    );
  }

  return { bytes, raw: bytesToString(bytes) };
}

function createDomException(name: string, message: string): DOMException {
  return new DOMException(message, name);
}

function createFileRemovedError(): DOMException {
  return createDomException(
    'NotFoundError',
    'A requested file or directory could not be found at the time an operation was processed.',
  );
}

function createUnreadableSnapshotError(): DOMException {
  return createDomException(
    'NotReadableError',
    'The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.',
  );
}

/** The mock is intended to simulate OPFS latency for representing slow systems */
const MOCK_OPFS_LATENCY_MS = {
  createWritable: 1,
  directoryHandle: 1,
  fileHandle: 1,
  getFile: 1,
  listDir: 1,
  resolve: 1,
  rootHandle: 1,
  sameEntry: 1,
  textRead: 2,
  writableClose: 2,
  writableWrite: 1,
  removeEntry: 1,
} as const;

function createAsyncIterator<T>(
  valuesPromise: Promise<Iterable<T>>,
): FileSystemDirectoryHandleAsyncIterator<T> {
  const iteratorPromise = valuesPromise.then((values) =>
    values[Symbol.iterator](),
  );

  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next(): Promise<IteratorResult<T>> {
      const iterator = await iteratorPromise;
      return iterator.next();
    },
  };
}

function splitFilePath(path: string): {
  dirSegments: string[];
  fileName: string;
} {
  const pathSegments = splitPath(path);
  const fileName = pathSegments.pop();
  if (fileName === undefined) {
    throw new Error(`Expected file path, received "${path}".`);
  }

  return { dirSegments: pathSegments, fileName };
}

export type MockBrowserOpfsOperation =
  | MockBrowserOpfsScopeOperation
  | MockBrowserOpfsFileOperation
  | MockBrowserOpfsReadWriteOperation
  | MockBrowserOpfsDeleteFileOperation
  | MockBrowserOpfsListDirOperation
  | MockBrowserOpfsDeleteDirOperation;

export class MockBrowserOpfsEnvironment {
  readonly operations: MockBrowserOpfsOperation[] = [];

  readonly #removeEntryFailures = new Map<string, number>();
  readonly #handlePaths = new WeakMap<FileSystemHandle, string[]>();
  readonly #pendingLatencies = new Set<Promise<void>>();
  readonly #root = createDirectoryNode('');
  readonly #startedAt = Date.now();
  #settledTime = 0;
  readonly #readDelays = new Map<string, number>();
  readonly #dynamicReadDelays: Array<{
    delayMs: number;
    matches: (path: string) => boolean;
  }> = [];

  async getRootDirectoryHandle(): Promise<FileSystemDirectoryHandle> {
    const rootReadyAtRef: ReadyAtRef = { value: 0 };
    await this.#waitLatency({
      delayMs: MOCK_OPFS_LATENCY_MS.rootHandle,
      readyAtRef: rootReadyAtRef,
    });
    return this.#createDirectoryHandle(this.#root, [], rootReadyAtRef);
  }

  clearInstrumentation(): void {
    this.operations.length = 0;
  }

  hasPendingLatencies(): boolean {
    return this.#pendingLatencies.size > 0;
  }

  async flushLatencies(): Promise<void> {
    while (this.#pendingLatencies.size > 0) {
      await Promise.all([...this.#pendingLatencies]);
      await Promise.resolve();
    }
  }

  setReadDelay(pathPrefix: string, delayMs: number): void {
    const normalizedPrefix = normalizePath(pathPrefix);
    if (delayMs <= 0) {
      this.#readDelays.delete(normalizedPrefix);
      return;
    }

    this.#readDelays.set(normalizedPrefix, delayMs);
  }

  setDynamicReadDelay(
    matches: (path: string) => boolean,
    delayMs: number,
  ): void {
    if (delayMs <= 0) return;

    this.#dynamicReadDelays.push({ matches, delayMs });
  }

  failRemoveEntry(path: string, times = 1): void {
    const normalizedPath = normalizePath(path);
    if (times <= 0) {
      this.#removeEntryFailures.delete(normalizedPath);
      return;
    }

    this.#removeEntryFailures.set(normalizedPath, times);
  }

  ensureDir(path: string): void {
    this.#getDirectoryBySegments(splitPath(path), true);
  }

  writeFile(path: string, raw: string): void {
    const { dirSegments, fileName } = splitFilePath(path);
    const directory = this.#getDirectoryBySegments(dirSegments, true);
    if (directory === null) {
      throw new Error(`Expected directory for "${path}".`);
    }

    directory.files.set(fileName, {
      bytes: stringToBytes(raw),
      kind: 'file',
      name: fileName,
      raw,
      version: 0,
    });
  }

  readFile(path: string): string | null {
    const { dirSegments, fileName } = splitFilePath(path);
    const directory = this.#getDirectoryBySegments(dirSegments, false);
    if (directory === null) return null;

    return directory.files.get(fileName)?.raw ?? null;
  }

  removeFile(path: string): void {
    const { dirSegments, fileName } = splitFilePath(path);
    const directory = this.#getDirectoryBySegments(dirSegments, false);
    directory?.files.delete(fileName);
  }

  fileExists(path: string): boolean {
    return this.readFile(path) !== null;
  }

  listEntries(path: string): string[] {
    const directory = this.#getDirectoryBySegments(splitPath(path), false);
    if (directory === null) return [];

    const directoryNames = [...directory.directories.keys()]
      .sort(compareStrings)
      .map((name) => `dir:${name}`);
    const fileNames = [...directory.files.keys()]
      .sort(compareStrings)
      .map((name) => `file:${name}`);

    return [...directoryNames, ...fileNames];
  }

  getElapsedTime(): number {
    return this.#time();
  }

  #time(): number {
    return Date.now() - this.#startedAt;
  }

  #getStartedTime(readyAtRef: ReadyAtRef): number {
    return Math.max(this.#time(), readyAtRef.value, this.#settledTime);
  }

  async #waitLatency(args: {
    delayMs: number;
    readyAtRef: ReadyAtRef;
  }): Promise<{ completionTime: number; startedTime: number }> {
    const startedTime = this.#getStartedTime(args.readyAtRef);
    const completionTime = startedTime + args.delayMs;
    args.readyAtRef.value = completionTime;
    const pendingLatency: Promise<void> =
      args.delayMs > 0
        ? sleep(args.delayMs).then(() => undefined)
        : Promise.resolve();
    this.#pendingLatencies.add(pendingLatency);

    try {
      await pendingLatency;
    } finally {
      this.#pendingLatencies.delete(pendingLatency);
    }

    this.#settledTime = Math.max(this.#settledTime, completionTime);
    return {
      completionTime: Math.max(this.#time(), completionTime),
      startedTime,
    };
  }

  #getReadDelay(path: string): number {
    let bestMatchLength = -1;
    let bestDelayMs = 0;

    for (const [pathPrefix, delayMs] of this.#readDelays) {
      if (
        path === pathPrefix ||
        pathPrefix === '' ||
        path.startsWith(`${pathPrefix}/`)
      ) {
        if (pathPrefix.length > bestMatchLength) {
          bestMatchLength = pathPrefix.length;
          bestDelayMs = delayMs;
        }
      }
    }

    for (const rule of this.#dynamicReadDelays) {
      if (rule.matches(path)) {
        bestDelayMs = Math.max(bestDelayMs, rule.delayMs);
      }
    }

    return bestDelayMs;
  }

  #getDirectoryBySegments(
    pathSegments: string[],
    create: boolean,
  ): MockDirectoryNode | null {
    let current = this.#root;
    for (const segment of pathSegments) {
      const next = current.directories.get(segment);
      if (next !== undefined) {
        current = next;
        continue;
      }

      if (!create) return null;

      const created = createDirectoryNode(segment);
      current.directories.set(segment, created);
      current = created;
    }

    return current;
  }

  #createDirectoryHandle(
    node: MockDirectoryNode,
    pathSegments: string[],
    readyAtRef: ReadyAtRef,
  ): FileSystemDirectoryHandle {
    const operations = this.operations;
    const removeEntryFailures = this.#removeEntryFailures;
    const waitLatency = this.#waitLatency.bind(this);
    const createDirectoryHandle = this.#createDirectoryHandle.bind(this);
    const createFileHandle = this.#createFileHandle.bind(this);
    const handlePaths = this.#handlePaths;
    const currentPath = joinPath(pathSegments);

    function getDirectoryEntries(): Array<
      [string, FileSystemDirectoryHandle | FileSystemFileHandle]
    > {
      const entries: Array<
        [string, FileSystemDirectoryHandle | FileSystemFileHandle]
      > = [];

      for (const name of [...node.directories.keys()].sort(compareStrings)) {
        const next = node.directories.get(name);
        if (next !== undefined) {
          entries.push([
            name,
            createDirectoryHandle(next, [...pathSegments, name], {
              value: readyAtRef.value,
            }),
          ]);
        }
      }

      for (const name of [...node.files.keys()].sort(compareStrings)) {
        const next = node.files.get(name);
        if (next !== undefined) {
          entries.push([
            name,
            createFileHandle(next, pathSegments, { value: readyAtRef.value }),
          ]);
        }
      }

      return entries;
    }

    async function loadDirectoryEntries(
      method: MockBrowserOpfsListDirOperation['method'],
    ): Promise<
      Array<[string, FileSystemDirectoryHandle | FileSystemFileHandle]>
    > {
      const { completionTime, startedTime } = await waitLatency({
        delayMs: MOCK_OPFS_LATENCY_MS.listDir,
        readyAtRef: cloneReadyAtRef(readyAtRef),
      });
      const entries = getDirectoryEntries();

      operations.push({
        startedTime,
        time: completionTime,
        type: 'listDir',
        method,
        path: currentPath,
        entries: entries.map(
          ([name, childHandle]) =>
            `${childHandle.kind === 'directory' ? 'dir' : 'file'}:${name}`,
        ),
      });

      return entries;
    }

    const handle: FileSystemDirectoryHandle = {
      kind: 'directory',
      name: node.name,
      async isSameEntry(other: FileSystemHandle): Promise<boolean> {
        await waitLatency({
          delayMs: MOCK_OPFS_LATENCY_MS.sameEntry,
          readyAtRef: cloneReadyAtRef(readyAtRef),
        });
        const otherPath = handlePaths.get(other);
        return (
          other.kind === 'directory' &&
          otherPath !== undefined &&
          joinPath(otherPath) === currentPath
        );
      },
      async getDirectoryHandle(
        name: string,
        options?: { create?: boolean },
      ): Promise<FileSystemDirectoryHandle> {
        const { completionTime, startedTime } = await waitLatency({
          delayMs: MOCK_OPFS_LATENCY_MS.directoryHandle,
          readyAtRef: cloneReadyAtRef(readyAtRef),
        });
        const create = options?.create === true;
        const existing = node.directories.get(name);
        const exists = existing !== undefined;
        const path = joinPath([...pathSegments, name]);

        if (!exists && !create) {
          operations.push({
            startedTime,
            time: completionTime,
            type: 'openDir',
            path,
            exists: false,
            created: false,
          });
          throw new Error(`Directory "${name}" does not exist.`);
        }

        const next =
          existing ??
          (() => {
            const createdNode = createDirectoryNode(name);
            node.directories.set(name, createdNode);
            return createdNode;
          })();

        operations.push({
          startedTime,
          time: completionTime,
          type: create ? 'ensureDir' : 'openDir',
          path,
          exists,
          created: !exists,
        });

        return createDirectoryHandle(next, [...pathSegments, name], {
          value: completionTime,
        });
      },
      async getFileHandle(
        name: string,
        options?: { create?: boolean },
      ): Promise<FileSystemFileHandle> {
        const { completionTime, startedTime } = await waitLatency({
          delayMs: MOCK_OPFS_LATENCY_MS.fileHandle,
          readyAtRef: cloneReadyAtRef(readyAtRef),
        });
        const create = options?.create === true;
        const existing = node.files.get(name);
        const exists = existing !== undefined;
        const path = joinPath(pathSegments, name);

        if (!exists && !create) {
          operations.push({
            startedTime,
            time: completionTime,
            type: 'openFile',
            path,
            exists: false,
            created: false,
          });
          throw new Error(`File "${name}" does not exist.`);
        }

        const fileNode =
          existing ??
          (() => {
            const createdNode: MockFileNode = {
              bytes: stringToBytes(''),
              kind: 'file',
              name,
              raw: '',
              version: 0,
            };
            node.files.set(name, createdNode);
            return createdNode;
          })();

        operations.push({
          startedTime,
          time: completionTime,
          type: create ? 'ensureFile' : 'openFile',
          path,
          exists,
          created: !exists,
        });
        return createFileHandle(fileNode, pathSegments, {
          value: completionTime,
        });
      },
      async removeEntry(
        name: string,
        options?: { recursive?: boolean },
      ): Promise<void> {
        const { completionTime, startedTime } = await waitLatency({
          delayMs: MOCK_OPFS_LATENCY_MS.removeEntry,
          readyAtRef: cloneReadyAtRef(readyAtRef),
        });
        const filePath = joinPath(pathSegments, name);
        const remainingFailures = removeEntryFailures.get(filePath) ?? 0;
        if (remainingFailures > 0) {
          if (remainingFailures === 1) {
            removeEntryFailures.delete(filePath);
          } else {
            removeEntryFailures.set(filePath, remainingFailures - 1);
          }

          const directory = node.directories.get(name);
          operations.push(
            directory === undefined
              ? {
                  startedTime,
                  time: completionTime,
                  type: 'deleteFile',
                  path: filePath,
                  exists: node.files.has(name),
                }
              : {
                  startedTime,
                  time: completionTime,
                  type: 'deleteDir',
                  path: filePath,
                  exists: true,
                  deleted: false,
                  recursive: options?.recursive === true,
                },
          );
          throw new Error(`Failed to remove entry "${name}".`);
        }

        if (node.files.has(name)) {
          node.files.delete(name);
          operations.push({
            startedTime,
            time: completionTime,
            type: 'deleteFile',
            path: filePath,
            exists: true,
          });
          return;
        }

        const directory = node.directories.get(name);
        const exists = directory !== undefined;
        const deleted =
          exists &&
          (options?.recursive === true ||
            (directory.files.size === 0 && directory.directories.size === 0));
        operations.push({
          startedTime,
          time: completionTime,
          type: 'deleteDir',
          path: filePath,
          exists,
          deleted,
          recursive: options?.recursive === true,
        });

        if (!exists) {
          throw new Error(`Entry "${name}" does not exist.`);
        }

        if (!deleted) {
          throw new Error(`Directory "${name}" is not empty.`);
        }

        node.directories.delete(name);
      },
      values(): FileSystemDirectoryHandleAsyncIterator<
        FileSystemDirectoryHandle | FileSystemFileHandle
      > {
        return createAsyncIterator(
          loadDirectoryEntries('values').then((entries) =>
            entries.map(([, childHandle]) => childHandle),
          ),
        );
      },
      entries(): FileSystemDirectoryHandleAsyncIterator<
        [string, FileSystemDirectoryHandle | FileSystemFileHandle]
      > {
        return createAsyncIterator(loadDirectoryEntries('entries'));
      },
      keys(): FileSystemDirectoryHandleAsyncIterator<string> {
        return createAsyncIterator(
          loadDirectoryEntries('keys').then((entries) =>
            entries.map(([entryName]) => entryName),
          ),
        );
      },
      [Symbol.asyncIterator]() {
        return this.entries();
      },
      async resolve(
        possibleDescendant: FileSystemHandle,
      ): Promise<string[] | null> {
        await waitLatency({
          delayMs: MOCK_OPFS_LATENCY_MS.resolve,
          readyAtRef: cloneReadyAtRef(readyAtRef),
        });
        const descendantPath = handlePaths.get(possibleDescendant);
        if (descendantPath === undefined) return null;
        if (pathSegments.length > descendantPath.length) return null;

        for (const [index, segment] of pathSegments.entries()) {
          if (descendantPath[index] !== segment) return null;
        }

        return descendantPath.slice(pathSegments.length);
      },
    };

    this.#handlePaths.set(handle, [...pathSegments]);
    return handle;
  }

  #createFileHandle(
    node: MockFileNode,
    pathSegments: string[],
    readyAtRef: ReadyAtRef,
  ): FileSystemFileHandle {
    const operations = this.operations;
    const waitLatency = this.#waitLatency.bind(this);
    const getReadDelay = this.#getReadDelay.bind(this);
    const handlePaths = this.#handlePaths;
    const getDirectoryBySegments = this.#getDirectoryBySegments.bind(this);

    const filePath = [...pathSegments, node.name];
    function getCurrentFileNode(): MockFileNode {
      const directory = getDirectoryBySegments(pathSegments, false);
      const currentNode = directory?.files.get(node.name);
      if (currentNode === undefined) {
        throw createFileRemovedError();
      }

      return currentNode;
    }

    const handle: FileSystemFileHandle = {
      kind: 'file',
      name: node.name,
      async isSameEntry(other: FileSystemHandle): Promise<boolean> {
        await waitLatency({
          delayMs: MOCK_OPFS_LATENCY_MS.sameEntry,
          readyAtRef: cloneReadyAtRef(readyAtRef),
        });
        const otherPath = handlePaths.get(other);
        return (
          other.kind === 'file' &&
          otherPath !== undefined &&
          joinPath(otherPath) === joinPath(filePath)
        );
      },
      async getFile(): Promise<File> {
        const { completionTime, startedTime: getFileStartedTime } =
          await waitLatency({
            delayMs: MOCK_OPFS_LATENCY_MS.getFile,
            readyAtRef: cloneReadyAtRef(readyAtRef),
          });
        const path = joinPath(pathSegments, node.name);
        const currentNode = getCurrentFileNode();
        const fileReadyAtRef: ReadyAtRef = { value: completionTime };
        const snapshotBytes = currentNode.bytes.slice();
        const snapshotRaw = currentNode.raw;
        const snapshotVersion = currentNode.version;

        function assertSnapshotIsReadable(): void {
          const directory = getDirectoryBySegments(pathSegments, false);
          const latestNode = directory?.files.get(node.name);
          if (latestNode === undefined) {
            throw createFileRemovedError();
          }
          if (
            latestNode !== currentNode ||
            latestNode.version !== snapshotVersion
          ) {
            throw createUnreadableSnapshotError();
          }
        }

        return __LEGIT_CAST__<File, unknown>({
          name: node.name,
          lastModified: Date.now(),
          size: snapshotBytes.byteLength,
          type: '',
          async arrayBuffer(): Promise<ArrayBuffer> {
            let { completionTime: arrayBufferCompletionTime } =
              await waitLatency({
                delayMs: MOCK_OPFS_LATENCY_MS.textRead,
                readyAtRef: fileReadyAtRef,
              });
            const readDelay = getReadDelay(path);
            if (readDelay > 0) {
              const delayedRead = await waitLatency({
                delayMs: readDelay,
                readyAtRef: fileReadyAtRef,
              });
              arrayBufferCompletionTime = delayedRead.completionTime;
            }

            assertSnapshotIsReadable();

            operations.push({
              readRaw: snapshotRaw,
              startedTime: getFileStartedTime,
              time: arrayBufferCompletionTime,
              type: 'readFile',
              path,
              valueByteSize: getStringByteSize(snapshotRaw),
            });

            return snapshotBytes.slice().buffer;
          },
          async text(): Promise<string> {
            let { completionTime: textCompletionTime } = await waitLatency({
              delayMs: MOCK_OPFS_LATENCY_MS.textRead,
              readyAtRef: fileReadyAtRef,
            });
            const readDelay = getReadDelay(path);
            if (readDelay > 0) {
              const delayedRead = await waitLatency({
                delayMs: readDelay,
                readyAtRef: fileReadyAtRef,
              });
              textCompletionTime = delayedRead.completionTime;
            }

            assertSnapshotIsReadable();

            operations.push({
              // Model the visible read as starting when the file snapshot
              // acquisition began, since getFile() is part of the effective read.
              readRaw: snapshotRaw,
              startedTime: getFileStartedTime,
              time: textCompletionTime,
              type: 'readFile',
              path,
              valueByteSize: getStringByteSize(snapshotRaw),
            });

            return snapshotRaw;
          },
        });
      },
      async createWritable(): Promise<FileSystemWritableFileStream> {
        const { completionTime, startedTime } = await waitLatency({
          delayMs: MOCK_OPFS_LATENCY_MS.createWritable,
          readyAtRef: cloneReadyAtRef(readyAtRef),
        });
        const path = joinPath(pathSegments, node.name);
        let currentNode: MockFileNode;
        try {
          currentNode = getCurrentFileNode();
        } catch (error) {
          operations.push({
            startedTime,
            time: completionTime,
            type: 'writeFileFailed',
            path,
            phase: 'createWritable',
            errorName:
              error instanceof DOMException || error instanceof Error
                ? error.name
                : 'Error',
          });
          throw error;
        }
        let pendingBytes = currentNode.bytes.slice();
        let pendingRaw = currentNode.raw;
        const streamReadyAtRef: ReadyAtRef = { value: completionTime };

        return __LEGIT_CAST__<FileSystemWritableFileStream, unknown>({
          async write(data: Blob | BufferSource | string): Promise<void> {
            await waitLatency({
              delayMs: MOCK_OPFS_LATENCY_MS.writableWrite,
              readyAtRef: streamReadyAtRef,
            });
            readyAtRef.value = streamReadyAtRef.value;
            const normalizedData = await normalizeWritableData(data);
            pendingBytes = new Uint8Array(normalizedData.bytes);
            pendingRaw = normalizedData.raw;
          },
          async close(): Promise<void> {
            const {
              completionTime: writeCompletionTime,
              startedTime: writeStartedTime,
            } = await waitLatency({
              delayMs: MOCK_OPFS_LATENCY_MS.writableClose,
              readyAtRef: streamReadyAtRef,
            });
            readyAtRef.value = streamReadyAtRef.value;
            let liveNode: MockFileNode;
            try {
              liveNode = getCurrentFileNode();
            } catch (error) {
              operations.push({
                startedTime: writeStartedTime,
                time: writeCompletionTime,
                type: 'writeFileFailed',
                path,
                phase: 'close',
                errorName:
                  error instanceof DOMException || error instanceof Error
                    ? error.name
                    : 'Error',
              });
              throw error;
            }
            const valueChanged = liveNode.raw !== pendingRaw;
            const valueByteSizeBefore = getStringByteSize(liveNode.raw);
            liveNode.bytes = pendingBytes;
            liveNode.raw = pendingRaw;
            liveNode.version += 1;
            operations.push({
              startedTime: writeStartedTime,
              time: writeCompletionTime,
              type: 'writeFile',
              path,
              writeRaw: liveNode.raw,
              valueChanged,
              valueByteSizeBefore,
              valueByteSizeAfter: getStringByteSize(liveNode.raw),
            });
          },
        });
      },
    };

    this.#handlePaths.set(handle, filePath);
    return handle;
  }
}

let currentEnvironment: MockBrowserOpfsEnvironment | null = null;

function ensureEnvironment(): MockBrowserOpfsEnvironment {
  if (currentEnvironment === null) {
    currentEnvironment = new MockBrowserOpfsEnvironment();
  }

  return currentEnvironment;
}

export function createMockBrowserOpfs(): MockBrowserOpfsEnvironment {
  installMockBrowserOpfsForTests();
  return ensureEnvironment();
}

export function hasPendingMockBrowserOpfsLatenciesForTests(): boolean {
  return currentEnvironment?.hasPendingLatencies() ?? false;
}

export async function flushMockBrowserOpfsLatenciesForTests(): Promise<void> {
  await currentEnvironment?.flushLatencies();
}

function installMockBrowserOpfsForTests(): void {
  Object.defineProperty(globalThis.navigator, 'storage', {
    value: {
      getDirectory: async () =>
        await ensureEnvironment().getRootDirectoryHandle(),
    },
    writable: true,
    configurable: true,
  });
}

export function readMockBrowserOpfsFileForTests(path: string): string | null {
  return currentEnvironment?.readFile(path) ?? null;
}

export function resetMockBrowserOpfsForTests(): void {
  currentEnvironment = null;
  installMockBrowserOpfsForTests();
}
