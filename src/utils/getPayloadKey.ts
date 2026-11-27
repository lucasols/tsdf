import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';

const keyOptions = { maxSortingDepth: Infinity };

/**
 * Builds the key of a payload. Payloads with the same content build the same
 * key whatever the order of their object keys, at any depth
 * (`getCompositeKey` only sorts the keys of the first 3 levels by default).
 */
export function getPayloadKey(payload: unknown): string {
  return getCompositeKey(payload, keyOptions);
}
