import { vi } from 'vitest';

function describePersistentStorageKey(key: string): string | null {
  if (key === 'tsdf._m.l' || key === 'tsdf.__lsm__.l') return 'lease';
  if (key === 'tsdf._m.c' || key === 'tsdf.__lsm__.c') return 'catalog';

  for (const prefix of ['tsdf._m.r.', 'tsdf.__lsm__.r.']) {
    if (!key.startsWith(prefix)) continue;

    const identity = key.slice(prefix.length);
    if (identity.endsWith('.m') || identity.endsWith('.manifest')) {
      if (identity.startsWith('s:') || identity.startsWith('single:')) {
        return 'root, single, manifest';
      }

      if (identity.startsWith('n:') || identity.startsWith('namespace:')) {
        return 'root, namespace, manifest';
      }

      return 'root, manifest';
    }

    if (identity.includes('.manifest.')) {
      const [rootIdentity, shardIndex] = identity.split('.manifest.');
      const rootType =
        rootIdentity?.startsWith('s:') || rootIdentity?.startsWith('single:')
          ? 'single'
          : rootIdentity?.startsWith('n:') ||
              rootIdentity?.startsWith('namespace:')
            ? 'namespace'
            : 'root';
      return `root, ${rootType}, manifest shard ${shardIndex ?? '?'}`;
    }

    if (identity.startsWith('s:') || identity.startsWith('single:')) {
      return 'root, single';
    }

    if (identity.startsWith('n:') || identity.startsWith('namespace:')) {
      return 'root, namespace';
    }

    return 'root';
  }

  if (key.startsWith('tsdf.')) return 'payload';

  return null;
}

function formatPersistentStorageKey(key: string | null): string {
  if (typeof key !== 'string') return '<non-string>';

  const description = describePersistentStorageKey(key);
  if (description === null) return key;

  return `${key} (${description})`;
}

type PersistentStorageOperation =
  | { type: 'getItem'; exists: boolean; key: string | null }
  | { type: 'setItem'; existsBefore: boolean; key: string }
  | { type: 'removeItem'; existsBefore: boolean; key: string }
  | { type: 'key'; index: number; key: string | null }
  | { type: 'clear' };

function formatPersistentStorageOperation(
  operation: PersistentStorageOperation,
): string {
  switch (operation.type) {
    case 'getItem':
      return `GET ${operation.exists ? '✅' : '❌'} ${formatPersistentStorageKey(operation.key)}`;
    case 'setItem':
      return `SET ${operation.existsBefore ? '✅' : '❌'}->✅ ${formatPersistentStorageKey(operation.key)}`;
    case 'removeItem':
      return `REMOVE ${operation.existsBefore ? '✅' : '❌'}->❌ ${formatPersistentStorageKey(operation.key)}`;
    case 'key':
      return `KEY[${operation.index}] ${operation.key === null ? '❌' : '✅'} ${formatPersistentStorageKey(operation.key)}`;
    case 'clear':
      return 'CLEAR';
  }
}

function getPersistentStorageOperationLog(
  operations: PersistentStorageOperation[],
): string[] {
  return operations.map(formatPersistentStorageOperation);
}

export type PersistentStorageOperationCapture = { finish: () => string[] };

export function startPersistentStorageOperationCapture(): PersistentStorageOperationCapture {
  const operations: PersistentStorageOperation[] = [];
  const originalGetItem = localStorage.getItem.bind(localStorage);
  const originalSetItem = localStorage.setItem.bind(localStorage);
  const originalRemoveItem = localStorage.removeItem.bind(localStorage);
  const originalKey = localStorage.key.bind(localStorage);
  const originalClear = localStorage.clear.bind(localStorage);
  const getItemSpy = vi.spyOn(localStorage, 'getItem');
  const setItemSpy = vi.spyOn(localStorage, 'setItem');
  const removeItemSpy = vi.spyOn(localStorage, 'removeItem');
  const keySpy = vi.spyOn(localStorage, 'key');
  const clearSpy = vi.spyOn(localStorage, 'clear');
  getItemSpy.mockClear();
  setItemSpy.mockClear();
  removeItemSpy.mockClear();
  keySpy.mockClear();
  clearSpy.mockClear();
  getItemSpy.mockImplementation((key: string): string | null => {
    const value = originalGetItem(key);
    operations.push({ type: 'getItem', key, exists: value !== null });
    return value;
  });
  setItemSpy.mockImplementation((key: string, value: string): void => {
    operations.push({
      type: 'setItem',
      key,
      existsBefore: originalGetItem(key) !== null,
    });
    originalSetItem(key, value);
  });
  removeItemSpy.mockImplementation((key: string): void => {
    operations.push({
      type: 'removeItem',
      key,
      existsBefore: originalGetItem(key) !== null,
    });
    originalRemoveItem(key);
  });
  keySpy.mockImplementation((index: number): string | null => {
    const key = originalKey(index);
    operations.push({ type: 'key', index, key });
    return key;
  });
  clearSpy.mockImplementation((): void => {
    operations.push({ type: 'clear' });
    originalClear();
  });

  return {
    finish() {
      const operationLog = getPersistentStorageOperationLog(operations);
      getItemSpy.mockRestore();
      setItemSpy.mockRestore();
      removeItemSpy.mockRestore();
      keySpy.mockRestore();
      clearSpy.mockRestore();
      return operationLog;
    },
  };
}

export const startPersistentStorageReadCapture =
  startPersistentStorageOperationCapture;
