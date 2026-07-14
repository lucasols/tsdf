# Partial Resources

Partial resources allow you to fetch only specific fields of an item, reducing payload size and improving performance. Different hooks can request different fields, and TSDF tracks which fields have been loaded per item.

**Store**: [List Query Store](./list-query-store.md) only.

## Enabling Partial Resources

Enable by setting the `TPartialResources` type parameter to `true` and providing a `partialResources` config:

```ts
type User = {
  id: string;
  name: string;
  email: string;
  avatar: string;
  bio: string;
};

const storeManager = createStoreManager({
  getSessionKey: () => currentTenantId ?? false,
  errorNormalizer: normalizeError,
});

const userStore = createListQueryStore<User, UserFilter, string, true>({
  //                                                              ^^^^ enables partial resources
  storeManager,

  fetchListFn: (filter, size, { signal, fields }) => {
    // `fields` is string[] | undefined
    // undefined means fetch all fields
    return api.getUsers(filter, size, { signal, fields });
  },

  fetchItemFn: (userId, { signal, fields }) => {
    return api.getUser(userId, { signal, fields });
  },

  partialResources: {
    // Merge newly fetched fields with previously loaded ones
    mergeItems: (prev, fetched) => ({ ...(prev ?? {}), ...fetched }),

    // Select only the requested fields from a full item
    selectFields: (fields, item) => {
      const result: Partial<User> = {};
      for (const field of fields) {
        if (item[field] !== undefined) {
          result[field] = item[field];
        }
      }
      return result as User;
    },

    // Report which logical fields are genuinely present in an item snapshot —
    // the only signal for metadata-free snapshots (manually added or offline
    // items), and a way to vouch for fields present beyond tracked metadata.
    inferFields: (item) =>
      Object.keys(item).filter((field) => item[field] !== undefined),
  },

  // ...other options
});
```

## How It Works

1. Each hook specifies which `fields` it needs
2. TSDF tracks `itemLoadedFields` — the set of fields already loaded for each item
3. When a hook requests fields that haven't been loaded yet, a fetch is triggered requesting only the missing fields
4. The `mergeItems` function combines the newly fetched data with previously loaded data
5. The `selectFields` function extracts the requested fields for the hook's return value
6. The `inferFields` function reports which fields are genuinely present in an item snapshot, complementing (or substituting for) the tracked metadata

## Using Fields in Hooks

When partial resources is enabled, the `fields` option becomes **required** in hooks:

```tsx
// Fetch only name and email
function UserCard({ userId }: { userId: string }) {
  const { data } = userStore.useItem(userId, { fields: ['name', 'email'] });

  return (
    <div>
      {data?.name} ({data?.email})
    </div>
  );
}

// Fetch all fields
function UserProfile({ userId }: { userId: string }) {
  const { data } = userStore.useItem(userId, {
    fields: '*', // '*' means all fields
  });

  return <div>{data?.bio}</div>;
}
```

For list queries:

```tsx
function UserList() {
  const { items } = userStore.useListQuery(
    { active: true },
    { fields: ['name', 'avatar'] },
  );

  return items.map((user) => (
    <UserRow
      key={user.id}
      name={user.name}
      avatar={user.avatar}
    />
  ));
}
```

## Per-Field Invalidation

You can invalidate specific fields without refetching everything:

```ts
userStore.invalidateQueryAndItems({
  queryPayload: false,
  itemPayload: 'user-1',
  fields: ['name', 'email'], // only these fields are refetched
});
```

This removes the specified fields from `itemLoadedFields`, causing hooks that request those fields to trigger a refetch — but only for those fields.

Invalidation priorities are tracked per field: each field keeps the highest priority it was invalidated with since it was last reloaded, and hooks adopt priorities only from the fields they actually request. A leftover obligation on a field no mounted hook displays (e.g. after a full high-priority invalidation followed by a narrower refetch) never escalates unrelated refetches, so scheduler throttling — such as `dynamicRealtimeThrottleMs` for realtime updates — keeps working.

## Loading Behavior

When a hook requests fields that are partially loaded:

- During the field fetch, the hook returns `null` data to prevent displaying stale partial data
- Once the missing fields are loaded and merged, the complete data is returned

If you enable `showPartialAsRefetching`, the hook exposes `loadingFields` with the requested fields that are still pending. When cached partial data already exists, TSDF keeps it visible during the follow-up fetch.

Invalidations are refetches, not new loads: when an invalidation (full or per-field) marks cached data as stale, hooks whose requested fields are still present keep the stale data visible while the refetch is in flight (with a `refetching` status when `returnRefetchingStatus` is enabled). Data is only hidden behind `loading` when a requested field was genuinely never loaded.

## Fields in Scheduling and Fetching

Fields propagate through the scheduling and fetching APIs:

```ts
// Schedule a fetch for specific fields
store.scheduleItemFetch('highPriority', 'user-1', {
  fields: ['name', 'email'],
});

// Await a fetch for specific fields
const result = await store.awaitItemFetch('user-1', { fields: ['name'] });

// Schedule a list query fetch
store.scheduleListQueryFetch('highPriority', filter, undefined, {
  fields: ['name', 'avatar'],
});
```

## partialResources Config

### mergeItems

```ts
mergeItems: (prev: ItemState | undefined, fetched: ItemState) => ItemState;
```

Called when new fields arrive. `prev` is `undefined` if the item has never been fetched before. Should return the merged item with all known fields.

### selectFields

```ts
selectFields: (fields: string[], item: ItemState) => ItemState;
```

Called when a hook requests specific fields. Should return an item containing only the requested fields.

### inferFields

```ts
inferFields: (item: ItemState) => string[] | '*';
```

Reports which logical fields are genuinely present in an item snapshot. Return the available fields, or `'*'` if the snapshot is complete.

It is the only availability signal for snapshots without `itemLoadedFields` metadata — manually inserted items, persisted fallback snapshots, and offline optimistic rows. But it is also consulted for metadata-tracked items: the loaded-fields metadata only records what fetches delivered, so `inferFields` can additionally vouch for fields that are present beyond the tracked list (e.g. written into the item by a mutation), avoiding refetches of data that is already there. Returning `'*'` marks the snapshot complete even when the tracked metadata is a partial field list.

Because it can vouch for any snapshot, `inferFields` must only report fields whose data is genuinely usable — inspect the item, don't return `'*'` unconditionally unless every snapshot your store can ever hold is complete. Staleness is not its concern: fields awaiting an invalidation refetch are excluded by TSDF before `inferFields` is consulted.

TSDF does not infer fields by checking object keys internally. If your field names are top-level properties, implement that rule explicitly in `inferFields` (excluding keys with `undefined` values); if your fields are logical or nested, return those logical field names instead.
