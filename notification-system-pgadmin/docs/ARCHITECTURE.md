# Architecture

```
  Client ──HTTP──►  Express API  ──SQL──►  PostgreSQL  ◄──SQL──  Worker (node-cron)
                    routes                 reminders             every 5 seconds:
                    controllers            notifications         1. release stuck reminders
                    services               failed_attempts       2. claim a due reminder
                                                                 3. create notification
                                                                 4. mark completed / retry
```

- The API and the worker never talk to each other directly. **PostgreSQL is the only shared place.**
- The worker can run **inside the API process** (`npm run dev`) or **separately** (`npm run worker`). You can run as many of either as you want.

## Code layers

| Layer | Job |
|---|---|
| `db/schema.sql` | tables, constraints, indexes |
| `config/db.js` | connection pool, `query()` helper, creates the DB + tables on start |
| routes | connect a URL to middlewares and a controller |
| middlewares | check the user header, validate input, handle errors |
| controllers | read the request, call a service, send the response |
| services | business rules + SQL |
| models | status list + row → API object (`due_at` → `dueAt`) |
| jobs | the background worker |

## Reminder status flow

```
  create ──► pending ──(worker claims)──► processing ──(success)──► completed
               │  ▲                            │
       cancel  │  └──(failed, tries left)──────┤
               ▼                               │ (failed, no tries left)
           cancelled                           ▼
                                             failed ──(POST /retry)──► pending
```

## How the worker processes one reminder

File: `src/jobs/reminder.job.js`

1. **Claim (lock)**
   ```sql
   UPDATE reminders SET status = 'processing', locked_by = $1, locked_until = now() + ..., attempts = attempts + 1
   WHERE id = (SELECT id FROM reminders
               WHERE status = 'pending' AND next_run_at <= now()
               ORDER BY next_run_at LIMIT 1
               FOR UPDATE SKIP LOCKED)
   RETURNING *;
   ```
   - `FOR UPDATE` locks the chosen row.
   - `SKIP LOCKED` makes other workers skip that row and take the next one, instead of waiting for it.
   - Result: two workers never get the same reminder, and they don't block each other either.
2. **Create the notification**: `INSERT ... ON CONFLICT (reminder_id) DO NOTHING`. There is never more than one.
3. **Mark completed**: `UPDATE ... WHERE id = $1 AND status = 'processing' AND locked_by = <this worker>`. A worker that lost its lock can't change the reminder anymore.
4. **On error**: insert a row into `failed_attempts`. If tries are left, set the reminder back to `pending` with a later `next_run_at` (30s, then 60s, then 120s...). Otherwise set it to `failed`.

## Why node-cron?

- It's a simple, readable way to say "run this every 5 seconds" (`*/5 * * * * *`).
- `noOverlap: true`: if one run is still busy (for example a slow DB), the next run is skipped. The same worker never runs twice at the same time.
- No Redis or queue server is needed.

## Edge cases

| Situation | What happens |
|---|---|
| **Server restart / crash while processing** | The reminder stays `processing` with an expired `locked_until`. On its next run, any worker sets it back to `pending` and processes it. If the notification was already created before the crash, `ON CONFLICT DO NOTHING` stops a second one and the reminder is just marked `completed`. |
| **Overdue reminders** (due while the server was off) | Processed on the next run, oldest first; `delay_ms` shows how late they were. They are not skipped. |
| **Many workers at the same time** | `FOR UPDATE SKIP LOCKED` + `locked_by` check + `UNIQUE (reminder_id)`. Tested with 5 workers and 40 reminders: exactly 40 notifications. |
| **User edits or cancels while the worker is working on it** | Update and cancel only match `status = 'pending'`. If the worker already claimed the reminder, the user gets `409`. Both are single statements, so there is no half-updated state. |
| **Retry creates a duplicate?** | No. `ON CONFLICT DO NOTHING`. |
| **Database down** | The worker run logs the error and tries again on the next cron run. The app doesn't crash. |
| **Servers with different clocks** | All "is it due?" checks use PostgreSQL's `now()`, so every server uses the same clock. |
| **API and worker start at the same moment** | Table creation runs inside a transaction with `pg_advisory_xact_lock`, so they take turns. |
| **Time zones** | Dates without a timezone are rejected, because "10:00" alone is unclear. Everything is stored as `TIMESTAMPTZ` (UTC). The user's timezone is saved and used to show `dueAtLocal`. Daylight-saving changes don't affect one-time reminders. |

## Known limitations

- A reminder stuck because of a crash gets one extra attempt after recovery, so it can go one over `max_attempts`. This keeps the recovery SQL simple.
- The worker checks every 5 seconds, so a notification can be up to ~5 seconds late. The interval is configurable.
- `schema.sql` only creates what doesn't exist yet. Changing an existing column needs a migration tool (e.g. `node-pg-migrate`) in a real project.
