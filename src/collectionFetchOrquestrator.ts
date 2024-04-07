import {
  CreateFetchOrchestratorOptions,
  FetchOrchestrator,
  createFetchOrchestrator,
} from './fetchOrchestrator';

export function createCollectionFetchOrchestrator<T>(
  props: CreateFetchOrchestratorOptions<T>,
) {
  const fetchOrchestrators = new Map<string, FetchOrchestrator<T>>();

  function getFetchOrchestrator(key: string): FetchOrchestrator<T> {
    if (!fetchOrchestrators.has(key)) {
      fetchOrchestrators.set(key, createFetchOrchestrator(props));
    }

    return fetchOrchestrators.get(key)!;
  }

  function reset() {
    fetchOrchestrators.clear();
  }

  return {
    get: getFetchOrchestrator,
    reset,
  };
}
