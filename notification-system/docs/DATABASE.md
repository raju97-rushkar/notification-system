# Database Design

The database has three collections: `reminders`, `notifications`, `failedattempts`.

## 1. reminders

| Field | Meaning |
|---|---|
| `userId` | owner of the reminder |
| `title`, `message` | content |
| `dueAt` | when it should fire (stored in UTC) |
| `timezone` | user's timezone, only used for `dueAtLocal` in responses |
| `status` | `pending` → `processing` → `completed` (or `failed` / `cancelled`) |
| `nextRunAt` | when the worker should pick it up. Equal to `dueAt` at first, moved later after a failure |
| `attempts`, `maxAttempts` | how many tries so far / allowed |
| `lastError` | message of the last error |
| `lockedBy`, `lockedUntil` | which worker is processing it, and until when (the "lock") |
| `processedAt` | when the notification was created |

**Why `nextRunAt` and not just `dueAt`?** After a failure we want to try again later, but we don't want to change the time the user chose. So the worker only looks at `nextRunAt`, and `dueAt` stays as the user set it.

### Indexes

| Index | Used by |
|---|---|
| `{ status: 1, nextRunAt: 1 }` | worker: "pending reminders whose time has come" |
| `{ status: 1, lockedUntil: 1 }` | worker: "stuck reminders whose lock has expired" |
| `{ userId: 1, status: 1, dueAt: 1 }` | API: list my reminders, filter by status, sort by date |
| `{ userId: 1, createdAt: -1 }` | API: list my reminders, newest first |

**How the order of fields was chosen:** fields used with `=` come first (`status`, `userId`). The field used for sorting or ranges (`<=`, `>=`) comes last (`nextRunAt`, `dueAt`). With this order MongoDB can jump straight to the right documents, already sorted, instead of scanning the whole collection. This is called the "ESR rule": **E**quality, **S**ort, **R**ange.

## 2. notifications

| Field | Meaning |
|---|---|
| `reminderId` | which reminder created it |
| `userId`, `title`, `message` | copied from the reminder, so listing notifications needs no join |
| `scheduledFor` | the reminder's `dueAt` |
| `delayMs` | how late it was created |
| `readAt` | `null` = unread |

### Indexes

| Index | Used by |
|---|---|
| **`{ reminderId: 1 }` unique** | **duplicate prevention** |
| `{ userId: 1, createdAt: -1 }` | API: my notifications, newest first |

**The unique index is the most important part of the design.** MongoDB itself refuses a second notification for the same reminder (error `11000`), even if two workers try at exactly the same moment. Our code catches error `11000` and treats it as "already done". A check in our own code ("find, then insert if missing") would not be safe: two workers can both run the "find" before either one inserts.

## 3. failedattempts

`{ reminderId, attempt, error, workerId, willRetry, createdAt }`, with one document per failed attempt.

| Index | Used by |
|---|---|
| `{ reminderId: 1 }` | `GET /reminders/:id/attempts` |
| `{ createdAt: 1 }` with `expireAfterSeconds` (TTL) | MongoDB deletes logs older than 30 days automatically |

**Why a separate collection instead of an array inside the reminder?** An array would keep growing and make the reminder document bigger and slower to update. A separate collection is also easy to search ("all failures today").

## 4. Performance decisions

- `find()` and `countDocuments()` for pagination run at the same time (`Promise.all`).
- `limit` is capped at 100, so nobody can request a million rows.
- The worker claims a reminder in **one** database call (`findOneAndUpdate`), not find + update.
- Search text is escaped before it is used as a regex, so a user can't send a slow or broken pattern.
- **Possible improvements** for very large data (not needed at this size):
  - partial indexes containing only `pending` reminders
  - cursor-based pagination instead of `skip`
  - `.lean()` on read queries

## 5. Why no transactions?

Creating the notification and updating the reminder are two separate writes. A transaction would need a MongoDB replica set. We don't need one, because the unique index already makes this safe. If the server crashes between the two writes, the next attempt gets "duplicate" (error `11000`) and simply marks the reminder completed. The user never gets two notifications, and no reminder is lost.
