import { act } from 'react';
import { rc_array, rc_number, rc_object, rc_string } from 'runcheck';
import { expect, test } from 'vitest';
import type {
  DocumentOfflineOperationDefinition,
  OfflineSessionConfig,
} from '../../src/main';
import { createStoreManager, opfsOfflineUploadAdapter } from '../../src/main';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createMockBrowserOpfs } from '../mocks/mockBrowserOpfs';
import { normalizeError } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';
import { docSchema, summarizeResolution } from './offlineTestShared';
import {
  network,
  resolveWithin,
  setupOfflineUploadTests,
} from './offlineUploadsTestShared';

// A document change declares its editor images as optional uploads
// (`{ id, optional: true }`) and its cover image as a required one. When the
// server refuses an optional image (storage limit, file type), the change is
// sent without it instead of waiting for a manual resolution.

setupOfflineUploadTests();

/**
 * Error thrown by the upload transport: the session classifiers below tell a
 * connection problem, a busy server and a refused file apart.
 */
class UploadError extends Error {
  kind: 'connection' | 'busy' | 'refused';

  constructor(kind: UploadError['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

const classifyFailure = (error: unknown) =>
  error instanceof UploadError && error.kind === 'connection'
    ? 'network'
    : 'ignore';
const classifyRetryableFailure = (error: unknown) =>
  error instanceof UploadError && error.kind === 'busy';

type DocWithImagesOperations = {
  saveDoc: DocumentOfflineOperationDefinition<
    { value: number },
    { input: { value: number; coverId: string; imageIds: string[] } }
  >;
};

/**
 * Document store whose `saveDoc` operation requires the `cover` upload and
 * lists the editor images as optional uploads. `uploadOutcomes` scripts the
 * transport per upload id, one outcome per call (calls past the end
 * succeed). `requests` lists what reached the server.
 */
function createDocWithImagesEnv({
  sessionKey,
  uploadOutcomes,
  classifiersDelayMs,
  enabled,
}: {
  sessionKey: string;
  /** Session gate */
  enabled?: () => boolean;
  uploadOutcomes: Record<string, UploadError[]>;
  /**
   * Makes the session classifiers async, answering after this delay, like a
   * classifier that reads the error response body first.
   */
  classifiersDelayMs?: number;
}) {
  const requests: string[] = [];
  const uploadCalls = new Map<string, number>();
  // Answer of the network recovery check, once the session went offline.
  let serverReachable = true;

  const delayed = <T,>(value: T) =>
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(value), classifiersDelayMs);
    });
  const classifiers: Pick<
    OfflineSessionConfig,
    'classifyFailure' | 'classifyRetryableFailure'
  > =
    classifiersDelayMs === undefined
      ? { classifyFailure, classifyRetryableFailure }
      : {
          classifyFailure: (error) => delayed(classifyFailure(error)),
          classifyRetryableFailure: (error) =>
            delayed(classifyRetryableFailure(error)),
        };

  const storeManager = createStoreManager({
    getSessionKey: () => sessionKey,
    errorNormalizer: normalizeError,
    offlineSession: {
      ...classifiers,
      ...(enabled ? { enabled } : {}),
      network: { ...network.config, recoveryCheck: () => serverReachable },
      uploads: {
        adapter: opfsOfflineUploadAdapter,
        upload: async ({ id }) => {
          const call = uploadCalls.get(id) ?? 0;
          uploadCalls.set(id, call + 1);
          const failure = uploadOutcomes[id]?.[call];
          // Every upload request takes 200ms to succeed or fail.
          await new Promise((resolve) => setTimeout(resolve, 200));

          if (failure) {
            requests.push(`upload ${id} -> ${failure.message}`);
            throw failure;
          }
          requests.push(`upload ${id} -> server:${id}`);
          return `server:${id}`;
        },
      },
    },
  });

  /** What the request sends: the refs it got and the images left out. */
  function describeRequest(uploads: {
    resolvedRefsById: Record<string, unknown>;
    refusedUploadErrorsById: Record<string, unknown>;
  }) {
    const refused = Object.entries(uploads.refusedUploadErrorsById).map(
      ([id, error]) =>
        `${id} (${error instanceof Error ? error.message : 'unknown'})`,
    );
    return `refs ${JSON.stringify(uploads.resolvedRefsById)}${
      refused.length > 0 ? `, without ${refused.join(', ')}` : ''
    }`;
  }

  const env = createDocumentStoreTestEnv<number, DocWithImagesOperations>(1, {
    id: `${sessionKey}-doc`,
    storeManager,
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        operations: {
          saveDoc: {
            inputSchema: rc_object({
              value: rc_number,
              coverId: rc_string,
              imageIds: rc_array(rc_string),
            }),
            kind: 'update',
            dependsOnUploads: ({ input }) => [
              input.coverId,
              ...input.imageIds.map((id) => ({ id, optional: true })),
            ],
            execute: async ({ input, uploads }) => {
              requests.push(`replay saveDoc with ${describeRequest(uploads)}`);
              await env.serverMock.delayedSetData(input.value);
              return { value: input.value };
            },
          },
        },
      },
    },
  });

  const docInput = { value: 2, coverId: 'cover', imageIds: ['img-1', 'img-2'] };

  return {
    env,
    storeManager,
    requests,
    setServerReachable: (reachable: boolean) => {
      serverReachable = reachable;
    },
    getUploads: () =>
      storeManager
        .getOfflineUploads()
        .map((upload) => pick(upload, ['id', 'state', 'lastError'])),
    /** Stages the cover and the editor images. */
    async stageFiles() {
      for (const id of ['cover', ...docInput.imageIds]) {
        (
          await resolveWithin(
            storeManager.saveOfflineUpload({
              id,
              file: new File([`${id} bytes`], `${id}.png`, { lastModified: 1 }),
            }),
          )
        ).unwrap();
      }
    },
    /** Saves the document the way the editor's save button does. */
    saveDoc() {
      return resolveWithin(
        env.apiStore.performMutation({
          mutation: async ({ uploads }) => {
            requests.push(`direct saveDoc with ${describeRequest(uploads)}`);
            await env.serverMock.delayedSetData(docInput.value);
            return { value: docInput.value };
          },
          offline: { operation: 'saveDoc', input: docInput },
        }),
        // Covers the three 200ms uploads and the 1.2s request, without
        // reaching the one-week retention timer of unreferenced uploads.
        3_000,
      );
    },
  };
}

async function reconnect(ms = 3_000) {
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await advanceTime(ms);
}

test('a queued change is sent without an optional image the server refuses, which stays staged as failed', async () => {
  createMockBrowserOpfs();
  network.setOffline();
  const { env, requests, getUploads, ...actions } = createDocWithImagesEnv({
    sessionKey: 'optional-upload-refused-replay',
    uploadOutcomes: { 'img-1': [new UploadError('refused', 'Storage full')] },
  });
  await flushAllTimers();

  // --- Setup: the document is saved offline with its cover and two images ---
  await actions.stageFiles();
  await actions.saveDoc();

  // --- Action: reconnecting replays the change ---
  await reconnect();

  // The refused image is left out, the other uploads are sent, and the
  // request reports which image it was sent without (and why), so the app
  // keeps its local reference for it.
  expect(requests).toMatchInlineSnapshot(`
    - 'upload cover -> server:cover'
    - 'upload img-1 -> Storage full'
    - 'upload img-2 -> server:img-2'
    - 'replay saveDoc with refs {"cover":"server:cover","img-2":"server:img-2"}, without img-1 (Storage full)'
  `);
  // Nothing waits for the user.
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);

  // The uploads the change used are deleted. The refused image was not sent,
  // so its file stays staged (the editor can still render it), marked as
  // failed with the server's answer: nothing retries it on its own.
  expect(getUploads()).toMatchInlineSnapshot(`
    - id: 'img-1'
      lastError: { message: 'Storage full' }
      state: 'failed'
  `);

  // Time passing does not upload it again.
  await advanceTime(60_000);
  expect(requests).toHaveLength(4);
});

test('when every optional image is refused, each is uploaded once and the change is sent without them, also with async classifiers', async () => {
  createMockBrowserOpfs();
  network.setOffline();
  const { env, requests, getUploads, ...actions } = createDocWithImagesEnv({
    sessionKey: 'optional-upload-all-refused-replay',
    uploadOutcomes: {
      'img-1': [new UploadError('refused', 'Storage full')],
      'img-2': [new UploadError('refused', 'Type not accepted')],
    },
    // The second refusal arrives while the first one is being classified.
    classifiersDelayMs: 100,
  });
  await flushAllTimers();

  await actions.stageFiles();
  await actions.saveDoc();
  await reconnect();

  // Each image is sent once, and the request reports the refusal the server
  // gave for each of them.
  expect(requests).toMatchInlineSnapshot(`
    - 'upload cover -> server:cover'
    - 'upload img-1 -> Storage full'
    - 'upload img-2 -> Type not accepted'
    - 'replay saveDoc with refs {"cover":"server:cover"}, without img-1 (Storage full), img-2 (Type not accepted)'
  `);
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  // Both refused images stay staged as failed.
  expect(getUploads()).toMatchInlineSnapshot(`
    - id: 'img-1'
      lastError: { message: 'Storage full' }
      state: 'failed'
    - id: 'img-2'
      lastError: { message: 'Type not accepted' }
      state: 'failed'
  `);
});

test('a change saved online with every optional image refused uploads each image once, also with async classifiers', async () => {
  createMockBrowserOpfs();
  const { requests, ...actions } = createDocWithImagesEnv({
    sessionKey: 'optional-upload-all-refused-direct',
    uploadOutcomes: {
      'img-1': [new UploadError('refused', 'Storage full')],
      'img-2': [new UploadError('refused', 'Type not accepted')],
    },
    classifiersDelayMs: 100,
  });
  await flushAllTimers();

  await actions.stageFiles();
  const result = await actions.saveDoc();

  // The save succeeds without both images, each sent once.
  expect(result.ok).toBe(true);
  expect(requests).toMatchInlineSnapshot(`
    - 'upload cover -> server:cover'
    - 'upload img-1 -> Storage full'
    - 'upload img-2 -> Type not accepted'
    - 'direct saveDoc with refs {"cover":"server:cover"}, without img-1 (Storage full), img-2 (Type not accepted)'
  `);
});

test('a refused required upload still sends the change to manual resolution, even when an optional image was refused too', async () => {
  createMockBrowserOpfs();
  network.setOffline();
  const { env, requests, getUploads, ...actions } = createDocWithImagesEnv({
    sessionKey: 'optional-upload-required-refused',
    uploadOutcomes: {
      'img-1': [new UploadError('refused', 'Storage full')],
      cover: [new UploadError('refused', 'Cover type not accepted')],
    },
  });
  await flushAllTimers();

  await actions.stageFiles();
  await actions.saveDoc();
  await reconnect();

  // The cover is required: the change is not sent without it.
  expect(requests).toMatchInlineSnapshot(`
    - 'upload cover -> Cover type not accepted'
    - 'upload img-1 -> Storage full'
    - 'upload img-2 -> server:img-2'
  `);
  expect(env.apiStore.getOfflineResolutions().map(summarizeResolution))
    .toMatchInlineSnapshot(`
      - error: 'Cover type not accepted'
        input: 'coverId: "cover", imageIds: "img-1", "img-2", value: 2'
        kind: 'retry-exhausted'
        on: 'document:document'
        op: 'saveDoc'
    `);
  // Every upload stays staged for a `retry` of the resolution.
  expect(getUploads()).toMatchInlineSnapshot(`
    - id: 'cover'
      lastError: { message: 'Cover type not accepted' }
      state: 'failed'
    - id: 'img-1'
      lastError: { message: 'Storage full' }
      state: 'failed'
    - { id: 'img-2', state: 'uploaded' }
  `);
});

test('an optional image that fails with a connection error is not dropped: the change waits and is sent with it once the network recovers', async () => {
  createMockBrowserOpfs();
  network.setOffline();
  const { env, storeManager, requests, getUploads, ...actions } =
    createDocWithImagesEnv({
      sessionKey: 'optional-upload-connection-failure',
      uploadOutcomes: {
        'img-1': [new UploadError('connection', 'Network error')],
      },
    });
  await flushAllTimers();
  // The browser reports online, but the server can't be reached yet.
  actions.setServerReachable(false);

  await actions.stageFiles();
  await actions.saveDoc();

  // --- Action: the browser reconnects but the image upload loses the
  // connection ---
  await reconnect();

  // A connection problem is not a refusal: the session goes offline and the
  // change stays queued, without being sent. The upload already running
  // finishes.
  expect(requests).toMatchInlineSnapshot(`
    - 'upload cover -> server:cover'
    - 'upload img-1 -> Network error'
    - 'upload img-2 -> server:img-2'
  `);
  expect(storeManager.getOfflineStatus().network.active).toBe(true);
  expect(
    env.apiStore.getOfflineEntities().map((entity) => entity.syncState),
  ).toMatchInlineSnapshot(`['pending']`);

  // --- Recovery: the server is reachable again ---
  actions.setServerReachable(true);
  await advanceTime(60_000);

  // The change is sent with every image, and nothing was refused.
  expect(requests.slice(3)).toMatchInlineSnapshot(`
    - 'upload img-1 -> server:img-1'
    - 'replay saveDoc with refs {"cover":"server:cover","img-1":"server:img-1","img-2":"server:img-2"}'
  `);
  expect(getUploads()).toMatchInlineSnapshot(`[]`);
});

test('an optional image whose retryable failures use up the replay retries is dropped, and the change is sent without it', async () => {
  createMockBrowserOpfs();
  network.setOffline();
  const busy = new UploadError('busy', 'Server busy');
  const { env, requests, getUploads, ...actions } = createDocWithImagesEnv({
    sessionKey: 'optional-upload-retries-exhausted',
    // As many failures as the default retry budget allows (3).
    uploadOutcomes: { 'img-1': [busy, busy, busy] },
  });
  await flushAllTimers();

  await actions.stageFiles();
  await actions.saveDoc();
  await reconnect(60_000);

  // The image is retried on the replay retry cadence first. Once the budget
  // is used up it is handled as refused, like a required upload would go to
  // manual resolution at that point.
  expect(requests).toMatchInlineSnapshot(`
    - 'upload cover -> server:cover'
    - 'upload img-1 -> Server busy'
    - 'upload img-2 -> server:img-2'
    - 'upload img-1 -> Server busy'
    - 'upload img-1 -> Server busy'
    - 'replay saveDoc with refs {"cover":"server:cover","img-2":"server:img-2"}, without img-1 (Server busy)'
  `);
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  expect(getUploads()).toMatchInlineSnapshot(`
    - id: 'img-1'
      lastError: { message: 'Server busy' }
      state: 'failed'
  `);
});

test('a change saved online is sent without an optional image the server refuses', async () => {
  createMockBrowserOpfs();
  const { env, requests, getUploads, ...actions } = createDocWithImagesEnv({
    sessionKey: 'optional-upload-refused-direct',
    uploadOutcomes: { 'img-2': [new UploadError('refused', 'Storage full')] },
  });
  await flushAllTimers();

  await actions.stageFiles();
  const result = await actions.saveDoc();

  // The direct request runs right away, without the refused image, and
  // learns which image was left out, as `execute` does on replay.
  expect(result.ok).toBe(true);
  expect(requests).toMatchInlineSnapshot(`
    - 'upload cover -> server:cover'
    - 'upload img-1 -> server:img-1'
    - 'upload img-2 -> Storage full'
    - 'direct saveDoc with refs {"cover":"server:cover","img-1":"server:img-1"}, without img-2 (Storage full)'
  `);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);

  // Only the refused image stays staged.
  expect(getUploads()).toMatchInlineSnapshot(`
    - id: 'img-2'
      lastError: { message: 'Storage full' }
      state: 'failed'
  `);
});

test('an optional image failing with a retryable error during an online save fails the save instead of dropping the image', async () => {
  createMockBrowserOpfs();
  const { env, requests, getUploads, ...actions } = createDocWithImagesEnv({
    sessionKey: 'optional-upload-retryable-direct',
    uploadOutcomes: { 'img-1': [new UploadError('busy', 'Server busy')] },
  });
  await flushAllTimers();

  await actions.stageFiles();
  const result = await actions.saveDoc();

  // A busy server may accept the image on the next attempt, so the save
  // fails with that error as for a required upload, and the request is not
  // sent. The upload already running finishes.
  expect(result.ok ? null : result.error).toMatchInlineSnapshot(`
    Error#:
      message: 'Server busy'
      name: 'StoreMutationError'
      kind: 'error'
      code: 500
      id: 'fetch-error'
      cause:
        Error#: { message: 'Server busy', name: 'Error', kind: 'busy' }
  `);
  expect(requests).toMatchInlineSnapshot(`
    - 'upload cover -> server:cover'
    - 'upload img-1 -> Server busy'
    - 'upload img-2 -> server:img-2'
  `);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);

  // Saving again uploads the image and sends the change with it.
  await actions.saveDoc();
  expect(requests.slice(3)).toMatchInlineSnapshot(`
    - 'upload img-1 -> server:img-1'
    - 'direct saveDoc with refs {"cover":"server:cover","img-1":"server:img-1","img-2":"server:img-2"}'
  `);
  expect(getUploads()).toMatchInlineSnapshot(`[]`);
});

test('with the session gate closed, an optional image the server refuses fails the online save instead of being dropped', async () => {
  createMockBrowserOpfs();
  const { env, requests, getUploads, ...actions } = createDocWithImagesEnv({
    sessionKey: 'optional-upload-refused-gate-closed',
    uploadOutcomes: { 'img-1': [new UploadError('refused', 'Storage full')] },
    // The offline layer is turned off, e.g. by a feature flag.
    enabled: () => false,
  });
  await flushAllTimers();

  await actions.stageFiles();
  const result = await actions.saveDoc();

  // Upload failures are not classified with the gate closed, so the refused
  // image fails the save like a required upload would, and the request is
  // not sent.
  expect(result.ok ? null : result.error).toMatchInlineSnapshot(`
    Error#:
      message: 'Storage full'
      name: 'StoreMutationError'
      kind: 'error'
      code: 500
      id: 'fetch-error'
      cause:
        Error#: { message: 'Storage full', name: 'Error', kind: 'refused' }
  `);
  expect(requests).toMatchInlineSnapshot(`
    - 'upload cover -> server:cover'
    - 'upload img-1 -> Storage full'
    - 'upload img-2 -> server:img-2'
  `);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  // The refused image stays staged, as failed.
  expect(getUploads()).toMatchInlineSnapshot(`
    - { id: 'cover', state: 'uploaded' }
    - id: 'img-1'
      lastError: { message: 'Storage full' }
      state: 'failed'
    - { id: 'img-2', state: 'uploaded' }
  `);
});
