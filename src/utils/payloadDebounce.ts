import type { DebounceOptions } from '@ls-stack/utils/debounce';
import type { PayloadDebounce } from './storeShared';

export function shouldDebouncePayload(
  debouncePayload: PayloadDebounce | undefined,
): boolean {
  return !!debouncePayload && debouncePayload.ms > 0;
}

export function getPayloadDebounceOptions(
  debouncePayload: PayloadDebounce | undefined,
): DebounceOptions | undefined {
  if (!debouncePayload) return undefined;
  const { leading, maxWait } = debouncePayload;

  if (leading === undefined && maxWait === undefined) {
    return undefined;
  }

  return { leading, maxWait, trailing: true };
}

export function assertNoEnsureIsLoadedWithDebouncePayload(
  hookName: string,
  ensureIsLoaded: boolean | undefined,
  debouncePayload: PayloadDebounce | undefined,
): void {
  if (
    !import.meta.env.PROD &&
    ensureIsLoaded &&
    shouldDebouncePayload(debouncePayload)
  ) {
    throw new Error(
      `${hookName} does not support using ensureIsLoaded together with debouncePayload.`,
    );
  }
}
