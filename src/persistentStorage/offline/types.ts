import type { __LEGIT_ANY__ } from '@ls-stack/utils/saferTyping';
import {
  rc_array,
  rc_boolean,
  rc_discriminated_union,
  rc_literals,
  rc_number,
  rc_object,
  rc_parse,
  rc_string,
  rc_unknown,
} from 'runcheck';

import type { ValidPayload, ValidStoreState } from '../../utils/storeShared';
import type { PersistentStorageSchema } from '../types';

/** Store kinds supported by offline replay and sync state tracking. */
export type OfflineStoreType = 'document' | 'collection' | 'listQuery';
/** Phase where a failure occurred during offline-enabled operation flow. */
export type OfflineFailurePhase = 'fetch' | 'mutation' | 'sync';
/** High-level classification used by outage detection. */
export type OfflineFailureClassification = 'outage' | 'network' | 'ignore';
/** Kinds of entities participating in offline conflict/sync tracking. */
export type OfflineEntityKind = 'document' | 'item' | 'query';

/** Runtime schema for validating serialized offline item entity references. */
export const offlineItemEntityRefSchema = rc_object({
  entityKey: rc_string,
  entityKind: rc_literals('item'),
});

const offlineResolutionEntityRefSchema = rc_object({
  entityKey: rc_string,
  entityKind: rc_literals('document', 'item', 'query'),
});

const offlineResolutionBaseFields = {
  id: rc_string,
  entryId: rc_string,
  sessionKey: rc_string,
  storeName: rc_string,
  storeType: rc_string,
  operation: rc_string,
  input: rc_unknown,
  enqueuedAt: rc_number,
  entityRefs: rc_array(offlineResolutionEntityRefSchema),
  createdAt: rc_number,
  updatedAt: rc_number,
};

/** Runtime schema for validating persisted offline resolution records on hydration. */
export const offlineResolutionRecordSchema = rc_discriminated_union('kind', {
  conflict: {
    ...offlineResolutionBaseFields,
    kind: rc_literals('conflict'),
    conflict: rc_unknown,
  },
  'retry-exhausted': {
    ...offlineResolutionBaseFields,
    kind: rc_literals('retry-exhausted'),
    lastReplayError: rc_object({ message: rc_string }),
  },
});

/** Error shape emitted when runtime is operating in offline mode. */
export type OfflineConnectivityError = {
  /** Numeric error code used by offline failure handlers. */
  code: 0;
  /** Stable machine-readable offline error identifier. */
  id: 'offline';
  /** Default offline error message. */
  message: 'Offline';
};

/** Connectivity cause currently governing offline mutation queueing. */
export type OfflineMutationQueueingCause = 'network' | 'outage';

/** Root policy value for whether offline-enabled mutations may queue. */
export type OfflineMutationQueueingPolicy = 'allow' | 'disallow';

/** Root mutation queueing policy shared by all configured offline operations. */
export type OfflineMutationQueueingConfig = {
  /**
   * Controls whether offline-enabled mutations may queue while network mode is
   * active, including browser-detected offline and classified network failures.
   * @default 'allow'
   */
  network?: OfflineMutationQueueingPolicy;
  /**
   * Controls whether offline-enabled mutations may queue while outage mode is
   * active.
   * @default 'allow'
   */
  outage?: OfflineMutationQueueingPolicy;
};

/**
 * Effective runtime offline controls exposed through an offline session.
 *
 * All fields are session-scoped and affect every store attached to the same
 * offline session.
 */
export type OfflineRuntimeConfig = {
  /** Effective network mode enablement for the current session. */
  network: { enabled: boolean };
  /** Effective outage mode enablement for the current session. */
  outage: { enabled: boolean };
  /** Effective queue admission policy for offline-enabled mutations. */
  mutationQueueing: {
    network: OfflineMutationQueueingPolicy;
    outage: OfflineMutationQueueingPolicy;
  };
};

/** Default runtime config when offline is not configured or no session exists. */
export const defaultOfflineRuntimeConfig: OfflineRuntimeConfig = {
  network: { enabled: false },
  outage: { enabled: false },
  mutationQueueing: { network: 'allow', outage: 'allow' },
};

/**
 * Partial runtime offline control update accepted by an offline session.
 *
 * Provided fields shallow-merge into the current runtime config.
 */
export type OfflineRuntimeConfigUpdate = {
  /** Optional session-scoped update for network mode enablement. */
  network?: { enabled?: boolean };
  /** Optional session-scoped update for outage mode enablement. */
  outage?: { enabled?: boolean };
  /** Optional session-scoped update for offline mutation queue admission policy. */
  mutationQueueing?: {
    network?: OfflineMutationQueueingPolicy;
    outage?: OfflineMutationQueueingPolicy;
  };
};

/** Context passed into offline failure classification hooks. */
export type OfflineFailureContext = {
  /** Phase in which the failure was detected. */
  phase: OfflineFailurePhase;
  /** Store type affected by the failure. */
  storeType: OfflineStoreType;
  /** Optional operation name associated with the failure. */
  operationName?: string;
  /** Session key used by browser tab and persistence scoping. */
  sessionKey: string;
};

/** Re-check strategy for recovery probing. Omitted fields use built-in defaults (which differ between network and outage modes). */
export type OfflineRecoveryProbeConfig = {
  /**
   * Initial recovery check delay, in milliseconds.
   * @default 5_000 (network) / 30_000 (outage)
   */
  initialIntervalMs?: number;
  /**
   * Maximum recovery check delay, in milliseconds.
   * @default 60_000 (network) / 300_000 (outage)
   */
  maxIntervalMs?: number;
  /**
   * Multiplicative backoff between recovery probes.
   * @default 2
   */
  backoffMultiplier?: number;
  /**
   * Jitter ratio (0-1) applied to the recovery probe delay.
   * @default 0.2
   */
  jitterRatio?: number;
};

/** Network availability mode configuration for offline controls. */
export type OfflineNetworkModeConfig = {
  /** Enable network connectivity detection and tracking. */
  enabled: boolean;
  /**
   * If true, subscribe to browser `online` / `offline` events.
   * @default true
   */
  listenToBrowserEvents?: boolean;
  /**
   * Optional override for network connectivity checks.
   * Return `true` when network should be considered offline.
   */
  getIsOffline?: () => boolean | Promise<boolean>;
  /**
   * Probe whether classified network recovery has completed.
   * Return `true` when the session should leave network offline mode.
   */
  recoveryCheck?: (ctx: { sessionKey: string }) => Promise<boolean> | boolean;
  /** Optional probe config to tune classified network recovery behavior. */
  recoveryProbe?: OfflineRecoveryProbeConfig;
};

/** Server outage detection and recovery configuration. */
export type OfflineOutageModeConfig = {
  /** Enable outage mode logic and confirmation retry flow. */
  enabled: boolean;
  /** Probe the remote service to confirm outage recovery. */
  recoveryCheck: (ctx: { sessionKey: string }) => Promise<boolean> | boolean;
  /** Optional probe config to tune recovery behavior. */
  recoveryProbe?: OfflineRecoveryProbeConfig;
};

/** Fixed replay retry policy for healthy online replay failures. Omitted fields use built-in defaults. */
export type OfflineReplayRetryConfig = {
  /**
   * Max counted failures before manual resolution is required.
   * @default 5
   */
  maxFailures?: number;
  /**
   * Fixed delay between replay retries, in milliseconds.
   * @default 5000
   */
  intervalMs?: number;
};

/** Shared offline/session policy reused by every store in the same session. */
export type OfflineSessionConfig = {
  /**
   * Classify a remote failure as `outage`, `network`, or `ignore`.
   * `outage` activates outage recovery behavior.
   * `network` activates network offline handling only when `network.enabled` is true.
   */
  classifyFailure?: (
    error: unknown,
    ctx: OfflineFailureContext,
  ) => Promise<OfflineFailureClassification> | OfflineFailureClassification;
  /** Network detection strategy and browser integration. */
  network?: OfflineNetworkModeConfig;
  /** Outage detection and recovery strategy for remote failures. */
  outage?: OfflineOutageModeConfig;
  /** Fixed retry policy for healthy online replay failures. */
  replayRetry?: OfflineReplayRetryConfig;
  /**
   * Root policy controlling whether offline-enabled mutations may enter the
   * durable offline queue for each active offline cause.
   * @default undefined
   */
  mutationQueueing?: OfflineMutationQueueingConfig;
};

/** Effective network/offline state computed by offline coordination. */
export type OfflineConnectivityState = 'online' | 'offline';

/** Per-session offline status snapshot shared across tabs. */
export type GlobalOfflineStatus = {
  /** Session key for this status bucket. */
  sessionKey: string;
  /**
   * Network mode runtime enablement plus the last observed network-offline
   * state for this session. `active` is preserved even while runtime support is
   * disabled so it can resume correctly when re-enabled.
   */
  network: { enabled: boolean; active: boolean };
  /**
   * Outage mode runtime enablement plus the last observed outage-active state
   * for this session. `active` is preserved even while runtime support is
   * disabled so it can resume correctly when re-enabled.
   */
  outage: { enabled: boolean; active: boolean };
  /** Effective mode after combining only enabled active modes. */
  effectiveMode: OfflineConnectivityState;
  /** Whether any enabled offline mode is currently active. */
  effectiveOffline: boolean;
  /** Whether this tab currently acts as leader for this session. */
  isLeader: boolean;
  /** Timestamp when this status entry was last updated. */
  updatedAt: number;
  /** Timestamp of the last failure, if any. */
  lastFailureAt: number | null;
  /** Timestamp of last recovery probe execution, if any. */
  lastRecoveryCheckAt: number | null;
};

/** Queue state of an offline mutation entry. */
export type OfflineSyncState = 'pending' | 'syncing' | 'needs-confirmation';

/** Aggregated offline status for a tracked document/item/query entity. */
export type GlobalOfflineEntity = {
  /** Internal entity identifier tracked by offline machinery. */
  id: string;
  /** Session key for this offline entity. */
  sessionKey: string;
  /** Store name where the entity is defined. */
  storeName: string;
  /** Store type this entity belongs to. */
  storeType: OfflineStoreType;
  /** Entity key used for deduping and conflict scoping. */
  entityKey: string;
  /** Entity kind used in queue partitioning. */
  entityKind: OfflineEntityKind;
  /** Number of pending mutations waiting for sync. */
  pendingMutations: number;
  /** Current sync state for the entity. */
  syncState: OfflineSyncState | 'resolution-required';
  /** Whether the entity currently requires manual resolution. */
  requiresResolution: boolean;
  /** Resolution ids currently blocking this entity from being resolved/applied. */
  blockedByResolutionIds: string[];
  /** Child resolution ids currently derived from this entity's temp-create chain. */
  childResolutionIds: string[];
  /** Number of blocking parent resolutions currently affecting this entity. */
  blockedResolutionCount: number;
  /** Number of child resolutions currently derived from this entity's temp-create chain. */
  childResolutionCount: number;
  /** Creation timestamp for lifecycle bookkeeping. */
  createdAt: number;
  /** Last mutation/update timestamp. */
  updatedAt: number;
  /** Optional temporary ID for optimistic create flows. */
  tempId?: ValidPayload;
};

/** Session-scoped offline controller shared across stores in the same session. */
export type OfflineSession = {
  /** Returns the active session key used to scope shared offline state. */
  getSessionKey: () => string | false;
  /** Shared static session configuration used by attached stores. */
  getConfig: () => OfflineSessionConfig;
  /** Latest effective runtime config for this session. */
  getOfflineRuntimeConfig: () => OfflineRuntimeConfig;
  /** Updates runtime controls for this session. */
  setOfflineRuntimeConfig: (update: OfflineRuntimeConfigUpdate) => void;
  /** Resets runtime controls back to the static session config. */
  resetOfflineRuntimeConfig: () => void;
  /** Returns the latest global offline status for the session. */
  getOfflineStatus: () => GlobalOfflineStatus;
  /** Returns the latest aggregated offline entities for the session. */
  getOfflineEntities: () => readonly GlobalOfflineEntity[];
  /** React hook subscribing to the session's global offline status. */
  useOfflineStatus: () => GlobalOfflineStatus;
  /** React hook subscribing to the session's aggregated offline entities. */
  useOfflineEntities: () => readonly GlobalOfflineEntity[];
};

const offlineStatusModeStateSchema = rc_object({
  enabled: rc_boolean,
  active: rc_boolean,
});

/** Runtime schema for persisted global offline status records. */
export const globalOfflineStatusSchema = rc_object({
  sessionKey: rc_string,
  network: offlineStatusModeStateSchema,
  outage: offlineStatusModeStateSchema,
  effectiveMode: rc_literals('online', 'offline'),
  effectiveOffline: rc_boolean,
  isLeader: rc_boolean,
  updatedAt: rc_number,
  lastFailureAt: rc_number.orNull(),
  lastRecoveryCheckAt: rc_number.orNull(),
});

export function isModeEffectivelyActive(mode: {
  enabled: boolean;
  active: boolean;
}) {
  return mode.enabled && mode.active;
}

export function getEffectiveOfflineFromModes(status: {
  network: { enabled: boolean; active: boolean };
  outage: { enabled: boolean; active: boolean };
}) {
  return (
    isModeEffectivelyActive(status.network) ||
    isModeEffectivelyActive(status.outage)
  );
}

export function isEffectiveOfflineStatusValue(value: unknown): boolean {
  const status = rc_parse(value, globalOfflineStatusSchema).unwrapOrNull();
  if (status === null) return false;

  return getEffectiveOfflineFromModes(status);
}

/**
 * Persisted offline conflict payload.
 *
 * @typeParam TConflict - Conflict payload stored for later resolution.
 * @typeParam TInput - Original mutation input associated with the conflict.
 */
type OfflineConflictResolutionRecordBase<
  TConflict = unknown,
  TInput = unknown,
> = {
  /** Resolution record identifier. */
  id: string;
  /** Resolution kind. */
  kind: 'conflict';
  /** Queue entry identifier that produced this conflict. */
  entryId: string;
  /** Session key that owns this conflict record. */
  sessionKey: string;
  /** Store name associated with the conflict. */
  storeName: string;
  /** Store type associated with the conflict. */
  storeType: OfflineStoreType;
  /** Operation name linked to the conflict. */
  operation: string;
  /** Input value that triggered the conflict. */
  input: TInput;
  /** Conflict payload returned by the resolver. */
  conflict: TConflict;
  /** Timestamp when the original queued mutation was enqueued. */
  enqueuedAt: number;
  /** Entity references involved in the conflict, each shaped as `{ entityKey, entityKind }`. */
  entityRefs: {
    entityKey: string;
    entityKind: 'document' | 'item' | 'query';
  }[];
  /** Conflict creation timestamp. */
  createdAt: number;
  /** Conflict update timestamp. */
  updatedAt: number;
  /** Optional temporary IDs associated with optimistic entity flow. */
  tempIds?: ValidPayload[];
};

/** Derived dependency metadata exposed for offline manual resolutions. */
export type OfflineResolutionDependencyMetadata = {
  /** Parent resolution ids that must be cleared before this resolution can be retried or discarded. */
  blockedByResolutionIds: string[];
  /** Child manual resolutions currently derived from this resolution's temp-create dependency chain. */
  childResolutionIds: string[];
  /** Number of blocking parent resolutions affecting this resolution. */
  blockedResolutionCount: number;
  /** Number of child manual resolutions currently derived from this resolution. */
  childResolutionCount: number;
};

/**
 * Persisted offline conflict payload with derived dependency metadata.
 *
 * @typeParam TConflict - Conflict payload stored for later resolution.
 * @typeParam TInput - Original mutation input associated with the conflict.
 */
export type OfflineConflictResolutionRecord<
  TConflict = unknown,
  TInput = unknown,
> = OfflineConflictResolutionRecordBase<TConflict, TInput> &
  OfflineResolutionDependencyMetadata;

/**
 * Persisted resolution record created when replay retries are exhausted.
 *
 * @typeParam TInput - Original mutation input associated with the replay failure.
 */
type OfflineRetryExhaustedResolutionRecordBase<TInput = unknown> = {
  /** Resolution record identifier. */
  id: string;
  /** Resolution kind. */
  kind: 'retry-exhausted';
  /** Queue entry identifier that exhausted replay retries. */
  entryId: string;
  /** Session key that owns this resolution record. */
  sessionKey: string;
  /** Store name associated with the resolution. */
  storeName: string;
  /** Store type associated with the resolution. */
  storeType: OfflineStoreType;
  /** Operation name linked to the replay failure. */
  operation: string;
  /** Input value that exhausted replay retries. */
  input: TInput;
  /** Timestamp when the original queued mutation was enqueued. */
  enqueuedAt: number;
  /** Entity references involved in the resolution, each shaped as `{ entityKey, entityKind }`. */
  entityRefs: {
    entityKey: string;
    entityKind: 'document' | 'item' | 'query';
  }[];
  /** Last replay error snapshot captured before exhaustion. */
  lastReplayError: { message: string };
  /** Resolution creation timestamp. */
  createdAt: number;
  /** Resolution update timestamp. */
  updatedAt: number;
  /** Optional temporary IDs associated with optimistic entity flow. */
  tempIds?: ValidPayload[];
};

/**
 * Persisted resolution record created when replay retries are exhausted, plus
 * derived dependency metadata.
 *
 * @typeParam TInput - Original mutation input associated with the replay failure.
 */
export type OfflineRetryExhaustedResolutionRecord<TInput = unknown> =
  OfflineRetryExhaustedResolutionRecordBase<TInput> &
    OfflineResolutionDependencyMetadata;

/**
 * Persisted offline resolution payload without any derived dependency metadata.
 *
 * This shape is what gets serialized to storage and hydrated back into memory.
 *
 * @typeParam TConflict - Conflict payload stored for later resolution.
 * @typeParam TInput - Original mutation input associated with the resolution.
 */
export type PersistedOfflineResolutionRecord<
  TConflict = unknown,
  TInput = unknown,
> =
  | OfflineConflictResolutionRecordBase<TConflict, TInput>
  | OfflineRetryExhaustedResolutionRecordBase<TInput>;

/**
 * Persisted offline resolution payload.
 *
 * @typeParam TConflict - Conflict payload stored for later resolution.
 * @typeParam TInput - Original mutation input associated with the resolution.
 */
export type OfflineResolutionRecord<TConflict = unknown, TInput = unknown> =
  | OfflineConflictResolutionRecord<TConflict, TInput>
  | OfflineRetryExhaustedResolutionRecord<TInput>;

/**
 * Persisted offline mutation queue entry.
 *
 * @typeParam TInput - Serialized input payload for the queued mutation.
 * @typeParam TConflict - Conflict payload that may be attached while waiting for confirmation or resolution.
 */
export type OfflineQueueEntry<TInput = unknown, TConflict = unknown> = {
  /** Queue entry identifier. */
  id: string;
  /** Session key for queue scoping. */
  sessionKey: string;
  /** Store name where operation is defined. */
  storeName: string;
  /** Store type for this queued operation. */
  storeType: OfflineStoreType;
  /** Operation name registered in offline configuration. */
  operation: string;
  /** Operation input payload persisted with the entry. */
  input: TInput;
  /** Stable ordering key used to replay queued operations deterministically. */
  queueOrder: number;
  /** Entity references tied to this mutation, each shaped as `{ entityKey, entityKind }`. */
  entityRefs: {
    entityKey: string;
    entityKind: 'document' | 'item' | 'query';
  }[];
  /** Number of execution attempts so far. */
  attempts: number;
  /** Queue entry creation timestamp. */
  createdAt: number;
  /** Last entry update timestamp. */
  updatedAt: number;
  /** Timestamp of last execution attempt, if any. */
  lastAttemptAt: number | null;
  /** Synchronization state for this entry. */
  syncState: OfflineSyncState;
  /** Optional temporary IDs for optimistic create operations. */
  tempIds?: ValidPayload[];
  /** Last recorded sync error if replay failed. */
  lastError?: { message: string };
  /** Pending conflict payload when confirmation or resolution is required. */
  pendingConflict?: TConflict;
};

/** Built-in resolution actions for retry exhaustion records. */
export type OfflineRetryExhaustedResolutionAction =
  | { action: 'retry' }
  | { action: 'discard' };

/**
 * Extracts operation input type from a schema map.
 *
 * @typeParam TOperations - Operation registry to inspect.
 * @typeParam TName - Operation name whose input type should be extracted.
 */
export type OperationInput<
  TOperations,
  TName extends keyof TOperations,
> = TOperations[TName] extends {
  inputSchema: PersistentStorageSchema<infer TInput>;
}
  ? TInput
  : never;

/**
 * A typed operation descriptor for an offline mutation queue entry.
 *
 * @typeParam TOperations - Operation registry that defines valid operation names and input schemas.
 * @typeParam TName - Operation name to describe. Defaults to all operation names in the registry.
 */
export type OfflineMutationDescriptor<
  TOperations extends Record<
    string,
    { inputSchema: PersistentStorageSchema<__LEGIT_ANY__> }
  >,
  TName extends keyof TOperations & string = keyof TOperations & string,
> = {
  [K in TName]: {
    /** Operation key from the offline operations registry. */
    operation: K;
    /** Input resolved from the registered operation schema. */
    input: OperationInput<TOperations, K>;
  };
}[TName];

/**
 * Public offline mutation input accepted by store mutation APIs.
 *
 * Callers queue exactly one descriptor per mutation fallback.
 */
export type OfflineMutationInput<
  TOperations extends Record<
    string,
    { inputSchema: PersistentStorageSchema<__LEGIT_ANY__> }
  >,
  TName extends keyof TOperations & string = keyof TOperations & string,
> = OfflineMutationDescriptor<TOperations, TName>;

/**
 * Result returned from conflict handlers to requeue a replacement operation input.
 *
 * @typeParam TInput - Input type expected by the operation when requeued.
 */
export type OfflineResolveConflictResult<TInput> =
  | undefined
  | null
  | false
  | { requeue?: { input: TInput } };

/**
 * Context passed into offline mutation accumulation hooks.
 *
 * @typeParam TInput - Input type shared by the existing and incoming queued mutations.
 */
export type OfflineAccumulationMergeContext<TInput> = {
  /** Session key used to isolate queued mutations. */
  sessionKey: string;
  /** Existing input already present in queue. */
  existingInput: TInput;
  /** Incoming input for merge attempt. */
  incomingInput: TInput;
};

/**
 * Optional in-memory accumulation strategy for queued offline mutations.
 *
 * @typeParam TInput - Input type that will be merged and revalidated before persisting.
 */
export type OfflineAccumulationConfig<TInput> = {
  /** Merge function for combining existing and incoming mutation inputs. */
  mergeInput: (
    ctx: OfflineAccumulationMergeContext<TInput>,
  ) => Promise<TInput> | TInput;
};

/**
 * Optional queue-pruning strategy for queued offline mutations.
 *
 * `same-entity` only applies to operations that resolve exactly one entity ref.
 * When enabled, the new operation may remove earlier unattempted pending entries
 * targeting that same single entity before the new entry is persisted.
 */
export type OfflineSupersedeConfig = {
  /** Drop earlier unattempted pending entries for the same single entity. */
  scope: 'same-entity';
  /**
   * Limits which earlier operations may be pruned for that entity.
   *
   * Omit this to prune every earlier pending operation for the entity,
   * use `'self'` to prune only earlier entries of the current operation,
   * or provide explicit operation names to target a specific related set.
   */
  operations?: 'self' | readonly string[];
  /**
   * When the pruned entries include a temp-entity lifecycle, drop the current
   * operation itself instead of persisting a replacement entry.
   */
  dropSelfIfTempLifecycleCancelled?: boolean;
};

/** Shared context passed to offline replay lifecycle hooks. */
type OperationBaseContext<TInput> = {
  /** Input payload for the queued mutation currently being processed. */
  input: TInput;
  /** Timestamp when the operation was originally enqueued. */
  enqueuedAt: number;
  /** Timestamp when the queued entry or conflict record was last updated. */
  updatedAt: number;
};

type IsUnknown<T> = unknown extends T
  ? [keyof T] extends [never]
    ? true
    : false
  : false;

/** Context passed to replay checks that may use a fresh server snapshot. */
type OperationReplayCheckContext<TInput, TServerSnapshot> =
  OperationBaseContext<TInput> & {
    /**
     * Optional snapshot fetched immediately before `shouldSkipSync` and
     * `detectConflict`.
     */
    serverSnapshot: IsUnknown<TServerSnapshot> extends true
      ? undefined
      : TServerSnapshot;
  };

/**
 * Conflict hook configuration for a queued offline operation.
 *
 * @typeParam TInput - Input type of the queued operation being checked and potentially requeued.
 * @typeParam TConflict - Conflict payload produced by detection and consumed during resolution.
 */
export type OfflineConflictHandlingConfig<
  TInput,
  TConflict,
  TServerSnapshot = unknown,
> = {
  /** Optional schema to validate and sanitize stored conflict payloads. */
  schema?: PersistentStorageSchema<TConflict>;
  /**
   * Inspect remote state before replaying the mutation and return conflict payload
   * when the queued mutation can no longer be applied safely.
   */
  detectConflict: (
    ctx: OperationReplayCheckContext<TInput, TServerSnapshot>,
  ) => Promise<TConflict | false | null> | TConflict | false | null;
  /**
   * Resolve persisted conflict data and optionally requeue an adjusted operation.
   */
  resolveConflict: (
    ctx: OperationBaseContext<TInput> & {
      conflict: TConflict;
      resolution: unknown;
    },
  ) =>
    | Promise<OfflineResolveConflictResult<TInput>>
    | OfflineResolveConflictResult<TInput>;
};

type ConflictHandlingField<TInput, TConflict, TServerSnapshot> =
  IsUnknown<TConflict> extends true
    ? {
        /**
         * Optional conflict strategy when a queued operation diverges from remote state.
         */
        conflictHandling?: OfflineConflictHandlingConfig<
          TInput,
          TConflict,
          TServerSnapshot
        >;
      }
    : {
        /**
         * Conflict strategy required when the operation declares a concrete
         * conflict payload type.
         */
        conflictHandling: OfflineConflictHandlingConfig<
          TInput,
          TConflict,
          TServerSnapshot
        >;
      };

type ServerSnapshotField<TInput, TServerSnapshot> =
  IsUnknown<TServerSnapshot> extends true
    ? {
        /**
         * Optionally loads a fresh server-side snapshot before replay checks run.
         * The result is passed to `shouldSkipSync` and `detectConflict` as
         * `ctx.serverSnapshot`.
         */
        getServerSnapshot?: (
          ctx: OperationBaseContext<TInput>,
        ) => Promise<TServerSnapshot> | TServerSnapshot;
      }
    : {
        /**
         * Required when the operation declares a concrete server snapshot type.
         * The result is passed to `shouldSkipSync` and `detectConflict` as
         * `ctx.serverSnapshot`.
         */
        getServerSnapshot: (
          ctx: OperationBaseContext<TInput>,
        ) => Promise<TServerSnapshot> | TServerSnapshot;
      };

/**
 * Replacement data returned by `tempEntity.reconcileServerEntity(...)`.
 *
 * @typeParam TFinalPayload - Final payload that should replace the temporary one.
 * @typeParam TFinalData - Optional replacement entity data for the final payload.
 */
export type OfflineTempEntityReconciliation<
  TFinalPayload extends ValidPayload = ValidPayload,
  TFinalData = unknown,
> = {
  /** Final payload that should replace the temporary optimistic one. */
  finalPayload: TFinalPayload;
  /**
   * Optional replacement data for the final payload.
   * Omit this to keep the current optimistic entity data and only swap the
   * payload/identity.
   */
  finalData?: TFinalData;
};

/**
 * Replacement data returned by `tempEntities.reconcileServerEntities(...)`.
 *
 * @typeParam TTempId - Temporary payload that should be reconciled.
 * @typeParam TFinalPayload - Final payload that should replace the temporary one.
 * @typeParam TFinalData - Optional replacement entity data for the final payload.
 */
export type OfflineTempEntitiesReconciliation<
  TTempId extends ValidPayload = ValidPayload,
  TFinalPayload extends ValidPayload = ValidPayload,
  TFinalData = unknown,
> = OfflineTempEntityReconciliation<TFinalPayload, TFinalData> & {
  /** Temporary payload that should be reconciled. */
  tempId: TTempId;
};

/**
 * Pending temp-entity returned by `tempEntities.buildPendingEntities(...)`.
 *
 * @typeParam TTempId - Temporary payload used to track the optimistic entity.
 * @typeParam TPendingEntity - Pending entity snapshot to insert locally.
 */
export type OfflineTempEntityPendingEntry<
  TTempId extends ValidPayload = ValidPayload,
  TPendingEntity = unknown,
> = {
  /** Temporary payload that identifies the optimistic entity. */
  tempId: TTempId;
  /** Pending entity snapshot inserted while the mutation is queued. */
  pendingEntity: TPendingEntity;
};

/**
 * Optional temp-id lifecycle for optimistic offline create flows.
 *
 * @typeParam TInput - Input type used to derive the temporary entity and identifier.
 * @typeParam TTempResult - Result returned by `execute`, used only by `tempEntity.reconcileServerEntity(...)`.
 * @typeParam TTempId - Temporary payload used to track optimistic entities before reconciliation.
 */
export type OfflineTempEntityConfig<
  TInput,
  TTempResult,
  TTempId extends ValidPayload = string,
  TPendingEntity = unknown,
  TFinalPayload extends ValidPayload = ValidPayload,
  TFinalData = unknown,
> = {
  /**
   * Builds the optimistic entity inserted into local state while the mutation
   * is queued offline.
   *
   * `tempId` is the temporary payload used to identify the optimistic entity
   * until replay succeeds and the final server entity can replace it.
   */
  buildPendingEntity: (input: TInput, tempId: TTempId) => TPendingEntity;
  /**
   * Reconciles the optimistic temp entity with the successful replay result.
   */
  reconcileServerEntity: (
    result: TTempResult,
    tempId: TTempId,
  ) => OfflineTempEntityReconciliation<TFinalPayload, TFinalData>;
};

/**
 * Optional temp-id lifecycle for optimistic offline batch-create flows.
 *
 * @typeParam TInput - Input type used to derive the temporary entities and identifiers.
 * @typeParam TTempResult - Result returned by `execute`, used only by `tempEntities.reconcileServerEntities(...)`.
 * @typeParam TTempId - Temporary payload used to track optimistic entities before reconciliation.
 */
export type OfflineTempEntitiesConfig<
  TInput,
  TTempResult,
  TTempId extends ValidPayload = string,
  TPendingEntity = unknown,
  TFinalPayload extends ValidPayload = ValidPayload,
  TFinalData = unknown,
> = {
  /**
   * Builds the optimistic entities inserted into local state while the mutation
   * is queued offline.
   *
   * `tempIds` are the temporary payloads derived from the operation entity refs
   * and used until replay succeeds and the final server entities can replace them.
   */
  buildPendingEntities: (
    input: TInput,
    tempIds: readonly TTempId[],
  ) => readonly OfflineTempEntityPendingEntry<TTempId, TPendingEntity>[];
  /**
   * Reconciles the optimistic temp entities with the successful replay result.
   */
  reconcileServerEntities: (
    result: TTempResult,
    tempIds: readonly TTempId[],
  ) => readonly OfflineTempEntitiesReconciliation<
    TTempId,
    TFinalPayload,
    TFinalData
  >[];
};

type OptionalTempEntityFields<
  TInput,
  TTempResult,
  TTempId extends ValidPayload,
  TPendingEntity = unknown,
  TFinalPayload extends ValidPayload = ValidPayload,
  TFinalData = unknown,
> =
  | {
      /** Optional temporary-entity lifecycle for optimistic create/update operations. */
      tempEntity?: OfflineTempEntityConfig<
        TInput,
        TTempResult,
        TTempId,
        TPendingEntity,
        TFinalPayload,
        TFinalData
      >;
      tempEntities?: never;
    }
  | {
      tempEntity?: never;
      /** Optional temporary-entity lifecycle for optimistic batch create/update operations. */
      tempEntities?: OfflineTempEntitiesConfig<
        TInput,
        TTempResult,
        TTempId,
        TPendingEntity,
        TFinalPayload,
        TFinalData
      >;
    };

type RequiredTempEntityFields<
  TInput,
  TTempResult,
  TTempId extends ValidPayload,
  TPendingEntity = unknown,
  TFinalPayload extends ValidPayload = ValidPayload,
  TFinalData = unknown,
> =
  | {
      /** Required when the operation declares a concrete temp-entity replay result. */
      tempEntity: OfflineTempEntityConfig<
        TInput,
        TTempResult,
        TTempId,
        TPendingEntity,
        TFinalPayload,
        TFinalData
      >;
      tempEntities?: never;
    }
  | {
      tempEntity?: never;
      /** Required when the operation declares a concrete batch temp-entity replay result. */
      tempEntities: OfflineTempEntitiesConfig<
        TInput,
        TTempResult,
        TTempId,
        TPendingEntity,
        TFinalPayload,
        TFinalData
      >;
    };

type TempEntityField<
  TInput,
  TTempResult,
  TTempId extends ValidPayload,
  TPendingEntity = unknown,
  TFinalPayload extends ValidPayload = ValidPayload,
  TFinalData = unknown,
> =
  IsUnknown<TTempResult> extends true
    ? OptionalTempEntityFields<
        TInput,
        TTempResult,
        TTempId,
        TPendingEntity,
        TFinalPayload,
        TFinalData
      >
    : [TTempResult] extends [void]
      ? OptionalTempEntityFields<
          TInput,
          TTempResult,
          TTempId,
          TPendingEntity,
          TFinalPayload,
          TFinalData
        >
      : RequiredTempEntityFields<
          TInput,
          TTempResult,
          TTempId,
          TPendingEntity,
          TFinalPayload,
          TFinalData
        >;

/**
 * Shape used by `persistentStorage.offline.operations` for each operation name.
 *
 * @typeParam TInput - The persisted input payload for the queued offline operation.
 * @typeParam TConflict - The conflict payload produced by pre-execution conflict detection.
 * @typeParam TTempResult - Result returned by `execute`, used only when `tempEntity` or `tempEntities` needs to reconcile the final server entity. Defaults to `void`.
 */
export type OfflineOperationDefinition<
  TInput,
  TConflict,
  TTempResult = void,
  TServerSnapshot = unknown,
  TTempId extends ValidPayload = string,
  TPendingEntity = unknown,
  TFinalPayload extends ValidPayload = ValidPayload,
  TFinalData = unknown,
> = {
  /** Schema used to validate incoming operation input. */
  inputSchema: PersistentStorageSchema<TInput>;
  /**
   * Optional queue compaction for consecutive mutations with same refs.
   */
  accumulation?: OfflineAccumulationConfig<TInput>;
  /**
   * Optional queue pruning for newer operations that supersede older queued work.
   *
   * This is mutually exclusive with `accumulation`.
   */
  supersedes?: OfflineSupersedeConfig;
  /**
   * Executes the queued mutation against the remote source during replay.
   * This may run multiple times when transient failures occur.
   */
  execute: (
    ctx: OperationBaseContext<TInput>,
  ) => Promise<TTempResult> | TTempResult;
  /**
   * Optional check executed before retrying a previously failed sync attempt.
   * Return `true` to drop the queued entry because the remote side already reflects it.
   * Return `false` to continue with normal replay.
   */
  shouldSkipSync?: (
    ctx: OperationReplayCheckContext<TInput, TServerSnapshot>,
  ) => Promise<boolean> | boolean;
} & ConflictHandlingField<TInput, TConflict, TServerSnapshot> &
  ServerSnapshotField<TInput, TServerSnapshot> &
  TempEntityField<
    TInput,
    TTempResult,
    TTempId,
    TPendingEntity,
    TFinalPayload,
    TFinalData
  >;

type WithoutTempEntity<
  T extends { tempEntity?: unknown; tempEntities?: unknown },
> = Omit<T, 'tempEntity' | 'tempEntities'> & {
  /** Document stores do not support optimistic temp entities. */
  tempEntity?: never;
  /** Document stores do not support optimistic batch temp entities. */
  tempEntities?: never;
};

/** Context used to resolve which entities a queued mutation affects. */
type OperationEntityRefsContext<TInput> = {
  /** Input payload for the queued mutation. */
  input: TInput;
};

/** Non-store-specific offline operation definition alias. */
export type AnyOfflineOperationDefinition = {
  inputSchema: PersistentStorageSchema<__LEGIT_ANY__>;
  conflictHandling?: OfflineConflictHandlingConfig<
    __LEGIT_ANY__,
    __LEGIT_ANY__,
    __LEGIT_ANY__
  >;
  accumulation?: OfflineAccumulationConfig<__LEGIT_ANY__>;
  supersedes?: OfflineSupersedeConfig;
  tempEntity?: OfflineTempEntityConfig<
    __LEGIT_ANY__,
    __LEGIT_ANY__,
    __LEGIT_ANY__
  >;
  tempEntities?: OfflineTempEntitiesConfig<
    __LEGIT_ANY__,
    __LEGIT_ANY__,
    __LEGIT_ANY__
  >;
  getServerSnapshot?: (ctx: OperationBaseContext<__LEGIT_ANY__>) => unknown;
  execute: (ctx: OperationBaseContext<__LEGIT_ANY__>) => unknown;
  shouldSkipSync?: (
    ctx: OperationReplayCheckContext<__LEGIT_ANY__, __LEGIT_ANY__>,
  ) => Promise<boolean> | boolean;
} & {
  getEntityRefs?: (ctx: OperationEntityRefsContext<__LEGIT_ANY__>) => unknown[];
};

/**
 * Compact type-spec helper for a single offline operation.
 *
 * Use this helper with {@link DefineDocumentOfflineOperations} to describe each
 * operation using generic parameters instead of inline object literals.
 *
 * The generic order is `input`, `conflict`, `temp result`, then `server snapshot`.
 *
 * @typeParam TInput - Input payload accepted by the operation.
 * @typeParam TConflict - Conflict payload produced by optional conflict handling.
 * @typeParam TTempResult - Result returned by `execute`, used only when `tempEntity` reconciliation needs it.
 *
 * @example
 * ```ts
 * type UpdateName = DefineOfflineOperation<
 *   { name: string },
 *   { remoteName: string },
 *   { name: string }
 * >;
 * ```
 */
export type DefineOfflineOperation<
  TInput = unknown,
  TConflict = unknown,
  TTempResult = unknown,
  TServerSnapshot = unknown,
> = {
  /** Input type accepted by the operation. */
  input?: TInput;
  /** Conflict payload type produced by the optional conflict handler. */
  conflict?: TConflict;
  /** Result returned by `execute`, used only for `tempEntity` reconciliation. */
  result?: TTempResult;
  /** Snapshot type returned by `getServerSnapshot` and exposed to replay checks. */
  serverSnapshot?: TServerSnapshot;
};

type DocumentOperationInput<TOptions extends DefineOfflineOperation> =
  TOptions extends { input?: infer TInput } ? TInput : unknown;

type DocumentOperationConflict<TOptions extends DefineOfflineOperation> =
  TOptions extends { conflict?: infer TConflict } ? TConflict : unknown;

type DocumentOperationResult<TOptions extends DefineOfflineOperation> =
  TOptions extends { result?: infer TTempResult } ? TTempResult : unknown;

type DocumentOperationServerSnapshot<TOptions extends DefineOfflineOperation> =
  TOptions extends { serverSnapshot?: infer TServerSnapshot }
    ? TServerSnapshot
    : unknown;

/**
 * Document-store specific offline operation definition.
 *
 * Prefer this alias when manually typing a single operation inside
 * `persistentStorage.offline.operations` for a document store.
 *
 * `TOptions` is usually provided with {@link DefineOfflineOperation}, which lets
 * callers specify the queued `input`, replay `result`, and optional `conflict`
 * payload concisely. Document stores do not support `tempEntity`.
 *
 * Omitted properties default to `unknown`.
 *
 * @typeParam State - Document state type for the owning store.
 * @typeParam TOptions - Operation typing options, usually created with {@link DefineOfflineOperation}.
 *
 * @example
 * ```ts
 * type RenameOperation = DocumentOfflineOperationDefinition<
 *   UserDoc,
 *   DefineOfflineOperation<
 *     { name: string },
 *     { remoteName: string },
 *     { name: string }
 *   >
 * >;
 * ```
 */
export type DocumentOfflineOperationDefinition<
  State extends ValidStoreState,
  TOptions extends DefineOfflineOperation = DefineOfflineOperation,
> = WithoutTempEntity<
  OfflineOperationDefinition<
    DocumentOperationInput<TOptions>,
    DocumentOperationConflict<TOptions>,
    DocumentOperationResult<TOptions>,
    DocumentOperationServerSnapshot<TOptions>
  >
> &
  ([State] extends [never] ? never : unknown);

/**
 * Builds a document offline operations map from a compact operation spec.
 *
 * This is the recommended way to type a document store's full offline operation map.
 * Each operation key is typically described with {@link DefineOfflineOperation},
 * and this helper expands that into the full
 * {@link DocumentOfflineOperationDefinition} map expected by the store.
 *
 * @typeParam State - Document state type for the owning store.
 * @typeParam TOperations - Operation map where each key declares its input, replay result, and optional conflict payload.
 *
 * @example
 * ```ts
 * type Operations = DefineDocumentOfflineOperations<
 *   UserDoc,
 *   {
 *     updateName: DefineOfflineOperation<
 *       { name: string },
 *       unknown,
 *       { name: string }
 *     >;
 *     archive: DefineOfflineOperation<
 *       { reason: string },
 *       { code: string }
 *     >;
 *   }
 * >;
 * ```
 *
 * Then use the resulting type as the `operations` object contract:
 *
 * ```ts
 * const operations: Operations = {
 *   updateName: {
 *     inputSchema: z.object({ name: z.string() }),
 *     execute: ({ input }) => ({ name: input.name }),
 *   },
 *   archive: {
 *     inputSchema: z.object({ reason: z.string() }),
 *     conflictHandling: {
 *       detectConflict: () => false,
 *       resolveConflict: () => undefined,
 *     },
 *     execute: () => undefined,
 *   },
 * };
 * ```
 */
export type DefineDocumentOfflineOperations<
  State extends ValidStoreState,
  TOperations extends Record<string, DefineOfflineOperation>,
> = {
  [TName in keyof TOperations]: DocumentOfflineOperationDefinition<
    State,
    TOperations[TName]
  >;
};

/**
 * Collection offline entity reference.
 *
 * Collection operations return raw item payloads, which are normalized to the
 * internal item key by the store.
 *
 * @typeParam ItemPayload - Collection item payload type for the owning store.
 */
export type CollectionOfflineEntityRef<ItemPayload extends ValidPayload> =
  ItemPayload;

/**
 * Collection-store specific offline operation definition.
 *
 * @typeParam ItemState - Collection item state type for the owning store.
 * @typeParam ItemPayloadUnused - Collection payload type used to anchor the operation to the owning store type.
 * @typeParam TInput - Input type accepted by the offline operation.
 * @typeParam TConflict - Conflict payload type produced by the optional conflict handler.
 * @typeParam TTempResult - Result returned by `execute`.
 * When `tempEntity` or `tempEntities` is provided, the pending builders must
 * return `ItemState`, and the reconciliation hooks must return an
 * `ItemPayload` plus optional `ItemState` replacement data.
 */
export type CollectionOfflineOperationDefinition<
  ItemState extends ValidStoreState,
  ItemPayloadUnused extends ValidPayload,
  TInput = unknown,
  TConflict = unknown,
  TTempResult = unknown,
  TServerSnapshot = unknown,
> = OfflineOperationDefinition<
  TInput,
  TConflict,
  TTempResult,
  TServerSnapshot,
  ItemPayloadUnused,
  ItemState,
  ItemPayloadUnused,
  ItemState
> & {
  /**
   * Declares which collection items are affected by this queued mutation.
   *
   * Return the raw collection payloads for the affected items. The store will
   * convert each payload with the configured item key logic.
   */
  getEntityRefs: (
    ctx: OperationEntityRefsContext<TInput>,
  ) => CollectionOfflineEntityRef<ItemPayloadUnused>[];
} & ([ItemState | ItemPayloadUnused] extends [never] ? never : unknown);

/**
 * Builds a collection offline operations map from a compact operation spec.
 *
 * Use this helper to define the full `persistentStorage.offline.operations` contract for a
 * collection store while keeping each operation's type declaration short.
 *
 * Each operation key is described with {@link DefineOfflineOperation}, and this
 * helper expands it into the corresponding
 * {@link CollectionOfflineOperationDefinition}. The runtime operation object
 * still needs to provide `getEntityRefs(...)`.
 *
 * @typeParam ItemState - Collection item state type for the owning store.
 * @typeParam ItemPayload - Collection payload type for the owning store.
 * @typeParam TOperations - Operation map where each key declares its input, optional conflict payload, and optional temp-result type.
 *
 * @example
 * ```ts
 * type Operations = DefineCollectionOfflineOperations<
 *   TodoItem,
 *   string,
 *   {
 *     renameTodo: DefineOfflineOperation<
 *       { id: string; title: string }
 *     >;
 *     createTodo: DefineOfflineOperation<
 *       { title: string },
 *       unknown,
 *       { id: string; title: string }
 *     >;
 *   }
 * >;
 * ```
 */
export type DefineCollectionOfflineOperations<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  TOperations extends Record<string, DefineOfflineOperation>,
> = {
  [TName in keyof TOperations]: CollectionOfflineOperationDefinition<
    ItemState,
    ItemPayload,
    DocumentOperationInput<TOperations[TName]>,
    DocumentOperationConflict<TOperations[TName]>,
    DocumentOperationResult<TOperations[TName]>,
    DocumentOperationServerSnapshot<TOperations[TName]>
  >;
};

/**
 * List-query offline entity reference.
 *
 * List-query operations return raw item payloads, which are normalized to the
 * internal item key by the store.
 *
 * @typeParam ItemPayload - Item payload type for the owning list-query store.
 */
export type ListQueryOfflineEntityRef<ItemPayload extends ValidPayload> =
  ItemPayload;

/**
 * List-query-store specific offline operation definition.
 *
 * @typeParam ItemState - List item state type for the owning store.
 * @typeParam QueryPayload - Query payload type used by the list store.
 * @typeParam ItemPayloadUnused - Item payload type used to anchor the operation to the owning store type.
 * @typeParam TInput - Input type accepted by the offline operation.
 * @typeParam TConflict - Conflict payload type produced by the optional conflict handler.
 * @typeParam TTempResult - Result returned by `execute`.
 * When `tempEntity` or `tempEntities` is provided, the pending builders must
 * return `ItemState`, and the reconciliation hooks must return an
 * `ItemPayload` plus optional `ItemState` replacement data.
 */
export type ListQueryOfflineOperationDefinition<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayloadUnused extends ValidPayload,
  TInput = unknown,
  TConflict = unknown,
  TTempResult = unknown,
  TServerSnapshot = unknown,
> = OfflineOperationDefinition<
  TInput,
  TConflict,
  TTempResult,
  TServerSnapshot,
  ItemPayloadUnused,
  ItemState,
  ItemPayloadUnused,
  ItemState
> & {
  /**
   * Declares which list-query entities are affected by this queued mutation.
   *
   * Return the raw item payloads for the affected items. The store will
   * convert each payload with the configured item key logic.
   */
  getEntityRefs: (
    ctx: OperationEntityRefsContext<TInput>,
  ) => ListQueryOfflineEntityRef<ItemPayloadUnused>[];
} & ([ItemState | QueryPayload | ItemPayloadUnused] extends [never]
    ? never
    : unknown);

/**
 * Builds a list-query offline operations map from a compact operation spec.
 *
 * Use this helper to define the full `persistentStorage.offline.operations` contract for a
 * list-query store while keeping each operation's type declaration short.
 *
 * Each operation key is described with {@link DefineOfflineOperation}, and this
 * helper expands it into the corresponding
 * {@link ListQueryOfflineOperationDefinition}. The runtime operation object
 * still needs to provide `getEntityRefs(...)`.
 *
 * @typeParam ItemState - List item state type for the owning store.
 * @typeParam QueryPayload - Query payload type used by the list store.
 * @typeParam ItemPayload - Item payload type used by the list store.
 * @typeParam TOperations - Operation map where each key declares its input, optional conflict payload, and optional temp-result type.
 *
 * @example
 * ```ts
 * type Operations = DefineListQueryOfflineOperations<
 *   User,
 *   { tableId: 'users' },
 *   { tableId: 'users'; id: number } | string,
 *   {
 *     renameUser: DefineOfflineOperation<
 *       { id: number; name: string }
 *     >;
 *     createUser: DefineOfflineOperation<
 *       { name: string },
 *       unknown,
 *       { id: number; name: string }
 *     >;
 *   }
 * >;
 * ```
 */
export type DefineListQueryOfflineOperations<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
  TOperations extends Record<string, DefineOfflineOperation>,
> = {
  [TName in keyof TOperations]: ListQueryOfflineOperationDefinition<
    ItemState,
    QueryPayload,
    ItemPayload,
    DocumentOperationInput<TOperations[TName]>,
    DocumentOperationConflict<TOperations[TName]>,
    DocumentOperationResult<TOperations[TName]>,
    DocumentOperationServerSnapshot<TOperations[TName]>
  >;
};

/**
 * Extracts operation conflict payload from a registered operation map.
 *
 * @typeParam TOperations - Operation registry to inspect.
 * @typeParam TName - Operation name whose conflict payload should be extracted.
 */
export type OperationConflict<
  TOperations,
  TName extends keyof TOperations,
> = TOperations[TName] extends {
  conflictHandling?: OfflineConflictHandlingConfig<
    __LEGIT_ANY__,
    infer TConflict
  >;
}
  ? TConflict
  : never;

/**
 * Base shape for each offline operation entry in `persistentStorage.offline.operations`.
 * The `inputSchema` is used for both validation and queue serialization.
 */
export type OfflineOperationSchemaShape = {
  inputSchema: PersistentStorageSchema<__LEGIT_ANY__>;
};
