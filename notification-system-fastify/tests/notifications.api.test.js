const { Notification } = require('../src/models');
const worker = require('../src/jobs/reminder.job');
const { setupApp, createClient } = require('./helpers/app');
const { clearDB, insertReminder } = require('./helpers/db');

const app = setupApp();
const api = createClient(app);

afterEach(clearDB);

// Creates due reminders and runs the worker, so notifications exist
async function createNotifications(userId, count) {
  for (let i = 0; i < count; i++) {
    await insertReminder({ userId, title: `Reminder ${i}` });
  }
  await worker.runWorkerOnce('test-worker');
}

describe('Notifications API', () => {
  it('lists the user\'s notifications with pagination', async () => {
    await createNotifications('user1', 5);
    await createNotifications('user2', 2);

    const res = await api.get('/api/notifications?limit=2', 'user1');

    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination.total).toBe(5);
    expect(typeof res.body.data[0].delayMs).toBe('number');
  });

  it('marks a notification as read (keeps first read time) and filters unread', async () => {
    await createNotifications('user1', 3);
    const { id } = await Notification.findOne();

    const first = await api.patch(`/api/notifications/${id}/read`, undefined, 'user1');
    expect(first.body.readAt).not.toBeNull();

    const second = await api.patch(`/api/notifications/${id}/read`, undefined, 'user1');
    expect(second.body.readAt).toBe(first.body.readAt);

    const unread = await api.get('/api/notifications?unread=true', 'user1');
    expect(unread.body.pagination.total).toBe(2);
  });

  it('cannot read another user\'s notification', async () => {
    await createNotifications('user1', 1);
    const { id } = await Notification.findOne();

    const res = await api.patch(`/api/notifications/${id}/read`, undefined, 'user2');
    expect(res.status).toBe(404);
  });

  it('gives 400 for an invalid id and 401 without x-user-id', async () => {
    expect((await api.patch('/api/notifications/abc/read', undefined, 'user1')).status).toBe(400);
    expect((await api.get('/api/notifications', null)).status).toBe(401);
  });

  it('filters read notifications (unread=false)', async () => {
    await createNotifications('user1', 3);
    const { id } = await Notification.findOne();
    await api.patch(`/api/notifications/${id}/read`, undefined, 'user1');

    const read = await api.get('/api/notifications?unread=false', 'user1');
    expect(read.body.pagination.total).toBe(1);
    expect(read.body.data[0].id).toBe(id);
  });
});
