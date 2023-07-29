type SortOrder = 'desc' | 'asc';

/** Use `Infinity` as as wildcard to absulute max and min values */
export function sortBy<T>(
  arr: T[],
  getPriority: (item: T) => (number | string)[] | number | string,
  { order = 'asc' }: { order?: SortOrder | SortOrder[] } = {},
) {
  // eslint-disable-next-line no-restricted-syntax -- in this case is ok to use this syntax
  return [...arr].sort((a, b) => {
    const _aPriority = getPriority(a);
    const _bPriority = getPriority(b);

    const aPriority = Array.isArray(_aPriority) ? _aPriority : [_aPriority];
    const bPriority = Array.isArray(_bPriority) ? _bPriority : [_bPriority];

    for (let i = 0; i < aPriority.length; i++) {
      const levelOrder: SortOrder =
        typeof order === 'string' ? order : order[i] ?? 'asc';

      const aP = aPriority[i] ?? 0;
      const bP = bPriority[i] ?? 0;

      if (aP === bP) {
        continue;
      }

      if (bP === Infinity || aP === -Infinity || aP < bP) {
        return levelOrder === 'asc' ? -1 : 1;
      }

      if (aP === Infinity || bP === -Infinity || aP > bP) {
        return levelOrder === 'asc' ? 1 : -1;
      }
    }

    return 0;
  });
}
