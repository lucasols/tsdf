export function shouldNotSkip(scheduleResult: string) {
  if (scheduleResult === 'skipped') {
    throw new Error('Should not skip');
  }
}

export type ListQueryTestEnv = {
  serverTable: { numOfFinishedFetches: number };
};

export function getFetchCountFromHere(env: ListQueryTestEnv) {
  const startCount = env.serverTable.numOfFinishedFetches;
  return () => env.serverTable.numOfFinishedFetches - startCount;
}
