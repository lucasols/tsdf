import { useCallback, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  createCollectionStore,
  createDocumentStore,
  createListQueryStore,
  type StoreError,
} from '@src/main';

type ListQueryPayload = {
  tableId: 'users';
};

type UserRow = {
  id: number;
  name: string;
};

function normalizeError(error: Error): StoreError {
  return {
    code: 500,
    id: 'fixture-error',
    message: error.message,
  };
}

async function requestJson<T>(
  pageId: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('x-page-id', pageId);

  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const response = await fetch(path, {
    ...init,
    headers,
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

type ScenarioName = 'document' | 'collection' | 'list';

function getQueryParams(): {
  pageId: string;
  scenario: ScenarioName;
  storeId: string | null;
  sessionKey: string | null;
} {
  const searchParams = new URLSearchParams(window.location.search);
  const pageId =
    searchParams.get('pageId') ??
    `page-${Math.random().toString(36).slice(2, 8)}`;
  const scenario = (searchParams.get('scenario') ?? 'document') as ScenarioName;
  const storeId = searchParams.get('storeId');
  const sessionKey = searchParams.get('sessionKey');

  return {
    pageId,
    scenario,
    storeId,
    sessionKey,
  };
}

function FocusControls({
  logicalFocus,
  prefix,
  setLogicalFocus,
}: {
  logicalFocus: boolean;
  prefix: string;
  setLogicalFocus: (value: boolean) => void;
}) {
  return (
    <div>
      <div data-testid={`${prefix}-focus-state`}>
        {logicalFocus ? 'active' : 'background'}
      </div>
      <button
        data-testid={`${prefix}-focus-active`}
        onClick={() => setLogicalFocus(true)}
        type="button"
      >
        set active
      </button>
      <button
        data-testid={`${prefix}-focus-background`}
        onClick={() => setLogicalFocus(false)}
        type="button"
      >
        set background
      </button>
    </div>
  );
}

function useLogicalFocus(initialValue = true) {
  const [logicalFocus, setLogicalFocusState] = useState(initialValue);
  const focusRef = useRef(logicalFocus);
  focusRef.current = logicalFocus;

  const setLogicalFocus = useCallback((value: boolean) => {
    focusRef.current = value;
    setLogicalFocusState(value);
    window.dispatchEvent(new Event(value ? 'focus' : 'blur'));
  }, []);

  return {
    logicalFocus,
    focusRef,
    setLogicalFocus,
  };
}

type DocumentState = {
  value: number;
};

function DocumentScenario({
  pageId,
  storeId,
  sessionKey,
}: {
  pageId: string;
  storeId: string;
  sessionKey: string | false;
}) {
  const { logicalFocus, focusRef, setLogicalFocus } = useLogicalFocus();
  const [lastScheduleResult, setLastScheduleResult] = useState('idle');

  const [store] = useState(() =>
    createDocumentStore<DocumentState>({
      id: storeId,
      getSessionKey: () => sessionKey,
      fetchFn: (signal) =>
        requestJson<DocumentState>(pageId, '/api/document', { signal }),
      errorNormalizer: normalizeError,
      lowPriorityThrottleMs: 10_000,
      baseCoalescingWindowMs: 50,
      backgroundCoalescingWindowMultiplier: 3,
      dynamicRealtimeThrottleMs: () => 100,
      usesRealTimeUpdates: true,
      blockWindowClose: null,
      '~test': {
        getWindowIsFocused: () => focusRef.current,
      },
    }),
  );

  const document = store.useDocument({
    returnRefetchingStatus: true,
  });

  const currentValue = document.data?.value ?? 0;

  return (
    <section>
      <h1>Document</h1>
      <FocusControls
        logicalFocus={logicalFocus}
        prefix="document"
        setLogicalFocus={setLogicalFocus}
      />
      <div data-testid="document-value">
        {document.data ? String(document.data.value) : 'null'}
      </div>
      <div data-testid="document-status">{document.status}</div>
      <div data-testid="document-last-schedule-result">
        {lastScheduleResult}
      </div>
      <button
        data-testid="document-fetch-high"
        onClick={() => {
          setLastScheduleResult(store.scheduleFetch('highPriority'));
        }}
        type="button"
      >
        fetch high
      </button>
      <button
        data-testid="document-fetch-low"
        onClick={() => {
          setLastScheduleResult(store.scheduleFetch('lowPriority'));
        }}
        type="button"
      >
        fetch low
      </button>
      <button
        data-testid="document-mutate-optimistic"
        onClick={() => {
          const nextValue = currentValue + 1;

          void store.performMutation({
            optimisticUpdate: () => {
              store.updateState((draft) => {
                draft.value = nextValue;
              });
            },
            mutation: async () => {
              return requestJson<DocumentState>(
                pageId,
                '/api/document/mutate',
                {
                  method: 'POST',
                  body: JSON.stringify({ value: nextValue }),
                },
              );
            },
          });
        }}
        type="button"
      >
        optimistic mutate
      </button>
      <button
        data-testid="document-trigger-rtu"
        onClick={() => {
          void requestJson<DocumentState>(pageId, '/api/document/set', {
            method: 'POST',
            body: JSON.stringify({ value: 2 }),
          }).then(() => {
            store.invalidateData('realtimeUpdate');
          });
        }}
        type="button"
      >
        trigger rtu
      </button>
    </section>
  );
}

type CollectionItem = {
  name: string;
};

function CollectionScenario({
  pageId,
  storeId,
  sessionKey,
}: {
  pageId: string;
  storeId: string;
  sessionKey: string | false;
}) {
  const { logicalFocus, focusRef, setLogicalFocus } = useLogicalFocus();

  const [store] = useState(() =>
    createCollectionStore<CollectionItem, string>({
      id: storeId,
      getSessionKey: () => sessionKey,
      fetchFn: (payload, signal) =>
        requestJson<CollectionItem>(pageId, `/api/collection/${payload}`, {
          signal,
        }),
      errorNormalizer: normalizeError,
      lowPriorityThrottleMs: 10_000,
      baseCoalescingWindowMs: 50,
      backgroundCoalescingWindowMultiplier: 3,
      usesRealTimeUpdates: true,
      blockWindowClose: null,
      '~test': {
        getWindowIsFocused: () => focusRef.current,
      },
    }),
  );

  const item1 = store.useItem('item1', {
    returnRefetchingStatus: true,
  });

  return (
    <section>
      <h1>Collection</h1>
      <FocusControls
        logicalFocus={logicalFocus}
        prefix="collection"
        setLogicalFocus={setLogicalFocus}
      />
      <div data-testid="collection-item1-name">
        {item1.data?.name ?? 'null'}
      </div>
      <div data-testid="collection-item1-status">{item1.status}</div>
      <button
        data-testid="collection-item1-mutate"
        onClick={() => {
          void store.performMutation('item1', {
            optimisticUpdate: () => {
              store.updateItemState('item1', (draft) => {
                draft.name = 'Updated';
              });
            },
            mutation: async () => {
              return requestJson<CollectionItem>(
                pageId,
                '/api/collection/item1/mutate',
                {
                  method: 'POST',
                  body: JSON.stringify({ name: 'Updated' }),
                },
              );
            },
          });
        }}
        type="button"
      >
        mutate item1
      </button>
      <button
        data-testid="collection-trigger-rtu"
        onClick={() => {
          void requestJson<CollectionItem>(
            pageId,
            '/api/collection/item1/mutate',
            {
              method: 'POST',
              body: JSON.stringify({ name: 'Updated' }),
            },
          ).then(() => {
            store.invalidateItem('item1', 'realtimeUpdate');
          });
        }}
        type="button"
      >
        trigger rtu
      </button>
    </section>
  );
}

function ListScenario({
  pageId,
  storeId,
  sessionKey,
}: {
  pageId: string;
  storeId: string;
  sessionKey: string | false;
}) {
  const { logicalFocus, focusRef, setLogicalFocus } = useLogicalFocus();

  const [store] = useState(() =>
    createListQueryStore<UserRow, ListQueryPayload, string>({
      id: storeId,
      getSessionKey: () => sessionKey,
      fetchListFn: async (payload, size, { signal }) => {
        const searchParams = new URLSearchParams({
          tableId: payload.tableId,
          limit: String(size),
        });

        return requestJson<{
          items: Array<{ itemPayload: string; data: UserRow }>;
          hasMore: boolean;
        }>(pageId, `/api/list?${searchParams.toString()}`, { signal });
      },
      fetchItemFn: async (itemPayload, { signal, fields }) => {
        const [tableId, rowId] = itemPayload.split('||');
        const searchParams = new URLSearchParams();

        if (fields && fields.length > 0) {
          searchParams.set('fields', fields.join(','));
        }

        const suffix = searchParams.toString();
        const querySuffix = suffix ? `?${suffix}` : '';

        return requestJson<UserRow>(
          pageId,
          `/api/item/${tableId}/${rowId}${querySuffix}`,
          { signal },
        );
      },
      errorNormalizer: normalizeError,
      lowPriorityThrottleMs: 10_000,
      baseCoalescingWindowMs: 50,
      backgroundCoalescingWindowMultiplier: 3,
      defaultQuerySize: 10,
      usesRealTimeUpdates: true,
      optimisticListUpdates: [
        {
          queries: { tableId: 'users' },
          sort: {
            sortBy: (item) => item.name,
            order: 'asc',
          },
        },
      ],
      blockWindowClose: null,
      '~test': {
        getWindowIsFocused: () => focusRef.current,
      },
    }),
  );

  const query = store.useListQuery(
    { tableId: 'users' },
    {
      itemSelector: (_item, itemPayload) => itemPayload,
      returnRefetchingStatus: true,
    },
  );
  const user1 = store.useItem('users||1', {
    returnRefetchingStatus: true,
  });
  const user2 = store.useItem('users||2', {
    returnRefetchingStatus: true,
  });

  return (
    <section>
      <h1>List Query</h1>
      <FocusControls
        logicalFocus={logicalFocus}
        prefix="list"
        setLogicalFocus={setLogicalFocus}
      />
      <div data-testid="list-query-order">{query.items.join(',')}</div>
      <div data-testid="list-query-status">{query.status}</div>
      <div data-testid="list-item1-name">{user1.data?.name ?? 'null'}</div>
      <div data-testid="list-item2-name">{user2.data?.name ?? 'null'}</div>
      <button
        data-testid="list-mutate-user1"
        onClick={() => {
          void store.performMutation('users||1', {
            optimisticUpdate: () => {
              store.updateItemState('users||1', (draft) => {
                draft.name = 'Zoe';
              });
            },
            mutation: async () => {
              return requestJson<UserRow>(pageId, '/api/item/users/1/mutate', {
                method: 'POST',
                body: JSON.stringify({
                  patch: { name: 'Zoe' },
                }),
              });
            },
            getRelatedQueries: (payload) => payload.tableId === 'users',
          });
        }}
        type="button"
      >
        mutate user1
      </button>
      <button
        data-testid="list-trigger-rtu"
        onClick={() => {
          void requestJson<UserRow>(pageId, '/api/item/users/1/mutate', {
            method: 'POST',
            body: JSON.stringify({
              patch: { name: 'Zoe' },
            }),
          }).then(() => {
            store.invalidateQueryAndItems({
              queryPayload: { tableId: 'users' },
              itemPayload: 'users||1',
              type: 'realtimeUpdate',
            });
          });
        }}
        type="button"
      >
        trigger rtu
      </button>
    </section>
  );
}

function App() {
  const { pageId, scenario, storeId, sessionKey } = getQueryParams();
  const resolvedStoreId =
    storeId ?? `playwright-${scenario === 'list' ? 'list' : scenario}-sync`;
  const resolvedSessionKey =
    sessionKey === 'none' ? false : (sessionKey ?? 'playwright-session');

  return (
    <main>
      <div data-testid="page-id">{pageId}</div>
      <div data-testid="scenario">{scenario}</div>
      <div data-testid="store-id">{resolvedStoreId}</div>
      <div data-testid="session-key">
        {resolvedSessionKey === false ? 'none' : resolvedSessionKey}
      </div>
      {scenario === 'document' ? (
        <DocumentScenario
          pageId={pageId}
          storeId={resolvedStoreId}
          sessionKey={resolvedSessionKey}
        />
      ) : null}
      {scenario === 'collection' ? (
        <CollectionScenario
          pageId={pageId}
          storeId={resolvedStoreId}
          sessionKey={resolvedSessionKey}
        />
      ) : null}
      {scenario === 'list' ? (
        <ListScenario
          pageId={pageId}
          storeId={resolvedStoreId}
          sessionKey={resolvedSessionKey}
        />
      ) : null}
    </main>
  );
}

const container = document.getElementById('root');

if (!container) {
  throw new Error('Missing root container');
}

createRoot(container).render(<App />);
