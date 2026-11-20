import { asPossiblyUndefined } from '@ls-stack/utils/typingFnUtils';

export async function getNavigatorStorageDirectory(): Promise<FileSystemDirectoryHandle> {
  const root = await getNavigatorStorageDirectoryIfAvailable();
  if (root === null) {
    throw new Error('[TSDF] OPFS is unavailable in this environment.');
  }

  return root;
}

/** Returns `null` when the environment has no OPFS at all. */
export async function getNavigatorStorageDirectoryIfAvailable(): Promise<FileSystemDirectoryHandle | null> {
  const storage = asPossiblyUndefined(globalThis.navigator)?.storage;
  if (storage?.getDirectory === undefined) return null;

  return storage.getDirectory();
}

export async function getDirectoryHandleIfExists(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await parent.getDirectoryHandle(name);
  } catch {
    return null;
  }
}

export async function getFileHandleIfExists(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemFileHandle | null> {
  try {
    return await parent.getFileHandle(name);
  } catch {
    return null;
  }
}
