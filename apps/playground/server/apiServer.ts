import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { z } from 'zod';
import {
  BEACON_PROJECT_PAYLOAD,
  COPPER_PROJECT_PAYLOAD,
  ATLAS_PROJECT_PAYLOAD,
  contactFilterSchema,
  contactSchema,
  projectKey,
  projectPayloadSchema,
  realtimeEventSchema,
  selectContactFields,
  type ContactFilter,
  type ContactRecord,
  type PlaygroundRealtimeEvent,
  type ProfileDocument,
  type Project,
  type ProjectPayload,
} from '../src/apiTypes.ts';

type Database = {
  profile: ProfileDocument;
  projects: Record<string, Project>;
  contacts: Record<string, ContactRecord>;
  nextContactNumber: number;
};

const PORT = Number(process.env.TSDF_PLAYGROUND_API_PORT ?? 5174);
const delayMs = { document: 260, collection: 320, list: 360, mutation: 420 };
const dataDirUrl = new URL('../.playground-data/', import.meta.url);
const dbFileUrl = new URL('db.json', dataDirUrl);
const eventClients = new Set<ServerResponse>();

let db: Database | null = null;

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function stamp(): string {
  return new Date().toISOString();
}

function createSeedDatabase(): Database {
  const now = stamp();

  const profile: ProfileDocument = {
    name: 'Ari Workbench',
    plan: 'Pro',
    credits: 42,
    tags: [
      { id: 'tag-critical', label: 'Critical path' },
      { id: 'tag-billing', label: 'Billing' },
    ],
    updatedAt: now,
  };

  const projects: Record<string, Project> = {
    [projectKey(ATLAS_PROJECT_PAYLOAD)]: {
      id: 'atlas',
      name: 'Atlas UI refresh',
      health: 'green',
      tasks: [
        { id: 'brief', title: 'Rewrite IA brief', done: true },
        { id: 'prototype', title: 'Prototype dense table states', done: false },
      ],
      updatedAt: now,
    },
    [projectKey(BEACON_PROJECT_PAYLOAD)]: {
      id: 'beacon',
      name: 'Beacon alerts',
      health: 'yellow',
      tasks: [
        { id: 'schema', title: 'Lock event schema', done: true },
        { id: 'rollout', title: 'Roll out to beta cohort', done: false },
      ],
      updatedAt: now,
    },
    [projectKey(COPPER_PROJECT_PAYLOAD)]: {
      id: 'copper',
      name: 'Copper onboarding',
      health: 'red',
      tasks: [
        { id: 'copy', title: 'Tighten empty state copy', done: false },
        { id: 'handoff', title: 'Hand off CRM mappings', done: false },
      ],
      updatedAt: now,
    },
  };

  const contacts = Object.fromEntries(
    [
      {
        id: 'ada',
        name: 'Ada Lovelace',
        email: 'ada@example.dev',
        team: 'engineering',
        status: 'active',
        notes: 'Owns orchestration and scheduling examples.',
      },
      {
        id: 'grace',
        name: 'Grace Hopper',
        email: 'grace@example.dev',
        team: 'engineering',
        status: 'active',
        notes: 'Good record for item detail fetching.',
      },
      {
        id: 'maya',
        name: 'Maya Chen',
        email: 'maya@example.dev',
        team: 'design',
        status: 'paused',
        notes: 'Use for derived paused filters.',
      },
      {
        id: 'lin',
        name: 'Lin Park',
        email: 'lin@example.dev',
        team: 'product',
        status: 'active',
        notes: 'Representative product contact.',
      },
      {
        id: 'nora',
        name: 'Nora Patel',
        email: 'nora@example.dev',
        team: 'design',
        status: 'active',
        notes: 'Shows partial resource merging.',
      },
      {
        id: 'sam',
        name: 'Sam Rivera',
        email: 'sam@example.dev',
        team: 'product',
        status: 'paused',
        notes: 'Useful for invalidation demos.',
      },
      {
        id: 'toni',
        name: 'Toni Ivers',
        email: 'toni@example.dev',
        team: 'engineering',
        status: 'paused',
        notes: 'Batch item fetch candidate.',
      },
    ].map((contact) => [
      contact.id,
      contactSchema.required().parse({ ...contact, updatedAt: now }),
    ]),
  );

  return { profile, projects, contacts, nextContactNumber: 1 };
}

async function loadDatabase(): Promise<Database> {
  if (db) return db;

  try {
    db = JSON.parse(await readFile(dbFileUrl, 'utf8')) as Database;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      db = createSeedDatabase();
      await persistDatabase();
    } else {
      throw error;
    }
  }

  return db;
}

async function persistDatabase(): Promise<void> {
  if (!db) return;

  await mkdir(dataDirUrl, { recursive: true });
  await writeFile(dbFileUrl, `${JSON.stringify(db, null, 2)}\n`);
}

async function delayed<T>(ms: number, read: () => T | Promise<T>): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return structuredClone(await read());
}

function requireProject(database: Database, payload: ProjectPayload): Project {
  const project = database.projects[projectKey(payload)];

  if (!project) {
    throw new HttpError(404, `Project ${payload.projectId} was not found`);
  }

  return project;
}

function requireContact(database: Database, id: string): ContactRecord {
  const contact = database.contacts[id];

  if (!contact) {
    throw new HttpError(404, `Contact ${id} was not found`);
  }

  return contact;
}

function matchesFilter(contact: ContactRecord, filter: ContactFilter): boolean {
  return (
    (filter.team === 'all' || contact.team === filter.team) &&
    (filter.status === 'all' || contact.status === filter.status)
  );
}

function sortedContacts(
  database: Database,
  filter: ContactFilter,
): ContactRecord[] {
  return Object.values(database.contacts)
    .filter((contact) => matchesFilter(contact, filter))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader(
    'Access-Control-Allow-Methods',
    'GET,POST,PATCH,DELETE,OPTIONS',
  );
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(
  response: ServerResponse,
  status: number,
  data: unknown,
): void {
  setCorsHeaders(response);
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(data));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = '';

  for await (const chunk of request) {
    body += chunk;
  }

  if (!body) return {};

  return JSON.parse(body) as unknown;
}

function readJsonParam(url: URL, name: string): unknown {
  const rawValue = url.searchParams.get(name);

  if (rawValue === null) {
    return undefined;
  }

  return JSON.parse(rawValue) as unknown;
}

function broadcast(event: PlaygroundRealtimeEvent): void {
  const data = realtimeEventSchema.parse(event);
  const frame = `data: ${JSON.stringify(data)}\n\n`;

  for (const client of eventClients) {
    client.write(frame);
  }
}

function openEventStream(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  setCorsHeaders(response);
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  response.write(': connected\n\n');

  eventClients.add(response);
  const heartbeat = setInterval(() => {
    response.write(': heartbeat\n\n');
  }, 25_000);

  request.on('close', () => {
    clearInterval(heartbeat);
    eventClients.delete(response);
  });
}

async function handleRoute(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  setCorsHeaders(response);

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(
    request.url ?? '/',
    `http://${request.headers.host ?? 'localhost'}`,
  );

  if (request.method === 'GET' && url.pathname === '/api/events') {
    openEventStream(request, response);
    return;
  }

  const database = await loadDatabase();

  if (request.method === 'GET' && url.pathname === '/api/profile') {
    sendJson(
      response,
      200,
      await delayed(delayMs.document, () => database.profile),
    );
    return;
  }

  if (request.method === 'PATCH' && url.pathname === '/api/profile/name') {
    const { name } = z
      .object({ name: z.string() })
      .parse(await readJson(request));
    const profile = await delayed(delayMs.mutation, async () => {
      database.profile = { ...database.profile, name, updatedAt: stamp() };
      await persistDatabase();
      return database.profile;
    });

    broadcast({ kind: 'profileChanged' });
    sendJson(response, 200, profile);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/profile/credits') {
    const { amount } = z
      .object({ amount: z.number() })
      .parse(await readJson(request));
    const profile = await delayed(delayMs.mutation, async () => {
      database.profile = {
        ...database.profile,
        credits: database.profile.credits + amount,
        updatedAt: stamp(),
      };
      await persistDatabase();
      return database.profile;
    });

    broadcast({ kind: 'profileChanged' });
    sendJson(response, 200, profile);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/profile/tags') {
    const { label } = z
      .object({ label: z.string() })
      .parse(await readJson(request));
    const profile = await delayed(delayMs.mutation, async () => {
      database.profile = {
        ...database.profile,
        tags: [
          ...database.profile.tags,
          { id: `tag-${label.toLowerCase().replaceAll(' ', '-')}`, label },
        ],
        updatedAt: stamp(),
      };
      await persistDatabase();
      return database.profile;
    });

    broadcast({ kind: 'profileChanged' });
    sendJson(response, 200, profile);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/projects/item') {
    const payload = projectPayloadSchema.parse(readJsonParam(url, 'payload'));
    sendJson(
      response,
      200,
      await delayed(delayMs.collection, () =>
        requireProject(database, payload),
      ),
    );
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/projects/batch') {
    const { payloads } = z
      .object({ payloads: z.array(projectPayloadSchema), batchKey: z.string() })
      .parse({
        payloads: readJsonParam(url, 'payloads'),
        batchKey: readJsonParam(url, 'batchKey'),
      });
    const result = await delayed(delayMs.collection, () =>
      payloads.map((payload) => {
        try {
          return { payload, data: requireProject(database, payload) };
        } catch (error) {
          return {
            payload,
            error: error instanceof Error ? error.message : 'Unknown error',
          };
        }
      }),
    );

    sendJson(response, 200, result);
    return;
  }

  if (request.method === 'PATCH' && url.pathname === '/api/projects/name') {
    const { payload, name } = z
      .object({ payload: projectPayloadSchema, name: z.string() })
      .parse(await readJson(request));
    const project = await delayed(delayMs.mutation, async () => {
      const currentProject = requireProject(database, payload);
      const nextProject = { ...currentProject, name, updatedAt: stamp() };
      database.projects[projectKey(payload)] = nextProject;
      await persistDatabase();
      return nextProject;
    });

    broadcast({ kind: 'projectChanged', payload });
    sendJson(response, 200, project);
    return;
  }

  if (
    request.method === 'POST' &&
    url.pathname === '/api/projects/toggle-first-task'
  ) {
    const { payload } = z
      .object({ payload: projectPayloadSchema })
      .parse(await readJson(request));
    const project = await delayed(delayMs.mutation, async () => {
      const currentProject = requireProject(database, payload);
      const firstTask = currentProject.tasks[0];

      if (!firstTask) {
        return currentProject;
      }

      const nextProject = {
        ...currentProject,
        tasks: [
          { ...firstTask, done: !firstTask.done },
          ...currentProject.tasks.slice(1),
        ],
        updatedAt: stamp(),
      };

      database.projects[projectKey(payload)] = nextProject;
      await persistDatabase();
      return nextProject;
    });

    broadcast({ kind: 'projectChanged', payload });
    sendJson(response, 200, project);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/contacts/list') {
    const { filter, offset, limit, fields } = z
      .object({
        filter: contactFilterSchema,
        offset: z.number(),
        limit: z.number(),
        fields: z.array(z.string()).optional(),
      })
      .parse({
        filter: readJsonParam(url, 'filter'),
        offset: readJsonParam(url, 'offset'),
        limit: readJsonParam(url, 'limit'),
        fields: readJsonParam(url, 'fields'),
      });
    const result = await delayed(delayMs.list, () => {
      const rows = sortedContacts(database, filter);
      const page = rows.slice(offset, offset + limit);

      return {
        items: page.map((contact) => ({
          itemPayload: contact.id,
          data: selectContactFields(contact, fields),
        })),
        hasMore: rows.length > offset + limit,
      };
    });

    sendJson(response, 200, result);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/contacts/item') {
    const { id, fields } = z
      .object({ id: z.string(), fields: z.array(z.string()).optional() })
      .parse({
        id: readJsonParam(url, 'id'),
        fields: readJsonParam(url, 'fields'),
      });
    sendJson(
      response,
      200,
      await delayed(delayMs.list, () =>
        selectContactFields(requireContact(database, id), fields),
      ),
    );
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/contacts/batch') {
    const { requests } = z
      .object({
        requests: z.array(
          z.object({
            payload: z.string(),
            fields: z.array(z.string()).optional(),
          }),
        ),
        batchKey: z.string(),
      })
      .parse({
        requests: readJsonParam(url, 'requests'),
        batchKey: readJsonParam(url, 'batchKey'),
      });
    const result = await delayed(delayMs.list, () =>
      requests.map((itemRequest) => {
        try {
          return {
            payload: itemRequest.payload,
            data: selectContactFields(
              requireContact(database, itemRequest.payload),
              itemRequest.fields,
            ),
          };
        } catch (error) {
          return {
            payload: itemRequest.payload,
            error: error instanceof Error ? error.message : 'Unknown error',
          };
        }
      }),
    );

    sendJson(response, 200, result);
    return;
  }

  if (request.method === 'PATCH' && url.pathname === '/api/contacts/name') {
    const { id, name } = z
      .object({ id: z.string(), name: z.string() })
      .parse(await readJson(request));
    const contact = await delayed(delayMs.mutation, async () => {
      const currentContact = requireContact(database, id);
      const nextContact = { ...currentContact, name, updatedAt: stamp() };
      database.contacts[id] = nextContact;
      await persistDatabase();
      return nextContact;
    });

    broadcast({ kind: 'contactsChanged', itemId: id });
    sendJson(response, 200, contact);
    return;
  }

  if (
    request.method === 'POST' &&
    url.pathname === '/api/contacts/toggle-status'
  ) {
    const { id } = z.object({ id: z.string() }).parse(await readJson(request));
    const contact = await delayed(delayMs.mutation, async () => {
      const currentContact = requireContact(database, id);
      const nextContact: ContactRecord = {
        ...currentContact,
        status: currentContact.status === 'active' ? 'paused' : 'active',
        updatedAt: stamp(),
      };
      database.contacts[id] = nextContact;
      await persistDatabase();
      return nextContact;
    });

    broadcast({ kind: 'contactsChanged', itemId: id });
    sendJson(response, 200, contact);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/contacts') {
    const contact = await delayed(delayMs.mutation, async () => {
      const contactNumber = database.nextContactNumber;
      const id = `new-${contactNumber}`;
      const nextContact: ContactRecord = {
        id,
        name: `New Contact ${contactNumber}`,
        email: `${id}@example.dev`,
        team: contactNumber % 2 === 0 ? 'design' : 'engineering',
        status: 'active',
        notes: 'Created from the playground.',
        updatedAt: stamp(),
      };

      database.nextContactNumber += 1;
      database.contacts[id] = nextContact;
      await persistDatabase();
      return nextContact;
    });

    broadcast({ kind: 'contactsChanged', itemId: contact.id });
    sendJson(response, 200, contact);
    return;
  }

  if (request.method === 'DELETE' && url.pathname === '/api/contacts/delete') {
    const { id } = z.object({ id: z.string() }).parse(await readJson(request));
    await delayed(delayMs.mutation, async () => {
      requireContact(database, id);
      delete database.contacts[id];
      await persistDatabase();
    });

    broadcast({ kind: 'contactsChanged', itemId: id });
    sendJson(response, 200, { id });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/reset') {
    db = createSeedDatabase();
    await persistDatabase();
    broadcast({ kind: 'reset' });
    sendJson(response, 200, { ok: true });
    return;
  }

  throw new HttpError(
    404,
    `Route ${request.method ?? 'GET'} ${url.pathname} was not found`,
  );
}

const server = createServer((request, response) => {
  void handleRoute(request, response).catch((error) => {
    const status = error instanceof HttpError ? error.status : 500;
    const message =
      error instanceof Error ? error.message : 'Unknown server error';

    sendJson(response, status, { message });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `TSDF playground API server listening on http://127.0.0.1:${PORT}`,
  );
  console.log(`Persistent data file: ${dbFileUrl.pathname}`);
});
