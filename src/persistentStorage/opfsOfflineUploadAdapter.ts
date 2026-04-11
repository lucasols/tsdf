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
          // WORKAROUND: Persisted upload metadata is validated only at the
          // shared ValidPayload boundary, and hydration rebinds that known-safe
          // value back to the caller's compile-time upload-ref generic.
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
  };
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
        serializeStoredUploadMetadataRecord(metadataRecord),
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

    const records: OfflineStoredUploadRecord<TResolvedRef>[] = [];
    for await (const [entryName, entryHandle] of sessionDir.entries()) {
      if (entryHandle.kind !== 'directory') continue;

      const record = await this.#loadFromDir<TResolvedRef>(
        await sessionDir.getDirectoryHandle(entryName),
      );
      if (record) {
        records.push(record);
      }
    }

    return records.sort((left, right) => left.id.localeCompare(right.id));
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
