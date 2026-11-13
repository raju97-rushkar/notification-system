const request = require('supertest');
const { createApp } = require('../src/app');
const { toReminder } = require('../src/models/reminder.model');
const notificationService = require('../src/services/notification.service');
const worker = require('../src/jobs/reminder.job');
const { startDB, clearDB, stopDB, insertReminder, getReminderRow, countRows, query } = require('./helpers/db');

beforeAll(startDB);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});
afterAll(stopDB);

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
  await query('UPDATE reminders SET next_run_at = now() WHERE id = $1', [id]);
}

// Simulates "a worker locked this reminder and then the server crashed"
async function makeStuck(id, { lockExpired = true } = {}) {
  await query(
    `UPDATE reminders SET status = 'processing', locked_by = 'dead-worker', attempts = 1,
       locked_until = now() + $2::float8 * interval '1 millisecond'
     WHERE id = $1`,
    [id, lockExpired ? -1000 : 60000]
  );
}

describe('Basic processing', () => {
  it('creates a notification and marks the reminder completed', async () => {
    const [reminder] = await createDueReminders(1);

    const result = await worker.runWorkerOnce('worker-1');

    expect(result.completed).toBe(1);
    const row = await getReminderRow(reminder.id);
    expect(row.status).toBe('completed');
    expect(row.locked_by).toBeNull();
    expect(await countRows('notifications', 'reminder_id = $1', [reminder.id])).toBe(1);
  });

  it('ignores future, cancelled and completed reminders', async () => {
    await insertReminder({ title: 'Future', dueAt: new Date(Date.now() + 60 * 60 * 1000) });
    await insertReminder({ status: 'cancelled' });
    await insertReminder({ status: 'completed' });

    const result = await worker.runWorkerOnce('worker-1');

    expect(result.completed).toBe(0);
    expect(await countRows('notifications')).toBe(0);
  });

  it('processes OVERDUE reminders (e.g. server was off for 2 hours)', async () => {
    await insertReminder({ title: 'Old', dueAt: new Date(Date.now() - 2 * 60 * 60 * 1000) });

    await worker.runWorkerOnce('worker-1');

    const { rows } = await query('SELECT delay_ms FROM notifications');
    expect(Number(rows[0].delay_ms)).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000);
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
    expect(await countRows('notifications')).toBe(40);
  });

  it('creating the same notification 10 times at once saves only 1', async () => {
    const [row] = await createDueReminders(1);
    const reminder = toReminder(row);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => notificationService.createNotification(reminder))
    );

    expect(results.filter((n) => n !== null)).toHaveLength(1); // only one insert "won"
    expect(await countRows('notifications')).toBe(1);
  });

  it('a slow worker whose lock expired cannot overwrite the result of the new worker', async () => {
    const [row] = await createDueReminders(1);

    // Worker A takes the reminder...
    const claimedByA = await worker.claimNextReminder('A');
    // ...but is too slow. Its lock expires, and worker B finishes the job.
    await query(`UPDATE reminders SET locked_until = now() - interval '1 second' WHERE id = $1`, [row.id]);
    await worker.runWorkerOnce('B');

    // Now A reports a failure. It must NOT change the completed reminder.
    await worker.handleFailure(claimedByA, 'A', new Error('late error'));

    expect((await getReminderRow(row.id)).status).toBe('completed');
    expect(await countRows('notifications')).toBe(1);
  });
});

describe('Retries and failures', () => {
  it('retries after a failure and creates only 1 notification', async () => {
    const [row] = await createDueReminders(1, { maxAttempts: 3 });
    // First call fails, second call works normally
    jest
      .spyOn(notificationService, 'createNotification')
      .mockRejectedValueOnce(new Error('Database timeout'));

    // Attempt 1: fails
    await worker.runWorkerOnce('worker-1');
    let updated = await getReminderRow(row.id);
    expect(updated.status).toBe('pending');
    expect(updated.attempts).toBe(1);
    expect(updated.last_error).toBe('Database timeout');
    expect(updated.next_run_at.getTime()).toBeGreaterThan(Date.now()); // will retry later

    // Not due yet -> nothing happens
    expect((await worker.runWorkerOnce('worker-1')).completed).toBe(0);

    // Attempt 2: after the wait time, it works
    await makeDueNow(row.id);
    await worker.runWorkerOnce('worker-1');

    updated = await getReminderRow(row.id);
    expect(updated.status).toBe('completed');
    expect(updated.attempts).toBe(2);
    expect(await countRows('notifications')).toBe(1);
    expect(await countRows('failed_attempts', 'reminder_id = $1', [row.id])).toBe(1);
  });

  it('marks reminder as failed after maxAttempts, and manual retry works', async () => {
    const [row] = await createDueReminders(1, { maxAttempts: 3 });
    jest.spyOn(notificationService, 'createNotification').mockRejectedValue(new Error('Always down'));

    for (let i = 0; i < 3; i++) {
      await worker.runWorkerOnce('worker-1');
      await makeDueNow(row.id);
    }

    const updated = await getReminderRow(row.id);
    expect(updated.status).toBe('failed');
    expect(updated.attempts).toBe(3);

    const { rows: failures } = await query(
      'SELECT will_retry FROM failed_attempts WHERE reminder_id = $1 ORDER BY attempt',
      [row.id]
    );
    expect(failures.map((f) => f.will_retry)).toEqual([true, true, false]);

    // API: see the failures, then retry manually
    const app = createApp();
    const attempts = await request(app).get(`/api/reminders/${row.id}/attempts`).set('x-user-id', 'user1');
    expect(attempts.body).toHaveLength(3);

    const retry = await request(app).post(`/api/reminders/${row.id}/retry`).set('x-user-id', 'user1');
    expect(retry.body.status).toBe('pending');
    expect(retry.body.attempts).toBe(0);
  });

  it('retry after "notification saved, but status update failed" gives no duplicate', async () => {
    const [row] = await createDueReminders(1);

    // Notification gets saved, then an error happens (e.g. network problem)
    const original = notificationService.createNotification;
    jest.spyOn(notificationService, 'createNotification').mockImplementationOnce(async (r) => {
      await original(r);
      throw new Error('Connection lost after saving');
    });

    await worker.runWorkerOnce('worker-1'); // fails, will retry
    await makeDueNow(row.id);
    await worker.runWorkerOnce('worker-1'); // retry: ON CONFLICT DO NOTHING

    expect((await getReminderRow(row.id)).status).toBe('completed');
    expect(await countRows('notifications')).toBe(1);
  });
});

describe('Crash / server restart', () => {
  it('a reminder stuck in "processing" (worker crashed) is picked up again', async () => {
    const [row] = await createDueReminders(1);
    await makeStuck(row.id);

    const result = await worker.runWorkerOnce('new-worker');

    expect(result.released).toBe(1);
    expect(result.completed).toBe(1);
    expect((await getReminderRow(row.id)).status).toBe('completed');
  });

  it('crashed AFTER creating the notification: still only 1 notification', async () => {
    const [row] = await createDueReminders(1);
    await notificationService.createNotification(toReminder(row)); // created before the crash
    await makeStuck(row.id);

    await worker.runWorkerOnce('new-worker');

    expect((await getReminderRow(row.id)).status).toBe('completed');
    expect(await countRows('notifications')).toBe(1);
  });

  it('does NOT take a reminder whose lock is still valid', async () => {
    const [row] = await createDueReminders(1);
    await makeStuck(row.id, { lockExpired: false });

    const result = await worker.runWorkerOnce('other-worker');

    expect(result).toEqual({ released: 0, completed: 0, failed: 0 });
  });
});

describe('node-cron job', () => {
  it('runs in the background and can be stopped', async () => {
    await createDueReminders(2);
    const job = worker.startReminderJob(); // default: every 5 seconds

    // wait until the job has processed the reminders (max 8 seconds)
    const deadline = Date.now() + 8000;
    while ((await countRows('notifications')) < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await job.stop();

    expect(await countRows('notifications')).toBe(2);
  });
});
