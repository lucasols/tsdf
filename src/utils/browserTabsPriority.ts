export type BrowserTabsPriorityTimings = {
  heartbeatMs?: number;
  presenceTtlMs?: number;
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

export type BrowserTabsRemoteLeaseState = {
  ownerTabId: string;
  startedAt: number;
  expiresAt: number;
};

export type BrowserTabsPriorityOptions = {
  enabled: boolean;
  tabId: string;
  getWindowIsFocused: () => boolean;
  publishStatus: (status: BrowserTabsTabStatusMessage) => void;
  timings?: BrowserTabsPriorityTimings;
};

const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_PRESENCE_TTL_MS = 15_000;
const DEFAULT_FETCH_LEASE_MS = 10_000;

export function createBrowserTabsPriority({
  enabled,
  tabId,
  getWindowIsFocused,
  publishStatus,
  timings,
}: BrowserTabsPriorityOptions) {
  const knownTabs = new Map<string, PresenceState>();
  const remoteFetchLeases = new Map<string, BrowserTabsRemoteLeaseState>();

  const localPresence: PresenceState = {
    tabId,
    isFocused: getWindowIsFocused(),
    lastFocusedAt: getWindowIsFocused() ? Date.now() : 0,
    lastPresenceAt: Date.now(),
  };

  const heartbeatMs = timings?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const presenceTtlMs = timings?.presenceTtlMs ?? DEFAULT_PRESENCE_TTL_MS;

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

  function pruneStaleTabs(): void {
    const now = Date.now();

    for (const [remoteTabId, presence] of knownTabs) {
      if (now - presence.lastPresenceAt > presenceTtlMs) {
        knownTabs.delete(remoteTabId);
      }
    }
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
    pruneStaleTabs();

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

  function publishLocalStatus(): void {
    if (!enabled) return;

    noteLocalFocusState();
    localPresence.lastPresenceAt = Date.now();

    publishStatus({
      kind: 'tab-status',
      isFocused: localPresence.isFocused,
      lastFocusedAt: localPresence.lastFocusedAt,
      lastPresenceAt: localPresence.lastPresenceAt,
    });
  }

  function noteLocalFocusState(): void {
    const isFocused = getWindowIsFocused();
    if (isFocused === localPresence.isFocused) return;

    localPresence.isFocused = isFocused;
    localPresence.lastPresenceAt = Date.now();

    if (isFocused) {
      localPresence.lastFocusedAt = localPresence.lastPresenceAt;
    }

    if (!enabled) return;

    publishStatus({
      kind: 'tab-status',
      isFocused: localPresence.isFocused,
      lastFocusedAt: localPresence.lastFocusedAt,
      lastPresenceAt: localPresence.lastPresenceAt,
    });
  }

  function getPriorityRank(): number {
    const tabs = getRankedLiveTabs();
    const index = tabs.findIndex((presence) => presence.tabId === tabId);
    return index >= 0 ? index + 1 : 1;
  }

  function onTabStatusMessage(
    remoteTabId: string,
    message: BrowserTabsTabStatusMessage,
  ): void {
    if (!enabled) return;

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
  }

  function noteRemoteFetchStart(
    targetKey: string,
    remoteTabId: string,
    startedAt: number,
    lastFetchDuration: number,
  ): BrowserTabsRemoteLeaseState {
    pruneExpiredRemoteLeases();

    const lease = {
      ownerTabId: remoteTabId,
      startedAt,
      expiresAt: startedAt + resolveFetchLeaseMs(lastFetchDuration),
    };

    remoteFetchLeases.set(targetKey, lease);
    return lease;
  }

  function noteRemoteFetchSuccess(
    targetKey: string,
    remoteTabId_: string,
    startedAt: number,
    duration_: number,
  ): void {
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
  let heartbeatInterval: ReturnType<typeof setInterval> | undefined;

  const shouldRunHeartbeat =
    enabled &&
    heartbeatMs > 0 &&
    (!import.meta.env.TEST || timings?.heartbeatMs !== undefined);

  if (enabled) {
    publishLocalStatus();

    if (shouldRunHeartbeat) {
      heartbeatInterval = setInterval(() => {
        publishLocalStatus();
      }, heartbeatMs);
    }

    if (typeof window !== 'undefined') {
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
    onTabStatusMessage,
    noteRemoteFetchStart,
    noteRemoteFetchSuccess,
    getRemoteLeaseState,
    clearRemoteLease,
    reset,
    close() {
      cleanupFocusListeners?.();
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
      }
      reset();
      knownTabs.clear();
    },
  };
}
