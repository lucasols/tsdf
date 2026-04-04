import {
  createOfflineSession,
  type OfflineSession,
  type OfflineSessionConfig,
} from '../../src/main';

type OfflineConfigSessionKey = string | false | (() => string | false);

type StoreOfflineConfig<TOperations extends Record<string, unknown>> = {
  session: OfflineSession;
  operations: TOperations;
};

export function createOfflineConfigForSessionKey<
  TOperations extends Record<string, unknown>,
>(
  sessionKey: OfflineConfigSessionKey,
  config: OfflineSessionConfig & { operations: TOperations },
): StoreOfflineConfig<TOperations> {
  const { operations, ...sessionConfig } = config;

  return {
    session: createOfflineSession({
      getSessionKey:
        typeof sessionKey === 'function' ? sessionKey : () => sessionKey,
      config: sessionConfig,
    }),
    operations,
  };
}
