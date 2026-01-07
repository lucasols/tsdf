import { FetchType } from './requestScheduler';

export type TSDFStatus = 'loading' | 'error' | 'refetching' | 'success';

export type ValidPayload = number | string | Record<string, unknown>;

export type ValidStoreState = Record<string, unknown> | unknown[];

export const fetchTypePriority: Record<FetchType, number> = {
  lowPriority: 0,
  mediumPriority: 1,
  realtimeUpdate: 2,
  highPriority: 3,
};

export type StoreError = {
  code: number;
  id: string;
  message: string;
};

export class StoreFetchError extends Error {
  code: number;
  id: string;
  type: 'fetch' | 'aborted' | 'timeout';

  constructor(error: StoreError, type: 'fetch' | 'aborted' | 'timeout') {
    super(error.message);
    this.name = 'StoreFetchError';
    this.code = error.code;
    this.id = error.id;
    this.type = type;
  }
}
