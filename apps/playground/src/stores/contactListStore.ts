import { rc_literals, rc_object, rc_string } from 'runcheck';
import { createListQueryStore } from 'tsdf';
import { apiClient } from '../apiClient';
import {
  selectContactFields,
  type Contact,
  type ContactFilter,
} from '../apiTypes';
import {
  PLAYGROUND_LIST_QUERY_STORAGE_ADAPTER,
  storeManager,
} from './storeManager';

const contactSchema = rc_object({
  id: rc_string,
  name: rc_string.optionalKey(),
  email: rc_string.optionalKey(),
  team: rc_literals('design', 'engineering', 'product').optionalKey(),
  status: rc_literals('active', 'paused').optionalKey(),
  notes: rc_string.optionalKey(),
  updatedAt: rc_string.optionalKey(),
});

const contactFilterSchema = rc_object({
  team: rc_literals('all', 'design', 'engineering', 'product'),
  status: rc_literals('all', 'active', 'paused'),
});

export const contactListStore = createListQueryStore<
  Contact,
  ContactFilter,
  string,
  true,
  true
>({
  id: 'playground-contacts',
  storeManager,
  usesRealTimeUpdates: true,
  fetchListFn: (filter, pagination, { signal, fields }) =>
    apiClient.fetchContacts(filter, pagination, { signal, fields }),
  fetchItemFn: (id, { signal, fields }) =>
    apiClient.fetchContact(id, { signal, fields }),
  batchFetchItemFn: (requests, options) =>
    apiClient.batchFetchContacts(requests, options),
  getItemsBatchKey: () => 'contacts',
  maxItemBatchSize: 4,
  defaultQuerySize: 4,
  offsetPagination: { maxInvalidationLimit: 4, maxParallel: 2 },
  partialResources: {
    mergeItems: (prev, fetched) => ({ ...prev, ...fetched }),
    selectFields: (fields, item) => selectContactFields(item, fields),
  },
  optimisticListUpdates: [
    {
      queries: () => true,
      sort: { sortBy: (item) => item.name ?? item.id, order: 'asc' },
    },
  ],
  derivedQueries: {
    getQueryGroup: () => 'contacts',
    getItemGroup: () => 'contacts',
    isComplete: (_queryPayload, { queries }) =>
      queries.some(
        ({ payload, hasMore }) =>
          payload.team === 'all' && payload.status === 'all' && !hasMore,
      ),
    deriveQuery: (queryPayload, items, { fields }) => {
      if (Array.isArray(fields) && fields.includes('notes')) {
        return false;
      }

      return items
        .filter(({ data }) => {
          const teamMatches =
            queryPayload.team === 'all' || data.team === queryPayload.team;
          const statusMatches =
            queryPayload.status === 'all' ||
            data.status === queryPayload.status;

          return teamMatches && statusMatches;
        })
        .sort((a, b) =>
          (a.data.name ?? a.data.id).localeCompare(b.data.name ?? b.data.id),
        )
        .map(({ key }) => key);
    },
  },
  persistentStorage: {
    adapter: PLAYGROUND_LIST_QUERY_STORAGE_ADAPTER,
    schema: contactSchema,
    itemPayloadSchema: rc_string,
    queryPayloadSchema: contactFilterSchema,
  },
});

export function renameContact(id: string, name: string): Promise<unknown> {
  return contactListStore.performMutation(id, {
    optimisticUpdate() {
      contactListStore.updateItemState(id, (draft) => {
        draft.name = name;
      });
    },
    mutation: () => apiClient.renameContact(id, name),
    revalidateOnSuccess: { queries: () => true, items: true },
  });
}

export function toggleContactStatus(id: string): Promise<unknown> {
  return contactListStore.performMutation(id, {
    optimisticUpdate() {
      contactListStore.updateItemState(id, (draft) => {
        draft.status = draft.status === 'active' ? 'paused' : 'active';
      });
    },
    mutation: () => apiClient.toggleContactStatus(id),
    debounce: { context: 'contact-status-toggle', payload: id, ms: 250 },
    revalidateOnSuccess: { queries: () => true, items: true },
  });
}

export async function createContact(): Promise<Contact | null> {
  const result = await contactListStore.performMutation(null, {
    mutation: () => apiClient.createContact(),
    onSuccess(contact) {
      contactListStore.addItemToState(contact.id, contact, {
        addItemToQueries: { queries: () => true, appendTo: 'start' },
      });
    },
    revalidateOnSuccess: 'queries',
  });

  return result.ok ? result.value : null;
}

export function deleteContact(id: string): Promise<unknown> {
  return contactListStore.performMutation(id, {
    optimisticUpdate() {
      contactListStore.deleteItemState(id);
    },
    mutation: () => apiClient.deleteContact(id),
    revalidateOnSuccess: 'queries',
  });
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    contactListStore.dispose();
  });
}
