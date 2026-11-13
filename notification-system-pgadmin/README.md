# Notification & Reminder System (PostgreSQL version)

The same project as `notification-system`, but with **PostgreSQL** instead of MongoDB.
Stack: **Node.js, Express, PostgreSQL (`pg` library, plain SQL) and node-cron**.

Users create reminders. A background worker checks every 5 seconds for reminders that are due. For each one it creates **exactly one** notification, even if many workers run at the same time. If something fails, the worker tries again later.

| Document | What's inside |
|---|---|
| [docs/API.md](docs/API.md) | All endpoints with examples |
| [docs/DATABASE.md](docs/DATABASE.md) | Tables, columns, indexes and why |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the worker works + edge cases |
| [docs/AI_USAGE.md](docs/AI_USAGE.md) | How AI was used |

---

## 1. Setup

You need **Node.js 20+** and **PostgreSQL 17**. pgAdmin 4 is installed together with PostgreSQL and is the GUI for looking at the data.

On this PC, PostgreSQL runs on **port 5433** with user `postgres` and password `postgres`. Port 5432 was already used by a Docker container.

```bash
npm install
copy .env.example .env      # Mac/Linux: cp .env.example .env
npm run dev                 # starts the API + the worker
```

Open http://localhost:3001/api/health. You should see `{"server":"ok","database":"connected"}`.

You don't need to create anything by hand. On startup the app:
1. creates the database `notification_system` if it doesn't exist
2. runs [src/db/schema.sql](src/db/schema.sql) to create the tables and indexes

### View the data in pgAdmin

1. Open **pgAdmin 4** from the Start menu.
2. Right-click **Servers → Register → Server**.
3. On the **General** tab, enter Name `Local PostgreSQL 17`.
4. On the **Connection** tab, enter:
   - Host: `127.0.0.1`
   - Port: `5433`
   - Username: `postgres`
   - Password: `postgres` (tick "Save password")
5. Open **Databases → notification_system → Schemas → public → Tables**.
6. Right-click a table → **View/Edit Data → All Rows**.
7. To run your own SQL, use **Tools → Query Tool**, e.g. `SELECT * FROM reminders ORDER BY created_at DESC;`.

## 2. Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API + worker, restarts automatically when code changes |
| `npm start` | API + worker (normal start) |
| `npm run worker` | Only the worker (to run more than one worker) |
| `npm test` | Runs all tests on a separate database `notification_system_test`, so your real data is safe |

**Try multiple workers:** run `npm run dev` in one terminal and `npm run worker` in another. Both share the work, and there are still no duplicates. To see retries happen, set `SIMULATED_FAILURE_RATE=0.3` in `.env`.

## 3. Settings (.env)

`server.js` and `worker.js` load `.env` on their first line. Each file reads only the settings it needs from `process.env`, with a default value if one is missing. `.env` is in `.gitignore`, so it is never committed; `.env.example` is the template.

| Name | Default | Meaning |
|---|---|---|
| `PORT` | 3001 | API port (3001, so it can run next to the MongoDB project on 3000) |
| `DATABASE_URL` | `postgres://postgres:postgres@127.0.0.1:5433/notification_system` | Database address |
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
  config/db.js          PostgreSQL connection pool + query() helper
  db/schema.sql         CREATE TABLE / CREATE INDEX (runs on every start)
  models/               status list + "database row -> API object" converters
  validators/           request validation rules (zod)
  middlewares/          checkUser (x-user-id), validate, errorHandler
  routes/               URL  ->  controller
  controllers/          read request  ->  call service  ->  send response
  services/             business logic and SQL queries
  jobs/reminder.job.js  background worker (node-cron)
  utils/                small helpers
  app.js                creates the Express app
  server.js             start: DB + API + worker
  worker.js             start: DB + worker only
tests/                  API tests + worker tests
```

**How a request flows:** `route → checkUser → validate → controller → service (SQL) → PostgreSQL`. Any error goes to `errorHandler`.

**Suggested reading order for code review:**
1. `db/schema.sql`
2. `models/`
3. `routes/` → `controllers/` → `services/`
4. `jobs/reminder.job.js`
5. `tests/worker.test.js`

## 5. Differences from the MongoDB version

| | MongoDB version | PostgreSQL version |
|---|---|---|
| Schema | Mongoose schemas in `models/` | SQL tables in `db/schema.sql` |
| Queries | Mongoose methods (`findOneAndUpdate`) | plain SQL with `$1, $2` parameters |
| Worker claim | `findOneAndUpdate` (atomic per document) | `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)` |
| Duplicate prevention | unique index + catch error `11000` | `UNIQUE` column + `ON CONFLICT DO NOTHING` |
| Old failure logs | TTL index deletes them automatically | worker deletes rows older than 30 days |
| Id | `_id` (ObjectId) | `id` (UUID) |
| GUI | MongoDB Compass | pgAdmin 4 |
| Tests | in-memory MongoDB | real PostgreSQL, separate test database |

## 6. Tests

`npm test` runs **40 tests**. They cover:
- create / update / cancel reminders, validation errors, timezones, SQL injection safety
- pagination, filter, sort, search, and that users only see their own data
- **5 workers at the same time → no duplicates**
- retries, max attempts → `failed`, manual retry
- worker crash / server restart recovery
- overdue reminders
- the node-cron job running in the background

If your PostgreSQL password or port is different, change `TEST_DATABASE_URL` in [tests/env.js](tests/env.js).
