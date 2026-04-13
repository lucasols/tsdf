import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { isPromise } from '@ls-stack/utils/typeGuards';
import type { AnyOfflineOperationDefinition } from '../persistentStorage/offline/types';
import type {
  TestOfflineTimelineEvent,
  TestSessionKeyChangedEvent,
} from './testTimelineTypes';

/**
 * Wraps `getSessionKey` to notify when the session key changes.
 * Test-only instrumentation — should be gated behind `import.meta.env.TEST`.
 */
export function wrapGetSessionKeyForTest(
  getSessionKey: () => string | false,
  onSessionKeyChanged:
    | ((event: TestSessionKeyChangedEvent) => void)
    | undefined,
): () => string | false {
  if (!onSessionKeyChanged) return getSessionKey;

  let previousSessionKey: string | false | undefined;

  return () => {
    const sessionKey = getSessionKey();

    if (previousSessionKey !== undefined && previousSessionKey !== sessionKey) {
      onSessionKeyChanged({ previousSessionKey, sessionKey });
    }

    previousSessionKey = sessionKey;
    return sessionKey;
  };
}

/**
 * Wraps each operation's `execute` with timeline event emissions.
 * Test-only instrumentation — should be gated behind `import.meta.env.TEST`.
 */
export function wrapOfflineOperationsForTimeline(
  operations: Record<string, AnyOfflineOperationDefinition>,
  onEvent: (event: TestOfflineTimelineEvent) => void,
): Record<string, AnyOfflineOperationDefinition> {
  return Object.fromEntries(
    Object.entries(operations).map(([operationName, operation]) => [
      operationName,
      {
        ...operation,
        execute: (...args: unknown[]) => {
          onEvent({ operation: operationName, phase: 'replay-started' });

          try {
            const result = operation.execute(
              // WORKAROUND: The test-only timeline wrapper captures replay phases through a rest-args boundary, so the original execute parameter tuple has to be restored before forwarding the call.
              ...__LEGIT_CAST__<
                Parameters<typeof operation.execute>,
                unknown[]
              >(args),
            );

            if (isPromise(result)) {
              return Promise.resolve(result).then(
                (value) => {
                  onEvent({
                    operation: operationName,
                    phase: 'replay-finished',
                  });
                  return value;
                },
                (error) => {
                  onEvent({ operation: operationName, phase: 'replay-failed' });
                  throw error;
                },
              );
            }

            onEvent({ operation: operationName, phase: 'replay-finished' });
            return result;
          } catch (error) {
            onEvent({ operation: operationName, phase: 'replay-failed' });
            throw error;
          }
        },
      },
    ]),
  );
}
