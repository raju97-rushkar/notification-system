# Notification & Reminder System (Fastify version)

The same project as `notification-system-sequelize`, migrated from **Express to Fastify**. The database layer (Sequelize models, services, worker) is unchanged. The HTTP layer is rebuilt as Fastify plugins.
Stack: **Node.js, Fastify 5, PostgreSQL, Sequelize 6, zod, node-cron**.

Users create reminders. A background worker checks every 5 seconds for reminders that are due. For each one it creates **exactly one** notification, even if many workers run at the same time. If something fails, the worker tries again later.

| Document | What's inside |
|---|---|
| [docs/API.md](docs/API.md) | All endpoints with examples + cURL for Postman |
| [docs/DATABASE.md](docs/DATABASE.md) | Models, relationships, keys, indexes |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Fastify plugins, worker, transactions, edge cases |
| [docs/AI_USAGE.md](docs/AI_USAGE.md) | How AI was used |

---

## 1. Setup

You need **Node.js 20+** (tests: see section 6) and **PostgreSQL** (on this PC: PostgreSQL 17, port **5433**, user `postgres`, password `postgres`).

```bash
npm install
copy .env.example .env      # Mac/Linux: cp .env.example .env
npm run dev                 # starts the API + the worker
```

Open http://localhost:3003/api/health. You should see `{"server":"ok","database":"connected"}`.

You don't need to create anything by hand. On startup the app:
1. creates the database `notification_system_fastify` if it doesn't exist
2. runs `sequelize.sync()`, which creates the tables, foreign keys and indexes from the models

**pgAdmin:** connect to `127.0.0.1`, port `5433`, user `postgres`, password `postgres`. Then open **Databases → notification_system_fastify → Schemas → public → Tables**.

## 2. Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API + worker, restarts automatically when code changes |
| `npm start` | API + worker (normal start) |
| `npm run worker` | Only the worker, no HTTP port (to run more than one worker) |
| `npm test` | All tests, on a separate database `notification_system_fastify_test` |
| `npm run test:coverage` | Tests + coverage report (in `coverage/`) |

## 3. Settings (.env)

| Name | Default | Meaning |
|---|---|---|
| `PORT` | 3003 | API port (MongoDB = 3000, raw SQL = 3001, Sequelize + Express = 3002) |
| `HOST` | localhost | Address to listen on. Use `0.0.0.0` inside Docker |
| `LOG_LEVEL` | info | Fastify's logger (pino): `error`, `warn`, `info`, `debug`, ... |
| `DATABASE_URL` | `postgres://postgres:postgres@127.0.0.1:5433/notification_system_fastify` | Database address |
| `RUN_WORKER` | true | Start the worker inside the API process |
| `WORKER_SCHEDULE` | `*/5 * * * * *` | How often the worker runs (node-cron, with seconds) |
| `WORKER_BATCH_SIZE` | 50 | Max reminders per run |
| `WORKER_CLAIM_SIZE` | 10 | Reminders claimed together in one transaction (see ARCHITECTURE) |
| `WORKER_LOCK_TIME_MS` | 60000 | After a crash, a stuck reminder is released after this time |
| `MAX_ATTEMPTS` | 3 | Attempts before a reminder becomes `failed` |
| `RETRY_DELAY_MS` | 30000 | Wait before the first retry (doubles each time) |
| `SIMULATED_FAILURE_RATE` | 0 | Demo only: share of attempts that fail on purpose |

## 4. Folder structure

```
src/
  app.js                buildApp(): puts the plugins together (no port opened)
  server.js             npm start: API + worker, listens on PORT
  worker.js             npm run worker: worker only, no routes, no port
  plugins/              Fastify plugins
    validation.js         zod as Fastify's validator compiler
    errorHandler.js       setErrorHandler + setNotFoundHandler
    database.js           connect Sequelize on start, close the pool on app.close()
    auth.js               checkUser hook (x-user-id) + request.userId
    worker.js             start node-cron on onReady, stop it on preClose
  routes/               URL + schema  ->  controller (each file is a plugin)
  controllers/          read request  ->  call service  ->  return the result
  validators/           zod schemas used by the routes (body, querystring, params)
  services/             business logic with Sequelize queries   (same as Express version)
  models/               Sequelize models + relationships         (same)
  jobs/reminder.job.js  background worker (node-cron + transactions) (same, logs via pino)
  config/database.js    Sequelize instance, connectDB()          (same)
  utils/                AppError, paginate() (shared by every list endpoint), timezone check
tests/                  unit tests, API tests (app.inject), worker tests, multi-process test
```

**Suggested reading order for code review:**
1. `app.js`, then `plugins/`
2. `routes/` and `controllers/`
3. `services/` and `models/`
4. `jobs/reminder.job.js`

## 5. Express → Fastify: what changed

| | Express version (3002) | **Fastify version (3003)** |
|---|---|---|
| App setup | `app.use(...)` middlewares | `app.register(plugin)`, loaded in order by `app.ready()` |
| Validation | `validate(schema)` middleware → `req.validated` | route `schema: { body, querystring, params }` with a zod **validator compiler** → `request.body` etc. are already clean |
| Invalid id (`/reminders/abc`) | database error 22P02 → 400 | rejected by the `params` schema → 400, **no DB query** |
| Auth (`x-user-id`) | `checkUser` middleware | `onRequest` hook in an encapsulated plugin (`/health` stays public) |
| Errors | error middleware (4 arguments) | `setErrorHandler` + `setNotFoundHandler`. Fastify's own errors (broken JSON, empty body, 415) keep their 4xx status |
| Responses | `res.status(201).json(x)` | `return x` (200) or `reply.code(201).send(x)` |
| Logging | `console.log` | built-in **pino** logger: JSON lines with a request id, worker logs in the same stream |
| Worker | started by `server.js` | **worker plugin**: starts on `onReady`, stops on `preClose` |
| Shutdown | close the job and DB by hand | `app.close()` runs every plugin's close hook in the right order |
| Tests | supertest | `app.inject()`: fake HTTP requests, no port opened |

Unchanged: models, associations, indexes, services, the worker logic (SKIP LOCKED, transactions, retries, crash recovery) and all API URLs, request bodies and responses.

## 6. Tests

`npm test` runs **115 tests** (about 15 seconds) on a real PostgreSQL.

| File | Type | What it checks |
|---|---|---|
| [tests/unit.test.js](tests/unit.test.js) | unit (no DB) | zod schemas, timezone check, `checkUser` hook, zod validator compiler, error handler |
| [tests/reminders.api.test.js](tests/reminders.api.test.js) | integration | create / get / update / cancel, validation, 404 / 409 rules, pagination, filter, sort, search, user isolation, SQL injection, timezones + daylight saving, broken / empty / non-JSON body, invalid id |
| [tests/notifications.api.test.js](tests/notifications.api.test.js) | integration | list, read / unread filter, mark as read, user isolation |
| [tests/worker.test.js](tests/worker.test.js) | integration | duplicates (5 workers, cancel races), transactions, SKIP LOCKED, retries + backoff, crash recovery, overdue, rescheduling, timezones, node-cron |
| [tests/workerPlugin.test.js](tests/workerPlugin.test.js) | integration | the worker plugin starts with `app.ready()` and stops with `app.close()` |
| [tests/multiprocess.test.js](tests/multiprocess.test.js) | integration | 4 separate worker processes, 200 reminders → exactly 200 notifications |

**Why `npm test` runs Node with `--experimental-vm-modules`:** `app.inject()` uses `light-my-request`, which loads `cookie` 2.x. That package is ESM only. Plain Node can `require()` it, but Jest's module loader can't unless VM modules are enabled. The test script turns them on and hides the "experimental" warning. Use Node 22.12 or newer for tests.

If your PostgreSQL password or port is different, change it in [tests/env.js](tests/env.js).
