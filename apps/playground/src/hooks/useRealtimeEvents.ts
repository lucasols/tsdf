import { useEffect } from 'react';
import { realtimeEventSchema } from '../apiTypes';
import { contactListStore } from '../stores/contactListStore';
import { profileStore } from '../stores/profileStore';
import { projectStore } from '../stores/projectStore';
import { storeManager } from '../stores/storeManager';
import type { LogFn } from '../utils/activityLog';

export function useRealtimeEvents(log: LogFn): void {
  useEffect(() => {
    const source = new EventSource('/api/events');
    let connectionWasInterrupted = false;

    source.onopen = () => {
      storeManager.onTransportReconnect();

      if (connectionWasInterrupted) {
        log('realtime transport reconnected');
      } else {
        log('realtime transport connected');
      }

      connectionWasInterrupted = false;
    };

    source.onerror = () => {
      connectionWasInterrupted = true;
      log('realtime transport disconnected');
    };

    source.onmessage = (message) => {
      const parsed = realtimeEventSchema.safeParse(JSON.parse(message.data));

      if (!parsed.success) {
        log('ignored invalid realtime event');
        return;
      }

      const event = parsed.data;

      if (event.kind === 'profileChanged') {
        profileStore.invalidateData('realtimeUpdate');
        log('realtime profile invalidation');
        return;
      }

      if (event.kind === 'projectChanged') {
        projectStore.invalidateItem(event.payload, 'realtimeUpdate');
        log(
          `realtime project invalidation: ${event.payload.workspaceId}/${event.payload.projectId}`,
        );
        return;
      }

      if (event.kind === 'contactsChanged') {
        contactListStore.invalidateQueryAndItems({
          all: true,
          type: 'realtimeUpdate',
        });
        log(
          event.itemId
            ? `realtime contacts invalidation: ${event.itemId}`
            : 'realtime contacts invalidation',
        );
        return;
      }

      profileStore.invalidateData('realtimeUpdate');
      projectStore.invalidateItem(() => true, 'realtimeUpdate');
      contactListStore.invalidateQueryAndItems({
        all: true,
        type: 'realtimeUpdate',
      });
      log('realtime reset invalidation');
    };

    return () => source.close();
  }, [log]);
}
