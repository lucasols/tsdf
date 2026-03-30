import { asPossiblyUndefined } from '@ls-stack/utils/typingFnUtils';

export function getNavigatorLockManager(): LockManager | null {
  const globalNavigator = asPossiblyUndefined(globalThis.navigator);
  return globalNavigator?.locks ?? null;
}

const warnedLockUnavailable = new Set<string>();

export function warnIfNavigatorLockUnavailable(warning: string): void {
  if (getNavigatorLockManager() !== null) return;

  if (!warnedLockUnavailable.has(warning)) {
    warnedLockUnavailable.add(warning);
    console.warn(warning);
  }
}

export async function runWithNavigatorLock<T>(
  lockName: string,
  unavailableWarning: string,
  callback: () => T | Promise<T>,
): Promise<T> {
  const lockManager = getNavigatorLockManager();

  if (lockManager === null) {
    warnIfNavigatorLockUnavailable(unavailableWarning);
    return await callback();
  }

  return lockManager.request(lockName, callback);
}
