/** @internal */
export type TestTimelineSessionKey = string | false;

/** @internal */
export type TestSessionKeyChangedEvent = {
  previousSessionKey: TestTimelineSessionKey;
  sessionKey: TestTimelineSessionKey;
};

/** @internal */
export type TestOfflineTimelineEvent = {
  operation: string;
  phase: 'queued' | 'replay-started' | 'replay-finished' | 'replay-failed';
};
