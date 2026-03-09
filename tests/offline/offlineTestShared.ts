import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { rc_number, rc_object, rc_string } from 'runcheck';
import type { PersistentStorageSchema } from '../../src/persistentStorage/types';

export const docSchema = __LEGIT_CAST__<
  PersistentStorageSchema<{ value: number }>,
  unknown
>(rc_object({ value: rc_number }));

export const docMutationInputSchema = __LEGIT_CAST__<
  PersistentStorageSchema<{ value: number }>,
  unknown
>(rc_object({ value: rc_number }));

export const docConflictSchema = __LEGIT_CAST__<
  PersistentStorageSchema<{ reason: string }>,
  unknown
>(rc_object({ reason: rc_string }));

export const collectionCreateInputSchema = __LEGIT_CAST__<
  PersistentStorageSchema<{ name: string }>,
  unknown
>(rc_object({ name: rc_string }));

export const collectionSchema = rc_object({
  value: rc_object({ name: rc_string }),
});
