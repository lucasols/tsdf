const protectedKeysBySession = new Map<string, Set<string>>();

export function setSessionProtectedKeysSnapshot(
  sessionKey: string,
  protectedKeys: Iterable<string>,
): void {
  protectedKeysBySession.set(sessionKey, new Set(protectedKeys));
}

export function getSessionProtectedKeysSnapshot(
  sessionKey: string,
): Set<string> | null {
  return protectedKeysBySession.get(sessionKey) ?? null;
}

export function clearSessionProtectedKeysSnapshot(sessionKey: string): void {
  protectedKeysBySession.delete(sessionKey);
}

export function __resetSessionProtectedKeysSnapshotForTests(): void {
  if (!import.meta.env.TEST) {
    throw new Error(
      '[tsdf] __resetSessionProtectedKeysSnapshotForTests is test-only',
    );
  }

  protectedKeysBySession.clear();
}
