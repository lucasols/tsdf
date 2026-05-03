import { z } from 'zod';

export const profileTagSchema = z.object({ id: z.string(), label: z.string() });

export const profileSchema = z.object({
  name: z.string(),
  plan: z.union([z.literal('Free'), z.literal('Pro'), z.literal('Team')]),
  credits: z.number(),
  tags: z.array(profileTagSchema),
  updatedAt: z.string(),
});

export type ProfileTag = z.infer<typeof profileTagSchema>;
export type ProfileDocument = z.infer<typeof profileSchema>;

export const projectPayloadSchema = z.object({
  workspaceId: z.string(),
  projectId: z.string(),
});

export const projectTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  done: z.boolean(),
});

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  health: z.union([z.literal('green'), z.literal('yellow'), z.literal('red')]),
  tasks: z.array(projectTaskSchema),
  updatedAt: z.string(),
});

export type ProjectPayload = z.infer<typeof projectPayloadSchema>;
export type ProjectTask = z.infer<typeof projectTaskSchema>;
export type Project = z.infer<typeof projectSchema>;

export const contactTeamSchema = z.union([
  z.literal('design'),
  z.literal('engineering'),
  z.literal('product'),
]);
export const contactStatusSchema = z.union([
  z.literal('active'),
  z.literal('paused'),
]);

export const contactFilterSchema = z.object({
  team: z.union([z.literal('all'), contactTeamSchema]),
  status: z.union([z.literal('all'), contactStatusSchema]),
});

export const contactSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  email: z.string().optional(),
  team: contactTeamSchema.optional(),
  status: contactStatusSchema.optional(),
  notes: z.string().optional(),
  updatedAt: z.string().optional(),
});

export type ContactTeam = z.infer<typeof contactTeamSchema>;
export type ContactStatus = z.infer<typeof contactStatusSchema>;
export type ContactFilter = z.infer<typeof contactFilterSchema>;
export type Contact = z.infer<typeof contactSchema>;
export type ContactRecord = Required<Contact>;

export const ATLAS_PROJECT_PAYLOAD = {
  workspaceId: 'core',
  projectId: 'atlas',
} satisfies ProjectPayload;

export const BEACON_PROJECT_PAYLOAD = {
  workspaceId: 'core',
  projectId: 'beacon',
} satisfies ProjectPayload;

export const COPPER_PROJECT_PAYLOAD = {
  workspaceId: 'growth',
  projectId: 'copper',
} satisfies ProjectPayload;

export const PROJECT_PAYLOADS = [
  ATLAS_PROJECT_PAYLOAD,
  BEACON_PROJECT_PAYLOAD,
  COPPER_PROJECT_PAYLOAD,
] satisfies ProjectPayload[];

export const CONTACT_FIELDS = [
  'id',
  'name',
  'email',
  'team',
  'status',
  'notes',
  'updatedAt',
] as const;

export type ContactField = (typeof CONTACT_FIELDS)[number];

export const contactFieldSchema = z.enum(CONTACT_FIELDS);

export const contactListResponseSchema = z.object({
  items: z.array(z.object({ itemPayload: z.string(), data: contactSchema })),
  hasMore: z.boolean(),
});

export type ContactListResponse = z.infer<typeof contactListResponseSchema>;

export const projectBatchResponseSchema = z.array(
  z.object({
    payload: projectPayloadSchema,
    data: projectSchema.optional(),
    error: z.string().optional(),
  }),
);

export type ProjectBatchResponse = z.infer<typeof projectBatchResponseSchema>;

export const contactBatchResponseSchema = z.array(
  z.object({
    payload: z.string(),
    data: contactSchema.optional(),
    error: z.string().optional(),
  }),
);

export type ContactBatchResponse = z.infer<typeof contactBatchResponseSchema>;

export const deleteContactResponseSchema = z.object({ id: z.string() });

export type DeleteContactResponse = z.infer<typeof deleteContactResponseSchema>;

export const realtimeEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('profileChanged') }),
  z.object({
    kind: z.literal('projectChanged'),
    payload: projectPayloadSchema,
  }),
  z.object({
    kind: z.literal('contactsChanged'),
    itemId: z.string().optional(),
  }),
  z.object({ kind: z.literal('reset') }),
]);

export type PlaygroundRealtimeEvent = z.infer<typeof realtimeEventSchema>;

export function projectKey(payload: ProjectPayload): string {
  return `${payload.workspaceId}:${payload.projectId}`;
}

export function getProjectLabel(payload: ProjectPayload): string {
  return `${payload.workspaceId}/${payload.projectId}`;
}

export function selectContactFields(
  contact: Contact,
  fields: readonly string[] | undefined,
): Contact {
  if (!fields) {
    return structuredClone(contact);
  }

  const selected: Contact = { id: contact.id };

  for (const field of fields) {
    switch (field) {
      case 'id':
        selected.id = contact.id;
        break;
      case 'name':
        selected.name = contact.name;
        break;
      case 'email':
        selected.email = contact.email;
        break;
      case 'team':
        selected.team = contact.team;
        break;
      case 'status':
        selected.status = contact.status;
        break;
      case 'notes':
        selected.notes = contact.notes;
        break;
      case 'updatedAt':
        selected.updatedAt = contact.updatedAt;
        break;
    }
  }

  return structuredClone(selected);
}
