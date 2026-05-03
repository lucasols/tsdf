import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import {
  isResult,
  unknownToError,
  type Result as ResultType,
  type ResultValidErrors,
} from 't-result';
import type { FetchType } from '../requestScheduler';

export type TSDFStatus = 'loading' | 'error' | 'refetching' | 'success';

export type ValidPayload = number | string | Record<string, unknown>;

export type ValidStoreState = Record<string, unknown> | unknown[];

export type UnwrapTSDFResult<T> = T extends { ok: true; value: infer Value }
  ? Value
  : T extends { ok: false; error: ResultValidErrors }
    ? never
    : T;

export function unwrapTSDFResult<T>(value: T): UnwrapTSDFResult<T> {
  if (isResult(value)) {
    if (value.ok) {
      // WORKAROUND: TS conditional return types don't narrow from a runtime isResult guard on generic T.
      return __LEGIT_CAST__<UnwrapTSDFResult<T>, unknown>(value.value);
    }

    // eslint-disable-next-line @typescript-eslint/only-throw-error -- Result.err carries the caller's domain error so existing normalization/offline classification can see it unchanged.
    throw value.error;
  }

  // WORKAROUND: same generic conditional limitation — the non-Result branch can't narrow to T.
  return __LEGIT_CAST__<UnwrapTSDFResult<T>, unknown>(value);
}

export type MaybeTSDFResult<T> = T | ResultType<T, ResultValidErrors>;

export function unwrapMaybeTSDFResult<T>(value: MaybeTSDFResult<T>): T {
  // WORKAROUND: unwrapTSDFResult returns UnwrapTSDFResult<T>, which doesn't reduce to T for the MaybeTSDFResult<T> input.
  return __LEGIT_CAST__<T, unknown>(unwrapTSDFResult(value));
}

/**
 * Debounce settings for payload-driven automatic fetches in store hooks.
 *
 * The hook still reads data from state using the latest payload immediately.
 * Only the automatic fetch side is delayed. Single hooks do not support
 * combining this with `ensureIsLoaded`.
 */
export type PayloadDebounce = {
  /** Debounce window in milliseconds before the latest payload is fetched. */
  ms: number;
  /**
   * Maximum time a burst may stay deferred before the latest payload is
   * fetched, even if changes keep happening within the debounce window.
   */
  maxWait?: number;
  /**
   * When true, the first payload in a burst may fetch immediately, and later
   * changes within the same burst stay debounced until the wait window ends.
   */
  leading?: boolean;
};

export const DEFAULT_BATCH_KEY = '__default__';

export type StoreError = {
  code: number;
  id: string;
  message: string;
  path?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
};

export const invalidPayloadError: StoreError = {
  code: 461,
  id: 'invalid-payload',
  message: 'Invalid payload',
};

export const fetchTypePriority: Record<FetchType, number> = {
  lowPriority: 0,
  realtimeUpdate: 1,
  mediumPriority: 2,
  highPriority: 3,
};

export type MutationSkipped = { kind: 'skipped' };

export const mutationSkipped: MutationSkipped = { kind: 'skipped' };

/** Options passed to mutation error handlers. */
export type StoreMutationErrorOptions = {
  /**
   * True when the mutation caller asked the shared error handler to stay quiet.
   *
   * Handlers are still called so apps can keep centralized logging, metrics, or
   * custom recovery behavior while suppressing user-facing noise such as toast
   * notifications.
   */
  silentErrors?: boolean;
};

/**
 * Resolves a store-level option that may inherit from a manager-level fallback.
 * `undefined` means "use the manager value" and `null` means "explicit opt-out,
 * ignore the manager value".
 */
export function resolveManagerFallback<T>(
  storeLevel: T | null | undefined,
  managerLevel: NoInfer<T> | undefined,
): T | undefined {
  if (storeLevel === null) return undefined;
  return storeLevel ?? managerLevel;
}

function getStoreErrorLike(value: unknown): StoreError | null {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('code' in value) ||
    typeof value.code !== 'number' ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    !('message' in value) ||
    typeof value.message !== 'string'
  ) {
    return null;
  }

  return {
    code: value.code,
    id: value.id,
    message: value.message,
    method:
      'method' in value &&
      (value.method === 'GET' ||
        value.method === 'POST' ||
        value.method === 'PUT' ||
        value.method === 'DELETE' ||
        value.method === 'PATCH')
        ? value.method
        : undefined,
    path:
      'path' in value && typeof value.path === 'string'
        ? value.path
        : undefined,
  };
}

export function normalizeStoreError(
  exception: unknown,
  errorNormalizer: (exception: Error) => StoreError,
): StoreError {
  return (
    getStoreErrorLike(exception) ?? errorNormalizer(unknownToError(exception))
  );
}

export class StoreMutationError extends Error {
  readonly kind = 'error';
  code: number;
  id: string;
  path?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

  constructor(error: StoreError, options?: ErrorOptions) {
    super(error.message, options);
    this.name = 'StoreMutationError';
    this.code = error.code;
    this.id = error.id;
    this.path = error.path;
    this.method = error.method;
  }
}

export function toStoreMutationError(
  exception: unknown,
  errorNormalizer: (exception: Error) => StoreError,
): StoreMutationError {
  if (exception instanceof StoreMutationError) return exception;

  return new StoreMutationError(
    normalizeStoreError(exception, errorNormalizer),
    { cause: exception },
  );
}

export class StoreFetchError extends Error {
  code: number;
  id: string;
  type: 'fetch' | 'aborted' | 'timeout';
  path?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

  constructor(error: StoreError, type: 'fetch' | 'aborted' | 'timeout') {
    super(error.message);
    this.name = 'StoreFetchError';
    this.code = error.code;
    this.id = error.id;
    this.type = type;
    this.path = error.path;
    this.method = error.method;
  }
}

export class TimeoutStoreError extends StoreFetchError {
  constructor() {
    super({ code: 408, id: 'timeout', message: 'Timeout' }, 'timeout');
    this.name = 'TimeoutStoreError';
  }
}

export class AbortedStoreError extends StoreFetchError {
  constructor() {
    super({ code: 408, id: 'aborted', message: 'Aborted' }, 'aborted');
    this.name = 'AbortedStoreError';
  }
}

export class NotFoundStoreError extends StoreFetchError {
  constructor() {
    super({ code: 404, id: 'not-found', message: 'Not found' }, 'fetch');
    this.name = 'NotFoundStoreError';
  }
}
