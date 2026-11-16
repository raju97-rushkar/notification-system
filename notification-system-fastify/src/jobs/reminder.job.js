const os = require('os');
const cron = require('node-cron');
const { Op } = require('sequelize');
const { sequelize } = require('../config/database');
const { Reminder, FailedAttempt, STATUS } = require('../models');
const notificationService = require('../services/notification.service');

// ----- Worker settings (from .env, with default values) -----
// Values in .env are always text, so Number() turns "3" into 3.
const SCHEDULE = process.env.WORKER_SCHEDULE || '*/5 * * * * *'; // every 5 seconds
const BATCH_SIZE = Number(process.env.WORKER_BATCH_SIZE) || 50; // max reminders per run
const CLAIM_SIZE = Number(process.env.WORKER_CLAIM_SIZE) || 10; // reminders claimed per transaction
const LOCK_TIME_MS = Number(process.env.WORKER_LOCK_TIME_MS) || 60 * 1000; // crash -> released after this
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS) || 30 * 1000; // first retry wait, doubles each time
const FAILURE_RATE = Number(process.env.SIMULATED_FAILURE_RATE) || 0; // demo only: 0.3 = 30% fail
const CLEANUP_EVERY_MS = 60 * 60 * 1000; // delete old failure logs at most once per hour
const FAILED_ATTEMPT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // keep failure logs for 30 days

// A unique name for this running process, e.g. "my-laptop-12345".
// Saved on the reminder while we work on it, so other workers know it's taken.
const WORKER_ID = `${os.hostname()}-${process.pid}`;

const CRASH_ERROR = 'Worker stopped before finishing';

// "Give the reminder back": used whenever a worker is done with a reminder
const UNLOCK = { lockedBy: null, lockedUntil: null };

// Where log lines go. startReminderJob() switches this to Fastify's logger
// (app.log), so worker logs appear in the same structured log as requests.
let log = console;

/*
 * HOW THE WORKER WORKS (every few seconds, via node-cron):
 *
 *   1. releaseStuckReminders()  -> a worker crashed? give its reminders back
 *   2. claimDueReminders()      -> TRANSACTION: lock up to CLAIM_SIZE due reminders (SKIP LOCKED)
 *   3. processReminder()        -> TRANSACTION per reminder: create notification + mark "completed"
 *        on error -> handleFailure() -> TRANSACTION: retry later / "failed" + save log
 *   4. repeat 2-3 until no due reminders are left (or BATCH_SIZE is reached)
 */

// STEP 1: Find due reminders and lock them, in ONE transaction.
//
//   SELECT ... WHERE status = 'pending' AND next_run_at <= now
//   ORDER BY next_run_at LIMIT n  FOR UPDATE SKIP LOCKED
//   UPDATE reminders SET status = 'processing', attempts = attempts + 1, ...
//   WHERE id IN (...) RETURNING *
//
//   FOR UPDATE  (lock)       -> lock the rows until the transaction ends
//   SKIP LOCKED (skipLocked) -> rows another worker has locked are skipped
//                               (don't wait, don't share)
// So two workers can never claim the same reminder.
//
// Claiming a few at once (instead of one transaction per reminder) saves
// database round trips. CLAIM_SIZE stays small so other workers still get
// a fair share, and so the lock time (LOCK_TIME_MS) is plenty for the batch.
async function claimDueReminders(workerId, count = CLAIM_SIZE) {
  return sequelize.transaction(async (transaction) => {
    const due = await Reminder.findAll({
      attributes: ['id'],
      where: { status: STATUS.PENDING, nextRunAt: { [Op.lte]: new Date() } },
      order: [['nextRunAt', 'ASC']], // oldest first
      limit: count,
      lock: transaction.LOCK.UPDATE,
      skipLocked: true,
      transaction,
    });
    if (due.length === 0) return []; // nothing is due

    const [, claimed] = await Reminder.update(
      {
        status: STATUS.PROCESSING,
        lockedBy: workerId,
        lockedUntil: new Date(Date.now() + LOCK_TIME_MS),
        attempts: sequelize.literal('attempts + 1'),
      },
      { where: { id: due.map((r) => r.id) }, returning: true, transaction }
    );

    // RETURNING has no guaranteed order: keep "oldest first"
    return claimed.sort((a, b) => a.nextRunAt - b.nextRunAt);
  }); // COMMIT here -> the row locks are released, status is now "processing"
}

// One reminder (used by tests and handy for debugging)
async function claimNextReminder(workerId) {
  const [reminder] = await claimDueReminders(workerId, 1);
  return reminder ?? null;
}

// STEP 2: Do the actual work for one reminder.
async function processReminder(reminder, workerId) {
  try {
    if (Math.random() < FAILURE_RATE) {
      throw new Error('Simulated failure (demo)');
    }

    // ONE transaction for both writes: either BOTH happen or NEITHER.
    // If anything fails in between, the notification insert is rolled back
    // too, so we never end up with "notification created but reminder still
    // processing".
    await sequelize.transaction(async (transaction) => {
      // Safe even if it runs twice: ON CONFLICT DO NOTHING (unique reminderId)
      await notificationService.createNotification(reminder, transaction);

      // "lockedBy: workerId": only update if WE still own the lock.
      const [updatedCount] = await Reminder.update(
        { status: STATUS.COMPLETED, processedAt: new Date(), lastError: null, ...UNLOCK },
        { where: { id: reminder.id, status: STATUS.PROCESSING, lockedBy: workerId }, transaction }
      );

      // Our lock expired and another worker took over -> undo our notification
      // insert (throwing inside the transaction = ROLLBACK).
      if (updatedCount === 0) {
        throw new Error('Lock lost: another worker took over this reminder');
      }
    });
    return true;
  } catch (error) {
    await handleFailure(reminder, workerId, error);
    return false;
  }
}

// Shared by handleFailure (an attempt threw) and releaseStuckReminders (a
// worker crashed): one failed attempt of `reminder`.
//
//   - attempts left -> back to "pending" at `retryAt`, otherwise -> "failed"
//   - write the failure log (failed_attempts)
//
// Both writes happen in the caller's transaction, so the log and the status
// always match. `where` is an extra guard: if the reminder no longer matches it
// (another worker owns it now), nothing is changed and false is returned.
async function recordFailedAttempt(reminder, { error, workerId, retryAt, where, transaction }) {
  const willRetry = reminder.attempts < reminder.maxAttempts;

  const [updatedCount] = await Reminder.update(
    {
      ...(willRetry ? { status: STATUS.PENDING, nextRunAt: retryAt } : { status: STATUS.FAILED }),
      lastError: error,
      ...UNLOCK,
    },
    { where: { id: reminder.id, ...where }, transaction }
  );
  if (updatedCount === 0) return false;

  await FailedAttempt.create(
    { reminderId: reminder.id, attempt: reminder.attempts, error, workerId, willRetry },
    { transaction }
  );
  return true;
}

// STEP 3: Something went wrong. Save the error, then retry later or give up.
async function handleFailure(reminder, workerId, error) {
  // Wait longer after each failure: 30s, 60s, 120s, ... ("exponential backoff")
  const waitMs = RETRY_DELAY_MS * 2 ** (reminder.attempts - 1);

  const logged = await sequelize.transaction((transaction) =>
    recordFailedAttempt(reminder, {
      error: error.message,
      workerId,
      retryAt: new Date(Date.now() + waitMs),
      // Only if WE still own it. If our lock expired and another worker took
      // over, this attempt no longer counts: no status change, no log.
      where: { status: STATUS.PROCESSING, lockedBy: workerId },
      transaction,
    })
  );

  if (logged) {
    log.warn(`Reminder ${reminder.id} failed (attempt ${reminder.attempts}): ${error.message}`);
  } else {
    log.warn(`Reminder ${reminder.id}: lock lost, another worker owns it now (${error.message})`);
  }
}

// Crash recovery: if a worker crashed or the server restarted while a reminder
// was "processing", the reminder would be stuck forever. When the lock time
// is over, we put it back to "pending" so any worker can pick it up again.
//
// A crash counts as a failed attempt: it is logged, and once maxAttempts is
// used up the reminder becomes "failed". Without that, a reminder that crashes
// the worker every time would be retried forever.
//
// SKIP LOCKED again: two workers starting at the same time never handle (and
// log) the same stuck reminder twice.
async function releaseStuckReminders() {
  return sequelize.transaction(async (transaction) => {
    const now = new Date();
    const stuck = await Reminder.findAll({
      where: { status: STATUS.PROCESSING, lockedUntil: { [Op.lte]: now } },
      limit: BATCH_SIZE,
      lock: transaction.LOCK.UPDATE,
      skipLocked: true,
      transaction,
    });

    for (const reminder of stuck) {
      await recordFailedAttempt(reminder, {
        error: CRASH_ERROR,
        workerId: reminder.lockedBy, // the worker that died
        retryAt: now, // retry right away
        where: { status: STATUS.PROCESSING }, // row is already locked by this transaction
        transaction,
      });
    }

    return stuck.length;
  });
}

// PostgreSQL has no automatic "delete after X days" (like MongoDB's TTL index),
// so the worker removes failure logs older than 30 days itself.
// Once per hour is plenty: running it every 5 seconds would only add load.
let lastCleanupAt = 0;
async function deleteOldFailedAttempts() {
  if (Date.now() - lastCleanupAt < CLEANUP_EVERY_MS) return;
  lastCleanupAt = Date.now();
  await FailedAttempt.destroy({ where: { createdAt: { [Op.lt]: new Date(Date.now() - FAILED_ATTEMPT_TTL_MS) } } });
}

// One full run of the worker. Returns counts (handy for logs and tests).
async function runWorkerOnce(workerId = WORKER_ID) {
  const released = await releaseStuckReminders();
  await deleteOldFailedAttempts();

  let completed = 0;
  let failed = 0;

  while (completed + failed < BATCH_SIZE) {
    const claimSize = Math.min(CLAIM_SIZE, BATCH_SIZE - completed - failed);
    const reminders = await claimDueReminders(workerId, claimSize);
    if (reminders.length === 0) break; // nothing is due

    for (const reminder of reminders) {
      const success = await processReminder(reminder, workerId);
      if (success) completed++;
      else failed++;
    }
  }

  return { released, completed, failed };
}

// Start the worker using node-cron.
// noOverlap: true -> if one run is still busy, the next run is skipped,
// so the same worker never runs twice at the same time.
//
// logger: Fastify's app.log (pino). Pino takes (object, message), and
// console accepts the same arguments, so both work.
function startReminderJob(logger = console) {
  log = logger;
  const task = cron.schedule(
    SCHEDULE,
    async () => {
      try {
        const result = await runWorkerOnce();
        if (result.completed || result.failed || result.released) {
          log.info(result, 'Worker run');
        }
      } catch (error) {
        // e.g. database is down. Don't crash, just try again on the next run.
        log.error({ err: error }, 'Worker run failed');
      }
    },
    { name: 'reminder-worker', noOverlap: true }
  );

  log.info(`Reminder worker started (${WORKER_ID}), schedule: "${SCHEDULE}"`);
  return task;
}

module.exports = {
  startReminderJob,
  runWorkerOnce,
  claimDueReminders,
  claimNextReminder,
  processReminder,
  handleFailure,
  releaseStuckReminders,
};
