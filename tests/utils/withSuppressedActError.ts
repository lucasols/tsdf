declare global {
  var __SUPPRESS_ACT_ERROR__: boolean;
}

export async function withSuppressedActError<T>(
  callback: () => T | Promise<T>,
): Promise<T> {
  const previousValue = globalThis.__SUPPRESS_ACT_ERROR__;
  globalThis.__SUPPRESS_ACT_ERROR__ = true;

  try {
    return await callback();
  } finally {
    globalThis.__SUPPRESS_ACT_ERROR__ = previousValue;
  }
}
