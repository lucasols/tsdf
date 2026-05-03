import { useSyncExternalStore } from 'react';

export type ApiFetchCall = {
  id: number;
  method: string;
  path: string;
  startedAt: number;
  status: 'pending' | 'success' | 'error';
  durationMs?: number;
  errorStatus?: string;
};

const subscribers = new Set<() => void>();

let apiFetchCalls: ApiFetchCall[] = [];

function emit(): void {
  for (const subscriber of subscribers) {
    subscriber();
  }
}

function subscribe(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

function getSnapshot(): ApiFetchCall[] {
  return apiFetchCalls;
}

export function startApiFetchCall(call: Omit<ApiFetchCall, 'status'>): void {
  apiFetchCalls = [{ ...call, status: 'pending' }, ...apiFetchCalls];
  emit();
}

export function finishApiFetchCall(
  id: number,
  result: { status: 'success' } | { status: 'error'; errorStatus: string },
): void {
  apiFetchCalls = apiFetchCalls.map((call) =>
    call.id === id
      ? {
          ...call,
          ...result,
          durationMs: Math.max(0, Date.now() - call.startedAt),
        }
      : call,
  );
  emit();
}

export function useApiFetchCalls(): ApiFetchCall[] {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function useApiFetchCount(): number {
  return useApiFetchCalls().length;
}
