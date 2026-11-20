import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import '@testing-library/react/dont-cleanup-after-each';
import type { ItemLoadedFields } from '../../src/listQueryStore/types';
import type { PartialResourcesConfig } from '../../src/listQueryStore/types';
import { type Row, type Tables } from '../mocks/listQueryStoreTestEnv';
import { range } from '../utils/genericTestUtils';

export const mergeAndSelect = {
  mergeItems: (prev: Row | undefined, fetched: Row) => {
    if (!prev) return fetched;
    return { ...prev, ...fetched };
  },
  selectFields: (fields: readonly string[], item: Row) => {
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      if (field in item) {
        result[field] = item[field];
      }
    }
    return __LEGIT_CAST__<Row, Record<string, unknown>>(result);
  },
} satisfies Pick<PartialResourcesConfig<Row>, 'mergeItems' | 'selectFields'>;

const ALL_FIELDS = ['id', 'name', 'address', 'age', 'country'] as const;

/** `inferFields` that reports the concrete list of defined fields (never `'*'`). */
export const listInferFieldsConfig: PartialResourcesConfig<Row> = {
  ...mergeAndSelect,
  inferFields: (item) =>
    Object.entries(item)
      .filter(([, value]) => value !== undefined)
      .map(([field]) => field),
};

/**
 * `inferFields` that returns the `'*'` sentinel once every field is present —
 * the shape the docs describe for manually inserted / offline / persisted rows.
 */
export const starInferFieldsConfig: PartialResourcesConfig<Row> = {
  ...mergeAndSelect,
  inferFields: (item): ItemLoadedFields => {
    const isComplete = ALL_FIELDS.every((field) => item[field] !== undefined);
    if (isComplete) return '*';
    return Object.entries(item)
      .filter(([, value]) => value !== undefined)
      .map(([field]) => field);
  },
};

export const initialServerData: Tables = {
  users: range(1, 5).map((id) => ({
    id,
    name: `User ${id}`,
    address: `Address ${id}`,
    age: id * 10,
    country: `Country ${id}`,
  })),
};
