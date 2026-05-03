import { useEffect } from 'react';
import { subscribeToRealtimeMessages } from '../realtimeClient';
import type { LogFn } from '../utils/activityLog';

export function useRealtimeEvents(log: LogFn): void {
  useEffect(() => {
    return subscribeToRealtimeMessages(log);
  }, [log]);
}
