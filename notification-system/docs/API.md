# API Documentation

Base URL: `http://localhost:3000/api`

**Every** `/reminders` and `/notifications` request needs the header `x-user-id: <your user id>`. This is a simple stand-in for login. A user can only see and change their own data. Another user's reminder returns `404`.

**Dates** must include a timezone, e.g. `2026-12-01T10:00:00+05:30` or `2026-12-01T04:30:00Z`. They are stored in UTC.

## Errors

```json
{ "message": "Validation failed", "details": [{ "field": "title", "message": "..." }] }
{ "message": "Reminder not found" }
```

| Status | When |
|---|---|
| 400 | invalid input, invalid id, broken JSON, date in the past |
| 401 | `x-user-id` header missing |
| 404 | not found (or belongs to another user), unknown URL |
| 409 | action not allowed in the current status (e.g. editing a completed reminder) |
| 500 | unexpected server error |

---

## Reminders

### Create: `POST /reminders` → 201

```json
{ "title": "Call mom", "message": "optional", "dueAt": "2026-12-01T10:00:00+05:30", "timezone": "Asia/Kolkata" }
```
- `title` is required (max 200 characters).
- `dueAt` is required and must be in the future.
- `timezone` is optional (default `UTC`).

Response:
```json
{
  "_id": "6729...", "userId": "user1", "title": "Call mom", "message": "",
  "dueAt": "2026-12-01T04:30:00.000Z", "timezone": "Asia/Kolkata",
  "dueAtLocal": "12/1/2026, 10:00:00 AM",
  "status": "pending", "nextRunAt": "2026-12-01T04:30:00.000Z",
  "attempts": 0, "maxAttempts": 3, "lastError": null, "processedAt": null,
  "createdAt": "...", "updatedAt": "..."
}
```

### List: `GET /reminders` → 200

| Query | Example | Default |
|---|---|---|
| `page` | `2` | 1 |
| `limit` | `20` (max 100) | 10 |
| `status` | `pending` / `processing` / `completed` / `failed` / `cancelled` | all |
| `from`, `to` | `2026-12-01T00:00:00Z` | filter on `dueAt` |
| `search` | `mom` | text inside the title |
| `sortBy` | `dueAt` / `createdAt` / `title` | `createdAt` |
| `order` | `asc` / `desc` | `desc` |

```json
{ "data": [ ...reminders ], "pagination": { "page": 1, "limit": 10, "total": 25, "totalPages": 3 } }
```

### Get one: `GET /reminders/:id` → 200 / 404

### Update: `PATCH /reminders/:id` → 200 / 409
Body can contain any of `title`, `message`, `dueAt`, `timezone`. You can only update a reminder while it is `pending`.

### Cancel: `POST /reminders/:id/cancel` → 200 / 409
Only works while the reminder is `pending`. The status becomes `cancelled`; the reminder is not deleted.

### Retry: `POST /reminders/:id/retry` → 200 / 409
Only works for a `failed` reminder. It goes back to `pending` with a fresh number of attempts.

### Failed attempts: `GET /reminders/:id/attempts` → 200
```json
[ { "reminderId": "...", "attempt": 1, "error": "Database timeout", "workerId": "PC-1234", "willRetry": true, "createdAt": "..." } ]
```

---

## Notifications

### List: `GET /notifications` → 200
Query parameters: `page`, `limit`, and `unread=true|false`. Newest first.
```json
{ "data": [ { "_id": "...", "reminderId": "...", "userId": "user1", "title": "Call mom", "message": "",
  "scheduledFor": "...", "delayMs": 850, "readAt": null, "createdAt": "..." } ],
  "pagination": { "page": 1, "limit": 10, "total": 1, "totalPages": 1 } }
```
`delayMs` is how late the notification was created. It is large if the server was off.

### Mark as read: `PATCH /notifications/:id/read` → 200 / 404

---

## Health: `GET /health`
`200 {"server":"ok","database":"connected"}`, or `503` if the database is not connected. No header is needed.
