import { act } from 'react';
import { rc_object, rc_parse, rc_string } from 'runcheck';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  CollectionOfflineOperationDefinition,
  OfflineResolutionRecord,
} from '../../src/main';
import { createStoreManager } from '../../src/storeManager';
import { createOfflineNetworkMock } from '../../src/testing';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import { createReplayFailure } from './offlineReplayTestShared';
import { summarizeResolution } from './offlineTestShared';

type Doc = { title: string; body: string; status: string };

type DocChanges = { title?: string; body?: string };

/** An edit, optionally moving the doc under another doc */
type EditDocInput = { docId: string; parentId?: string; changes: DocChanges };

type DocOperations = {
  /** Creates a doc, with an id generated on the client */
  createDoc: CollectionOfflineOperationDefinition<
    Doc,
    string,
    { docId: string; title: string }
  >;
  /** Edits fields of the doc: queued edits are merged, newer fields win */
  editDoc: CollectionOfflineOperationDefinition<
    Doc,
    string,
    EditDocInput,
    { reason: string }
  >;
  /** Sets the status: a newer status replaces an older one */
  setStatus: CollectionOfflineOperationDefinition<
    Doc,
    string,
    { docId: string; status: string }
  >;
  /** Renames the doc, with neither `accumulation` nor `supersedes` */
  renameDoc: CollectionOfflineOperationDefinition<
    Doc,
    string,
    { docId: string; title: string }
  >;
};

type DocMutation =
  | { operation: 'editDoc'; input: EditDocInput }
  | { operation: 'setStatus'; input: { docId: string; status: string } }
  | { operation: 'renameDoc'; input: { docId: string; title: string } };

const editDocInputSchema = rc_object({
  docId: rc_string,
  parentId: rc_string.optionalKey(),
  changes: rc_object({
    title: rc_string.optionalKey(),
    body: rc_string.optionalKey(),
  }),
});

/** The fields an edit changes (the input schema keeps the others as `undefined`) */
function getDefinedChanges({ title, body }: DocChanges): DocChanges {
  return {
    ...(title === undefined ? {} : { title }),
    ...(body === undefined ? {} : { body }),
  };
}

let network = createOfflineNetworkMock();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
  network = createOfflineNetworkMock();
  network.install();
  localStorage.clear();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  localStorage.clear();
});

function createDocsEnv() {
  const sessionKey = 'newer-changes-session';
  /** Values the server rejects while the queue is replayed */
  const rejectedValues = new Set<string>();
  /** Values the server reports a conflict for while the queue is replayed */
  const conflictingValues = new Set<string>();
  /** The requests the replay sent, in order */
  const replayed: string[] = [];

  function failIfRejected(values: (string | undefined)[]) {
    if (
      values.some((value) => value !== undefined && rejectedValues.has(value))
    ) {
      throw createReplayFailure(`rejected ${values.filter(Boolean).join(' ')}`);
    }
  }

  function getServerDoc(): Doc {
    const doc = env.serverTable.getAll()['docs||1'];
    if (!doc) throw new Error('Missing server doc');
    return doc;
  }

  async function updateServerDoc(data: Partial<Doc>): Promise<{ value: Doc }> {
    await env.serverTable.delayedUpdateItem('docs||1', data);
    return { value: getServerDoc() };
  }

  const storeManager = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: { network: network.config },
  });

  const env = createCollectionStoreTestEnv<Doc, DocOperations>(
    { 'docs||1': { title: 'T0', body: 'v0', status: 'draft' } },
    {
      id: 'docs',
      getSessionKey: () => sessionKey,
      storeManager,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: rc_object({
          value: rc_object({
            title: rc_string,
            body: rc_string,
            status: rc_string,
          }),
        }),
        payloadSchema: rc_string,
        offline: {
          operations: {
            createDoc: {
              inputSchema: rc_object({ docId: rc_string, title: rc_string }),
              kind: 'create',
              getEntityRefs: ({ input }) => [input.docId],
              execute: async ({ input }) => {
                failIfRejected([input.title]);
                replayed.push(`createDoc ${input.title}`);
                await env.serverTable.delayedSetItem(input.docId, {
                  title: input.title,
                  body: '',
                  status: 'draft',
                });
              },
              onSuccessExecute: () => {},
            },
            editDoc: {
              inputSchema: editDocInputSchema,
              kind: 'update',
              getEntityRefs: ({ input }) => [input.docId],
              // Moved under another doc, the edit needs that doc saved first
              dependsOn: ({ input }) =>
                input.parentId === undefined ? [] : [input.parentId],
              accumulation: {
                mergeInput: ({ existingInput, incomingInput }) => ({
                  ...incomingInput,
                  changes: {
                    ...getDefinedChanges(existingInput.changes),
                    ...getDefinedChanges(incomingInput.changes),
                  },
                }),
              },
              conflictHandling: {
                schema: rc_object({ reason: rc_string }),
                detectConflict: ({ input }) =>
                  [input.changes.title, input.changes.body].some(
                    (value) =>
                      value !== undefined && conflictingValues.has(value),
                  )
                    ? { reason: 'edited elsewhere' }
                    : false,
              },
              execute: ({ input }) => {
                failIfRejected([input.changes.title, input.changes.body]);
                const changes = getDefinedChanges(input.changes);
                replayed.push(`editDoc ${JSON.stringify(changes)}`);
                return updateServerDoc(changes);
              },
              onSuccessExecute: ({ input }) => {
                env.apiStore.updateItemState(input.docId, (draft) => {
                  Object.assign(draft.value, getDefinedChanges(input.changes));
                });
              },
            },
            setStatus: {
              inputSchema: rc_object({ docId: rc_string, status: rc_string }),
              kind: 'update',
              getEntityRefs: ({ input }) => [input.docId],
              supersedes: { scope: 'same-entity', operations: 'self' },
              execute: ({ input }) => {
                failIfRejected([input.status]);
                replayed.push(`setStatus ${input.status}`);
                return updateServerDoc({ status: input.status });
              },
              onSuccessExecute: ({ input }) => {
                env.apiStore.updateItemState(input.docId, (draft) => {
                  draft.value.status = input.status;
                });
              },
            },
            renameDoc: {
              inputSchema: rc_object({ docId: rc_string, title: rc_string }),
              kind: 'update',
              getEntityRefs: ({ input }) => [input.docId],
              execute: ({ input }) => {
                failIfRejected([input.title]);
                replayed.push(`renameDoc ${input.title}`);
                return updateServerDoc({ title: input.title });
              },
              onSuccessExecute: ({ input }) => {
                env.apiStore.updateItemState(input.docId, (draft) => {
                  draft.value.title = input.title;
                });
              },
            },
          },
        },
      },
    },
  );

  /**
   * Runs a mutation like the app does, lets its request (or the replay it
   * triggers) finish, and resolves to whether it was sent online or queued.
   */
  async function mutate(
    changes: Partial<Doc>,
    offline: DocMutation,
  ): Promise<string> {
    const result = env.apiStore.performMutation('docs||1', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('docs||1', (draft) => {
          Object.assign(draft.value, changes);
        });
      },
      mutation: () => updateServerDoc(changes),
      offline,
    });
    await flushAllTimers();
    return (await result).unwrap().kind;
  }

  function getOnlyResolution(): OfflineResolutionRecord {
    const resolutions = env.apiStore.getOfflineResolutions();
    const [resolution] = resolutions;
    if (!resolution || resolutions.length !== 1) {
      throw new Error(`Expected one resolution, got ${resolutions.length}`);
    }
    return resolution;
  }

  return {
    env,
    storeManager,
    rejectedValues,
    conflictingValues,
    replayed,
    getServerDoc,
    getOnlyResolution,
    getLocalDoc: () => env.apiStore.getItemState('docs||1')?.data?.value,
    editDoc: (changes: DocChanges) =>
      mutate(changes, {
        operation: 'editDoc',
        input: { docId: 'docs||1', changes },
      }),
    /** An edit with the full input (e.g. moving the doc under another doc) */
    editDocWith: (input: EditDocInput) =>
      mutate(input.changes, { operation: 'editDoc', input }),
    setStatus: (status: string) =>
      mutate(
        { status },
        { operation: 'setStatus', input: { docId: 'docs||1', status } },
      ),
    renameDoc: (title: string) =>
      mutate(
        { title },
        { operation: 'renameDoc', input: { docId: 'docs||1', title } },
      ),
    getResolutions: () =>
      env.apiStore
        .getOfflineResolutions()
        .map((resolution) => ({
          ...summarizeResolution(resolution),
          ...(resolution.hasNewerChanges ? { hasNewerChanges: true } : {}),
        })),
    /** Clicks "Try again" on the only change waiting for a decision */
    retryFailedChange: async () => {
      const result = await act(() =>
        storeManager.resolveOfflineResolution(getOnlyResolution().id, 'retry'),
      );
      await flushAllTimers();
      return result.ok;
    },
    /** Goes online and lets the queue replay, with the retries it schedules */
    goOnline: async () => {
      act(() => network.goOnline());
      await flushAllTimers();
    },
    /**
     * Goes online only until the queue is first replayed: a failed change is
     * kept to be checked again a few seconds later
     */
    goOnlineUntilFirstReplayAttempt: async () => {
      act(() => network.goOnline());
      await advanceTime(100);
    },
    goOffline: () => {
      act(() => network.goOffline());
    },
  };
}

describe('an operation with accumulation', () => {
  test('retrying a failed edit after a newer edit was saved online keeps the newer values and still sends the fields only the failed edit changed', async () => {
    const t = createDocsEnv();

    // Offline, the user edits the title and the body. The server rejects
    // that edit when it is replayed, so it waits for a decision
    network.setOffline();
    await t.editDoc({ title: 'T1', body: 'v1' });
    t.rejectedValues.add('v1');
    await t.goOnline();
    t.rejectedValues.clear();

    expect(t.getResolutions()).toMatchInlineSnapshot(`
      - error: 'rejected T1 v1'
        input: 'changes: body: "v1", title: "T1", docId: "docs||1", parentId: undefined'
        kind: 'retry-exhausted'
        on: 'item:docs||1'
        op: 'editDoc'
    `);

    // Online, the user opens the doc from the failed change and keeps
    // writing: the newer body is saved directly
    expect(await t.editDoc({ body: 'v2' })).toBe('online');
    expect(t.getServerDoc()).toMatchInlineSnapshot(`
      body: 'v2'
      status: 'draft'
      title: 'T0'
    `);

    // The failed change follows the newer edit: its body is the newer one,
    // and the title only it changed is kept
    expect(t.getResolutions()).toMatchInlineSnapshot(`
      - error: 'rejected T1 v1'
        input: 'changes: body: "v2", title: "T1", docId: "docs||1", parentId: undefined'
        kind: 'retry-exhausted'
        on: 'item:docs||1'
        op: 'editDoc'
    `);

    // "Try again" sends the title without bringing the old body back
    expect(await t.retryFailedChange()).toBe(true);
    expect(t.replayed).toMatchInlineSnapshot(
      `['editDoc {"title":"T1","body":"v2"}']`,
    );
    expect(t.getServerDoc()).toMatchInlineSnapshot(`
      body: 'v2'
      status: 'draft'
      title: 'T1'
    `);
    expect(t.getLocalDoc()).toMatchInlineSnapshot(`
      body: 'v2'
      status: 'draft'
      title: 'T1'
    `);
    expect(t.getResolutions()).toMatchInlineSnapshot(`[]`);
  });

  test('retrying a failed edit while a newer offline edit is still queued sends the newer edit first and keeps its values', async () => {
    const t = createDocsEnv();

    network.setOffline();
    await t.editDoc({ title: 'T1', body: 'v1' });
    t.rejectedValues.add('v1');
    await t.goOnline();
    t.rejectedValues.clear();

    // Offline again, the user keeps writing: the edit is queued on its own,
    // and the failed change follows it
    t.goOffline();
    expect(await t.editDoc({ body: 'v2' })).toBe('queued');
    expect(t.getResolutions()).toMatchInlineSnapshot(`
      - error: 'rejected T1 v1'
        input: 'changes: body: "v2", title: "T1", docId: "docs||1", parentId: undefined'
        kind: 'retry-exhausted'
        on: 'item:docs||1'
        op: 'editDoc'
    `);

    // "Try again" while still offline queues the failed change after the
    // newer edit
    expect(await t.retryFailedChange()).toBe(true);
    await t.goOnline();

    // The failed change is sent last, with the newer body
    expect(t.replayed).toMatchInlineSnapshot(
      `['editDoc {"body":"v2"}', 'editDoc {"title":"T1","body":"v2"}']`,
    );
    expect(t.getServerDoc()).toMatchInlineSnapshot(`
      body: 'v2'
      status: 'draft'
      title: 'T1'
    `);
  });

  test('an edit queued while an older edit was being retried is followed by that edit once it fails', async () => {
    const t = createDocsEnv();

    // The first edit fails once: the replay keeps it to check it again
    network.setOffline();
    await t.editDoc({ title: 'T1', body: 'v1' });
    t.rejectedValues.add('v1');
    await t.goOnlineUntilFirstReplayAttempt();
    expect(t.getResolutions()).toMatchInlineSnapshot(`[]`);

    // Offline again, a newer edit is queued behind it, apart: the first one
    // may have reached the server, so it cannot be merged into it
    t.goOffline();
    expect(await t.editDoc({ body: 'v2' })).toBe('queued');

    // Back online the first edit fails for good, then the newer one is sent
    await t.goOnline();
    t.rejectedValues.clear();
    expect(t.replayed).toMatchInlineSnapshot(`['editDoc {"body":"v2"}']`);

    // The failed change already follows the newer edit
    expect(t.getResolutions()).toMatchInlineSnapshot(`
      - error: 'rejected T1 v1'
        input: 'changes: body: "v2", title: "T1", docId: "docs||1", parentId: undefined'
        kind: 'retry-exhausted'
        on: 'item:docs||1'
        op: 'editDoc'
    `);

    expect(await t.retryFailedChange()).toBe(true);
    expect(t.getServerDoc()).toMatchInlineSnapshot(`
      body: 'v2'
      status: 'draft'
      title: 'T1'
    `);
  });

  test('a conflict follows a newer edit too, so requeueing its input keeps the newer values', async () => {
    const t = createDocsEnv();

    network.setOffline();
    await t.editDoc({ title: 'T1', body: 'v1' });
    t.conflictingValues.add('v1');
    await t.goOnline();
    t.conflictingValues.clear();

    expect(await t.editDoc({ body: 'v2' })).toBe('online');
    expect(t.getResolutions()).toMatchInlineSnapshot(`
      - input: 'changes: body: "v2", title: "T1", docId: "docs||1", parentId: undefined'
        kind: 'conflict'
        on: 'item:docs||1'
        op: 'editDoc'
        reason: 'edited elsewhere'
    `);

    // The conflict UI keeps the user's version: it requeues the input
    const resolution = t.getOnlyResolution();
    const input = rc_parse(resolution.input, editDocInputSchema).unwrap();
    await act(() =>
      t.env.apiStore.resolveOfflineResolution(resolution.id, 'editDoc', {
        action: 'requeue',
        input,
      }),
    );
    await flushAllTimers();

    expect(t.getServerDoc()).toMatchInlineSnapshot(`
      body: 'v2'
      status: 'draft'
      title: 'T1'
    `);
  });
});

describe('changes that finish out of order or wait for a creation', () => {
  test('an older online edit whose response arrives last does not bring its values back into the failed edit', async () => {
    const t = createDocsEnv();

    // An edit fails and waits for a decision
    network.setOffline();
    await t.editDoc({ title: 'T1', body: 'v1' });
    t.rejectedValues.add('v1');
    await t.goOnline();
    t.rejectedValues.clear();

    /** An online edit whose response takes `responseMs` to come back */
    function editBody(body: string, responseMs: number) {
      return t.env.apiStore.performMutation('docs||1', {
        mutation: async () => {
          await t.env.serverTable.delayedUpdateItem('docs||1', { body });
          const response = { value: t.getServerDoc() };
          await new Promise((resolve) => setTimeout(resolve, responseMs));
          return response;
        },
        offline: {
          operation: 'editDoc',
          input: { docId: 'docs||1', changes: { body } },
        },
      });
    }

    // Autosave sends `v2`, then `v3` while the response of `v2` is slow: the
    // server saves both in order, but `v3`'s response arrives first
    const earlier = editBody('v2', 3_000);
    await advanceTime(1_300);
    const later = editBody('v3', 0);
    await flushAllTimers();
    expect((await earlier).unwrap().kind).toBe('online');
    expect((await later).unwrap().kind).toBe('online');
    expect(t.getServerDoc().body).toBe('v3');

    // The failed edit followed `v3`. The older `v2`, arriving last, is not
    // merged over it: the failed edit is only flagged
    expect(t.getResolutions()).toMatchInlineSnapshot(`
      - error: 'rejected T1 v1'
        hasNewerChanges: '✅'
        input: 'changes: body: "v3", title: "T1", docId: "docs||1", parentId: undefined'
        kind: 'retry-exhausted'
        on: 'item:docs||1'
        op: 'editDoc'
    `);

    // "Try again" keeps the newest body
    expect(await t.retryFailedChange()).toBe(true);
    expect(t.getServerDoc()).toMatchInlineSnapshot(`
      body: 'v3'
      status: 'draft'
      title: 'T1'
    `);
  });

  test('a failed edit is flagged by a newer edit held behind a doc creation that waits for a decision, so retrying it does not silently overwrite that edit', async () => {
    const t = createDocsEnv();

    // An edit fails and waits for a decision
    network.setOffline();
    await t.editDoc({ title: 'T1', body: 'v1' });
    t.rejectedValues.add('v1');
    await t.goOnline();
    t.rejectedValues.clear();

    // Offline, the user creates a parent doc, which the server rejects
    t.goOffline();
    const create = t.env.apiStore.performMutation('docs||2', {
      // Offline: queued without being called
      mutation: () => Promise.resolve(null),
      offline: {
        operation: 'createDoc',
        input: { docId: 'docs||2', title: 'Parent' },
      },
    });
    await flushAllTimers();
    expect((await create).unwrap().kind).toBe('queued');
    t.rejectedValues.add('Parent');
    await t.goOnline();
    t.rejectedValues.clear();

    // Then edits the doc and moves it under the parent: the edit waits for
    // the parent's creation. It may still be sent, so the older failed edit
    // is flagged instead of following it
    t.goOffline();
    expect(
      await t.editDocWith({
        docId: 'docs||1',
        parentId: 'docs||2',
        changes: { body: 'v2' },
      }),
    ).toBe('queued');
    expect(t.getResolutions()).toMatchInlineSnapshot(`
      - error: 'rejected T1 v1'
        hasNewerChanges: '✅'
        input: 'changes: body: "v1", title: "T1", docId: "docs||1", parentId: undefined'
        kind: 'retry-exhausted'
        on: 'item:docs||1'
        op: 'editDoc'
      - blocks: 1
        error: 'rejected Parent'
        input: 'docId: "docs||2", title: "Parent"'
        kind: 'retry-exhausted'
        on: 'item:docs||2'
        op: 'createDoc'
      - blockedBy: 1
        error: 'Blocked by unresolved dependency'
        input: 'changes: body: "v2", title: undefined, docId: "docs||1", parentId: "docs||2"'
        kind: 'retry-exhausted'
        on: 'item:docs||1'
        op: 'editDoc'
    `);
  });
});

describe('an operation with supersedes', () => {
  test('a failed status change is dropped once a newer status is saved online', async () => {
    const t = createDocsEnv();

    network.setOffline();
    await t.setStatus('archived');
    t.rejectedValues.add('archived');
    await t.goOnline();
    expect(t.getResolutions()).toMatchInlineSnapshot(`
      - error: 'rejected archived'
        input: 'docId: "docs||1", status: "archived"'
        kind: 'retry-exhausted'
        on: 'item:docs||1'
        op: 'setStatus'
    `);

    // The newer status replaces the failed one: nothing is left to decide,
    // so no "Try again" can bring the older status back
    expect(await t.setStatus('published')).toBe('online');
    expect(t.getResolutions()).toMatchInlineSnapshot(`[]`);
    expect(t.getServerDoc().status).toBe('published');
    expect(t.getLocalDoc()?.status).toBe('published');
  });

  test('a failed status change is dropped when a newer status is queued offline, and only the newer one is sent', async () => {
    const t = createDocsEnv();

    network.setOffline();
    await t.setStatus('archived');
    t.rejectedValues.add('archived');
    await t.goOnline();
    t.rejectedValues.clear();

    t.goOffline();
    expect(await t.setStatus('published')).toBe('queued');
    expect(t.getResolutions()).toMatchInlineSnapshot(`[]`);

    await t.goOnline();
    expect(t.replayed).toMatchInlineSnapshot(`['setStatus published']`);
    expect(t.getServerDoc().status).toBe('published');
  });

  test('a status change queued while an older one was being retried replaces it once it fails', async () => {
    const t = createDocsEnv();

    // The first status change fails once: the replay keeps it to check it
    // again, so a newer one is queued behind it instead of replacing it
    network.setOffline();
    await t.setStatus('archived');
    t.rejectedValues.add('archived');
    await t.goOnlineUntilFirstReplayAttempt();
    expect(t.getResolutions()).toMatchInlineSnapshot(`[]`);
    t.goOffline();
    expect(await t.setStatus('published')).toBe('queued');

    // Back online the first one fails for good: the newer one replaces it,
    // so no decision is left, and the newer one is sent
    await t.goOnline();
    expect(t.getResolutions()).toMatchInlineSnapshot(`[]`);
    expect(t.replayed).toMatchInlineSnapshot(`['setStatus published']`);
    expect(t.getServerDoc().status).toBe('published');
  });
});

describe('an operation with neither accumulation nor supersedes', () => {
  test('a failed rename is flagged once a newer rename is saved, and retrying it still sends it', async () => {
    const t = createDocsEnv();

    network.setOffline();
    await t.renameDoc('T1');
    t.rejectedValues.add('T1');
    await t.goOnline();
    t.rejectedValues.clear();
    expect(t.getResolutions()).toMatchInlineSnapshot(`
      - error: 'rejected T1'
        input: 'docId: "docs||1", title: "T1"'
        kind: 'retry-exhausted'
        on: 'item:docs||1'
        op: 'renameDoc'
    `);

    // TSDF cannot tell whether the newer rename makes the failed one
    // obsolete: the failed change is flagged, so the UI can warn that
    // sending it again overwrites the newer title
    expect(await t.renameDoc('T2')).toBe('online');
    expect(t.getResolutions()).toMatchInlineSnapshot(`
      - error: 'rejected T1'
        hasNewerChanges: '✅'
        input: 'docId: "docs||1", title: "T1"'
        kind: 'retry-exhausted'
        on: 'item:docs||1'
        op: 'renameDoc'
    `);

    // A session-wide panel sees the flag too
    expect(
      t.storeManager
        .getOfflineResolutions()
        .map((resolution) => resolution.hasNewerChanges),
    ).toMatchInlineSnapshot(`['✅']`);

    // Retrying anyway is the user's call: the older title is sent
    expect(await t.retryFailedChange()).toBe(true);
    expect(t.getServerDoc().title).toBe('T1');
  });

  test('a failed edit is flagged by a newer change of another operation of the doc', async () => {
    const t = createDocsEnv();

    network.setOffline();
    await t.editDoc({ title: 'T1' });
    t.rejectedValues.add('T1');
    await t.goOnline();
    t.rejectedValues.clear();

    // A rename does not merge into an edit: the edit would overwrite the
    // newer title if it were sent again
    t.goOffline();
    expect(await t.renameDoc('T2')).toBe('queued');
    expect(t.getResolutions()).toMatchInlineSnapshot(`
      - error: 'rejected T1'
        hasNewerChanges: '✅'
        input: 'changes: body: undefined, title: "T1", docId: "docs||1", parentId: undefined'
        kind: 'retry-exhausted'
        on: 'item:docs||1'
        op: 'editDoc'
    `);
  });
});
