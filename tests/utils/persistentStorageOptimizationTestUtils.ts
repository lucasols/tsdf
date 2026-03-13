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

type PersistentStorageReadCall = { exists: boolean; key: string | null };

function formatReadKey(call: PersistentStorageReadCall): string {
  if (typeof call.key !== 'string') {
    return `${call.exists ? '✅' : '❌'} <non-string>`;
  }

  const description = describePersistentStorageKey(call.key);
  if (description === null) return `${call.exists ? '✅' : '❌'} ${call.key}`;

  return `${call.exists ? '✅' : '❌'} ${call.key} (${description})`;
}

export type PersistentStorageReadBreakdown = {
  metadataKeys: string[];
  payloadKeys: string[];
  otherKeys: string[];
};

function getPersistentStorageReadBreakdown(
  calls: PersistentStorageReadCall[],
): PersistentStorageReadBreakdown {
  const breakdown: PersistentStorageReadBreakdown = {
    metadataKeys: [],
    payloadKeys: [],
    otherKeys: [],
  };

  for (const call of calls) {
    if (typeof call.key !== 'string') continue;

    if (
      call.key.startsWith('tsdf._m.') ||
      call.key.startsWith('tsdf.__lsm__.')
    ) {
      breakdown.metadataKeys.push(formatReadKey(call));
      continue;
    }

    if (call.key.startsWith('tsdf.')) {
      breakdown.payloadKeys.push(formatReadKey(call));
      continue;
    }

    breakdown.otherKeys.push(formatReadKey(call));
  }

  return breakdown;
}

export type PersistentStorageReadCapture = {
  finish: () => PersistentStorageReadBreakdown;
};

export function startPersistentStorageReadCapture(): PersistentStorageReadCapture {
  const calls: PersistentStorageReadCall[] = [];
  const originalGetItem = localStorage.getItem.bind(localStorage);
  const getItemSpy = vi.spyOn(localStorage, 'getItem');
  getItemSpy.mockClear();
  getItemSpy.mockImplementation((key: string): string | null => {
    const value = originalGetItem(key);
    calls.push({ key, exists: value !== null });
    return value;
  });

  return {
    finish() {
      const readBreakdown = getPersistentStorageReadBreakdown(calls);
      getItemSpy.mockRestore();
      return readBreakdown;
    },
  };
}
