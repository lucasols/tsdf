import { deepEqual } from 't-state';
import {
  newTSDFListQueryStore,
  TSFDListQueryState,
} from '../../src/listQueryStore';
import { getCacheId } from '../../src/utils/getCacheId';
import { mockServerResource } from '../mocks/fetchMock';
import { pick } from './objectUtils';
import { normalizeError, StoreError } from './storeUtils';

type Row = {
  id: number;
  name: string;
  type?: string;
  archived?: boolean;
};

export type Tables = {
  [id: string]: Row[];
};

export type ListQueryParams = {
  tableId: string;
  filters?: { idIsGreaterThan?: number };
};

export type DefaultListQueryState = TSFDListQueryState<
  Row,
  StoreError,
  ListQueryParams
>;

export function createDefaultListQueryStore({
  initialServerData = {},
  useLoadedSnapshot,
  defaultQuerySize,
  debug,
  dynamicRTUThrottleMs,
  debugRequests: debuFetchs,
  emulateRTU,
}: {
  initialServerData?: Tables;
  useLoadedSnapshot?: {
    tables?: string[];
    items?: string[];
    queries?: ListQueryParams[];
  };
  defaultQuerySize?: number;
  dynamicRTUThrottleMs?: (duration: number) => number;
  debug?: never;
  debugRequests?: never;
  emulateRTU?: boolean;
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

  const listQueryStore = newTSDFListQueryStore<
    Row,
    StoreError,
    ListQueryParams
  >({
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

      return {
        items: result.map((item) => ({
          id: getItemId({ tableId, id: item.id }),
          data: item,
        })),
        hasMore,
      };
    },
    fetchItemFn: async (itemId) => {
      const result = await serverMock.fetch(itemId);

      if (Array.isArray(result)) {
        throw new Error('Invalid server response');
      }

      return result;
    },
    errorNormalizer: normalizeError,
    defaultQuerySize,
    getDynamicRealtimeThrottleMs: dynamicRTUThrottleMs,
    syncMutationsAndInvalidations: {
      syncItemAndQuery(itemId, query) {
        return query.tableId === itemId.split('||')[0];
      },
      syncQueries(query1, query2) {
        return query1.tableId === query2.tableId;
      },
    },
  });

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

    const state: DefaultListQueryState = {
      items: {},
      queries: {},
      itemQueries: {},
    };

    for (const [tableId, items] of Object.entries(initialServerData)) {
      const queryId = `[{"tableId":"${tableId}"}]`;

      if (!tablesToSnapshot.includes(tableId)) {
        continue;
      }

      state.queries[queryId] = {
        status: 'success',
        items: items.map((item) => getItemId({ tableId, id: item.id })),
        hasMore: false,
        payload: { tableId },
        wasLoaded: true,
        refetchOnMount: false,
        error: null,
      };

      for (const item of items) {
        state.items[getItemId({ tableId, id: item.id })] = item;
        state.itemQueries[getItemId({ tableId, id: item.id })] = {
          status: 'success',
          error: null,
          refetchOnMount: false,
          wasLoaded: true,
        };
      }
    }

    for (const query of useLoadedSnapshot.queries ?? []) {
      const queryId = getCacheId(query);

      const { tableId } = query;

      const items =
        initialServerData[query.tableId]?.filter((item) => {
          if (query.filters?.idIsGreaterThan) {
            return item.id > query.filters.idIsGreaterThan;
          }

          return true;
        }) ?? [];

      state.queries[queryId] = {
        status: 'success',
        items: items.map((item) => getItemId({ tableId, id: item.id })),
        hasMore: false,
        payload: query,
        wasLoaded: true,
        refetchOnMount: false,
        error: null,
      };

      for (const item of items) {
        state.items[getItemId({ tableId, id: item.id })] = item;
        state.itemQueries[getItemId({ tableId, id: item.id })] = {
          status: 'success',
          error: null,
          refetchOnMount: false,
          wasLoaded: true,
        };
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

        state.itemQueries[itemId] = {
          status: 'success',
          refetchOnMount: false,
          wasLoaded: true,
          error: null,
        };
        state.items[itemId] = itemData;
      }
    }

    listQueryStore.store.setState(state);
  }

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
