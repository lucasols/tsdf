/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import { deepEqual, Store } from 't-state';
import {
    CollectionInitialStateItem,
    newTSDFCollectionStore,
    TSDFCollectionStore,
    TSFDCollectionState,
} from '../../src/collectionStore';
import { newTSDFDocumentStore } from '../../src/documentStore';
import { filterAndMap } from '../../src/utils/filterAndMap';
import { isObject } from '../../src/utils/isObject';
import { clampMin } from '../../src/utils/math';
import { mockServerResource } from '../mocks/fetchMock';
import { arrayWithPrevAndIndex } from './arrayUtils';
import { omit, pick } from './objectUtils';

export type StoreError = {
  message: string;
};

export function normalizeError(exception: unknown): StoreError {
  if (exception instanceof Error) {
    return {
      message: exception.message,
    };
  }

  return {
    message: String(exception),
  };
}

export type DefaultDocStoreData = {
  hello: string;
};

export function createDefaultDocumentStore({
  initialServerData: serverHello = 'world',
  useLoadedSnapshot,
  emulateRTU,
  dynamicRTUThrottleMs,
  disableInitialDataInvalidation = false,
  debug,
}: {
  initialServerData?: string;
  useLoadedSnapshot?: boolean;
  disableInitialDataInvalidation?: boolean;
  debug?: never;
  emulateRTU?: boolean;
  dynamicRTUThrottleMs?: (duration: number) => number;
} = {}) {
  const serverMock = mockServerResource<DefaultDocStoreData>({
    initialData: { hello: serverHello },
    logFetches: debug,
  });

  const store = newTSDFDocumentStore({
    fetchFn: serverMock.fetchWitoutSelector,
    getInitialData: () => (useLoadedSnapshot ? { hello: 'world' } : undefined),
    errorNormalizer: normalizeError,
    dynamicRealtimeThrottleMs: dynamicRTUThrottleMs,
    disableInitialDataInvalidation,
  });

  const startTime = Date.now();

  function getElapsedTime() {
    return Date.now() - startTime;
  }

  if (debug as any) {
    store.store.subscribe(({ current }) => {
      // eslint-disable-next-line no-console
      console.log(serverMock.relativeTime(), current);
    });
  }

  if (emulateRTU) {
    serverMock.addOnUpdateServerData(({ prev, data }) => {
      if (!deepEqual(prev, data)) {
        store.invalidateData('realtimeUpdate');
      }
    });
  }

  return { serverMock, store, getElapsedTime };
}

export type Todo = {
  title: string;
  completed: boolean;
  description?: string;
};

type ServerData = Record<string, Todo | null>;

export type DefaultCollectionState = TSFDCollectionState<
  Todo,
  string,
  StoreError
>;

export type DefaultCollectionStore = TSDFCollectionStore<
  Todo,
  StoreError,
  string
>;

export function createDefaultCollectionStore<
  Payload extends { id: { id: string } } | string = string,
>({
  initialServerData: serverInitialData = {
    '1': { title: 'todo', completed: false },
  },
  useLoadedSnapshot,
  randomTimeout,
  emulateRTU,
  disableInitialDataInvalidation = false,
  dynamicRTUThrottleMs,
  lowPriorityThrottleMs,
  debug,
}: {
  initialServerData?: ServerData;
  useLoadedSnapshot?: boolean;
  dynamicRTUThrottleMs?: (duration: number) => number;
  emulateRTU?: boolean;
  /** default: 30-100 */
  randomTimeout?: true;
  lowPriorityThrottleMs?: number;
  disableInitialDataInvalidation?: boolean;
  debug?: never;
} = {}) {
  const serverMock = mockServerResource<ServerData, Todo>({
    initialData: serverInitialData,
    randomTimeout,
    logFetches: debug,
    fetchSelector(data, params) {
      let payload = params.startsWith('{"id":"')
        ? (JSON.parse(params) as { id: { id: string } })
        : params;

      if (isObject(payload)) {
        payload = payload.id.id;
      }

      const todo: any = data && data[params];

      if (!todo) {
        throw new Error('Not found');
      }

      return todo;
    },
  });

  let initialStateItems:
    | undefined
    | CollectionInitialStateItem<Payload, Todo>[] = undefined;

  if (useLoadedSnapshot) {
    initialStateItems = [];

    for (const [id, todo] of Object.entries(serverInitialData)) {
      if (!todo) continue;

      initialStateItems.push({
        data: todo,
        payload: id as Payload,
      });
    }
  }

  const collectionStore = newTSDFCollectionStore<Todo, StoreError, Payload>({
    fetchFn: async (payload) => {
      return serverMock.fetch(
        typeof payload === 'object' ? JSON.stringify(payload) : String(payload),
      );
    },
    errorNormalizer: normalizeError,
    lowPriorityThrottleMs,
    dynamicRealtimeThrottleMs: dynamicRTUThrottleMs,
    disableInitialDataInvalidation,
    getInitialData: () => initialStateItems,
  });

  const startTime = Date.now();

  function getElapsedTime() {
    return Date.now() - startTime;
  }

  const renderResults: any[] = [];

  function onRender(renderResult: any) {
    renderResults.push(renderResult);
  }

  if (debug as any) {
    collectionStore.store.subscribe(({ current }) => {
      // eslint-disable-next-line no-console
      console.log(serverMock.relativeTime(), current);
    });
  }

  if (emulateRTU) {
    serverMock.addOnUpdateServerData(({ prev, data }) => {
      for (const tableId of Object.keys(data)) {
        if (!deepEqual(prev[tableId], data[tableId])) {
          collectionStore.invalidateItem(tableId as Payload, 'realtimeUpdate');
        }
      }
    });
  }

  return {
    serverMock,
    store: collectionStore,
    getElapsedTime,
    onRender,
    renderResults,
    shouldNotSkip(this: void, scheduleResult: any) {
      if (scheduleResult === 'skipped') {
        throw new Error('Should not skip');
      }
    },
  };
}

export function shouldNotSkip(scheduleResult: any) {
  if (scheduleResult === 'skipped') {
    throw new Error('Should not skip');
  }
}

export function createRenderLogger({
  filterKeys: defaultFilterKeys,
  rejectKeys: defaultRejectKeys,
}: {
  filterKeys?: string[];
  rejectKeys?: string[];
} = {}) {
  let renders: Record<string, unknown>[] = [];
  let rendersTime: number[] = [];
  let startTime = Date.now();
  let onNextRender: () => void = () => {};

  function reset(keepLastRender = false) {
    renders = keepLastRender ? [renders.at(-1)!] : [];
    rendersTime = [];
    startTime = Date.now();
  }

  function add(
    render: Record<string, unknown> | readonly Record<string, unknown>[],
  ) {
    if (!isObject(render)) {
      for (const [i, r] of render.entries()) {
        renders.push({
          i: i + 1,
          ...r,
        });
        rendersTime.push(Date.now() - startTime);
      }
    } else {
      renders.push(render);
      rendersTime.push(Date.now() - startTime);
    }

    onNextRender();

    if (renders.length > 100) {
      throw new Error('Too many renders');
    }
  }

  function renderCount() {
    return renders.filter((item) => !item._lastSnapshotMark).length;
  }

  async function waitNextRender(timeout = 50) {
    return new Promise<void>((resolve) => {
      const timeoutId = setTimeout(() => {
        throw new Error('Timeout');
      }, timeout);

      onNextRender = () => {
        clearTimeout(timeoutId);
        resolve();
      };
    });
  }

  function getSnapshot({
    arrays = { firstNItems: 1 },
    changesOnly = true,
    filterKeys = defaultFilterKeys,
    rejectKeys = defaultRejectKeys,
    includeLastSnapshotEndMark = true,
  }: {
    arrays?: 'all' | 'firstAndLast' | 'lenght' | { firstNItems: number };
    changesOnly?: boolean;
    filterKeys?: string[];
    rejectKeys?: string[];
    includeLastSnapshotEndMark?: boolean;
  } = {}) {
    let rendersToUse = renders;

    if (changesOnly || filterKeys || rejectKeys) {
      rendersToUse = [];

      for (let { item, prev } of arrayWithPrevAndIndex(renders)) {
        if (item._lastSnapshotMark || item._mark) {
          rendersToUse.push(item);
          continue;
        }

        if (filterKeys) {
          prev = prev && pick(prev, filterKeys);
          item = pick(item, filterKeys);
        }

        if (rejectKeys) {
          prev = prev && omit(prev, rejectKeys);
          item = omit(item, rejectKeys);
        }

        if (!deepEqual(prev, item)) {
          rendersToUse.push(item);
        }
      }
    }

    renders.push({ _lastSnapshotMark: true });

    return `\n${filterAndMap(rendersToUse, (render, ignore, i) => {
      if (render._lastSnapshotMark) {
        if (includeLastSnapshotEndMark && i !== rendersToUse.length - 1) {
          return '---';
        } else {
          return ignore;
        }
      }

      if (render._mark) {
        let mark = `\n>>> ${String(render._mark)}`;

        const nextRender = rendersToUse[i + 1];

        if (nextRender && !nextRender._mark && !nextRender._lastSnapshotMark) {
          mark = `${mark}\n`;
        }

        return mark;
      }

      let line = '';

      for (const [key, _value] of Object.entries(render)) {
        let value = _value;

        if (Array.isArray(value)) {
          if (arrays === 'lenght') {
            value = `Array(${value.length})`;
          } else if (arrays === 'firstAndLast' && value.length > 2) {
            const intermediateSize = clampMin(value.length - 2, 0);

            value = [
              value[0],
              `...(${intermediateSize} between)`,
              value.at(-1),
            ];
          } else if (typeof arrays === 'object' && value.length > 2) {
            value = [
              ...value.slice(0, arrays.firstNItems),
              `...(${value.length - arrays.firstNItems} more)`,
            ];
          }
        }

        if (value === '') {
          value = `''`;
        }

        if (typeof value === 'object' && value !== null) {
          value = JSON.stringify(value).replace(/"/g, '').replace(/,/g, ', ');
        }

        line += `${key}: ${value} -- `;
      }

      line = line.slice(0, -4);
      return line;
    }).join('\n')}\n`;
  }

  function addMark(label: string) {
    add({ _mark: label });
  }

  return {
    add,
    reset,
    getSnapshot,
    waitNextRender,
    get changesSnapshot() {
      return getSnapshot({ changesOnly: true });
    },
    get snapshot() {
      return getSnapshot({ changesOnly: false });
    },
    renderCount,
    get rendersTime() {
      return rendersTime;
    },
    addMark,
  };
}

export function createValueStore<T>(initialValue: T) {
  const store = new Store({
    state: { value: initialValue },
  });

  return {
    store,
    useValue() {
      return store.useSelector((state) => state.value);
    },
    set(value: T) {
      store.setState({ value });
    },
  };
}

function formatArray(
  type: 'all' | { firstNItems: number } | 'length',
  array: any[],
): string {
  if (type === 'length') {
    return `Array(${array.length})`;
  }

  const normalizedItems: string[] = [];

  for (const item of array) {
    if (isObject(item)) {
      normalizedItems.push(`{${formatObject(item, type)}}`);
    } else {
      normalizedItems.push(String(item));
    }

    if (
      typeof type === 'object' &&
      normalizedItems.length >= type.firstNItems
    ) {
      normalizedItems.push(`...(${array.length - type.firstNItems} more)`);
      break;
    }
  }

  return `[${normalizedItems.join(', ')}]`;
}

function formatObject(obj: Record<string, any>, arrayType: any): string {
  return Object.keys(obj)
    .map((key) => {
      let value = obj[key];

      if (Array.isArray(value)) {
        value = formatArray(arrayType, value);
      }

      if (isObject(value)) {
        value = JSON.stringify(value)
          .replace(/"/g, '')
          .replace(/,/g, ', ')
          .replace(/:/g, ': ');
      }

      return `${key}: ${value}`;
    })
    .join(', ');
}

export function simplifyArraySnapshot(
  array: any[],
  arrayType: 'all' | { firstNItems: number } | 'length' = { firstNItems: 4 },
) {
  const result = array
    .map((item) => {
      if (isObject(item)) {
        return formatObject(item, arrayType);
      }

      if (Array.isArray(item)) {
        return formatArray(arrayType, item);
      }

      return String(item);
    })
    .join('\n');

  return `\n${result}\n`;
}

export function waitElapsedTime() {
  const startTime = Date.now();

  return (waitUntil: number) => {
    return new Promise<void>((resolve) => {
      const timeoutId = setTimeout(
        () => {
          clearTimeout(timeoutId);
          resolve();
        },
        waitUntil - (Date.now() - startTime),
      );
    });
  };
}
