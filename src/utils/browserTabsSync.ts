import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { rc_number, rc_object, rc_parse, rc_string } from 'runcheck';

import {
  createBrowserTabsPriority,
  type BrowserTabsTabStatusMessage,
  type BrowserTabsPriorityTimings,
} from './browserTabsPriority';

export type BrowserTabsStoreType = 'document' | 'collection' | 'listQuery';
export type BrowserTabsSessionKey = string | false;

export type BrowserTabsTransport = {
  postMessage: (message: unknown) => void;
  close: () => void;
};

export type BrowserTabsTransportFactory = (options: {
  channelName: string;
  onMessage: (message: unknown) => void;
}) => BrowserTabsTransport | null;

export type BrowserTabsCoordinatorOptions<Message extends { kind: string }> = {
  storeType: BrowserTabsStoreType;
  storeKey: string;
  getSessionKey: () => BrowserTabsSessionKey;
  onMessage: (message: Message) => void;
  onSessionChange?: (
    sessionKey: BrowserTabsSessionKey,
    previousSessionKey: BrowserTabsSessionKey,
  ) => void;
  transportFactory?: BrowserTabsTransportFactory;
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

export type BrowserTabsCoordinator<Message extends { kind: string }> = {
  enabled: boolean;
  tabId: string;
  isSessionActive: () => boolean;
  publish: (
    message: MessageWithoutMeta<Message>,
  ) => (Message & BrowserTabsMessageMeta) | null;
  close: () => void;
};

const PROTOCOL_VERSION = 1 as const;
const CHANNEL_PREFIX = 'tsdf-browser-tabs-v1';

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

export function createBrowserTabsCoordinator<Message extends { kind: string }>({
  storeType,
  storeKey,
  getSessionKey,
  onMessage,
  onSessionChange,
  transportFactory = getDefaultTransportFactory(),
}: BrowserTabsCoordinatorOptions<Message>): BrowserTabsCoordinator<Message> {
  const channelName = `${CHANNEL_PREFIX}:${storeType}:${storeKey}`;
  const tabId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  let seq = 0;

  const lastSeenSeqByTab = new Map<string, number>();
  let currentSessionKey: BrowserTabsSessionKey | undefined;

  function refreshSessionKey(): BrowserTabsSessionKey {
    const nextSessionKey = getSessionKey();
    if (currentSessionKey === nextSessionKey) return nextSessionKey;

    const previousSessionKey = currentSessionKey;
    currentSessionKey = nextSessionKey;
    lastSeenSeqByTab.clear();

    if (previousSessionKey !== undefined) {
      onSessionChange?.(nextSessionKey, previousSessionKey);
    }

    return nextSessionKey;
  }

  const transport = transportFactory({
    channelName,
    onMessage(rawMessage) {
      const localSessionKey = refreshSessionKey();
      if (localSessionKey === false) return;

      const message = parseSyncMessage(rawMessage, storeType);
      if (!message) return;
      if (message.sessionKey !== localSessionKey) return;
      if (message.tabId === tabId) return;
      const lastSeenSeq = lastSeenSeqByTab.get(message.tabId);
      if (lastSeenSeq !== undefined && message.seq <= lastSeenSeq) return;

      lastSeenSeqByTab.set(message.tabId, message.seq);
      onMessage(
        // WORKAROUND: parseSyncMessage validates the shared transport envelope before the generic message payload is forwarded to typed callbacks.
        __LEGIT_CAST__<Message, RawBrowserTabsMessage>(message),
      );
    },
  });

  return {
    enabled: transport !== null,
    tabId,
    isSessionActive() {
      return transport !== null && refreshSessionKey() !== false;
    },
    publish(message) {
      if (!transport) return null;
      const sessionKey = refreshSessionKey();
      if (sessionKey === false) return null;

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

      return typedMessage;
    },
    close() {
      lastSeenSeqByTab.clear();
      transport?.close();
    },
  };
}

export type BrowserTabsCoordinatorWithPriorityOptions<
  Message extends { kind: string },
> = BrowserTabsCoordinatorOptions<Message> & {
  getWindowIsFocused: () => boolean;
  onWindowFocusChange?: (handler: () => void) => () => void;
  priorityTimings?: BrowserTabsPriorityTimings;
};

export function createBrowserTabsCoordinatorWithPriority<
  Message extends { kind: string },
>({
  storeType,
  storeKey,
  getSessionKey,
  onMessage,
  onSessionChange,
  transportFactory,
  getWindowIsFocused,
  onWindowFocusChange,
  priorityTimings,
}: BrowserTabsCoordinatorWithPriorityOptions<Message>) {
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
  });
  priorityRef.current = priority;

  return { coordinator, priority };
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
