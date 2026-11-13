const request = require('supertest');
const { createApp } = require('../src/app');
const worker = require('../src/jobs/reminder.job');
const { startDB, clearDB, stopDB, insertReminder, query } = require('./helpers/db');

const app = createApp();

beforeAll(startDB);
afterEach(clearDB);
afterAll(stopDB);

// Creates due reminders and runs the worker, so notifications exist
async function createNotifications(userId, count) {
  for (let i = 0; i < count; i++) {
    await insertReminder({ userId, title: `Reminder ${i}` });
  }
  await worker.runWorkerOnce('test-worker');
}

async function firstNotificationId() {
  const { rows } = await query('SELECT id FROM notifications LIMIT 1');
  return rows[0].id;
}

describe('Notifications API', () => {
  it('lists the user\'s notifications with pagination', async () => {
    await createNotifications('user1', 5);
    await createNotifications('user2', 2);

    const res = await request(app).get('/api/notifications?limit=2').set('x-user-id', 'user1');

    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination.total).toBe(5);
    expect(typeof res.body.data[0].delayMs).toBe('number');
  });

  it('marks a notification as read (keeps first read time) and filters unread', async () => {
    await createNotifications('user1', 3);
    const id = await firstNotificationId();

    const first = await request(app).patch(`/api/notifications/${id}/read`).set('x-user-id', 'user1');
    expect(first.body.readAt).not.toBeNull();

    const second = await request(app).patch(`/api/notifications/${id}/read`).set('x-user-id', 'user1');
    expect(second.body.readAt).toBe(first.body.readAt);

    const unread = await request(app).get('/api/notifications?unread=true').set('x-user-id', 'user1');
    expect(unread.body.pagination.total).toBe(2);
  });

  it('cannot read another user\'s notification', async () => {
    await createNotifications('user1', 1);
    const id = await firstNotificationId();

    const res = await request(app).patch(`/api/notifications/${id}/read`).set('x-user-id', 'user2');
    expect(res.status).toBe(404);
  });
});
