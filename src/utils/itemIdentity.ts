import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { isResolvedItemIdentityObject } from './itemIdentity.typeGuards';
import { ValidPayload, ValidStoreState } from './storeShared';

export type ResolvedItemIdentity<ItemPayload extends ValidPayload> =
  | ItemPayload
  | { canonicalPayload: ItemPayload; aliasPayloads?: ItemPayload[] };

export type ResolveItemIdentityArgs<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = {
  payload: ItemPayload;
  data: ItemState;
  source: 'itemFetch' | 'listFetch';
};

export type ResolveItemIdentity<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = (
  args: ResolveItemIdentityArgs<ItemState, ItemPayload>,
) => ResolvedItemIdentity<ItemPayload> | undefined;

export type NormalizedResolvedItemIdentity<ItemPayload extends ValidPayload> = {
  canonicalItemKey: string;
  canonicalPayload: ItemPayload;
  aliasItemKeys: string[];
  aliasPayloads: ItemPayload[];
};
type AliasEntries<ItemPayload extends ValidPayload> = Map<string, ItemPayload>;

export function normalizeResolvedItemIdentity<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
>(args: {
  data: ItemState;
  extraAliasPayloads?: ItemPayload[];
  getItemKey: (payload: ItemPayload) => string;
  payload: ItemPayload;
  resolveItemIdentity: ResolveItemIdentity<ItemState, ItemPayload> | undefined;
  source: 'itemFetch' | 'listFetch';
}): NormalizedResolvedItemIdentity<ItemPayload> {
  const resolved = args.resolveItemIdentity?.({
    payload: args.payload,
    data: args.data,
    source: args.source,
  });
  const resolvedObject = isResolvedItemIdentityObject(resolved)
    ? resolved
    : null;

  let canonicalPayload = args.payload;
  if (resolvedObject) {
    canonicalPayload = resolvedObject.canonicalPayload;
  } else if (resolved !== undefined) {
    // WORKAROUND: after excluding the object hook result, the remaining runtime
    // value is the payload form, but TypeScript does not narrow the generic
    // union all the way back to ItemPayload.
    canonicalPayload = __LEGIT_CAST__<
      ItemPayload,
      ResolvedItemIdentity<ItemPayload>
    >(resolved);
  }
  const canonicalItemKey = args.getItemKey(canonicalPayload);
  const aliasPayloadsByKey = new Map<string, ItemPayload>();

  for (const aliasPayload of [
    args.payload,
    ...(args.extraAliasPayloads ?? []),
    ...(resolvedObject?.aliasPayloads ?? []),
  ]) {
    const aliasItemKey = args.getItemKey(aliasPayload);
    if (aliasItemKey === canonicalItemKey) continue;
    if (!aliasPayloadsByKey.has(aliasItemKey)) {
      aliasPayloadsByKey.set(aliasItemKey, aliasPayload);
    }
  }

  return {
    canonicalItemKey,
    canonicalPayload,
    aliasItemKeys: [...aliasPayloadsByKey.keys()],
    aliasPayloads: [...aliasPayloadsByKey.values()],
  };
}

export type ItemAliasEntry<ItemPayload extends ValidPayload> = {
  aliasItemKey: string;
  aliasPayload: ItemPayload;
  canonicalItemKey: string;
};

export type ItemAliasRegistry<ItemPayload extends ValidPayload> = {
  clearAll(this: void): void;
  clearCanonicalAliases(this: void, canonicalItemKey: string): void;
  getAliasEntries(this: void): ItemAliasEntry<ItemPayload>[];
  getAliasPayloads(this: void, canonicalItemKey: string): ItemPayload[];
  resolveItemKey(this: void, itemKey: string): string;
  setCanonicalAliases(
    this: void,
    canonicalItemKey: string,
    aliasPayloads: readonly ItemPayload[],
  ): void;
};

export function createItemAliasRegistry<ItemPayload extends ValidPayload>(
  getItemKey: (payload: ItemPayload) => string,
): ItemAliasRegistry<ItemPayload> {
  const aliasItemKeyToCanonicalKey = new Map<string, string>();
  const canonicalKeyToAliasPayloads = new Map<
    string,
    AliasEntries<ItemPayload>
  >();

  function resolveItemKey(itemKey: string): string {
    let currentItemKey = itemKey;
    const visited = new Set<string>();

    while (aliasItemKeyToCanonicalKey.has(currentItemKey)) {
      if (visited.has(currentItemKey)) break;
      visited.add(currentItemKey);
      currentItemKey =
        aliasItemKeyToCanonicalKey.get(currentItemKey) ?? currentItemKey;
    }

    return currentItemKey;
  }

  function clearCanonicalAliases(canonicalItemKey: string): void {
    const resolvedCanonicalItemKey = resolveItemKey(canonicalItemKey);
    const knownAliases = canonicalKeyToAliasPayloads.get(
      resolvedCanonicalItemKey,
    );
    if (!knownAliases) return;

    for (const aliasItemKey of knownAliases.keys()) {
      aliasItemKeyToCanonicalKey.delete(aliasItemKey);
    }

    canonicalKeyToAliasPayloads.delete(resolvedCanonicalItemKey);
  }

  function setCanonicalAliases(
    canonicalItemKey: string,
    aliasPayloads: readonly ItemPayload[],
  ): void {
    const resolvedCanonicalItemKey = resolveItemKey(canonicalItemKey);
    clearCanonicalAliases(resolvedCanonicalItemKey);

    const aliasesByKey: AliasEntries<ItemPayload> = new Map();
    for (const aliasPayload of aliasPayloads) {
      const aliasItemKey = resolveItemKey(getItemKey(aliasPayload));
      if (aliasItemKey === resolvedCanonicalItemKey) continue;
      if (!aliasesByKey.has(aliasItemKey)) {
        aliasesByKey.set(aliasItemKey, aliasPayload);
      }
      aliasItemKeyToCanonicalKey.set(aliasItemKey, resolvedCanonicalItemKey);
    }

    if (aliasesByKey.size > 0) {
      canonicalKeyToAliasPayloads.set(resolvedCanonicalItemKey, aliasesByKey);
    }
  }

  function getAliasPayloads(canonicalItemKey: string): ItemPayload[] {
    const resolvedCanonicalItemKey = resolveItemKey(canonicalItemKey);
    return [
      ...(canonicalKeyToAliasPayloads.get(resolvedCanonicalItemKey)?.values() ??
        []),
    ];
  }

  function getAliasEntries(): ItemAliasEntry<ItemPayload>[] {
    const entries: ItemAliasEntry<ItemPayload>[] = [];

    for (const [
      canonicalItemKey,
      aliasEntries,
    ] of canonicalKeyToAliasPayloads) {
      for (const [aliasItemKey, aliasPayload] of aliasEntries) {
        entries.push({ aliasItemKey, aliasPayload, canonicalItemKey });
      }
    }

    return entries;
  }

  function clearAll(): void {
    aliasItemKeyToCanonicalKey.clear();
    canonicalKeyToAliasPayloads.clear();
  }

  return {
    clearAll,
    clearCanonicalAliases,
    getAliasEntries,
    getAliasPayloads,
    resolveItemKey,
    setCanonicalAliases,
  };
}
