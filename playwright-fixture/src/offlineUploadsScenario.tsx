import { useState } from 'react';
import { rc_object, rc_parse, rc_string } from 'runcheck';
import { indexedDbOfflineUploadAdapter } from '../../src/indexed-db-storage';
import {
  createStoreManager,
  opfsOfflineUploadAdapter,
  type StoreError,
} from '../../src/main';

const UPLOAD_ID = 'attachment';

const uploadResponseSchema = rc_object({ ref: rc_string });

function normalizeError(error: Error): StoreError {
  return { code: 500, id: 'fixture-error', message: error.message };
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join(' ');
}

async function describeFile(file: File | null): Promise<string> {
  if (!file) return 'null';

  return [
    file.name,
    file.type,
    String(file.lastModified),
    String(file.size),
    toHex(await file.arrayBuffer()),
  ].join(' | ');
}

/**
 * Stages one file per session through the manager upload helpers, so browser
 * tests can check what each upload adapter really persists and restores.
 */
export function OfflineUploadsScenario({
  sessionKey,
  uploadAdapterKey,
}: {
  sessionKey: string;
  uploadAdapterKey: string | null;
}) {
  const [lastResult, setLastResult] = useState('idle');
  const [loadedFile, setLoadedFile] = useState('not-loaded');
  const [pickedFile, setPickedFile] = useState('not-picked');

  const [storeManager] = useState(() =>
    createStoreManager<string>({
      getSessionKey: () => sessionKey,
      errorNormalizer: normalizeError,
      offlineSession: {
        uploads: {
          adapter:
            uploadAdapterKey === 'indexedDb'
              ? indexedDbOfflineUploadAdapter
              : opfsOfflineUploadAdapter,
          // Sends the staged file as the request body, the server answers with
          // a ref describing the bytes it received
          upload: async ({ file }) => {
            const response = await fetch('/api/upload', {
              method: 'POST',
              headers: { 'content-type': file.type, 'x-file-name': file.name },
              body: file,
            });

            return rc_parse(
              await response.json(),
              uploadResponseSchema,
            ).unwrap().ref;
          },
        },
      },
    }),
  );

  const uploads = storeManager.useOfflineUploads();

  function report(
    action: string,
    result: Promise<{ ok: true } | { ok: false; error: Error }>,
  ) {
    void result.then((settled) => {
      setLastResult(
        settled.ok
          ? `${action}: ok`
          : `${action}: error: ${settled.error.message}`,
      );
    });
  }

  return (
    <section>
      <h1>Offline uploads</h1>
      <label>
        stage file
        <input
          data-testid="upload-save-input"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;

            void describeFile(file).then(setPickedFile);
            report(
              'save',
              storeManager.saveOfflineUpload({ id: UPLOAD_ID, file }),
            );
          }}
          type="file"
        />
      </label>
      <label>
        replace file
        <input
          data-testid="upload-replace-input"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;

            void describeFile(file).then(setPickedFile);
            report(
              'replace',
              storeManager.replaceOfflineUpload({ id: UPLOAD_ID, file }),
            );
          }}
          type="file"
        />
      </label>
      <button
        data-testid="upload-load"
        onClick={() => {
          void storeManager
            .loadOfflineUpload(UPLOAD_ID)
            .then(async (result) => {
              setLoadedFile(
                result.ok
                  ? await describeFile(result.value)
                  : `error: ${result.error.message}`,
              );
            });
        }}
        type="button"
      >
        load
      </button>
      <button
        data-testid="upload-delete"
        onClick={() => {
          report('delete', storeManager.deleteOfflineUpload(UPLOAD_ID));
        }}
        type="button"
      >
        delete
      </button>
      <button
        data-testid="upload-resolve"
        onClick={() => {
          report('resolve', storeManager.resolveOfflineUpload(UPLOAD_ID));
        }}
        type="button"
      >
        upload now
      </button>
      <div data-testid="upload-last-result">{lastResult}</div>
      <div data-testid="upload-picked-file">{pickedFile}</div>
      <div data-testid="upload-loaded-file">{loadedFile}</div>
      <div data-testid="upload-list">
        {uploads.length === 0
          ? 'empty'
          : uploads
              .map((upload) =>
                [
                  upload.id,
                  upload.state,
                  upload.fileName,
                  upload.resolvedRef ?? 'no-ref',
                ].join(' | '),
              )
              .join('\n')}
      </div>
    </section>
  );
}
