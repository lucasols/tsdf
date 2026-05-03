import { realtimeEventSchema } from './apiTypes';
import { contactListStore } from './stores/contactListStore';
import { profileStore } from './stores/profileStore';
import { projectStore } from './stores/projectStore';
import { storeManager } from './stores/storeManager';

type RealtimeListener = (message: string) => void;

const listeners = new Set<RealtimeListener>();

let source: EventSource | null = null;
let connectionWasInterrupted = false;
let hasConnected = false;
let initialSyncWasTriggered = false;
let lastReconnectInvalidationAt = 0;

function emit(message: string): void {
  for (const listener of listeners) {
    listener(message);
  }
}

function invalidateAllStores(): void {
  profileStore.invalidateData('realtimeUpdate');
  projectStore.invalidateItem(() => true, 'realtimeUpdate');
  contactListStore.invalidateQueryAndItems({
    all: true,
    type: 'realtimeUpdate',
  });
}

function triggerInitialSync(): void {
  if (initialSyncWasTriggered) return;

  initialSyncWasTriggered = true;
  window.setTimeout(() => {
    storeManager.onTransportReconnect();
    emit('realtime initial sync');
  });
}

function handleRealtimeMessage(message: MessageEvent<string>): void {
  let rawEvent: unknown;

  try {
    rawEvent = JSON.parse(message.data) as unknown;
  } catch {
    emit('ignored invalid realtime event');
    return;
  }

  const parsed = realtimeEventSchema.safeParse(rawEvent);

  if (!parsed.success) {
    emit('ignored invalid realtime event');
    return;
  }

  const event = parsed.data;

  if (event.kind === 'profileChanged') {
    profileStore.invalidateData('realtimeUpdate');
    emit('realtime profile invalidation');
    return;
  }

  if (event.kind === 'projectChanged') {
    projectStore.invalidateItem(event.payload, 'realtimeUpdate');
    emit(
      `realtime project invalidation: ${event.payload.workspaceId}/${event.payload.projectId}`,
    );
    return;
  }

  if (event.kind === 'contactsChanged') {
    contactListStore.invalidateQueryAndItems({
      all: true,
      type: 'realtimeUpdate',
    });
    emit(
      event.itemId
        ? `realtime contacts invalidation: ${event.itemId}`
        : 'realtime contacts invalidation',
    );
    return;
  }

  invalidateAllStores();
  emit('realtime reset invalidation');
}

export function startRealtimeClient(): void {
  if (source) return;

  source = new EventSource('/api/events');

  source.onopen = () => {
    if (!hasConnected) {
      hasConnected = true;
      triggerInitialSync();
      emit('realtime transport connected');
      return;
    }

    if (connectionWasInterrupted) {
      const now = Date.now();

      if (now - lastReconnectInvalidationAt > 5_000) {
        storeManager.onTransportReconnect();
        lastReconnectInvalidationAt = now;
        emit('realtime transport reconnected');
      } else {
        emit('realtime reconnect ignored while fetches settle');
      }
    }

    connectionWasInterrupted = false;
  };

  source.onerror = () => {
    if (!connectionWasInterrupted) {
      emit('realtime transport disconnected');
    }

    connectionWasInterrupted = true;
  };

  source.onmessage = handleRealtimeMessage;
}

export function subscribeToRealtimeMessages(
  listener: RealtimeListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

startRealtimeClient();
