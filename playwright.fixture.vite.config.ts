import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

type DocumentState = { value: number };

type CollectionItem = { name: string };

type UserRow = { id: number; name: string };

const workspaceRoot = fileURLToPath(new URL('.', import.meta.url));
const fixtureRoot = resolve(workspaceRoot, 'playwright-fixture');

type FixtureState = {
  document: DocumentState;
  collection: Record<string, CollectionItem>;
  users: UserRow[];
};

function createDefaultState(): FixtureState {
  return {
    document: { value: 0 },
    collection: { item1: { name: 'Item 1' }, item2: { name: 'Item 2' } },
    users: [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {} as T;
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  const json = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(json);
}

function parseFields(searchParams: URLSearchParams): string[] | undefined {
  const raw = searchParams.get('fields');
  if (!raw) return undefined;

  return raw
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean);
}

function selectFields<T extends Record<string, unknown>>(
  item: T,
  fields: string[] | undefined,
): T {
  if (!fields || fields.length === 0) {
    return item;
  }

  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in item) {
      result[field] = item[field];
    }
  }
  return result as T;
}

type RequestHistoryEntry = {
  method: string;
  path: string;
  pageId: string | null;
  timestamp: number;
};

type FixtureApiScope = {
  requestHistory: RequestHistoryEntry[];
  state: FixtureState;
};

function createFixtureApiScope(): FixtureApiScope {
  return { requestHistory: [], state: createDefaultState() };
}

function createFixtureApiPlugin(): Plugin {
  const scopes = new Map<string, FixtureApiScope>();

  function getScopeId(req: IncomingMessage, url: URL): string {
    const headerScopeId = req.headers['x-scope-id'];
    if (typeof headerScopeId === 'string' && headerScopeId) {
      return headerScopeId;
    }

    return url.searchParams.get('scopeId') ?? 'default';
  }

  function getScope(scopeId: string): FixtureApiScope {
    const currentScope = scopes.get(scopeId);
    if (currentScope) return currentScope;

    const scope = createFixtureApiScope();
    scopes.set(scopeId, scope);
    return scope;
  }

  function resetScope(scopeId: string): void {
    scopes.set(scopeId, createFixtureApiScope());
  }

  function addHistoryEntry(
    scope: FixtureApiScope,
    req: IncomingMessage,
    pathname: string,
  ): void {
    scope.requestHistory.push({
      method: req.method ?? 'GET',
      path: pathname,
      pageId:
        typeof req.headers['x-page-id'] === 'string'
          ? req.headers['x-page-id']
          : null,
      timestamp: Date.now(),
    });
  }

  return {
    name: 'tsdf-playwright-fixture-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url) {
          next();
          return;
        }

        const url = new URL(req.url, 'http://127.0.0.1:42173');
        const { pathname, searchParams } = url;
        const scopeId = getScopeId(req, url);
        const scope = getScope(scopeId);

        if (pathname === '/api/test/reset' && req.method === 'POST') {
          resetScope(scopeId);
          sendJson(res, 200, { ok: true });
          return;
        }

        if (pathname === '/api/test/history/reset' && req.method === 'POST') {
          scope.requestHistory = [];
          sendJson(res, 200, { ok: true });
          return;
        }

        if (pathname === '/api/test/history' && req.method === 'GET') {
          sendJson(res, 200, { history: scope.requestHistory });
          return;
        }

        if (pathname === '/api/document' && req.method === 'GET') {
          addHistoryEntry(scope, req, pathname);
          await sleep(75);
          sendJson(res, 200, scope.state.document);
          return;
        }

        if (pathname === '/api/document/set' && req.method === 'POST') {
          const body = await readJsonBody<{ value: number }>(req);
          scope.state.document = { value: body.value };
          sendJson(res, 200, scope.state.document);
          return;
        }

        if (pathname === '/api/document/mutate' && req.method === 'POST') {
          const body = await readJsonBody<{ value: number; delayMs?: number }>(
            req,
          );
          addHistoryEntry(scope, req, pathname);
          await sleep(body.delayMs ?? 0);
          scope.state.document = { value: body.value };
          sendJson(res, 200, scope.state.document);
          return;
        }

        const collectionItemMatch = pathname.match(
          /^\/api\/collection\/([^/]+)$/,
        );
        if (collectionItemMatch && req.method === 'GET') {
          const itemId = collectionItemMatch[1];
          const item = itemId ? scope.state.collection[itemId] : undefined;

          if (!item) {
            sendJson(res, 404, {
              message: `Unknown collection item: ${itemId}`,
            });
            return;
          }

          addHistoryEntry(scope, req, pathname);
          await sleep(75);
          sendJson(res, 200, item);
          return;
        }

        if (pathname === '/api/collection/batch' && req.method === 'GET') {
          const itemIds = (searchParams.get('itemIds') ?? '')
            .split(',')
            .map((itemId) => itemId.trim())
            .filter(Boolean);

          addHistoryEntry(scope, req, pathname);
          await sleep(75);
          sendJson(res, 200, {
            items: itemIds.map((itemId) => ({
              itemId,
              data: scope.state.collection[itemId] ?? null,
            })),
          });
          return;
        }

        const collectionMutationMatch = pathname.match(
          /^\/api\/collection\/([^/]+)\/mutate$/,
        );
        if (collectionMutationMatch && req.method === 'POST') {
          const itemId = collectionMutationMatch[1];
          if (!itemId || !scope.state.collection[itemId]) {
            sendJson(res, 404, {
              message: `Unknown collection item: ${itemId}`,
            });
            return;
          }

          const body = await readJsonBody<{ name: string; delayMs?: number }>(
            req,
          );
          addHistoryEntry(scope, req, pathname);
          await sleep(body.delayMs ?? 0);
          const updatedItem = { name: body.name };
          scope.state.collection[itemId] = updatedItem;
          sendJson(res, 200, updatedItem);
          return;
        }

        if (pathname === '/api/list' && req.method === 'GET') {
          const tableId = searchParams.get('tableId');
          if (tableId !== 'users') {
            sendJson(res, 404, { message: `Unknown table: ${tableId}` });
            return;
          }

          const offset = Number(searchParams.get('offset') ?? 0);
          const limit = Number(
            searchParams.get('limit') ?? scope.state.users.length,
          );
          const users = scope.state.users.slice(offset, offset + limit);

          addHistoryEntry(scope, req, pathname);
          await sleep(75);
          sendJson(res, 200, {
            items: users.map((user) => ({
              itemPayload: `users||${user.id}`,
              data: user,
            })),
            hasMore: offset + limit < scope.state.users.length,
          });
          return;
        }

        const itemMatch = pathname.match(/^\/api\/item\/([^/]+)\/([^/]+)$/);
        if (itemMatch && req.method === 'GET') {
          const tableId = itemMatch[1];
          const itemId = Number(itemMatch[2]);

          if (tableId !== 'users') {
            sendJson(res, 404, { message: `Unknown table: ${tableId}` });
            return;
          }

          const item = scope.state.users.find((user) => user.id === itemId);
          if (!item) {
            sendJson(res, 404, { message: `Unknown user: ${itemId}` });
            return;
          }

          addHistoryEntry(scope, req, pathname);
          await sleep(75);
          sendJson(res, 200, selectFields(item, parseFields(searchParams)));
          return;
        }

        const itemMutationMatch = pathname.match(
          /^\/api\/item\/([^/]+)\/([^/]+)\/mutate$/,
        );
        if (itemMutationMatch && req.method === 'POST') {
          const tableId = itemMutationMatch[1];
          const itemId = Number(itemMutationMatch[2]);

          if (tableId !== 'users') {
            sendJson(res, 404, { message: `Unknown table: ${tableId}` });
            return;
          }

          const body = await readJsonBody<{
            patch: Partial<UserRow>;
            delayMs?: number;
          }>(req);
          const index = scope.state.users.findIndex(
            (user) => user.id === itemId,
          );

          if (index === -1) {
            sendJson(res, 404, { message: `Unknown user: ${itemId}` });
            return;
          }

          addHistoryEntry(scope, req, pathname);
          await sleep(body.delayMs ?? 0);
          const current = scope.state.users[index];
          if (!current) {
            sendJson(res, 404, { message: `Unknown user: ${itemId}` });
            return;
          }

          scope.state.users[index] = { ...current, ...body.patch };
          sendJson(res, 200, scope.state.users[index]);
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig({
  root: fixtureRoot,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@src': resolve(workspaceRoot, 'src') } },
  server: { fs: { allow: [workspaceRoot] }, port: 42173, strictPort: true },
  plugins: [createFixtureApiPlugin()],
});
