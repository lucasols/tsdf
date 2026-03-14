import { safeJsonParse } from '@ls-stack/utils/safeJson';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { vi } from 'vitest';

function describePersistentStorageKey(key: string): string | null {
  if (key === 'tsdf._m.l' || key === 'tsdf.__lsm__.l') return 'lease';
  if (key === 'tsdf._m.g') return 'global maintenance';

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

  if (key.startsWith('tsdf.')) return 'entry';

  return null;
}

function formatPersistentStorageKey(key: string | null): string {
  if (typeof key !== 'string') return '<non-string>';

  const description = describePersistentStorageKey(key);
  if (description === null) return key;

  return `${key} (${description})`;
}

function formatByteSize(byteSize: number): string {
  return `${(byteSize / 1024).toFixed(2)} kb`;
}

const secondsFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 3,
});

function formatTimeMs(ms: number): string {
  if (ms === 0) return '0';
  if (ms >= 1000) return `${secondsFormatter.format(ms / 1000)}s`;
  return `${ms}ms`;
}

function formatRelativeTime(
  ms: number,
  previousMs: number | undefined,
): string {
  if (previousMs !== undefined && ms === previousMs) return '.';
  return formatTimeMs(ms);
}

export type PersistentStorageOperation =
  | {
      time: number;
      type: 'getItem';
      exists: boolean;
      key: string | null;
      valueByteSize: number | null;
    }
  | {
      time: number;
      type: 'setItem';
      existsBefore: boolean;
      valueChanged: boolean;
      key: string;
      valueByteSizeBefore: number | null;
      valueByteSizeAfter: number;
    }
  | { time: number; type: 'removeItem'; existsBefore: boolean; key: string }
  | { time: number; type: 'key'; index: number; key: string | null }
  | { time: number; type: 'clear' };

function formatPersistentStorageOperation(
  operation: PersistentStorageOperation,
): string {
  switch (operation.type) {
    case 'getItem': {
      const base = `📖 ${operation.exists ? '✅' : '❌'} ${formatPersistentStorageKey(operation.key)}`;
      if (operation.valueByteSize !== null) {
        return `${base} | ${formatByteSize(operation.valueByteSize)}`;
      }
      return base;
    }
    case 'setItem': {
      const unchangedFlag = !operation.valueChanged ? ' ⚠️ UNCHANGED' : '';
      const base = `✍️ ${operation.existsBefore ? '✅' : '❌'}->✅ ${formatPersistentStorageKey(operation.key)}`;
      const before =
        operation.valueByteSizeBefore !== null
          ? formatByteSize(operation.valueByteSizeBefore)
          : '❌';
      return `${base} | ${before} -> ${formatByteSize(operation.valueByteSizeAfter)}${unchangedFlag}`;
    }
    case 'removeItem':
      return `🗑️ ${operation.existsBefore ? '✅' : '❌'}->❌ ${formatPersistentStorageKey(operation.key)}`;
    case 'key':
      return `🔑[${operation.index}] ${operation.key === null ? '❌' : '✅'} ${formatPersistentStorageKey(operation.key)}`;
    case 'clear':
      return '🧹';
  }
}

function formatTableString(rows: Array<{ cols: string[] }>): string {
  if (rows.length === 0) return '';

  const colWidths: number[] = [];
  for (const { cols } of rows) {
    for (const [index, col] of cols.entries()) {
      colWidths[index] = Math.max(colWidths[index] ?? 0, col.length);
    }
  }

  return rows
    .map(({ cols }) =>
      cols
        .map((col, index) => col.padEnd(colWidths[index] ?? 0))
        .join(' | ')
        .trimEnd(),
    )
    .join('\n');
}

export function getPersistentStorageOperationTimelineString(
  operations: readonly PersistentStorageOperation[],
): string {
  if (operations.length === 0) return 'empty';

  const rows: Array<{ cols: string[] }> = [{ cols: ['time', ''] }];
  let previousTime: number | undefined;

  for (const operation of operations) {
    rows.push({
      cols: [
        formatRelativeTime(operation.time, previousTime),
        formatPersistentStorageOperation(operation),
      ],
    });
    previousTime = operation.time;
  }

  return ['\n', formatTableString(rows), '\n'].join('');
}

export type PersistentStorageOperationCapture = {
  finish: () => {
    timelineString: string;
    operations: readonly PersistentStorageOperation[];
  };
};

export function startPersistentStorageOperationCapture(): PersistentStorageOperationCapture {
  const operations: PersistentStorageOperation[] = [];
  const startedAt = Date.now();
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
    operations.push({
      time: Date.now() - startedAt,
      type: 'getItem',
      key,
      exists: value !== null,
      valueByteSize: value !== null ? value.length * 2 : null,
    });
    return value;
  });
  setItemSpy.mockImplementation((key: string, value: string): void => {
    const existingValue = originalGetItem(key);
    operations.push({
      time: Date.now() - startedAt,
      type: 'setItem',
      key,
      existsBefore: existingValue !== null,
      valueChanged: existingValue !== value,
      valueByteSizeBefore:
        existingValue !== null ? existingValue.length * 2 : null,
      valueByteSizeAfter: value.length * 2,
    });
    originalSetItem(key, value);
  });
  removeItemSpy.mockImplementation((key: string): void => {
    operations.push({
      time: Date.now() - startedAt,
      type: 'removeItem',
      key,
      existsBefore: originalGetItem(key) !== null,
    });
    originalRemoveItem(key);
  });
  keySpy.mockImplementation((index: number): string | null => {
    const key = originalKey(index);
    operations.push({ time: Date.now() - startedAt, type: 'key', index, key });
    return key;
  });
  clearSpy.mockImplementation((): void => {
    operations.push({ time: Date.now() - startedAt, type: 'clear' });
    originalClear();
  });

  return {
    finish() {
      const finishedOperations = [...operations];
      getItemSpy.mockRestore();
      setItemSpy.mockRestore();
      removeItemSpy.mockRestore();
      keySpy.mockRestore();
      clearSpy.mockRestore();
      return {
        timelineString:
          getPersistentStorageOperationTimelineString(finishedOperations),
        operations: finishedOperations,
      };
    },
  };
}

export const startPersistentStorageReadCapture =
  startPersistentStorageOperationCapture;

export function getParsedLocalStorageValue<T = unknown>(key: string): T | null {
  const value = localStorage.getItem(key);
  if (value === null) return null;

  return __LEGIT_CAST__<T | null, unknown>(safeJsonParse(value));
}
