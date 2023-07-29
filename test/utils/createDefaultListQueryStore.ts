import { deepEqual } from 't-state';
import {
  ListQueryStoreInitialData,
  newTSDFListQueryStore,
  TSFDListQueryState,
} from '../../src/listQueryStore';
import { mockServerResource } from '../mocks/fetchMock';
import { normalizeError, StoreError } from './storeUtils';

type Row = {
  id: number;
  name: string;
  type?: 'admin' | 'user';
  archived?: boolean;
  age?: number;
};

export type Tables = {
  [id: string]: Row[];
};

export type ListQueryParams = {
  tableId: string;
  filters?: {
    idIsGreaterThan?: number;
    type?: 'admin' | 'user';
    archived?: boolean;
    ageRange?: [number, number];
  };
};

export type DefaultListQueryState = TSFDListQueryState<
  Row,
  StoreError,
  ListQueryParams,
  string
>;

export function createDefaultListQueryStore({
  initialServerData = {},
  useLoadedSnapshot,
  defaultQuerySize,
  debug,
  disableFetchItemFn,
  dynamicRTUThrottleMs,
  disableInitialDataInvalidation = false,
  debugRequests: debuFetchs,
  emulateRTU,
  optimisticListUpdates,
  disableSyncInvalidation,
}: {
  initialServerData?: Tables;
  useLoadedSnapshot?: {
    tables?: string[];
    items?: string[];
    queries?: ListQueryParams[];
  };
  disableFetchItemFn?: boolean;
  defaultQuerySize?: number;
  dynamicRTUThrottleMs?: (duration: number) => number;
  debug?: never;
  debugRequests?: never;
  disableInitialDataInvalidation?: boolean;
  emulateRTU?: boolean;
  disableSyncInvalidation?: boolean;

  optimisticListUpdates?: Parameters<
    typeof newTSDFListQueryStore<Row, any, ListQueryParams, string>
  >[0]['optimisticListUpdates'];
} = {}) {
  const serverMock = mockServerResource<Tables, Row[] | Row>({
    initialData: initialServerData,
    logFetchs: (debug as any) || (debuFetchs as any),
    fetchSelector: (data, param) => {
      if (param.includes('||')) {
        const [tableId, id] = param.split('||');

        const item = data?.[tableId!]?.find((item) => item.id === Number(id));

        if (!item) {
          return 'notFound';
        }

        return item;
      }

      return data?.[param] ?? 'notFound';
    },
  });

  function getItemId({ tableId, id }: { tableId: string; id: number }) {
    return `${tableId}||${id}`;
  }

  let initialData:
    | undefined
    | ListQueryStoreInitialData<Row, ListQueryParams, string> = undefined;

  if (useLoadedSnapshot) {
    const tablesToSnapshot = useLoadedSnapshot.tables ?? [];

    if (useLoadedSnapshot.tables) {
      const allIdsExist = tablesToSnapshot.every((tableId) =>
        initialServerData.hasOwnProperty(tableId),
      );

      if (!allIdsExist) {
        throw new Error(
          `loadTablesSnapshot: Some tableId doesn't exist in initialServerData`,
        );
      }
    }

    initialData = { queries: [], items: [] };

    for (const [tableId, items] of Object.entries(initialServerData)) {
      if (!tablesToSnapshot.includes(tableId)) {
        continue;
      }

      initialData.queries.push({
        payload: { tableId },
        hasMore: false,
        items: items.map((item) => getItemId({ tableId, id: item.id })),
      });

      for (const item of items) {
        initialData.items.push({
          payload: getItemId({ tableId, id: item.id }),
          data: item,
        });
      }
    }

    for (const query of useLoadedSnapshot.queries ?? []) {
      const { tableId } = query;

      const items =
        initialServerData[query.tableId]?.filter((item) => {
          if (query.filters?.idIsGreaterThan) {
            return item.id > query.filters.idIsGreaterThan;
          }

          if (query.filters?.type) {
            return item.type === query.filters.type;
          }

          if (query.filters?.archived) {
            return item.archived === query.filters.archived;
          }

          if (query.filters?.ageRange) {
            return (
              item.age! >= query.filters.ageRange[0]! &&
              item.age! <= query.filters.ageRange[1]!
            );
          }

          return true;
        }) ?? [];

      initialData.queries.push({
        payload: query,
        hasMore: false,
        items: items.map((item) => getItemId({ tableId, id: item.id })),
      });

      for (const item of items) {
        initialData.items.push({
          payload: getItemId({ tableId, id: item.id }),
          data: item,
        });
      }
    }

    if (useLoadedSnapshot.items) {
      for (const itemId of useLoadedSnapshot.items) {
        const itemData = initialServerData[itemId.split('||')[0]!]?.find(
          (item) => item.id === Number(itemId.split('||')[1]),
        );

        if (!itemData) {
          throw new Error(
            `loadItemsSnapshot: Item doesn't exist in initialServerData`,
          );
        }

        initialData.items.push({
          payload: itemId,
          data: itemData,
        });
      }
    }
  }

  const listQueryStore = newTSDFListQueryStore<
    Row,
    StoreError,
    ListQueryParams,
    string
  >({
    optimisticListUpdates,
    fetchListFn: async ({ tableId, filters }, size) => {
      let result = await serverMock.fetch(tableId);
      let hasMore = false;

      if (!Array.isArray(result)) {
        throw new Error('Invalid server response');
      }

      hasMore = result.length > size;
      result = result.slice(0, size);

      if (filters?.idIsGreaterThan) {
        result = result.filter((item) => item.id > filters.idIsGreaterThan!);
      }

      if (filters?.type) {
        result = result.filter((item) => item.type === filters.type!);
      }

      if (filters?.archived) {
        result = result.filter((item) => item.archived === filters.archived!);
      }

      if (filters?.ageRange) {
        result = result.filter(
          (item) =>
            item.age! >= filters.ageRange![0]! &&
            item.age! <= filters.ageRange![1]!,
        );
      }

      return {
        items: result.map((item) => ({
          itemPayload: getItemId({ tableId, id: item.id }),
          data: item,
        })),
        hasMore,
      };
    },
    fetchItemFn: disableFetchItemFn
      ? undefined
      : async (itemId) => {
          const result = await serverMock.fetch(itemId);

          if (Array.isArray(result)) {
            throw new Error('Invalid server response');
          }

          return result;
        },
    errorNormalizer: normalizeError,
    defaultQuerySize,
    getInitialData: () => initialData,
    disableInitialDataInvalidation,
    dynamicRealtimeThrottleMs: dynamicRTUThrottleMs,
    syncMutationsAndInvalidations: disableSyncInvalidation
      ? undefined
      : {
          syncItemAndQuery(itemId, query) {
            return query.tableId === itemId.split('||')[0];
          },
          syncQueries(query1, query2) {
            return query1.tableId === query2.tableId;
          },
        },
  });

  if (debug as any) {
    listQueryStore.store.subscribe(({ current }) => {
      // eslint-disable-next-line no-console
      console.log(serverMock.relativeTime(), current);
    });
  }

  function forceListUpdate(params: ListQueryParams) {
    const scheduleResult = listQueryStore.scheduleListQueryFetch(
      'highPriority',
      params,
    );

    if (scheduleResult !== 'started') {
      throw new Error(`error forceListUpdate: ${scheduleResult}`);
    }
  }

  if (emulateRTU) {
    serverMock.addOnUpdateServerData(({ prev, data }) => {
      for (const tableId of Object.keys(data)) {
        if (!deepEqual(prev[tableId], data[tableId])) {
          listQueryStore.invalidateQuery({ tableId }, 'realtimeUpdate');
        }
      }
    });
  }

  return {
    serverMock,
    store: listQueryStore,
    getItemId,
    forceListUpdate,
    shouldNotSkip(this: void, scheduleResult: any) {
      if (scheduleResult === 'skipped') {
        throw new Error('Should not skip');
      }
    },
  };
}
