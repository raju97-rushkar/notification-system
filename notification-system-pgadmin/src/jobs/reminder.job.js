const os = require('os');
const cron = require('node-cron');
const { query } = require('../config/db');
const { toReminder } = require('../models/reminder.model');
const notificationService = require('../services/notification.service');

// ----- Worker settings (from .env, with default values) -----
// Values in .env are always text, so Number() turns "3" into 3.
const SCHEDULE = process.env.WORKER_SCHEDULE || '*/5 * * * * *'; // every 5 seconds
const BATCH_SIZE = Number(process.env.WORKER_BATCH_SIZE) || 50; // max reminders per run
const LOCK_TIME_MS = Number(process.env.WORKER_LOCK_TIME_MS) || 60 * 1000; // crash -> released after this
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS) || 30 * 1000; // first retry wait, doubles each time
const FAILURE_RATE = Number(process.env.SIMULATED_FAILURE_RATE) || 0; // demo only: 0.3 = 30% fail

// A unique name for this running process, e.g. "my-laptop-12345".
// Saved on the reminder while we work on it, so other workers know it's taken.
const WORKER_ID = `${os.hostname()}-${process.pid}`;

/*
 * HOW THE WORKER WORKS (every few seconds, via node-cron):
 *
 *   1. releaseStuckReminders()  -> a worker crashed? give its reminders back
 *   2. claimNextReminder()      -> take ONE due reminder and lock it
 *   3. processReminder()        -> create notification, mark "completed"
 *        on error -> handleFailure() -> retry later, or mark "failed"
 *   4. repeat 2-3 until no due reminders are left (or BATCH_SIZE is reached)
 *
 * All times use the DATABASE clock (now()), so several servers with slightly
 * different clocks still agree on what "due" means.
 */

// STEP 1: Find a due reminder and lock it, in ONE SQL statement.
// "FOR UPDATE SKIP LOCKED" is the key part for multiple workers:
//   FOR UPDATE  -> lock the selected row until this statement is finished
//   SKIP LOCKED -> if another worker has already locked a row, skip it and
//                  take the next one (instead of waiting or taking the same one)
// So two workers can never claim the same reminder.
async function claimNextReminder(workerId) {
  const result = await query(
    `UPDATE reminders
     SET status       = 'processing',
         locked_by    = $1,
         locked_until = now() + $2::float8 * interval '1 millisecond',
         attempts     = attempts + 1,
         updated_at   = now()
     WHERE id = (
       SELECT id FROM reminders
       WHERE status = 'pending' AND next_run_at <= now()
       ORDER BY next_run_at          -- oldest first
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [workerId, LOCK_TIME_MS]
  );
  return toReminder(result.rows[0]); // null if nothing is due
}

// STEP 2: Do the actual work for one reminder.
async function processReminder(reminder, workerId) {
  try {
    if (Math.random() < FAILURE_RATE) {
      throw new Error('Simulated failure (demo)');
    }

    // Safe even if it runs twice: ON CONFLICT DO NOTHING prevents duplicates.
    await notificationService.createNotification(reminder);

    // "locked_by = $2": only update if WE still own the lock.
    // (If our lock expired and another worker took over, this changes nothing.)
    await query(
      `UPDATE reminders
       SET status = 'completed', processed_at = now(), last_error = NULL,
           locked_by = NULL, locked_until = NULL, updated_at = now()
       WHERE id = $1 AND status = 'processing' AND locked_by = $2`,
      [reminder.id, workerId]
    );
    return true;
  } catch (error) {
    await handleFailure(reminder, workerId, error);
    return false;
  }
}

// STEP 3: Something went wrong. Save the error, then retry later or give up.
async function handleFailure(reminder, workerId, error) {
  const willRetry = reminder.attempts < reminder.maxAttempts;

  // Wait longer after each failure: 30s, 60s, 120s, ... ("exponential backoff")
  const waitMs = RETRY_DELAY_MS * 2 ** (reminder.attempts - 1);

  if (willRetry) {
    await query(
      `UPDATE reminders
       SET status = 'pending', next_run_at = now() + $3::float8 * interval '1 millisecond',
           last_error = $4, locked_by = NULL, locked_until = NULL, updated_at = now()
       WHERE id = $1 AND status = 'processing' AND locked_by = $2`,
      [reminder.id, workerId, waitMs, error.message]
    );
  } else {
    await query(
      `UPDATE reminders
       SET status = 'failed', last_error = $3, locked_by = NULL, locked_until = NULL, updated_at = now()
       WHERE id = $1 AND status = 'processing' AND locked_by = $2`,
      [reminder.id, workerId, error.message]
    );
  }

  // Keep a record of every failed attempt
  await query(
    `INSERT INTO failed_attempts (reminder_id, attempt, error, worker_id, will_retry)
     VALUES ($1, $2, $3, $4, $5)`,
    [reminder.id, reminder.attempts, error.message, workerId, willRetry]
  );

  console.log(`Reminder ${reminder.id} failed (attempt ${reminder.attempts}): ${error.message}`);
}

// Crash recovery: if a worker crashed or the server restarted while a reminder
// was "processing", the reminder would be stuck forever. When the lock time
// is over, we put it back to "pending" so any worker can pick it up again.
// (If the crashed worker had already created the notification, the next try
// hits ON CONFLICT DO NOTHING -> it's simply marked completed. No duplicate.)
async function releaseStuckReminders() {
  const result = await query(
    `UPDATE reminders
     SET status = 'pending', next_run_at = now(), last_error = 'Worker stopped before finishing',
         locked_by = NULL, locked_until = NULL, updated_at = now()
     WHERE status = 'processing' AND locked_until <= now()`
  );
  return result.rowCount;
}

// PostgreSQL has no automatic "delete after X days" (MongoDB's TTL index),
// so the worker removes failure logs older than 30 days itself.
async function deleteOldFailedAttempts() {
  await query(`DELETE FROM failed_attempts WHERE created_at < now() - interval '30 days'`);
}

// One full run of the worker. Returns counts (handy for logs and tests).
async function runWorkerOnce(workerId = WORKER_ID) {
  const released = await releaseStuckReminders();
  await deleteOldFailedAttempts();

  let completed = 0;
  let failed = 0;

  for (let i = 0; i < BATCH_SIZE; i++) {
    const reminder = await claimNextReminder(workerId);
    if (!reminder) break; // nothing is due

    const success = await processReminder(reminder, workerId);
    if (success) completed++;
    else failed++;
  }

  return { released, completed, failed };
}

// Start the worker using node-cron.
// noOverlap: true -> if one run is still busy, the next run is skipped,
// so the same worker never runs twice at the same time.
function startReminderJob() {
  const task = cron.schedule(
    SCHEDULE,
    async () => {
      try {
        const result = await runWorkerOnce();
        if (result.completed || result.failed || result.released) {
          console.log('Worker run:', result);
        }
      } catch (error) {
        // e.g. database is down. Don't crash, just try again on the next run.
        console.error('Worker run failed:', error.message);
      }
    },
    { name: 'reminder-worker', noOverlap: true }
  );

  console.log(`Reminder worker started (${WORKER_ID}), schedule: "${SCHEDULE}"`);
  return task;
}

module.exports = {
  startReminderJob,
  runWorkerOnce,
  claimNextReminder,
  processReminder,
  handleFailure,
  releaseStuckReminders,
};
