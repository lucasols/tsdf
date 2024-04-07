import {
  CreateFetchOrquestratorOptions as CreateFetchOrchestratorOptions,
  FetchOrquestrator as FetchOrchestrator,
  createFetchOrquestrator,
} from './fetchOrchestrator';

export function createCollectionFetchOrchestrator<T>(
  props: CreateFetchOrchestratorOptions<T>,
) {
  const fetchOrchestrators = new Map<string, FetchOrchestrator<T>>();

  function getFetchOrquestrator(key: string): FetchOrchestrator<T> {
    if (!fetchOrchestrators.has(key)) {
      fetchOrchestrators.set(key, createFetchOrquestrator(props));
    }

    return fetchOrchestrators.get(key)!;
  }

  function reset() {
    fetchOrchestrators.clear();
  }

  return {
    get: getFetchOrquestrator,
    reset,
  };
}
