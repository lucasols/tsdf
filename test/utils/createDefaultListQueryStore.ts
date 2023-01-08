import {
  newTSDFListQueryStore,
  TSFDListQueryState,
} from '../../src/listQueryStore';
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

type FetchListParams = { tableId: string };

export type DefaultListQueryState = TSFDListQueryState<
  Row,
  StoreError,
  FetchListParams
>;

export function createDefaultListQueryStore({
  initialServerData = {},
  loadLoadedTablesSnapshot: initializedWithLoaded,
  defaultQuerySize,
  loadLoadedItemsSnapshot: initializeWithItemsLoaded,
  debug,
}: {
  initialServerData?: Tables;
  loadLoadedTablesSnapshot?: string | string[];
  loadLoadedItemsSnapshot?: string[];
  defaultQuerySize?: number;
  debug?: never;
} = {}) {
  const serverMock = mockServerResource<Tables, Row[] | Row>({
    initialData: initialServerData,
    logFetchs: debug,
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
    FetchListParams
  >({
    fetchListFn: async ({ tableId }, size) => {
      let result = await serverMock.fetch(tableId);
      let hasMore = false;

      if (!Array.isArray(result)) {
        throw new Error('Invalid server response');
      }

      hasMore = result.length > size;
      result = result.slice(0, size);

      return {
        items: result.map((item) => ({
          id: getItemId({ tableId, id: item.id }),
          data: item,
        })),
        hasMore,
      };
    },
    fetchItemFn: async (itemId) => {
      const result = await serverMock.fetch(itemId!);

      if (Array.isArray(result)) {
        throw new Error('Invalid server response');
      }

      return result;
    },
    errorNormalizer: normalizeError,
    defaultQuerySize,
  });

  if (initializedWithLoaded || initializeWithItemsLoaded) {
    const tablesToSnapshot = initializedWithLoaded
      ? Array.isArray(initializedWithLoaded)
        ? initializedWithLoaded
        : [initializedWithLoaded]
      : [];

    if (initializedWithLoaded) {
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

    if (initializeWithItemsLoaded) {
      for (const itemId of initializeWithItemsLoaded) {
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

  function forceListUpdate(params: FetchListParams) {
    const scheduleResult = listQueryStore.scheduleListQueryFetch(
      'highPriority',
      params,
    );

    if (scheduleResult !== 'started') {
      throw new Error(`error forceListUpdate: ${scheduleResult}`);
    }
  }

  return { serverMock, listQueryStore, getItemId, forceListUpdate };
}
