import {
  ApiStoreUpdateManager,
  UpdateType,
} from '../src/updateManager/apiStoreUpdateManager';

// FIX: remove file

class ServerState {
  server: number;
  serverHistory: number[];
  startTime: number;
  actionsHistory: string[] = [];
  actionsTiming: number[] = [];
  websocketListeners: ((value: number) => void)[] = [];

  constructor(initialValue: number) {
    this.server = initialValue;
    this.serverHistory = [initialValue];
  }

  async apiFetch(ms: number) {
    const { server } = this;
    await sleep(ms);
    return server;
  }

  addAction(action: string) {
    this.actionsHistory.push(action);
    this.actionsTiming.push(Date.now() - this.startTime);
  }

  async apiMutation(value: number, ms = 300) {
    if (
      !this.actionsHistory.at(-1)?.startsWith(`optmistic/mutation-updated:`)
    ) {
      this.addAction(`mutation-started: ${value}`);
    }

    await sleep(ms);
    this.setSever(value);
    await sleep(50);
    this.addAction(`mutation-finished: ${value}`);
  }

  setSever(value: number) {
    this.serverHistory.push(value);

    setTimeout(() => {
      void this.websocketListeners.forEach((listener) => listener(value));
    }, 100);

    this.server = value;
  }
}

export class TestStore extends ServerState {
  uiHistory: number[];

  fetchs = 0;
  commits = 0;

  pageIsHidden = false;
  onPageIsVisible: (() => void) | undefined;
  private pageVisibility = {
    isHidden: () => this.pageIsHidden,
    onIsVisible: (callback: any) => {
      this.onPageIsVisible = callback;

      return callback;
    },
    removeOnIsVisible: (callback: any) => {
      this.onPageIsVisible = undefined;
    },
  };
  updatesManager = new ApiStoreUpdateManager(true, this.pageVisibility);

  constructor(
    initialValue: number,
    public autoUpdate: boolean,
    public skipAutoUpdate = false,
  ) {
    super(initialValue);

    this.uiHistory = [initialValue];
    this.startTime = Date.now();

    if (autoUpdate && !skipAutoUpdate) {
      this.websocketListeners.push((value) => {
        void this.fetch({ type: 'realtimeUpdate' });
      });
    }
  }

  setPageIsHidden(isHidden: boolean) {
    this.pageIsHidden = isHidden;

    if (!isHidden && this.onPageIsVisible) {
      this.onPageIsVisible();
    }
  }

  setUi(value: number) {
    if (this.uiHistory.at(-1) !== value) {
      this.uiHistory.push(value);
    }
  }

  optimisticUpdate(value: number) {
    this.addAction(`optmistic/mutation-updated: ${value}`);
    this.setUi(value);
  }

  startMutation() {
    return this.updatesManager.startMutation();
  }

  logActionsTimming() {
    console.info(
      this.actionsTiming.map((time, i) => [this.actionsHistory[i], time]),
    );
  }

  async fetch({ ms = 200, type }: { ms?: number; type: UpdateType }) {
    const fetchController = this.updatesManager.startFetch({
      updateType: type,
      retry: () => {
        void this.fetch({ ms, type });
      },
    });

    if (fetchController === 'skipFetch') {
      this.addAction(`fetch-skipped`);
      return;
    }

    this.addAction(`fetch-started`);
    this.fetchs++;

    const response = await this.apiFetch(ms);

    const commitUpdate = fetchController.onSuccess();

    if (commitUpdate === 'abort') {
      this.addAction(`ui-update-skipped: ${response}`);
    }
    else if (commitUpdate === 'schedule') {
      // discard update if mutation is in progress
      this.addAction(`ui-update-schedule: ${response}`);
    }
    else {
      this.commits++;
      this.setUi(response);
      this.addAction(`fetch-finished: ${response}`);
    }
  }
}

type MultiQueryState = { a: number; b: number };

class MultiQueryServer {
  server: MultiQueryState;
  websocketListeners: ((key: keyof MultiQueryState, value: number) => void)[] =
    [];
  actionsHistory: string[] = [];

  constructor(initialValue: MultiQueryState) {
    this.server = initialValue;
  }

  async apiFetch(ms: number) {
    const { server } = this;
    await sleep(ms);
    return server;
  }

  addAction(action: string) {
    this.actionsHistory.push(action);
  }

  async apiMutation(key: keyof MultiQueryState, value: number, ms = 300) {
    if (
      !this.actionsHistory.at(-1)?.startsWith(`optmistic/mutation-updated:`)
    ) {
      this.addAction(`mutation-started: ${value}`);
    }

    await sleep(ms);
    this.setSever(key, value);
    await sleep(50);
    this.addAction(`mutation-finished: ${value}`);
  }

  setSever(key: keyof MultiQueryState, value: number) {
    setTimeout(() => {
      void this.websocketListeners.forEach((listener) => listener(key, value));
    }, 100);

    this.server[key] = value;
  }
}

export class TestMultiQueryStore extends MultiQueryServer {
  uiHistory: MultiQueryState[];

  fetchs = 0;
  commits = 0;

  pageIsHidden = false;
  onPageIsVisible: (() => void) | undefined;
  private pageVisibility = {
    isHidden: () => this.pageIsHidden,
    onIsVisible: (callback: any) => {
      this.onPageIsVisible = callback;

      return callback;
    },
    removeOnIsVisible: (callback: any) => {
      this.onPageIsVisible = undefined;
    },
  };
  updatesManager = new ApiStoreUpdateManager(true, this.pageVisibility);

  constructor(
    initialUIValue: MultiQueryState,
    public autoUpdate: boolean,
    public skipAutoUpdate = false,
    initialServerValue = initialUIValue,
  ) {
    super(initialServerValue);

    this.uiHistory = [initialUIValue];

    if (autoUpdate && !skipAutoUpdate) {
      this.websocketListeners.push((value) => {
        void this.fetch({ type: 'realtimeUpdate', key: 'a' });
      });
    }
  }

  setPageIsHidden(isHidden: boolean) {
    this.pageIsHidden = isHidden;

    if (!isHidden && this.onPageIsVisible) {
      this.onPageIsVisible();
    }
  }

  setUi(key: keyof MultiQueryState, value: number) {
    const lastUi = this.uiHistory.at(-1)!;

    if (lastUi[key] !== value) {
      this.uiHistory.push({ ...lastUi, [key]: value });
    }
  }

  optimisticUpdate(key: keyof MultiQueryState, value: number) {
    this.addAction(`optmistic/mutation-updated: ${value}`);
    this.setUi(key, value);
  }

  startMutation() {
    return this.updatesManager.startMutation();
  }

  async fetch({
    ms = 200,
    key,
    type,
  }: {
    ms?: number;
    type: UpdateType;
    key: keyof MultiQueryState;
  }) {
    const fetchController = this.updatesManager.startFetch({
      updateType: type,
      fetchId: key,
      retry: () => {
        void this.fetch({ ms, type, key });
      },
    });

    if (fetchController === 'skipFetch') {
      this.addAction(`fetch-skipped`);
      return;
    }

    this.addAction(`fetch-started`);
    this.fetchs++;

    const response = await this.apiFetch(ms);

    const commitUpdate = fetchController.onSuccess();

    if (commitUpdate === 'abort') {
      this.addAction(`ui-update-skipped: ${response}`);
    }
    else if (commitUpdate === 'schedule') {
      // discard update if mutation is in progress
      this.addAction(`ui-update-schedule: ${response}`);
    }
    else {
      this.commits++;
      this.setUi(key, response[key]);
      this.addAction(`fetch-finished: ${response}`);
    }
  }
}

export async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function delay(ms: number, promise: () => Promise<any>) {
  return new Promise<void>((resolve) =>
    setTimeout(() => {
      void promise().then(() => {
        resolve();
      });
    }, ms),
  );
}
