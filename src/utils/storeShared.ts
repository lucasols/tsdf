import { unknownToError } from 't-result';

import type { FetchType } from '../requestScheduler';

export type TSDFStatus = 'loading' | 'error' | 'refetching' | 'success';

export type ValidPayload = number | string | Record<string, unknown>;

export type ValidStoreState = Record<string, unknown> | unknown[];

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

export const invalidPayloadError = {
  code: 461,
  id: 'invalid-payload',
  message: 'Invalid payload',
} as const;

export const fetchTypePriority: Record<FetchType, number> = {
  lowPriority: 0,
  realtimeUpdate: 1,
  mediumPriority: 2,
  highPriority: 3,
};

export type MutationSkipped = { kind: 'skipped' };

export const mutationSkipped = {
  kind: 'skipped',
} as const satisfies MutationSkipped;

export type StoreError = {
  code: number;
  id: string;
  message: string;
  path?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
};

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

  const normalizedError =
    getStoreErrorLike(exception) ?? errorNormalizer(unknownToError(exception));

  return new StoreMutationError(normalizedError, { cause: exception });
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
