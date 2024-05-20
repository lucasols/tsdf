import 'vitest';

interface CustomMatchers<R = unknown> {
  toMatchTimeline: (timeline: string) => R;
  toMatchInlineSnapshotString: (snapshot: string) => R;
}

declare module 'vitest' {
  interface Assertion<T = any> extends CustomMatchers<T> {}
  interface AsymmetricMatchersContaining extends CustomMatchers {}
}
