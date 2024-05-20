export function invariant(
  condition: any,
  message: string = '[tsdf] Invariant violation',
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
