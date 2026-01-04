export type NonPartial<T> = { [K in keyof Required<T>]: T[K] };
