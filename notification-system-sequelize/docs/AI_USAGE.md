# AI Usage Report (Sequelize version)

> **DRAFT. Rewrite this in your own words before submitting.** These entries describe what really happened while building this version with Claude Code. Re-run each verification yourself so you can explain it without reading this file.

---

## 1. Moving from raw SQL to Sequelize ORM

- **Problem:** Re-build the PostgreSQL project with Sequelize. That meant models, associations, primary/foreign keys, indexes, transactions and Sequelize queries.
- **Prompt:** My task list for the day: set up Sequelize, define the models and relationships, build the APIs with pagination, filtering and sorting, move the worker to Sequelize, prevent duplicates and handle concurrency with transactions, add retries, and test everything.
- **AI decisions:**
  - Use Sequelize 6, the current stable version. Version 7 is still in alpha.
  - Use `underscored: true`: camelCase in JavaScript, snake_case in the database.
  - Put the relationships in `models/index.js`.
  - Create tables with `sync()`, and document migrations as the production approach.
- **What I kept the same:** Routes, controllers, validators and middlewares were copied unchanged. Only the database layer changed, which shows the layering works.
- **Verification:** 42 tests pass. A manual run with 2 worker processes and 30% simulated failures gave 19 completed, 1 cancelled, 8 reminders retried, and a maximum of 1 notification per reminder.

## 2. Concurrency: SKIP LOCKED through Sequelize

- **Problem:** How do I write `SELECT ... FOR UPDATE SKIP LOCKED` without raw SQL?
- **AI suggestion:** `findOne({ lock: transaction.LOCK.UPDATE, skipLocked: true, transaction })` inside `sequelize.transaction()`, followed by `reminder.update(...)` in the same transaction.
- **Verification:**
  - A dedicated test opens a second transaction that holds a lock on the oldest reminder. The worker then claims the *next* reminder immediately instead of waiting.
  - The 5-parallel-workers test still creates exactly 40 notifications for 40 reminders.

## 3. Transactions for "notification + status update"

- **Problem:** In the raw-SQL version these were two separate statements, and the unique constraint covered the gap.
- **AI suggestion:** Wrap both writes in one transaction. If the `UPDATE ... WHERE lockedBy = me` changes 0 rows (we lost the lock), throw, so the notification insert is rolled back too.
- **A problem the AI caught:** Using `Notification.create()` inside the transaction would break retries. A duplicate key error in PostgreSQL aborts the whole transaction. So it uses `bulkCreate([...], { ignoreDuplicates: true })` instead, which becomes `ON CONFLICT DO NOTHING` and throws no error.
- **Verification:** The test *"if marking completed fails, the notification insert is rolled back too"*. After the failed attempt there are 0 notifications. After the retry there is exactly 1.

## 4. A test that changed meaning with transactions

- In the raw-SQL version, the test *"notification saved, but status update failed"* expected 1 notification after the failure, because nothing was rolled back.
- With transactions, the correct behaviour is **0** after the failure (rolled back) and 1 after the retry. The test was rewritten to check both steps.
- **Lesson:** When the design changes, tests must change for the right reason, not just to be "made green".

## 5. Smaller details

- `sync()` could race if the API and a worker start together. The AI wrapped it in `sequelize.transaction()` with `pg_advisory_xact_lock`. I verified that tables, the `UNIQUE` constraint, both foreign keys (`ON DELETE CASCADE`) and all 8 custom indexes were created, and that a second start runs without errors.
- `BIGINT` (`delayMs`) comes back from PostgreSQL as a string. A getter in the model turns it into a number.
- An invalid UUID in the URL raises a `DatabaseError` with code `22P02`, which becomes `400 Invalid id`. Sequelize `ValidationError` also maps to 400.
- A shell removal command was blocked by a safety check because it used a relative glob after `cd`. The AI copied the project first and then deleted only the specific files, using absolute paths.

---

## How I verified everything

1. `npm test`: 42 tests on a real PostgreSQL (separate `notification_system_sequelize_test` database).
2. A manual run: the API on port 3002 plus a second worker (`npm run worker`), `SIMULATED_FAILURE_RATE=0.3`, 20 reminders, 1 of them cancelled. Result:
   - 19 completed, 1 cancelled
   - 8 reminders needed retries
   - exactly 1 notification per reminder
   - both workers shared the work
3. Checked `pg_indexes` and `pg_constraint` to confirm the keys and indexes exist.
4. *(TODO, do this yourself:)* Open the tables in pgAdmin and test the APIs in Postman.
