import {
  rc_array,
  rc_boolean,
  rc_literals,
  rc_object,
  rc_string,
} from 'runcheck';
import { createCollectionStore } from 'tsdf';
import { apiClient } from '../apiClient';
import type { Project, ProjectPayload } from '../apiTypes';
import {
  PLAYGROUND_COLLECTION_STORAGE_ADAPTER,
  storeManager,
} from './storeManager';

const projectPayloadSchema = rc_object({
  workspaceId: rc_string,
  projectId: rc_string,
});

const projectTaskSchema = rc_object({
  id: rc_string,
  title: rc_string,
  done: rc_boolean,
});

const projectSchema = rc_object({
  id: rc_string,
  name: rc_string,
  health: rc_literals('green', 'yellow', 'red'),
  tasks: rc_array(projectTaskSchema),
  updatedAt: rc_string,
});

export const projectStore = createCollectionStore<Project, ProjectPayload>({
  id: 'playground-projects',
  storeManager,
  fetchFn: (payload, signal) => apiClient.fetchProject(payload, signal),
  batchFetchFn: (payloads, signal, batchKey) =>
    apiClient.batchFetchProjects(payloads, signal, batchKey),
  getItemsBatchKey: (payload) => payload.workspaceId,
  maxBatchSize: 3,
  usesRealTimeUpdates: true,
  persistentStorage: {
    adapter: PLAYGROUND_COLLECTION_STORAGE_ADAPTER,
    schema: projectSchema,
    payloadSchema: projectPayloadSchema,
  },
});

export function renameProject(
  payload: ProjectPayload,
  name: string,
): Promise<unknown> {
  return projectStore.performMutation(payload, {
    optimisticUpdate() {
      projectStore.updateItemState(payload, (draft) => {
        draft.name = name;
      });
    },
    mutation: () => apiClient.renameProject(payload, name),
    revalidateOnSuccess: true,
  });
}

export function toggleFirstProjectTask(
  payload: ProjectPayload,
): Promise<unknown> {
  return projectStore.performMutation(payload, {
    optimisticUpdate() {
      projectStore.updateItemState(payload, (draft) => {
        const first = draft.tasks[0];
        if (first) {
          first.done = !first.done;
        }
      });
    },
    mutation: () => apiClient.toggleFirstProjectTask(payload),
    debounce: {
      context: 'project-task-toggle',
      payload: `${payload.workspaceId}:${payload.projectId}`,
      ms: 250,
    },
    revalidateOnSuccess: true,
  });
}

export function addLocalDraftProject(): void {
  projectStore.addItemToState(
    { workspaceId: 'local', projectId: 'draft' },
    {
      id: 'draft',
      name: 'Local draft project',
      health: 'yellow',
      tasks: [{ id: 'shape', title: 'Shape the idea', done: false }],
      updatedAt: new Date().toISOString(),
    },
  );
}

export function deleteLocalDraftProject(): void {
  projectStore.deleteItemState({ workspaceId: 'local', projectId: 'draft' });
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    projectStore.dispose();
  });
}
