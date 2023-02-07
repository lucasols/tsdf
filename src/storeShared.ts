import { FetchType } from './fetchOrquestrator';

export type TSDFStatus = 'loading' | 'error' | 'refetching' | 'success';

export type ValidPayload = number | string | Record<string, unknown>;

export type ValidStoreState = Record<string, unknown> | any[];

export const fetchTypePriority: Record<FetchType, number> = {
  lowPriority: 0,
  realtimeUpdate: 1,
  highPriority: 2,
};
