import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { rc_number, rc_object, rc_parse, rc_string } from 'runcheck';
import {
  emitTSDFDebugLog,
  type TSDFBrowserTabsDebugOperation,
  type TSDFDebugLogger,
} from '../debug';
import {
  createBrowserTabsPriority,
  type BrowserTabsLeaderChangeDetails,
  type BrowserTabsTabStatusMessage,
  type BrowserTabsPriorityTimings,
} from './browserTabsPriority';

export type BrowserTabsStoreType =
  | 'presence'
  | 'document'
  | 'collection'
  | 'listQuery'
  | 'offline';
type BrowserTabsSessionKey = string | false;

export type BrowserTabsTransport = {
  postMessage: (message: unknown) => void;
  close: () => void;
};

export type BrowserTabsTransportFactory = (options: {
  channelName: string;
  onMessage: (message: unknown) => void;
}) => BrowserTabsTransport | null;

type BrowserTabsCoordinatorOptions<Message extends { kind: string }> = {
  storeType: BrowserTabsStoreType;
  storeKey: string;
  getSessionKey: () => BrowserTabsSessionKey;
  onMessage: (message: Message) => void;
  onSessionChange?: (
    sessionKey: BrowserTabsSessionKey,
    previousSessionKey: BrowserTabsSessionKey,
  ) => void;
  transportFactory?: BrowserTabsTransportFactory;
  debugLogger?: TSDFDebugLogger;
  tabId?: string;
};

export type BrowserTabsMessageMeta = {
  protocolVersion: 1;
  messageId: string;
  storeType: BrowserTabsStoreType;
  sessionKey: string;
  tabId: string;
  seq: number;
  sentAt: number;
};

type MessageWithoutMeta<Message extends { kind: string }> =
  Message extends unknown ? Omit<Message, keyof BrowserTabsMessageMeta> : never;

type BrowserTabsCoordinator<Message extends { kind: string }> = {
  enabled: boolean;
  tabId: string;
  isSessionActive: () => boolean;
  publish: (
    message: MessageWithoutMeta<Message>,
  ) => (Message & BrowserTabsMessageMeta) | null;
  close: () => void;
};

type BrowserTabsCoordinatorWithPriority<Message extends { kind: string }> = {
  coordinator: BrowserTabsCoordinator<Message>;
  priority: ReturnType<typeof createBrowserTabsPriority>;
};

const PROTOCOL_VERSION = 1 as const;
const CHANNEL_PREFIX = 'tsdf';

type RawBrowserTabsMessage = BrowserTabsMessageMeta & { kind: string };

const rawBrowserTabsMessageSchema = rc_object({
  protocolVersion: rc_number,
  messageId: rc_string,
  storeType: rc_string,
  sessionKey: rc_string,
  tabId: rc_string,
  seq: rc_number,
  sentAt: rc_number,
  kind: rc_string,
});

function getDefaultTransportFactory(): BrowserTabsTransportFactory {
  return ({ channelName, onMessage }) => {
    let channel: BroadcastChannel;
    try {
      channel = new BroadcastChannel(channelName);
    } catch {
      return null;
    }
    function handleMessage(event: MessageEvent<unknown>) {
      onMessage(event.data);
    }

    channel.addEventListener('message', handleMessage);

    return {
      postMessage(message) {
        channel.postMessage(message);
      },
      close() {
        channel.removeEventListener('message', handleMessage);
        channel.close();
      },
    };
  };
}

/** @internal */
export function createBrowserTabsCoordinator<Message extends { kind: string }>(
  options: BrowserTabsCoordinatorOptions<Message>,
): BrowserTabsCoordinator<Message> {
  const {
    storeType,
    storeKey,
    getSessionKey,
    onMessage,
    onSessionChange,
    transportFactory = getDefaultTransportFactory(),
  } = options;
  const debugLogger = import.meta.env.DEV ? options.debugLogger : undefined;
  const channelName = `${CHANNEL_PREFIX}:${storeType}:${storeKey}`;
  const tabId = options.tabId ?? createBrowserTabsTabId();
  let seq = 0;

  const lastSeenSeqByTab = new Map<string, number>();
  let currentSessionKey: BrowserTabsSessionKey | undefined;

  function logBrowserTabsOperation(
    level: 'log' | 'warn' | 'error',
    operation: TSDFBrowserTabsDebugOperation,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ): void {
    if (!import.meta.env.DEV) return;
    if (!debugLogger) return;

    emitTSDFDebugLog(debugLogger, {
      area: 'browser-tabs',
      level,
      message,
      operation,
      details: { channelName, storeKey, storeType, tabId, ...details },
    });
  }

  function refreshSessionKey(): BrowserTabsSessionKey {
    const nextSessionKey = getSessionKey();
    if (currentSessionKey === nextSessionKey) return nextSessionKey;

    const previousSessionKey = currentSessionKey;
    currentSessionKey = nextSessionKey;
    lastSeenSeqByTab.clear();

    if (previousSessionKey !== undefined) {
      if (import.meta.env.DEV) {
        logBrowserTabsOperation('log', 'session-change', 'session changed', {
          nextSessionKey,
          previousSessionKey,
        });
      }
      onSessionChange?.(nextSessionKey, previousSessionKey);
    }

    return nextSessionKey;
  }

  const transport = transportFactory({
    channelName,
    onMessage(rawMessage) {
      const localSessionKey = refreshSessionKey();
      if (localSessionKey === false) {
        if (import.meta.env.DEV) {
          logBrowserTabsOperation(
            'log',
            'receive-skipped',
            'received message while session is inactive',
            { reason: 'inactive-session' },
          );
        }
        return;
      }

      const message = parseSyncMessage(rawMessage, storeType);
      if (!message) {
        if (import.meta.env.DEV) {
          logBrowserTabsOperation('log', 'receive-skipped', 'ignored message', {
            reason: 'invalid-message',
          });
        }
        return;
      }
      if (message.sessionKey !== localSessionKey) {
        if (import.meta.env.DEV) {
          logBrowserTabsOperation('log', 'receive-skipped', 'ignored message', {
            messageId: message.messageId,
            messageKind: message.kind,
            reason: 'session-mismatch',
            remoteSessionKey: message.sessionKey,
          });
        }
        return;
      }
      if (message.tabId === tabId) {
        if (import.meta.env.DEV) {
          logBrowserTabsOperation('log', 'receive-skipped', 'ignored message', {
            messageId: message.messageId,
            messageKind: message.kind,
            reason: 'same-tab',
          });
        }
        return;
      }
      const lastSeenSeq = lastSeenSeqByTab.get(message.tabId);
      if (lastSeenSeq !== undefined && message.seq <= lastSeenSeq) {
        if (import.meta.env.DEV) {
          logBrowserTabsOperation('log', 'receive-skipped', 'ignored message', {
            lastSeenSeq,
            messageId: message.messageId,
            messageKind: message.kind,
            reason: 'stale-sequence',
            remoteTabId: message.tabId,
            seq: message.seq,
          });
        }
        return;
      }

      lastSeenSeqByTab.set(message.tabId, message.seq);
      if (import.meta.env.DEV) {
        logBrowserTabsOperation('log', 'receive', 'received message', {
          messageId: message.messageId,
          messageKind: message.kind,
          remoteTabId: message.tabId,
          seq: message.seq,
        });
      }
      onMessage(
        // WORKAROUND: parseSyncMessage validates the shared transport envelope before the generic message payload is forwarded to typed callbacks.
        __LEGIT_CAST__<Message, RawBrowserTabsMessage>(message),
      );
    },
  });
  if (import.meta.env.DEV) {
    logBrowserTabsOperation(
      transport === null ? 'warn' : 'log',
      transport === null ? 'transport-unavailable' : 'transport-open',
      transport === null
        ? 'browser-tab sync transport is unavailable'
        : 'browser-tab sync transport opened',
    );
  }

  return {
    enabled: transport !== null,
    tabId,
    isSessionActive() {
      return transport !== null && refreshSessionKey() !== false;
    },
    publish(message) {
      if (!transport) {
        if (import.meta.env.DEV) {
          logBrowserTabsOperation(
            'warn',
            'publish-skipped',
            'publish skipped because transport is unavailable',
            { messageKind: message.kind, reason: 'transport-unavailable' },
          );
        }
        return null;
      }
      const sessionKey = refreshSessionKey();
      if (sessionKey === false) {
        if (import.meta.env.DEV) {
          logBrowserTabsOperation(
            'log',
            'publish-skipped',
            'publish skipped because session is inactive',
            { messageKind: message.kind, reason: 'inactive-session' },
          );
        }
        return null;
      }

      const meta: BrowserTabsMessageMeta = {
        protocolVersion: PROTOCOL_VERSION,
        storeType,
        sessionKey,
        tabId,
        seq: ++seq,
        sentAt: Date.now(),
        messageId: `${tabId}:${seq}`,
      };
      const typedMessage =
        // WORKAROUND: The generic message type is reconstructed only after we attach the runtime transport metadata required by every cross-tab message.
        __LEGIT_CAST__<
          Message & BrowserTabsMessageMeta,
          MessageWithoutMeta<Message> & BrowserTabsMessageMeta
        >({ ...message, ...meta });

      transport.postMessage(typedMessage);
      if (import.meta.env.DEV) {
        logBrowserTabsOperation('log', 'publish', 'published message', {
          messageId: typedMessage.messageId,
          messageKind: typedMessage.kind,
          seq: typedMessage.seq,
        });
      }

      return typedMessage;
    },
    close() {
      lastSeenSeqByTab.clear();
      transport?.close();
      if (import.meta.env.DEV) {
        logBrowserTabsOperation('log', 'transport-close', 'transport closed');
      }
    },
  };
}

type BrowserTabsCoordinatorWithPriorityOptions<
  Message extends { kind: string },
> = BrowserTabsCoordinatorOptions<Message> & {
  getWindowIsFocused: () => boolean;
  onWindowFocusChange?: (handler: () => void) => () => void;
  priorityTimings?: BrowserTabsPriorityTimings;
};

/** @internal */
export function createBrowserTabsCoordinatorWithPriority<
  Message extends { kind: string },
>(
  options: BrowserTabsCoordinatorWithPriorityOptions<Message>,
): BrowserTabsCoordinatorWithPriority<Message> {
  const {
    storeType,
    storeKey,
    getSessionKey,
    onMessage,
    onSessionChange,
    transportFactory,
    tabId,
    getWindowIsFocused,
    onWindowFocusChange,
    priorityTimings,
  } = options;
  const debugLogger = import.meta.env.DEV ? options.debugLogger : undefined;
  const channelName = `${CHANNEL_PREFIX}:${storeType}:${storeKey}`;
  const priorityRef: {
    current: ReturnType<typeof createBrowserTabsPriority> | null;
  } = { current: null };
  const coordinator = createBrowserTabsCoordinator({
    storeType,
    storeKey,
    getSessionKey,
    onMessage,
    onSessionChange(sessionKey, previousSessionKey) {
      priorityRef.current?.reset();
      if (sessionKey !== false && coordinator.enabled) {
        priorityRef.current?.publishLocalStatus();
      }
      onSessionChange?.(sessionKey, previousSessionKey);
    },
    transportFactory,
    tabId,
    ...(import.meta.env.DEV ? { debugLogger: options.debugLogger } : undefined),
  });

  const priority = createBrowserTabsPriority({
    transportEnabled: coordinator.enabled,
    getIsEnabled: () => coordinator.isSessionActive(),
    tabId: coordinator.tabId,
    getWindowIsFocused,
    onWindowFocusChange,
    publishStatus: (status) => {
      coordinator.publish(
        // WORKAROUND: Priority status messages are only published by stores whose Message union includes this status shape.
        __LEGIT_CAST__<
          MessageWithoutMeta<Message>,
          BrowserTabsTabStatusMessage
        >(status),
      );
    },
    timings: priorityTimings,
    ...(import.meta.env.DEV
      ? {
          onLeaderChange(details: BrowserTabsLeaderChangeDetails) {
            if (!debugLogger) return;

            emitTSDFDebugLog(debugLogger, {
              area: 'browser-tabs',
              level: 'log',
              message: 'browser-tab sync leader changed',
              operation: 'leader-change',
              details: {
                channelName,
                storeKey,
                storeType,
                tabId: details.localTabId,
                ...details,
              },
            });
          },
        }
      : undefined),
  });
  priorityRef.current = priority;

  return { coordinator, priority };
}

export type BrowserTabsPresencePriority = {
  priority: ReturnType<typeof createBrowserTabsPriority>;
  tabId: string;
  close: () => void;
};

/** @internal */
export function createBrowserTabsPresencePriority(options: {
  getSessionKey: () => BrowserTabsSessionKey;
  getWindowIsFocused: () => boolean;
  onWindowFocusChange?: (handler: () => void) => () => void;
  transportFactory?: BrowserTabsTransportFactory;
  debugLogger?: TSDFDebugLogger;
  priorityTimings?: BrowserTabsPriorityTimings;
}): BrowserTabsPresencePriority {
  const priorityRef: {
    current: ReturnType<typeof createBrowserTabsPriority> | null;
  } = { current: null };
  const { coordinator, priority } = createBrowserTabsCoordinatorWithPriority<
    BrowserTabsMessageMeta & BrowserTabsTabStatusMessage
  >({
    storeType: 'presence',
    storeKey: 'manager',
    getSessionKey: options.getSessionKey,
    onMessage(message) {
      priorityRef.current?.onTabStatusMessage(message.tabId, message);
    },
    transportFactory: options.transportFactory,
    ...(import.meta.env.DEV ? { debugLogger: options.debugLogger } : undefined),
    getWindowIsFocused: options.getWindowIsFocused,
    onWindowFocusChange: options.onWindowFocusChange,
    priorityTimings: options.priorityTimings,
  });
  priorityRef.current = priority;

  return {
    priority,
    tabId: coordinator.tabId,
    close() {
      coordinator.close();
      priority.close();
    },
  };
}

function createBrowserTabsTabId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export type SnapshotConsistency = 'optimistic' | 'confirmed';

export type BrowserTabsSyncVersion = {
  consistency: SnapshotConsistency;
  sentAt: number;
  tabId: string;
  seq: number;
};

export function toBrowserTabsSyncVersion(
  meta: Pick<BrowserTabsMessageMeta, 'tabId' | 'seq' | 'sentAt'>,
  consistency: SnapshotConsistency,
): BrowserTabsSyncVersion {
  return { tabId: meta.tabId, seq: meta.seq, sentAt: meta.sentAt, consistency };
}

export function isBrowserTabsSyncVersionNewer(
  candidate: BrowserTabsSyncVersion,
  current: BrowserTabsSyncVersion | undefined,
): boolean {
  if (!current) return true;

  if (candidate.sentAt !== current.sentAt) {
    return candidate.sentAt > current.sentAt;
  }

  if (candidate.tabId !== current.tabId) {
    return candidate.tabId > current.tabId;
  }

  if (candidate.seq !== current.seq) {
    return candidate.seq > current.seq;
  }

  return (
    getConsistencyRank(candidate.consistency) >
    getConsistencyRank(current.consistency)
  );
}

function getConsistencyRank(consistency: SnapshotConsistency): number {
  return consistency === 'confirmed' ? 1 : 0;
}

function parseSyncMessage(
  message: unknown,
  storeType: BrowserTabsStoreType,
): RawBrowserTabsMessage | null {
  if (!message || typeof message !== 'object') return null;

  const result = rc_parse(message, rawBrowserTabsMessageSchema);
  if (!result.ok) return null;

  const value = result.value;
  if (
    value.protocolVersion !== PROTOCOL_VERSION ||
    value.storeType !== storeType
  ) {
    return null;
  }

  return Object.assign({}, message, value, {
    protocolVersion: PROTOCOL_VERSION,
    storeType,
  });
}
