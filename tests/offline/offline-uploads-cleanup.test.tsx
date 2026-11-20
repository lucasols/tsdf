import { act } from 'react';
import { rc_array, rc_number, rc_object, rc_string } from 'runcheck';
import { expect, test } from 'vitest';
import type {
  CollectionOfflineOperationDefinition,
  DocumentOfflineOperationDefinition,
  ListQueryOfflineOperationDefinition,
} from '../../src/main';
import { createStoreManager, opfsOfflineUploadAdapter } from '../../src/main';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
} from '../mocks/listQueryStoreTestEnv';
import { createMockBrowserOpfs } from '../mocks/mockBrowserOpfs';
import { normalizeError } from '../mocks/testEnvUtils';
import {
  advanceTime,
  flushAllTimers,
  pick,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import { getOpfsDirTree } from '../utils/persistentStorageOptimizationTestUtils';
import { resetSessionForTests } from '../utils/resetSessionForTests';
import {
  deleteItemInputSchema,
  getSortedQueueSummary,
  userRowSchema,
} from './offlineReplayTestShared';
import {
  classifyRetryableReplayFailure,
  collectionSchema,
  docConflictSchema,
  docSchema,
  listQueryQueryPayloadSchema,
  summarizeResolution,
} from './offlineTestShared';
import {
  getOfflineUploadOpfsPath,
  network,
  resolveWithin,
  setupOfflineUploadTests,
  type DirectUploadUpdateOperations,
  type UploadDependencyOperations,
} from './offlineUploadsTestShared';

setupOfflineUploadTests();

/**
 * Session whose upload transport resolves instantly and whose replay gives up
 * after a single failure, so one rejected `execute` is enough to turn a queued
 * mutation into a manual resolution.
 */
function createUploadCleanupStoreManager(sessionKey: string) {
  return createStoreManager({
    getSessionKey: () => sessionKey,
    errorNormalizer: normalizeError,
    offlineSession: {
      network: network.config,
      classifyRetryableFailure: (error, ctx) =>
        classifyRetryableReplayFailure(error, ctx.phase),
      replayRetry: { maxFailures: 1, intervalMs: 1 },
      uploads: {
        adapter: opfsOfflineUploadAdapter,
        upload: ({ id }) => Promise.resolve(`server:${id}`),
      },
    },
  });
}

type UploadCleanupStoreManager = ReturnType<
  typeof createUploadCleanupStoreManager
>;

/** Stages a file the same way an app does before queueing its mutation. */
async function stageUpload(
  storeManager: UploadCleanupStoreManager,
  id: string,
): Promise<void> {
  (
    await resolveWithin(
      storeManager.saveOfflineUpload({
        id,
        file: new File([`${id} bytes`], `${id}.txt`, {
          type: 'text/plain',
          lastModified: 1,
        }),
      }),
    )
  ).unwrap();
}

function getStagedUploads(storeManager: UploadCleanupStoreManager) {
  return storeManager
    .getOfflineUploads()
    .map((upload) => pick(upload, ['id', 'source', 'state']));
}

async function reconnect(): Promise<void> {
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  // Long enough for the upload transport, the replay and the storage writes,
  // far below the one-week upload retention.
  await advanceTime(2_000);
}

test('discarding a failed mutation deletes the staged upload it depended on, and keeps a file no mutation used yet', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  network.setOffline();
  const storeManager = createUploadCleanupStoreManager(
    'offline-upload-discard-session',
  );

  const env = createDocumentStoreTestEnv<number, UploadDependencyOperations>(
    1,
    {
      id: 'offline-upload-discard-doc',
      storeManager,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          operations: {
            updateWithAttachment: {
              inputSchema: rc_object({
                attachmentId: rc_string,
                value: rc_number,
              }),
              kind: 'update',
              dependsOnUploads: ({ input }) => [input.attachmentId],
              // The server rejects the mutation after its file was uploaded.
              execute: () =>
                Promise.reject(new Error('server rejected the attachment')),
              onSuccessExecute: () => {},
            },
          },
        },
      },
    },
  );
  await flushAllTimers();

  // --- Setup: two staged files, only one of them used by a queued mutation ---
  await stageUpload(storeManager, 'asset-1');
  // The user picked this file but has not submitted its mutation yet.
  await stageUpload(storeManager, 'draft-asset');
  await resolveWithin(
    env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value = 3;
        });
      },
      mutation: () => Promise.resolve({ value: 3 }),
      offline: {
        operation: 'updateWithAttachment',
        input: { attachmentId: 'asset-1', value: 3 },
      },
    }),
  );

  // --- Replay fails: the file is uploaded, then the mutation is rejected ---
  await reconnect();

  const [resolution] = env.apiStore.getOfflineResolutions();
  if (!resolution) {
    throw new Error('Expected the failed replay to require a resolution');
  }
  expect(summarizeResolution(resolution)).toMatchInlineSnapshot(`
    error: 'server rejected the attachment'
    input: 'attachmentId: "asset-1", value: 3'
    kind: 'retry-exhausted'
    on: 'document:document'
    op: 'updateWithAttachment'
  `);
  // While the resolution is pending its upload must stay available, because
  // the user may still retry it.
  expect(getStagedUploads(storeManager)).toMatchInlineSnapshot(`
    - { id: 'asset-1', source: 'manual', state: 'uploaded' }
    - { id: 'draft-asset', source: 'manual', state: 'pending' }
  `);
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`
    "tsdf-uploads (1.07 kb)
    └ offline-upload-discard-session (1.04 kb)
      ├ asset-1 (0.55 kb)
      │ ├ binary.blob (0.05 kb)
      │ └ metadata.json (0.49 kb)
      └ draft-asset (0.44 kb)
        ├ binary.blob (0.05 kb)
        └ metadata.json (0.36 kb)"
  `);

  // --- Action: the user gives up on the mutation ---
  await resolveWithin(
    env.apiStore.resolveOfflineResolution(
      resolution.id,
      'updateWithAttachment',
      { action: 'discard' },
    ),
  );

  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  // Nothing can consume `asset-1` anymore, so both its record and its bytes
  // are gone. `draft-asset` was never referenced by queued work and is kept
  // for the mutation the user has not queued yet.
  expect(getStagedUploads(storeManager)).toMatchInlineSnapshot(
    `- { id: 'draft-asset', source: 'manual', state: 'pending' }`,
  );
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`
    "tsdf-uploads (0.52 kb)
    └ offline-upload-discard-session (0.49 kb)
      └ draft-asset (0.44 kb)
        ├ binary.blob (0.05 kb)
        └ metadata.json (0.36 kb)"
  `);
});

const usersQuery = { tableId: 'users' } as const;

type UserRow = { id: number; name: string };

type UserLifecycleOperations = {
  createUser: ListQueryOfflineOperationDefinition<
    UserRow,
    ListQueryParams,
    string,
    { name: string; avatarId: string },
    unknown,
    UserRow
  >;
  renameUser: ListQueryOfflineOperationDefinition<
    UserRow,
    ListQueryParams,
    string,
    { itemId: string; name: string; attachmentId: string },
    unknown
  >;
  deleteUser: ListQueryOfflineOperationDefinition<
    UserRow,
    ListQueryParams,
    string,
    { itemId: string },
    unknown
  >;
};

/**
 * Users list where creating a user uploads an avatar, renaming a user uploads
 * an attachment, and deleting a user that only exists offline cancels its
 * whole pending lifecycle.
 */
function createUserLifecycleEnv(args: {
  storeManager: UploadCleanupStoreManager;
  storeName: string;
  replayedOperations: string[];
  createUser: (input: { name: string }) => Promise<UserRow>;
}) {
  const env: ReturnType<
    typeof createListQueryStoreTestEnv<
      UserRow,
      false,
      false,
      UserLifecycleOperations
    >
  > = createListQueryStoreTestEnv<
    UserRow,
    false,
    false,
    UserLifecycleOperations
  >(
    { users: [{ id: 1, name: 'Ada' }] },
    {
      id: args.storeName,
      storeManager: args.storeManager,
      testScenario: { loaded: { queries: [usersQuery] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: {
          operations: {
            createUser: {
              inputSchema: rc_object({ name: rc_string, avatarId: rc_string }),
              kind: 'create',
              getEntityRefs: ({ input }) => [`temp:${input.name}`],
              dependsOnUploads: ({ input }) => [input.avatarId],
              tempEntity: {
                buildPendingEntity: (input) => ({ id: -1, name: input.name }),
                reconcileServerEntity: (result) => ({
                  finalPayload: `users||${result.id}`,
                  finalData: result,
                }),
              },
              execute: ({ input }) => {
                args.replayedOperations.push('createUser');
                return args.createUser(input);
              },
            },
            renameUser: {
              inputSchema: rc_object({
                itemId: rc_string,
                name: rc_string,
                attachmentId: rc_string,
              }),
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              dependsOnUploads: ({ input }) => [input.attachmentId],
              execute: ({ input }) => {
                args.replayedOperations.push('renameUser');
                return Promise.resolve({ name: input.name });
              },
              onSuccessExecute: ({ input }) => {
                env.apiStore.updateItemState(input.itemId, (item) => ({
                  ...item,
                  name: input.name,
                }));
              },
            },
            deleteUser: {
              inputSchema: deleteItemInputSchema,
              kind: 'delete',
              getEntityRefs: ({ input }) => [input.itemId],
              supersedes: {
                scope: 'same-entity',
                dropSelfIfTempLifecycleCancelled: true,
              },
              execute: () => {
                args.replayedOperations.push('deleteUser');
                return Promise.resolve(undefined);
              },
              onSuccessExecute: ({ input }) => {
                env.apiStore.deleteItemState(input.itemId);
              },
            },
          },
        },
      },
    },
  );

  /** Queues the creation of the user "Linus" with the given avatar upload. */
  async function queueCreateLinus(avatarId: string): Promise<void> {
    await resolveWithin(
      env.apiStore.performMutation('temp:Linus', {
        optimisticUpdate: () => {
          env.apiStore.addItemToState(
            'temp:Linus',
            { id: -1, name: 'Linus' },
            { addItemToQueries: { queries: [usersQuery], appendTo: 'end' } },
          );
        },
        mutation: () => Promise.resolve({ id: 3, name: 'Linus' }),
        offline: {
          operation: 'createUser',
          input: { name: 'Linus', avatarId },
        },
      }),
    );
  }

  /** Queues a rename of the still-offline "Linus" with the given attachment. */
  async function queueRenameLinus(
    name: string,
    attachmentId: string,
  ): Promise<void> {
    await resolveWithin(
      env.apiStore.performMutation('temp:Linus', {
        optimisticUpdate: () => {
          env.apiStore.updateItemState('temp:Linus', (item) => ({
            ...item,
            name,
          }));
        },
        mutation: () => Promise.resolve({ name }),
        offline: {
          operation: 'renameUser',
          input: { itemId: 'temp:Linus', name, attachmentId },
        },
      }),
    );
  }

  return { ...env, queueCreateLinus, queueRenameLinus };
}

test('discarding a failed create also deletes the staged uploads of the queued edits that depended on the new entity', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  network.setOffline();
  const storeManager = createUploadCleanupStoreManager(
    'offline-upload-cascade-discard-session',
  );
  const replayedOperations: string[] = [];
  const env = createUserLifecycleEnv({
    storeManager,
    storeName: 'offline-upload-cascade-discard-users',
    replayedOperations,
    // The server refuses to create the user.
    createUser: () => Promise.reject(new Error('create replay failed')),
  });
  await flushAllTimers();

  // --- Setup: a create and an edit of the new user, each with its own file ---
  await stageUpload(storeManager, 'linus-avatar');
  await stageUpload(storeManager, 'rename-attachment');
  await env.queueCreateLinus('linus-avatar');
  await env.queueRenameLinus('Linus T.', 'rename-attachment');

  // --- Replay: the create fails, so the rename is blocked behind it ---
  await reconnect();

  // Back offline, the user edits the new user once more. This edit stays in
  // the queue (it is not a resolution record) behind the failed create.
  await act(async () => {
    network.goOffline();
    await Promise.resolve();
  });
  await stageUpload(storeManager, 'second-rename-attachment');
  await env.queueRenameLinus('Linus Torvalds', 'second-rename-attachment');

  // So the chain to discard has both kinds of dependents: the first rename is
  // a blocked resolution record (below), the second one a plain queue entry.
  expect(
    getSortedQueueSummary(
      'offline-upload-cascade-discard-session',
      'offline-upload-cascade-discard-users',
    ),
  ).toMatchInlineSnapshot(`
    - input:
        attachmentId: 'second-rename-attachment'
        itemId: 'temp:Linus'
        name: 'Linus Torvalds'
      operation: 'renameUser'
  `);

  expect(
    env.apiStore
      .getOfflineResolutions()
      .map(summarizeResolution)
      .sort((left, right) => left.op.localeCompare(right.op)),
  ).toMatchInlineSnapshot(`
    - blocks: 1
      error: 'create replay failed'
      input: 'avatarId: "linus-avatar", name: "Linus"'
      kind: 'retry-exhausted'
      on: 'item:temp:Linus'
      op: 'createUser'
      tempIds: ['temp:Linus']
    - blockedBy: 1
      error: 'Blocked by unresolved dependency'
      input: 'attachmentId: "rename-attachment", itemId: "temp:Linus", name: "Linus T."'
      kind: 'retry-exhausted'
      on: 'item:temp:Linus'
      op: 'renameUser'
  `);
  // Only the create got as far as uploading its file; all of them stay staged
  // while the user can still retry the chain.
  expect(getStagedUploads(storeManager)).toMatchInlineSnapshot(`
    - { id: 'linus-avatar', source: 'manual', state: 'uploaded' }
    - { id: 'rename-attachment', source: 'manual', state: 'pending' }
    - { id: 'second-rename-attachment', source: 'manual', state: 'pending' }
  `);
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`
    "tsdf-uploads (1.76 kb)
    └ offline-upload-cascade-discard-session (1.74 kb)
      ├ linus-avatar (0.61 kb)
      │ ├ binary.blob (0.06 kb)
      │ └ metadata.json (0.53 kb)
      ├ rename-attachment (0.50 kb)
      │ ├ binary.blob (0.07 kb)
      │ └ metadata.json (0.40 kb)
      └ second-rename-attachment (0.55 kb)
        ├ binary.blob (0.08 kb)
        └ metadata.json (0.43 kb)"
  `);

  const createResolution = env.apiStore
    .getOfflineResolutions()
    .find((resolution) => resolution.operation === 'createUser');
  if (!createResolution) {
    throw new Error('Expected the failed create to require a resolution');
  }

  // --- Action: discarding the create also drops both edits of the new user ---
  await resolveWithin(
    env.apiStore.resolveOfflineResolution(createResolution.id, 'createUser', {
      action: 'discard',
    }),
  );

  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  expect(
    getSortedQueueSummary(
      'offline-upload-cascade-discard-session',
      'offline-upload-cascade-discard-users',
    ),
  ).toMatchInlineSnapshot(`[]`);
  expect(replayedOperations).toMatchInlineSnapshot(`['createUser']`);
  // The files of the discarded create AND of both cascaded edits are gone.
  expect(getStagedUploads(storeManager)).toMatchInlineSnapshot(`[]`);
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`"empty"`);
});

test('deleting an entity that only exists offline deletes the staged uploads of its cancelled create and edits', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  network.setOffline();
  const storeManager = createUploadCleanupStoreManager(
    'offline-upload-temp-cancel-session',
  );
  const replayedOperations: string[] = [];
  const env = createUserLifecycleEnv({
    storeManager,
    storeName: 'offline-upload-temp-cancel-users',
    replayedOperations,
    createUser: (input) => Promise.resolve({ id: 3, name: input.name }),
  });
  await flushAllTimers();

  // --- Setup: a create and an edit of the new user, each with its own file ---
  await stageUpload(storeManager, 'linus-avatar');
  await stageUpload(storeManager, 'rename-attachment');
  await env.queueCreateLinus('linus-avatar');
  await env.queueRenameLinus('Linus T.', 'rename-attachment');

  expect(getStagedUploads(storeManager)).toMatchInlineSnapshot(`
    - { id: 'linus-avatar', source: 'manual', state: 'pending' }
    - { id: 'rename-attachment', source: 'manual', state: 'pending' }
  `);
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`
    "tsdf-uploads (1.03 kb)
    └ offline-upload-temp-cancel-session (1.01 kb)
      ├ linus-avatar (0.45 kb)
      │ ├ binary.blob (0.06 kb)
      │ └ metadata.json (0.37 kb)
      └ rename-attachment (0.49 kb)
        ├ binary.blob (0.07 kb)
        └ metadata.json (0.39 kb)"
  `);

  // --- Action: the user deletes the new user before anything was replayed ---
  // The delete cancels the create and the rename, and drops itself too because
  // the server never knew about this user.
  await resolveWithin(
    env.apiStore.performMutation('temp:Linus', {
      optimisticUpdate: () => {
        env.apiStore.deleteItemState('temp:Linus');
      },
      mutation: () => Promise.resolve(undefined),
      offline: { operation: 'deleteUser', input: { itemId: 'temp:Linus' } },
    }),
  );

  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  // The cancelled work will never replay, so its files are removed right
  // away, while still offline.
  expect(getStagedUploads(storeManager)).toMatchInlineSnapshot(`[]`);
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`"empty"`);

  // Reconnecting has nothing left to upload or replay.
  await reconnect();
  expect(replayedOperations).toMatchInlineSnapshot(`[]`);
});

type AttachmentCollectionOperations = {
  attachFile: CollectionOfflineOperationDefinition<
    { value: { name: string } },
    string,
    { itemId: string; attachmentId: string },
    unknown
  >;
  deleteItem: CollectionOfflineOperationDefinition<
    { value: { name: string } },
    string,
    { itemId: string },
    unknown
  >;
};

/**
 * Collection where `attachFile` depends on a staged upload and `deleteItem`
 * supersedes the queued edits of the item it deletes.
 */
function createAttachmentCollectionEnv(args: {
  storeManager: UploadCleanupStoreManager;
  storeName: string;
  replayedOperations: string[];
}) {
  const env = createCollectionStoreTestEnv<
    { name: string },
    AttachmentCollectionOperations
  >(
    { 'items||1': { name: 'Ada' } },
    {
      id: args.storeName,
      storeManager: args.storeManager,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: collectionSchema,
        payloadSchema: rc_string,
        offline: {
          operations: {
            attachFile: {
              inputSchema: rc_object({
                itemId: rc_string,
                attachmentId: rc_string,
              }),
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              dependsOnUploads: ({ input }) => [input.attachmentId],
              execute: () => {
                args.replayedOperations.push(`${args.storeName}:attachFile`);
                return Promise.resolve(undefined);
              },
              onSuccessExecute: () => {},
            },
            deleteItem: {
              inputSchema: deleteItemInputSchema,
              kind: 'delete',
              getEntityRefs: ({ input }) => [input.itemId],
              supersedes: { scope: 'same-entity' },
              execute: () => {
                args.replayedOperations.push(`${args.storeName}:deleteItem`);
                return Promise.resolve(undefined);
              },
              onSuccessExecute: ({ input }) => {
                env.apiStore.deleteItemState(input.itemId);
              },
            },
          },
        },
      },
    },
  );

  async function queueAttachFile(attachmentId: string): Promise<void> {
    await resolveWithin(
      env.apiStore.performMutation('items||1', {
        optimisticUpdate: () => {},
        mutation: () => Promise.resolve(undefined),
        offline: {
          operation: 'attachFile',
          input: { itemId: 'items||1', attachmentId },
        },
      }),
    );
  }

  async function queueDeleteItem(): Promise<void> {
    await resolveWithin(
      env.apiStore.performMutation('items||1', {
        optimisticUpdate: () => {
          env.apiStore.deleteItemState('items||1');
        },
        mutation: () => Promise.resolve(undefined),
        offline: { operation: 'deleteItem', input: { itemId: 'items||1' } },
      }),
    );
  }

  return { ...env, queueAttachFile, queueDeleteItem };
}

test('a queued edit superseded by a delete releases its staged upload, and keeps a file no mutation used yet', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  network.setOffline();
  const storeManager = createUploadCleanupStoreManager(
    'offline-upload-supersede-session',
  );
  const replayedOperations: string[] = [];
  const env = createAttachmentCollectionEnv({
    storeManager,
    storeName: 'offline-upload-supersede-items',
    replayedOperations,
  });
  await flushAllTimers();

  // --- Setup: one file used by a queued edit, one not used by anything yet ---
  await stageUpload(storeManager, 'attachment-1');
  await stageUpload(storeManager, 'draft-asset');
  await env.queueAttachFile('attachment-1');

  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`
    "tsdf-uploads (0.97 kb)
    └ offline-upload-supersede-session (0.95 kb)
      ├ attachment-1 (0.45 kb)
      │ ├ binary.blob (0.06 kb)
      │ └ metadata.json (0.37 kb)
      └ draft-asset (0.44 kb)
        ├ binary.blob (0.05 kb)
        └ metadata.json (0.36 kb)"
  `);

  // --- Action: deleting the item prunes the queued edit that needed the file ---
  await env.queueDeleteItem();

  // The pruned edit will never replay, so `attachment-1` is removed while
  // still offline. `draft-asset` was never referenced and stays.
  expect(getStagedUploads(storeManager)).toMatchInlineSnapshot(
    `- { id: 'draft-asset', source: 'manual', state: 'pending' }`,
  );
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`
    "tsdf-uploads (0.53 kb)
    └ offline-upload-supersede-session (0.50 kb)
      └ draft-asset (0.44 kb)
        ├ binary.blob (0.05 kb)
        └ metadata.json (0.36 kb)"
  `);

  // Only the delete is replayed after reconnecting, and the unused file is
  // still waiting for its mutation.
  await reconnect();
  expect(replayedOperations).toMatchInlineSnapshot(
    `['offline-upload-supersede-items:deleteItem']`,
  );
  expect(getStagedUploads(storeManager)).toMatchInlineSnapshot(
    `- { id: 'draft-asset', source: 'manual', state: 'pending' }`,
  );
});

test('an upload shared by queued mutations of two stores survives until the last one is gone', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  network.setOffline();
  const storeManager = createUploadCleanupStoreManager(
    'offline-upload-shared-session',
  );
  const replayedOperations: string[] = [];
  const tasks = createAttachmentCollectionEnv({
    storeManager,
    storeName: 'offline-upload-shared-tasks',
    replayedOperations,
  });
  const notes = createAttachmentCollectionEnv({
    storeManager,
    storeName: 'offline-upload-shared-notes',
    replayedOperations,
  });
  await flushAllTimers();

  // --- Setup: the same staged file is attached to a task and to a note ---
  await stageUpload(storeManager, 'shared-asset');
  await tasks.queueAttachFile('shared-asset');
  await notes.queueAttachFile('shared-asset');

  // --- Action 1: the task (and its queued edit) is deleted ---
  await tasks.queueDeleteItem();

  // The note's queued edit lives in another store but still needs the file,
  // so it must not be deleted yet.
  expect(getStagedUploads(storeManager)).toMatchInlineSnapshot(
    `- { id: 'shared-asset', source: 'manual', state: 'pending' }`,
  );
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`
    "tsdf-uploads (0.52 kb)
    └ offline-upload-shared-session (0.50 kb)
      └ shared-asset (0.44 kb)
        ├ binary.blob (0.06 kb)
        └ metadata.json (0.36 kb)"
  `);

  // --- Action 2: the note is deleted too ---
  await notes.queueDeleteItem();

  // No queued work references the file anymore.
  expect(getStagedUploads(storeManager)).toMatchInlineSnapshot(`[]`);
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`"empty"`);
});

type AttachmentsConflictOperations = {
  saveAttachments: DocumentOfflineOperationDefinition<
    { value: number },
    {
      input: { attachmentIds: string[]; value: number };
      conflict: { reason: string };
    }
  >;
};

/**
 * Document whose `saveAttachments` mutation depends on several staged uploads
 * and reports a conflict for `value: 2` instead of executing.
 */
function createAttachmentsConflictEnv(args: {
  storeManager: UploadCleanupStoreManager;
  storeName: string;
  executedRefs: unknown[];
}) {
  const env = createDocumentStoreTestEnv<number, AttachmentsConflictOperations>(
    1,
    {
      id: args.storeName,
      storeManager: args.storeManager,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          operations: {
            saveAttachments: {
              inputSchema: rc_object({
                attachmentIds: rc_array(rc_string),
                value: rc_number,
              }),
              kind: 'update',
              dependsOnUploads: ({ input }) => input.attachmentIds,
              execute: (ctx) => {
                args.executedRefs.push(ctx.uploads.resolvedRefsById);
                return Promise.resolve({ value: ctx.input.value });
              },
              onSuccessExecute: ({ input }) => {
                env.apiStore.updateState((draft) => {
                  draft.value = input.value;
                });
              },
              conflictHandling: {
                schema: docConflictSchema,
                detectConflict: ({ input }) =>
                  input.value === 2 ? { reason: 'server-changed' } : false,
              },
            },
          },
        },
      },
    },
  );

  /** Queues the conflicting mutation and replays it into a conflict record. */
  async function queueConflictingMutation(attachmentIds: string[]) {
    await resolveWithin(
      env.apiStore.performMutation({
        optimisticUpdate: () => {
          env.apiStore.updateState((draft) => {
            draft.value = 2;
          });
        },
        mutation: () => Promise.resolve({ value: 2 }),
        offline: {
          operation: 'saveAttachments',
          input: { attachmentIds, value: 2 },
        },
      }),
    );
    await reconnect();

    const [conflict] = env.apiStore.getOfflineResolutions();
    if (!conflict || conflict.kind !== 'conflict') {
      throw new Error('Expected the replay to stop on a conflict');
    }
    return conflict;
  }

  return { ...env, queueConflictingMutation };
}

test('requeueing a conflict deletes the staged uploads the replacement no longer uses and keeps the ones it still needs', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  network.setOffline();
  const storeManager = createUploadCleanupStoreManager(
    'offline-upload-requeue-session',
  );
  const executedRefs: unknown[] = [];
  const env = createAttachmentsConflictEnv({
    storeManager,
    storeName: 'offline-upload-requeue-doc',
    executedRefs,
  });
  await flushAllTimers();

  // --- Setup: a mutation with two files stops on a conflict ---
  await stageUpload(storeManager, 'attachment-a');
  await stageUpload(storeManager, 'attachment-b');
  const conflict = await env.queueConflictingMutation([
    'attachment-a',
    'attachment-b',
  ]);

  // A conflict is detected before anything is uploaded, so both files are
  // still waiting.
  expect(getStagedUploads(storeManager)).toMatchInlineSnapshot(`
    - { id: 'attachment-a', source: 'manual', state: 'pending' }
    - { id: 'attachment-b', source: 'manual', state: 'pending' }
  `);

  // Go back offline so the replacement stays queued and its uploads can be
  // inspected before it replays.
  await act(async () => {
    network.goOffline();
    await Promise.resolve();
  });
  await stageUpload(storeManager, 'attachment-c');

  // --- Action: the replacement drops `attachment-a` and adds `attachment-c` ---
  await resolveWithin(
    env.apiStore.resolveOfflineResolution(conflict.id, 'saveAttachments', {
      action: 'requeue',
      input: { attachmentIds: ['attachment-b', 'attachment-c'], value: 3 },
    }),
  );

  // Only the file the replacement stopped using is deleted.
  expect(getStagedUploads(storeManager)).toMatchInlineSnapshot(`
    - { id: 'attachment-b', source: 'manual', state: 'pending' }
    - { id: 'attachment-c', source: 'manual', state: 'pending' }
  `);
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`
    "tsdf-uploads (0.97 kb)
    └ offline-upload-requeue-session (0.95 kb)
      ├ attachment-b (0.44 kb)
      │ ├ binary.blob (0.06 kb)
      │ └ metadata.json (0.36 kb)
      └ attachment-c (0.44 kb)
        ├ binary.blob (0.06 kb)
        └ metadata.json (0.36 kb)"
  `);

  // --- Replay: the replacement uploads and consumes the files it kept ---
  await reconnect();

  expect(executedRefs).toMatchInlineSnapshot(
    `- { attachment-b: 'server:attachment-b', attachment-c: 'server:attachment-c' }`,
  );
  expect(getStagedUploads(storeManager)).toMatchInlineSnapshot(`[]`);
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`"empty"`);
});

test('requeueing a conflict sends the replacement with the files attached directly to the original mutation', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  network.setOffline();
  const storeManager = createUploadCleanupStoreManager(
    'offline-direct-upload-requeue-session',
  );
  const replayedFiles: Array<{ value: number; avatar: string | null }> = [];

  const env = createDocumentStoreTestEnv<
    number,
    {
      updateValue: DocumentOfflineOperationDefinition<
        { value: number },
        { input: { value: number }; conflict: { reason: string } }
      >;
    }
  >(1, {
    id: 'offline-direct-upload-requeue-doc',
    storeManager,
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        operations: {
          updateValue: {
            inputSchema: rc_object({ value: rc_number }),
            kind: 'update',
            execute: async (ctx) => {
              const file = ctx.uploads.filesById.avatar;
              replayedFiles.push({
                value: ctx.input.value,
                avatar: file ? await file.text() : null,
              });
              return ctx.input;
            },
            onSuccessExecute: () => {},
            conflictHandling: {
              schema: docConflictSchema,
              detectConflict: ({ input }) =>
                input.value === 2 ? { reason: 'server-changed' } : false,
            },
          },
        },
      },
    },
  });
  await flushAllTimers();

  // --- Setup: a mutation with an attached file stops on a conflict ---
  await resolveWithin(
    env.apiStore.performMutation({
      optimisticUpdate: () => {},
      mutation: () => Promise.resolve({ value: 2 }),
      offline: { operation: 'updateValue', input: { value: 2 } },
      upload: {
        avatar: new File(['avatar body'], 'avatar.txt', {
          type: 'text/plain',
          lastModified: 1,
        }),
      },
    }),
  );
  await reconnect();

  const [conflict] = env.apiStore.getOfflineResolutions();
  if (!conflict || conflict.kind !== 'conflict') {
    throw new Error('Expected the replay to stop on a conflict');
  }
  // The conflict is detected before `execute`, so nothing was sent yet.
  expect(replayedFiles).toMatchInlineSnapshot(`[]`);

  // --- Action: the user resends the change with adjusted input ---
  await resolveWithin(
    env.apiStore.resolveOfflineResolution(conflict.id, 'updateValue', {
      action: 'requeue',
      input: { value: 3 },
    }),
  );
  await flushAllTimers();

  // The replacement is sent with the file the user attached originally.
  expect(replayedFiles).toMatchInlineSnapshot(
    `- { avatar: 'avatar body', value: 3 }`,
  );
  expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  // Once replayed, nothing needs the attached file anymore.
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`"empty"`);
});

test('committing a conflict without replaying it deletes the staged uploads it depended on', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  network.setOffline();
  const storeManager = createUploadCleanupStoreManager(
    'offline-upload-commit-session',
  );
  const executedRefs: unknown[] = [];
  const env = createAttachmentsConflictEnv({
    storeManager,
    storeName: 'offline-upload-commit-doc',
    executedRefs,
  });
  await flushAllTimers();

  // --- Setup: a mutation with a staged file stops on a conflict ---
  await stageUpload(storeManager, 'attachment-a');
  const conflict = await env.queueConflictingMutation(['attachment-a']);

  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`
    "tsdf-uploads (0.52 kb)
    └ offline-upload-commit-session (0.50 kb)
      └ attachment-a (0.44 kb)
        ├ binary.blob (0.06 kb)
        └ metadata.json (0.36 kb)"
  `);

  // --- Action: the user accepts the current state instead of replaying ---
  await resolveWithin(
    env.apiStore.resolveOfflineResolution(conflict.id, 'saveAttachments', {
      action: 'commit',
    }),
  );

  // The mutation is settled without ever executing, so its file has no
  // consumer left.
  expect(executedRefs).toMatchInlineSnapshot(`[]`);
  expect(getStagedUploads(storeManager)).toMatchInlineSnapshot(`[]`);
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`"empty"`);
});

test('files attached directly to a mutation are deleted when that mutation is discarded', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  network.setOffline();
  const storeManager = createUploadCleanupStoreManager(
    'offline-direct-upload-discard-session',
  );

  const env = createDocumentStoreTestEnv<number, DirectUploadUpdateOperations>(
    1,
    {
      id: 'offline-direct-upload-discard-doc',
      storeManager,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          operations: {
            updateValue: {
              inputSchema: rc_object({ value: rc_number }),
              kind: 'update',
              execute: () =>
                Promise.reject(new Error('server rejected the file')),
              onSuccessExecute: () => {},
            },
          },
        },
      },
    },
  );
  await flushAllTimers();

  // --- Setup: the file travels with the mutation instead of being staged ---
  await resolveWithin(
    env.apiStore.performMutation({
      optimisticUpdate: () => {},
      mutation: () => Promise.resolve({ value: 2 }),
      offline: { operation: 'updateValue', input: { value: 2 } },
      upload: {
        avatar: new File(['direct upload body'], 'avatar.txt', {
          type: 'text/plain',
          lastModified: 1,
        }),
      },
    }),
  );
  await reconnect();

  const [resolution] = env.apiStore.getOfflineResolutions();
  if (!resolution) {
    throw new Error('Expected the failed replay to require a resolution');
  }
  // The attached file is kept while the user can still retry.
  expect(
    storeManager
      .getOfflineUploads()
      .map((upload) => pick(upload, ['source', 'state'])),
  ).toMatchInlineSnapshot(`- { source: 'mutation', state: 'pending' }`);

  // --- Action: the user gives up on the mutation ---
  await resolveWithin(
    env.apiStore.resolveOfflineResolution(resolution.id, 'updateValue', {
      action: 'discard',
    }),
  );

  expect(storeManager.getOfflineUploads()).toMatchInlineSnapshot(`[]`);
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`"empty"`);
});

test('a file attached to a mutation is kept while another store queues a mutation during the file write', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  network.setOffline();
  const storeManager = createUploadCleanupStoreManager(
    'offline-direct-upload-concurrent-session',
  );
  const replayedFiles: string[] = [];

  function createDocEnv(id: string) {
    return createDocumentStoreTestEnv<number, DirectUploadUpdateOperations>(1, {
      id,
      storeManager,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          operations: {
            updateValue: {
              inputSchema: rc_object({ value: rc_number }),
              kind: 'update',
              execute: async (ctx) => {
                const file = ctx.uploads.filesById.avatar;
                if (file) replayedFiles.push(await file.text());
                return ctx.input;
              },
              onSuccessExecute: () => {},
            },
          },
        },
      },
    });
  }

  const profile = createDocEnv('offline-direct-upload-concurrent-profile');
  const settings = createDocEnv('offline-direct-upload-concurrent-settings');
  await flushAllTimers();

  // --- Action: one offline save edits two stores, one of them with a file ---
  // The settings mutation is queued while the profile file is still being
  // written to storage, before the profile mutation that references it is.
  await resolveWithin(
    Promise.all([
      profile.apiStore.performMutation({
        optimisticUpdate: () => {},
        mutation: () => Promise.resolve({ value: 2 }),
        offline: { operation: 'updateValue', input: { value: 2 } },
        upload: {
          avatar: new File(['avatar body'], 'avatar.txt', {
            type: 'text/plain',
            lastModified: 1,
          }),
        },
      }),
      settings.apiStore.performMutation({
        optimisticUpdate: () => {},
        mutation: () => Promise.resolve({ value: 3 }),
        offline: { operation: 'updateValue', input: { value: 3 } },
      }),
    ]),
  );

  // The attached file is still stored for the queued profile mutation.
  expect(
    storeManager
      .getOfflineUploads()
      .map((upload) => pick(upload, ['source', 'state'])),
  ).toMatchInlineSnapshot(`- { source: 'mutation', state: 'pending' }`);

  // --- Assert: after reconnecting the profile mutation is sent with its file ---
  await reconnect();

  expect(replayedFiles).toMatchInlineSnapshot(`['avatar body']`);
  expect(profile.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  // Once replayed, nothing needs the attached file anymore.
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`"empty"`);
});

test('a file queued offline is kept after a restart when another store is created before the store that queued it', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  const sessionKey = 'offline-lazy-store-upload-session';
  const replayedFiles: Array<{ fileName?: string; fileText: string | null }> =
    [];

  function createManager() {
    return createStoreManager({
      getSessionKey: () => sessionKey,
      errorNormalizer: normalizeError,
      offlineSession: {
        network: network.config,
        uploads: {
          adapter: opfsOfflineUploadAdapter,
          upload: ({ id }) => Promise.resolve(`server:${id}`),
        },
      },
    });
  }

  // The store of the "profile" screen, whose edits carry an avatar file.
  function createProfileStore(
    storeManager: ReturnType<typeof createManager>,
    testScenario: 'loaded' | 'idle',
  ) {
    return createDocumentStoreTestEnv<number, DirectUploadUpdateOperations>(1, {
      id: 'offline-lazy-profile-doc',
      storeManager,
      testScenario,
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          operations: {
            updateValue: {
              inputSchema: rc_object({ value: rc_number }),
              kind: 'update',
              execute: async (ctx) => {
                const file = ctx.uploads.filesById.avatar;
                replayedFiles.push({
                  fileName: file?.name,
                  fileText: file ? await file.text() : null,
                });
                return ctx.input;
              },
              onSuccessExecute: () => {},
            },
          },
        },
      },
    });
  }

  // Queue a profile edit with an avatar while offline.
  network.setOffline();
  const storeManager = createManager();
  storeManager.getOfflineStatus();
  const profileEnv = createProfileStore(storeManager, 'loaded');
  await flushAllTimers();

  await resolveAfterAllTimers(
    profileEnv.apiStore.performMutation({
      mutation: () => Promise.resolve({ value: 2 }),
      offline: { operation: 'updateValue', input: { value: 2 } },
      upload: {
        avatar: new File(['avatar body'], 'avatar.txt', {
          type: 'text/plain',
          lastModified: 1,
        }),
      },
    }),
  );
  await flushAllTimers();
  expect(storeManager.getOfflineUploads()).toHaveLength(1);

  // The app restarts on another screen: only the "settings" store is created,
  // the profile store is code-split and created later.
  resetSessionForTests();
  const restartedStoreManager = createManager();
  restartedStoreManager.getOfflineStatus();
  const settingsEnv = createDocumentStoreTestEnv<
    number,
    DirectUploadUpdateOperations
  >(1, {
    id: 'offline-lazy-settings-doc',
    storeManager: restartedStoreManager,
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        operations: {
          updateValue: {
            inputSchema: rc_object({ value: rc_number }),
            kind: 'update',
            execute: (ctx) => Promise.resolve(ctx.input),
            onSuccessExecute: () => {},
          },
        },
      },
    },
  });
  await flushAllTimers();

  // Still offline, the user edits a setting.
  await resolveAfterAllTimers(
    settingsEnv.apiStore.performMutation({
      mutation: () => Promise.resolve({ value: 5 }),
      offline: { operation: 'updateValue', input: { value: 5 } },
    }),
  );
  await flushAllTimers();

  // The queued profile edit still needs its avatar, so the settings store
  // being the only one created must not delete it.
  expect(
    restartedStoreManager.getOfflineUploads().map((upload) => upload.state),
  ).toMatchInlineSnapshot(`['pending']`);
  expect(getOpfsDirTree(mockBrowserOpfs)).toContain('binary.blob');

  // The user opens the profile screen and the connection comes back: the
  // queued edit is sent with the original file.
  createProfileStore(restartedStoreManager, 'idle');
  await flushAllTimers();
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  // A minute online, far less than the one-week retention of unused files.
  await advanceTime(60_000);

  expect(replayedFiles).toMatchInlineSnapshot(`
    - { fileName: 'avatar.txt', fileText: 'avatar body' }
  `);
  // Once the profile store exists and its edit is sent, the file is unused
  // and removed as usual.
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`"empty"`);
});

test('a file queued offline by an older version is removed once its edit is sent', async () => {
  const mockBrowserOpfs = createMockBrowserOpfs();
  const sessionKey = 'offline-legacy-upload-session';
  const replayedFiles: Array<string | null> = [];

  function createManager() {
    return createStoreManager({
      getSessionKey: () => sessionKey,
      errorNormalizer: normalizeError,
      offlineSession: {
        network: network.config,
        uploads: {
          adapter: opfsOfflineUploadAdapter,
          upload: ({ id }) => Promise.resolve(`server:${id}`),
        },
      },
    });
  }

  function createProfileStore(
    storeManager: ReturnType<typeof createManager>,
    testScenario: 'loaded' | 'idle',
  ) {
    return createDocumentStoreTestEnv<number, DirectUploadUpdateOperations>(1, {
      id: 'offline-legacy-profile-doc',
      storeManager,
      testScenario,
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          operations: {
            updateValue: {
              inputSchema: rc_object({ value: rc_number }),
              kind: 'update',
              execute: async (ctx) => {
                const file = ctx.uploads.filesById.avatar;
                replayedFiles.push(file ? await file.text() : null);
                return ctx.input;
              },
              onSuccessExecute: () => {},
            },
          },
        },
      },
    });
  }

  // Queue a profile edit with an avatar while offline.
  network.setOffline();
  const storeManager = createManager();
  storeManager.getOfflineStatus();
  const profileEnv = createProfileStore(storeManager, 'loaded');
  await flushAllTimers();

  await resolveAfterAllTimers(
    profileEnv.apiStore.performMutation({
      mutation: () => Promise.resolve({ value: 2 }),
      offline: { operation: 'updateValue', input: { value: 2 } },
      upload: {
        avatar: new File(['avatar body'], 'avatar.txt', {
          type: 'text/plain',
          lastModified: 1,
        }),
      },
    }),
  );
  await flushAllTimers();
  const [queuedUpload] = storeManager.getOfflineUploads();
  if (!queuedUpload) throw new Error('Expected the queued avatar upload');

  // Older versions didn't persist which store queued the file: drop it from
  // the stored record to get the same data an upgraded app finds.
  const metadataPath = getOfflineUploadOpfsPath(
    sessionKey,
    queuedUpload.id,
    'metadata.json',
  );
  const storedMetadata = mockBrowserOpfs.readFile(metadataPath);
  const legacyMetadata = storedMetadata?.replace(
    ',"s":"offline-legacy-profile-doc"',
    '',
  );
  if (legacyMetadata === undefined || legacyMetadata === storedMetadata) {
    throw new Error('Expected the stored record to have a store name');
  }
  mockBrowserOpfs.writeFile(metadataPath, legacyMetadata);

  // The upgraded app restarts on the profile screen and the connection comes
  // back: the queued edit is sent with the original file.
  resetSessionForTests();
  const restartedStoreManager = createManager();
  restartedStoreManager.getOfflineStatus();
  createProfileStore(restartedStoreManager, 'idle');
  await flushAllTimers();
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
  });
  // A minute online, far less than the one-week retention of unused files.
  await advanceTime(60_000);

  expect(replayedFiles).toMatchInlineSnapshot(`['avatar body']`);
  // Nothing in the profile queue uses the file anymore, so it's removed right
  // away instead of staying in storage until the retention expires.
  expect(getOpfsDirTree(mockBrowserOpfs)).toMatchInlineSnapshot(`"empty"`);
});
