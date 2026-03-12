import type { __LEGIT_ANY__ } from '@ls-stack/utils/saferTyping';
import type { ValidPayload, ValidStoreState } from '../../utils/storeShared';
import type { PersistentStorageSchema } from '../types';

/** Store kinds supported by offline replay and sync state tracking. */
export type OfflineStoreType = 'document' | 'collection' | 'listQuery';
/** Phase where a failure occurred during offline-enabled operation flow. */
export type OfflineFailurePhase = 'fetch' | 'mutation' | 'sync';
/** High-level classification used by outage detection. */
export type OfflineFailureClassification = 'outage' | 'ignore';
/** Kinds of entities participating in offline conflict/sync tracking. */
export type OfflineEntityKind = 'document' | 'item' | 'query';

/** Error shape emitted when runtime is operating in offline mode. */
export type OfflineConnectivityError = {
  /** Numeric error code used by offline failure handlers. */
  code: 0;
  /** Stable machine-readable offline error identifier. */
  id: 'offline';
  /** Default offline error message. */
  message: 'Offline';
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

/** Re-check strategy when outage recovery is enabled. */
export type OfflineRecoveryProbeConfig = {
  /** Initial recovery check delay, in milliseconds. */
  intervalMs?: number;
  /** Maximum recovery probe delay, in milliseconds. */
  maxIntervalMs?: number;
  /** Multiplicative backoff between recovery probes. */
  backoffMultiplier?: number;
  /** Jitter ratio (0-1) applied to the recovery probe delay. */
  jitterRatio?: number;
};

/** Network availability mode configuration for offline controls. */
export type OfflineNetworkModeConfig = {
  /** Enable network outage checks and tracking. */
  enabled: boolean;
  /** If true, subscribe to browser `online` / `offline` events. */
  listenToBrowserEvents?: boolean;
  /**
   * Optional override for network connectivity checks.
   * Return `true` when network should be considered offline.
   */
  getIsOffline?: () => boolean | Promise<boolean>;
};

/** Server outage detection and recovery configuration. */
export type OfflineOutageModeConfig = {
  /** Enable outage mode logic and confirmation retry flow. */
  enabled: boolean;
  /**
   * Classify a remote failure as `outage` or `ignore`.
   * `outage` activates offline recovery behavior.
   */
  classifyFailure: (
    error: unknown,
    ctx: OfflineFailureContext,
  ) => Promise<OfflineFailureClassification> | OfflineFailureClassification;
  /** Probe the remote service to confirm outage recovery. */
  recoveryCheck: (ctx: { sessionKey: string }) => Promise<boolean> | boolean;
  /** Optional probe config to tune recovery behavior. */
  recoveryProbe?: OfflineRecoveryProbeConfig;
};

/** Effective network/offline state computed by offline coordination. */
export type OfflineConnectivityState = 'online' | 'offline';

/** Per-session offline status snapshot shared across tabs. */
export type GlobalOfflineStatus = {
  /** Session key for this status bucket. */
  sessionKey: string;
  /** Network mode and current active state. */
  network: { enabled: boolean; active: boolean };
  /** Outage mode and active recovery state. */
  outage: { enabled: boolean; active: boolean };
  /** Effective mode after combining network and outage data. */
  effectiveMode: OfflineConnectivityState;
  /** Whether offline behavior is currently active. */
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
  syncState: OfflineSyncState | 'conflict';
  /** Whether the entity is currently in conflict state. */
  hasConflict: boolean;
  /** Creation timestamp for lifecycle bookkeeping. */
  createdAt: number;
  /** Last mutation/update timestamp. */
  updatedAt: number;
  /** Optional temporary ID for optimistic create flows. */
  tempId?: string;
};

/** Lightweight entity reference used to merge and protect related offline queue entries. */
export type OfflineEntityRef = {
  /** Entity key referenced by the relation. */
  entityKey: string;
  /** Entity kind of the relation reference. */
  entityKind: OfflineEntityKind;
};

/** Persisted offline conflict payload. */
export type OfflineConflictRecord<TConflict = unknown, TInput = unknown> = {
  /** Conflict record identifier. */
  id: string;
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
  /** Optional mutation payload snapshot if tracked by adapter. */
  mutationPayload?: unknown;
  /** Entity references involved in the conflict. */
  entityRefs: OfflineEntityRef[];
  /** Conflict creation timestamp. */
  createdAt: number;
  /** Conflict update timestamp. */
  updatedAt: number;
  /** Optional temporary ID associated with optimistic entity flow. */
  tempId?: string;
};

/** Persisted offline mutation queue entry. */
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
  /** Optional adapter-specific payload for mutation replay. */
  mutationPayload?: unknown;
  /** Entity references tied to this mutation. */
  entityRefs: OfflineEntityRef[];
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
  /** Optional temporary ID for optimistic create operations. */
  tempId?: string;
  /** Last recorded sync error if replay failed. */
  lastError?: { message: string };
  /** Pending conflict payload when confirmation or resolution is required. */
  pendingConflict?: TConflict;
};

/**
 * Base shape for each offline operation entry in `offlineMode.operations`.
 * The `inputSchema` is used for both validation and queue serialization.
 */
export type OfflineOperationSchemaShape = {
  inputSchema: PersistentStorageSchema<__LEGIT_ANY__>;
};

/** Extracts operation input type from a schema map. */
export type OperationInput<
  TOperations,
  TName extends keyof TOperations,
> = TOperations[TName] extends {
  inputSchema: PersistentStorageSchema<infer TInput>;
}
  ? TInput
  : never;

/** A typed operation descriptor for an offline mutation queue entry. */
export type OfflineMutationDescriptor<
  TOperations extends Record<
    string,
    { inputSchema: PersistentStorageSchema<__LEGIT_ANY__> }
  >,
  TName extends keyof TOperations = keyof TOperations,
> = TName extends keyof TOperations
  ? {
      /** Operation key from the offline operations registry. */
      operation: TName;
      /** Input resolved from the registered operation schema. */
      input: OperationInput<TOperations, TName>;
    }
  : never;

/** Result returned from conflict handlers to requeue a replacement operation input. */
export type OfflineResolveConflictResult<TInput> = void | {
  requeue?: { input: TInput };
};

/** Outcome for confirming whether a previously executed mutation was already applied. */
export type OfflineConfirmRemoteOutcomeResult =
  | { type: 'applied' }
  | { type: 'not-applied' }
  | { type: 'conflict'; conflict: unknown }
  | { type: 'unknown' };

/** Context passed into offline mutation accumulation hooks. */
export type OfflineAccumulationMergeContext<TInput> = {
  /** Session key used to isolate queued mutations. */
  sessionKey: string;
  /** Existing input already present in queue. */
  existingInput: TInput;
  /** Incoming input for merge attempt. */
  incomingInput: TInput;
};

/** Optional in-memory accumulation strategy for queued offline mutations. */
export type OfflineAccumulationConfig<TInput> = {
  /** Merge function for combining existing and incoming mutation inputs. */
  mergeInput: (
    ctx: OfflineAccumulationMergeContext<TInput>,
  ) => Promise<TInput> | TInput;
};

/** Shared context passed to offline conflict detection and resolution handlers. */
type OperationBaseContext<TInput, TMutationPayload> = {
  /** Session identifier used for queue scoping and offline coordination. */
  sessionKey: string;
  /** Input payload for the queued mutation currently being processed. */
  input: TInput;
  /**
   * Optional payload provided by the adapter during mutation execution, if
   * available.
   */
  mutationPayload?: TMutationPayload;
};

/**
 * Conflict hook configuration for a queued offline operation.
 */
export type OfflineConflictHandlingConfig<
  TInput,
  TConflict,
  TResult,
  TMutationPayload = unknown,
> = {
  /** Optional schema to validate and sanitize stored conflict payloads. */
  schema?: PersistentStorageSchema<TConflict>;
  /**
   * Analyze an operation result and return conflict payload when local replay does
   * not match remote state.
   */
  detectConflict: (
    ctx: OperationBaseContext<TInput, TMutationPayload> & { result: TResult },
  ) => Promise<TConflict | false | null> | TConflict | false | null;
  /**
   * Resolve persisted conflict data and optionally requeue an adjusted operation.
   */
  resolveConflict: (
    ctx: OperationBaseContext<TInput, TMutationPayload> & {
      conflict: TConflict;
      resolution: unknown;
    },
  ) =>
    | Promise<OfflineResolveConflictResult<TInput>>
    | OfflineResolveConflictResult<TInput>;
};

/** Optional temp-id lifecycle for optimistic offline create flows. */
export type OfflineTempEntityConfig<TInput, TResult> = {
  /**
   * Creates a temporary identifier to reference optimistic local entities.
   */
  createTempId: (input: TInput) => string;
  /**
   * Builds a temporary optimistic entity inserted into local state.
   */
  buildPendingEntity: (input: TInput, tempId: string) => unknown;
  /**
   * Reconciles temp entities with the successful server response.
   */
  reconcileServerEntity: (
    result: TResult,
    tempId: string,
  ) => { finalPayload: ValidPayload; finalData?: unknown };
};

/**
 * Shape used by `offlineMode.operations` for each operation name.
 */
export type OfflineOperationDefinition<
  TInput,
  TConflict,
  TResult,
  TMutationPayload = unknown,
> = {
  /** Schema used to validate incoming operation input. */
  inputSchema: PersistentStorageSchema<TInput>;
  /**
   * Optional conflict strategy when a queued operation diverges from remote state.
   */
  conflictHandling?: OfflineConflictHandlingConfig<
    TInput,
    TConflict,
    TResult,
    TMutationPayload
  >;
  /**
   * Optional queue compaction for consecutive mutations with same refs.
   */
  accumulation?: OfflineAccumulationConfig<TInput>;
  /** Optional temporary-entity lifecycle for optimistic create/update operations. */
  tempEntity?: OfflineTempEntityConfig<TInput, TResult>;
  /**
   * Executes the queued mutation against the remote source during replay.
   * This may run multiple times when transient failures occur.
   */
  execute: (
    ctx: OperationBaseContext<TInput, TMutationPayload> & {
      signal?: AbortSignal;
    },
  ) => Promise<TResult> | TResult;
  /**
   * Optional remote-confirmation check for entries awaiting confirmation.
   */
  confirmRemoteOutcome?: (
    ctx: OperationBaseContext<TInput, TMutationPayload>,
  ) =>
    | Promise<OfflineConfirmRemoteOutcomeResult>
    | OfflineConfirmRemoteOutcomeResult;
};

/** Non-store-specific offline operation definition alias. */
export type AnyOfflineOperationDefinition<TMutationPayload = __LEGIT_ANY__> =
  OfflineOperationDefinition<
    __LEGIT_ANY__,
    __LEGIT_ANY__,
    __LEGIT_ANY__,
    TMutationPayload
  >;

/** Document-store specific offline operation definition. */
export type DocumentOfflineOperationDefinition<
  State extends ValidStoreState,
  TInput = __LEGIT_ANY__,
  TConflict = __LEGIT_ANY__,
  TResult = __LEGIT_ANY__,
  TMutationPayload = unknown,
> = OfflineOperationDefinition<TInput, TConflict, TResult, TMutationPayload> &
  ([State] extends [never] ? never : unknown);

/** Document-store offline operations registry keyed by mutation name. */
export type DocumentOfflineOperationsRegistry<State extends ValidStoreState> =
  Record<string, DocumentOfflineOperationDefinition<State>>;

/** Collection-store specific offline operation definition. */
export type CollectionOfflineOperationDefinition<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  TInput = __LEGIT_ANY__,
  TConflict = __LEGIT_ANY__,
  TResult = __LEGIT_ANY__,
  TMutationPayload = ItemPayload,
> = OfflineOperationDefinition<TInput, TConflict, TResult, TMutationPayload> &
  ([ItemState] extends [never] ? never : unknown);

/** Collection-store offline operations registry keyed by mutation name. */
export type CollectionOfflineOperationsRegistry<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = Record<
  string,
  CollectionOfflineOperationDefinition<ItemState, ItemPayload>
>;

/** List-query-store specific offline operation definition. */
export type ListQueryOfflineOperationDefinition<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
  TInput = __LEGIT_ANY__,
  TConflict = __LEGIT_ANY__,
  TResult = __LEGIT_ANY__,
  TMutationPayload = ItemPayload | ItemPayload[] | undefined,
> = OfflineOperationDefinition<TInput, TConflict, TResult, TMutationPayload> &
  ([ItemState | QueryPayload] extends [never] ? never : unknown);

/** List-query-store offline operations registry keyed by mutation name. */
export type ListQueryOfflineOperationsRegistry<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = Record<
  string,
  ListQueryOfflineOperationDefinition<ItemState, QueryPayload, ItemPayload>
>;

/** Extracts operation conflict payload from a registered operation map. */
export type OperationConflict<
  TOperations,
  TName extends keyof TOperations,
> = TOperations[TName] extends {
  conflictHandling?: OfflineConflictHandlingConfig<
    __LEGIT_ANY__,
    infer TConflict,
    __LEGIT_ANY__,
    __LEGIT_ANY__
  >;
}
  ? TConflict
  : never;

/** Root offline configuration passed in store persistentStorage options. */
export type OfflineModeConfig<
  TOperations extends Record<string, OfflineOperationSchemaShape>,
> = {
  /** Network detection strategy and browser integration. */
  network?: OfflineNetworkModeConfig;
  /** Outage detection and recovery strategy for remote failures. */
  outage?: OfflineOutageModeConfig;
  /** Mutation operation definitions keyed by operation name. */
  operations: TOperations;
};
