import type { ResolvedItemIdentity } from './itemIdentity';
import type { ValidPayload } from './storeShared';

export function isResolvedItemIdentityObject<ItemPayload extends ValidPayload>(
  value: ResolvedItemIdentity<ItemPayload> | undefined,
): value is { canonicalPayload: ItemPayload; aliasPayloads?: ItemPayload[] } {
  return typeof value === 'object' && 'canonicalPayload' in value;
}
