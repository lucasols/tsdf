export function hasOwnEntry(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}
