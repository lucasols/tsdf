import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_array, rc_number, rc_object, rc_string } from 'runcheck';
import { expect, test, vi } from 'vitest';
import type {
  DocumentOfflineOperationDefinition,
  OfflineSessionConfig,
} from '../../src/main';
import { createStoreManager, opfsOfflineUploadAdapter } from '../../src/main';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createMockBrowserOpfs } from '../mocks/mockBrowserOpfs';
import { normalizeError } from '../mocks/testEnvUtils';
import {
  advanceTime,
  flushAllTimers,
  pick,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import { getOpfsDirTree } from '../utils/persistentStorageOptimizationTestUtils';
import {
  docSchema,
  getGlobalOfflineStatusSummary,
  summarizeResolution,
} from './offlineTestShared';
import {
  network,
  resolveWithin,
  setupOfflineUploadTests,
  type UploadDependencyOperations,
} from './offlineUploadsTestShared';

setupOfflineUploadTests();

/**
 * Error thrown by the upload transport in the failure-handling tests below. A
 * real transport throws whatever its HTTP client throws; what matters is that
 * the session classifiers can tell a connection problem, a server outage and a
 * rejected file apart.
 */
class UploadTransportError extends Error {
  kind: 'connection' | 'server-down' | 'rejected-file';

  constructor(kind: UploadTransportError['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Recovery probes at 5s, 10s, 20s, ... without random jitter. */
const deterministicRecoveryProbe = {
  initialIntervalMs: 5_000,
  maxIntervalMs: 60_000,
  backoffMultiplier: 2,
  jitterRatio: 0,
} as const;

/**
 * Document store with one `updateWithAttachment` offline operation that
 * depends on a staged upload, plus a scripted upload transport.
 *
 * The timeline (`env.timelineString`) tracks what a UI would show: the upload
 * state (and its last error), the sync state of the dependent operation and
 * the session connectivity mode. `requests` lists what reached the server.
 */
function createUploadFailureTestEnv({
  sessionKey,
  storeId,
  offlineSession,
  uploadAttempts,
}: {
  sessionKey: string;
  storeId: string;
  /** Session classifiers and modes under test (the uploads config is added here). */
  offlineSession: Omit<OfflineSessionConfig<string>, 'uploads'>;
  /** Outcome of each transport call, in order. Calls past the end succeed. */
  uploadAttempts: Array<UploadTransportError | 'success'>;
}) {
  const requests: string[] = [];
  let transportCalls = 0;

  const storeManager = createStoreManager({
    getSessionKey: () => sessionKey,
    errorNormalizer: normalizeError,
    offlineSession: {
      ...offlineSession,
      uploads: {
        adapter: opfsOfflineUploadAdapter,
        upload: async ({ id }) => {
          const outcome = uploadAttempts[transportCalls] ?? 'success';
          transportCalls += 1;
          // Every upload request takes 200ms to succeed or fail.
          await new Promise((resolve) => setTimeout(resolve, 200));

          if (outcome !== 'success') {
            requests.push(`upload ${id} -> ${outcome.message}`);
            throw outcome;
          }

          requests.push(`upload ${id} -> server:${id}`);
          return `server:${id}`;
        },
      },
    },
  });

  const env = createDocumentStoreTestEnv<number, UploadDependencyOperations>(
    1,
    {
      id: storeId,
      storeManager,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          operations: {
            updateWithAttachment: {
              inputSchema: rc_object({
                attachmentId: rc_string,
                value: rc_number,
              }),
              kind: 'update',
              dependsOnUploads: ({ input }) => [input.attachmentId],
              execute: async (ctx) => {
                const resolvedRef =
                  ctx.uploads.resolvedRefsById[ctx.input.attachmentId];
                requests.push(
                  `execute updateWithAttachment with ${JSON.stringify(resolvedRef)}`,
                );
                await env.serverMock.delayedSetData(ctx.input.value);
                return { value: ctx.input.value };
              },
              onSuccessExecute: ({ input }) => {
                env.apiStore.updateState((draft) => {
                  draft.value = input.value;
                });
              },
            },
          },
        },
      },
    },
  );

  const uiHook = renderHook(() => {
    const uploads = storeManager.useOfflineUploads();
    const upload = uploads[0];
    const entity = env.apiStore.useOfflineEntities()[0];
    const status = storeManager.useOfflineStatus();

    const uploadLabel = upload
      ? `${upload.state}${upload.lastError ? ` (${upload.lastError.message})` : ''}`
      : 'none';
    const sessionLabel = status.outage.active
      ? 'outage'
      : status.network.active
        ? 'network-offline'
        : 'online';

    env.trackUIChanges(
      `upload:${uploadLabel} | op:${entity?.syncState ?? 'none'} | session:${sessionLabel}`,
    );

    return uploads;
  });

  // The calls below run inside `act` because the tracked UI re-renders
  // synchronously with them.
  async function stageDependencyUpload() {
    await act(async () => {
      (
        await resolveAfterAllTimers(
          storeManager.saveOfflineUpload({
            id: 'asset-1',
            file: new File(['attachment body'], 'attachment.txt', {
              type: 'text/plain',
              lastModified: 1,
            }),
          }),
        )
      ).unwrap();
    });
  }

  return {
    env,
    requests,
    unmount: () => uiHook.unmount(),
    /** Uploads as the UI currently sees them through `useOfflineUploads()`. */
    getUploads: () => uiHook.result.current,
    /** Stages the `asset-1` file without queueing anything that depends on it. */
    stageUpload: stageDependencyUpload,
    /** Stages the `asset-1` upload and queues the mutation that depends on it. */
    async stageUploadAndQueueDependentMutation() {
      await stageDependencyUpload();
      await act(async () => {
        await resolveAfterAllTimers(
          env.apiStore.performMutation({
            mutation: () => Promise.resolve({ value: 3 }),
            offline: {
              operation: 'updateWithAttachment',
              input: { attachmentId: 'asset-1', value: 3 },
            },
          }),
        );
      });
    },
    /** Uploads the staged `asset-1` file through the online path. */
    resolveUploadOnline() {
      return act(async () => {
        const pendingResult = storeManager.resolveOfflineUpload('asset-1');
        // Covers the 200ms transport request without reaching the one-week
        // retention timer of unreferenced uploads.
        await advanceTime(1_000);
        return pendingResult;
      });
    },
  };
}

test('a dependency upload that fails with a connection error stays pending and is uploaded again once the network recovers', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'upload-connection-failure-session';
  let uploadEndpointReachable = false;
  const classifiedFailures: unknown[] = [];

  // The browser starts offline so the upload and its mutation are queued.
  network.setOffline();

  const { env, requests, unmount, ...actions } = createUploadFailureTestEnv({
    sessionKey,
    storeId: 'upload-connection-failure-doc',
    offlineSession: {
      // The session treats connection errors as "network is down", exactly
      // like it does for a failed `execute`.
      classifyFailure: (error, ctx) => {
        classifiedFailures.push(ctx);
        return error instanceof UploadTransportError &&
          error.kind === 'connection'
          ? 'network'
          : 'ignore';
      },
      network: {
        ...network.config,
        recoveryCheck: () => uploadEndpointReachable,
        recoveryProbe: deterministicRecoveryProbe,
      },
    },
    // The browser reports online, but the upload endpoint is unreachable.
    uploadAttempts: [
      new UploadTransportError('connection', 'Upload failed: Network error'),
    ],
  });
  await flushAllTimers();
  env.clearTimeline();

  await actions.stageUploadAndQueueDependentMutation();

  env.addTimelineComments('beforeNextAction', [
    'browser reconnects, but the upload endpoint is still unreachable',
  ]);
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  // Long enough for three failed recovery probes (after 5s, 15s and 35s).
  await advanceTime(40_000);

  // The classifier is told which upload failed, on top of the usual context
  // of the operation that was being replayed.
  expect(classifiedFailures).toMatchInlineSnapshot(`
    - operationName: 'updateWithAttachment'
      phase: 'sync'
      sessionKey: 'upload-connection-failure-session'
      storeType: 'document'
      uploadId: 'asset-1'
  `);

  // The upload was attempted once and the operation never reached the server.
  expect(requests).toMatchInlineSnapshot(
    `['upload asset-1 -> Upload failed: Network error']`,
  );

  // The upload is waiting to be sent again (not failed), the operation is
  // still queued and nothing asks the user for manual resolution.
  expect(
    actions
      .getUploads()
      .map((upload) => pick(upload, ['id', 'state', 'lastError'])),
  ).toMatchInlineSnapshot(`
    - id: 'asset-1'
      lastError: { message: 'Upload failed: Network error' }
      state: 'pending'
  `);
  expect(
    env.apiStore
      .getOfflineEntities()
      .map((entity) =>
        pick(entity, ['syncState', 'pendingMutations', 'requiresResolution']),
      ),
  ).toMatchInlineSnapshot(
    `- { pendingMutations: 1, requiresResolution: '❌', syncState: 'pending' }`,
  );
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);

  env.addTimelineComments('beforeNextAction', [
    'the upload endpoint is reachable again; the next recovery probe notices it',
  ]);
  uploadEndpointReachable = true;
  // The backoff puts the next probe 40s after the previous one.
  await advanceTime(40_000);

  // The upload ran again and the operation executed exactly once, with the
  // ref returned by the successful upload.
  expect(requests).toMatchInlineSnapshot(`
    - 'upload asset-1 -> Upload failed: Network error'
    - 'upload asset-1 -> server:asset-1'
    - 'execute updateWithAttachment with "server:asset-1"'
  `);

  // The operation that depended on the upload was sent, so the staged file
  // was deleted. The timeline above shows it reached `uploaded` without the
  // earlier error before that.
  expect(
    actions
      .getUploads()
      .map((upload) =>
        pick(upload, ['id', 'state', 'resolvedRef', 'lastError']),
      ),
  ).toMatchInlineSnapshot(`[]`);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time    | ui                                                                                     |
    12s     | -                                                                                      | -- timeline-cleared
    12.009s | "upload:pending | op:none | session:network-offline"                                   | ui-changed
    .       | "upload:pending | op:pending | session:network-offline"                                | ui-changed
    .       | "upload:pending | op:pending | session:network-offline"                                | offline:updateWithAttachment queued
    .       | "upload:pending | op:pending | session:network-offline"                                | -- browser reconnects, but the upload endpoint is still unreachable
    .       | "upload:pending | op:pending | session:online"                                         | ui-changed
    .       | "upload:pending | op:syncing | session:online"                                         | ui-changed
    12.018s | "upload:uploading | op:syncing | session:online"                                       | ui-changed
    12.227s | "upload:pending (Upload failed: Network error) | op:syncing | session:online"          | ui-changed
    .       | "upload:pending (Upload failed: Network error) | op:syncing | session:network-offline" | ui-changed
    .       | "upload:pending (Upload failed: Network error) | op:pending | session:network-offline" | ui-changed
    87.227s | "upload:pending (Upload failed: Network error) | op:pending | session:network-offline" | -- the upload endpoint is reachable again; the next recovery probe notices it
    .       | "upload:pending (Upload failed: Network error) | op:pending | session:online"          | ui-changed
    .       | "upload:pending (Upload failed: Network error) | op:syncing | session:online"          | ui-changed
    87.236s | "upload:uploading (Upload failed: Network error) | op:syncing | session:online"        | ui-changed
    87.445s | "upload:uploaded | op:syncing | session:online"                                        | ui-changed
    .       | "upload:uploaded | op:syncing | session:online"                                        | offline:updateWithAttachment replay-started
    88.645s | "upload:uploaded | op:syncing | session:online"                                        | server-data-changed (value: 3)
    .       | "upload:uploaded | op:syncing | session:online"                                        | offline:updateWithAttachment replay-finished
    .       | "upload:uploaded | op:none | session:online"                                           | ui-changed
    88.647s | "upload:none | op:none | session:online"                                               | ui-changed
    "
  `);

  unmount();
});

test('a dependency upload failure classified as an outage puts the session in outage mode and is uploaded again after the outage ends', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'upload-outage-failure-session';
  let serverIsBack = false;

  network.setOffline();

  const { env, requests, unmount, ...actions } = createUploadFailureTestEnv({
    sessionKey,
    storeId: 'upload-outage-failure-doc',
    offlineSession: {
      classifyFailure: (error) =>
        error instanceof UploadTransportError && error.kind === 'server-down'
          ? 'outage'
          : 'ignore',
      network: network.config,
      outage: {
        enabled: true,
        recoveryCheck: () => serverIsBack,
        recoveryProbe: deterministicRecoveryProbe,
      },
    },
    uploadAttempts: [
      new UploadTransportError('server-down', 'Upload failed: 503'),
    ],
  });
  await flushAllTimers();
  env.clearTimeline();

  await actions.stageUploadAndQueueDependentMutation();

  env.addTimelineComments('beforeNextAction', [
    'browser reconnects while the upload service answers 503',
  ]);
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await advanceTime(40_000);

  // The session is in outage mode, the same as after an outage-classified
  // `execute` failure.
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '✅'
    network: { active: '❌', enabled: '✅' }
    outage: { active: '✅', enabled: '✅' }
    sessionKey: 'upload-outage-failure-session'
  `);

  // The upload keeps waiting and the operation stays queued without any
  // manual resolution, no matter how long the outage lasts.
  expect(
    actions
      .getUploads()
      .map((upload) => pick(upload, ['id', 'state', 'lastError'])),
  ).toMatchInlineSnapshot(`
    - id: 'asset-1'
      lastError: { message: 'Upload failed: 503' }
      state: 'pending'
  `);
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);

  env.addTimelineComments('beforeNextAction', [
    'the upload service is back; the next outage recovery probe notices it',
  ]);
  serverIsBack = true;
  await advanceTime(40_000);

  expect(requests).toMatchInlineSnapshot(`
    - 'upload asset-1 -> Upload failed: 503'
    - 'upload asset-1 -> server:asset-1'
    - 'execute updateWithAttachment with "server:asset-1"'
  `);
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '❌'
    network: { active: '❌', enabled: '✅' }
    outage: { active: '❌', enabled: '✅' }
    sessionKey: 'upload-outage-failure-session'
  `);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time    | ui                                                                    |
    12s     | -                                                                     | -- timeline-cleared
    12.009s | "upload:pending | op:none | session:network-offline"                  | ui-changed
    .       | "upload:pending | op:pending | session:network-offline"               | ui-changed
    .       | "upload:pending | op:pending | session:network-offline"               | offline:updateWithAttachment queued
    .       | "upload:pending | op:pending | session:network-offline"               | -- browser reconnects while the upload service answers 503
    .       | "upload:pending | op:pending | session:online"                        | ui-changed
    .       | "upload:pending | op:syncing | session:online"                        | ui-changed
    12.018s | "upload:uploading | op:syncing | session:online"                      | ui-changed
    12.227s | "upload:pending (Upload failed: 503) | op:syncing | session:online"   | ui-changed
    .       | "upload:pending (Upload failed: 503) | op:syncing | session:outage"   | ui-changed
    .       | "upload:pending (Upload failed: 503) | op:pending | session:outage"   | ui-changed
    87.227s | "upload:pending (Upload failed: 503) | op:pending | session:outage"   | -- the upload service is back; the next outage recovery probe notices it
    .       | "upload:pending (Upload failed: 503) | op:pending | session:online"   | ui-changed
    .       | "upload:pending (Upload failed: 503) | op:syncing | session:online"   | ui-changed
    87.236s | "upload:uploading (Upload failed: 503) | op:syncing | session:online" | ui-changed
    87.445s | "upload:uploaded | op:syncing | session:online"                       | ui-changed
    .       | "upload:uploaded | op:syncing | session:online"                       | offline:updateWithAttachment replay-started
    88.645s | "upload:uploaded | op:syncing | session:online"                       | server-data-changed (value: 3)
    .       | "upload:uploaded | op:syncing | session:online"                       | offline:updateWithAttachment replay-finished
    .       | "upload:uploaded | op:none | session:online"                          | ui-changed
    88.647s | "upload:none | op:none | session:online"                              | ui-changed
    "
  `);

  unmount();
});

test('a dependency upload failure marked as retryable is uploaded again on the replay retry cadence without failing the upload', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'upload-retryable-failure-session';

  network.setOffline();

  const { env, requests, unmount, ...actions } = createUploadFailureTestEnv({
    sessionKey,
    storeId: 'upload-retryable-failure-doc',
    offlineSession: {
      network: network.config,
      // A timeout is not a connectivity problem for the whole session, but
      // sending the upload again is safe.
      classifyRetryableFailure: (error, ctx) =>
        ctx.uploadId !== undefined &&
        error instanceof UploadTransportError &&
        error.kind === 'connection',
    },
    // Two timeouts, then the upload goes through.
    uploadAttempts: [
      new UploadTransportError('connection', 'Upload timed out'),
      new UploadTransportError('connection', 'Upload timed out'),
    ],
  });
  await flushAllTimers();
  env.clearTimeline();

  await actions.stageUploadAndQueueDependentMutation();

  env.addTimelineComments('beforeNextAction', [
    'browser reconnects; the first two upload attempts time out',
  ]);
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  // Replay retries every 5s by default: attempts at 0s, 5s and 10s.
  await advanceTime(15_000);

  // Two failures stayed below the default budget of 3, so the third attempt
  // uploaded the file and the operation executed once.
  expect(requests).toMatchInlineSnapshot(`
    - 'upload asset-1 -> Upload timed out'
    - 'upload asset-1 -> Upload timed out'
    - 'upload asset-1 -> server:asset-1'
    - 'execute updateWithAttachment with "server:asset-1"'
  `);
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  // The operation was sent, so the staged file it depended on was deleted.
  expect(
    actions
      .getUploads()
      .map((upload) =>
        pick(upload, ['id', 'state', 'resolvedRef', 'lastError']),
      ),
  ).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time    | ui                                                                           |
    12s     | -                                                                            | -- timeline-cleared
    12.009s | "upload:pending | op:none | session:network-offline"                         | ui-changed
    .       | "upload:pending | op:pending | session:network-offline"                      | ui-changed
    .       | "upload:pending | op:pending | session:network-offline"                      | offline:updateWithAttachment queued
    .       | "upload:pending | op:pending | session:network-offline"                      | -- browser reconnects; the first two upload attempts time out
    .       | "upload:pending | op:pending | session:online"                               | ui-changed
    .       | "upload:pending | op:syncing | session:online"                               | ui-changed
    12.018s | "upload:uploading | op:syncing | session:online"                             | ui-changed
    12.227s | "upload:pending (Upload timed out) | op:syncing | session:online"            | ui-changed
    .       | "upload:pending (Upload timed out) | op:needs-confirmation | session:online" | ui-changed
    17.227s | "upload:pending (Upload timed out) | op:syncing | session:online"            | ui-changed
    17.236s | "upload:uploading (Upload timed out) | op:syncing | session:online"          | ui-changed
    17.445s | "upload:pending (Upload timed out) | op:syncing | session:online"            | ui-changed
    .       | "upload:pending (Upload timed out) | op:needs-confirmation | session:online" | ui-changed
    22.445s | "upload:pending (Upload timed out) | op:syncing | session:online"            | ui-changed
    22.454s | "upload:uploading (Upload timed out) | op:syncing | session:online"          | ui-changed
    22.663s | "upload:uploaded | op:syncing | session:online"                              | ui-changed
    .       | "upload:uploaded | op:syncing | session:online"                              | offline:updateWithAttachment replay-started
    23.863s | "upload:uploaded | op:syncing | session:online"                              | server-data-changed (value: 3)
    .       | "upload:uploaded | op:syncing | session:online"                              | offline:updateWithAttachment replay-finished
    .       | "upload:uploaded | op:none | session:online"                                 | ui-changed
    23.865s | "upload:none | op:none | session:online"                                     | ui-changed
    "
  `);

  unmount();
});

test('a retryable dependency upload failure that keeps failing uses up the replay retry budget and then requires manual resolution', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'upload-retry-budget-session';
  const uploadTimeout = new UploadTransportError(
    'connection',
    'Upload timed out',
  );

  network.setOffline();

  const { env, requests, unmount, ...actions } = createUploadFailureTestEnv({
    sessionKey,
    storeId: 'upload-retry-budget-doc',
    offlineSession: {
      network: network.config,
      classifyRetryableFailure: (error) =>
        error instanceof UploadTransportError && error.kind === 'connection',
    },
    // As many timeouts as the default retry budget allows (3 failures).
    uploadAttempts: [uploadTimeout, uploadTimeout, uploadTimeout],
  });
  await flushAllTimers();
  env.clearTimeline();

  await actions.stageUploadAndQueueDependentMutation();

  env.addTimelineComments('beforeNextAction', [
    'browser reconnects; every upload attempt times out',
  ]);
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await advanceTime(60_000);

  // After the third failure nothing is retried anymore: the operation waits
  // for the user and the upload is reported as failed.
  expect(requests).toMatchInlineSnapshot(`
    - 'upload asset-1 -> Upload timed out'
    - 'upload asset-1 -> Upload timed out'
    - 'upload asset-1 -> Upload timed out'
  `);
  expect(env.apiStore.getOfflineResolutions().map(summarizeResolution))
    .toMatchInlineSnapshot(`
      - error: 'Upload timed out'
        input: 'attachmentId: "asset-1", value: 3'
        kind: 'retry-exhausted'
        on: 'document:document'
        op: 'updateWithAttachment'
    `);
  expect(
    actions
      .getUploads()
      .map((upload) => pick(upload, ['id', 'state', 'lastError'])),
  ).toMatchInlineSnapshot(`
    - id: 'asset-1'
      lastError: { message: 'Upload timed out' }
      state: 'failed'
  `);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time    | ui                                                                           |
    12s     | -                                                                            | -- timeline-cleared
    12.009s | "upload:pending | op:none | session:network-offline"                         | ui-changed
    .       | "upload:pending | op:pending | session:network-offline"                      | ui-changed
    .       | "upload:pending | op:pending | session:network-offline"                      | offline:updateWithAttachment queued
    .       | "upload:pending | op:pending | session:network-offline"                      | -- browser reconnects; every upload attempt times out
    .       | "upload:pending | op:pending | session:online"                               | ui-changed
    .       | "upload:pending | op:syncing | session:online"                               | ui-changed
    12.018s | "upload:uploading | op:syncing | session:online"                             | ui-changed
    12.227s | "upload:pending (Upload timed out) | op:syncing | session:online"            | ui-changed
    .       | "upload:pending (Upload timed out) | op:needs-confirmation | session:online" | ui-changed
    17.227s | "upload:pending (Upload timed out) | op:syncing | session:online"            | ui-changed
    17.236s | "upload:uploading (Upload timed out) | op:syncing | session:online"          | ui-changed
    17.445s | "upload:pending (Upload timed out) | op:syncing | session:online"            | ui-changed
    .       | "upload:pending (Upload timed out) | op:needs-confirmation | session:online" | ui-changed
    22.445s | "upload:pending (Upload timed out) | op:syncing | session:online"            | ui-changed
    22.454s | "upload:uploading (Upload timed out) | op:syncing | session:online"          | ui-changed
    22.663s | "upload:pending (Upload timed out) | op:syncing | session:online"            | ui-changed
    22.672s | "upload:failed (Upload timed out) | op:syncing | session:online"             | ui-changed
    .       | "upload:failed (Upload timed out) | op:syncing | session:online"             | offline:updateWithAttachment resolution-required
    .       | "upload:failed (Upload timed out) | op:resolution-required | session:online" | ui-changed
    "
  `);

  unmount();
});

test('a permanently rejected dependency upload sends the operation to manual resolution, where retry uploads the file again', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'upload-permanent-failure-session';

  network.setOffline();

  const { env, requests, unmount, ...actions } = createUploadFailureTestEnv({
    sessionKey,
    storeId: 'upload-permanent-failure-doc',
    // No classifier recognizes the error: it is neither a connectivity
    // problem nor safe to retry automatically, so it is a permanent failure.
    offlineSession: { network: network.config },
    uploadAttempts: [
      new UploadTransportError('rejected-file', 'File type not accepted'),
    ],
  });
  await flushAllTimers();
  env.clearTimeline();

  await actions.stageUploadAndQueueDependentMutation();

  env.addTimelineComments('beforeNextAction', [
    'browser reconnects and the server rejects the file',
  ]);
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  // Just the time the upload request takes: no retry timer is involved.
  await advanceTime(1_000);

  // The operation never executed and is now a resolution that carries the
  // upload error and points to the upload it depends on.
  expect(requests).toMatchInlineSnapshot(
    `['upload asset-1 -> File type not accepted']`,
  );
  const [resolution] = env.apiStore.getOfflineResolutions();
  if (!resolution || resolution.kind !== 'retry-exhausted') {
    throw new Error('Expected a retry-exhausted resolution');
  }
  expect(
    pick(resolution, [
      'kind',
      'operation',
      'lastReplayError',
      'dependencyUploadIds',
    ]),
  ).toMatchInlineSnapshot(`
    dependencyUploadIds: ['asset-1']
    kind: 'retry-exhausted'
    lastReplayError: { message: 'File type not accepted' }
    operation: 'updateWithAttachment'
  `);

  // The upload is marked as failed, with the error the transport reported.
  expect(
    actions
      .getUploads()
      .map((upload) => pick(upload, ['id', 'state', 'lastError'])),
  ).toMatchInlineSnapshot(`
    - id: 'asset-1'
      lastError: { message: 'File type not accepted' }
      state: 'failed'
  `);

  // Time passing does not retry a permanent failure on its own.
  await advanceTime(60_000);
  expect(requests).toHaveLength(1);

  env.addTimelineComments('beforeNextAction', [
    'the server now accepts the file and the user resolves with "retry"',
  ]);
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(
      resolution.id,
      'updateWithAttachment',
      { action: 'retry' },
    );
  });
  await advanceTime(5_000);

  // Retry uploaded the file again and then executed the operation once.
  expect(requests).toMatchInlineSnapshot(`
    - 'upload asset-1 -> File type not accepted'
    - 'upload asset-1 -> server:asset-1'
    - 'execute updateWithAttachment with "server:asset-1"'
  `);
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);

  // The operation that depended on the upload was sent, so the staged file
  // was deleted. The timeline above shows it reached `uploaded` without the
  // earlier error before that.
  expect(
    actions
      .getUploads()
      .map((upload) =>
        pick(upload, ['id', 'state', 'resolvedRef', 'lastError']),
      ),
  ).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time    | ui                                                                                 |
    12s     | -                                                                                  | -- timeline-cleared
    12.009s | "upload:pending | op:none | session:network-offline"                               | ui-changed
    .       | "upload:pending | op:pending | session:network-offline"                            | ui-changed
    .       | "upload:pending | op:pending | session:network-offline"                            | offline:updateWithAttachment queued
    .       | "upload:pending | op:pending | session:network-offline"                            | -- browser reconnects and the server rejects the file
    .       | "upload:pending | op:pending | session:online"                                     | ui-changed
    .       | "upload:pending | op:syncing | session:online"                                     | ui-changed
    12.018s | "upload:uploading | op:syncing | session:online"                                   | ui-changed
    12.227s | "upload:pending (File type not accepted) | op:syncing | session:online"            | ui-changed
    12.236s | "upload:failed (File type not accepted) | op:syncing | session:online"             | ui-changed
    .       | "upload:failed (File type not accepted) | op:syncing | session:online"             | offline:updateWithAttachment resolution-required
    .       | "upload:failed (File type not accepted) | op:resolution-required | session:online" | ui-changed
    73.009s | "upload:failed (File type not accepted) | op:resolution-required | session:online" | -- the server now accepts the file and the user resolves with "retry"
    .       | "upload:failed (File type not accepted) | op:pending | session:online"             | ui-changed
    .       | "upload:failed (File type not accepted) | op:syncing | session:online"             | ui-changed
    73.018s | "upload:uploading (File type not accepted) | op:syncing | session:online"          | ui-changed
    73.227s | "upload:uploaded | op:syncing | session:online"                                    | ui-changed
    .       | "upload:uploaded | op:syncing | session:online"                                    | offline:updateWithAttachment replay-started
    74.427s | "upload:uploaded | op:syncing | session:online"                                    | server-data-changed (value: 3)
    .       | "upload:uploaded | op:syncing | session:online"                                    | offline:updateWithAttachment replay-finished
    .       | "upload:uploaded | op:none | session:online"                                       | ui-changed
    74.429s | "upload:none | op:none | session:online"                                           | ui-changed
    "
  `);

  unmount();
});

test('discarding the resolution of a rejected dependency upload removes the operation without uploading again', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'upload-permanent-failure-discard-session';

  network.setOffline();

  const { env, requests, unmount, ...actions } = createUploadFailureTestEnv({
    sessionKey,
    storeId: 'upload-permanent-failure-discard-doc',
    offlineSession: { network: network.config },
    uploadAttempts: [
      new UploadTransportError('rejected-file', 'File is too large'),
    ],
  });
  await flushAllTimers();
  env.clearTimeline();

  await actions.stageUploadAndQueueDependentMutation();

  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await advanceTime(1_000);

  const [resolution] = env.apiStore.getOfflineResolutions();
  if (!resolution) throw new Error('Expected a resolution');
  expect(summarizeResolution(resolution)).toMatchInlineSnapshot(`
    error: 'File is too large'
    input: 'attachmentId: "asset-1", value: 3'
    kind: 'retry-exhausted'
    on: 'document:document'
    op: 'updateWithAttachment'
  `);

  // The discard resolves once the staged file was deleted from storage, which
  // needs the (fake) clock to move.
  await resolveWithin(
    env.apiStore.resolveOfflineResolution(
      resolution.id,
      'updateWithAttachment',
      { action: 'discard' },
    ),
  );
  await advanceTime(10_000);

  // The operation is gone and nothing else was sent to the server.
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(requests).toMatchInlineSnapshot(
    `['upload asset-1 -> File is too large']`,
  );

  // Nothing else depends on the staged file, so the discard deleted it too.
  expect(
    actions
      .getUploads()
      .map((upload) => pick(upload, ['id', 'state', 'lastError'])),
  ).toMatchInlineSnapshot(`[]`);

  unmount();
});

type TwoAttachmentsOperations = {
  saveAttachments: DocumentOfflineOperationDefinition<
    { value: number },
    { input: { attachmentIds: string[]; value: number } }
  >;
};

/**
 * Document whose `saveAttachments` mutation depends on two staged uploads,
 * `photo` (a 200ms request) and `video` (a 5s request), with a scripted
 * outcome for each file. No session classifier recognizes the transport
 * errors, so a failed upload is a permanent failure.
 */
function createTwoAttachmentsUploadEnv({
  sessionKey,
  videoOutcome,
}: {
  sessionKey: string;
  /** What the server answers once the slow `video` upload finishes. */
  videoOutcome: 'rejected' | 'success';
}) {
  const requests: string[] = [];
  const storeManager = createStoreManager({
    getSessionKey: () => sessionKey,
    errorNormalizer: normalizeError,
    offlineSession: {
      network: network.config,
      uploads: {
        adapter: opfsOfflineUploadAdapter,
        concurrency: 2,
        upload: async ({ id }) => {
          const isVideo = id === 'video';
          await new Promise((resolve) =>
            setTimeout(resolve, isVideo ? 5_000 : 200),
          );

          if (!isVideo || videoOutcome === 'rejected') {
            requests.push(`upload ${id} -> rejected`);
            throw new UploadTransportError(
              'rejected-file',
              `${id} type not accepted`,
            );
          }

          requests.push(`upload ${id} -> server:${id}`);
          return `server:${id}`;
        },
      },
    },
  });

  const env = createDocumentStoreTestEnv<number, TwoAttachmentsOperations>(1, {
    id: `${sessionKey}-doc`,
    storeManager,
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        operations: {
          saveAttachments: {
            inputSchema: rc_object({
              attachmentIds: rc_array(rc_string),
              value: rc_number,
            }),
            kind: 'update',
            dependsOnUploads: ({ input }) => input.attachmentIds,
            execute: ({ input }) => {
              requests.push('execute saveAttachments');
              return Promise.resolve({ value: input.value });
            },
          },
        },
      },
    },
  });

  function getUploads() {
    return storeManager
      .getOfflineUploads()
      .map((upload) => pick(upload, ['id', 'state', 'lastError']));
  }

  /** Stages both files offline and queues the mutation that needs them. */
  async function queueMutationWithBothFiles() {
    for (const id of ['photo', 'video']) {
      (
        await resolveWithin(
          storeManager.saveOfflineUpload({
            id,
            file: new File([`${id} bytes`], `${id}.bin`, { lastModified: 1 }),
          }),
        )
      ).unwrap();
    }
    await resolveWithin(
      env.apiStore.performMutation({
        mutation: () => Promise.resolve({ value: 2 }),
        offline: {
          operation: 'saveAttachments',
          input: { attachmentIds: ['photo', 'video'], value: 2 },
        },
      }),
    );
  }

  return { env, requests, getUploads, queueMutationWithBothFiles };
}

test('when several dependency uploads of an operation are rejected, every rejected upload ends up failed, including the ones that finish after the operation moved to manual resolution', async () => {
  createMockBrowserOpfs();
  network.setOffline();
  const { env, requests, getUploads, queueMutationWithBothFiles } =
    createTwoAttachmentsUploadEnv({
      sessionKey: 'two-rejected-uploads-session',
      videoOutcome: 'rejected',
    });
  await flushAllTimers();

  await queueMutationWithBothFiles();

  // --- Action: reconnect; the photo is rejected first ---
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await advanceTime(1_000);

  // The operation is already waiting for a manual resolution while the video
  // is still being sent.
  expect(requests).toMatchInlineSnapshot(`['upload photo -> rejected']`);
  expect(
    env.apiStore.getOfflineResolutions().map((resolution) => resolution.kind),
  ).toMatchInlineSnapshot(`['retry-exhausted']`);
  expect(getUploads()).toMatchInlineSnapshot(`
    - id: 'photo'
      lastError: { message: 'photo type not accepted' }
      state: 'failed'
    - { id: 'video', state: 'uploading' }
  `);

  // --- The video is rejected too ---
  await advanceTime(5_000);

  // Nothing will retry the video on its own (the operation waits for the
  // user), so it must show as failed, not as waiting to be uploaded.
  expect(requests).toMatchInlineSnapshot(
    `['upload photo -> rejected', 'upload video -> rejected']`,
  );
  expect(getUploads()).toMatchInlineSnapshot(`
    - id: 'photo'
      lastError: { message: 'photo type not accepted' }
      state: 'failed'
    - id: 'video'
      lastError: { message: 'video type not accepted' }
      state: 'failed'
  `);
});

test('discarding an operation while one of its dependency uploads is still being sent deletes that upload once it finishes', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  network.setOffline();
  const { env, requests, getUploads, queueMutationWithBothFiles } =
    createTwoAttachmentsUploadEnv({
      sessionKey: 'discard-during-upload-session',
      videoOutcome: 'success',
    });
  await flushAllTimers();

  await queueMutationWithBothFiles();

  // --- Setup: the photo is rejected while the video is still being sent ---
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await advanceTime(1_000);

  const [resolution] = env.apiStore.getOfflineResolutions();
  if (!resolution) throw new Error('Expected a resolution');

  // --- Action: the user discards the operation before the video finishes ---
  await resolveWithin(
    env.apiStore.resolveOfflineResolution(resolution.id, 'saveAttachments', {
      action: 'discard',
    }),
  );

  // The photo is deleted right away; the video is kept while it is sent.
  expect(getUploads()).toMatchInlineSnapshot(
    `- { id: 'video', state: 'uploading' }`,
  );

  // --- The video upload finishes ---
  await advanceTime(5_000);

  // The operation that needed the video is gone, so the file is deleted
  // instead of waiting for the one-week retention.
  expect(requests).toMatchInlineSnapshot(
    `['upload photo -> rejected', 'upload video -> server:video']`,
  );
  expect(getUploads()).toMatchInlineSnapshot(`[]`);
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`"empty"`);
});

test('resolveOfflineUpload returns the transport error without touching the session mode and uploads again on the next call', async () => {
  createMockBrowserOpfs();
  const sessionKey = 'upload-online-failure-session';
  const classifyFailure = vi.fn(() => 'network' as const);

  // The file is staged while the browser is offline.
  network.setOffline();

  const { env, requests, unmount, ...actions } = createUploadFailureTestEnv({
    sessionKey,
    storeId: 'upload-online-failure-doc',
    offlineSession: { classifyFailure, network: network.config },
    uploadAttempts: [
      new UploadTransportError('connection', 'Upload failed: Network error'),
    ],
  });
  await flushAllTimers();
  env.clearTimeline();

  await actions.stageUpload();

  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  await advanceTime(0);

  // Back online, the app uploads the staged file itself instead of queueing
  // an operation that depends on it.
  env.addTimelineComments('beforeNextAction', [
    'app calls resolveOfflineUpload while the upload endpoint is unreachable',
  ]);
  const failedResult = await actions.resolveUploadOnline();

  // The caller gets the transport error back and decides what to do with it:
  // the session classifiers are not consulted and the session stays online.
  expect(
    failedResult.ok ? null : failedResult.error.message,
  ).toMatchInlineSnapshot(`"Upload failed: Network error"`);
  expect(classifyFailure).not.toHaveBeenCalled();
  expect(getGlobalOfflineStatusSummary(sessionKey)).toMatchInlineSnapshot(`
    isOfflineMode: '❌'
    network: { active: '❌', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'upload-online-failure-session'
  `);

  // Nothing retries on the app's behalf, so the upload is marked as failed.
  expect(
    actions
      .getUploads()
      .map((upload) => pick(upload, ['id', 'state', 'lastError'])),
  ).toMatchInlineSnapshot(`
    - id: 'asset-1'
      lastError: { message: 'Upload failed: Network error' }
      state: 'failed'
  `);

  // A failed upload is not blocked: resolving it again runs the transport
  // again, and the success clears the stored error.
  env.addTimelineComments('beforeNextAction', [
    'app calls resolveOfflineUpload again',
  ]);
  const retriedResult = await actions.resolveUploadOnline();

  expect(retriedResult.ok ? retriedResult.value : null).toMatchInlineSnapshot(
    `"server:asset-1"`,
  );
  expect(requests).toMatchInlineSnapshot(`
    - 'upload asset-1 -> Upload failed: Network error'
    - 'upload asset-1 -> server:asset-1'
  `);
  expect(
    actions
      .getUploads()
      .map((upload) =>
        pick(upload, ['id', 'state', 'resolvedRef', 'lastError']),
      ),
  ).toMatchInlineSnapshot(
    `- { id: 'asset-1', resolvedRef: 'server:asset-1', state: 'uploaded' }`,
  );
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time    | ui                                                                           |
    12s     | -                                                                            | -- timeline-cleared
    12.009s | "upload:pending | op:none | session:network-offline"                         | ui-changed
    .       | "upload:pending | op:none | session:online"                                  | ui-changed
    12.018s | "upload:pending | op:none | session:online"                                  | -- app calls resolveOfflineUpload while the upload endpoint is unreachable
    .       | "upload:uploading | op:none | session:online"                                | ui-changed
    12.227s | "upload:failed (Upload failed: Network error) | op:none | session:online"    | ui-changed
    13.018s | "upload:failed (Upload failed: Network error) | op:none | session:online"    | -- app calls resolveOfflineUpload again
    .       | "upload:uploading (Upload failed: Network error) | op:none | session:online" | ui-changed
    13.227s | "upload:uploaded | op:none | session:online"                                 | ui-changed
    "
  `);

  unmount();
});

// ---------------------------------------------------------------------------
// Staged uploads follow the queued work that depends on them
// ---------------------------------------------------------------------------
