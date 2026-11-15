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
const LOCK_TIME_MS = Number(process.env.WORKER_LOCK_TIME_MS) || 60 * 1000; // crash -> released after this
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS) || 30 * 1000; // first retry wait, doubles each time
const FAILURE_RATE = Number(process.env.SIMULATED_FAILURE_RATE) || 0; // demo only: 0.3 = 30% fail

// A unique name for this running process, e.g. "my-laptop-12345".
// Saved on the reminder while we work on it, so other workers know it's taken.
const WORKER_ID = `${os.hostname()}-${process.pid}`;

// Where log lines go. startReminderJob() switches this to Fastify's logger
// (app.log), so worker logs appear in the same structured log as requests.
let log = console;

/*
 * HOW THE WORKER WORKS (every few seconds, via node-cron):
 *
 *   1. releaseStuckReminders()  -> a worker crashed? give its reminders back
 *   2. claimNextReminder()      -> TRANSACTION: lock ONE due reminder (SKIP LOCKED)
 *   3. processReminder()        -> TRANSACTION: create notification + mark "completed"
 *        on error -> handleFailure() -> TRANSACTION: retry later / "failed" + save log
 *   4. repeat 2-3 until no due reminders are left (or BATCH_SIZE is reached)
 */

// STEP 1: Find a due reminder and lock it.
//
// Inside a transaction, Sequelize runs:
//   SELECT ... WHERE status = 'pending' AND next_run_at <= now
//   ORDER BY next_run_at LIMIT 1  FOR UPDATE SKIP LOCKED
//   UPDATE reminders SET status = 'processing', ...
//
//   FOR UPDATE  (lock)       -> lock the row until the transaction ends
//   SKIP LOCKED (skipLocked) -> if another worker has locked a row, skip it
//                               and take the next one (don't wait, don't share)
// So two workers can never claim the same reminder.
async function claimNextReminder(workerId) {
  return sequelize.transaction(async (transaction) => {
    const reminder = await Reminder.findOne({
      where: { status: STATUS.PENDING, nextRunAt: { [Op.lte]: new Date() } },
      order: [['nextRunAt', 'ASC']], // oldest first
      lock: transaction.LOCK.UPDATE,
      skipLocked: true,
      transaction,
    });
    if (!reminder) return null; // nothing is due

    await reminder.update(
      {
        status: STATUS.PROCESSING,
        lockedBy: workerId,
        lockedUntil: new Date(Date.now() + LOCK_TIME_MS),
        attempts: reminder.attempts + 1,
      },
      { transaction }
    );
    return reminder;
  }); // COMMIT here -> the row lock is released, status is now "processing"
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
        {
          status: STATUS.COMPLETED,
          processedAt: new Date(),
          lastError: null,
          lockedBy: null,
          lockedUntil: null,
        },
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

// STEP 3: Something went wrong. Save the error, then retry later or give up.
async function handleFailure(reminder, workerId, error) {
  const willRetry = reminder.attempts < reminder.maxAttempts;

  // Wait longer after each failure: 30s, 60s, 120s, ... ("exponential backoff")
  const waitMs = RETRY_DELAY_MS * 2 ** (reminder.attempts - 1);

  const changes = willRetry
    ? { status: STATUS.PENDING, nextRunAt: new Date(Date.now() + waitMs) }
    : { status: STATUS.FAILED };

  // Status change + failure log are saved together (one transaction)
  const logged = await sequelize.transaction(async (transaction) => {
    const [updatedCount] = await Reminder.update(
      { ...changes, lastError: error.message, lockedBy: null, lockedUntil: null },
      { where: { id: reminder.id, status: STATUS.PROCESSING, lockedBy: workerId }, transaction }
    );

    // Our lock expired and another worker took over: this attempt no longer
    // owns the reminder, so don't write a failure log for it.
    if (updatedCount === 0) return false;

    await FailedAttempt.create(
      {
        reminderId: reminder.id,
        attempt: reminder.attempts,
        error: error.message,
        workerId,
        willRetry,
      },
      { transaction }
    );
    return true;
  });

  if (logged) {
    log.warn(`Reminder ${reminder.id} failed (attempt ${reminder.attempts}): ${error.message}`);
  } else {
    log.warn(`Reminder ${reminder.id}: lock lost, another worker owns it now (${error.message})`);
  }
}

const CRASH_ERROR = 'Worker stopped before finishing';

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
      const willRetry = reminder.attempts < reminder.maxAttempts;
      const deadWorker = reminder.lockedBy;

      await reminder.update(
        {
          ...(willRetry ? { status: STATUS.PENDING, nextRunAt: now } : { status: STATUS.FAILED }),
          lastError: CRASH_ERROR,
          lockedBy: null,
          lockedUntil: null,
        },
        { transaction }
      );

      await FailedAttempt.create(
        { reminderId: reminder.id, attempt: reminder.attempts, error: CRASH_ERROR, workerId: deadWorker, willRetry },
        { transaction }
      );
    }

    return stuck.length;
  });
}

// PostgreSQL has no automatic "delete after X days" (like MongoDB's TTL index),
// so the worker removes failure logs older than 30 days itself.
async function deleteOldFailedAttempts() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  await FailedAttempt.destroy({ where: { createdAt: { [Op.lt]: thirtyDaysAgo } } });
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
  claimNextReminder,
  processReminder,
  handleFailure,
  releaseStuckReminders,
};
