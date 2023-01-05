export type Status = 'loading' | 'refetching' | 'error' | 'success';

export type ValidFetchParams = number | string | null | Record<string, unknown>;

export type ValidStoreState = Record<string, unknown> | any[];
