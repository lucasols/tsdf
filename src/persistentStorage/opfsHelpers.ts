import { asPossiblyUndefined } from '@ls-stack/utils/typingFnUtils';

export async function getNavigatorStorageDirectory(): Promise<FileSystemDirectoryHandle> {
  const storage = asPossiblyUndefined(globalThis.navigator)?.storage;
  if (storage?.getDirectory === undefined) {
    throw new Error('[TSDF] OPFS is unavailable in this environment.');
  }

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
