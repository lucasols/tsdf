import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { TSDFDocumentStore, TSDFUseDocumentReturn } from '../src/documentStore';
import { ServerMock } from './mocks/fetchMock';
import { sleep } from './utils/sleep';
import {
  createDefaultDocumentStore,
  DefaultDocStoreData as DefaultDocumentStoreData,
} from './utils/storeUtils';

const Component = ({
  store,
  testIdPrefix = '',
  onRender,
  returnRefetchingStatus,
  enableRefetchOnMount,
}: {
  store: TSDFDocumentStore<any, any>;
  testIdPrefix?: string;
  returnRefetchingStatus?: boolean;
  enableRefetchOnMount?: boolean;
  onRender?: (renderResult: Readonly<TSDFUseDocumentReturn<any, any>>) => void;
}) => {
  const selectionResult = store.useDocument({
    returnRefetchingStatus,
    disableRefetchOnMount: !enableRefetchOnMount,
  });

  onRender?.(selectionResult);

  return (
    <div>
      <div data-testid={`${testIdPrefix}status`}>{selectionResult.status}</div>
      <div data-testid={`${testIdPrefix}isLoading`}>
        {selectionResult.isLoading ? 'true' : 'false'}
      </div>
      <div data-testid={`${testIdPrefix}data`}>
        {JSON.stringify(selectionResult.data)}
      </div>
      <div data-testid={`${testIdPrefix}error`}>
        {selectionResult.error?.message}
      </div>
    </div>
  );
};

afterEach(() => {
  cleanup();
});

test('load data', async () => {
  const { serverMock, documentStore } = createDefaultDocumentStore();

  const { getByTestId, unmount } = render(<Component store={documentStore} />);

  expect(getByTestId('status').textContent).toBe('loading');
  expect(getByTestId('isLoading').textContent).toBe('true');
  expect(getByTestId('data').textContent).toBe('null');

  await sleep(serverMock.timeout + 5);

  expect(getByTestId('status').textContent).toBe('success');
  expect(getByTestId('isLoading').textContent).toBe('false');
  expect(getByTestId('data').textContent).toBe('{"hello":"world"}');

  unmount();
});

test('invalidate data', async () => {
  const { serverMock, documentStore } = createDefaultDocumentStore({
    storeWithInitialData: true,
  });

  const { getByTestId } = render(<Component store={documentStore} />);

  expect(getByTestId('data').textContent).toBe('{"hello":"world"}');

  serverMock.mutateData({ hello: 'was invalidated' });
  documentStore.invalidateData();

  await sleep(serverMock.timeout + 5);

  expect(getByTestId('data').textContent).toBe('{"hello":"was invalidated"}');
});

test('revalidation with multiple components do not trigger multiple fetchs', async () => {
  const { serverMock, documentStore } = createDefaultDocumentStore({
    storeWithInitialData: true,
  });

  const { getByTestId } = render(
    <>
      <Component store={documentStore} />
      <Component store={documentStore} />
      <Component store={documentStore} />
      <Component store={documentStore} />
      <Component store={documentStore} />
      <Component store={documentStore} />
      <Component store={documentStore} />
      <Component store={documentStore} />
      <Component store={documentStore} />
      <Component store={documentStore} />
      <Component store={documentStore} />
      <Component store={documentStore} />
      <Component store={documentStore} />
      <Component store={documentStore} />
      <Component store={documentStore} />
      <Component store={documentStore} />
      <Component store={documentStore} />
      <Component store={documentStore} />
      <Component store={documentStore} />
      <Component store={documentStore} />
      <Component store={documentStore} />
      <Component store={documentStore} />
      <Component store={documentStore} />
      <Component store={documentStore} />
      <Component store={documentStore} />
      <Component store={documentStore} />
      <Component store={documentStore} />
      <Component store={documentStore} testIdPrefix="check-" />
    </>,
  );

  act(() => {
    serverMock.mutateData({ hello: 'was invalidated' });
    documentStore.invalidateData();
  });

  await sleep(300);

  expect(getByTestId('check-data').textContent).toBe(
    '{"hello":"was invalidated"}',
  );

  expect(serverMock.numOfFetchs).toBe(1);
});

test('data selector', async () => {
  const { documentStore } = createDefaultDocumentStore({
    storeWithInitialData: true,
  });

  const Comp = () => {
    const data = documentStore.useDocument({
      selector: (data) => data?.hello,
    });

    return <div data-testid="selector-data">{data.data}</div>;
  };

  const { getByTestId } = render(<Comp />);

  expect(getByTestId('selector-data').textContent).toBe('world');
});

describe('disable', () => {
  test('disable initial fetch', async () => {
    const { serverMock, documentStore } = createDefaultDocumentStore();

    const Comp = () => {
      const data = documentStore.useDocument({
        disabled: true,
      });

      return (
        <div>
          <div data-testid="data">{data.data?.hello}</div>
          <div data-testid="status">{data.status}</div>
        </div>
      );
    };

    const { getByTestId } = render(<Comp />);

    await sleep(200);

    expect(getByTestId('data').textContent).toBe('');
    expect(getByTestId('status').textContent).toBe('idle');
    expect(serverMock.numOfFetchs).toBe(0);
  });

  test('disable then enable fetch', async () => {
    const { serverMock, documentStore } = createDefaultDocumentStore();

    const renders: any[] = [];

    const Comp = () => {
      const [disabled, setDisabled] = useState(true);

      const data = documentStore.useDocument({
        disabled,
      });

      renders.push({ data: data.data, status: data.status, disabled });

      return (
        <div>
          <div data-testid="data">{data.data?.hello}</div>
          <div data-testid="status">{data.status}</div>
          <button
            data-testid="toggle-disabled"
            onClick={() => setDisabled(!disabled)}
          >
            btn
          </button>
        </div>
      );
    };

    const { getByTestId } = render(<Comp />);

    await sleep(40);

    expect(serverMock.numOfFetchs).toBe(0);
    expect(renders).toMatchInlineSnapshot(`
      [
        {
          "data": null,
          "disabled": true,
          "status": "idle",
        },
      ]
    `);

    act(() => {
      fireEvent.click(getByTestId('toggle-disabled'));
    });

    await sleep(100);

    expect(serverMock.numOfFetchs).toBe(1);
    expect(renders).toMatchInlineSnapshot(`
      [
        {
          "data": null,
          "disabled": true,
          "status": "idle",
        },
        {
          "data": null,
          "disabled": false,
          "status": "loading",
        },
        {
          "data": {
            "hello": "world",
          },
          "disabled": false,
          "status": "success",
        },
      ]
    `);
  });
});

test('disableRefetchOnMount', async () => {
  const { serverMock, documentStore } = createDefaultDocumentStore({
    storeWithInitialData: false,
  });

  const renders: any[] = [];
  const comp2Renders: any[] = [];

  const Comp2 = () => {
    const data = documentStore.useDocument({
      disableRefetchOnMount: true,
    });

    comp2Renders.push({ data: data.data, status: data.status });

    return <div />;
  };

  const Comp = () => {
    const [mountComp2, setMountComp2] = useState(false);

    const data = documentStore.useDocument({
      disableRefetchOnMount: true,
    });

    renders.push({ data: data.data, status: data.status });

    useEffect(() => {
      if (data.status === 'success') {
        setMountComp2(true);
      }
    }, [data.status]);

    return <>{mountComp2 && <Comp2 />}</>;
  };

  render(<Comp />);

  await sleep(200);

  // loads the initial data
  expect(renders).toMatchInlineSnapshot(`
    [
      {
        "data": null,
        "status": "loading",
      },
      {
        "data": {
          "hello": "world",
        },
        "status": "success",
      },
      {
        "data": {
          "hello": "world",
        },
        "status": "success",
      },
    ]
  `);

  expect(serverMock.numOfFetchs).toBe(1);

  await sleep(200);

  expect(comp2Renders).toMatchInlineSnapshot(`
    [
      {
        "data": {
          "hello": "world",
        },
        "status": "success",
      },
    ]
  `);

  // does not refetch on mount
  expect(serverMock.numOfFetchs).toBe(1);
});

test('do not return refetchin status by default', async () => {
  const { serverMock, documentStore } = createDefaultDocumentStore({
    storeWithInitialData: true,
  });

  const renders: any[] = [];

  render(
    <Component
      store={documentStore}
      onRender={({ data, status }) => {
        renders.push([data.hello, status]);
      }}
    />,
  );

  act(() => {
    serverMock.mutateData({ hello: 'was invalidated' });
    documentStore.invalidateData();
  });

  await sleep(200);

  expect(renders).toMatchInlineSnapshot(`
    [
      [
        "world",
        "success",
      ],
      [
        "was invalidated",
        "success",
      ],
    ]
  `);
});

describe('action types', () => {
  test('action with optmistic update', async () => {
    const { serverMock, documentStore } = createDefaultDocumentStore({
      storeWithInitialData: true,
    });

    const renders: any[] = [];

    render(
      <Component
        store={documentStore}
        onRender={({ data, status }) => {
          renders.push([data.hello, status]);
        }}
      />,
    );

    act(() => {
      actionWithOptimisticUpdate(serverMock, documentStore, 'was updated');
    });

    await sleep(150);

    expect(renders).toMatchInlineSnapshot(`
      [
        [
          "world",
          "success",
        ],
        [
          "was updated",
          "success",
        ],
      ]
    `);
  });

  test('action with optmistic update and revalidation', async () => {
    const { serverMock, documentStore } = createDefaultDocumentStore({
      storeWithInitialData: true,
    });

    const renders: any[] = [];

    render(
      <Component
        returnRefetchingStatus
        store={documentStore}
        onRender={({ data, status }) => {
          renders.push([data.hello, status]);
        }}
      />,
    );

    act(() => {
      actionWithOptimisticUpdateAndRevalidation(
        serverMock,
        documentStore,
        'was updated',
      );
    });

    await sleep(150);

    expect(renders).toMatchInlineSnapshot(`
      [
        [
          "world",
          "success",
        ],
        [
          "was updated",
          "success",
        ],
        [
          "was updated",
          "refetching",
        ],
        [
          "was updated",
          "success",
        ],
      ]
    `);
  });

  test('action without optimistic update', async () => {
    const { serverMock, documentStore } = createDefaultDocumentStore({
      storeWithInitialData: true,
    });

    const renders: any[] = [];

    render(
      <Component
        store={documentStore}
        onRender={({ data, status }) => {
          renders.push([data.hello, status]);
        }}
      />,
    );

    act(() => {
      actionWithoutOptimisticUpdate(serverMock, documentStore, 'was updated');
    });

    await sleep(150);

    expect(renders).toMatchInlineSnapshot(`
      [
        [
          "world",
          "success",
        ],
        [
          "was updated",
          "success",
        ],
      ]
    `);
  });

  test('action with revalition and without optimistic update', async () => {
    const { serverMock, documentStore } = createDefaultDocumentStore({
      storeWithInitialData: true,
    });

    const renders: any[] = [];

    render(
      <Component
        store={documentStore}
        returnRefetchingStatus
        onRender={({ data, status }) => {
          renders.push([data.hello, status]);
        }}
      />,
    );

    act(() => {
      actionWithRevalidationAndWithoutOptimisticUpdate(
        serverMock,
        documentStore,
        'was updated',
      );
    });

    await sleep(150);

    expect(renders).toMatchInlineSnapshot(`
      [
        [
          "world",
          "success",
        ],
        [
          "world",
          "refetching",
        ],
        [
          "was updated",
          "success",
        ],
      ]
    `);
  });
});

test('rollback on error', async () => {
  const { serverMock, documentStore } = createDefaultDocumentStore({
    storeWithInitialData: true,
  });

  const renders: any[] = [];

  render(
    <Component
      store={documentStore}
      returnRefetchingStatus
      onRender={({ data, status, error }) => {
        renders.push([data.hello, status, error]);
      }}
    />,
  );

  act(() => {
    actionWithOptimisticUpdate(
      serverMock,
      documentStore,
      'was updated',
      'error',
    );
  });

  await sleep(200);

  expect(renders).toMatchInlineSnapshot(`
    [
      [
        "world",
        "success",
        null,
      ],
      [
        "was updated",
        "success",
        null,
      ],
      [
        "was updated",
        "refetching",
        null,
      ],
      [
        "world",
        "success",
        null,
      ],
    ]
  `);
});

async function actionWithOptimisticUpdate(
  serverMock: ServerMock<DefaultDocumentStoreData>,
  documentStore: TSDFDocumentStore<DefaultDocumentStoreData, any>,
  newText: string,
  error?: string,
) {
  const endMutation = documentStore.startMutation();

  documentStore.updateState((draftData) => {
    draftData.hello = newText;
  });

  try {
    const result = await serverMock.emulateMutation(
      { hello: newText },
      { emulateError: error },
    );

    endMutation();

    return result;
  } catch (e) {
    endMutation();

    documentStore.invalidateData();
    return false;
  }
}

async function actionWithOptimisticUpdateAndRevalidation(
  serverMock: ServerMock<DefaultDocumentStoreData>,
  documentStore: TSDFDocumentStore<DefaultDocumentStoreData, any>,
  newText: string,
) {
  const endMutation = documentStore.startMutation();

  documentStore.updateState((draftData) => {
    draftData.hello = newText;
  });

  try {
    const result = await serverMock.emulateMutation({ hello: newText });

    endMutation();

    return result;
  } catch (e) {
    endMutation();

    return false;
  } finally {
    documentStore.invalidateData();
  }
}

async function actionWithoutOptimisticUpdate(
  serverMock: ServerMock<DefaultDocumentStoreData>,
  documentStore: TSDFDocumentStore<DefaultDocumentStoreData, any>,
  newText: string,
) {
  const endMutation = documentStore.startMutation();

  try {
    const result = await serverMock.emulateMutation({ hello: newText });

    documentStore.updateState((draftData) => {
      draftData.hello = result.hello;
    });

    endMutation();

    return result;
  } catch (e) {
    endMutation();

    documentStore.invalidateData();
    return false;
  }
}

async function actionWithRevalidationAndWithoutOptimisticUpdate(
  serverMock: ServerMock<DefaultDocumentStoreData>,
  documentStore: TSDFDocumentStore<DefaultDocumentStoreData, any>,
  newText: string,
) {
  const endMutation = documentStore.startMutation();

  try {
    const result = await serverMock.emulateMutation({ hello: newText });

    endMutation();

    return result;
  } catch (e) {
    endMutation();

    return false;
  } finally {
    documentStore.invalidateData();
  }
}
