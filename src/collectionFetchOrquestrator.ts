import {
    createFetchOrquestrator,
    CreateFetchOrquestratorOptions,
    FetchOrquestrator,
} from './fetchOrchestrator';

export function createCollectionFetchOrchestrator<T>(
  props: CreateFetchOrquestratorOptions<T>,
) {
  const fetchOrquestrators = new Map<string, FetchOrquestrator<T>>();

  function getFetchOrquestrator(key: string): FetchOrquestrator<T> {
    if (!fetchOrquestrators.has(key)) {
      fetchOrquestrators.set(key, createFetchOrquestrator(props));
    }

    return fetchOrquestrators.get(key)!;
  }

  function reset() {
    fetchOrquestrators.clear();
  }

  return {
    get: getFetchOrquestrator,
    reset,
  };
}
