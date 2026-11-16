# API Documentation

Base URL: `http://localhost:3003/api`

**Every** `/reminders` and `/notifications` request needs the header `x-user-id: <your user id>`. This is a simple stand-in for login. A user can only see and change their own data. Another user's reminder returns `404`.

**Ids** are UUIDs, e.g. `3f2b8c1e-7a4d-4e1b-9c2a-5d6e7f8a9b0c`.

**Dates** must include a timezone, e.g. `2026-12-01T10:00:00+05:30` or `...Z`. They are stored in UTC.

## Errors

```json
{ "message": "Validation failed", "details": [{ "field": "title", "message": "..." }] }
{ "message": "Reminder not found" }
```

| Status | When |
|---|---|
| 400 | invalid input, invalid id (not a UUID), broken or empty JSON body, date in the past, empty update, `from` after `to`, `x-user-id` longer than 255 characters |
| 401 | `x-user-id` header missing or only spaces (checked before the body, so it wins over 400). Spaces around the id are trimmed |
| 404 | not found (or belongs to another user), unknown URL |
| 409 | action not allowed in the current status (e.g. editing a completed reminder) |
| 415 | body sent with an unsupported `Content-Type` (only `application/json` is accepted) |
| 500 | unexpected server error |

An invalid id is caught by the route's `params` schema, so it uses the validation format:
```json
{ "message": "Validation failed", "details": [{ "field": "id", "message": "Invalid id, must be a UUID" }] }
```

## Reminders

| Method | URL | Body / Query | Notes |
|---|---|---|---|
| POST | `/reminders` | `{ title, message?, dueAt, timezone? }` | 201. `dueAt` must be in the future |
| GET | `/reminders` | `page, limit (≤100), status, from, to, search, sortBy (dueAt/createdAt/title), order (asc/desc)` | `{ data, pagination }` |
| GET | `/reminders/:id` | | 200 / 404 |
| PATCH | `/reminders/:id` | any of `title, message, dueAt, timezone` | only while `pending`, else 409 |
| POST | `/reminders/:id/cancel` | | only while `pending`, else 409 |
| POST | `/reminders/:id/retry` | | only when `failed`, else 409 |
| GET | `/reminders/:id/attempts` | | list of failed attempts |

Reminder response:
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

`GET /reminders/:id/attempts` response (newest first). A worker crash also shows up here:
```json
[
  { "id": "...", "reminderId": "3f2b8c1e-...", "attempt": 2, "error": "Worker stopped before finishing",
    "workerId": "server-a-4120", "willRetry": true, "createdAt": "..." },
  { "id": "...", "reminderId": "3f2b8c1e-...", "attempt": 1, "error": "SMTP timeout",
    "workerId": "server-b-8812", "willRetry": true, "createdAt": "..." }
]
```

## Notifications

| Method | URL | Query | Notes |
|---|---|---|---|
| GET | `/notifications` | `page, limit, unread=true/false` | newest first |
| PATCH | `/notifications/:id/read` | | keeps the first read time |

`delayMs` = how late the notification was created (large if the server was off).

## Health

`GET /health` returns `200 {"server":"ok","database":"connected"}`, or `503` if the database is not reachable.

---

## cURL for Postman (Import → Raw text)

```bash
curl --location 'http://localhost:3003/api/reminders' \
--header 'x-user-id: user1' \
--header 'Content-Type: application/json' \
--data '{ "title": "Test reminder", "message": "Sequelize test", "dueAt": "2026-11-12T15:08:00+05:30", "timezone": "Asia/Kolkata" }'
```

```bash
curl --location 'http://localhost:3003/api/reminders?page=1&limit=10&status=pending&sortBy=dueAt&order=asc' \
--header 'x-user-id: user1'
```

```bash
curl --location 'http://localhost:3003/api/reminders/REMINDER_ID' --header 'x-user-id: user1'
```

```bash
curl --location --request PATCH 'http://localhost:3003/api/reminders/REMINDER_ID' \
--header 'x-user-id: user1' \
--header 'Content-Type: application/json' \
--data '{ "title": "Updated reminder" }'
```

```bash
curl --location --request POST 'http://localhost:3003/api/reminders/REMINDER_ID/cancel' --header 'x-user-id: user1'
```

```bash
curl --location 'http://localhost:3003/api/notifications?page=1&limit=10' --header 'x-user-id: user1'
```

```bash
curl --location --request PATCH 'http://localhost:3003/api/notifications/NOTIFICATION_ID/read' --header 'x-user-id: user1'
```

```bash
curl --location 'http://localhost:3003/api/reminders/REMINDER_ID/attempts' --header 'x-user-id: user1'
```

```bash
curl --location --request POST 'http://localhost:3003/api/reminders/REMINDER_ID/retry' --header 'x-user-id: user1'
```
