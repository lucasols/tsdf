import type { OfflineUploadAdapter } from './offlineUploadTypes';

const uploadAdaptersBySession = new Map<string, Set<OfflineUploadAdapter>>();

export function registerOfflineUploadAdapterForSession(
  sessionKey: string,
  adapter: OfflineUploadAdapter,
): void {
  const adapters = uploadAdaptersBySession.get(sessionKey) ?? new Set();
  adapters.add(adapter);
  uploadAdaptersBySession.set(sessionKey, adapters);
}

export async function clearRegisteredOfflineUploadStorage(
  sessionKey: string,
): Promise<void> {
  const adapters = uploadAdaptersBySession.get(sessionKey);
  if (!adapters || adapters.size === 0) return;

  uploadAdaptersBySession.delete(sessionKey);
  const results = await Promise.allSettled(
    [...adapters].map((adapter) => adapter.clearSession(sessionKey)),
  );
  const firstFailure = results.find((result) => result.status === 'rejected');

  if (firstFailure?.status === 'rejected') {
    throw firstFailure.reason;
  }
}

/**
 * Test-only primitive for resetting the session-to-upload-adapter registry.
 *
 * Prefer calling `resetSessionForTests()` from
 * `tests/utils/resetSessionForTests.ts` so restart-style tests reset the full
 * session/runtime boundary instead of invoking this low-level reset directly.
 */
export function __resetOfflineUploadRegistryForTests(): void {
  if (!import.meta.env.TEST) {
    throw new Error('[tsdf] __resetOfflineUploadRegistryForTests is test-only');
  }

  uploadAdaptersBySession.clear();
}
