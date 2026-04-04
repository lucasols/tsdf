export type TestTimelineSessionKey = string | false;

export type TestSessionKeyChangedEvent = {
  previousSessionKey: TestTimelineSessionKey;
  sessionKey: TestTimelineSessionKey;
};

export type TestOfflineTimelineEvent = {
  operation: string;
  phase: 'queued' | 'replay-started' | 'replay-finished' | 'replay-failed';
};
