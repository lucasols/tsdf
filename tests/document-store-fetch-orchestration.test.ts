import { renderHook } from '@testing-library/react';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { createDocumentStoreTestEnv } from './mocks/documentStoreTestEnv';
import {
  DEFAULT_FETCH_DURATION_MS,
  DEFAULT_MUTATION_DURATION_MS,
} from './mocks/serverMock';

beforeAll(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

test('simple mutation with revalidation and optimistic update', async () => {
  const env = createDocumentStoreTestEnv(0);

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  // Wait for initial fetch
  await vi.runAllTimersAsync();

  env.performClientUpdateAction(1, {
    withRevalidation: true,
    withOptimisticUpdate: true,
  });

  await vi.runAllTimersAsync();

  expect(env.uiChanges).toEqual([0, 1]);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |                                     
    0     | 0  | ui-initialized                      
    .     | 1  | ⬜ optimistic-ui-commit              
    .     | 1  | ⬜ >mutation-started (value: 1)       
    840ms | 1  | ⬜ <mutation-data-persisted (value: 1)
    1.2s  | 1  | 🔴 >fetch-started                    
    2s    | 1  | 🔴 <fetch-finished (value: 1)        
    "
  `);
});

test('simple mutation with optimistic update', async () => {
  const env = createDocumentStoreTestEnv(0);

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  // Wait for initial fetch
  await vi.runAllTimersAsync();

  env.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
  });

  await vi.runAllTimersAsync();

  expect(env.uiChanges).toEqual([0, 1]);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |                                     
    0     | 0  | ui-initialized                      
    .     | 1  | ⬜ optimistic-ui-commit              
    .     | 1  | ⬜ >mutation-started (value: 1)       
    840ms | 1  | ⬜ <mutation-data-persisted (value: 1)
    "
  `);
});

test('simple mutation without optimistic update', async () => {
  const env = createDocumentStoreTestEnv(0);

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  // Wait for initial fetch
  await vi.runAllTimersAsync();

  env.performClientUpdateAction(1, {
    withRevalidation: true,
  });

  await vi.runAllTimersAsync();

  expect(env.uiChanges).toEqual([0, 1]);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |                                     
    0     | 0  | ui-initialized                      
    .     | 0  | ⬜ >mutation-started (value: 1)       
    840ms | 0  | ⬜ <mutation-data-persisted (value: 1)
    1.2s  | 0  | 🔴 >fetch-started                    
    2s    | 0  | 🔴 <fetch-finished (value: 1)        
    .     | 1  | ui-changed                          
    "
  `);
});

test('prevent overfetch of low priority fetches', async () => {
  const env = createDocumentStoreTestEnv(0);

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  // Initial data is already loaded, no fetch needed

  env.scheduleFetch('lowPriority');
  await vi.advanceTimersByTimeAsync(10);

  env.addTimelineComment(
    'All fetches started after this point should be skipped',
  );

  env.scheduleFetch('lowPriority');
  await vi.advanceTimersByTimeAsync(10);

  env.scheduleFetch('lowPriority');
  await vi.advanceTimersByTimeAsync(10);

  env.scheduleFetch('lowPriority');

  await vi.runAllTimersAsync();

  expect(env.numOfFinishedFetches).toBe(1);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |                                                          
    0     | 0  | ui-initialized                                           
    .     | 0  | 🔴 >fetch-started-from-manual-scheduling                 
    10ms  | 0  | -- All fetches started after this point should be skipped
    .     | 0  | scheduled-fetch-skipped                                  
    20ms  | 0  | scheduled-fetch-skipped                                  
    30ms  | 0  | scheduled-fetch-skipped                                  
    800ms | 0  | 🔴 <fetch-finished (value: 0)                            
    "
  `);
});

test('multiple mutations with revalidation in sequence', async () => {
  const env = createDocumentStoreTestEnv(0);

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  const sequentialGapMs =
    DEFAULT_MUTATION_DURATION_MS + DEFAULT_FETCH_DURATION_MS + 50;

  env.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await vi.advanceTimersByTimeAsync(sequentialGapMs);

  env.performClientUpdateAction(2, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await vi.runAllTimersAsync();

  expect(env.uiChanges).toEqual([0, 1, 2]);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |                                     
    0     | 0  | ui-initialized                      
    .     | 1  | ⬜ optimistic-ui-commit              
    .     | 1  | ⬜ >mutation-started (value: 1)       
    840ms | 1  | ⬜ <mutation-data-persisted (value: 1)
    1.2s  | 1  | 🔴 >fetch-started                    
    2s    | 1  | 🔴 <fetch-finished (value: 1)        
    2.05s | 2  | ⬛ optimistic-ui-commit              
    .     | 2  | ⬛ >mutation-started (value: 2)       
    2.89s | 2  | ⬛ <mutation-data-persisted (value: 2)
    3.25s | 2  | 🟠 >fetch-started                    
    4.05s | 2  | 🟠 <fetch-finished (value: 2)        
    "
  `);
});

test('multiple mutations with revalidation in sequence, causing concurrent updates', async () => {
  // mutations should abort in progress fetches
  const env = createDocumentStoreTestEnv(0);

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  // First mutation
  env.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  const duringRevalidationMs = DEFAULT_MUTATION_DURATION_MS + 50;

  // Wait for the server write (mutation-finished event), but not the revalidation fetch
  await vi.advanceTimersByTimeAsync(duringRevalidationMs);

  env.addTimelineComment(
    'New mutation starts during revalidation; scheduler aborts in-flight fetch to prevent stale commit.',
  );

  // Second mutation starts during revalidation
  env.performClientUpdateAction(2, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await vi.runAllTimersAsync();

  expect(env.uiChanges).toEqual([0, 1, 2]);
  expect(env.numOfFinishedFetches).toBe(1);
  expect(env.numOfStartedFetches).toBe(2);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |                                           
    0     | 0  | ui-initialized                            
    .     | 1  | ⬜ optimistic-ui-commit                    
    .     | 1  | ⬜ >mutation-started (value: 1)                            
    840ms | 1  | ⬜ <mutation-data-persisted (value: 1)                     
    1.2s  | 1  | 🔴 >fetch-started                                         
    1.25s | 1  | -- New mutation starts during revalidation; scheduler aborts in-flight fetch to prevent stale commit.
    .     | 2  | ⬛ optimistic-ui-commit                    
    .     | 2  | ⬛ >mutation-started (value: 2)                            
    2s    | 2  | 🔴 <fetch-aborted 🚫                                      
    2.09s | 2  | ⬛ <mutation-data-persisted (value: 2)                     
    2.45s | 2  | 🟠 >fetch-started                                         
    3.25s | 2  | 🟠 <fetch-finished (value: 2)                             
    "
  `);
});

test('multiple mutations with revalidation in sequence 2', async () => {
  // mutations should abort in progress fetches, stress test
  const env = createDocumentStoreTestEnv(0);

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  const duringRevalidationMs = DEFAULT_MUTATION_DURATION_MS + 50;

  // Initial low priority fetch
  env.scheduleFetch('lowPriority');

  // First mutation (start shortly after fetch begins)
  await vi.advanceTimersByTimeAsync(100);
  env.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  // Wait for the server write (mutation-finished event) + small buffer, but not the full revalidation fetch
  await vi.advanceTimersByTimeAsync(duringRevalidationMs);

  env.addTimelineComment(
    'New mutation starts during revalidation; scheduler aborts in-flight fetch to prevent stale commit.',
  );

  // Second mutation (revalidation fetch from mutation 1 still in progress)
  env.performClientUpdateAction(2, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await vi.advanceTimersByTimeAsync(duringRevalidationMs);

  // Third mutation
  env.performClientUpdateAction(3, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await vi.advanceTimersByTimeAsync(duringRevalidationMs);

  // Fourth mutation
  env.performClientUpdateAction(4, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await vi.advanceTimersByTimeAsync(duringRevalidationMs);

  // Fifth mutation with same value
  env.performClientUpdateAction(4, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await vi.runAllTimersAsync();

  expect(env.uiChanges).toEqual([0, 1, 2, 3, 4]);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |                                           
    0     | 0  | ui-initialized                            
    .     | 0  | 🔴 >fetch-started-from-manual-scheduling                                                             
    100ms | 1  | ⬜ optimistic-ui-commit                    
    .     | 1  | ⬜ >mutation-started (value: 1)            
    800ms | 1  | 🔴 <fetch-aborted 🚫                      
    940ms | 1  | ⬜ <mutation-data-persisted (value: 1)     
    1.3s  | 1  | 🟠 >fetch-started                         
    1.35s | 1  | -- New mutation starts during revalidation; scheduler aborts in-flight fetch to prevent stale commit.
    .     | 2  | ⬛ optimistic-ui-commit                    
    .     | 2  | ⬛ >mutation-started (value: 2)            
    2.1s  | 2  | 🟠 <fetch-aborted 🚫                      
    2.19s | 2  | ⬛ <mutation-data-persisted (value: 2)     
    2.55s | 2  | 🟡 >fetch-started                         
    2.6s  | 3  | 🟫 optimistic-ui-commit                   
    .     | 3  | 🟫 >mutation-started (value: 3)           
    3.35s | 3  | 🟡 <fetch-aborted 🚫                      
    3.44s | 3  | 🟫 <mutation-data-persisted (value: 3)    
    3.8s  | 3  | 🟢 >fetch-started                         
    3.85s | 4  | 🟪 optimistic-ui-commit                   
    .     | 4  | 🟪 >mutation-started (value: 4)           
    4.6s  | 4  | 🟢 <fetch-aborted 🚫                      
    4.69s | 4  | 🟪 <mutation-data-persisted (value: 4)    
    5.05s | 4  | 🔵 >fetch-started                         
    5.1s  | 4  | 🟦 optimistic-ui-commit                   
    .     | 4  | 🟦 >mutation-started (value: 4)           
    5.85s | 4  | 🔵 <fetch-aborted 🚫                      
    5.94s | 4  | 🟦 <mutation-data-persisted (value: 4)    
    6.3s  | 4  | 🟣 >fetch-started                         
    7.1s  | 4  | 🟣 <fetch-finished (value: 4)             
    "
  `);

  expect(env.numOfFinishedFetches).toBe(1);
  expect(env.numOfStartedFetches).toBe(6);
});

test('multiple mutations with revalidation in sequence 3', async () => {
  // mutations should abort in progress fetches, no initial low priority fetch
  const env = createDocumentStoreTestEnv(0);

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  const duringRevalidationMs = DEFAULT_MUTATION_DURATION_MS + 50;

  env.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await vi.advanceTimersByTimeAsync(duringRevalidationMs);
  env.addTimelineComment(
    'New mutation starts during revalidation; scheduler aborts in-flight fetch to prevent stale commit.',
  );
  env.performClientUpdateAction(2, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await vi.advanceTimersByTimeAsync(duringRevalidationMs);
  env.performClientUpdateAction(3, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await vi.advanceTimersByTimeAsync(duringRevalidationMs);
  env.performClientUpdateAction(4, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await vi.advanceTimersByTimeAsync(duringRevalidationMs);
  env.performClientUpdateAction(4, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await vi.runAllTimersAsync();

  expect(env.uiChanges).toEqual([0, 1, 2, 3, 4]);
  expect(env.numOfFinishedFetches).toBe(1);
  expect(env.numOfStartedFetches).toBe(5);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |                                           
    0     | 0  | ui-initialized                            
    .     | 1  | ⬜ optimistic-ui-commit                    
    .     | 1  | ⬜ >mutation-started (value: 1)            
    840ms | 1  | ⬜ <mutation-data-persisted (value: 1)     
    1.2s  | 1  | 🔴 >fetch-started                         
    1.25s | 1  | -- New mutation starts during revalidation; scheduler aborts in-flight fetch to prevent stale commit.
    .     | 2  | ⬛ optimistic-ui-commit                    
    .     | 2  | ⬛ >mutation-started (value: 2)            
    2s    | 2  | 🔴 <fetch-aborted 🚫                      
    2.09s | 2  | ⬛ <mutation-data-persisted (value: 2)     
    2.45s | 2  | 🟠 >fetch-started                         
    2.5s  | 3  | 🟫 optimistic-ui-commit                   
    .     | 3  | 🟫 >mutation-started (value: 3)           
    3.25s | 3  | 🟠 <fetch-aborted 🚫                      
    3.34s | 3  | 🟫 <mutation-data-persisted (value: 3)    
    3.7s  | 3  | 🟡 >fetch-started                         
    3.75s | 4  | 🟪 optimistic-ui-commit                   
    .     | 4  | 🟪 >mutation-started (value: 4)           
    4.5s  | 4  | 🟡 <fetch-aborted 🚫                      
    4.59s | 4  | 🟪 <mutation-data-persisted (value: 4)    
    4.95s | 4  | 🟢 >fetch-started                         
    5s    | 4  | 🟦 optimistic-ui-commit                   
    .     | 4  | 🟦 >mutation-started (value: 4)           
    5.75s | 4  | 🟢 <fetch-aborted 🚫                      
    5.84s | 4  | 🟦 <mutation-data-persisted (value: 4)    
    6.2s  | 4  | 🔵 >fetch-started                         
    7s    | 4  | 🔵 <fetch-finished (value: 4)             
    "
  `);
});

test('high priority fetch during mutation', async () => {
  // Expected: high priority fetch triggered during mutation should be scheduled
  // to run after the mutation completes, preventing stale data commits.
  const env = createDocumentStoreTestEnv(0);

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  // Start a mutation (without revalidation to isolate the high priority fetch behavior)
  env.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
  });

  // Trigger high priority fetch while mutation is in progress
  await vi.advanceTimersByTimeAsync(100);
  env.addTimelineComment(
    'High priority fetch during mutation; should be scheduled after mutation completes.',
  );
  const result = env.scheduleFetch('highPriority');
  expect(result).toBe('scheduled');

  await vi.runAllTimersAsync();

  expect(env.uiChanges).toEqual([0, 1]);
  expect(env.numOfFinishedFetches).toBe(1);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |                                                                                      
    0     | 0  | ui-initialized                                                                       
    .     | 1  | ⬜ optimistic-ui-commit                                                               
    .     | 1  | ⬜ >mutation-started (value: 1)                                                       
    100ms | 1  | -- High priority fetch during mutation; should be scheduled after mutation completes.
    .     | 1  | scheduled-fetch-scheduled                                                            
    840ms | 1  | ⬜ <mutation-data-persisted (value: 1)                                                
    1.2s  | 1  | 🔴 >fetch-started                                                                    
    2s    | 1  | 🔴 <fetch-finished (value: 1)                                                        
    "
  `);
});

test('multiple concurrent mutations with revalidation', async () => {
  // Expected: overlapping mutations schedule a single revalidation fetch that
  // skips redundant requests and commits only once with the latest data.
  const env = createDocumentStoreTestEnv(0);

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  // First mutation
  env.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  // Second mutation starts 50ms after first (while first is still running)
  await vi.advanceTimersByTimeAsync(50);
  env.addTimelineComment('Second mutation overlaps first');
  env.performClientUpdateAction(2, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await vi.runAllTimersAsync();

  expect(env.uiChanges).toEqual([0, 1, 2]);
  expect(env.serverHistory).toEqual([0, 1, 2]);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |                                      
    0     | 0  | ui-initialized                       
    .     | 1  | ⬜ optimistic-ui-commit               
    .     | 1  | ⬜ >mutation-started (value: 1)       
    50ms  | 1  | -- Second mutation overlaps first    
    .     | 2  | ⬛ optimistic-ui-commit               
    .     | 2  | ⬛ >mutation-started (value: 2)       
    840ms | 2  | ⬜ <mutation-data-persisted (value: 1)
    890ms | 2  | ⬛ <mutation-data-persisted (value: 2)
    1.25s | 2  | 🔴 >fetch-started                    
    2.05s | 2  | 🔴 <fetch-finished (value: 2)        
    "
  `);

  expect(env.numOfFinishedFetches).toBe(1);
  expect(env.numOfStartedFetches).toBe(1);
});

test('multiple high priority fetches', async () => {
  // Expected: high priority requests coalesce into a running fetch plus one scheduled fetch.
  const env = createDocumentStoreTestEnv(0);

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  // First high priority fetch starts immediately
  env.scheduleFetch('highPriority');

  // These are skipped (fetch already in progress, within throttle window)
  await vi.advanceTimersByTimeAsync(5);
  env.scheduleFetch('highPriority');

  await vi.advanceTimersByTimeAsync(3);
  env.scheduleFetch('highPriority');

  // These get scheduled (outside throttle window but fetch still in progress)
  await vi.advanceTimersByTimeAsync(7);
  env.scheduleFetch('highPriority');

  await vi.advanceTimersByTimeAsync(5);
  env.scheduleFetch('highPriority');

  await vi.runAllTimersAsync();

  expect(env.numOfFinishedFetches).toBe(2);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |                                         
    0     | 0  | ui-initialized                          
    .     | 0  | 🔴 >fetch-started-from-manual-scheduling
    5ms   | 0  | scheduled-fetch-skipped                 
    8ms   | 0  | scheduled-fetch-skipped                 
    15ms  | 0  | scheduled-fetch-scheduled               
    20ms  | 0  | scheduled-fetch-scheduled               
    800ms | 0  | 🔴 <fetch-finished (value: 0)           
    .     | 0  | 🟠 >fetch-started                       
    1.6s  | 0  | 🟠 <fetch-finished (value: 0)           
    "
  `);
});

test('throttle low priority updates', async () => {
  // Expected: low priority requests are throttled so only the first and last execute.
  const env = createDocumentStoreTestEnv(0);

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  // t=0: first low priority fetch starts
  env.scheduleFetch('lowPriority');

  // t=100: skipped - first fetch in progress
  await vi.advanceTimersByTimeAsync(100);
  env.scheduleFetch('lowPriority');

  // t=110: skipped - first fetch in progress
  await vi.advanceTimersByTimeAsync(10);
  env.scheduleFetch('lowPriority');

  // t=120: skipped - first fetch in progress
  await vi.advanceTimersByTimeAsync(10);
  env.scheduleFetch('lowPriority');

  // Wait for first fetch to complete
  await vi.advanceTimersByTimeAsync(DEFAULT_FETCH_DURATION_MS + 10);

  // Second fetch starts outside the throttle window from t=0
  env.scheduleFetch('lowPriority');

  await vi.runAllTimersAsync();

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |                                         
    0     | 0  | ui-initialized                          
    .     | 0  | 🔴 >fetch-started-from-manual-scheduling
    100ms | 0  | scheduled-fetch-skipped                 
    110ms | 0  | scheduled-fetch-skipped                 
    120ms | 0  | scheduled-fetch-skipped                 
    800ms | 0  | 🔴 <fetch-finished (value: 0)           
    930ms | 0  | 🟠 >fetch-started-from-manual-scheduling
    1.73s | 0  | 🟠 <fetch-finished (value: 0)           
    "
  `);
  expect(env.numOfFinishedFetches).toBe(2);
});

test('throttle low priority after a fast fetch completes', async () => {
  // Expected: low priority throttling uses the fetch start time, even if it finishes quickly.
  const env = createDocumentStoreTestEnv(0);

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  env.setNextFetchDurations(50, 50);

  // t=0: first low priority fetch starts (treated as high priority when no prior fetch exists)
  env.scheduleFetch('lowPriority');

  // t=60: first fetch finished (50ms), still within the throttle window
  await vi.advanceTimersByTimeAsync(60);
  const result = env.scheduleFetch('lowPriority');
  expect(result).toBe('skipped');

  // t=210: outside throttle window
  await vi.advanceTimersByTimeAsync(150);
  env.scheduleFetch('lowPriority');

  await vi.runAllTimersAsync();

  expect(env.numOfFinishedFetches).toBe(2);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |                                         
    0     | 0  | ui-initialized                          
    .     | 0  | 🔴 >fetch-started-from-manual-scheduling
    50ms  | 0  | 🔴 <fetch-finished (value: 0)           
    60ms  | 0  | scheduled-fetch-skipped                 
    210ms | 0  | 🟠 >fetch-started-from-manual-scheduling
    260ms | 0  | 🟠 <fetch-finished (value: 0)           
    "
  `);
});

test('multiple mutations with low priority fetch between', async () => {
  // Expected: low priority fetch is scheduled but coalesced with mutation revalidation,
  // resulting in a single fetch commit.
  const env = createDocumentStoreTestEnv(0);

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  // t=0: first mutation with revalidation
  env.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  // t=50: second mutation with revalidation
  await vi.advanceTimersByTimeAsync(50);
  env.performClientUpdateAction(2, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  // t=70: low priority fetch (should be skipped while mutations are in flight)
  await vi.advanceTimersByTimeAsync(20);
  const result = env.scheduleFetch('lowPriority');
  expect(result).toBe('scheduled');

  await vi.runAllTimersAsync();

  expect(env.uiChanges).toEqual([0, 1, 2]);
  expect(env.numOfFinishedFetches).toBe(1);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |                                      
    0     | 0  | ui-initialized                       
    .     | 1  | ⬜ optimistic-ui-commit               
    .     | 1  | ⬜ >mutation-started (value: 1)       
    50ms  | 2  | ⬛ optimistic-ui-commit               
    .     | 2  | ⬛ >mutation-started (value: 2)       
    70ms  | 2  | scheduled-fetch-scheduled            
    840ms | 2  | ⬜ <mutation-data-persisted (value: 1)
    890ms | 2  | ⬛ <mutation-data-persisted (value: 2)
    1.25s | 2  | 🔴 >fetch-started                    
    2.05s | 2  | 🔴 <fetch-finished (value: 2)        
    "
  `);
});

test('very slow mutation revalidation then mutation', async () => {
  // Expected: long revalidation fetch overlaps a second mutation, causing the
  // first fetch to be aborted and a fresh fetch to commit the latest value.
  // First revalidation (2000ms) > second mutation (200ms) + second revalidation (200ms)
  const env = createDocumentStoreTestEnv(0);

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  // Set fetch durations: first revalidation slow (2000ms), second revalidation fast (200ms)
  env.setNextFetchDurations(2000, 200);

  // t=0: first mutation with revalidation (short 200ms mutation)
  env.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
    withRevalidation: true,
    duration: 200,
  });

  // Wait for the mutation to resolve (200ms) so revalidation starts (2000ms)
  // Start second mutation while first revalidation is still in progress
  await vi.advanceTimersByTimeAsync(300);

  env.addTimelineComment(
    'Slow revalidation still running; scheduler aborts in-flight fetch after new mutation to prevent stale commit.',
  );

  // t=300: second mutation starts during first revalidation (which started at t=200)
  // First revalidation would finish at t=2200, but gets aborted
  env.performClientUpdateAction(2, {
    withOptimisticUpdate: true,
    withRevalidation: true,
    duration: 200, // Second mutation + revalidation = 200 + 200 = 400ms < 2000ms first revalidation
  });

  await vi.runAllTimersAsync();

  expect(env.uiChanges).toEqual([0, 1, 2]);
  expect(env.numOfFinishedFetches).toBe(1);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |                                                                                                                 
    0     | 0  | ui-initialized                                                                                                  
    .     | 1  | ⬜ optimistic-ui-commit                                                                                          
    .     | 1  | ⬜ >mutation-started (value: 1)                                                                                  
    140ms | 1  | ⬜ <mutation-data-persisted (value: 1)                                                                           
    200ms | 1  | 🔴 >fetch-started                                                                                               
    300ms | 1  | -- Slow revalidation still running; scheduler aborts in-flight fetch after new mutation to prevent stale commit.
    .     | 2  | ⬛ optimistic-ui-commit                                                                                          
    .     | 2  | ⬛ >mutation-started (value: 2)                                                                                  
    440ms | 2  | ⬛ <mutation-data-persisted (value: 2)                                                                           
    500ms | 2  | 🟠 >fetch-started                                                                                               
    700ms | 2  | 🟠 <fetch-finished (value: 2)                                                                                   
    2.2s  | 2  | 🔴 <fetch-aborted 🚫                                                                                            
    "
  `);
});

test('fetch error', async () => {
  // Expected: first fetch succeeds, second fetch errors and UI enters error state.
  const env = createDocumentStoreTestEnv(0, {
    forceInitialDataInvalidation: true,
  });

  renderHook(() => {
    const { data, error } = env.useDocument();
    env.trackUIChanges(error ? 'error' : data?.value);
  });

  // First fetch starts automatically due to forceInitialDataInvalidation
  await vi.advanceTimersByTimeAsync(DEFAULT_FETCH_DURATION_MS + 10);

  // Mark next fetch as error (helper also mutates server data for timeline)
  env.errorInNextFetch();

  // Second fetch (will error)
  env.scheduleFetch('lowPriority');

  await vi.runAllTimersAsync();

  expect(env.uiChanges).toEqual([0, 'error']);
  expect(env.numOfFinishedFetches).toBe(2);
  expect(env.timelineString).toContain('fetch-error');
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui    |                                         
    0     | -     | 🔴 >fetch-started                       
    800ms | -     | 🔴 <fetch-finished (value: 0)           
    .     | 0     | ui-initialized                          
    810ms | 0     | 🟠 >fetch-started-from-manual-scheduling
    .     | 0     | 🟠 <fetch-error (value: "error")        
    .     | error | ui-changed                              
    "
  `);
});

function dynamicRealtimeThrottleMs(lastDuration: number): number {
  if (lastDuration > 300) {
    return 300;
  }
  return 100;
}

test('dynamically throttle realtime updates', async () => {
  // Expected: slow RTU fetch increases throttle window, causing coalescing of RTUs
  // and eventual commits for the latest updates.
  const env = createDocumentStoreTestEnv(0, { dynamicRealtimeThrottleMs });

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  const slowDuration = 300;
  const fastDuration = 200;

  // t=0: first RTU with slow fetch
  env.setNextFetchDurations(slowDuration, fastDuration, fastDuration);
  env.emulateExternalRTU(1);

  // t=320: second RTU
  await vi.advanceTimersByTimeAsync(slowDuration + 20);
  env.addTimelineComment('vvv throttle window (100ms) vvv', 300);
  env.emulateExternalRTU(2);

  // t=330: third RTU
  await vi.advanceTimersByTimeAsync(10);
  env.emulateExternalRTU(3);

  env.addTimelineComment('^^^ throttle window ^^^', 400);

  // t=660: fourth RTU
  await vi.advanceTimersByTimeAsync(330);
  env.emulateExternalRTU(4);

  await vi.runAllTimersAsync();

  expect(env.uiChanges).toEqual([0, 1, 3, 4]);
  expect(env.numOfFinishedFetches).toBe(3);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |                                   
    0     | 0  | ui-initialized                    
    .     | 0  | server-data-changed (value: 1)    
    .     | 0  | received-ws-data-change-event     
    .     | 0  | 🔴 >fetch-started                 
    300ms | 0  | 🔴 <fetch-finished (value: 1)     
    .     | 1  | ui-changed                        
    .     | 1  | -- vvv throttle window (100ms) vvv
    320ms | 1  | server-data-changed (value: 2)    
    .     | 1  | received-ws-data-change-event     
    330ms | 1  | server-data-changed (value: 3)    
    .     | 1  | received-ws-data-change-event     
    400ms | 1  | -- ^^^ throttle window ^^^        
    .     | 1  | scheduled-rt-fetch-started        
    .     | 1  | 🟠 >fetch-started                 
    600ms | 1  | 🟠 <fetch-finished (value: 3)     
    .     | 3  | ui-changed                        
    660ms | 3  | server-data-changed (value: 4)    
    .     | 3  | received-ws-data-change-event     
    700ms | 3  | scheduled-rt-fetch-started        
    .     | 3  | 🟡 >fetch-started                 
    900ms | 3  | 🟡 <fetch-finished (value: 4)     
    .     | 4  | ui-changed                        
    "
  `);
});

test('dynamically throttle multiple realtime updates at same time with delay inferior to debounce 2', async () => {
  // Expected: dynamic throttle shortens for recent fetches, allowing two RTU fetches
  // while coalescing multiple RTU signals into the last update.
  const env = createDocumentStoreTestEnv(0, {
    dynamicRealtimeThrottleMs(lastFetchDuration: number) {
      return lastFetchDuration < 700 ? 100 : 500;
    },
  });

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  const shortFetch = 500;
  const mediumFetch = 1000;
  env.setNextFetchDurations(shortFetch, mediumFetch, shortFetch);

  // t=0: first RTU triggers immediate fetch (no prior fetch, no throttle)
  env.emulateExternalRTU(1);

  // t=500: first fetch completes (500ms < 700ms → short 100ms throttle starts after)
  env.addTimelineComment('vvv 100ms throttle (500ms fetch < 700ms) vvv', 501);
  env.addTimelineComment('^^^ throttle ends ^^^', 600);

  // t=700: second RTU after throttle window → immediate start
  await vi.advanceTimersByTimeAsync(700);
  env.emulateExternalRTU(2);

  // t=900: third RTU while second fetch is in flight → coalesced
  await vi.advanceTimersByTimeAsync(200);
  env.emulateExternalRTU(3);

  // t=1700: second fetch completes (1000ms >= 700ms → long 500ms throttle starts after)
  env.addTimelineComment('vvv 500ms throttle (1000ms fetch >= 700ms) vvv', 1701);
  env.addTimelineComment('^^^ throttle ends, delayed fetch runs ^^^', 2200);

  await vi.runAllTimersAsync();

  expect(env.uiChanges).toEqual([0, 1, 3]);
  expect(env.numOfFinishedFetches).toBe(3);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ui |                                                  
    0      | 0  | ui-initialized                                   
    .      | 0  | server-data-changed (value: 1)                   
    .      | 0  | received-ws-data-change-event                    
    .      | 0  | 🔴 >fetch-started                                
    500ms  | 0  | 🔴 <fetch-finished (value: 1)                    
    .      | 1  | ui-changed                                       
    501ms  | 1  | -- vvv 100ms throttle (500ms fetch < 700ms) vvv  
    600ms  | 1  | -- ^^^ throttle ends ^^^                         
    700ms  | 1  | server-data-changed (value: 2)                   
    .      | 1  | received-ws-data-change-event                    
    .      | 1  | 🟠 >fetch-started                                
    900ms  | 1  | server-data-changed (value: 3)                   
    .      | 1  | received-ws-data-change-event                    
    1.7s   | 1  | 🟠 <fetch-finished (value: 3)                    
    .      | 3  | ui-changed                                       
    1.701s | 3  | -- vvv 500ms throttle (1000ms fetch >= 700ms) vvv
    2.2s   | 3  | -- ^^^ throttle ends, delayed fetch runs ^^^     
    .      | 3  | scheduled-rt-fetch-started                       
    .      | 3  | 🟡 >fetch-started                                
    2.7s   | 3  | 🟡 <fetch-finished (value: 3)                    
    "
  `);
});

test('simple mutation that triggers a RTU', async () => {
    // Expected: mutation triggers RTU fetch after optimistic commit, committing the server state.
  const env = createDocumentStoreTestEnv(0, {
    dynamicRealtimeThrottleMs: (lastDuration) => (lastDuration > 300 ? 300 : 100),
  });

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  // t=0: schedule low priority fetch (short duration)
  env.setNextFetchDurations(20);
  env.scheduleFetch('lowPriority');

  // t=110: mutation with RTU
  await vi.advanceTimersByTimeAsync(110);
  env.performClientUpdateAction(1, {
              withOptimisticUpdate: true,
              duration: 200,
              triggerRTU: true,
    addServerDataChangeAction: true,
  });

  await vi.runAllTimersAsync();

  expect(env.serverHistory).toEqual([0, 1]);
  expect(env.uiChanges).toEqual([0, 1]);
  expect(env.numOfFinishedFetches).toBe(2);
  expect(env.timelineString).toContain('scheduled-rt-fetch-started');
  expect(env.timelineString).toMatchInlineSnapshot(`
      "
    time  | ui |                                         
    0     | 0  | ui-initialized                          
    .     | 0  | 🔴 >fetch-started-from-manual-scheduling
    20ms  | 0  | 🔴 <fetch-finished (value: 0)           
    110ms | 1  | ⬜ optimistic-ui-commit                  
    .     | 1  | ⬜ >mutation-started (value: 1)          
    250ms | 1  | server-data-changed (value: 1)          
    .     | 1  | ⬜ <mutation-data-persisted (value: 1)   
    300ms | 1  | received-ws-data-change-event           
    310ms | 1  | scheduled-rt-fetch-started              
    .     | 1  | 🟠 >fetch-started                       
    1.11s | 1  | 🟠 <fetch-finished (value: 1)           
      "
    `);
  });

  test.concurrent(
    'slow mutation then external RTU while mutation RTU is running',
    async () => {
      // Expected: external RTU schedules another fetch while mutation RTU is in flight,
      // both fetches eventually commit in order.
      const store = createTestStore(0);

      await waitTimeline(
        [
          [0, () => store.fetch('lowPriority', 20)],
          [110, () => action(store, 1, defaultRTUMutation)],
          [340, () => store.emulateExternalRTU(2)],
        ],
        510,
      );

      expect(store.server.history).toEqual([0, 1, 2]);
      expect(store.ui.changesHistory).toEqual([0, 1, 2]);
      expect(store.numOfFetchs).toEqual(3);

      expect(store.actions).toMatchTimeline(`
        "
        .
        1 - optimistic-ui-commit
        1 - mutation-started
        1 - server-data-changed
        1 - mutation-finished
        rt-fetch-scheduled
        scheduled-rt-fetch-started : 2
          2 - server-data-changed
          rt-fetch-scheduled

        ---
        2 - fetch-finished : 2
        2 - fetch-ui-commit
        OR
        1 - fetch-finished : 2
        1 - fetch-ui-commit
        ---

          scheduled-rt-fetch-started : 3
          2 - fetch-finished : 3
          2 - fetch-ui-commit
        "
    `);
    },
  );

  test.concurrent(
    'slow mutation then new mutation while prev mutation RTU is running',
    async () => {
      // Expected: new mutation aborts in-flight RTU fetch, then schedules a new RTU fetch
      // that commits the latest mutation result.
      const store = createTestStore(0);

      await waitTimeline(
        [
          [0, () => store.fetch('lowPriority', 20)],
          [110, () => action(store, 1, defaultRTUMutation)],
          [340, () => action(store, 2, defaultRTUMutation)],
        ],
        600,
      );

      expect(store.server.history).toEqual([0, 1, 2]);
      expect(store.ui.changesHistory).toEqual([0, 1, 2]);
      expect(store.numOfFetchs).toEqual(3);

      expect(store.actions).toMatchTimeline(`
        "
        .
        1 - optimistic-ui-commit
        1 - mutation-started
        1 - server-data-changed
        1 - mutation-finished
        rt-fetch-scheduled

        scheduled-rt-fetch-started : 2

          2 - optimistic-ui-commit
          2 - mutation-started

        fetch-aborted : 2

          2 - server-data-changed
          2 - mutation-finished
          rt-fetch-scheduled

          scheduled-rt-fetch-started : 3
          2 - fetch-finished : 3
          2 - fetch-ui-commit
        "
    `);
    },
  );

  test.concurrent(
    'slow mutation then new mutation while prev mutation is running',
    async () => {
      // Expected: overlapping mutations each trigger RTU scheduling, but only one RTU fetch runs,
      // committing the latest data.
      const store = createTestStore(0);

      await waitTimeline(
        [
          [0, () => store.fetch('lowPriority', 20)],
          [110, () => action(store, 1, defaultRTUMutation)],
          [200, () => action(store, 2, defaultRTUMutation)],
        ],
        600,
      );

      expect(store.server.history).toEqual([0, 1, 2]);
      expect(store.ui.changesHistory).toEqual([0, 1, 2]);
      expect(store.numOfFetchs).toEqual(2);

      expect(store.actions).toMatchTimeline(`
      "
      .
      1 - optimistic-ui-commit
      1 - mutation-started
        2 - optimistic-ui-commit
        2 - mutation-started
      1 - server-data-changed
      1 - mutation-finished
      rt-fetch-scheduled
        2 - server-data-changed
        2 - mutation-finished
        rt-fetch-scheduled
        scheduled-rt-fetch-started : 2
        2 - fetch-finished : 2
        2 - fetch-ui-commit
      "
    `);
    },
  );

  test.concurrent('rtu mutations without optimistic updates', async () => {
    // Expected: no optimistic UI commits, RTU fetches drive UI updates after server change.
    const store = createTestStore(0);

    const rtuWithoutOptimisticUpdate = {
      withOptimisticUpdate: false,
      duration: 200,
      triggerRTU: true,
    };

    await waitTimeline(
      [
        [0, () => store.fetch('lowPriority', 20)],
        [110, () => action(store, 1, rtuWithoutOptimisticUpdate)],
        [110 + 220, () => action(store, 2, rtuWithoutOptimisticUpdate)],
      ],
      1000,
    );

    expect(store.server.history).toEqual([0, 1, 2]);
    expect(store.ui.changesHistory).toEqual([0, 2]);

    expect(store.numOfFetchs).toEqual(3);

    expect(store.actions).toMatchTimeline(`
      "
      fetch-started : 1
      fetch-finished : 1
      fetch-ui-commit
      1 - mutation-started
      1 - server-data-changed
      1 - mutation-finished
      rt-fetch-scheduled
      scheduled-rt-fetch-started : 2
        2 - mutation-started
      fetch-aborted : 2
        2 - server-data-changed
        2 - mutation-finished
        rt-fetch-scheduled
        scheduled-rt-fetch-started : 3
        2 - fetch-finished : 3
        2 - fetch-ui-commit
      "
    `);
  });

  test.concurrent(
    'schedule rtu updates then schedulle a fetch right before the rtu starts',
    async () => {
      // Expected: low priority fetch starts before RTU fetch, so RTU is skipped and
      // the low priority fetch commits the server state.
      const store = createTestStore(0, {
        dynamicRealtimeThrottleMs() {
          return 300;
        },
      });

      await waitTimeline(
        [
          [0, () => store.fetch('lowPriority', 20)],
          [110, () => store.emulateExternalRTU(1)],
          [110 + 190, () => store.fetch('lowPriority', 20)],
        ],
        800,
      );

      expect(store.server.history).toEqual([0, 1]);
      expect(store.ui.changesHistory).toEqual([0, 1]);

      expect(store.numOfFetchs).toEqual(2);

      expect(store.actions).toMatchTimeline(`
      "
      fetch-started : 1
      fetch-finished : 1
      fetch-ui-commit
      1 - server-data-changed
      rt-fetch-scheduled
      fetch-started : 2
      1 - fetch-finished : 2
      1 - fetch-ui-commit
      "
    `);
    },
  );

  test.concurrent('mutation that triggers multiple rtu updates', async () => {
    // Expected: burst of RTU fetch requests is coalesced into a single scheduled RTU fetch.
    const store = createTestStore(0, {
      dynamicRealtimeThrottleMs() {
        return 300;
      },
    });

    await waitTimeline(
      [
        [0, () => store.fetch('lowPriority', 20)],
        [110, () => action(store, 1, { duration: 400 })],
        [110 + 200, () => store.fetch('realtimeUpdate')],
        [110 + 200, () => store.fetch('realtimeUpdate')],
        [110 + 200, () => store.fetch('realtimeUpdate')],
        [110 + 200, () => store.fetch('realtimeUpdate')],
        [110 + 200, () => store.fetch('realtimeUpdate')],
        [110 + 200, () => store.fetch('realtimeUpdate')],
      ],
      900,
    );

    expect(store.actions).toMatchTimeline(`
        "
        fetch-started : 1
        fetch-finished : 1
        fetch-ui-commit
        1 - mutation-started
        rt-fetch-scheduled
        rt-fetch-scheduled
        rt-fetch-scheduled
        rt-fetch-scheduled
        rt-fetch-scheduled
        rt-fetch-scheduled
        1 - mutation-finished
        scheduled-rt-fetch-started : 2
        1 - fetch-finished : 2
        1 - fetch-ui-commit
        "
      `);

    expect(store.ui.changesHistory).toEqual([0, 1]);

    expect(store.numOfFetchs).toEqual(2);
  });
});
