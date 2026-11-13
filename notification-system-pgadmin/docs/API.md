# API Documentation

Base URL: `http://localhost:3001/api`

**Every** `/reminders` and `/notifications` request needs the header `x-user-id: <your user id>`. This is a simple stand-in for login. A user can only see and change their own data. Another user's reminder returns `404`.

**Ids** are UUIDs, e.g. `3f2b8c1e-7a4d-4e1b-9c2a-5d6e7f8a9b0c`.

**Dates** must include a timezone, e.g. `2026-12-01T10:00:00+05:30` or `2026-12-01T04:30:00Z`. They are stored in UTC.

## Errors

```json
{ "message": "Validation failed", "details": [{ "field": "title", "message": "..." }] }
{ "message": "Reminder not found" }
```

| Status | When |
|---|---|
| 400 | invalid input, invalid id (not a UUID), broken JSON, date in the past, empty update |
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
  "id": "3f2b8c1e-...", "userId": "user1", "title": "Call mom", "message": "",
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
| `search` | `mom` | text inside the title (case-insensitive) |
| `sortBy` | `dueAt` / `createdAt` / `title` | `createdAt` |
| `order` | `asc` / `desc` | `desc` |

```json
{ "data": [ ...reminders ], "pagination": { "page": 1, "limit": 10, "total": 25, "totalPages": 3 } }
```

### Get one: `GET /reminders/:id` → 200 / 404

### Update: `PATCH /reminders/:id` → 200 / 409
Body can contain any of `title`, `message`, `dueAt`, `timezone` (at least one). You can only update a reminder while it is `pending`.

### Cancel: `POST /reminders/:id/cancel` → 200 / 409
Only works while the reminder is `pending`. The status becomes `cancelled`; the row is not deleted.

### Retry: `POST /reminders/:id/retry` → 200 / 409
Only works for a `failed` reminder. It goes back to `pending` with a fresh number of attempts.

### Failed attempts: `GET /reminders/:id/attempts` → 200
```json
[ { "id": "...", "reminderId": "...", "attempt": 1, "error": "Database timeout", "workerId": "PC-1234", "willRetry": true, "createdAt": "..." } ]
```

---

## Notifications

### List: `GET /notifications` → 200
Query parameters: `page`, `limit`, and `unread=true|false`. Newest first.
```json
{ "data": [ { "id": "...", "reminderId": "...", "userId": "user1", "title": "Call mom", "message": "",
  "scheduledFor": "...", "delayMs": 850, "readAt": null, "createdAt": "..." } ],
  "pagination": { "page": 1, "limit": 10, "total": 1, "totalPages": 1 } }
```
`delayMs` is how late the notification was created. It is large if the server was off.

### Mark as read: `PATCH /notifications/:id/read` → 200 / 404
Calling it again keeps the first read time.

---

## Health: `GET /health`
`200 {"server":"ok","database":"connected"}`, or `503` if the database is not reachable. No header is needed.

---

## cURL for Postman (Import → Raw text)

```bash
curl --location 'http://localhost:3001/api/reminders' \
--header 'x-user-id: user1' \
--header 'Content-Type: application/json' \
--data '{ "title": "Test reminder", "dueAt": "2026-11-05T15:08:00+05:30", "timezone": "Asia/Kolkata" }'

curl --location 'http://localhost:3001/api/reminders?page=1&limit=10&sortBy=dueAt&order=asc' --header 'x-user-id: user1'

curl --location 'http://localhost:3001/api/notifications' --header 'x-user-id: user1'
```
