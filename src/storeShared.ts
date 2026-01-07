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
