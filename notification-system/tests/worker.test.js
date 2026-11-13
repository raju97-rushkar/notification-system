const request = require('supertest');
const { createApp } = require('../src/app');
const { Reminder } = require('../src/models/reminder.model');
const { Notification } = require('../src/models/notification.model');
const { FailedAttempt } = require('../src/models/failedAttempt.model');
const notificationService = require('../src/services/notification.service');
const worker = require('../src/jobs/reminder.job');
const { startDB, clearDB, stopDB } = require('./helpers/db');

beforeAll(startDB);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});
afterAll(stopDB);

// Creates reminders that are already due
async function createDueReminders(count, extra = {}) {
  const dueAt = new Date(Date.now() - 1000);
  const reminders = [];
  for (let i = 0; i < count; i++) {
    reminders.push({ userId: 'user1', title: `Reminder ${i}`, dueAt, nextRunAt: dueAt, ...extra });
  }
  return Reminder.insertMany(reminders);
}

// Simulates "the retry wait time is over"
async function makeDueNow(id) {
  await Reminder.updateOne({ _id: id }, { nextRunAt: new Date() });
}

describe('Basic processing', () => {
  it('creates a notification and marks the reminder completed', async () => {
    const [reminder] = await createDueReminders(1);

    const result = await worker.runWorkerOnce('worker-1');

    expect(result.completed).toBe(1);
    const updated = await Reminder.findById(reminder._id);
    expect(updated.status).toBe('completed');
    expect(updated.lockedBy).toBeNull();
    expect(await Notification.countDocuments({ reminderId: reminder._id })).toBe(1);
  });

  it('ignores future, cancelled and completed reminders', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    await Reminder.create({ userId: 'user1', title: 'Future', dueAt: future, nextRunAt: future });
    await createDueReminders(1, { status: 'cancelled' });
    await createDueReminders(1, { status: 'completed' });

    const result = await worker.runWorkerOnce('worker-1');

    expect(result.completed).toBe(0);
    expect(await Notification.countDocuments()).toBe(0);
  });

  it('processes OVERDUE reminders (e.g. server was off for 2 hours)', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await Reminder.create({ userId: 'user1', title: 'Old', dueAt: twoHoursAgo, nextRunAt: twoHoursAgo });

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
    expect(await Notification.countDocuments()).toBe(40);
  });

  it('creating the same notification 10 times at once saves only 1', async () => {
    const [reminder] = await createDueReminders(1);

    await Promise.all(Array.from({ length: 10 }, () => notificationService.createNotification(reminder)));

    expect(await Notification.countDocuments()).toBe(1);
  });

  it('a slow worker whose lock expired cannot overwrite the result of the new worker', async () => {
    const [reminder] = await createDueReminders(1);

    // Worker A takes the reminder...
    const claimedByA = await worker.claimNextReminder('A');
    // ...but is too slow. Its lock expires, and worker B finishes the job.
    await Reminder.updateOne({ _id: reminder._id }, { lockedUntil: new Date(Date.now() - 1000) });
    await worker.runWorkerOnce('B');

    // Now A reports a failure. It must NOT change the completed reminder.
    await worker.handleFailure(claimedByA, 'A', new Error('late error'));

    expect((await Reminder.findById(reminder._id)).status).toBe('completed');
    expect(await Notification.countDocuments()).toBe(1);
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
    let updated = await Reminder.findById(reminder._id);
    expect(updated.status).toBe('pending');
    expect(updated.attempts).toBe(1);
    expect(updated.lastError).toBe('Database timeout');
    expect(updated.nextRunAt.getTime()).toBeGreaterThan(Date.now()); // will retry later

    // Not due yet -> nothing happens
    expect((await worker.runWorkerOnce('worker-1')).completed).toBe(0);

    // Attempt 2: after the wait time, it works
    await makeDueNow(reminder._id);
    await worker.runWorkerOnce('worker-1');

    updated = await Reminder.findById(reminder._id);
    expect(updated.status).toBe('completed');
    expect(updated.attempts).toBe(2);
    expect(await Notification.countDocuments()).toBe(1);
    expect(await FailedAttempt.countDocuments({ reminderId: reminder._id })).toBe(1);
  });

  it('marks reminder as failed after maxAttempts, and manual retry works', async () => {
    const [reminder] = await createDueReminders(1, { maxAttempts: 3 });
    jest.spyOn(notificationService, 'createNotification').mockRejectedValue(new Error('Always down'));

    for (let i = 0; i < 3; i++) {
      await worker.runWorkerOnce('worker-1');
      await makeDueNow(reminder._id);
    }

    const updated = await Reminder.findById(reminder._id);
    expect(updated.status).toBe('failed');
    expect(updated.attempts).toBe(3);

    const failures = await FailedAttempt.find({ reminderId: reminder._id }).sort({ attempt: 1 });
    expect(failures.map((f) => f.willRetry)).toEqual([true, true, false]);

    // API: see the failures, then retry manually
    const app = createApp();
    const attempts = await request(app).get(`/api/reminders/${reminder._id}/attempts`).set('x-user-id', 'user1');
    expect(attempts.body).toHaveLength(3);

    const retry = await request(app).post(`/api/reminders/${reminder._id}/retry`).set('x-user-id', 'user1');
    expect(retry.body.status).toBe('pending');
    expect(retry.body.attempts).toBe(0);
  });

  it('retry after "notification saved, but status update failed" gives no duplicate', async () => {
    const [reminder] = await createDueReminders(1);

    // Notification gets saved, then an error happens (e.g. network problem)
    const original = notificationService.createNotification;
    jest.spyOn(notificationService, 'createNotification').mockImplementationOnce(async (r) => {
      await original(r);
      throw new Error('Connection lost after saving');
    });

    await worker.runWorkerOnce('worker-1'); // fails, will retry
    await makeDueNow(reminder._id);
    await worker.runWorkerOnce('worker-1'); // retry: duplicate is ignored

    expect((await Reminder.findById(reminder._id)).status).toBe('completed');
    expect(await Notification.countDocuments()).toBe(1);
  });
});

describe('Crash / server restart', () => {
  it('a reminder stuck in "processing" (worker crashed) is picked up again', async () => {
    const [reminder] = await createDueReminders(1);
    // Simulate: a worker locked it and then the server crashed
    await Reminder.updateOne(
      { _id: reminder._id },
      { status: 'processing', lockedBy: 'dead-worker', lockedUntil: new Date(Date.now() - 1000), attempts: 1 }
    );

    const result = await worker.runWorkerOnce('new-worker');

    expect(result.released).toBe(1);
    expect(result.completed).toBe(1);
    expect((await Reminder.findById(reminder._id)).status).toBe('completed');
  });

  it('crashed AFTER creating the notification: still only 1 notification', async () => {
    const [reminder] = await createDueReminders(1);
    await notificationService.createNotification(reminder); // created before the crash
    await Reminder.updateOne(
      { _id: reminder._id },
      { status: 'processing', lockedBy: 'dead-worker', lockedUntil: new Date(Date.now() - 1000), attempts: 1 }
    );

    await worker.runWorkerOnce('new-worker');

    expect((await Reminder.findById(reminder._id)).status).toBe('completed');
    expect(await Notification.countDocuments()).toBe(1);
  });

  it('does NOT take a reminder whose lock is still valid', async () => {
    const [reminder] = await createDueReminders(1);
    await Reminder.updateOne(
      { _id: reminder._id },
      { status: 'processing', lockedBy: 'busy-worker', lockedUntil: new Date(Date.now() + 60000) }
    );

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
    while ((await Notification.countDocuments()) < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await job.stop();

    expect(await Notification.countDocuments()).toBe(2);
  });
});
