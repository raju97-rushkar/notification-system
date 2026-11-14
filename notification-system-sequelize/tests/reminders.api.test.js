const request = require('supertest');
const { createApp } = require('../src/app');
const { Reminder } = require('../src/models');
const { startDB, clearDB, stopDB, insertReminder } = require('./helpers/db');

const app = createApp();

beforeAll(startDB);
afterEach(clearDB);
afterAll(stopDB);

// Small helpers
const minutesFromNow = (minutes) => new Date(Date.now() + minutes * 60 * 1000).toISOString();
const post = (url, body, user = 'user1') => request(app).post(url).set('x-user-id', user).send(body);
const get = (url, user = 'user1') => request(app).get(url).set('x-user-id', user);
const patch = (url, body, user = 'user1') => request(app).patch(url).set('x-user-id', user).send(body);

describe('Create reminder', () => {
  it('creates a reminder', async () => {
    const res = await post('/api/reminders', { title: 'Pay bill', dueAt: minutesFromNow(10) });

    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Pay bill');
    expect(res.body.status).toBe('pending');
    expect(res.body.id).toBeDefined();
    expect(res.body).not.toHaveProperty('lockedBy'); // internal field hidden
  });

  it('saves time in UTC and shows local time', async () => {
    const res = await post('/api/reminders', {
      title: 'Meeting',
      dueAt: '2099-01-15T10:00:00+05:30', // 10 AM India time
      timezone: 'Asia/Kolkata',
    });

    expect(res.body.dueAt).toBe('2099-01-15T04:30:00.000Z'); // = 4:30 AM UTC
    expect(res.body.dueAtLocal).toBe('1/15/2099, 10:00:00 AM');
  });

  it('handles daylight saving time (New York summer = UTC-4, winter = UTC-5)', async () => {
    const summer = await post('/api/reminders', {
      title: 'Summer',
      dueAt: '2099-07-01T09:00:00-04:00',
      timezone: 'America/New_York',
    });
    const winter = await post('/api/reminders', {
      title: 'Winter',
      dueAt: '2099-01-01T09:00:00-05:00',
      timezone: 'America/New_York',
    });

    expect(summer.body.dueAt).toBe('2099-07-01T13:00:00.000Z');
    expect(summer.body.dueAtLocal).toBe('7/1/2099, 9:00:00 AM');
    expect(winter.body.dueAt).toBe('2099-01-01T14:00:00.000Z');
    expect(winter.body.dueAtLocal).toBe('1/1/2099, 9:00:00 AM');
  });

  it('the same moment written with different offsets is stored identically', async () => {
    const india = await post('/api/reminders', { title: 'A', dueAt: '2099-03-10T15:30:00+05:30' });
    const utc = await post('/api/reminders', { title: 'B', dueAt: '2099-03-10T10:00:00Z' });
    const tokyo = await post('/api/reminders', { title: 'C', dueAt: '2099-03-10T19:00:00+09:00' });

    expect(new Set([india.body.dueAt, utc.body.dueAt, tokyo.body.dueAt]).size).toBe(1);
  });

  it('defaults timezone to UTC', async () => {
    const res = await post('/api/reminders', { title: 'x', dueAt: '2099-01-15T10:00:00Z' });
    expect(res.body.timezone).toBe('UTC');
    expect(res.body.dueAtLocal).toBe('1/15/2099, 10:00:00 AM');
  });

  it('changing only the timezone changes the local time, not the moment', async () => {
    const created = await post('/api/reminders', { title: 'x', dueAt: '2099-01-15T10:00:00Z' });
    const res = await patch(`/api/reminders/${created.body.id}`, { timezone: 'Asia/Kolkata' });

    expect(res.body.dueAt).toBe('2099-01-15T10:00:00.000Z');
    expect(res.body.dueAtLocal).toBe('1/15/2099, 3:30:00 PM');
  });

  it('rejects a date without timezone', async () => {
    const res = await post('/api/reminders', { title: 'x', dueAt: '2099-01-15T10:00:00' });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid timezone', async () => {
    const res = await post('/api/reminders', { title: 'x', dueAt: minutesFromNow(5), timezone: 'Mars/City' });
    expect(res.status).toBe(400);
  });

  it('rejects a date in the past', async () => {
    const res = await post('/api/reminders', { title: 'x', dueAt: minutesFromNow(-60) });
    expect(res.status).toBe(400);
  });

  it('rejects missing title', async () => {
    const res = await post('/api/reminders', { dueAt: minutesFromNow(5) });
    expect(res.status).toBe(400);
    expect(res.body.details[0].field).toBe('title');
  });

  it('needs the x-user-id header', async () => {
    const res = await request(app).post('/api/reminders').send({ title: 'x', dueAt: minutesFromNow(5) });
    expect(res.status).toBe(401);
  });

  it('is safe against SQL injection in text fields', async () => {
    const evil = "x'); DROP TABLE reminders; --";
    const res = await post('/api/reminders', { title: evil, dueAt: minutesFromNow(5) });

    expect(res.status).toBe(201);
    expect(res.body.title).toBe(evil); // stored as plain text
    expect((await get('/api/reminders')).status).toBe(200); // table still exists
  });
});

describe('List reminders (pagination, filter, sort)', () => {
  beforeEach(async () => {
    // 25 reminders for user1, one per hour. Plus 2 for another user.
    for (let i = 1; i <= 25; i++) {
      await insertReminder({
        title: `Task ${String(i).padStart(2, '0')}`,
        dueAt: new Date(Date.now() + i * 60 * 60 * 1000),
        status: i === 1 ? 'cancelled' : 'pending',
      });
    }
    await insertReminder({ userId: 'user2', title: 'Other' });
    await insertReminder({ userId: 'user2', title: 'Other 2' });
  });

  it('returns pages', async () => {
    const res = await get('/api/reminders?page=2&limit=10');
    expect(res.body.data).toHaveLength(10);
    expect(res.body.pagination).toEqual({ page: 2, limit: 10, total: 25, totalPages: 3 });
  });

  it('only shows the user\'s own reminders', async () => {
    const res = await get('/api/reminders', 'user2');
    expect(res.body.pagination.total).toBe(2);
  });

  it('sorts by dueAt', async () => {
    const asc = await get('/api/reminders?sortBy=dueAt&order=asc&limit=2');
    expect(asc.body.data.map((r) => r.title)).toEqual(['Task 01', 'Task 02']);

    const desc = await get('/api/reminders?sortBy=dueAt&order=desc&limit=1');
    expect(desc.body.data[0].title).toBe('Task 25');
  });

  it('filters by status', async () => {
    const res = await get('/api/reminders?status=cancelled');
    expect(res.body.pagination.total).toBe(1);
  });

  it('filters by date range', async () => {
    const from = encodeURIComponent(new Date(Date.now() + 2.5 * 3600 * 1000).toISOString());
    const to = encodeURIComponent(new Date(Date.now() + 5.5 * 3600 * 1000).toISOString());
    const res = await get(`/api/reminders?from=${from}&to=${to}`);
    expect(res.body.pagination.total).toBe(3); // Task 03, 04, 05
  });

  it('searches by title (special characters are safe)', async () => {
    expect((await get('/api/reminders?search=task 1')).body.pagination.total).toBe(10); // 10-19
    expect((await get('/api/reminders?search=%25')).body.pagination.total).toBe(0); // "%" is not a wildcard
  });

  it('rejects invalid query values', async () => {
    expect((await get('/api/reminders?limit=500')).status).toBe(400);
    expect((await get('/api/reminders?sortBy=password')).status).toBe(400);
    expect((await get('/api/reminders?status=unknown')).status).toBe(400);
  });
});

describe('Get, update, cancel', () => {
  let id;
  beforeEach(async () => {
    const res = await post('/api/reminders', { title: 'Original', dueAt: minutesFromNow(30) });
    id = res.body.id;
  });

  it('gets a reminder by id', async () => {
    expect((await get(`/api/reminders/${id}`)).status).toBe(200);
  });

  it('returns 404 for another user\'s reminder and 400 for a bad id', async () => {
    expect((await get(`/api/reminders/${id}`, 'someone-else')).status).toBe(404);
    expect((await get('/api/reminders/abc')).status).toBe(400);
  });

  it('updates a pending reminder', async () => {
    const newTime = minutesFromNow(120);
    const res = await patch(`/api/reminders/${id}`, { title: 'Changed', dueAt: newTime });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Changed');
    expect(res.body.nextRunAt).toBe(new Date(newTime).toISOString()); // worker uses new time
  });

  it('rejects an empty update', async () => {
    expect((await patch(`/api/reminders/${id}`, {})).status).toBe(400);
  });

  it('rejects moving dueAt into the past', async () => {
    expect((await patch(`/api/reminders/${id}`, { dueAt: minutesFromNow(-60) })).status).toBe(400);
  });

  it('cannot update or cancel another user\'s reminder (404)', async () => {
    expect((await patch(`/api/reminders/${id}`, { title: 'x' }, 'user2')).status).toBe(404);
    expect((await post(`/api/reminders/${id}/cancel`, undefined, 'user2')).status).toBe(404);
  });

  it('cannot update a cancelled reminder (409)', async () => {
    await post(`/api/reminders/${id}/cancel`);
    expect((await patch(`/api/reminders/${id}`, { title: 'x' })).status).toBe(409);
  });

  it('cancels a pending reminder, second cancel gives 409', async () => {
    const res = await post(`/api/reminders/${id}/cancel`);
    expect(res.body.status).toBe('cancelled');
    expect((await post(`/api/reminders/${id}/cancel`)).status).toBe(409);
  });

  it('cannot update or cancel while the worker is processing it', async () => {
    await Reminder.update({ status: 'processing' }, { where: { id } });

    expect((await patch(`/api/reminders/${id}`, { title: 'x' })).status).toBe(409);
    expect((await post(`/api/reminders/${id}/cancel`)).status).toBe(409);
  });
});

describe('Other routes', () => {
  it('unknown route gives 404', async () => {
    expect((await request(app).get('/api/unknown')).status).toBe(404);
  });

  it('broken JSON gives 400', async () => {
    const res = await request(app)
      .post('/api/reminders')
      .set('x-user-id', 'user1')
      .set('Content-Type', 'application/json')
      .send('{"title":');
    expect(res.status).toBe(400);
  });

  it('health check works', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body).toEqual({ server: 'ok', database: 'connected' });
  });
});
