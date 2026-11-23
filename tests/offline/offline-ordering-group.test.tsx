import { act } from 'react';
import { rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { CollectionOfflineOperationDefinition } from '../../src/main';
import { createStoreManager } from '../../src/storeManager';
import { createOfflineNetworkMock } from '../../src/testing';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import { createReplayFailure } from './offlineReplayTestShared';
import { summarizeResolution } from './offlineTestShared';

type Message = { chatId: string; text: string };

type MessageInput = { id: string; chatId: string; text: string };

const messageInputSchema = rc_object({
  id: rc_string,
  chatId: rc_string,
  text: rc_string,
});

/** Time the photo upload takes before the message is inserted */
const PHOTO_UPLOAD_MS = 3_000;

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

type ChatOperations = {
  sendMessage: CollectionOfflineOperationDefinition<
    Message,
    string,
    MessageInput
  >;
  /** A message with a photo: the photo is uploaded first, which is slow */
  sendPhoto: CollectionOfflineOperationDefinition<
    Message,
    string,
    MessageInput
  >;
  deleteMessage: CollectionOfflineOperationDefinition<
    Message,
    string,
    { id: string }
  >;
};

function createChatEnv() {
  const sessionKey = 'chat-session';
  /**
   * Messages in the order the server inserted them: the server sets their
   * creation time on insert, so this is the order every member sees
   */
  const inserted: string[] = [];
  /** Messages the server rejects */
  const rejectedTexts = new Set<string>();

  async function insertMessage(input: MessageInput, durationMs?: number) {
    if (rejectedTexts.has(input.text)) {
      throw createReplayFailure(`rejected ${input.text}`);
    }
    await env.serverTable.delayedSetItem(
      input.id,
      { chatId: input.chatId, text: input.text },
      { durationMs },
    );
    inserted.push(`${input.chatId}: ${input.text}`);
  }

  const storeManager = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: { network: network.config },
  });

  const env = createCollectionStoreTestEnv<Message, ChatOperations>(
    {},
    {
      id: 'messages',
      getSessionKey: () => sessionKey,
      storeManager,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: rc_object({
          value: rc_object({ chatId: rc_string, text: rc_string }),
        }),
        payloadSchema: rc_string,
        offline: {
          operations: {
            sendMessage: {
              inputSchema: messageInputSchema,
              kind: 'create',
              getEntityRefs: ({ input }) => [input.id],
              orderingGroup: ({ input }) => `chat:${input.chatId}`,
              execute: ({ input }) => insertMessage(input),
              onSuccessExecute: () => {},
            },
            sendPhoto: {
              inputSchema: messageInputSchema,
              kind: 'create',
              getEntityRefs: ({ input }) => [input.id],
              // The same group as text messages: the chat keeps one order
              orderingGroup: ({ input }) => `chat:${input.chatId}`,
              execute: ({ input }) => insertMessage(input, PHOTO_UPLOAD_MS),
              onSuccessExecute: () => {},
            },
            deleteMessage: {
              inputSchema: rc_object({ id: rc_string }),
              kind: 'delete',
              getEntityRefs: ({ input }) => [input.id],
              supersedes: {
                scope: 'same-entity',
                dropSelfIfTempLifecycleCancelled: true,
              },
              execute: async ({ input }) => {
                await env.serverTable.delayedRemoveItem(input.id);
              },
              onSuccessExecute: () => {},
            },
          },
        },
      },
    },
  );

  let nextId = 1;

  /**
   * Sends a message like the chat composer does, and resolves to whether it
   * was sent online or queued (without waiting for the queue to replay it)
   */
  async function send(
    chatId: string,
    text: string,
    operation: 'sendMessage' | 'sendPhoto' = 'sendMessage',
  ): Promise<string> {
    const input = { id: `messages||${nextId}`, chatId, text };
    nextId += 1;
    const result = env.apiStore.performMutation(input.id, {
      mutation: async () => {
        await insertMessage(
          input,
          operation === 'sendPhoto' ? PHOTO_UPLOAD_MS : undefined,
        );
        return { value: { chatId, text } };
      },
      offline: { operation, input },
    });
    // Lets the request, and the queue replay it may start, finish
    await flushAllTimers();
    return (await result).unwrap().kind;
  }

  return {
    env,
    sessionKey,
    storeManager,
    inserted,
    rejectedTexts,
    send,
    deleteMessage: async (id: string) => {
      const result = env.apiStore.performMutation(id, {
        mutation: async () => {
          await env.serverTable.delayedRemoveItem(id);
          return null;
        },
        offline: { operation: 'deleteMessage', input: { id } },
      });
      await flushAllTimers();
      return (await result).unwrap().kind;
    },
    /** Goes online and lets the queue start replaying */
    goOnline: async () => {
      act(() => network.goOnline());
      await advanceTime(100);
    },
  };
}

test('a message sent while the older offline messages of its chat replay is queued behind them, and every member sees the chat in the order it was written', async () => {
  const t = createChatEnv();

  // Offline, the user sends a photo and a text message to the chat
  network.setOffline();
  expect(await t.send('chat-1', 'photo', 'sendPhoto')).toBe('queued');
  expect(await t.send('chat-1', 'first')).toBe('queued');

  // Back online the photo uploads first, which takes a few seconds. The user
  // writes another message meanwhile: sent on its own it would reach the
  // server first, so it is queued behind them
  await t.goOnline();
  expect(t.inserted).toMatchInlineSnapshot(`[]`);
  expect(await t.send('chat-1', 'second')).toBe('queued');

  await flushAllTimers();
  expect(t.inserted).toMatchInlineSnapshot(
    `['chat-1: photo', 'chat-1: first', 'chat-1: second']`,
  );
});

test('a message of another chat is sent right away while the queued messages of a chat replay', async () => {
  const t = createChatEnv();

  network.setOffline();
  await t.send('chat-1', 'photo', 'sendPhoto');
  await t.goOnline();

  // Chat 2 has no older message waiting: nothing delays it
  expect(await t.send('chat-2', 'hello')).toBe('online');
  await flushAllTimers();
  expect(t.inserted).toMatchInlineSnapshot(
    `['chat-2: hello', 'chat-1: photo']`,
  );
});

test('a message of the chat whose older message failed for good is not held behind it', async () => {
  const t = createChatEnv();

  network.setOffline();
  await t.send('chat-1', 'rejected');
  await t.send('chat-1', 'first');
  t.rejectedTexts.add('rejected');

  // The rejected message waits for a decision, out of the queue: the next
  // message of the chat is still sent
  act(() => network.goOnline());
  await flushAllTimers();
  expect(t.env.apiStore.getOfflineResolutions().map(summarizeResolution))
    .toMatchInlineSnapshot(`
    - error: 'rejected rejected'
      input: 'chatId: "chat-1", id: "messages||1", text: "rejected"'
      kind: 'retry-exhausted'
      on: 'item:messages||1'
      op: 'sendMessage'
  `);
  expect(t.inserted).toMatchInlineSnapshot(`['chat-1: first']`);

  // With nothing left in the queue, a new message runs online
  expect(await t.send('chat-1', 'second')).toBe('online');
  await flushAllTimers();
  expect(t.inserted).toMatchInlineSnapshot(
    `['chat-1: first', 'chat-1: second']`,
  );
});

test('deleting an older unsent message of the chat does not drop the newer ones', async () => {
  const t = createChatEnv();

  network.setOffline();
  await t.send('chat-1', 'typo');
  await t.send('chat-1', 'fixed');

  // The ordering group ties no message to another: deleting the unsent one
  // cancels only it
  expect(await t.deleteMessage('messages||1')).toBe('queued');
  act(() => network.goOnline());
  await flushAllTimers();

  expect(t.inserted).toMatchInlineSnapshot(`['chat-1: fixed']`);
  expect(t.env.serverTable.getAll()).toMatchInlineSnapshot(
    `messages||2: { chatId: 'chat-1', text: 'fixed' }`,
  );
});

test('the ordering group spans the stores of the session: a poll posted while the chat messages replay is sent after them', async () => {
  const t = createChatEnv();
  type PollOperations = {
    createPoll: CollectionOfflineOperationDefinition<
      { chatId: string; question: string },
      string,
      { id: string; chatId: string; question: string }
    >;
  };
  const polls = createCollectionStoreTestEnv<
    { chatId: string; question: string },
    PollOperations
  >(
    {},
    {
      id: 'polls',
      getSessionKey: () => t.sessionKey,
      storeManager: t.storeManager,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: rc_object({
          value: rc_object({ chatId: rc_string, question: rc_string }),
        }),
        payloadSchema: rc_string,
        offline: {
          operations: {
            createPoll: {
              inputSchema: rc_object({
                id: rc_string,
                chatId: rc_string,
                question: rc_string,
              }),
              kind: 'create',
              getEntityRefs: ({ input }) => [input.id],
              // Same key as the messages of the chat
              orderingGroup: ({ input }) => `chat:${input.chatId}`,
              execute: async ({ input }) => {
                await polls.serverTable.delayedSetItem(input.id, input);
                t.inserted.push(`${input.chatId}: poll ${input.question}`);
              },
              onSuccessExecute: () => {},
            },
          },
        },
      },
    },
  );

  network.setOffline();
  await t.send('chat-1', 'photo', 'sendPhoto');
  await t.goOnline();

  const input = { id: 'polls||1', chatId: 'chat-1', question: 'lunch?' };
  const result = polls.apiStore.performMutation(input.id, {
    mutation: async () => {
      await polls.serverTable.delayedSetItem(input.id, input);
      t.inserted.push(`chat-1: poll lunch?`);
      return null;
    },
    offline: { operation: 'createPoll', input },
  });
  await flushAllTimers();

  // Queued behind the photo of the messages store, and sent after it
  expect((await result).unwrap().kind).toBe('queued');
  expect(t.inserted).toMatchInlineSnapshot(
    `['chat-1: photo', 'chat-1: poll lunch?']`,
  );
});
