export function range(start: number, end: number, step?: number): number[] {
  const result = [];

  if (start > end) {
    for (let i = start; i >= end; i--) {
      if (step && i % step !== 0) continue;

      result.push(i);
    }
  } else {
    for (let i = start; i <= end; i++) {
      if (step && i % step !== 0) continue;

      result.push(i);
    }
  }

  return result;
}
