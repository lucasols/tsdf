# TSDF

A data fetching solution based on T-State.

## Browser Tabs Sync

`createDocumentStore`, `createCollectionStore`, and `createListQueryStore` now require an `id`.

- Reuse the same id for the same logical store across browser tabs.
- Use a different id for unrelated stores.
- Cross-tab sync is enabled automatically when `BroadcastChannel` is available.

```ts
const documentStore = createDocumentStore({
  id: 'user-profile',
  fetchFn,
  errorNormalizer,
  lowPriorityThrottleMs: 5_000,
  baseCoalescingWindowMs: 100,
  backgroundCoalescingWindowMultiplier: 3,
  blockWindowClose: null,
});
```

Playwright coverage for the browser-tabs feature runs with:

```bash
pnpm test:playwright
```
