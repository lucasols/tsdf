export type OwnMaterializedValue<Value> =
  | { status: 'missing'; value: undefined }
  | { status: 'lazy'; value: undefined }
  | { status: 'materialized'; value: Value };

export function readOwnMaterializedValue<Value>(
  record: Record<string, Value>,
  key: string,
): OwnMaterializedValue<Value> {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);

  if (!descriptor) {
    return { status: 'missing', value: undefined };
  }

  if (typeof descriptor.get === 'function') {
    return { status: 'lazy', value: undefined };
  }

  const value = record[key];

  if (value === undefined) {
    return { status: 'missing', value: undefined };
  }

  return { status: 'materialized', value };
}
