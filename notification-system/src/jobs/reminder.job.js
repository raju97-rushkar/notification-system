const os = require('os');
const cron = require('node-cron');
const { Reminder, STATUS } = require('../models/reminder.model');
const { FailedAttempt } = require('../models/failedAttempt.model');
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
 *   4. repeat 2-3 until no due reminders are left (or batchSize is reached)
 */

// STEP 1: Find a due reminder and lock it, in ONE atomic MongoDB operation.
// Two workers can never get the same reminder: MongoDB runs findOneAndUpdate
// on a document one at a time, and after the first worker changes the status
// to "processing", the filter no longer matches for the second worker.
async function claimNextReminder(workerId) {
  const now = new Date();
  return Reminder.findOneAndUpdate(
    { status: STATUS.PENDING, nextRunAt: { $lte: now } },
    {
      $set: {
        status: STATUS.PROCESSING,
        lockedBy: workerId,
        lockedUntil: new Date(now.getTime() + LOCK_TIME_MS),
      },
      $inc: { attempts: 1 },
    },
    { sort: { nextRunAt: 1 }, returnDocument: 'after' } // oldest first
  );
}

// STEP 2: Do the actual work for one reminder.
async function processReminder(reminder, workerId) {
  try {
    if (Math.random() < FAILURE_RATE) {
      throw new Error('Simulated failure (demo)');
    }

    // Safe even if it runs twice: the unique index prevents duplicates.
    await notificationService.createNotification(reminder);

    // "lockedBy: workerId" in the filter: only update if WE still own the lock.
    // (If our lock expired and another worker took over, this does nothing.)
    await Reminder.updateOne(
      { _id: reminder._id, status: STATUS.PROCESSING, lockedBy: workerId },
      {
        $set: {
          status: STATUS.COMPLETED,
          processedAt: new Date(),
          lastError: null,
          lockedBy: null,
          lockedUntil: null,
        },
      }
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

  const changes = willRetry
    ? { status: STATUS.PENDING, nextRunAt: new Date(Date.now() + waitMs) }
    : { status: STATUS.FAILED };

  await Reminder.updateOne(
    { _id: reminder._id, status: STATUS.PROCESSING, lockedBy: workerId },
    { $set: { ...changes, lastError: error.message, lockedBy: null, lockedUntil: null } }
  );

  // Keep a record of every failed attempt
  await FailedAttempt.create({
    reminderId: reminder._id,
    attempt: reminder.attempts,
    error: error.message,
    workerId,
    willRetry,
  });

  console.log(`Reminder ${reminder._id} failed (attempt ${reminder.attempts}): ${error.message}`);
}

// Crash recovery: if a worker crashed or the server restarted while a reminder
// was "processing", the reminder would be stuck forever. When the lock time
// is over, we put it back to "pending" so any worker can pick it up again.
// (If the crashed worker had already created the notification, the next try
// gets a duplicate error -> it's simply marked completed. No double notification.)
async function releaseStuckReminders() {
  const result = await Reminder.updateMany(
    { status: STATUS.PROCESSING, lockedUntil: { $lte: new Date() } },
    {
      $set: {
        status: STATUS.PENDING,
        nextRunAt: new Date(),
        lastError: 'Worker stopped before finishing',
        lockedBy: null,
        lockedUntil: null,
      },
    }
  );
  return result.modifiedCount;
}

// One full run of the worker. Returns counts (handy for logs and tests).
async function runWorkerOnce(workerId = WORKER_ID) {
  const released = await releaseStuckReminders();
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
