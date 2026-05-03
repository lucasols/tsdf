import {
  setTypedFetchGlobalDefaults,
  typedFetch,
  type TypedFetchLogger,
} from '@ls-stack/typed-fetch';
import { finishApiFetchCall, startApiFetchCall } from './apiFetchCounter';
import {
  contactBatchResponseSchema,
  contactListResponseSchema,
  contactSchema,
  deleteContactResponseSchema,
  profileSchema,
  projectBatchResponseSchema,
  projectSchema,
  type Contact,
  type ContactBatchResponse,
  type ContactFilter,
  type ContactListResponse,
  type DeleteContactResponse,
  type ProfileDocument,
  type Project,
  type ProjectBatchResponse,
  type ProjectPayload,
} from './apiTypes';

const apiHost = window.location.origin;

const playgroundApiLogger: TypedFetchLogger = (
  logId,
  url,
  method,
  startTimestamp,
) => {
  startApiFetchCall({
    id: logId,
    method,
    path: `${url.pathname}${url.search}`,
    startedAt: startTimestamp,
  });

  return {
    success() {
      finishApiFetchCall(logId, { status: 'success' });
    },
    error(status) {
      finishApiFetchCall(logId, {
        status: 'error',
        errorStatus: String(status),
      });
    },
  };
};

setTypedFetchGlobalDefaults({ logger: playgroundApiLogger });

async function apiRequest<Response>(
  path: string,
  options: Parameters<typeof typedFetch<Response>>[1],
): Promise<Response> {
  const result = await typedFetch<Response>(path, {
    host: apiHost,
    ...options,
  });

  if (result.ok) {
    return result.value;
  }

  throw result.error;
}

function mapBatchResponse<Payload, Data>(
  requests: readonly Payload[],
  response: readonly { data?: Data; error?: string }[],
): Map<Payload, Data | Error> {
  const result = new Map<Payload, Data | Error>();

  response.forEach((entry, index) => {
    const request = requests[index];
    if (!request) return;

    result.set(
      request,
      entry.error ? new Error(entry.error) : (entry.data as Data),
    );
  });

  return result;
}

export const apiClient = {
  fetchProfile(signal: AbortSignal): Promise<ProfileDocument> {
    return apiRequest<ProfileDocument>('api/profile', {
      method: 'GET',
      signal,
      responseSchema: profileSchema,
    });
  },

  renameProfile(name: string): Promise<ProfileDocument> {
    return apiRequest<ProfileDocument>('api/profile/name', {
      method: 'PATCH',
      payload: { name },
      responseSchema: profileSchema,
    });
  },

  addProfileCredits(amount: number): Promise<ProfileDocument> {
    return apiRequest<ProfileDocument>('api/profile/credits', {
      method: 'POST',
      payload: { amount },
      responseSchema: profileSchema,
    });
  },

  addProfileTag(label: string): Promise<ProfileDocument> {
    return apiRequest<ProfileDocument>('api/profile/tags', {
      method: 'POST',
      payload: { label },
      responseSchema: profileSchema,
    });
  },

  fetchProject(payload: ProjectPayload, signal: AbortSignal): Promise<Project> {
    return apiRequest<Project>('api/projects/item', {
      method: 'POST',
      payload,
      signal,
      responseSchema: projectSchema,
    });
  },

  async batchFetchProjects(
    payloads: ProjectPayload[],
    signal: AbortSignal,
    batchKey: string,
  ): Promise<Map<ProjectPayload, Project | Error>> {
    const response = await apiRequest<ProjectBatchResponse>(
      'api/projects/batch',
      {
        method: 'POST',
        payload: { payloads, batchKey },
        signal,
        responseSchema: projectBatchResponseSchema,
      },
    );

    return mapBatchResponse(payloads, response);
  },

  renameProject(payload: ProjectPayload, name: string): Promise<Project> {
    return apiRequest<Project>('api/projects/name', {
      method: 'PATCH',
      payload: { payload, name },
      responseSchema: projectSchema,
    });
  },

  toggleFirstProjectTask(payload: ProjectPayload): Promise<Project> {
    return apiRequest<Project>('api/projects/toggle-first-task', {
      method: 'POST',
      payload: { payload },
      responseSchema: projectSchema,
    });
  },

  fetchContacts(
    filter: ContactFilter,
    pagination: { offset: number; limit: number },
    options: { signal: AbortSignal; fields?: string[] },
  ): Promise<ContactListResponse> {
    return apiRequest<ContactListResponse>('api/contacts/list', {
      method: 'POST',
      payload: {
        filter,
        offset: pagination.offset,
        limit: pagination.limit,
        fields: options.fields,
      },
      signal: options.signal,
      responseSchema: contactListResponseSchema,
    });
  },

  fetchContact(
    id: string,
    options: { signal: AbortSignal; fields?: string[] },
  ): Promise<Contact> {
    return apiRequest<Contact>('api/contacts/item', {
      method: 'POST',
      payload: { id, fields: options.fields },
      signal: options.signal,
      responseSchema: contactSchema,
    });
  },

  async batchFetchContacts(
    requests: { payload: string; fields?: string[] }[],
    options: { signal: AbortSignal; batchKey: string },
  ): Promise<Map<string, Contact | Error>> {
    const response = await apiRequest<ContactBatchResponse>(
      'api/contacts/batch',
      {
        method: 'POST',
        payload: { requests, batchKey: options.batchKey },
        signal: options.signal,
        responseSchema: contactBatchResponseSchema,
      },
    );

    return mapBatchResponse(
      requests.map((request) => request.payload),
      response,
    );
  },

  renameContact(id: string, name: string): Promise<Contact> {
    return apiRequest<Contact>('api/contacts/name', {
      method: 'PATCH',
      payload: { id, name },
      responseSchema: contactSchema,
    });
  },

  toggleContactStatus(id: string): Promise<Contact> {
    return apiRequest<Contact>('api/contacts/toggle-status', {
      method: 'POST',
      payload: { id },
      responseSchema: contactSchema,
    });
  },

  createContact(): Promise<Contact> {
    return apiRequest<Contact>('api/contacts', {
      method: 'POST',
      responseSchema: contactSchema,
    });
  },

  deleteContact(id: string): Promise<DeleteContactResponse> {
    return apiRequest<DeleteContactResponse>('api/contacts/delete', {
      method: 'DELETE',
      payload: { id },
      responseSchema: deleteContactResponseSchema,
    });
  },
};
