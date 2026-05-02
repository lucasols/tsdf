/**
 * Predicate that matches every currently known payload.
 *
 * Use it with APIs that accept payload filters, such as
 * `invalidateQueryAndItems`, `invalidateItem`, `getItemState`, and
 * `getQueriesState`.
 */
export const GET_ALL: (...args: unknown[]) => true = () => true;
