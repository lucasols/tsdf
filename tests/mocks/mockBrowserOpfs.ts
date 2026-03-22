/* eslint-disable @typescript-eslint/require-await -- test helper intentionally implements a compact in-memory OPFS model. */
import { sleep } from '@ls-stack/utils/sleep';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';

type MockBrowserOpfsScopeOperation = {
  created: boolean;
  exists: boolean;
  path: string;
  time: number;
  type: 'ensureDir' | 'openDir';
};

type MockBrowserOpfsFileOperation = {
  created: boolean;
  exists: boolean;
  path: string;
  time: number;
  type: 'ensureFile' | 'openFile';
};

type MockBrowserOpfsReadWriteOperation = { path: string; time: number } & (
  | { type: 'readFile'; valueByteSize: number }
  | {
      type: 'writeFile';
      valueChanged: boolean;
      valueByteSizeAfter: number;
      valueByteSizeBefore: number;
    }
);

type MockBrowserOpfsDeleteFileOperation = {
  exists: boolean;
  path: string;
  time: number;
  type: 'deleteFile';
};

type MockBrowserOpfsListDirOperation = {
  entries: string[];
  path: string;
  time: number;
  type: 'listDir';
};

type MockBrowserOpfsDeleteDirOperation = {
  exists: boolean;
  path: string;
  time: number;
  type: 'deleteDir';
};

type ReadyAtRef = { value: number };

type MockFileNode = { kind: 'file'; name: string; raw: string };

type MockDirectoryNode = {
  directories: Map<string, MockDirectoryNode>;
  files: Map<string, MockFileNode>;
  kind: 'directory';
  name: string;
};

function createDirectoryNode(name: string): MockDirectoryNode {
  return { kind: 'directory', name, directories: new Map(), files: new Map() };
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

const MOCK_OPFS_LATENCY_MS = {
  createWritable: 1,
  directoryHandle: 1,
  fileHandle: 1,
  getFile: 1,
  rootHandle: 1,
  textRead: 2,
  writableClose: 2,
  writableWrite: 1,
  removeEntry: 1,
} as const;

function createAsyncIterator<T>(
  values: Iterable<T>,
): FileSystemDirectoryHandleAsyncIterator<T> {
  const iterator = values[Symbol.iterator]();

  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next(): Promise<IteratorResult<T>> {
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

  private readonly handlePaths = new WeakMap<FileSystemHandle, string[]>();
  private readonly pendingLatencies = new Set<Promise<void>>();
  private readonly root = createDirectoryNode('');
  private readonly startedAt = Date.now();
  private readonly readDelays = new Map<string, number>();

  async getRootDirectoryHandle(): Promise<FileSystemDirectoryHandle> {
    const rootReadyAtRef: ReadyAtRef = { value: 0 };
    await this.waitLatency({
      delayMs: MOCK_OPFS_LATENCY_MS.rootHandle,
      readyAtRef: rootReadyAtRef,
    });
    return this.createDirectoryHandle(this.root, [], rootReadyAtRef);
  }

  clearInstrumentation(): void {
    this.operations.length = 0;
  }

  hasPendingLatencies(): boolean {
    return this.pendingLatencies.size > 0;
  }

  async flushLatencies(): Promise<void> {
    while (this.pendingLatencies.size > 0) {
      await Promise.all([...this.pendingLatencies]);
    }
  }

  setReadDelay(pathPrefix: string, delayMs: number): void {
    const normalizedPrefix = normalizePath(pathPrefix);
    if (delayMs <= 0) {
      this.readDelays.delete(normalizedPrefix);
      return;
    }

    this.readDelays.set(normalizedPrefix, delayMs);
  }

  ensureDir(path: string): void {
    this.getDirectoryBySegments(splitPath(path), true);
  }

  writeFile(path: string, raw: string): void {
    const { dirSegments, fileName } = splitFilePath(path);
    const directory = this.getDirectoryBySegments(dirSegments, true);
    if (directory === null) {
      throw new Error(`Expected directory for "${path}".`);
    }

    directory.files.set(fileName, { kind: 'file', name: fileName, raw });
  }

  readFile(path: string): string | null {
    const { dirSegments, fileName } = splitFilePath(path);
    const directory = this.getDirectoryBySegments(dirSegments, false);
    if (directory === null) return null;

    return directory.files.get(fileName)?.raw ?? null;
  }

  removeFile(path: string): void {
    const { dirSegments, fileName } = splitFilePath(path);
    const directory = this.getDirectoryBySegments(dirSegments, false);
    directory?.files.delete(fileName);
  }

  fileExists(path: string): boolean {
    return this.readFile(path) !== null;
  }

  listEntries(path: string): string[] {
    const directory = this.getDirectoryBySegments(splitPath(path), false);
    if (directory === null) return [];

    const directoryNames = [...directory.directories.keys()]
      .sort(compareStrings)
      .map((name) => `dir:${name}`);
    const fileNames = [...directory.files.keys()]
      .sort(compareStrings)
      .map((name) => `file:${name}`);

    return [...directoryNames, ...fileNames];
  }

  private time(): number {
    return Date.now() - this.startedAt;
  }

  private getStartTime(readyAtRef: ReadyAtRef): number {
    return Math.max(this.time(), readyAtRef.value);
  }

  private async waitLatency(args: {
    delayMs: number;
    readyAtRef: ReadyAtRef;
    useFakeTimeDelay?: boolean;
  }): Promise<number> {
    const completionTime = this.getStartTime(args.readyAtRef) + args.delayMs;
    const actualDelayMs = args.useFakeTimeDelay === true ? args.delayMs : 0;
    const pendingLatency: Promise<void> =
      actualDelayMs > 0
        ? sleep(actualDelayMs).then(() => undefined)
        : Promise.resolve();
    this.pendingLatencies.add(pendingLatency);

    try {
      await pendingLatency;
    } finally {
      this.pendingLatencies.delete(pendingLatency);
    }

    args.readyAtRef.value = completionTime;
    return completionTime;
  }

  private getReadDelay(path: string): number {
    let bestMatchLength = -1;
    let bestDelayMs = 0;

    for (const [pathPrefix, delayMs] of this.readDelays) {
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

    return bestDelayMs;
  }

  private getDirectoryBySegments(
    pathSegments: string[],
    create: boolean,
  ): MockDirectoryNode | null {
    let current = this.root;
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

  private createDirectoryHandle(
    node: MockDirectoryNode,
    pathSegments: string[],
    readyAtRef: ReadyAtRef,
  ): FileSystemDirectoryHandle {
    const operations = this.operations;
    const getStartTime = this.getStartTime.bind(this);
    const waitLatency = this.waitLatency.bind(this);
    const createDirectoryHandle = this.createDirectoryHandle.bind(this);
    const createFileHandle = this.createFileHandle.bind(this);
    const handlePaths = this.handlePaths;
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

    const handle: FileSystemDirectoryHandle = {
      kind: 'directory',
      name: node.name,
      async isSameEntry(other: FileSystemHandle): Promise<boolean> {
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
        const completionTime = await waitLatency({
          delayMs: MOCK_OPFS_LATENCY_MS.directoryHandle,
          readyAtRef,
        });
        const create = options?.create === true;
        const existing = node.directories.get(name);
        const exists = existing !== undefined;
        const path = joinPath([...pathSegments, name]);

        if (!exists && !create) {
          operations.push({
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
        const completionTime = await waitLatency({
          delayMs: MOCK_OPFS_LATENCY_MS.fileHandle,
          readyAtRef,
        });
        const create = options?.create === true;
        const existing = node.files.get(name);
        const exists = existing !== undefined;
        const path = joinPath(pathSegments, name);

        if (!exists && !create) {
          operations.push({
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
            const createdNode: MockFileNode = { kind: 'file', name, raw: '' };
            node.files.set(name, createdNode);
            return createdNode;
          })();

        operations.push({
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
        const completionTime = await waitLatency({
          delayMs: MOCK_OPFS_LATENCY_MS.removeEntry,
          readyAtRef,
        });
        const filePath = joinPath(pathSegments, name);
        if (node.files.has(name)) {
          node.files.delete(name);
          operations.push({
            time: completionTime,
            type: 'deleteFile',
            path: filePath,
            exists: true,
          });
          return;
        }

        const directory = node.directories.get(name);
        const exists = directory !== undefined;
        operations.push({
          time: completionTime,
          type: 'deleteDir',
          path: filePath,
          exists,
        });

        if (!exists) {
          throw new Error(`Entry "${name}" does not exist.`);
        }

        if (
          options?.recursive !== true &&
          (directory.files.size > 0 || directory.directories.size > 0)
        ) {
          throw new Error(`Directory "${name}" is not empty.`);
        }

        node.directories.delete(name);
      },
      values(): FileSystemDirectoryHandleAsyncIterator<
        FileSystemDirectoryHandle | FileSystemFileHandle
      > {
        const directoryNames = [...node.directories.keys()]
          .sort(compareStrings)
          .map((name) => `dir:${name}`);
        const fileNames = [...node.files.keys()]
          .sort(compareStrings)
          .map((name) => `file:${name}`);

        operations.push({
          time: getStartTime(readyAtRef),
          type: 'listDir',
          path: currentPath,
          entries: [...directoryNames, ...fileNames],
        });

        return createAsyncIterator(
          getDirectoryEntries().map(([, childHandle]) => childHandle),
        );
      },
      entries(): FileSystemDirectoryHandleAsyncIterator<
        [string, FileSystemDirectoryHandle | FileSystemFileHandle]
      > {
        return createAsyncIterator(getDirectoryEntries());
      },
      keys(): FileSystemDirectoryHandleAsyncIterator<string> {
        return createAsyncIterator(
          getDirectoryEntries().map(([entryName]) => entryName),
        );
      },
      [Symbol.asyncIterator]() {
        return this.entries();
      },
      async resolve(
        possibleDescendant: FileSystemHandle,
      ): Promise<string[] | null> {
        const descendantPath = handlePaths.get(possibleDescendant);
        if (descendantPath === undefined) return null;
        if (pathSegments.length > descendantPath.length) return null;

        for (const [index, segment] of pathSegments.entries()) {
          if (descendantPath[index] !== segment) return null;
        }

        return descendantPath.slice(pathSegments.length);
      },
    };

    this.handlePaths.set(handle, [...pathSegments]);
    return handle;
  }

  private createFileHandle(
    node: MockFileNode,
    pathSegments: string[],
    readyAtRef: ReadyAtRef,
  ): FileSystemFileHandle {
    const operations = this.operations;
    const waitLatency = this.waitLatency.bind(this);
    const getReadDelay = this.getReadDelay.bind(this);
    const handlePaths = this.handlePaths;

    const filePath = [...pathSegments, node.name];
    const handle: FileSystemFileHandle = {
      kind: 'file',
      name: node.name,
      async isSameEntry(other: FileSystemHandle): Promise<boolean> {
        const otherPath = handlePaths.get(other);
        return (
          other.kind === 'file' &&
          otherPath !== undefined &&
          joinPath(otherPath) === joinPath(filePath)
        );
      },
      async getFile(): Promise<File> {
        const completionTime = await waitLatency({
          delayMs: MOCK_OPFS_LATENCY_MS.getFile,
          readyAtRef,
        });
        const path = joinPath(pathSegments, node.name);
        const fileReadyAtRef: ReadyAtRef = { value: completionTime };

        return __LEGIT_CAST__<File, unknown>({
          async text(): Promise<string> {
            let readCompletionTime = await waitLatency({
              delayMs: MOCK_OPFS_LATENCY_MS.textRead,
              readyAtRef: fileReadyAtRef,
            });
            const delayMs = getReadDelay(path);
            if (delayMs > 0) {
              readCompletionTime = await waitLatency({
                delayMs,
                readyAtRef: fileReadyAtRef,
                useFakeTimeDelay: true,
              });
            }

            operations.push({
              time: readCompletionTime,
              type: 'readFile',
              path,
              valueByteSize: getStringByteSize(node.raw),
            });

            return node.raw;
          },
        });
      },
      async createWritable(): Promise<FileSystemWritableFileStream> {
        const completionTime = await waitLatency({
          delayMs: MOCK_OPFS_LATENCY_MS.createWritable,
          readyAtRef,
        });
        const path = joinPath(pathSegments, node.name);
        let pendingRaw = node.raw;
        const streamReadyAtRef: ReadyAtRef = { value: completionTime };

        return __LEGIT_CAST__<FileSystemWritableFileStream, unknown>({
          async write(data: string): Promise<void> {
            await waitLatency({
              delayMs: MOCK_OPFS_LATENCY_MS.writableWrite,
              readyAtRef: streamReadyAtRef,
            });
            readyAtRef.value = streamReadyAtRef.value;
            pendingRaw = data;
          },
          async close(): Promise<void> {
            const writeCompletionTime = await waitLatency({
              delayMs: MOCK_OPFS_LATENCY_MS.writableClose,
              readyAtRef: streamReadyAtRef,
            });
            readyAtRef.value = streamReadyAtRef.value;
            const valueChanged = node.raw !== pendingRaw;
            const valueByteSizeBefore = getStringByteSize(node.raw);
            node.raw = pendingRaw;
            operations.push({
              time: writeCompletionTime,
              type: 'writeFile',
              path,
              valueChanged,
              valueByteSizeBefore,
              valueByteSizeAfter: getStringByteSize(node.raw),
            });
          },
        });
      },
    };

    this.handlePaths.set(handle, filePath);
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

export function installMockBrowserOpfsForTests(): void {
  Object.defineProperty(globalThis.navigator, 'storage', {
    value: {
      getDirectory: async () =>
        await ensureEnvironment().getRootDirectoryHandle(),
    },
    writable: true,
    configurable: true,
  });
}

export function resetMockBrowserOpfsForTests(): void {
  currentEnvironment = null;
  installMockBrowserOpfsForTests();
}
