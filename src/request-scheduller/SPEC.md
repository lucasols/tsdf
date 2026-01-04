The request scheduler is responsible for scheduling and executing fetch and mutation requests.

- Fetch requests retrieve data from the server.
- Mutation requests update the server data.

## Rules and features

## Correctly handles concurrent mutations and fetches

When fetches and mutations happen at same time, the scheduler may cancel or reschedule the fetch so the final retrieved data reflects the most recent state of the server.

## Prevent overfetching from low priority fetches or redundant fetches

Low priority fetches are throttled to prevent overfetching. The same way redundant fetches are rescheduled or ignored.


