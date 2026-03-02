import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';

export type BrowserTabsStoreType = 'document' | 'collection' | 'listQuery';

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
  onMessage: (message: Message) => void;
  transportFactory?: BrowserTabsTransportFactory;
};

export type BrowserTabsMessageMeta = {
  protocolVersion: 1;
  messageId: string;
  storeType: BrowserTabsStoreType;
  tabId: string;
  seq: number;
  sentAt: number;
};

type RawBrowserTabsMessage = BrowserTabsMessageMeta & { kind: string };

type MessageWithoutMeta<Message extends { kind: string }> =
  Message extends unknown ? Omit<Message, keyof BrowserTabsMessageMeta> : never;

export type BrowserTabsCoordinator<Message extends { kind: string }> = {
  enabled: boolean;
  tabId: string;
  publish: (
    message: MessageWithoutMeta<Message>,
  ) => (Message & BrowserTabsMessageMeta) | null;
  close: () => void;
};

const PROTOCOL_VERSION = 1 as const;
const CHANNEL_PREFIX = 'tsdf-browser-tabs-v1';

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
  onMessage,
  transportFactory = getDefaultTransportFactory(),
}: BrowserTabsCoordinatorOptions<Message>): BrowserTabsCoordinator<Message> {
  const channelName = `${CHANNEL_PREFIX}:${storeType}:${storeKey}`;
  const tabId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  let seq = 0;

  const lastSeenSeqByTab = new Map<string, number>();
  const transport = transportFactory({
    channelName,
    onMessage(rawMessage) {
      const message = parseSyncMessage(rawMessage, storeType);
      if (!message) return;
      if (message.tabId === tabId) return;
      const lastSeenSeq = lastSeenSeqByTab.get(message.tabId);
      if (lastSeenSeq !== undefined && message.seq <= lastSeenSeq) return;

      lastSeenSeqByTab.set(message.tabId, message.seq);
      onMessage(__LEGIT_CAST__<Message, RawBrowserTabsMessage>(message));
    },
  });

  return {
    enabled: transport !== null,
    tabId,
    publish(message) {
      if (!transport) return null;

      const meta: BrowserTabsMessageMeta = {
        protocolVersion: PROTOCOL_VERSION,
        storeType,
        tabId,
        seq: ++seq,
        sentAt: Date.now(),
        messageId: `${tabId}:${seq}`,
      };
      const fullMessage = {
        ...message,
        ...meta,
      };
      type PublishedMessage = Message & BrowserTabsMessageMeta;
      type FullMessageShape = MessageWithoutMeta<Message> &
        BrowserTabsMessageMeta;
      const typedMessage = __LEGIT_CAST__<PublishedMessage, FullMessageShape>(
        fullMessage,
      );

      transport.postMessage(typedMessage);

      return typedMessage;
    },
    close() {
      lastSeenSeqByTab.clear();
      transport?.close();
    },
  };
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
  return {
    tabId: meta.tabId,
    seq: meta.seq,
    sentAt: meta.sentAt,
    consistency,
  };
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

type SyncMessageRecord = Record<string, unknown>;

function parseSyncMessage(
  message: unknown,
  storeType: BrowserTabsStoreType,
): RawBrowserTabsMessage | null {
  if (!message || typeof message !== 'object') return null;

  const value = __LEGIT_CAST__<SyncMessageRecord, unknown>(message);
  const isValid =
    value.protocolVersion === PROTOCOL_VERSION &&
    value.storeType === storeType &&
    typeof value.messageId === 'string' &&
    typeof value.tabId === 'string' &&
    typeof value.seq === 'number' &&
    typeof value.sentAt === 'number' &&
    typeof value.kind === 'string';

  if (!isValid) return null;

  return __LEGIT_CAST__<RawBrowserTabsMessage, SyncMessageRecord>(value);
}
