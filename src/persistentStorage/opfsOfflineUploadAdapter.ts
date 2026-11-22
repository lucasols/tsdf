import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import {
  rc_literals,
  rc_number,
  rc_object,
  rc_parse,
  rc_record,
  rc_string,
  rc_union,
  rc_unknown,
} from 'runcheck';
import type { ValidPayload } from '../utils/storeShared';
import type {
  OfflineStoredUploadRecord,
  OfflineUploadAdapter,
} from './offlineUploadTypes';
import { encodePathSegment } from './opfsFileNaming';
import {
  getDirectoryHandleIfExists,
  getFileHandleIfExists,
  getNavigatorStorageDirectory,
  getNavigatorStorageDirectoryIfAvailable,
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

const uploadProgressSchema = rc_object({
  loadedBytes: rc_number.optionalKey(),
  totalBytes: rc_number.optionalKey(),
  progress: rc_number,
});

const validPayloadSchema = rc_union(
  rc_string,
  rc_number,
  rc_record(rc_unknown),
);

const lastErrorSchema = rc_object({ message: rc_string });

const storedUploadMetadataRecordSchema = rc_object({
  i: rc_string,
  k: rc_string,
  o: rc_literals('manual', 'mutation'),
  t: rc_literals('pending', 'uploading', 'uploaded', 'failed'),
  n: rc_string,
  m: rc_string,
  z: rc_number,
  c: rc_number,
  u: rc_number,
  r: validPayloadSchema.optionalKey(),
  p: uploadProgressSchema.optionalKey(),
  e: lastErrorSchema.optionalKey(),
  g: rc_number.optionalKey(),
  l: rc_number,
  d: validPayloadSchema.optionalKey(),
  s: rc_string.optionalKey(),
});

type PersistedUploadMetadataRecord<
  TResolvedRef extends ValidPayload = ValidPayload,
> = Omit<OfflineStoredUploadRecord<TResolvedRef>, 'file'>;

function serializeStoredUploadMetadataRecord<
  TResolvedRef extends ValidPayload = ValidPayload,
>(record: PersistedUploadMetadataRecord<TResolvedRef>): string {
  return JSON.stringify({
    i: record.id,
    k: record.sessionKey,
    o: record.source,
    t: record.state,
    n: record.fileName,
    m: record.mimeType,
    z: record.sizeBytes,
    c: record.createdAt,
    u: record.updatedAt,
    ...(record.resolvedRef !== undefined ? { r: record.resolvedRef } : {}),
    ...(record.progress !== undefined ? { p: record.progress } : {}),
    ...(record.lastError !== undefined ? { e: record.lastError } : {}),
    ...(record.lastOnlineSessionStartedAt !== undefined
      ? { g: record.lastOnlineSessionStartedAt }
      : {}),
    l: record.lastModified,
    ...(record.metadata !== undefined ? { d: record.metadata } : {}),
    ...(record.storeName !== undefined ? { s: record.storeName } : {}),
  });
}

function parseStoredUploadMetadataRecord<
  TResolvedRef extends ValidPayload = ValidPayload,
>(raw: string): PersistedUploadMetadataRecord<TResolvedRef> | null {
  const parsed: unknown = JSON.parse(raw);
  const compactRecord = rc_parse(
    parsed,
    storedUploadMetadataRecordSchema,
  ).unwrapOrNull();

  if (compactRecord === null) return null;

  return {
    id: compactRecord.i,
    sessionKey: compactRecord.k,
    source: compactRecord.o,
    state: compactRecord.t,
    fileName: compactRecord.n,
    mimeType: compactRecord.m,
    sizeBytes: compactRecord.z,
    createdAt: compactRecord.c,
    updatedAt: compactRecord.u,
    ...(compactRecord.r !== undefined
      ? {
          // WORKAROUND: The adapter contract is generic over the upload ref,
          // but the stored value is only checked to be a ValidPayload here. The
          // offline session validates it with `uploads.resolvedRefSchema`, when
          // configured, before exposing it.
          resolvedRef: __LEGIT_CAST__<TResolvedRef, ValidPayload>(
            compactRecord.r,
          ),
        }
      : {}),
    ...(compactRecord.p !== undefined ? { progress: compactRecord.p } : {}),
    ...(compactRecord.e !== undefined ? { lastError: compactRecord.e } : {}),
    ...(compactRecord.g !== undefined
      ? { lastOnlineSessionStartedAt: compactRecord.g }
      : {}),
    lastModified: compactRecord.l,
    ...(compactRecord.d !== undefined ? { metadata: compactRecord.d } : {}),
    ...(compactRecord.s !== undefined ? { storeName: compactRecord.s } : {}),
  };
}

function getUploadPath(sessionKey: string, encodedId: string): string {
  return `${encodePathSegment(sessionKey)}/${encodedId}`;
}

class OpfsOfflineUploadDriver implements OfflineUploadAdapter {
  #rootDirPromise: Promise<FileSystemDirectoryHandle> | null = null;
  /**
   * The files known to hold the bytes of each upload path's stored binary:
   * the file this driver last wrote there and the files restored from it
   * since. Restored files are read lazily from their binary, so writing one
   * over its own binary would leave it unreadable (browsers fail reads of a
   * file snapshot once the file changed). Held weakly, so files the session
   * no longer holds aren't kept in memory.
   */
  readonly #storedFiles = new Map<string, WeakSet<File>>();

  async save<TResolvedRef extends ValidPayload>(
    sessionKey: string,
    id: string,
    record: OfflineStoredUploadRecord<TResolvedRef>,
  ): Promise<File | undefined> {
    const uploadPath = getUploadPath(sessionKey, encodePathSegment(id));
    const uploadDir = await this.#getUploadDir(sessionKey, id, true);
    if (!uploadDir) {
      throw new Error('Failed to create OPFS upload directory');
    }
    const { file, ...metadataRecord } = record;

    // State changes save the record again with the same file, so the binary
    // is only written when it doesn't already hold this file. It is written
    // before the metadata, so a failed binary write keeps the previous record.
    const isFileStored =
      this.#storedFiles.get(uploadPath)?.has(file) === true &&
      (await getFileHandleIfExists(uploadDir, BINARY_FILE_NAME)) !== null;
    let binaryHandle: FileSystemFileHandle | null = null;
    if (!isFileStored) {
      binaryHandle = await uploadDir.getFileHandle(BINARY_FILE_NAME, {
        create: true,
      });
      // Writes are committed when the writable closes, so the previous files
      // still match the binary until the write succeeds
      await writeFile(binaryHandle, file);
      this.#storedFiles.set(uploadPath, new WeakSet([file]));
    }

    try {
      const metadataHandle = await uploadDir.getFileHandle(METADATA_FILE_NAME, {
        create: true,
      });
      await writeFile(
        metadataHandle,
        serializeStoredUploadMetadataRecord(metadataRecord),
      );
    } catch (error) {
      // The previous metadata doesn't describe the new binary, so the upload
      // is removed instead of being restored with it. Removing the binary too
      // frees the space a write over the quota needs, and the session's next
      // save of the record writes both again.
      if (!isFileStored) await this.remove(sessionKey, id);
      throw error;
    }

    if (!binaryHandle) return undefined;

    // The saved file can read from storage that is removed or replaced later
    // (a file restored for another upload, or built from one), so the session
    // holds a file of the binary it was written to instead
    try {
      const storedFile = new File(
        [await binaryHandle.getFile()],
        record.fileName,
        { type: record.mimeType, lastModified: record.lastModified },
      );
      this.#storedFiles.get(uploadPath)?.add(storedFile);
      return storedFile;
    } catch {
      return undefined;
    }
  }

  async load<TResolvedRef extends ValidPayload>(
    sessionKey: string,
    id: string,
  ): Promise<OfflineStoredUploadRecord<TResolvedRef> | null> {
    const uploadDir = await this.#getUploadDir(sessionKey, id, false);
    if (!uploadDir) return null;

    return this.#loadFromDir(
      uploadDir,
      getUploadPath(sessionKey, encodePathSegment(id)),
    );
  }

  async list<TResolvedRef extends ValidPayload>(
    sessionKey: string,
  ): Promise<OfflineStoredUploadRecord<TResolvedRef>[]> {
    const sessionDir = await this.#getSessionDir(sessionKey, false);
    if (!sessionDir) return [];

    // Collect directory handles first, then load records in parallel.
    const dirEntries: Array<[string, FileSystemDirectoryHandle]> = [];
    for await (const [entryName, entryHandle] of sessionDir.entries()) {
      if (entryHandle.kind !== 'directory') continue;
      dirEntries.push([
        entryName,
        await sessionDir.getDirectoryHandle(entryName),
      ]);
    }

    const loadedRecords = await Promise.all(
      dirEntries.map(([entryName, dirHandle]) =>
        this.#loadFromDir<TResolvedRef>(
          dirHandle,
          getUploadPath(sessionKey, entryName),
        ),
      ),
    );

    return loadedRecords
      .filter((record) => record !== null)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async remove(sessionKey: string, id: string): Promise<void> {
    const sessionDir = await this.#getSessionDir(sessionKey, false);
    if (!sessionDir) return;

    this.#storedFiles.delete(getUploadPath(sessionKey, encodePathSegment(id)));
    try {
      await sessionDir.removeEntry(encodePathSegment(id), { recursive: true });
    } catch {
      // Ignore missing records.
    }
  }

  async clearSession(sessionKey: string): Promise<void> {
    const sessionPathPrefix = `${encodePathSegment(sessionKey)}/`;
    for (const uploadPath of this.#storedFiles.keys()) {
      if (uploadPath.startsWith(sessionPathPrefix)) {
        this.#storedFiles.delete(uploadPath);
      }
    }

    const rootDir = await this.#getExistingRootDir();
    if (!rootDir) return;

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
    this.#storedFiles.clear();
  }

  async #loadFromDir<TResolvedRef extends ValidPayload>(
    uploadDir: FileSystemDirectoryHandle,
    uploadPath: string,
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
      metadataRecord = parseStoredUploadMetadataRecord(metadataRaw);
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
      // The file stays backed by the stored binary instead of being read into
      // memory: its bytes are only read when it is uploaded or rendered.
      const file = new File(
        [await binaryHandle.getFile()],
        metadataRecord.fileName,
        {
          type: metadataRecord.mimeType,
          lastModified: metadataRecord.lastModified,
        },
      );
      const storedFiles = this.#storedFiles.get(uploadPath);
      if (storedFiles) storedFiles.add(file);
      else this.#storedFiles.set(uploadPath, new WeakSet([file]));

      return { ...metadataRecord, file };
    } catch {
      return null;
    }
  }

  /**
   * Root directory for reads and removals, which must not create storage:
   * `null` when OPFS is unavailable (no `navigator.storage.getDirectory`, or
   * it rejects, as in Firefox private windows) or nothing was ever staged,
   * since no upload can be stored there either way. Saves still fail when
   * OPFS is unavailable.
   */
  async #getExistingRootDir(): Promise<FileSystemDirectoryHandle | null> {
    try {
      if (this.#rootDirPromise !== null) return await this.#rootDirPromise;

      const navigatorRoot = await getNavigatorStorageDirectoryIfAvailable();
      if (navigatorRoot === null) return null;

      return await getDirectoryHandleIfExists(
        navigatorRoot,
        OPFS_UPLOADS_ROOT_DIR,
      );
    } catch {
      return null;
    }
  }

  async #getRootDir(): Promise<FileSystemDirectoryHandle> {
    const rootDirPromise = (this.#rootDirPromise ??= (async () => {
      const root = await getNavigatorStorageDirectory();
      return root.getDirectoryHandle(OPFS_UPLOADS_ROOT_DIR, { create: true });
    })());

    try {
      return await rootDirPromise;
    } catch (error) {
      // Opening OPFS is tried again by the next save instead of failing for
      // the rest of the page load
      if (this.#rootDirPromise === rootDirPromise) this.#rootDirPromise = null;
      throw error;
    }
  }

  async #getSessionDir(
    sessionKey: string,
    create: boolean,
  ): Promise<FileSystemDirectoryHandle | null> {
    const root = create
      ? await this.#getRootDir()
      : await this.#getExistingRootDir();
    if (!root) return null;

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
}

export const opfsOfflineUploadAdapter: OfflineUploadAdapter =
  new OpfsOfflineUploadDriver();
