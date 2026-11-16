const { sequelize } = require('../src/config/database');
const { Reminder, Notification, FailedAttempt } = require('../src/models');
const notificationService = require('../src/services/notification.service');
const worker = require('../src/jobs/reminder.job');
const { setupApp, createClient } = require('./helpers/app');
const { clearDB, insertReminder } = require('./helpers/db');

// The app (and its database plugin) is used for the DB connection and the API calls
const app = setupApp();
const api = createClient(app);

afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

// Creates reminders that are already due
async function createDueReminders(count, options = {}) {
  const reminders = [];
  for (let i = 0; i < count; i++) {
    reminders.push(await insertReminder({ title: `Reminder ${i}`, ...options }));
  }
  return reminders;
}

// Simulates "the retry wait time is over"
async function makeDueNow(id) {
  await Reminder.update({ nextRunAt: new Date() }, { where: { id } });
}

// Simulates "a worker locked this reminder and then the server crashed"
async function makeStuck(id, { lockExpired = true } = {}) {
  await Reminder.update(
    {
      status: 'processing',
      lockedBy: 'dead-worker',
      attempts: 1,
      lockedUntil: new Date(Date.now() + (lockExpired ? -1000 : 60000)),
    },
    { where: { id } }
  );
}

describe('Basic processing', () => {
  it('creates a notification and marks the reminder completed', async () => {
    const [reminder] = await createDueReminders(1);

    const result = await worker.runWorkerOnce('worker-1');

    expect(result.completed).toBe(1);
    await reminder.reload();
    expect(reminder.status).toBe('completed');
    expect(reminder.lockedBy).toBeNull();
    expect(await Notification.count({ where: { reminderId: reminder.id } })).toBe(1);
  });

  it('can load the notification through the relationship (hasOne)', async () => {
    const [reminder] = await createDueReminders(1);
    await worker.runWorkerOnce('worker-1');

    const withNotification = await Reminder.findByPk(reminder.id, { include: 'notification' });
    expect(withNotification.notification.title).toBe(reminder.title);
  });

  it('ignores future, cancelled and completed reminders', async () => {
    await insertReminder({ title: 'Future', dueAt: new Date(Date.now() + 60 * 60 * 1000) });
    await insertReminder({ status: 'cancelled' });
    await insertReminder({ status: 'completed' });

    const result = await worker.runWorkerOnce('worker-1');

    expect(result.completed).toBe(0);
    expect(await Notification.count()).toBe(0);
  });

  it('processes OVERDUE reminders (e.g. server was off for 2 hours)', async () => {
    await insertReminder({ title: 'Old', dueAt: new Date(Date.now() - 2 * 60 * 60 * 1000) });

    await worker.runWorkerOnce('worker-1');

    const notification = await Notification.findOne();
    expect(notification.delayMs).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000);
  });
});

describe('Duplicate prevention (multiple workers)', () => {
  it('5 workers running at the same time: every reminder gets exactly 1 notification', async () => {
    await createDueReminders(40);

    // Start 5 workers at the same moment
    const results = await Promise.all([
      worker.runWorkerOnce('w1'),
      worker.runWorkerOnce('w2'),
      worker.runWorkerOnce('w3'),
      worker.runWorkerOnce('w4'),
      worker.runWorkerOnce('w5'),
    ]);

    const totalCompleted = results.reduce((sum, r) => sum + r.completed, 0);
    expect(totalCompleted).toBe(40);
    expect(await Notification.count()).toBe(40);
  });

  it('creating the same notification 10 times at once saves only 1', async () => {
    const [reminder] = await createDueReminders(1);

    await Promise.all(Array.from({ length: 10 }, () => notificationService.createNotification(reminder)));

    expect(await Notification.count()).toBe(1);
  });

  it('a slow worker whose lock expired cannot overwrite the result of the new worker', async () => {
    const [reminder] = await createDueReminders(1);

    // Worker A takes the reminder...
    const claimedByA = await worker.claimNextReminder('A');
    // ...but is too slow. Its lock expires, and worker B finishes the job.
    await Reminder.update({ lockedUntil: new Date(Date.now() - 1000) }, { where: { id: reminder.id } });
    await worker.runWorkerOnce('B');

    // Now A tries to finish too. It lost the lock, so its transaction is
    // rolled back and it must NOT change anything.
    const success = await worker.processReminder(claimedByA, 'A');

    expect(success).toBe(false);
    await reminder.reload();
    expect(reminder.status).toBe('completed');
    expect(await Notification.count()).toBe(1);
    // The only log is B's crash-recovery entry for A's expired lock. A itself
    // does NOT add a second, misleading failure log for a completed reminder.
    const logs = await FailedAttempt.findAll();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ workerId: 'A', error: 'Worker stopped before finishing' });
  });

  it('cancel requests racing with 3 workers: each reminder is EITHER cancelled OR notified, never both', async () => {
    const reminders = await createDueReminders(30);
    const [cancelResponses] = await Promise.all([
      Promise.all(
        reminders.map((r) => api.post(`/api/reminders/${r.id}/cancel`, undefined, 'user1'))
      ),
      worker.runWorkerOnce('w1'),
      worker.runWorkerOnce('w2'),
      worker.runWorkerOnce('w3'),
    ]);

    for (const [i, reminder] of reminders.entries()) {
      await reminder.reload();
      const notifications = await Notification.count({ where: { reminderId: reminder.id } });
      const response = cancelResponses[i];

      if (reminder.status === 'cancelled') {
        expect(response.status).toBe(200);
        expect(notifications).toBe(0);
      } else {
        expect(reminder.status).toBe('completed');
        expect(response.status).toBe(409); // the worker got there first
        expect(notifications).toBe(1);
      }
    }
  });
});

describe('Batch claiming', () => {
  it('claims several due reminders in one go, oldest first, each attempt counted once', async () => {
    const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000);
    await insertReminder({ title: 'newest', dueAt: minutesAgo(1) });
    await insertReminder({ title: 'oldest', dueAt: minutesAgo(30) });
    await insertReminder({ title: 'middle', dueAt: minutesAgo(10) });
    await insertReminder({ title: 'future', dueAt: new Date(Date.now() + 60 * 60 * 1000) });

    const claimed = await worker.claimDueReminders('worker-1', 2);

    expect(claimed.map((r) => r.title)).toEqual(['oldest', 'middle']);
    claimed.forEach((r) => expect(r).toMatchObject({ status: 'processing', lockedBy: 'worker-1', attempts: 1 }));
    expect(await Reminder.count({ where: { status: 'pending' } })).toBe(2); // newest + future untouched
  });

  it('two workers claiming at the same moment never get the same reminder', async () => {
    await createDueReminders(20);

    const [a, b] = await Promise.all([worker.claimDueReminders('A', 15), worker.claimDueReminders('B', 15)]);

    const ids = [...a, ...b].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length); // no overlap
    expect(ids).toHaveLength(20);
  });
});

describe('Cleanup of old failure logs', () => {
  it('deletes logs older than 30 days, at most once per hour', async () => {
    const [reminder] = await createDueReminders(1, { status: 'failed' });
    const log = (attempt, daysAgo) =>
      FailedAttempt.create({ reminderId: reminder.id, attempt, error: 'x', willRetry: false }).then((row) =>
        sequelize.query('UPDATE failed_attempts SET created_at = :at WHERE id = :id', {
          replacements: { at: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000), id: row.id },
        })
      );
    await log(1, 31); // old
    await log(2, 1); // recent

    // Pretend 2 hours have passed, so the hourly cleanup is due no matter
    // what earlier tests did
    const realNow = Date.now;
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + 2 * 60 * 60 * 1000);
    await worker.runWorkerOnce('worker-1');
    expect((await FailedAttempt.findAll()).map((f) => f.attempt)).toEqual([2]);

    // Another old log right away: not deleted, the next cleanup is in an hour
    await log(3, 31);
    await worker.runWorkerOnce('worker-1');
    expect(await FailedAttempt.count()).toBe(2);
  });
});

describe('Rescheduling', () => {
  it('a due reminder moved to a later time is not sent now', async () => {
    const [reminder] = await createDueReminders(1);
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const res = await api.patch(`/api/reminders/${reminder.id}`, { dueAt: later });
    expect(res.status).toBe(200);

    expect((await worker.runWorkerOnce('worker-1')).completed).toBe(0);
    expect(await Notification.count()).toBe(0);
  });
});

describe('Timezones (the worker only compares UTC instants)', () => {
  it('reminders due at the same instant fire together, whatever the user timezone', async () => {
    const justDue = new Date(Date.now() - 1000);
    const inOneHour = new Date(Date.now() + 60 * 60 * 1000);
    const make = (title, dueAt, timezone) =>
      Reminder.create({ userId: 'user1', title, dueAt, nextRunAt: dueAt, timezone });

    await make('India', justDue, 'Asia/Kolkata');
    await make('Los Angeles', justDue, 'America/Los_Angeles');
    await make('Kiribati (+14h) future', inOneHour, 'Pacific/Kiritimati');

    const result = await worker.runWorkerOnce('worker-1');

    expect(result.completed).toBe(2);
    const titles = (await Notification.findAll()).map((n) => n.title).sort();
    expect(titles).toEqual(['India', 'Los Angeles']);
  });
});

describe('Transactions', () => {
  it('if marking "completed" fails, the notification insert is rolled back too', async () => {
    const [reminder] = await createDueReminders(1);

    // Notification gets inserted, then an error happens inside the transaction
    const original = notificationService.createNotification;
    jest.spyOn(notificationService, 'createNotification').mockImplementationOnce(async (r, t) => {
      await original(r, t);
      throw new Error('Connection lost after saving');
    });

    await worker.runWorkerOnce('worker-1');

    // ROLLBACK: no notification was saved, reminder is waiting for a retry
    expect(await Notification.count()).toBe(0);
    await reminder.reload();
    expect(reminder.status).toBe('pending');

    // Retry works and creates exactly one notification
    await makeDueNow(reminder.id);
    await worker.runWorkerOnce('worker-1');
    expect(await Notification.count()).toBe(1);
    await reminder.reload();
    expect(reminder.status).toBe('completed');
  });

  it('SKIP LOCKED: a reminder locked by another transaction is skipped, not waited for', async () => {
    const [first] = await createDueReminders(1);
    const second = await insertReminder({ title: 'Second', dueAt: new Date(Date.now() - 500) });

    // Another "worker" holds a row lock on the oldest reminder (open transaction)
    const otherTransaction = await sequelize.transaction();
    await Reminder.findByPk(first.id, { lock: otherTransaction.LOCK.UPDATE, transaction: otherTransaction });

    // Our worker skips the locked row and takes the next one immediately
    const claimed = await worker.claimNextReminder('worker-1');
    expect(claimed.id).toBe(second.id);

    await otherTransaction.rollback();
  });
});

describe('Retries and failures', () => {
  it('retries after a failure and creates only 1 notification', async () => {
    const [reminder] = await createDueReminders(1, { maxAttempts: 3 });
    // First call fails, second call works normally
    jest
      .spyOn(notificationService, 'createNotification')
      .mockRejectedValueOnce(new Error('Database timeout'));

    // Attempt 1: fails
    await worker.runWorkerOnce('worker-1');
    await reminder.reload();
    expect(reminder.status).toBe('pending');
    expect(reminder.attempts).toBe(1);
    expect(reminder.lastError).toBe('Database timeout');
    expect(reminder.nextRunAt.getTime()).toBeGreaterThan(Date.now()); // will retry later

    // Not due yet -> nothing happens
    expect((await worker.runWorkerOnce('worker-1')).completed).toBe(0);

    // Attempt 2: after the wait time, it works
    await makeDueNow(reminder.id);
    await worker.runWorkerOnce('worker-1');

    await reminder.reload();
    expect(reminder.status).toBe('completed');
    expect(reminder.attempts).toBe(2);
    expect(await Notification.count()).toBe(1);
    expect(await FailedAttempt.count({ where: { reminderId: reminder.id } })).toBe(1);
  });

  it('marks reminder as failed after maxAttempts, and manual retry works', async () => {
    const [reminder] = await createDueReminders(1, { maxAttempts: 3 });
    jest.spyOn(notificationService, 'createNotification').mockRejectedValue(new Error('Always down'));

    for (let i = 0; i < 3; i++) {
      await worker.runWorkerOnce('worker-1');
      await makeDueNow(reminder.id);
    }

    await reminder.reload();
    expect(reminder.status).toBe('failed');
    expect(reminder.attempts).toBe(3);

    // Relationship (hasMany): load the failure log through the reminder
    const withFailures = await Reminder.findByPk(reminder.id, {
      include: 'failedAttempts',
      order: [['failedAttempts', 'attempt', 'ASC']],
    });
    expect(withFailures.failedAttempts.map((f) => f.willRetry)).toEqual([true, true, false]);

    // API: see the failures, then retry manually
    const attempts = await api.get(`/api/reminders/${reminder.id}/attempts`, 'user1');
    expect(attempts.body).toHaveLength(3);

    const retry = await api.post(`/api/reminders/${reminder.id}/retry`, undefined, 'user1');
    expect(retry.body.status).toBe('pending');
    expect(retry.body.attempts).toBe(0);
  });

  it('waits longer after each failure (exponential backoff: 30s, then 60s)', async () => {
    const [reminder] = await createDueReminders(1, { maxAttempts: 3 });
    jest.spyOn(notificationService, 'createNotification').mockRejectedValue(new Error('Down'));
    const expectWaitAbout = (ms) => {
      const wait = reminder.nextRunAt.getTime() - Date.now();
      expect(wait).toBeGreaterThan(ms - 5000);
      expect(wait).toBeLessThanOrEqual(ms);
    };

    await worker.runWorkerOnce('worker-1');
    await reminder.reload();
    expectWaitAbout(30 * 1000);

    await makeDueNow(reminder.id);
    await worker.runWorkerOnce('worker-1');
    await reminder.reload();
    expectWaitAbout(60 * 1000);
  });

  it('logs every failed attempt with attempt number, error and worker id', async () => {
    const [reminder] = await createDueReminders(1);
    jest.spyOn(notificationService, 'createNotification').mockRejectedValueOnce(new Error('SMTP timeout'));

    await worker.runWorkerOnce('worker-7');

    const [log] = await FailedAttempt.findAll({ where: { reminderId: reminder.id } });
    expect(log).toMatchObject({ attempt: 1, error: 'SMTP timeout', workerId: 'worker-7', willRetry: true });
  });

  it('manual retry is only allowed for failed reminders (409 otherwise)', async () => {
    const [reminder] = await createDueReminders(1);
    const res = await api.post(`/api/reminders/${reminder.id}/retry`, undefined, 'user1');
    expect(res.status).toBe(409);
  });

  it('failed attempts of another user\'s reminder are hidden (404)', async () => {
    const [reminder] = await createDueReminders(1);
    const res = await api.get(`/api/reminders/${reminder.id}/attempts`, 'user2');
    expect(res.status).toBe(404);
  });
});

describe('Crash / server restart', () => {
  it('a reminder stuck in "processing" (worker crashed) is picked up again', async () => {
    const [reminder] = await createDueReminders(1);
    await makeStuck(reminder.id);

    const result = await worker.runWorkerOnce('new-worker');

    expect(result.released).toBe(1);
    expect(result.completed).toBe(1);
    await reminder.reload();
    expect(reminder.status).toBe('completed');
  });

  it('crashed after creating the notification: still only 1 notification', async () => {
    const [reminder] = await createDueReminders(1);
    await notificationService.createNotification(reminder); // created before the crash
    await makeStuck(reminder.id);

    await worker.runWorkerOnce('new-worker');

    await reminder.reload();
    expect(reminder.status).toBe('completed');
    expect(await Notification.count()).toBe(1);
  });

  it('does NOT take a reminder whose lock is still valid', async () => {
    const [reminder] = await createDueReminders(1);
    await makeStuck(reminder.id, { lockExpired: false });

    const result = await worker.runWorkerOnce('other-worker');

    expect(result).toEqual({ released: 0, completed: 0, failed: 0 });
  });

  it('a crash is logged as a failed attempt (with the dead worker\'s id)', async () => {
    const [reminder] = await createDueReminders(1);
    await makeStuck(reminder.id);

    await worker.releaseStuckReminders();

    const [log] = await FailedAttempt.findAll({ where: { reminderId: reminder.id } });
    expect(log).toMatchObject({
      attempt: 1,
      error: 'Worker stopped before finishing',
      workerId: 'dead-worker',
      willRetry: true,
    });
  });

  it('a reminder that crashes the worker EVERY time stops after maxAttempts (no endless loop)', async () => {
    const [reminder] = await createDueReminders(1, { maxAttempts: 3 });

    for (let i = 0; i < 3; i++) {
      await worker.claimNextReminder('crashy-worker'); // takes it...
      await Reminder.update({ lockedUntil: new Date(Date.now() - 1000) }, { where: { id: reminder.id } }); // ...and dies
      await worker.releaseStuckReminders();
    }

    await reminder.reload();
    expect(reminder.status).toBe('failed');
    expect(reminder.attempts).toBe(3);
    const logs = await FailedAttempt.findAll({ where: { reminderId: reminder.id }, order: [['attempt', 'ASC']] });
    expect(logs.map((l) => l.willRetry)).toEqual([true, true, false]);

    // It is no longer picked up
    expect((await worker.runWorkerOnce('worker-1')).completed).toBe(0);
  });

  it('two workers starting at the same time release a stuck reminder only once', async () => {
    const [reminder] = await createDueReminders(1);
    await makeStuck(reminder.id);

    const released = await Promise.all([worker.releaseStuckReminders(), worker.releaseStuckReminders()]);

    expect(released[0] + released[1]).toBe(1);
    expect(await FailedAttempt.count()).toBe(1);
  });
});

describe('node-cron job', () => {
  it('runs in the background and can be stopped', async () => {
    await createDueReminders(2);
    const job = worker.startReminderJob(); // default: every 5 seconds

    // wait until the job has processed the reminders (max 8 seconds)
    const deadline = Date.now() + 8000;
    while ((await Notification.count()) < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await job.stop();

    expect(await Notification.count()).toBe(2);
  });
});
