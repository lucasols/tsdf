import {
  rc_array,
  rc_literals,
  rc_number,
  rc_object,
  rc_string,
} from 'runcheck';
import { createDocumentStore } from 'tsdf';
import { apiClient } from '../apiClient';
import type { ProfileDocument } from '../apiTypes';
import {
  PLAYGROUND_DOCUMENT_STORAGE_ADAPTER,
  storeManager,
} from './storeManager';

const profileTagSchema = rc_object({ id: rc_string, label: rc_string });

const profileSchema = rc_object({
  name: rc_string,
  plan: rc_literals('Free', 'Pro', 'Team'),
  credits: rc_number,
  tags: rc_array(profileTagSchema),
  updatedAt: rc_string,
});

export const profileStore = createDocumentStore<ProfileDocument>({
  id: 'playground-profile',
  storeManager,
  fetchFn: (signal) => apiClient.fetchProfile(signal),
  usesRealTimeUpdates: true,
  persistentStorage: {
    adapter: PLAYGROUND_DOCUMENT_STORAGE_ADAPTER,
    schema: profileSchema,
  },
});

export function addLocalProfileTag(): boolean {
  return profileStore.updateState((draft) => {
    draft.tags.push({ id: 'tag-local', label: 'Local only' });
  });
}

export function renameProfile(name: string): Promise<unknown> {
  return profileStore.performMutation({
    optimisticUpdate(currentState) {
      if (!currentState) return false;

      profileStore.updateState((draft) => {
        draft.name = name;
      });
      return undefined;
    },
    mutation: () => apiClient.renameProfile(name),
    revalidateOnSuccess: true,
  });
}

export function addProfileCredits(amount: number): Promise<unknown> {
  return profileStore.performMutation({
    optimisticUpdate(currentState) {
      if (!currentState) return false;

      profileStore.updateState((draft) => {
        draft.credits += amount;
      });
      return undefined;
    },
    mutation: () => apiClient.addProfileCredits(amount),
    debounce: { context: 'profile-credit', payload: amount, ms: 300 },
    revalidateOnSuccess: true,
  });
}

export async function pushProfileTagFromServer(label: string): Promise<void> {
  await apiClient.addProfileTag(label);
  profileStore.invalidateData('realtimeUpdate');
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    profileStore.dispose();
  });
}
