import type { ValidPayload } from '../utils/storeShared';
import {
  parseCompactUploadMetadataRecord,
  type PersistedUploadMetadataRecord,
  toCompactUploadMetadataRecord,
} from './offlineUploadMetadataRecord';
import type {
  OfflineStoredUploadRecord,
  OfflineUploadAdapter,
} from './offlineUploadTypes';
import { encodePathSegment } from './opfsFileNaming';
import {
  getDirectoryHandleIfExists,
  getFileHandleIfExists,
  getNavigatorStorageDirectory,
} from './opfsHelpers';

const OPFS_UPLOADS_ROOT_DIR = 'tsdf-uploads';
const METADATA_FILE_NAME = 'metadata.json';
const BINARY_FILE_NAME = 'binary.blob';

async function readTextFile(
  handle: FileSystemFileHandle,
): Promise<string | null> {
  try {
    const file = await handle.getFile();
    return await file.text();
  } catch {
    return null;
  }
}

async function writeFile(
  handle: FileSystemFileHandle,
  data: string | Blob,
): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

class OpfsOfflineUploadDriver implements OfflineUploadAdapter {
  #rootDirPromise: Promise<FileSystemDirectoryHandle> | null = null;

  async save<TResolvedRef extends ValidPayload>(
    sessionKey: string,
    id: string,
    record: OfflineStoredUploadRecord<TResolvedRef>,
  ): Promise<void> {
    const uploadDir = await this.#replaceUploadDir(sessionKey, id);
    const metadataHandle = await uploadDir.getFileHandle(METADATA_FILE_NAME, {
      create: true,
    });
    const binaryHandle = await uploadDir.getFileHandle(BINARY_FILE_NAME, {
      create: true,
    });
    const { file: _file, ...metadataRecord } = record;

    await Promise.all([
      writeFile(
        metadataHandle,
        JSON.stringify(toCompactUploadMetadataRecord(metadataRecord)),
      ),
      writeFile(binaryHandle, record.file),
    ]);
  }

  async load<TResolvedRef extends ValidPayload>(
    sessionKey: string,
    id: string,
  ): Promise<OfflineStoredUploadRecord<TResolvedRef> | null> {
    const uploadDir = await this.#getUploadDir(sessionKey, id, false);
    if (!uploadDir) return null;

    return this.#loadFromDir(uploadDir);
  }

  async list<TResolvedRef extends ValidPayload>(
    sessionKey: string,
  ): Promise<OfflineStoredUploadRecord<TResolvedRef>[]> {
    const sessionDir = await this.#getSessionDir(sessionKey, false);
    if (!sessionDir) return [];

    // Collect directory handles first, then load records in parallel.
    const dirHandles: FileSystemDirectoryHandle[] = [];
    for await (const [entryName, entryHandle] of sessionDir.entries()) {
      if (entryHandle.kind !== 'directory') continue;
      dirHandles.push(await sessionDir.getDirectoryHandle(entryName));
    }

    const loadedRecords = await Promise.all(
      dirHandles.map((dirHandle) => this.#loadFromDir<TResolvedRef>(dirHandle)),
    );

    return loadedRecords
      .filter((record) => record !== null)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async remove(sessionKey: string, id: string): Promise<void> {
    const sessionDir = await this.#getSessionDir(sessionKey, false);
    if (!sessionDir) return;

    try {
      await sessionDir.removeEntry(encodePathSegment(id), { recursive: true });
    } catch {
      // Ignore missing records.
    }
  }

  async clearSession(sessionKey: string): Promise<void> {
    const rootDir = await this.#getRootDir();
    try {
      await rootDir.removeEntry(encodePathSegment(sessionKey), {
        recursive: true,
      });
    } catch {
      // Ignore missing sessions.
    }
  }

  resetForTests(): void {
    this.#rootDirPromise = null;
  }

  async #loadFromDir<TResolvedRef extends ValidPayload>(
    uploadDir: FileSystemDirectoryHandle,
  ): Promise<OfflineStoredUploadRecord<TResolvedRef> | null> {
    const metadataHandle = await getFileHandleIfExists(
      uploadDir,
      METADATA_FILE_NAME,
    );
    if (!metadataHandle) return null;

    const metadataRaw = await readTextFile(metadataHandle);
    if (metadataRaw === null) return null;

    let metadataRecord: PersistedUploadMetadataRecord<TResolvedRef> | null =
      null;
    try {
      metadataRecord = parseCompactUploadMetadataRecord(
        JSON.parse(metadataRaw),
      );
    } catch {
      return null;
    }
    if (metadataRecord === null) return null;

    const binaryHandle = await getFileHandleIfExists(
      uploadDir,
      BINARY_FILE_NAME,
    );
    if (!binaryHandle) return null;

    try {
      const storedFile = await binaryHandle.getFile();
      const fileBuffer = await storedFile.arrayBuffer();

      return {
        ...metadataRecord,
        file: new File([fileBuffer], metadataRecord.fileName, {
          type: metadataRecord.mimeType,
          lastModified: metadataRecord.lastModified,
        }),
      };
    } catch {
      return null;
    }
  }

  async #getRootDir(): Promise<FileSystemDirectoryHandle> {
    this.#rootDirPromise ??= (async () => {
      const root = await getNavigatorStorageDirectory();
      return root.getDirectoryHandle(OPFS_UPLOADS_ROOT_DIR, { create: true });
    })();

    return this.#rootDirPromise;
  }

  async #getSessionDir(
    sessionKey: string,
    create: boolean,
  ): Promise<FileSystemDirectoryHandle | null> {
    const root = await this.#getRootDir();
    if (create) {
      return root.getDirectoryHandle(encodePathSegment(sessionKey), {
        create: true,
      });
    }

    return getDirectoryHandleIfExists(root, encodePathSegment(sessionKey));
  }

  async #getUploadDir(
    sessionKey: string,
    id: string,
    create: boolean,
  ): Promise<FileSystemDirectoryHandle | null> {
    const sessionDir = await this.#getSessionDir(sessionKey, create);
    if (!sessionDir) return null;

    if (create) {
      return sessionDir.getDirectoryHandle(encodePathSegment(id), {
        create: true,
      });
    }

    return getDirectoryHandleIfExists(sessionDir, encodePathSegment(id));
  }

  async #replaceUploadDir(
    sessionKey: string,
    id: string,
  ): Promise<FileSystemDirectoryHandle> {
    const sessionDir = await this.#getSessionDir(sessionKey, true);
    if (!sessionDir) {
      throw new Error('Failed to create OPFS upload session directory');
    }

    try {
      await sessionDir.removeEntry(encodePathSegment(id), { recursive: true });
    } catch {
      // Ignore missing upload directories.
    }

    return sessionDir.getDirectoryHandle(encodePathSegment(id), {
      create: true,
    });
  }
}

export const opfsOfflineUploadAdapter: OfflineUploadAdapter =
  new OpfsOfflineUploadDriver();
