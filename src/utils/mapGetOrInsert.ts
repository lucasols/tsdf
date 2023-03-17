export function mapGetOrInsert<K, V>(
  map: Map<K, V>,
  key: K,
  insert: () => V,
): V {
  if (!map.has(key)) {
    map.set(key, insert());
  }

  return map.get(key)!;
}
