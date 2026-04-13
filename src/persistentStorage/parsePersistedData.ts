import {
  rc_array,
  rc_boolean,
  rc_object,
  rc_parse,
  rc_string,
  rc_unknown,
  type RcType,
} from 'runcheck';
import type { ValidPayload } from '../utils/storeShared';
import type {
  ConvertedPersistentStorageDataSchema,
  PersistentStorageDataSchema,
  PersistentStorageSchema,
} from './types';
import { validateWithSchema } from './validateWithSchema';

const persistedDocumentDataSchema = rc_object({ data: rc_unknown });

const persistedCollectionItemDataSchema = rc_object({
  data: rc_unknown,
  payload: rc_unknown,
});

const persistedListQueryItemDataSchema = rc_object({
  data: rc_unknown,
  payload: rc_unknown,
  loadedFields: rc_array(rc_string).optional(),
});

const persistedListQueryDataSchema = rc_object({
  payload: rc_unknown,
  items: rc_array(rc_string),
  hasMore: rc_boolean,
});

export type NormalizedPersistentStorageDataSchema<TFinal, TStorage = unknown> =
  | { mode: 'direct'; storeSchema: PersistentStorageSchema<TFinal> }
  | ({ mode: 'converted' } & ConvertedPersistentStorageDataSchema<
      TFinal,
      TStorage
    >);

export function normalizePersistentStorageDataSchema<
  TFinal,
  TStorage = unknown,
>(
  schema: PersistentStorageDataSchema<TFinal, TStorage>,
): NormalizedPersistentStorageDataSchema<TFinal, TStorage> {
  if (typeof schema === 'object' && 'storeSchema' in schema) {
    return { mode: 'converted', ...schema };
  }

  return { mode: 'direct', storeSchema: schema };
}

export function parsePersistedStoreData<TFinal, TStorage = unknown>(
  value: unknown,
  schema: NormalizedPersistentStorageDataSchema<TFinal, TStorage>,
): TFinal | null {
  if (schema.mode === 'direct') {
    return validateWithSchema(schema.storeSchema, value);
  }

  const persistedData = validateWithSchema(schema.storageSchema, value);
  if (persistedData === null) return null;

  try {
    const convertedData = schema.convertFromStorage(persistedData);
    return validateWithSchema(schema.storeSchema, convertedData);
  } catch {
    return null;
  }
}

type PersistedStoreDataValue<TFinal, TStorage = unknown> = TFinal | TStorage;

function validatePersistedStoreDataValue<TFinal, TStorage = unknown>(
  value: unknown,
  schema: NormalizedPersistentStorageDataSchema<TFinal, TStorage>,
): PersistedStoreDataValue<TFinal, TStorage> | null {
  if (schema.mode === 'direct') {
    return validateWithSchema(schema.storeSchema, value);
  }

  return validateWithSchema(schema.storageSchema, value);
}

export function convertStoreDataForPersistence<TFinal, TStorage = unknown>(
  value: TFinal,
  schema: NormalizedPersistentStorageDataSchema<TFinal, TStorage>,
): { ok: true; value: TFinal | TStorage } | { ok: false; error: unknown } {
  if (schema.mode === 'direct') {
    return { ok: true, value };
  }

  try {
    return { ok: true, value: schema.convertToStorage(value) };
  } catch (error) {
    return { ok: false, error };
  }
}

type ParsedPersistedDocumentData<TData = unknown> = { data: TData };

export function parsePersistedDocumentData(
  value: unknown,
): ParsedPersistedDocumentData | null;
export function parsePersistedDocumentData<TFinal, TStorage = unknown>(
  value: unknown,
  dataSchema: NormalizedPersistentStorageDataSchema<TFinal, TStorage>,
): ParsedPersistedDocumentData<
  PersistedStoreDataValue<TFinal, TStorage>
> | null;
export function parsePersistedDocumentData<TFinal, TStorage = unknown>(
  value: unknown,
  dataSchema?: NormalizedPersistentStorageDataSchema<TFinal, TStorage>,
): ParsedPersistedDocumentData<unknown> | null {
  const result = rc_parse(value, persistedDocumentDataSchema);
  if (!result.ok) return null;

  const data =
    dataSchema === undefined
      ? result.value.data
      : validatePersistedStoreDataValue(result.value.data, dataSchema);
  if (data === null) return null;

  return { data };
}

type ParsedPersistedItem<
  ItemPayload extends ValidPayload,
  TRaw extends { data: unknown; payload: unknown },
> = { data: unknown; payload: ItemPayload; raw: TRaw };

function parsePersistedItem<
  ItemPayload extends ValidPayload,
  TRaw extends { data: unknown; payload: unknown },
  TFinal,
  TStorage,
>(
  value: unknown,
  valueSchema: RcType<TRaw>,
  payloadSchema: PersistentStorageSchema<ItemPayload>,
  dataSchema:
    | NormalizedPersistentStorageDataSchema<TFinal, TStorage>
    | undefined,
): ParsedPersistedItem<ItemPayload, TRaw> | null {
  const result = rc_parse(value, valueSchema);
  if (!result.ok) return null;

  const payload = validateWithSchema(payloadSchema, result.value.payload);
  if (payload === null) return null;

  const data =
    dataSchema === undefined
      ? result.value.data
      : validatePersistedStoreDataValue(result.value.data, dataSchema);
  if (data === null) return null;

  return { data, payload, raw: result.value };
}

export type ParsedPersistedCollectionItemData<
  ItemPayload extends ValidPayload,
  TData = unknown,
> = { data: TData; payload: ItemPayload };

export function parsePersistedCollectionItemData<
  ItemPayload extends ValidPayload,
>(
  value: unknown,
  payloadSchema: PersistentStorageSchema<ItemPayload>,
): ParsedPersistedCollectionItemData<ItemPayload> | null;

export function parsePersistedCollectionItemData<
  ItemPayload extends ValidPayload,
  TFinal,
  TStorage = unknown,
>(
  value: unknown,
  payloadSchema: PersistentStorageSchema<ItemPayload>,
  dataSchema: NormalizedPersistentStorageDataSchema<TFinal, TStorage>,
): ParsedPersistedCollectionItemData<
  ItemPayload,
  PersistedStoreDataValue<TFinal, TStorage>
> | null;
export function parsePersistedCollectionItemData<
  ItemPayload extends ValidPayload,
  TFinal,
  TStorage = unknown,
>(
  value: unknown,
  payloadSchema: PersistentStorageSchema<ItemPayload>,
  dataSchema?: NormalizedPersistentStorageDataSchema<TFinal, TStorage>,
): ParsedPersistedCollectionItemData<ItemPayload> | null {
  const parsed = parsePersistedItem(
    value,
    persistedCollectionItemDataSchema,
    payloadSchema,
    dataSchema,
  );
  if (!parsed) return null;

  return { data: parsed.data, payload: parsed.payload };
}

export type ParsedTypedPersistedListQueryItemData<
  ItemPayload extends ValidPayload,
  TData,
> = { data: TData; payload: ItemPayload; loadedFields?: string[] };

export type ParsedPersistedListQueryItemData<ItemPayload extends ValidPayload> =
  ParsedTypedPersistedListQueryItemData<ItemPayload, unknown>;

export function parsePersistedListQueryItemData<
  ItemPayload extends ValidPayload,
>(
  value: unknown,
  payloadSchema: PersistentStorageSchema<ItemPayload>,
): ParsedPersistedListQueryItemData<ItemPayload> | null;

export function parsePersistedListQueryItemData<
  ItemPayload extends ValidPayload,
  TFinal,
  TStorage = unknown,
>(
  value: unknown,
  payloadSchema: PersistentStorageSchema<ItemPayload>,
  dataSchema: NormalizedPersistentStorageDataSchema<TFinal, TStorage>,
): ParsedTypedPersistedListQueryItemData<
  ItemPayload,
  PersistedStoreDataValue<TFinal, TStorage>
> | null;
export function parsePersistedListQueryItemData<
  ItemPayload extends ValidPayload,
  TFinal,
  TStorage = unknown,
>(
  value: unknown,
  payloadSchema: PersistentStorageSchema<ItemPayload>,
  dataSchema?: NormalizedPersistentStorageDataSchema<TFinal, TStorage>,
): ParsedPersistedListQueryItemData<ItemPayload> | null {
  const parsed = parsePersistedItem(
    value,
    persistedListQueryItemDataSchema,
    payloadSchema,
    dataSchema,
  );
  if (!parsed) return null;

  return {
    data: parsed.data,
    payload: parsed.payload,
    loadedFields: parsed.raw.loadedFields,
  };
}

export type ParsedPersistedListQueryData<QueryPayload extends ValidPayload> = {
  payload: QueryPayload;
  items: string[];
  hasMore: boolean;
};

export function parsePersistedListQueryData<QueryPayload extends ValidPayload>(
  value: unknown,
  payloadSchema: PersistentStorageSchema<QueryPayload>,
): ParsedPersistedListQueryData<QueryPayload> | null {
  const result = rc_parse(value, persistedListQueryDataSchema);
  if (!result.ok) return null;

  const payload = validateWithSchema(payloadSchema, result.value.payload);
  if (payload === null) return null;

  return { payload, items: result.value.items, hasMore: result.value.hasMore };
}
