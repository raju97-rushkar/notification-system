# Database Design (Sequelize models)

There are three models, each stored in one PostgreSQL table:

| Model | Table | File |
|---|---|---|
| `Reminder` | `reminders` | [src/models/reminder.model.js](../src/models/reminder.model.js) |
| `Notification` | `notifications` | [src/models/notification.model.js](../src/models/notification.model.js) |
| `FailedAttempt` | `failed_attempts` | [src/models/failedAttempt.model.js](../src/models/failedAttempt.model.js) |

Every model uses `underscored: true`. In JavaScript we write `dueAt`; in the database the column is `due_at`. Sequelize converts between the two automatically.

## 1. Relationships (associations)

Defined in [src/models/index.js](../src/models/index.js):

```
Reminder 1 ──── 1 Notification      Reminder.hasOne(Notification)    / Notification.belongsTo(Reminder)
Reminder 1 ──── N FailedAttempt     Reminder.hasMany(FailedAttempt)  / FailedAttempt.belongsTo(Reminder)
```

- These create the **foreign keys** `notifications.reminder_id → reminders.id` and `failed_attempts.reminder_id → reminders.id`.
- `onDelete: 'CASCADE'`: if a reminder is deleted, its notification and failure logs are deleted too. There are never orphan rows.
- You can load related data with `include`:
  ```js
  Reminder.findByPk(id, { include: 'notification' });
  Reminder.findByPk(id, { include: 'failedAttempts' });
  ```
  Both are used in the tests.

## 2. Primary keys

All three tables use `id: UUID` with `defaultValue: DataTypes.UUIDV4`.

**Why UUID and not 1, 2, 3?** Ids can't be guessed (`/reminders/5` → try `/reminders/6`), and an id can be generated anywhere without asking the database.

## 3. Reminder

| Field (JS) | Type | Meaning |
|---|---|---|
| `id` | UUID, PK | |
| `userId` | STRING | owner |
| `title` / `message` | STRING(200) / TEXT | content |
| `dueAt` | DATE (= `TIMESTAMPTZ`, stored as UTC) | when it should fire |
| `timezone` | STRING | for `dueAtLocal` |
| `status` | **ENUM** | `pending / processing / completed / failed / cancelled`. The database refuses other values |
| `nextRunAt` | DATE | when the worker should pick it up (moved later after a failure) |
| `attempts` / `maxAttempts` | INTEGER | tries so far / allowed |
| `lastError` | TEXT | last error message |
| `lockedBy` / `lockedUntil` | STRING / DATE | which worker has it, until when (hidden from the API by `toJSON`) |
| `processedAt` | DATE | |
| `dueAtLocal` | **VIRTUAL** | not stored; calculated from `dueAt` + `timezone` |
| `createdAt` / `updatedAt` | DATE | added by `timestamps: true` |

## 4. Notification

| Field | Type | Meaning |
|---|---|---|
| `reminderId` | UUID, **unique**, FK | one notification per reminder |
| `userId`, `title`, `message` | | copied from the reminder, so listing needs no JOIN |
| `scheduledFor` | DATE | the reminder's `dueAt` |
| `delayMs` | BIGINT (getter → Number) | how late it was created |
| `readAt` | DATE | `null` = unread |

**`unique: true` on `reminderId` is the duplicate-prevention guarantee.** PostgreSQL refuses a second row for the same reminder, no matter how many workers try. We insert with `bulkCreate([...], { ignoreDuplicates: true })`, which becomes `INSERT ... ON CONFLICT DO NOTHING`. If the row already exists, nothing happens and **no error** is thrown.

That last point matters because the insert runs inside a transaction. In PostgreSQL, any error inside a transaction cancels the whole transaction.

## 5. FailedAttempt

`id, reminderId (FK), attempt, error, workerId, willRetry, createdAt`. It has `updatedAt: false` because a log row never changes.

PostgreSQL has no TTL index (MongoDB has one), so the worker deletes rows older than 30 days itself (at most once per hour).

## 6. Indexes

Defined in each model's `indexes` option. The `fields` are database column names.

| Table | Index | Columns | Used by |
|---|---|---|---|
| reminders | `idx_reminders_pending_next_run` | `next_run_at` **WHERE status = 'pending'** | worker: find due reminders |
| reminders | `idx_reminders_processing_locked` | `locked_until` **WHERE status = 'processing'** | worker: find stuck reminders |
| reminders | `idx_reminders_user_status_due` | `user_id, status, due_at` | API: filter by status, sort by date |
| reminders | `idx_reminders_user_created` | `user_id, created_at DESC` | API: newest first |
| notifications | `notifications_reminder_id_key` | `reminder_id` (unique) | duplicate prevention |
| notifications | `idx_notifications_user_created` | `user_id, created_at DESC` | API: my notifications |
| failed_attempts | `idx_failed_attempts_reminder` | `reminder_id` | API: failures of a reminder |
| failed_attempts | `idx_failed_attempts_created` | `created_at` | worker: delete old logs |

**How the column order was chosen:** columns compared with `=` come first (`user_id`, `status`). The sort or range column comes last (`due_at`, `next_run_at`).

**Checked with `EXPLAIN ANALYZE`** on 50,000 reminders (500 users, 90% completed) and about 45,000 notifications:

| Query | Plan | Time |
|---|---|---|
| Worker: claim a due reminder (`FOR UPDATE SKIP LOCKED`) | Index Scan `idx_reminders_pending_next_run` | 0.04 ms |
| Worker: find stuck reminders | Index Scan `idx_reminders_processing_locked` | 0.03 ms |
| API: my reminders, newest first | Index Scan `idx_reminders_user_created` | 0.06 ms |
| API: my reminders by status, sorted by due date | Bitmap Index Scan `idx_reminders_user_status_due` | 0.03 ms |
| API: count for pagination | Bitmap Index Scan `idx_reminders_user_created` | 0.15 ms |
| API: my (unread) notifications | Index Scan `idx_notifications_user_created` | 0.04–0.08 ms |

Every query uses an index, and none needs a full table scan. The two worker rows were measured again after the change below.

### Partial indexes for the worker

The worker only looks for `pending` and `processing` reminders, but after a few weeks almost every row is `completed`. The first version used composite indexes on `(status, next_run_at)` and `(status, locked_until)`. They were fast, but they stored **every** row, including finished ones.

They are now **partial indexes** (`CREATE INDEX ... WHERE status = 'pending'`). In Sequelize this is the index option `where: { status: STATUS.PENDING }`. Only the rows the worker can still pick up are in them.

Measured on 200,000 reminders (200 pending, 10 processing, the rest completed):

| Index | Size | Query time |
|---|---|---|
| `(status, next_run_at)` (before) | 11 MB | 0.040 ms |
| `(next_run_at) WHERE status = 'pending'` (now) | **16 kB** | 0.043 ms |
| `(status, locked_until)` (before) | 1288 kB | 0.024 ms |
| `(locked_until) WHERE status = 'processing'` (now) | **16 kB** | 0.034 ms |

The queries are no faster today. The gain is that these indexes no longer grow as completed reminders pile up, so they always fit in memory.

**Existing databases:** `sync()` creates the new indexes but never drops the old ones. Drop them once by hand:

```sql
DROP INDEX IF EXISTS idx_reminders_status_next_run, idx_reminders_status_locked_until;
```

## 7. Query decisions

- **Filters** use Sequelize operators: `Op.gte`, `Op.lte`, `Op.iLike` (case-insensitive LIKE), `Op.ne`. Search text is LIKE-escaped, so `%` and `_` are not wildcards.
- **Pagination** uses `findAndCountAll({ where, order, limit, offset })`, which returns the rows of the page plus the total count.
- **Sorting:** `sortBy` and `order` are checked by zod, so only allowed columns reach `order`. `id` is added as a tie-breaker so pages never repeat rows.
- **Conditional updates:** `Reminder.update(changes, { where: { id, userId, status: 'pending' }, returning: true })` is one SQL statement. That is how update and cancel avoid race conditions with the worker.
- **SQL injection:** Sequelize always sends values as parameters. There is a test that stores `x'); DROP TABLE reminders; --` as a normal title.

## 8. sync() vs migrations

`sequelize.sync()` creates missing tables and indexes on start, but **it does not change existing tables**. For example, a new column on an existing table will not be added. It's fine for this assignment. A real production project would use migrations (`sequelize-cli`: `db:migrate`), so every schema change is versioned and can be rolled back.
