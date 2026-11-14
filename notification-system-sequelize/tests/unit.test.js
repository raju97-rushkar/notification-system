// UNIT tests: pure functions and middlewares, no database and no HTTP server.
// (The *.api.test.js and worker tests are the integration tests.)
const { ValidationError, ValidationErrorItem } = require('sequelize');
const { isValidTimeZone } = require('../src/utils/time');
const AppError = require('../src/utils/AppError');
const checkUser = require('../src/middlewares/checkUser');
const validate = require('../src/middlewares/validate');
const { notFound, errorHandler } = require('../src/middlewares/errorHandler');
const {
  createReminderSchema,
  updateReminderSchema,
  listRemindersSchema,
  listNotificationsSchema,
} = require('../src/validators/reminder.validator');

// A tiny fake Express "res" object that remembers what was sent
function fakeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('isValidTimeZone', () => {
  it.each(['UTC', 'Asia/Kolkata', 'America/New_York', 'Europe/London'])('accepts %s', (tz) => {
    expect(isValidTimeZone(tz)).toBe(true);
  });

  it.each(['Mars/City', 'Kolkata', '', 'GMT+99'])('rejects "%s"', (tz) => {
    expect(isValidTimeZone(tz)).toBe(false);
  });
});

describe('createReminderSchema', () => {
  const valid = { title: 'Pay bill', dueAt: '2099-01-15T10:00:00+05:30' };

  it('turns dueAt into a Date in UTC', () => {
    const data = createReminderSchema.parse(valid);
    expect(data.dueAt).toBeInstanceOf(Date);
    expect(data.dueAt.toISOString()).toBe('2099-01-15T04:30:00.000Z');
  });

  it('trims the title', () => {
    expect(createReminderSchema.parse({ ...valid, title: '  Pay bill  ' }).title).toBe('Pay bill');
  });

  it('accepts "Z" as the timezone offset', () => {
    expect(createReminderSchema.safeParse({ ...valid, dueAt: '2099-01-15T04:30:00Z' }).success).toBe(true);
  });

  it.each([
    ['no timezone offset', { ...valid, dueAt: '2099-01-15T10:00:00' }],
    ['not a date', { ...valid, dueAt: 'tomorrow' }],
    ['empty title', { ...valid, title: '   ' }],
    ['title too long', { ...valid, title: 'x'.repeat(201) }],
    ['message too long', { ...valid, message: 'x'.repeat(2001) }],
    ['unknown timezone', { ...valid, timezone: 'Mars/City' }],
    ['missing dueAt', { title: 'x' }],
  ])('rejects %s', (_, body) => {
    expect(createReminderSchema.safeParse(body).success).toBe(false);
  });

  it('drops fields the client must not set (status, attempts, userId)', () => {
    const data = createReminderSchema.parse({ ...valid, status: 'completed', attempts: 99, userId: 'hacker' });
    expect(data).not.toHaveProperty('status');
    expect(data).not.toHaveProperty('attempts');
    expect(data).not.toHaveProperty('userId');
  });
});

describe('updateReminderSchema', () => {
  it('allows a partial update', () => {
    expect(updateReminderSchema.parse({ title: 'New' })).toEqual({ title: 'New' });
  });

  it('cannot change status through update', () => {
    expect(updateReminderSchema.parse({ status: 'completed' })).toEqual({});
  });
});

describe('listRemindersSchema', () => {
  it('fills in defaults and turns text into numbers', () => {
    expect(listRemindersSchema.parse({ page: '2' })).toEqual({
      page: 2,
      limit: 10,
      sortBy: 'createdAt',
      order: 'desc',
    });
  });

  it.each([{ page: '0' }, { limit: '101' }, { page: '1.5' }, { sortBy: 'lockedBy' }, { order: 'up' }])(
    'rejects %o',
    (query) => {
      expect(listRemindersSchema.safeParse(query).success).toBe(false);
    }
  );
});

describe('listNotificationsSchema', () => {
  it('only accepts "true" or "false" for unread', () => {
    expect(listNotificationsSchema.safeParse({ unread: 'true' }).success).toBe(true);
    expect(listNotificationsSchema.safeParse({ unread: 'yes' }).success).toBe(false);
  });
});

describe('checkUser middleware', () => {
  it('saves the user id from the header', () => {
    const req = { header: () => 'user1' };
    const next = jest.fn();
    checkUser(req, {}, next);
    expect(req.userId).toBe('user1');
    expect(next).toHaveBeenCalledWith();
  });

  it('sends a 401 error when the header is missing', () => {
    const next = jest.fn();
    checkUser({ header: () => undefined }, {}, next);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 401 });
  });
});

describe('validate middleware', () => {
  it('puts clean data in req.validated', () => {
    const req = { query: { page: '3' } };
    const next = jest.fn();
    validate(listNotificationsSchema, 'query')(req, {}, next);
    expect(req.validated).toEqual({ page: 3, limit: 10 });
    expect(next).toHaveBeenCalledWith();
  });

  it('passes the zod error on when invalid', () => {
    const next = jest.fn();
    validate(createReminderSchema)({ body: {} }, {}, next);
    expect(next.mock.calls[0][0].name).toBe('ZodError');
  });

  it('treats a missing body as {}', () => {
    const next = jest.fn();
    validate(updateReminderSchema)({}, {}, next);
    expect(next).toHaveBeenCalledWith();
  });
});

describe('errorHandler', () => {
  function handle(err) {
    const res = fakeRes();
    errorHandler(err, {}, res, () => {});
    return { status: res.status.mock.calls[0][0], body: res.json.mock.calls[0][0] };
  }

  it('AppError -> its own status code', () => {
    expect(handle(new AppError(409, 'Busy'))).toEqual({ status: 409, body: { message: 'Busy' } });
  });

  it('zod error -> 400 with field names', () => {
    const result = createReminderSchema.safeParse({ dueAt: 'x' });
    const { status, body } = handle(result.error);
    expect(status).toBe(400);
    expect(body.details.map((d) => d.field)).toEqual(expect.arrayContaining(['title', 'dueAt']));
  });

  it('Sequelize validation error -> 400', () => {
    const err = new ValidationError('bad', [new ValidationErrorItem('too long', 'Validation error', 'title')]);
    expect(handle(err)).toEqual({
      status: 400,
      body: { message: 'Validation failed', details: [{ field: 'title', message: 'too long' }] },
    });
  });

  it('broken JSON -> 400', () => {
    expect(handle({ type: 'entity.parse.failed' }).status).toBe(400);
  });

  it('unknown error -> 500 without leaking details', () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(handle(new Error('secret connection string'))).toEqual({
      status: 500,
      body: { message: 'Something went wrong' },
    });
    console.error.mockRestore();
  });

  it('notFound -> 404 with the route', () => {
    const next = jest.fn();
    notFound({ method: 'GET', originalUrl: '/api/nope' }, {}, next);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 404, message: 'Route GET /api/nope not found' });
  });
});
