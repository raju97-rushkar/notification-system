# Notification & Reminder System (Sequelize ORM version)

The same project as `notification-system-pgadmin`, but database access goes through the **Sequelize ORM** instead of raw SQL.
Stack: **Node.js, Express, PostgreSQL, Sequelize 6, node-cron**.

Users create reminders. A background worker checks every 5 seconds for reminders that are due. For each one it creates **exactly one** notification, even if many workers run at the same time. If something fails, the worker tries again later.

| Document | What's inside |
|---|---|
| [docs/API.md](docs/API.md) | All endpoints with examples + cURL for Postman |
| [docs/DATABASE.md](docs/DATABASE.md) | Models, relationships, keys, indexes |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Worker, transactions, edge cases |
| [docs/AI_USAGE.md](docs/AI_USAGE.md) | How AI was used |

---

## 1. Setup

You need **Node.js 20+** and **PostgreSQL** (on this PC: PostgreSQL 17, port **5433**, user `postgres`, password `postgres`).

```bash
npm install
copy .env.example .env      # Mac/Linux: cp .env.example .env
npm run dev                 # starts the API + the worker
```

Open http://localhost:3002/api/health. You should see `{"server":"ok","database":"connected"}`.

You don't need to create anything by hand. On startup the app:
1. creates the database `notification_system_sequelize` if it doesn't exist
2. runs `sequelize.sync()`, which creates the tables, foreign keys and indexes from the models

**pgAdmin:** connect to `127.0.0.1`, port `5433`, user `postgres`, password `postgres`. Then open **Databases → notification_system_sequelize → Schemas → public → Tables**.

## 2. Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API + worker, restarts automatically when code changes |
| `npm start` | API + worker (normal start) |
| `npm run worker` | Only the worker (to run more than one worker) |
| `npm test` | All tests, on a separate database `notification_system_sequelize_test` |

## 3. Settings (.env)

| Name | Default | Meaning |
|---|---|---|
| `PORT` | 3002 | API port (MongoDB version = 3000, raw-SQL version = 3001) |
| `DATABASE_URL` | `postgres://postgres:postgres@127.0.0.1:5433/notification_system_sequelize` | Database address |
| `RUN_WORKER` | true | Start the worker inside the API process |
| `WORKER_SCHEDULE` | `*/5 * * * * *` | How often the worker runs (node-cron, with seconds) |
| `WORKER_BATCH_SIZE` | 50 | Max reminders per run |
| `WORKER_LOCK_TIME_MS` | 60000 | After a crash, a stuck reminder is released after this time |
| `MAX_ATTEMPTS` | 3 | Attempts before a reminder becomes `failed` |
| `RETRY_DELAY_MS` | 30000 | Wait before the first retry (doubles each time) |
| `SIMULATED_FAILURE_RATE` | 0 | Demo only: share of attempts that fail on purpose |

## 4. Folder structure

```
src/
  config/database.js    Sequelize instance, connectDB() (create DB + sync tables)
  models/
    reminder.model.js        Reminder model (+ STATUS list)
    notification.model.js    Notification model
    failedAttempt.model.js   FailedAttempt model
    index.js                 loads models + RELATIONSHIPS (hasOne / hasMany / belongsTo)
  validators/           request validation rules (zod)
  middlewares/          checkUser (x-user-id), validate, errorHandler
  routes/               URL  ->  controller
  controllers/          read request  ->  call service  ->  send response
  services/             business logic with Sequelize queries
  jobs/reminder.job.js  background worker (node-cron + transactions)
  utils/                small helpers
  app.js / server.js / worker.js
tests/                  API tests + worker tests
```

**Suggested reading order for code review:**
1. `models/` (start with `index.js`)
2. `services/`
3. `jobs/reminder.job.js`
4. `tests/worker.test.js`

## 5. The three versions side by side

| | MongoDB | PostgreSQL raw SQL | **PostgreSQL + Sequelize** |
|---|---|---|---|
| Schema | Mongoose schema | `schema.sql` | `sequelize.define()` + `sync()` |
| Relationships | – | FK in SQL | `hasOne` / `hasMany` / `belongsTo` |
| Claim a reminder | `findOneAndUpdate` | `UPDATE ... (SELECT ... FOR UPDATE SKIP LOCKED)` | transaction + `findOne({ lock, skipLocked })` |
| No duplicates | unique index + error 11000 | `UNIQUE` + `ON CONFLICT DO NOTHING` | `unique: true` + `bulkCreate({ ignoreDuplicates })` |
| Notification + status update | 2 separate writes | 2 separate writes | **1 transaction** (both or neither) |
| Port | 3000 | 3001 | 3002 |

## 6. Tests

`npm test` runs **42 tests**:
- API: create / update / cancel, validation, timezones, SQL injection safety, pagination, filter, sort, search, user isolation
- **5 workers at the same time → no duplicates**
- **transactions:** a failure after the notification insert rolls the insert back
- **SKIP LOCKED:** a row locked by another transaction is skipped
- **relationships:** `include: 'notification'` and `include: 'failedAttempts'`
- retries, max attempts → `failed`, manual retry, crash recovery, overdue reminders, node-cron job

If your PostgreSQL password or port is different, change it in [tests/env.js](tests/env.js).
