import type { __LEGIT_ANY__ } from '@ls-stack/utils/saferTyping';
import type { PersistentStorageSchema } from '../types';
import type { ValidPayload, ValidStoreState } from '../../utils/storeShared';

export type OfflineStoreType = 'document' | 'collection' | 'listQuery';
export type OfflineFailurePhase = 'fetch' | 'mutation' | 'sync';

export type OfflineFailureClassification = 'outage' | 'ignore';

export type OfflineEntityKind = 'document' | 'item' | 'query';

export type OfflineConnectivityError = {
  code: 0;
  id: 'offline';
  message: 'Offline';
};

export type OfflineFailureContext = {
  phase: OfflineFailurePhase;
  storeType: OfflineStoreType;
  operationName?: string;
  sessionKey: string;
};

export type OfflineRecoveryProbeConfig = {
  intervalMs?: number;
  maxIntervalMs?: number;
  backoffMultiplier?: number;
  jitterRatio?: number;
};

export type OfflineNetworkModeConfig = {
  enabled: boolean;
  listenToBrowserEvents?: boolean;
  getIsOffline?: () => boolean | Promise<boolean>;
};

export type OfflineOutageModeConfig = {
  enabled: boolean;
  classifyFailure: (
    error: unknown,
    ctx: OfflineFailureContext,
  ) => Promise<OfflineFailureClassification> | OfflineFailureClassification;
  recoveryCheck: (ctx: { sessionKey: string }) => Promise<boolean> | boolean;
  recoveryProbe?: OfflineRecoveryProbeConfig;
};

export type OfflineConnectivityState = 'online' | 'offline';

export type GlobalOfflineStatus = {
  sessionKey: string;
  network: { enabled: boolean; active: boolean };
  outage: { enabled: boolean; active: boolean };
  effectiveMode: OfflineConnectivityState;
  effectiveOffline: boolean;
  isLeader: boolean;
  updatedAt: number;
  lastFailureAt: number | null;
  lastRecoveryCheckAt: number | null;
};

export type OfflineSyncState = 'pending' | 'syncing' | 'needs-confirmation';

export type GlobalOfflineEntity = {
  id: string;
  sessionKey: string;
  storeName: string;
  storeType: OfflineStoreType;
  entityKey: string;
  entityKind: OfflineEntityKind;
  pendingMutations: number;
  syncState: OfflineSyncState | 'conflict';
  hasConflict: boolean;
  createdAt: number;
  updatedAt: number;
  tempId?: string;
};

export type OfflineEntityRef = {
  entityKey: string;
  entityKind: OfflineEntityKind;
};

export type OfflineConflictRecord<TConflict = unknown, TInput = unknown> = {
  id: string;
  entryId: string;
  sessionKey: string;
  storeName: string;
  storeType: OfflineStoreType;
  operation: string;
  input: TInput;
  conflict: TConflict;
  mutationPayload?: unknown;
  entityRefs: OfflineEntityRef[];
  createdAt: number;
  updatedAt: number;
  tempId?: string;
};

export type OfflineQueueEntry<TInput = unknown, TConflict = unknown> = {
  id: string;
  sessionKey: string;
  storeName: string;
  storeType: OfflineStoreType;
  operation: string;
  input: TInput;
  mutationPayload?: unknown;
  entityRefs: OfflineEntityRef[];
  attempts: number;
  createdAt: number;
  updatedAt: number;
  lastAttemptAt: number | null;
  syncState: OfflineSyncState;
  tempId?: string;
  lastError?: { message: string };
  pendingConflict?: TConflict;
};

export type OfflineOperationSchemaShape = {
  inputSchema: PersistentStorageSchema<__LEGIT_ANY__>;
};

export type OperationInput<
  TOperations,
  TName extends keyof TOperations,
> = TOperations[TName] extends {
  inputSchema: PersistentStorageSchema<infer TInput>;
}
  ? TInput
  : never;

export type OfflineMutationDescriptor<
  TOperations extends Record<
    string,
    { inputSchema: PersistentStorageSchema<__LEGIT_ANY__> }
  >,
  TName extends keyof TOperations = keyof TOperations,
> = TName extends keyof TOperations
  ? { operation: TName; input: OperationInput<TOperations, TName> }
  : never;

export type OfflineResolveConflictResult<TInput> = void | {
  requeue?: { input: TInput };
};

export type OfflineConfirmRemoteOutcomeResult =
  | { type: 'applied' }
  | { type: 'not-applied' }
  | { type: 'conflict'; conflict: unknown }
  | { type: 'unknown' };

export type OfflineAccumulationMergeContext<THelpers, TInput> = {
  sessionKey: string;
  helpers: THelpers;
  existingInput: TInput;
  incomingInput: TInput;
};

export type OfflineAccumulationConfig<THelpers, TInput> = {
  mergeInput: (
    ctx: OfflineAccumulationMergeContext<THelpers, TInput>,
  ) => Promise<TInput> | TInput;
};

type OperationBaseContext<THelpers, TInput, TMutationPayload> = {
  sessionKey: string;
  helpers: THelpers;
  input: TInput;
  mutationPayload?: TMutationPayload;
};

export type OfflineConflictHandlingConfig<
  THelpers,
  TInput,
  TConflict,
  TResult,
  TMutationPayload = unknown,
> = {
  /**
   * Optional schema used to validate conflict payloads before they are written
   * to offline conflict storage.
   */
  schema?: PersistentStorageSchema<TConflict>;
  /**
   * Inspects a successful `execute` result and returns a conflict payload when
   * the queued mutation cannot be applied cleanly.
   *
   * Return `false` or `null` when the mutation should be considered synced.
   */
  detectConflict: (
    ctx: OperationBaseContext<THelpers, TInput, TMutationPayload> & {
      result: TResult;
    },
  ) => Promise<TConflict | false | null> | TConflict | false | null;
  /**
   * Resolves a persisted offline conflict.
   *
   * Return `requeue` to enqueue the same operation again with replacement
   * input.
   */
  resolveConflict: (
    ctx: OperationBaseContext<THelpers, TInput, TMutationPayload> & {
      conflict: TConflict;
      resolution: unknown;
    },
  ) =>
    | Promise<OfflineResolveConflictResult<TInput>>
    | OfflineResolveConflictResult<TInput>;
};

export type OfflineTempEntityConfig<TInput, TResult> = {
  /**
   * Creates a temporary entity id for optimistic offline-created records.
   *
   * When provided, accumulation is skipped for that queued mutation.
   */
  createTempId: (input: TInput) => string;
  /**
   * Builds the optimistic entity state inserted into the local store for a new
   * temporary id, when the store adapter supports pending entities.
   */
  buildPendingEntity: (input: TInput, tempId: string) => unknown;
  /**
   * Maps the successful server result for a temp-id mutation into the final
   * store payload and optional data used to replace the optimistic entity.
   */
  reconcileServerEntity: (
    result: TResult,
    tempId: string,
  ) => { finalPayload: ValidPayload; finalData?: unknown };
};

export type OfflineOperationDefinition<
  THelpers,
  TInput,
  TConflict,
  TResult,
  TMutationPayload = unknown,
> = {
  /** Schema used to validate the queued operation input. */
  inputSchema: PersistentStorageSchema<TInput>;
  /**
   * Optional conflict handling. When omitted, the operation cannot surface
   * persisted offline conflicts.
   */
  conflictHandling?: OfflineConflictHandlingConfig<
    THelpers,
    TInput,
    TConflict,
    TResult,
    TMutationPayload
  >;
  /**
   * Opt-in queue compaction for pending offline mutations targeting the same
   * operation and entity refs. When provided, a new pending mutation may merge
   * into an existing pending queue entry instead of creating a second entry.
   */
  accumulation?: OfflineAccumulationConfig<THelpers, TInput>;
  /**
   * Optional temp-entity lifecycle for optimistic offline-created records.
   * When omitted, the operation does not create temporary ids.
   */
  tempEntity?: OfflineTempEntityConfig<TInput, TResult>;
  /**
   * Replays the queued mutation against the remote source during offline sync.
   *
   * This may be retried after transient failures. `signal` is provided when the
   * caller can cancel the in-flight request.
   */
  execute: (
    ctx: OperationBaseContext<THelpers, TInput, TMutationPayload> & {
      signal?: AbortSignal;
    },
  ) => Promise<TResult> | TResult;
  /**
   * Verifies whether a previously failed sync attempt may already have been
   * applied remotely.
   *
   * This hook is called before retrying entries in `needs-confirmation`. Return
   * `applied` to drop the entry, `not-applied` to retry `execute`, `conflict`
   * to persist a conflict, or `unknown` to keep waiting for confirmation.
   */
  confirmRemoteOutcome?: (
    ctx: OperationBaseContext<THelpers, TInput, TMutationPayload>,
  ) =>
    | Promise<OfflineConfirmRemoteOutcomeResult>
    | OfflineConfirmRemoteOutcomeResult;
};

export type AnyOfflineOperationDefinition<
  THelpers = __LEGIT_ANY__,
  TMutationPayload = __LEGIT_ANY__,
> = OfflineOperationDefinition<
  THelpers,
  __LEGIT_ANY__,
  __LEGIT_ANY__,
  __LEGIT_ANY__,
  TMutationPayload
>;

export type DocumentOfflineHelpers<State extends ValidStoreState> = {
  getState: () => State | null;
  updateState: (updater: (draft: State) => void) => boolean;
  invalidateData: () => void;
};

export type DocumentOfflineOperationDefinition<
  State extends ValidStoreState,
  TInput = __LEGIT_ANY__,
  TConflict = __LEGIT_ANY__,
  TResult = __LEGIT_ANY__,
  TMutationPayload = unknown,
> = OfflineOperationDefinition<
  DocumentOfflineHelpers<State>,
  TInput,
  TConflict,
  TResult,
  TMutationPayload
>;

export type DocumentOfflineOperationsRegistry<State extends ValidStoreState> =
  Record<string, DocumentOfflineOperationDefinition<State>>;

export type CollectionOfflineHelpers<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = {
  getItemState: (payload: ItemPayload) => ItemState | null;
  updateItemState: (
    payload: ItemPayload | ItemPayload[],
    updater: (item: ItemState) => ItemState | undefined,
  ) => boolean;
  addItemToState: (payload: ItemPayload, data: ItemState) => void;
  deleteItemState: (payload: ItemPayload | ItemPayload[]) => void;
  invalidateItem: (payload: ItemPayload) => void;
  getItemKey: (payload: ItemPayload) => string;
};

export type CollectionOfflineOperationDefinition<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  TInput = __LEGIT_ANY__,
  TConflict = __LEGIT_ANY__,
  TResult = __LEGIT_ANY__,
  TMutationPayload = ItemPayload,
> = OfflineOperationDefinition<
  CollectionOfflineHelpers<ItemState, ItemPayload>,
  TInput,
  TConflict,
  TResult,
  TMutationPayload
>;

export type CollectionOfflineOperationsRegistry<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = Record<
  string,
  CollectionOfflineOperationDefinition<ItemState, ItemPayload>
>;

export type ListQueryOfflineHelpers<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = {
  getItemState: (payload: ItemPayload) => ItemState | null;
  updateItemState: (
    payload: ItemPayload | ItemPayload[],
    updater: (item: ItemState) => ItemState | undefined,
  ) => boolean;
  addItemToState: (payload: ItemPayload, data: ItemState) => void;
  deleteItemState: (payload: ItemPayload | ItemPayload[]) => void;
  invalidateItem: (payload: ItemPayload) => void;
  invalidateQueryAndItems: (args: {
    itemPayload:
      | ItemPayload
      | ItemPayload[]
      | ((item: ItemPayload) => boolean)
      | false;
    queryPayload:
      | QueryPayload
      | QueryPayload[]
      | ((query: QueryPayload) => boolean)
      | false;
  }) => void;
  getItemKey: (payload: ItemPayload) => string;
  getQueryKey: (payload: QueryPayload) => string;
};

export type ListQueryOfflineOperationDefinition<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
  TInput = __LEGIT_ANY__,
  TConflict = __LEGIT_ANY__,
  TResult = __LEGIT_ANY__,
  TMutationPayload = ItemPayload | ItemPayload[] | undefined,
> = OfflineOperationDefinition<
  ListQueryOfflineHelpers<ItemState, QueryPayload, ItemPayload>,
  TInput,
  TConflict,
  TResult,
  TMutationPayload
>;

export type ListQueryOfflineOperationsRegistry<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = Record<
  string,
  ListQueryOfflineOperationDefinition<ItemState, QueryPayload, ItemPayload>
>;

export type OperationConflict<
  TOperations,
  TName extends keyof TOperations,
> = TOperations[TName] extends {
  conflictHandling?: OfflineConflictHandlingConfig<
    __LEGIT_ANY__,
    __LEGIT_ANY__,
    infer TConflict,
    __LEGIT_ANY__,
    __LEGIT_ANY__
  >;
}
  ? TConflict
  : never;

export type OfflineModeConfig<
  TOperations extends Record<string, OfflineOperationSchemaShape>,
> = {
  network?: OfflineNetworkModeConfig;
  outage?: OfflineOutageModeConfig;
  operations: TOperations;
};
