# AI Usage Report (Fastify version)

> **DRAFT. Rewrite this in your own words before submitting.** These entries describe what really happened while building this version with Claude Code. Re-run each verification yourself so you can explain it without reading this file.

---

## 1. Migrating from Express to Fastify

- **Problem:** Move the Sequelize project from Express to Fastify, with a modular structure (routes, controllers, services, plugins), Fastify plugins for validation and error handling, and the worker built into the Fastify app.
- **Prompt:** My task list for the day: initialize Fastify, integrate it with the existing Sequelize models, set up the plugin architecture, configure validation and error handling plugins, migrate the reminder APIs with pagination, filtering and sorting, and start integrating the worker.
- **AI decisions:**
  - Start from a copy of the Sequelize project. Keep the models, services, worker logic and config **unchanged**, and rewrite only the HTTP layer. The API contract (URLs, bodies, responses) stays the same.
  - Use Fastify 5 with `fastify-plugin` and `@fastify/cors`.
  - Build the app in `buildApp()` with no `listen()`, so tests can use `app.inject()`.
  - Build every concern as a plugin: validation, errors, database, auth, worker.
- **Verification:** The existing test suite was ported (supertest → `app.inject()`) and passes: 107 tests. A manual run on port 3003 created a reminder, the worker completed it within one cron run, and the notification appeared.

## 2. Validation: zod instead of Fastify's JSON Schema

- **Problem:** Fastify validates with JSON Schema (Ajv). The project's zod schemas also *transform* data (ISO string → `Date`, `"2"` → `2`) and check timezones with a custom function. Plain JSON Schema can't do that.
- **AI suggestion:** Keep zod and plug it in with `app.setValidatorCompiler()`. The compiler returns `{ value }` (Fastify replaces `request.body` with the clean data) or `{ error }` (Fastify passes the `ZodError` to the error handler).
- **How it was checked:** The AI read Fastify's `lib/validation.js` to confirm that a `{ value }` result replaces the request part, and that an `Error` result is passed through with `statusCode: 400`. It also read `lib/schemas.js` to confirm that schemas with a custom prototype, like zod objects, are not changed by Fastify.
- **Trade-off:** No JSON Schema means no automatic Swagger docs and no fast-json-stringify response serialization. Documented as a known limitation.

## 3. A new id check in the route schema

- In the Express version, `/reminders/abc` reached PostgreSQL, failed with error `22P02`, and was turned into a 400.
- In Fastify, each `/:id` route has a `params` schema (`z.uuid()`), so a bad id is rejected **before any database query**. The 22P02 mapping stays as a safety net.

## 4. Worker as a plugin, and shutdown order

- The worker plugin starts node-cron in the `onReady` hook and stops it in `preClose`. `preClose` was chosen over `onClose` on purpose: it runs before the database plugin's `onClose` closes the pool, so a running job never hits a closed pool.
- `npm run worker` reuses `buildApp({ worker: true, api: false })`: the same plugins, logger and clean shutdown, without opening a port.
- **Verification:** `tests/workerPlugin.test.js` starts the app, waits for the cron job to process 2 reminders, then calls `app.close()`.

## 5. A problem found while testing: `app.inject()` in Jest

- **Problem:** After switching tests to `app.inject()`, 45 tests failed with "Must use import to load ES Module ... cookie/dist/index.js".
- **Cause:** `light-my-request` (used by `inject`) loads `cookie` 2.x, which is ESM only. Plain Node 24 can `require()` it, but Jest's module loader can't without VM modules.
- **Fix:** The test scripts run Jest with `node --experimental-vm-modules --no-warnings=ExperimentalWarning`. Written as a `node ...` command, so it works on Windows and Mac/Linux. All 107 tests pass.

## 6. Smaller details

- Jest gives each test file its own copy of `process.env`, so the multi-process test passes `env` explicitly to the child processes. A child refuses to run unless the database name ends in `_test`.
- Fastify's own client errors (broken JSON, empty JSON body, wrong `Content-Type` → 415) are recognised by their 4xx `statusCode` in the error handler, so they are not reported as 500.
- Worker logs now go through Fastify's pino logger, as JSON lines next to the request logs.

---

## How I verified everything

1. `npm test`: 107 tests on a real PostgreSQL (separate `notification_system_fastify_test` database).
2. A manual run on port 3003: health check, create, list with sort, invalid id (400), missing header (401), then the worker completed the reminder and the notification appeared. The log showed pino JSON lines for each request and the worker run.
3. *(TODO, do this yourself:)* Test the APIs in Postman, and run `npm run worker` next to `npm start` with `RUN_WORKER=false`.
