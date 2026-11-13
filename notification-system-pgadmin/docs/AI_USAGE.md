# AI Usage Report (PostgreSQL version)

> **DRAFT. Rewrite this in your own words before submitting.** These entries describe what really happened while building this version with Claude Code (an AI coding assistant in VS Code). Re-run each verification yourself so you can explain it without reading this file.

---

## 1. Porting the MongoDB project to PostgreSQL

- **Problem:** Make the same project work with PostgreSQL instead of MongoDB.
- **Prompt:** *"Make a copy of the same project called notification-system-pgadmin, just use PostgreSQL as the database."*
- **AI decisions:**
  - Use the `pg` library with plain SQL, not an ORM like Sequelize or Prisma. Every query is visible and easy to explain in a review.
  - Put the tables in one `schema.sql` file.
  - Convert `snake_case` columns to `camelCase` API fields in small `toReminder()` / `toNotification()` functions.
- **What I accepted or rejected:** Rejected using an ORM. For this project, being able to show and defend the exact SQL (especially `SKIP LOCKED`) matters more than shorter code.
- **Verification:** 40 tests pass. A manual run with 2 worker processes and 30% simulated failures gave 18 completed, 1 cancelled, 1 failed after 3 attempts, and a maximum of 1 notification per reminder.

## 2. Claiming reminders safely with multiple workers

- **Problem:** In MongoDB, `findOneAndUpdate` is atomic per document. What is the PostgreSQL equivalent?
- **AI suggestion:** `UPDATE reminders ... WHERE id = (SELECT id ... FOR UPDATE SKIP LOCKED) RETURNING *`.
- **Why I accepted it:** `FOR UPDATE` locks the row, and `SKIP LOCKED` lets other workers take the next free row instead of waiting. This is the standard way to use PostgreSQL as a job queue.
- **Verification:** The test runs 5 workers in parallel on 40 reminders and gets exactly 40 notifications.

## 3. Duplicate prevention: error 11000 → ON CONFLICT

- **AI suggestion:** Replace "catch MongoDB error 11000" with `UNIQUE (reminder_id)` plus `INSERT ... ON CONFLICT (reminder_id) DO NOTHING RETURNING *`.
- **Why it's better:** No error is thrown at all. `RETURNING` gives an empty result when the row already existed, so the code just checks for `null`.
- **Verification:** The test creates the same notification 10 times in parallel. Only 1 insert returns a row, and the table has 1 row.

## 4. Installation problem: port 5432 already in use

- **Problem:** The silent PostgreSQL install failed with exit code 1.
- **How the AI debugged it:** It read the installer log, which said *"The specified port number is not available"*. `Get-NetTCPConnection` showed port 5432 was used by Docker Desktop: a `postgres:16.6-alpine` container from another project.
- **Decision:** Install PostgreSQL 17 on **port 5433** instead of stopping someone else's container.

## 5. Second port conflict during testing (API port 3000)

- **Problem:** The first manual test showed `_id` values (MongoDB ObjectIds) in the responses, even though this project uses UUIDs.
- **Cause:** The MongoDB version of the project was already running on port 3000 through `npm run dev`, so the requests went to the wrong server.
- **Fix:** The PostgreSQL version now uses **port 3001** by default, so both projects can run at the same time.
- **Lesson:** When a result looks impossible, check *which* server answered before debugging the code.

## 6. Small SQL details the AI got right or fixed

- `now() + $2 * interval '1 millisecond'`: PostgreSQL can't always guess the type of `$2` here, so it was changed to `$2::float8`.
- `COUNT(*)` and `BIGINT` columns come back from `pg` as strings (e.g. `"850"`), so the code uses `COUNT(*)::int` and `Number(row.delay_ms)`.
- An invalid UUID in the URL raises PostgreSQL error `22P02`. `errorHandler` turns it into `400 Invalid id`.
- Table creation runs in a transaction with `pg_advisory_xact_lock`. Without it, the API and a worker starting at the same moment could both run `CREATE TABLE` and one would fail.

---

## How I verified everything

1. `npm test`: 40 tests on a real PostgreSQL in a separate `notification_system_test` database.
2. A manual run: the API on port 3001 plus a second worker (`npm run worker`), with `SIMULATED_FAILURE_RATE=0.3`, 20 reminders, 1 of them cancelled. Result:
   - 18 completed, 1 cancelled
   - 1 failed after 3 attempts
   - 9 reminders needed retries
   - exactly 1 notification per reminder
   - both workers shared the work
3. *(TODO, do this yourself:)* Open the tables in pgAdmin and run `EXPLAIN` on the worker query.
