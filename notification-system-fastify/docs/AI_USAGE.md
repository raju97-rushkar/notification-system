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
- **Verification:** The existing test suite was ported (supertest → `app.inject()`) and passes: 115 tests. A manual run on port 3003 created a reminder, the worker completed it within one cron run, and the notification appeared.

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
- **Fix:** The test scripts run Jest with `node --experimental-vm-modules --no-warnings=ExperimentalWarning`. Written as a `node ...` command, so it works on Windows and Mac/Linux. All 115 tests pass.

## 6. Smaller details

- Jest gives each test file its own copy of `process.env`, so the multi-process test passes `env` explicitly to the child processes. A child refuses to run unless the database name ends in `_test`.
- Fastify's own client errors (broken JSON, empty JSON body, wrong `Content-Type` → 415) are recognised by their 4xx `statusCode` in the error handler, so they are not reported as 500.
- Worker logs now go through Fastify's pino logger, as JSON lines next to the request logs.

## 7. Review: edge cases probed with real requests

- **Method:** A temporary test sent unusual requests to the app (very long header, invalid dates, huge page numbers, array bodies, reversed date ranges) and printed the status of each.
- **Bug 1, long `x-user-id` → 500:** `user_id` is `VARCHAR(255)`, so a 300 character id made PostgreSQL reject the insert. `checkUser` now trims the id and returns 400 above 255 characters. An id of only spaces now counts as missing (401).
- **Bug 2, mark-as-read race:** `markAsRead` read the notification, then updated it. A test with 10 clicks at the same moment got **9 different read times**. Now it's one conditional `UPDATE ... WHERE read_at IS NULL`, and all 10 get the first time.
- **Small fix:** `from` after `to` now gives 400 instead of an empty list.
- **Fine as they were:** invalid dates like Feb 30 or month 13, huge `page` values, an array as the body, and repeated `status` params were already rejected with 400.

## 8. Making the code reusable and faster

- **Prompt:** "Make the code reusable and optimize it."
- **Reuse:**
  - `utils/paginate.js`: one helper for "page of rows + total count", used by reminders and notifications. The `page`/`limit` zod rules are shared the same way.
  - `updateIfStatus()` in the reminder service: update, cancel and retry were three copies of "conditional UPDATE, then 404 or 409". Now each is a few lines.
  - `updateReminderSchema = createReminderSchema.partial()`: the same rules as create, so they can't drift apart.
  - `recordFailedAttempt()` in the worker: shared by normal failures and crash recovery (retry or `failed`, plus the failure log).
- **Optimization, measured before and after** (1000 due reminders, median of 3 runs):
  - Claim up to 10 reminders per transaction with one `UPDATE ... WHERE id IN (...)`, instead of one transaction per reminder.
  - Delete old failure logs at most once per hour, instead of every 5 seconds.
  - Result: 1 worker 2659 → 1548 ms, 4 workers 1296 → 702 ms. Every run still had exactly 1000 notifications.
- **New tests:** batch claim order and attempts, two workers claiming at once never overlap, and the hourly cleanup.

---

## How I verified everything

1. `npm test`: 115 tests on a real PostgreSQL (separate `notification_system_fastify_test` database).
2. A manual run on port 3003: health check, create, list with sort, invalid id (400), missing header (401), then the worker completed the reminder and the notification appeared. The log showed pino JSON lines for each request and the worker run.
3. *(TODO, do this yourself:)* Test the APIs in Postman, and run `npm run worker` next to `npm start` with `RUN_WORKER=false`.
