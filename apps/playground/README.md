# TSDF Playground

A small Vite app for manually exercising TSDF stores while developing the library.

```bash
pnpm playground
```

The dev command starts both Vite on `http://localhost:5173` and a local API
server on `http://127.0.0.1:5174`.

The API server persists its fake data in `.playground-data/db.json`, so changes
survive restarts and can be exercised across multiple browser tabs. It also
exposes an SSE stream at `/api/events` so the playground can invalidate TSDF
stores with `realtimeUpdate` priority when another tab mutates data.

The browser client uses `@ls-stack/typed-fetch` with response schemas. The app
imports the local TSDF `src/` files through Vite aliases, so changes to the
library source are reflected without building the package first.
