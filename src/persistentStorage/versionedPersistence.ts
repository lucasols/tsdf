import type { PersistentStorageMigration } from './types';
import { doesStorageEntryVersionMatch } from './persistentStorageManager';

export type ResolvedVersionedPersistedData<TPersisted> = {
  persisted: TPersisted;
  wasMigrated: boolean;
};

export function resolveVersionedPersistedData<TPersisted>(args: {
  persistedData: unknown;
  fromVersion: number | undefined;
  targetVersion: number | undefined;
  migrate: PersistentStorageMigration | undefined;
  parseCurrentPersistedData: (value: unknown) => TPersisted | null;
}): ResolvedVersionedPersistedData<TPersisted> | null {
  if (doesStorageEntryVersionMatch(args.fromVersion, args.targetVersion)) {
    const persisted = args.parseCurrentPersistedData(args.persistedData);
    if (persisted === null) return null;

    return { persisted, wasMigrated: false };
  }

  if (args.targetVersion === undefined || args.migrate === undefined) {
    return null;
  }

  let migratedPersistedData: unknown;
  try {
    migratedPersistedData = args.migrate({
      persistedData: args.persistedData,
      fromVersion: args.fromVersion,
      toVersion: args.targetVersion,
    });
  } catch {
    return null;
  }

  if (migratedPersistedData === null) return null;

  const persisted = args.parseCurrentPersistedData(migratedPersistedData);
  if (persisted === null) return null;

  return { persisted, wasMigrated: true };
}
