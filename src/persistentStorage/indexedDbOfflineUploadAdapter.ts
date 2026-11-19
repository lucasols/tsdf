import { isObject } from '@ls-stack/utils/typeGuards';
import type { ValidPayload } from '../utils/storeShared';
import {
  parseCompactUploadMetadataRecord,
  toCompactUploadMetadataRecord,
} from './offlineUploadMetadataRecord';
import type {
  OfflineStoredUploadRecord,
  OfflineUploadAdapter,
} from './offlineUploadTypes';

// Uploads use their own database instead of a store in the persistent storage
// database: that database has a configurable name and recreates its stores on
// upgrade, so sharing it would couple both schemas to one version number.
const DATABASE_NAME = 'tsdf-offline-uploads';
const DATABASE_VERSION = 1;
// Compact metadata record plus the `f` token of the file bytes it belongs to
const METADATA_STORE = 'metadata';
// File bytes as `ArrayBuffer`. Bytes are stored instead of `Blob`/`File`
// objects because WebKit has a history of failing to store or read back blobs
// in IndexedDB, and this adapter exists for Safari versions without OPFS writes
const FILES_STORE = 'files';
const STORE_NAMES = [METADATA_STORE, FILES_STORE];

function createSessionKeyRange(sessionKey: string): IDBKeyRange {
  // In IndexedDB key order `[sessionKey]` sorts before every
  // `[sessionKey, id]` key, and an array sorts after any string id
  return IDBKeyRange.bound([sessionKey], [sessionKey, []]);
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    // Failed requests and quota errors abort the transaction, so this covers
    // every way a transaction can fail
    transaction.onabort = () =>
      reject(
        transaction.error ??
          new Error('IndexedDB offline upload transaction aborted.'),
      );
  });
}

function getStoredFileToken(metadataValue: unknown): string | null {
  return isObject(metadataValue) && typeof metadataValue.f === 'string'
    ? metadataValue.f
    : null;
}

function createFileToken(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

type UploadKey = [sessionKey: string, id: string];

class IndexedDbOfflineUploadDriver implements OfflineUploadAdapter {
  #databasePromise: Promise<IDBDatabase> | null = null;
  /**
   * Token of the stored bytes each known `File` object was saved as or
   * restored from. A metadata record carrying the same token is known to sit
   * next to those exact bytes, so metadata-only updates (upload state,
   * progress, retention stamps) can skip reading and rewriting the file.
   */
  #fileTokens = new WeakMap<File, string>();

  async save<TResolvedRef extends ValidPayload>(
    sessionKey: string,
    id: string,
    record: OfflineStoredUploadRecord<TResolvedRef>,
  ): Promise<void> {
    const key: UploadKey = [sessionKey, id];
    const metadata = toCompactUploadMetadataRecord(record);
    const knownFileToken = this.#fileTokens.get(record.file);

    if (
      knownFileToken !== undefined &&
      (await this.#updateMetadataIfFileIsStored(key, metadata, knownFileToken))
    ) {
      return;
    }

    // Read the bytes before opening the transaction: IndexedDB transactions
    // auto-commit as soon as they are left without pending requests
    const fileBytes = await record.file.arrayBuffer();
    const fileToken = knownFileToken ?? createFileToken();
    const database = await this.#getDatabase();
    const transaction = database.transaction(STORE_NAMES, 'readwrite');
    try {
      transaction
        .objectStore(METADATA_STORE)
        .put({ ...metadata, f: fileToken }, key);
      transaction.objectStore(FILES_STORE).put(fileBytes, key);
    } catch (error) {
      // A write rejected synchronously (e.g. a value that cannot be cloned)
      // must not let the other one commit alone: the metadata token would
      // then point at the bytes of another file
      transaction.abort();
      throw error;
    }
    await transactionDone(transaction);

    this.#fileTokens.set(record.file, fileToken);
  }

  async load<TResolvedRef extends ValidPayload>(
    sessionKey: string,
    id: string,
  ): Promise<OfflineStoredUploadRecord<TResolvedRef> | null> {
    const key: UploadKey = [sessionKey, id];
    const database = await this.#getDatabase();
    const transaction = database.transaction(STORE_NAMES, 'readonly');
    const metadataRequest = transaction.objectStore(METADATA_STORE).get(key);
    const fileRequest = transaction.objectStore(FILES_STORE).get(key);
    await transactionDone(transaction);

    return this.#toStoredRecord(metadataRequest.result, fileRequest.result);
  }

  async list<TResolvedRef extends ValidPayload>(
    sessionKey: string,
  ): Promise<OfflineStoredUploadRecord<TResolvedRef>[]> {
    const sessionKeyRange = createSessionKeyRange(sessionKey);
    const database = await this.#getDatabase();
    const transaction = database.transaction(STORE_NAMES, 'readonly');
    const metadataStore = transaction.objectStore(METADATA_STORE);
    const filesStore = transaction.objectStore(FILES_STORE);
    const metadataKeysRequest = metadataStore.getAllKeys(sessionKeyRange);
    const metadataRequest = metadataStore.getAll(sessionKeyRange);
    const fileKeysRequest = filesStore.getAllKeys(sessionKeyRange);
    const filesRequest = filesStore.getAll(sessionKeyRange);
    await transactionDone(transaction);

    const fileValues: unknown[] = filesRequest.result;
    const fileBytesByKey = new Map<string, unknown>();
    for (const [index, key] of fileKeysRequest.result.entries()) {
      fileBytesByKey.set(JSON.stringify(key), fileValues[index]);
    }

    const metadataValues: unknown[] = metadataRequest.result;
    const records: OfflineStoredUploadRecord<TResolvedRef>[] = [];
    for (const [index, key] of metadataKeysRequest.result.entries()) {
      const record = this.#toStoredRecord<TResolvedRef>(
        metadataValues[index],
        fileBytesByKey.get(JSON.stringify(key)),
      );
      if (record !== null) records.push(record);
    }

    return records.sort((left, right) => left.id.localeCompare(right.id));
  }

  async remove(sessionKey: string, id: string): Promise<void> {
    await this.#deleteFromAllStores([sessionKey, id]);
  }

  async clearSession(sessionKey: string): Promise<void> {
    await this.#deleteFromAllStores(createSessionKeyRange(sessionKey));
  }

  resetForTests(): void {
    const databasePromise = this.#databasePromise;
    this.#databasePromise = null;
    void databasePromise?.then(
      (database) => database.close(),
      () => {},
    );
  }

  /** Deleting keys that do not exist is a no-op, so missing uploads and sessions are ignored. */
  async #deleteFromAllStores(query: UploadKey | IDBKeyRange): Promise<void> {
    const database = await this.#getDatabase();
    const transaction = database.transaction(STORE_NAMES, 'readwrite');
    for (const storeName of STORE_NAMES) {
      transaction.objectStore(storeName).delete(query);
    }
    await transactionDone(transaction);
  }

  /**
   * Rewrites only the metadata when the stored record still belongs to the
   * file identified by `fileToken`. Returns `false` when the record is gone
   * or holds another file (replaced or removed, possibly by another tab), so
   * the caller writes the file bytes again.
   */
  async #updateMetadataIfFileIsStored(
    key: UploadKey,
    metadata: Record<string, unknown>,
    fileToken: string,
  ): Promise<boolean> {
    const database = await this.#getDatabase();
    const transaction = database.transaction(METADATA_STORE, 'readwrite');
    const metadataStore = transaction.objectStore(METADATA_STORE);
    const storedMetadataRequest = metadataStore.get(key);
    let didUpdate = false;
    storedMetadataRequest.onsuccess = () => {
      if (getStoredFileToken(storedMetadataRequest.result) !== fileToken) {
        return;
      }

      metadataStore.put({ ...metadata, f: fileToken }, key);
      didUpdate = true;
    };
    await transactionDone(transaction);

    return didUpdate;
  }

  #toStoredRecord<TResolvedRef extends ValidPayload>(
    metadataValue: unknown,
    fileBytes: unknown,
  ): OfflineStoredUploadRecord<TResolvedRef> | null {
    if (!(fileBytes instanceof ArrayBuffer)) return null;

    const fileToken = getStoredFileToken(metadataValue);
    if (fileToken === null) return null;

    const metadata =
      parseCompactUploadMetadataRecord<TResolvedRef>(metadataValue);
    if (metadata === null) return null;

    const file = new File([fileBytes], metadata.fileName, {
      type: metadata.mimeType,
      lastModified: metadata.lastModified,
    });
    this.#fileTokens.set(file, fileToken);

    return { ...metadata, file };
  }

  #getDatabase(): Promise<IDBDatabase> {
    if (this.#databasePromise !== null) return this.#databasePromise;

    const databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        for (const storeName of STORE_NAMES) {
          if (!database.objectStoreNames.contains(storeName)) {
            database.createObjectStore(storeName);
          }
        }
      };
      request.onerror = () =>
        reject(
          request.error ??
            new Error('IndexedDB offline upload database open failed.'),
        );
      request.onsuccess = () => resolve(request.result);
    });
    this.#databasePromise = databasePromise;

    // Drops the cached connection so the next operation opens a new one
    const forgetConnection = () => {
      if (this.#databasePromise === databasePromise) {
        this.#databasePromise = null;
      }
    };
    databasePromise.then((database) => {
      // Never block another tab that needs to upgrade or delete the database
      database.onversionchange = () => {
        database.close();
        forgetConnection();
      };
      // Browsers can drop the connection on their own, e.g. Safari does it
      // for backgrounded pages
      database.onclose = forgetConnection;
    }, forgetConnection);

    return databasePromise;
  }
}

/**
 * Built-in IndexedDB-backed adapter for `offlineSession.uploads.adapter`.
 *
 * Stores staged upload files in a dedicated `tsdf-offline-uploads` IndexedDB
 * database, scoped by session key. Prefer it over `opfsOfflineUploadAdapter`
 * when the app must support browsers where OPFS files cannot be written from
 * the main thread, such as Safari before version 26.
 *
 * @example
 * ```ts
 * import { createStoreManager } from 'tsdf';
 * import { indexedDbOfflineUploadAdapter } from 'tsdf/indexed-db-storage';
 *
 * const storeManager = createStoreManager({
 *   getSessionKey: () => userId,
 *   errorNormalizer,
 *   offlineSession: {
 *     uploads: {
 *       adapter: indexedDbOfflineUploadAdapter,
 *       upload: ({ file }) => uploadFile(file),
 *     },
 *   },
 * });
 * ```
 */
export const indexedDbOfflineUploadAdapter: OfflineUploadAdapter =
  /* @__PURE__ */ new IndexedDbOfflineUploadDriver();
