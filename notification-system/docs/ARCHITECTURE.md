# Architecture

```
  Client ──HTTP──►  Express API  ──────────►  MongoDB  ◄──────────  Worker (node-cron)
                    routes                    reminders              every 5 seconds:
                    controllers               notifications          1. release stuck reminders
                    services                  failedattempts         2. claim a due reminder
                                                                     3. create notification
                                                                     4. mark completed / retry
```

- The API and the worker never talk to each other directly. **MongoDB is the only shared place.**
- The worker can run **inside the API process** (`npm run dev`) or **separately** (`npm run worker`). You can run as many of either as you want.

## Code layers

| Layer | Job |
|---|---|
| routes | connect a URL to middlewares and a controller |
| middlewares | check the user header, validate input, handle errors |
| controllers | read the request, call a service, send the response |
| services | business rules + database queries |
| models | schemas + indexes |
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

1. **Claim (lock).** `findOneAndUpdate` finds a `pending` reminder with `nextRunAt <= now` and, in the same operation, sets it to `processing` with `lockedBy = this worker` and `lockedUntil = now + 60s`. Because the find and the update are one atomic operation, two workers can never claim the same reminder.
2. **Create the notification.** The unique index on `reminderId` guarantees there is never more than one.
3. **Mark completed.** The update filter includes `lockedBy: this worker`, so a worker that lost its lock can't change the reminder anymore.
4. **On error.** Save a `failedattempts` record. If tries are left, set the reminder back to `pending` with a later `nextRunAt` (30s, then 60s, then 120s...). Otherwise set it to `failed`.

## Why node-cron?

- It's a simple, readable way to say "run this every 5 seconds" (`*/5 * * * * *`).
- `noOverlap: true`: if one run is still busy (for example a slow DB), the next run is skipped. The same worker never runs twice at the same time.
- It is the only scheduling dependency; no Redis or queue server is needed.

## Edge cases

| Situation | What happens |
|---|---|
| **Server restart / crash while processing** | The reminder stays `processing` with an expired `lockedUntil`. On its next run, any worker sets it back to `pending` (`releaseStuckReminders`) and processes it again. If the notification was already created before the crash, the unique index stops a second one and the reminder is just marked `completed`. |
| **Overdue reminders** (due while the server was off) | They are processed on the next run, oldest first, and `delayMs` shows how late they were. They are not skipped. |
| **Many workers at the same time** | Atomic claim + `lockedBy` check + unique index. Tested with 5 workers and 40 reminders: exactly 40 notifications. |
| **User edits or cancels while the worker is working on it** | Update and cancel only match `status: pending`. If the worker already claimed the reminder, the user gets `409`. No half-updated state is possible. |
| **Retry creates a duplicate?** | No. The unique index blocks it, and error `11000` is treated as success. |
| **Database down** | The worker run logs the error and tries again on the next cron run. The app doesn't crash. |
| **Time zones** | Dates without a timezone are rejected, because "10:00" alone is unclear. Everything is stored in UTC. The user's timezone is saved and used to show `dueAtLocal`. One-time reminders are fixed moments in time, so daylight-saving changes don't affect them. |

## Known limitations

- A reminder stuck because of a crash gets one extra attempt after recovery, so it can go one over `maxAttempts`. This keeps the recovery code simple.
- The worker checks every 5 seconds, so a notification can be up to ~5 seconds late. The interval is configurable.
- For huge volumes, a job queue (e.g. BullMQ with Redis) would replace polling.
