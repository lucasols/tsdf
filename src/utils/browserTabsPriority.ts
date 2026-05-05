export type BrowserTabsPriorityTimings = {
  backgroundCoalescingDelayMs?: number;
  fetchLeaseMs?: number | ((lastFetchDuration: number) => number);
};

export type BrowserTabsTabStatusMessage = {
  kind: 'tab-status';
  isFocused: boolean;
  lastFocusedAt: number;
  lastPresenceAt: number;
};

type PresenceState = {
  tabId: string;
  isFocused: boolean;
  lastFocusedAt: number;
  lastPresenceAt: number;
};

export type BrowserTabsLeaderPresence = {
  tabId: string;
  isFocused: boolean;
  lastFocusedAt: number;
  lastPresenceAt: number;
};

export type BrowserTabsLeaderChangeDetails = {
  isLocalLeader: boolean;
  leaderTabId: string;
  liveTabs: readonly BrowserTabsLeaderPresence[];
  localRank: number;
  localTabId: string;
  reason: 'local-focus' | 'local-status' | 'priority-read' | 'remote-status';
};

type BrowserTabsRemoteLeaseState = {
  ownerTabId: string;
  startedAt: number;
  expiresAt: number;
};

export type BrowserTabsPriority = {
  publishLocalStatus: () => void;
  noteLocalFocusState: () => void;
  getPriorityRank: () => number;
  getCoalescingWindowMs: (baseCoalescingWindowMs: number) => number;
  onTabStatusMessage: (
    remoteTabId: string,
    message: BrowserTabsTabStatusMessage,
  ) => void;
  noteRemoteFetchStart: (
    targetKey: string,
    remoteTabId: string,
    startedAt: number,
    lastFetchDuration: number,
  ) => BrowserTabsRemoteLeaseState;
  noteRemoteFetchSuccess: (
    targetKey: string,
    remoteTabId: string,
    startedAt: number,
    duration: number,
  ) => void;
  getRemoteLeaseState: (
    targetKey: string,
  ) => BrowserTabsRemoteLeaseState | null;
  clearRemoteLease: (targetKey: string) => void;
  reset: () => void;
  close: () => void;
};

const DEFAULT_FETCH_LEASE_MS = 10_000;
const DEFAULT_BACKGROUND_COALESCING_DELAY_MS = 3_000;
const COALESCING_WINDOW_STEP_MS = 1_000;

/** @internal */
export function createBrowserTabsPriority(
  transportEnabled: boolean,
  getIsEnabled: () => boolean,
  tabId: string,
  getWindowIsFocused: () => boolean,
  onWindowFocusChange: ((handler: () => void) => () => void) | undefined,
  publishStatus: (status: BrowserTabsTabStatusMessage) => void,
  timings: BrowserTabsPriorityTimings | undefined,
  onLeaderChange:
    | ((details: BrowserTabsLeaderChangeDetails) => void)
    | undefined,
): BrowserTabsPriority {
  const knownTabs = new Map<string, PresenceState>();
  const remoteFetchLeases = new Map<string, BrowserTabsRemoteLeaseState>();
  let lastLeaderTabId: string | undefined;

  const localPresence: PresenceState = {
    tabId,
    isFocused: getWindowIsFocused(),
    lastFocusedAt: getWindowIsFocused() ? Date.now() : 0,
    lastPresenceAt: Date.now(),
  };

  function resolveFetchLeaseMs(lastFetchDuration: number): number {
    const configuredLeaseMs = timings?.fetchLeaseMs;

    if (typeof configuredLeaseMs === 'function') {
      return Math.max(0, configuredLeaseMs(lastFetchDuration));
    }

    if (typeof configuredLeaseMs === 'number') {
      return Math.max(0, configuredLeaseMs);
    }

    return Math.max(lastFetchDuration * 3, DEFAULT_FETCH_LEASE_MS);
  }

  function pruneExpiredRemoteLeases(): void {
    const now = Date.now();

    for (const [targetKey, lease] of remoteFetchLeases) {
      if (lease.expiresAt <= now) {
        remoteFetchLeases.delete(targetKey);
      }
    }
  }

  function getRankedLiveTabs(): PresenceState[] {
    if (!getIsEnabled()) {
      return [localPresence];
    }

    return [localPresence, ...knownTabs.values()].sort((a, b) => {
      if (a.isFocused !== b.isFocused) {
        return a.isFocused ? -1 : 1;
      }

      if (a.lastFocusedAt !== b.lastFocusedAt) {
        return b.lastFocusedAt - a.lastFocusedAt;
      }

      if (a.lastPresenceAt !== b.lastPresenceAt) {
        return b.lastPresenceAt - a.lastPresenceAt;
      }

      if (a.tabId === b.tabId) return 0;
      return a.tabId > b.tabId ? -1 : 1;
    });
  }

  function reportLeaderChange(
    reason: BrowserTabsLeaderChangeDetails['reason'],
    tabs = getRankedLiveTabs(),
  ): void {
    if (!import.meta.env.DEV) return;
    if (!onLeaderChange) return;

    const leader = tabs[0];
    if (!leader) return;
    if (leader.tabId === lastLeaderTabId) return;

    lastLeaderTabId = leader.tabId;
    const localTabIndex = tabs.findIndex(
      (presence) => presence.tabId === tabId,
    );

    onLeaderChange({
      isLocalLeader: leader.tabId === tabId,
      leaderTabId: leader.tabId,
      liveTabs: tabs.map((presence) => ({ ...presence })),
      localRank: localTabIndex >= 0 ? localTabIndex + 1 : 1,
      localTabId: tabId,
      reason,
    });
  }

  function publishLocalStatus(): void {
    if (!getIsEnabled()) return;

    noteLocalFocusState();
    localPresence.lastPresenceAt = Date.now();

    publishStatus({
      kind: 'tab-status',
      isFocused: localPresence.isFocused,
      lastFocusedAt: localPresence.lastFocusedAt,
      lastPresenceAt: localPresence.lastPresenceAt,
    });
    if (import.meta.env.DEV) {
      reportLeaderChange('local-status');
    }
  }

  function noteLocalFocusState(): void {
    const isFocused = getWindowIsFocused();
    if (isFocused === localPresence.isFocused) return;

    localPresence.isFocused = isFocused;
    localPresence.lastPresenceAt = Date.now();

    if (isFocused) {
      localPresence.lastFocusedAt = localPresence.lastPresenceAt;
    }

    if (!getIsEnabled()) return;

    publishStatus({
      kind: 'tab-status',
      isFocused: localPresence.isFocused,
      lastFocusedAt: localPresence.lastFocusedAt,
      lastPresenceAt: localPresence.lastPresenceAt,
    });
    if (import.meta.env.DEV) {
      reportLeaderChange('local-focus');
    }
  }

  function getPriorityRank(): number {
    if (!getIsEnabled()) return 1;

    const tabs = getRankedLiveTabs();
    if (import.meta.env.DEV) {
      reportLeaderChange('priority-read', tabs);
    }
    const localTabIndex = tabs.findIndex(
      (presence) => presence.tabId === tabId,
    );
    return localTabIndex >= 0 ? localTabIndex + 1 : 1;
  }

  function getCoalescingRank(): number {
    const tabs = getRankedLiveTabs();
    if (import.meta.env.DEV) {
      reportLeaderChange('priority-read', tabs);
    }
    const localTabIndex = tabs.findIndex(
      (presence) => presence.tabId === tabId,
    );
    if (localTabIndex < 0) return 0;

    if (tabs[localTabIndex]?.isFocused) return localTabIndex;

    const hasFocusedTab = tabs.some((presence) => presence.isFocused);
    return hasFocusedTab ? localTabIndex : localTabIndex + 1;
  }

  function getCoalescingWindowMs(baseCoalescingWindowMs: number): number {
    if (baseCoalescingWindowMs <= 0) return baseCoalescingWindowMs;

    const coalescingRank = getCoalescingRank();
    if (coalescingRank <= 0) return baseCoalescingWindowMs;

    return (
      baseCoalescingWindowMs +
      Math.max(
        0,
        timings?.backgroundCoalescingDelayMs ??
          DEFAULT_BACKGROUND_COALESCING_DELAY_MS,
      ) +
      (coalescingRank - 1) * COALESCING_WINDOW_STEP_MS
    );
  }
  function onTabStatusMessage(
    remoteTabId: string,
    message: BrowserTabsTabStatusMessage,
  ): void {
    if (!getIsEnabled()) return;

    const previousPresence = knownTabs.get(remoteTabId);
    if (
      previousPresence &&
      message.lastPresenceAt < previousPresence.lastPresenceAt
    ) {
      return;
    }

    knownTabs.set(remoteTabId, {
      tabId: remoteTabId,
      isFocused: message.isFocused,
      lastFocusedAt: message.lastFocusedAt,
      lastPresenceAt: message.lastPresenceAt,
    });
    if (import.meta.env.DEV) {
      reportLeaderChange('remote-status');
    }
  }

  function noteRemoteFetchStart(
    targetKey: string,
    remoteTabId: string,
    startedAt: number,
    lastFetchDuration: number,
  ): BrowserTabsRemoteLeaseState {
    const lease = {
      ownerTabId: remoteTabId,
      startedAt,
      expiresAt: startedAt + resolveFetchLeaseMs(lastFetchDuration),
    };
    if (!getIsEnabled()) return lease;

    pruneExpiredRemoteLeases();

    remoteFetchLeases.set(targetKey, lease);
    return lease;
  }

  function noteRemoteFetchSuccess(
    targetKey: string,
    remoteTabId_: string,
    startedAt: number,
    duration_: number,
  ): void {
    if (!getIsEnabled()) return;

    void remoteTabId_;
    void duration_;
    pruneExpiredRemoteLeases();

    const currentLease = remoteFetchLeases.get(targetKey);
    if (!currentLease) return;
    if (currentLease.startedAt > startedAt) return;

    remoteFetchLeases.delete(targetKey);
  }

  function getRemoteLeaseState(
    targetKey: string,
  ): BrowserTabsRemoteLeaseState | null {
    if (!getIsEnabled()) return null;

    pruneExpiredRemoteLeases();
    return remoteFetchLeases.get(targetKey) ?? null;
  }

  function clearRemoteLease(targetKey: string): void {
    remoteFetchLeases.delete(targetKey);
  }

  function reset(): void {
    remoteFetchLeases.clear();
  }

  let cleanupFocusListeners: (() => void) | undefined;

  if (transportEnabled) {
    publishLocalStatus();

    if (onWindowFocusChange) {
      cleanupFocusListeners = onWindowFocusChange(() => {
        noteLocalFocusState();
      });
    } else if (typeof window !== 'undefined') {
      function onFocusOrBlur() {
        noteLocalFocusState();
      }

      window.addEventListener('focus', onFocusOrBlur);
      window.addEventListener('blur', onFocusOrBlur);
      cleanupFocusListeners = () => {
        window.removeEventListener('focus', onFocusOrBlur);
        window.removeEventListener('blur', onFocusOrBlur);
      };
    }
  }

  return {
    publishLocalStatus,
    noteLocalFocusState,
    getPriorityRank,
    getCoalescingWindowMs,
    onTabStatusMessage,
    noteRemoteFetchStart,
    noteRemoteFetchSuccess,
    getRemoteLeaseState,
    clearRemoteLease,
    reset,
    close(): void {
      cleanupFocusListeners?.();
      reset();
      knownTabs.clear();
    },
  };
}
