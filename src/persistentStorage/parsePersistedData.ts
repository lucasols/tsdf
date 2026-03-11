import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import {
  rc_array,
  rc_boolean,
  rc_object,
  rc_parse,
  rc_string,
  rc_unknown,
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

export type ParsedPersistedDocumentData = { data: unknown };

export function parsePersistedDocumentData(
  value: unknown,
): ParsedPersistedDocumentData | null {
  const result = rc_parse(value, persistedDocumentDataSchema);
  return result.ok ? result.value : null;
}

export type ParsedPersistedCollectionItemData<
  ItemPayload extends ValidPayload,
> = { data: unknown; payload: ItemPayload };

export function parsePersistedCollectionItemData<
  ItemPayload extends ValidPayload,
>(
  value: unknown,
  payloadSchema?: PersistentStorageSchema<ItemPayload>,
): ParsedPersistedCollectionItemData<ItemPayload> | null {
  const result = rc_parse(value, persistedCollectionItemDataSchema);
  if (!result.ok) return null;

  const payload = payloadSchema
    ? validateWithSchema(payloadSchema, result.value.payload)
    : __LEGIT_CAST__<ItemPayload, unknown>(result.value.payload);
  if (payload === null) return null;

  return { data: result.value.data, payload };
}

export type ParsedPersistedListQueryItemData<ItemPayload extends ValidPayload> =
  { data: unknown; payload: ItemPayload; loadedFields?: string[] };

export function parsePersistedListQueryItemData<
  ItemPayload extends ValidPayload,
>(
  value: unknown,
  payloadSchema?: PersistentStorageSchema<ItemPayload>,
): ParsedPersistedListQueryItemData<ItemPayload> | null {
  const result = rc_parse(value, persistedListQueryItemDataSchema);
  if (!result.ok) return null;

  const payload = payloadSchema
    ? validateWithSchema(payloadSchema, result.value.payload)
    : __LEGIT_CAST__<ItemPayload, unknown>(result.value.payload);
  if (payload === null) return null;

  return {
    data: result.value.data,
    payload,
    loadedFields: result.value.loadedFields,
  };
}

export type ParsedPersistedListQueryData<QueryPayload extends ValidPayload> = {
  payload: QueryPayload;
  items: string[];
  hasMore: boolean;
};

export function parsePersistedListQueryData<QueryPayload extends ValidPayload>(
  value: unknown,
  payloadSchema?: PersistentStorageSchema<QueryPayload>,
): ParsedPersistedListQueryData<QueryPayload> | null {
  const result = rc_parse(value, persistedListQueryDataSchema);
  if (!result.ok) return null;

  const payload = payloadSchema
    ? validateWithSchema(payloadSchema, result.value.payload)
    : __LEGIT_CAST__<QueryPayload, unknown>(result.value.payload);
  if (payload === null) return null;

  return { payload, items: result.value.items, hasMore: result.value.hasMore };
}
