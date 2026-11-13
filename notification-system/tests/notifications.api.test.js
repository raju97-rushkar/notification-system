const request = require('supertest');
const { createApp } = require('../src/app');
const { Reminder } = require('../src/models/reminder.model');
const { Notification } = require('../src/models/notification.model');
const { ReminderProcessor } = require('../src/worker/reminder.processor');
const { formatInTimeZone, isValidTimeZone } = require('../src/utils/time');
const { startDB, clearDB, stopDB } = require('./helpers/db');

const app = createApp();

beforeAll(startDB);
afterEach(clearDB);
afterAll(stopDB);

async function seedNotifications(userId, n) {
  const past = new Date(Date.now() - 1000);
  await Reminder.insertMany(
    Array.from({ length: n }, (_, i) => ({ userId, title: `N${i}`, dueAt: past, nextRunAt: past }))
  );
  await new ReminderProcessor().runOnce();
}

describe('notifications API', () => {
  it('lists the user\'s notifications with pagination', async () => {
    await seedNotifications('u1', 5);
    await seedNotifications('u2', 2);

    const res = await request(app).get('/api/notifications?limit=2').set('x-user-id', 'u1');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination.total).toBe(5);
    expect(res.body.data[0]).toMatchObject({ userId: 'u1', read: false });
  });

  it('marks as read (idempotent - keeps first readAt) and filters unread', async () => {
    await seedNotifications('u1', 3);
    const n = await Notification.findOne({ userId: 'u1' }).lean();

    const first = await request(app).patch(`/api/notifications/${n._id}/read`).set('x-user-id', 'u1');
    expect(first.status).toBe(200);
    expect(first.body.data.read).toBe(true);
    const second = await request(app).patch(`/api/notifications/${n._id}/read`).set('x-user-id', 'u1');
    expect(second.body.data.readAt).toBe(first.body.data.readAt);

    const unread = await request(app).get('/api/notifications?unread=true').set('x-user-id', 'u1');
    expect(unread.body.pagination.total).toBe(2);
    const read = await request(app).get('/api/notifications?unread=false').set('x-user-id', 'u1');
    expect(read.body.pagination.total).toBe(1);
  });

  it('cannot mark another user\'s notification as read', async () => {
    await seedNotifications('u1', 1);
    const n = await Notification.findOne().lean();
    const res = await request(app).patch(`/api/notifications/${n._id}/read`).set('x-user-id', 'u2');
    expect(res.status).toBe(404);
  });
});

describe('time utils', () => {
  it('validates IANA timezones', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
  });

  it('formats the same instant differently per timezone (incl. DST)', () => {
    const instant = new Date('2026-07-01T12:00:00Z');
    expect(formatInTimeZone(instant, 'Asia/Kolkata')).toBe('2026-07-01 17:30:00 GMT+5:30');
    expect(formatInTimeZone(instant, 'America/New_York')).toBe('2026-07-01 08:00:00 EDT'); // summer
    expect(formatInTimeZone(new Date('2026-01-01T12:00:00Z'), 'America/New_York')).toBe('2026-01-01 07:00:00 EST'); // winter
  });
});
