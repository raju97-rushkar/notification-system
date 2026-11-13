# AI Usage Report

> **DRAFT. Rewrite this in your own words before submitting.** These entries describe what really happened while building this project with Claude Code (an AI coding assistant in VS Code). Re-run each verification yourself so you can explain it without reading this file.

---

## 1. Preventing duplicate notifications with multiple workers

- **Problem:** The same reminder must never create two notifications, even when several workers run at once.
- **Prompt:** The full assignment text, plus *"build it with a proper structure and guide me through how it works."*
- **AI suggestion:**
  1. Claim the reminder with one atomic `findOneAndUpdate` (`pending → processing`) plus a lock (`lockedBy`, `lockedUntil`).
  2. Add a **unique index** on `notifications.reminderId`.
  3. Treat MongoDB error `11000` (duplicate) as "already done".
- **What I changed or rejected:** I rejected using only a status flag. If a worker crashes after setting `processing`, the reminder would be stuck forever. `lockedUntil` lets another worker take over after a timeout. I also rejected transactions, because they need a replica set and the unique index already gives the same safety.
- **Verification:** The test runs 5 workers in parallel on 40 reminders and gets exactly 40 notifications. A manual run with 2 real processes and 30% simulated failures also gave a maximum of 1 notification per reminder.

## 2. Crash after the notification was saved

- **Problem:** What if the server crashes after creating the notification but before marking the reminder `completed`?
- **Prompt:** *"What happens if the worker crashes between creating the notification and updating the status?"*
- **AI answer:** The lock expires, and `releaseStuckReminders()` puts the reminder back to `pending`. The next attempt gets error `11000` from the unique index, which counts as success, so the reminder is marked `completed`. No duplicate is created.
- **Verification:** Tests "crashed AFTER creating the notification" and "retry after notification saved, but status update failed".

## 3. Making the code simpler (fresher-friendly)

- **Problem:** The first version was correct but hard for a fresher to read. It used a class with dependency injection, a lock token (UUID), partial indexes, custom serializers and a custom logger.
- **Prompt:** *"Use node-cron and make the project simple and easy, so even a fresher doing code review can understand it."*
- **AI changes:**
  - The worker class became plain functions (`claimNextReminder`, `processReminder`, `handleFailure`, `releaseStuckReminders`).
  - The `setTimeout` loop became node-cron with `noOverlap: true`.
  - The lock check uses `lockedBy` (the worker id) instead of a separate UUID token.
  - Partial indexes became normal compound indexes.
  - Serializers were replaced by the schema's `toJSON`.
  - Tests use `jest.spyOn` instead of injected fake functions.
- **Trade-offs I accepted:** A crash-recovered reminder can get one extra attempt beyond `maxAttempts`. Partial indexes would be a bit faster at very large scale. Both are written down in ARCHITECTURE.md and DATABASE.md.
- **Verification:** 38 tests pass, plus a manual run with 2 worker processes on local MongoDB.

## 4. Tests failing with "Missing required sub-document 'driver'"

- **Problem:** Every database test failed inside Jest, although the same code worked outside Jest.
- **Prompt:** I pasted the error message.
- **AI approach:** It narrowed the problem down step by step:
  1. A plain Node script connected fine.
  2. A minimal Jest test with the raw driver failed, so the cause was Jest + the driver, not my code.
  3. Inside Jest, the driver's `await import('os')` throws unless Node runs with `--experimental-vm-modules`.
- **What I changed or rejected:** I rejected changing `db.js` just for tests. I added the Node flag to the `npm test` script instead.
- **Verification:** All tests pass.

## 5. Time zones

- **Problem:** Store times safely and show them in the user's timezone.
- **AI suggestion:** Store everything in UTC, require an offset in the input, store the IANA timezone, and show `dueAtLocal`.
- **What I changed:** The first formatter printed abbreviations like "IST". These are ambiguous (India, Israel and Ireland all use "IST") and differ between systems. The simple version uses `toLocaleString('en-US', { timeZone })`, which gives a clear local time. I also made dates without an offset (e.g. `2026-12-01T10:00`) an error instead of guessing.
- **Verification:** Test "saves time in UTC and shows local time": `10:00+05:30` is stored as `04:30Z` and shown as `10:00:00 AM`.

## 6. A mistake by the AI that I caught

- While writing files through shell commands, the AI broke backslashes in a regex, which caused a syntax error, and one file was cut off. Loading every module once (`require('./src/app')`) found the problem before the tests ran.
- **Lesson:** always run the generated code. Don't trust it just because it was written.

---

## How I verified everything

1. `npm test`: 38 tests on a real in-memory MongoDB.
2. A manual run on local MongoDB: the API plus a second worker (`npm run worker`) with `SIMULATED_FAILURE_RATE=0.3`, 20 reminders, 1 of them cancelled. Result:
   - 18 completed, 1 cancelled
   - 1 failed after 3 attempts
   - exactly 1 notification per reminder
   - both workers shared the work
3. *(TODO, do this yourself:)* Check the collections and indexes in MongoDB Compass.
