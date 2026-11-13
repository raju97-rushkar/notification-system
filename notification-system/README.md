# Notification & Reminder System

A backend built with **Node.js, Express, MongoDB (Mongoose) and node-cron**.

Users create reminders. A background worker checks every 5 seconds for reminders that are due. For each one it creates **exactly one** notification, even if many workers run at the same time. If something fails, the worker tries again later.

| Document | What's inside |
|---|---|
| [docs/API.md](docs/API.md) | All endpoints with examples |
| [docs/DATABASE.md](docs/DATABASE.md) | Collections, fields, indexes and why |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the worker works + edge cases |
| [docs/AI_USAGE.md](docs/AI_USAGE.md) | How AI was used |

---

## 1. Setup

You need **Node.js 20+** and **MongoDB** installed locally (as a Windows service). **MongoDB Compass** is a GUI for looking at the data.

```bash
npm install
copy .env.example .env      # Mac/Linux: cp .env.example .env
npm run dev                 # starts the API + the worker
```

Open http://localhost:3000/api/health. You should see `{"server":"ok","database":"connected"}`.

**View the data in Compass:** connect to `mongodb://127.0.0.1:27017` and open the database `notification_system`. The app creates the collections and indexes itself on startup.

## 2. Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API + worker, restarts automatically when code changes |
| `npm start` | API + worker (normal start) |
| `npm run worker` | Only the worker (to run more than one worker) |
| `npm test` | Runs all tests (uses an in-memory MongoDB, so your real data is safe) |

**Try multiple workers:** run `npm run dev` in one terminal and `npm run worker` in another. Both share the work, and there are still no duplicate notifications. To see retries happen, set `SIMULATED_FAILURE_RATE=0.3` in `.env`.

## 3. Settings (.env)

`server.js` and `worker.js` load `.env` on their first line (`require('dotenv').config()`). Each file then reads only the settings it needs from `process.env`, with a default value if one is missing. `.env` is in `.gitignore`, so it is never committed; `.env.example` is the template.

| Name | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | API port |
| `MONGO_URI` | `mongodb://127.0.0.1:27017/notification_system` | Database address |
| `RUN_WORKER` | true | Start the worker inside the API process |
| `WORKER_SCHEDULE` | `*/5 * * * * *` | How often the worker runs (node-cron format with seconds) |
| `WORKER_BATCH_SIZE` | 50 | Max reminders per run |
| `WORKER_LOCK_TIME_MS` | 60000 | After a crash, a stuck reminder is released after this time |
| `MAX_ATTEMPTS` | 3 | Attempts before a reminder becomes `failed` |
| `RETRY_DELAY_MS` | 30000 | Wait before the first retry (doubles each time) |
| `SIMULATED_FAILURE_RATE` | 0 | Demo only: share of attempts that fail on purpose |

## 4. Folder structure

```
src/
  config/
    db.js               MongoDB connection
  models/               database schemas + indexes
    reminder.model.js
    notification.model.js
    failedAttempt.model.js
  validators/           request validation rules (zod)
  middlewares/
    checkUser.js        reads the x-user-id header
    validate.js         runs the validation rules
    errorHandler.js     turns errors into JSON responses
  routes/               URL  ->  controller
  controllers/          read request  ->  call service  ->  send response
  services/             business logic and database queries
  jobs/
    reminder.job.js     background worker (node-cron)
  utils/                small helpers
  app.js                creates the Express app
  server.js             start: DB + API + worker
  worker.js             start: DB + worker only
tests/                  API tests + worker tests
```

**How a request flows:** `route → checkUser → validate → controller → service → model → MongoDB`. Any error goes to `errorHandler`.

**Suggested reading order for code review:**
1. `models/`
2. `routes/` → `controllers/` → `services/`
3. `jobs/reminder.job.js`
4. `tests/worker.test.js`

## 5. Quick test with curl

```bash
curl -X POST http://localhost:3000/api/reminders -H "x-user-id: user1" -H "Content-Type: application/json" -d "{\"title\":\"Call mom\",\"dueAt\":\"2026-12-01T10:00:00+05:30\",\"timezone\":\"Asia/Kolkata\"}"

curl "http://localhost:3000/api/reminders?status=pending&sortBy=dueAt&order=asc" -H "x-user-id: user1"
curl http://localhost:3000/api/notifications -H "x-user-id: user1"
```

## 6. Tests

`npm test` runs **38 tests** on a real MongoDB that runs in memory. They cover:
- create / update / cancel reminders, validation errors, timezones
- pagination, filter, sort, search, and that users only see their own data
- **5 workers at the same time → no duplicates**
- retries, max attempts → `failed`, manual retry
- worker crash / server restart recovery
- overdue reminders
- the node-cron job running in the background

> **Note:** the test script uses `node --experimental-vm-modules`. The MongoDB driver loads a module with a dynamic `import()`, and Jest can't handle that without this flag. It only affects tests.
