# Architecture

```
  Client ──HTTP──►  Express API  ──Sequelize──►  PostgreSQL  ◄──Sequelize──  Worker (node-cron)
                    routes                       reminders                   every 5 seconds:
                    controllers                  notifications               1. release stuck reminders
                    services                     failed_attempts             2. TX: claim (SKIP LOCKED)
                                                                             3. TX: notification + completed
                                                                             4. TX: on error, retry/failed + log
```
(TX = database transaction)

The API and the worker never talk to each other directly. **PostgreSQL is the only shared place.** The worker can run inside the API (`npm run dev`) or as separate processes (`npm run worker`), as many as you want.

## Reminder status flow

```
  create ──► pending ──(worker claims)──► processing ──(success)──► completed
               │  ▲                            │
       cancel  │  └──(failed, tries left)──────┤
               ▼                               │ (failed, no tries left)
           cancelled                           ▼
                                             failed ──(POST /retry)──► pending
```

## The worker and its transactions

File: [src/jobs/reminder.job.js](../src/jobs/reminder.job.js)

### Transaction 1: claim a reminder

```js
sequelize.transaction(async (transaction) => {
  const reminder = await Reminder.findOne({
    where: { status: 'pending', nextRunAt: { [Op.lte]: new Date() } },
    order: [['nextRunAt', 'ASC']],
    lock: transaction.LOCK.UPDATE,   // SELECT ... FOR UPDATE
    skipLocked: true,                //            SKIP LOCKED
    transaction,
  });
  await reminder.update({ status: 'processing', lockedBy, lockedUntil, attempts: +1 }, { transaction });
});
```

- `FOR UPDATE` locks the row until the transaction ends.
- `SKIP LOCKED` makes other workers skip that row and take the next one. They don't wait, and they never get the same row.
- After COMMIT the status is `processing`, so no other worker's query matches it anymore.

### Transaction 2: create the notification + mark completed

```js
sequelize.transaction(async (transaction) => {
  await createNotification(reminder, transaction);                       // INSERT ... ON CONFLICT DO NOTHING
  const [count] = await Reminder.update({ status: 'completed', ... },
    { where: { id, status: 'processing', lockedBy: workerId }, transaction });
  if (count === 0) throw new Error('Lock lost');                          // -> ROLLBACK
});
```

**Both writes succeed together or neither does.**
- If the status update fails, or our lock was taken by another worker, the notification insert is rolled back too.
- We can never end up with "notification created, but the reminder is still processing".
- The test *"if marking completed fails, the notification insert is rolled back too"* proves it.

### Transaction 3: on failure

The reminder's status change (back to `pending` with a later `nextRunAt`, or `failed`) and the new `failed_attempts` row are saved in one transaction. The log and the status always match.

## Duplicate prevention: three layers

1. **SKIP LOCKED claim:** two workers never claim the same reminder.
2. **`lockedBy` check + transaction:** a worker that lost its lock can't complete the reminder, and its notification insert is rolled back.
3. **`unique` reminderId + `ignoreDuplicates`:** even if all of the above failed, PostgreSQL would still refuse a second notification.

## Why node-cron?

- Simple: `*/5 * * * * *` = every 5 seconds.
- `noOverlap: true`: if one run is still busy, the next one is skipped. The same worker never runs twice at once.
- No Redis or queue server is needed.

## Edge cases

| Situation | What happens |
|---|---|
| **Server restart / crash while processing** | The reminder stays `processing` with an expired `lockedUntil`. The next run of any worker sets it back to `pending` and processes it. Thanks to transaction 2, a crash in the middle leaves no half-done work. |
| **Overdue reminders** | Processed on the next run, oldest first. `delayMs` shows how late they were. |
| **Many workers / many servers** | SKIP LOCKED + `lockedBy` + unique. Tested with 5 parallel workers on 40 reminders: exactly 40 notifications. |
| **User edits or cancels while the worker has it** | Update and cancel only match `status: 'pending'` (one SQL statement), otherwise `409`. |
| **Retry creates a duplicate?** | No. Layers 2 and 3. |
| **Database down** | The worker logs the error and tries again on the next cron run. |
| **API + worker start at the same time** | `sync()` runs inside a transaction with `pg_advisory_xact_lock`, so they take turns creating tables. |
| **Time zones** | Dates without an offset are rejected. Storage is `TIMESTAMPTZ` (UTC). `dueAtLocal` is a VIRTUAL field. |

## Known limitations

- A crash-recovered reminder gets one extra attempt, so it can go one over `maxAttempts`. This keeps the recovery code simple.
- Up to ~5 seconds of delay because of the cron interval. It's configurable.
- `sync()` doesn't alter existing tables. Use migrations in production.
- Worker times use the Node.js clock (`new Date()`). With several servers, keep their clocks in sync (NTP). The raw-SQL version uses PostgreSQL's `now()` instead.
