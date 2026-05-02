/**
 * Predicate that matches every currently known payload.
 *
 * Use it with APIs that accept payload filters, such as
 * `invalidateQueryAndItems`, `invalidateItem`, `getItemState`, and
 * `getQueriesState`.
 */
export const GET_ALL: (...args: unknown[]) => true = () => true;

/**
 * Shared List Query invalidation target for invalidating every cached query and
 * every cached item.
 */
export const ALL_QUERY_AND_ITEMS: {
  readonly queryPayload: typeof GET_ALL;
  readonly itemPayload: typeof GET_ALL;
} = { queryPayload: GET_ALL, itemPayload: GET_ALL };
