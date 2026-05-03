import { useEffect } from 'react';
import { contactListStore } from '../stores/contactListStore';
import { profileStore } from '../stores/profileStore';
import { projectStore } from '../stores/projectStore';
import { compactJson, type LogFn } from '../utils/activityLog';

export function useStoreEventLog(log: LogFn) {
  useEffect(() => {
    const unsubscribers = [
      profileStore.events.on('invalidateData', ({ payload }) => {
        log(`document invalidated with ${payload}`);
      }),
      profileStore.storeEvents.on('*', (event) => {
        log(`document ${event.type} ${compactJson(event.payload)}`);
      }),
      projectStore.events.on('invalidateData', ({ payload }) => {
        log(
          `collection invalidated ${payload.itemKey} with ${payload.priority}`,
        );
      }),
      projectStore.storeEvents.on('*', (event) => {
        log(`collection ${event.type} ${compactJson(event.payload)}`);
      }),
      contactListStore.events.on('*', (event) => {
        log(`list ${event.type} ${compactJson(event.payload)}`);
      }),
      contactListStore.storeEvents.on('*', (event) => {
        log(`list ${event.type} ${compactJson(event.payload)}`);
      }),
    ];

    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }, [log]);
}
