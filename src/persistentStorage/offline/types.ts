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
  tempId?: ValidPayload;
};

/**
 * Persisted offline conflict payload.
 *
 * @typeParam TConflict - Conflict payload stored for later resolution.
 * @typeParam TInput - Original mutation input associated with the conflict.
 */
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
  /** Optional temporary ID associated with optimistic entity flow. */
  tempId?: ValidPayload;
};

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
  /** Optional temporary ID for optimistic create operations. */
  tempId?: ValidPayload;
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
 * Non-empty list form accepted by offline-aware mutation APIs.
 *
 * The descriptors are queued in the exact order provided whenever the direct
 * mutation falls back to offline persistence.
 */
export type OfflineMutationDescriptorList<
  TOperations extends Record<
    string,
    { inputSchema: PersistentStorageSchema<__LEGIT_ANY__> }
  >,
  TName extends keyof TOperations & string = keyof TOperations & string,
> = readonly [
  OfflineMutationDescriptor<TOperations, TName>,
  ...OfflineMutationDescriptor<TOperations, TName>[],
];

/**
 * Public offline mutation input accepted by store mutation APIs.
 *
 * Callers can queue either one descriptor or an ordered non-empty list of
 * descriptors.
 */
export type OfflineMutationInput<
  TOperations extends Record<
    string,
    { inputSchema: PersistentStorageSchema<__LEGIT_ANY__> }
  >,
  TName extends keyof TOperations & string = keyof TOperations & string,
> =
  | OfflineMutationDescriptor<TOperations, TName>
  | OfflineMutationDescriptorList<TOperations, TName>;

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

type TempEntityField<
  TInput,
  TTempResult,
  TTempId extends ValidPayload,
  TPendingEntity = unknown,
  TFinalPayload extends ValidPayload = ValidPayload,
  TFinalData = unknown,
> =
  IsUnknown<TTempResult> extends true
    ? {
        /** Optional temporary-entity lifecycle for optimistic create/update operations. */
        tempEntity?: OfflineTempEntityConfig<
          TInput,
          TTempResult,
          TTempId,
          TPendingEntity,
          TFinalPayload,
          TFinalData
        >;
      }
    : [TTempResult] extends [void]
      ? {
          /** Optional temporary-entity lifecycle for optimistic create/update operations. */
          tempEntity?: OfflineTempEntityConfig<
            TInput,
            TTempResult,
            TTempId,
            TPendingEntity,
            TFinalPayload,
            TFinalData
          >;
        }
      : {
          /** Required when the operation declares a concrete temp-entity replay result. */
          tempEntity: OfflineTempEntityConfig<
            TInput,
            TTempResult,
            TTempId,
            TPendingEntity,
            TFinalPayload,
            TFinalData
          >;
        };

/**
 * Shape used by `offlineMode.operations` for each operation name.
 *
 * @typeParam TInput - The persisted input payload for the queued offline operation.
 * @typeParam TConflict - The conflict payload produced by pre-execution conflict detection.
 * @typeParam TTempResult - Result returned by `execute`, used only when `tempEntity` needs to reconcile the final server entity. Defaults to `void`.
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

type WithoutTempEntity<T extends { tempEntity?: unknown }> = Omit<
  T,
  'tempEntity'
> & {
  /** Document stores do not support optimistic temp entities. */
  tempEntity?: never;
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
  tempEntity?: OfflineTempEntityConfig<
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
 * `persistentStorage.offlineMode.operations` for a document store.
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
 * When `tempEntity` is provided, `buildPendingEntity(...)` must return
 * `ItemState`, and `reconcileServerEntity(...)` must return an `ItemPayload`
 * plus optional `ItemState` replacement data.
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
 * Use this helper to define the full `offlineMode.operations` contract for a
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
 * When `tempEntity` is provided, `buildPendingEntity(...)` must return
 * `ItemState`, and `reconcileServerEntity(...)` must return an `ItemPayload`
 * plus optional `ItemState` replacement data.
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
 * Use this helper to define the full `offlineMode.operations` contract for a
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
 * Root offline configuration passed in store persistentStorage options.
 *
 * @typeParam TOperations - Operation registry exposed by the store.
 */
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
