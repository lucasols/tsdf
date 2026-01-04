export function clampMax(value: number, max: number) {
  return value > max ? max : value;
}

export function clampMin(value: number, min: number) {
  return value < min ? min : value;
}
