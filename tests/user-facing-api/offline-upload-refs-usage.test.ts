import { typingTest } from '@ls-stack/utils/typingTestUtils';
import { rc_number, rc_object, rc_string } from 'runcheck';
import type { Result } from 't-result';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  type CollectionOfflineOperationDefinition,
  createCollectionStore,
  createDocumentStore,
  createListQueryStore,
  createStoreManager,
  type DefineCollectionOfflineOperations,
  type DefineDocumentOfflineOperations,
  type DefineListQueryOfflineOperations,
  type DefineOfflineOperation,
  type DocumentOfflineOperationDefinition,
  type ListQueryOfflineOperationDefinition,
  type OfflineSessionConfig,
  type OfflineUpload,
  type OfflineUploadAdapter,
  type OfflineUploadFile,
  type OfflineUploadRefSchema,
  type PersistentStorageSchema,
  type StoreManager,
  type StoreManagerUploadRef,
  type ValidPayload,
} from '../../src/main';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { normalizeError, TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { resetSessionForTests } from '../utils/resetSessionForTests';

// Type-level usage tests for the upload ref type: what an app gets, without
// narrowing by hand, from `createStoreManager`, from the manager upload APIs
// and inside the `execute` of queued operations of the three store types.
//
// The runtime behavior of uploads is covered by
// `tests/offline/offline-uploads.test.tsx`; here the assertions are the
// `typingTest` calls, which fail `pnpm tsc` when a type regresses.

const uploadedFileRefSchema = rc_object({ fileId: rc_string, url: rc_string });

/** Whether a value of type `Source` can be passed where `Target` is expected. */
type IsAssignable<Source, Target> = [Source] extends [Target] ? true : false;

// The adapter is irrelevant for typing, so nothing is persisted here.
const uploadAdapter: OfflineUploadAdapter = {
  save: () => Promise.resolve(),
  load: () => Promise.resolve(null),
  list: () => Promise.resolve([]),
  remove: () => Promise.resolve(),
  clearSession: () => Promise.resolve(),
};

/** What the app's upload endpoint returns for an uploaded file. */
type UploadedFileRef = { fileId: string; url: string };

function uploadFile({ id }: { id: string }): Promise<UploadedFileRef> {
  return Promise.resolve({
    fileId: `file-${id}`,
    url: `https://cdn.test/${id}`,
  });
}

/** The app manager: the ref type is never written, only inferred. */
function createAppStoreManager(sessionKey: string) {
  return createStoreManager({
    getSessionKey: () => sessionKey,
    errorNormalizer: normalizeError,
    offlineSession: {
      uploads: {
        adapter: uploadAdapter,
        upload: uploadFile,
        resolvedRefSchema: uploadedFileRefSchema,
      },
    },
  });
}

/** How an app names the ref type of its manager without repeating it. */
type AppUploadRef = StoreManagerUploadRef<
  ReturnType<typeof createAppStoreManager>
>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
  resetSessionForTests({ clearStorage: true });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  resetSessionForTests({ clearStorage: true });
});

test('createStoreManager infers the upload ref type from the upload transport and types the manager upload APIs with it', () => {
  // No explicit generic and no schema: the transport return type is enough.
  const storeManager = createStoreManager({
    getSessionKey: () => 'upload-refs-manager-inference',
    errorNormalizer: normalizeError,
    offlineSession: {
      uploads: {
        adapter: uploadAdapter,
        upload: ({ id }) =>
          Promise.resolve({
            fileId: `file-${id}`,
            url: `https://cdn.test/${id}`,
          }),
      },
    },
  });

  typingTest.expectTypesAreEqual<
    typeof storeManager,
    StoreManager<UploadedFileRef>
  >();
  typingTest.expectTypesAreEqual<
    StoreManagerUploadRef<typeof storeManager>,
    UploadedFileRef
  >();

  // Upload status entries expose the typed ref...
  typingTest.expectTypesAreEqual<
    ReturnType<typeof storeManager.getOfflineUploads>,
    readonly OfflineUpload<UploadedFileRef>[]
  >();
  typingTest.expectTypesAreEqual<
    ReturnType<typeof storeManager.useOfflineUploads>,
    readonly OfflineUpload<UploadedFileRef>[]
  >();
  const firstUpload_ = storeManager.getOfflineUploads()[0];
  typingTest.expectTypesAreEqual<
    NonNullable<typeof firstUpload_>['resolvedRef'],
    UploadedFileRef | undefined
  >();

  // ...as does the ref the staged file hook reports once the upload was sent
  // and released...
  typingTest.expectTypesAreEqual<
    ReturnType<typeof storeManager.useOfflineUploadFile>,
    OfflineUploadFile<UploadedFileRef>
  >();
  typingTest.expectTypesAreEqual<
    ReturnType<typeof storeManager.useOfflineUploadFile>['resolvedRef'],
    UploadedFileRef | null
  >();

  // ...and so do both resolve APIs.
  typingTest.expectTypesAreEqual<
    Awaited<ReturnType<typeof storeManager.resolveOfflineUpload>>,
    Result<UploadedFileRef, Error>
  >();
  typingTest.expectTypesAreEqual<
    Awaited<ReturnType<typeof storeManager.resolveOfflineUploads>>,
    Result<Record<string, UploadedFileRef>, Error>
  >();

  expect(storeManager.getOfflineUploads()).toMatchInlineSnapshot(`[]`);
});

test('managers that do not type the upload ref keep the unvalidated ValidPayload ref', () => {
  // Without an upload transport there is nothing to infer from.
  const managerWithoutUploads = createStoreManager({
    getSessionKey: () => 'upload-refs-no-uploads',
    errorNormalizer: normalizeError,
  });
  typingTest.expectTypesAreEqual<typeof managerWithoutUploads, StoreManager>();
  typingTest.expectTypesAreEqual<
    StoreManagerUploadRef<typeof managerWithoutUploads>,
    ValidPayload
  >();

  // Annotating the manager with the default `StoreManager` type is where an
  // app loses an inferred ref type: the annotation wins over the inference.
  const annotatedManager_: StoreManager = createAppStoreManager(
    'upload-refs-annotated',
  );
  typingTest.expectTypesAreEqual<
    StoreManagerUploadRef<typeof annotatedManager_>,
    ValidPayload
  >();
  typingTest.expectTypesAreEqual<
    Awaited<ReturnType<typeof annotatedManager_.resolveOfflineUpload>>,
    Result<ValidPayload, Error>
  >();

  expect(managerWithoutUploads.getOfflineConfig()).toBeUndefined();
});

test('the resolved ref schema takes runcheck and Standard Schema types and has to agree with the transport', () => {
  // A runcheck schema and the transport agree on the ref type.
  const runcheckManager_ = createAppStoreManager('upload-refs-runcheck-schema');
  typingTest.expectTypesAreEqual<
    typeof runcheckManager_,
    StoreManager<UploadedFileRef>
  >();
  typingTest.expectTypesAreEqual<AppUploadRef, UploadedFileRef>();

  // Same with a Standard Schema (zod).
  const zodManager = createStoreManager({
    getSessionKey: () => 'upload-refs-zod-schema',
    errorNormalizer: normalizeError,
    offlineSession: {
      uploads: {
        adapter: uploadAdapter,
        upload: uploadFile,
        resolvedRefSchema: z.object({ fileId: z.string(), url: z.string() }),
      },
    },
  });
  typingTest.expectTypesAreEqual<
    typeof zodManager,
    StoreManager<UploadedFileRef>
  >();

  // A restored ref is only guaranteed to have what the schema checks, so a
  // transport returning more than the schema validates does not widen the ref.
  const managerWithNarrowerSchema_ = createStoreManager({
    getSessionKey: () => 'upload-refs-narrower-schema',
    errorNormalizer: normalizeError,
    offlineSession: {
      uploads: {
        adapter: uploadAdapter,
        upload: ({ id }) =>
          Promise.resolve({
            fileId: `file-${id}`,
            url: `https://cdn.test/${id}`,
            uploadedAt: 1,
          }),
        resolvedRefSchema: uploadedFileRefSchema,
      },
    },
  });
  typingTest.expectTypesAreEqual<
    StoreManagerUploadRef<typeof managerWithNarrowerSchema_>,
    UploadedFileRef
  >();

  // The option accepts whatever an operation `inputSchema` accepts...
  typingTest.expectTypesAreEqual<
    IsAssignable<
      PersistentStorageSchema<UploadedFileRef>,
      OfflineUploadRefSchema<UploadedFileRef>
    >,
    true
  >();
  // ...but not a schema for a different ref than the transport returns.
  typingTest.expectTypesAreEqual<
    IsAssignable<typeof uploadedFileRefSchema, OfflineUploadRefSchema<string>>,
    false
  >();
  typingTest.expectTypesAreEqual<
    IsAssignable<
      OfflineSessionConfig<UploadedFileRef>,
      OfflineSessionConfig<string>
    >,
    false
  >();

  expect(
    zodManager.getOfflineConfig()?.uploads?.resolvedRefSchema,
  ).toBeDefined();
});

test('a manager with a typed upload ref is accepted wherever the default StoreManager type is expected', () => {
  const storeManager = createAppStoreManager('upload-refs-assignability');

  // A typed manager and its config can be handed to code typed with the
  // defaults (shared helpers, wrappers around store creation, ...).
  const defaultManager: StoreManager = storeManager;
  const defaultConfig: OfflineSessionConfig | undefined =
    storeManager.getOfflineConfig();
  typingTest.expectTypesAreEqual<
    IsAssignable<StoreManager<UploadedFileRef>, StoreManager>,
    true
  >();
  typingTest.expectTypesAreEqual<
    IsAssignable<StoreManager<`upload:${string}`>, StoreManager>,
    true
  >();

  // The test envs are such wrappers: they take the default manager type.
  const documentEnv = createDocumentStoreTestEnv(1, {
    id: 'upload-refs-assignability-doc',
    storeManager,
  });
  const collectionEnv = createCollectionStoreTestEnv(
    { '1': { title: 'Todo' } },
    { id: 'upload-refs-assignability-collection', storeManager },
  );
  const listQueryEnv = createListQueryStoreTestEnv(
    { users: [{ id: 1, name: 'Ada' }] },
    { id: 'upload-refs-assignability-list', storeManager },
  );

  expect(defaultManager.getAllStoreIds()).toMatchInlineSnapshot(`
    - 'upload-refs-assignability-doc'
    - 'upload-refs-assignability-collection'
    - 'upload-refs-assignability-list'
  `);
  expect(defaultConfig?.uploads?.adapter).toBe(uploadAdapter);

  documentEnv.apiStore.dispose();
  collectionEnv.apiStore.dispose();
  listQueryEnv.apiStore.dispose();
});

const docSchema = rc_object({ avatarUrl: rc_string });
const attachInputSchema = rc_object({ uploadId: rc_string });

type Doc = { avatarUrl: string };

test('document store operations read the typed upload ref in execute', () => {
  const storeManager = createAppStoreManager('upload-refs-document');

  type DocOperations = DefineDocumentOfflineOperations<
    Doc,
    { setAvatar: DefineOfflineOperation<{ uploadId: string }> },
    AppUploadRef
  >;

  // The single-operation alias takes the ref type as well.
  typingTest.expectTypesAreEqual<
    DocOperations['setAvatar'],
    DocumentOfflineOperationDefinition<
      Doc,
      DefineOfflineOperation<{ uploadId: string }>,
      UploadedFileRef
    >
  >();

  const documentStore = createDocumentStore<Doc, DocOperations>({
    id: 'upload-refs-document',
    storeManager,
    fetchFn: () => Promise.resolve({ avatarUrl: 'https://cdn.test/initial' }),
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        operations: {
          setAvatar: {
            inputSchema: attachInputSchema,
            kind: 'update',
            dependsOnUploads: ({ input }) => [input.uploadId],
            execute: ({ input, uploads }) => {
              const uploadedFile_ = uploads.resolvedRefsById[input.uploadId];
              typingTest.expectTypesAreEqual<
                typeof uploadedFile_,
                UploadedFileRef | undefined
              >();
            },
            onSuccessExecute: () => {},
          },
        },
      },
    },
  });

  // Without the ref type argument the operation keeps the untyped default,
  // which is what apps that do not type the ref get.
  type UntypedDocOperations = DefineDocumentOfflineOperations<
    Doc,
    { setAvatar: DefineOfflineOperation<{ uploadId: string }> }
  >;
  const untypedExecute: UntypedDocOperations['setAvatar']['execute'] = ({
    input,
    uploads,
  }) => {
    const uploadedFile_ = uploads.resolvedRefsById[input.uploadId];
    typingTest.expectTypesAreEqual<
      typeof uploadedFile_,
      ValidPayload | undefined
    >();
  };

  expect(typeof untypedExecute).toBe('function');
  expect(storeManager.getAllStoreIds()).toMatchInlineSnapshot(`
    ['upload-refs-document']
  `);
  documentStore.dispose();
});

const todoSchema = rc_object({ title: rc_string, attachmentUrl: rc_string });
const todoAttachInputSchema = rc_object({ id: rc_string, uploadId: rc_string });

type Todo = { title: string; attachmentUrl: string };

test('collection store operations read the typed upload ref in execute', () => {
  const storeManager = createAppStoreManager('upload-refs-collection');

  type TodoOperations = DefineCollectionOfflineOperations<
    Todo,
    string,
    { attachFile: DefineOfflineOperation<{ id: string; uploadId: string }> },
    AppUploadRef
  >;

  // The single-operation alias takes the ref type as well.
  typingTest.expectTypesAreEqual<
    TodoOperations['attachFile'],
    CollectionOfflineOperationDefinition<
      Todo,
      string,
      { id: string; uploadId: string },
      unknown,
      unknown,
      unknown,
      UploadedFileRef
    >
  >();

  const collectionStore = createCollectionStore<Todo, string, TodoOperations>({
    id: 'upload-refs-collection',
    storeManager,
    fetchFn: () => Promise.resolve({ title: 'Todo', attachmentUrl: '' }),
    getCollectionItemKey: (payload) => payload,
    persistentStorage: {
      adapter: 'local-sync',
      schema: todoSchema,
      payloadSchema: rc_string,
      offline: {
        operations: {
          attachFile: {
            inputSchema: todoAttachInputSchema,
            kind: 'update',
            getEntityRefs: ({ input }) => [input.id],
            dependsOnUploads: ({ input }) => [input.uploadId],
            execute: ({ input, uploads }) => {
              const uploadedFile_ = uploads.resolvedRefsById[input.uploadId];
              typingTest.expectTypesAreEqual<
                typeof uploadedFile_,
                UploadedFileRef | undefined
              >();
            },
            onSuccessExecute: () => {},
          },
        },
      },
    },
  });

  expect(storeManager.getAllStoreIds()).toMatchInlineSnapshot(`
    ['upload-refs-collection']
  `);
  collectionStore.dispose();
});

type User = { id: number; avatarUrl: string };
type UsersQuery = { teamId: string };
type UserPayload = { id: number };
const userSchema = rc_object({ id: rc_number, avatarUrl: rc_string });
const userAttachInputSchema = rc_object({ id: rc_number, uploadId: rc_string });

test('list query store operations read the typed upload ref in execute', () => {
  const storeManager = createAppStoreManager('upload-refs-list-query');

  type UserOperations = DefineListQueryOfflineOperations<
    User,
    UsersQuery,
    UserPayload,
    { setAvatar: DefineOfflineOperation<{ id: number; uploadId: string }> },
    AppUploadRef
  >;

  // The single-operation alias takes the ref type as well.
  typingTest.expectTypesAreEqual<
    UserOperations['setAvatar'],
    ListQueryOfflineOperationDefinition<
      User,
      UsersQuery,
      UserPayload,
      { id: number; uploadId: string },
      unknown,
      unknown,
      unknown,
      UploadedFileRef
    >
  >();

  const listQueryStore = createListQueryStore<
    User,
    UsersQuery,
    UserPayload,
    false,
    false,
    UserOperations
  >({
    id: 'upload-refs-list-query',
    storeManager,
    fetchListFn: () => Promise.resolve({ items: [], hasMore: false }),
    fetchItemFn: (payload) =>
      Promise.resolve({ id: payload.id, avatarUrl: '' }),
    getItemKey: (payload) => payload.id,
    persistentStorage: {
      adapter: 'local-sync',
      schema: userSchema,
      itemPayloadSchema: rc_object({ id: rc_number }),
      queryPayloadSchema: rc_object({ teamId: rc_string }),
      offline: {
        operations: {
          setAvatar: {
            inputSchema: userAttachInputSchema,
            kind: 'update',
            getEntityRefs: ({ input }) => [{ id: input.id }],
            dependsOnUploads: ({ input }) => [input.uploadId],
            execute: ({ input, uploads }) => {
              const uploadedFile_ = uploads.resolvedRefsById[input.uploadId];
              typingTest.expectTypesAreEqual<
                typeof uploadedFile_,
                UploadedFileRef | undefined
              >();
            },
            onSuccessExecute: () => {},
          },
        },
      },
    },
  });

  expect(storeManager.getAllStoreIds()).toMatchInlineSnapshot(`
    ['upload-refs-list-query']
  `);
  listQueryStore.dispose();
});
