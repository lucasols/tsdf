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

export type StoreError = {
  code: number;
  id: string;
  message: string;
  path?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
};

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
