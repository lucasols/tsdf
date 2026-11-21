import { afterEach, beforeEach, vi } from 'vitest';
import type { DocumentOfflineOperationDefinition } from '../../src/main';
import { encodePathSegment } from '../../src/persistentStorage/opfsFileNaming';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { resetSessionForTests } from '../utils/resetSessionForTests';

/**
 * Network mock of the current test, recreated before each test by
 * `setupOfflineUploadTests`.
 */
export let network = createOfflineNetworkMock();

/**
 * Registers the fake timers, network mock and storage reset shared by the
 * offline upload test files.
 */
export function setupOfflineUploadTests(): void {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_INITIAL_TIME);
    network = createOfflineNetworkMock();
    network.install();
    resetSessionForTests({ clearStorage: true });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    resetSessionForTests({ clearStorage: true });
  });
}

export function getOfflineUploadOpfsPath(
  sessionKey: string,
  uploadId: string,
  fileName: 'binary.blob' | 'metadata.json',
): string {
  return `tsdf-uploads/${encodePathSegment(sessionKey)}/${encodePathSegment(uploadId)}/${fileName}`;
}

/**
 * Settles `promise` while advancing the fake clock by a bounded amount.
 *
 * `flushAllTimers` / `resolveAfterAllTimers` also run the one-week upload
 * retention timer once the session is online, and that timer deletes
 * unreferenced uploads on its own. These tests must prove the upload is
 * removed by the queue change itself, so they never jump that far.
 */
export async function resolveWithin<T>(
  promise: Promise<T> | T,
  ms = 100,
): Promise<T> {
  const [result] = await Promise.all([promise, advanceTime(ms)]);
  return result;
}

export type DirectUploadUpdateOperations = {
  updateValue: DocumentOfflineOperationDefinition<
    { value: number },
    { input: { value: number } }
  >;
};

export type UploadDependencyOperations = {
  updateWithAttachment: DocumentOfflineOperationDefinition<
    { value: number },
    { input: { attachmentId: string; value: number } }
  >;
};
