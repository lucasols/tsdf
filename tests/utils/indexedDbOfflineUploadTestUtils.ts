import { IDBFactory } from 'fake-indexeddb';
import { indexedDbOfflineUploadAdapter } from '../../src/indexed-db-storage';

const OFFLINE_UPLOADS_DATABASE_NAME = 'tsdf-offline-uploads';
const METADATA_STORE = 'metadata';
const FILES_STORE = 'files';

/**
 * Starts the next test from an empty IndexedDB, like a fresh browser profile.
 */
export function resetIndexedDbOfflineUploadStorageForTests(): void {
  indexedDbOfflineUploadAdapter.resetForTests?.();
  globalThis.indexedDB = new IDBFactory();
}

function openOfflineUploadsDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_UPLOADS_DATABASE_NAME);
    request.onerror = () => reject(request.error ?? new Error('open failed'));
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('transaction aborted'));
  });
}

async function offlineUploadsDatabaseExists(): Promise<boolean> {
  const databases = await indexedDB.databases();

  return databases.some(
    (database) => database.name === OFFLINE_UPLOADS_DATABASE_NAME,
  );
}

function formatKey(key: IDBValidKey): string {
  const keyParts = Array.isArray(key) ? key : [key];

  return keyParts
    .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
    .join(' / ');
}

function toSnapshotMetadata(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;

  // `f` is a random token linking the metadata to its stored file bytes, it
  // is left out so snapshots stay deterministic
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'f'),
  );
}

type StoredUploadSnapshot = {
  /** `sessionKey / uploadId` */
  key: string;
  /** Stored file bytes decoded as text */
  file: string | null;
  metadata: Record<string, unknown> | null;
};

/**
 * Reads what the adapter persisted straight from IndexedDB, so tests assert
 * on the durable data instead of the session in-memory state.
 *
 * Under fake timers wrap the call with `resolveAfterAllTimers(...)`.
 */
export async function getIndexedDbOfflineUploadsSnapshot(): Promise<
  StoredUploadSnapshot[]
> {
  // Opening a missing database would create it without the adapter stores
  if (!(await offlineUploadsDatabaseExists())) return [];

  const database = await openOfflineUploadsDatabase();
  const transaction = database.transaction(
    [METADATA_STORE, FILES_STORE],
    'readonly',
  );
  const metadataStore = transaction.objectStore(METADATA_STORE);
  const filesStore = transaction.objectStore(FILES_STORE);
  const metadataKeysRequest = metadataStore.getAllKeys();
  const metadataRequest = metadataStore.getAll();
  const fileKeysRequest = filesStore.getAllKeys();
  const filesRequest = filesStore.getAll();
  await transactionDone(transaction);
  database.close();

  const metadataValues: unknown[] = metadataRequest.result;
  const fileValues: unknown[] = filesRequest.result;
  const snapshotsByKey = new Map<string, StoredUploadSnapshot>();

  for (const [index, key] of metadataKeysRequest.result.entries()) {
    snapshotsByKey.set(formatKey(key), {
      key: formatKey(key),
      file: null,
      metadata: toSnapshotMetadata(metadataValues[index]),
    });
  }

  for (const [index, key] of fileKeysRequest.result.entries()) {
    const fileValue = fileValues[index];
    const snapshot = snapshotsByKey.get(formatKey(key)) ?? {
      key: formatKey(key),
      file: null,
      metadata: null,
    };
    snapshot.file =
      fileValue instanceof ArrayBuffer
        ? new TextDecoder().decode(fileValue)
        : `invalid: ${String(fileValue)}`;
    snapshotsByKey.set(snapshot.key, snapshot);
  }

  return [...snapshotsByKey.values()];
}

/**
 * Overwrites the stored metadata of one upload, simulating a record that was
 * corrupted or written in a shape this version does not understand.
 */
export async function overwriteIndexedDbOfflineUploadMetadata(
  sessionKey: string,
  uploadId: string,
  metadata: unknown,
): Promise<void> {
  const database = await openOfflineUploadsDatabase();
  const transaction = database.transaction(METADATA_STORE, 'readwrite');
  transaction.objectStore(METADATA_STORE).put(metadata, [sessionKey, uploadId]);
  await transactionDone(transaction);
  database.close();
}
