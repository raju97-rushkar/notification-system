// UNIT tests: pure functions and plugin functions, no database and no HTTP server.
// (The *.api.test.js and worker tests are the integration tests.)
const { ValidationError, ValidationErrorItem } = require('sequelize');
const { isValidTimeZone } = require('../src/utils/time');
const AppError = require('../src/utils/AppError');
const { checkUser } = require('../src/plugins/auth');
const { zodValidatorCompiler } = require('../src/plugins/validation');
const { errorHandler, notFoundHandler } = require('../src/plugins/errorHandler');
const {
  idParamsSchema,
  createReminderSchema,
  updateReminderSchema,
  listRemindersSchema,
  listNotificationsSchema,
} = require('../src/validators/reminder.validator');

// A tiny fake Fastify "reply" object that remembers what was sent
function fakeReply() {
  const reply = {};
  reply.code = jest.fn(() => reply);
  reply.send = jest.fn(() => reply);
  return reply;
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

describe('idParamsSchema', () => {
  it('accepts a UUID and rejects anything else', () => {
    expect(idParamsSchema.safeParse({ id: '3f2b8c1e-7a4d-4e1b-9c2a-5d6e7f8a9b0c' }).success).toBe(true);
    expect(idParamsSchema.safeParse({ id: 'abc' }).success).toBe(false);
    expect(idParamsSchema.safeParse({ id: "1' OR '1'='1" }).success).toBe(false);
  });
});

describe('checkUser hook', () => {
  it('saves the user id from the header', async () => {
    const request = { headers: { 'x-user-id': 'user1' } };
    await checkUser(request);
    expect(request.userId).toBe('user1');
  });

  it('throws a 401 error when the header is missing', async () => {
    await expect(checkUser({ headers: {} })).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('zod validator compiler', () => {
  it('returns { value } with the clean, transformed data', () => {
    const validate = zodValidatorCompiler({ schema: listNotificationsSchema });
    expect(validate({ page: '3' })).toEqual({ value: { page: 3, limit: 10 } });
  });

  it('returns { error } with the zod error when invalid', () => {
    const validate = zodValidatorCompiler({ schema: createReminderSchema });
    expect(validate({}).error.name).toBe('ZodError');
  });

  it('treats a missing body (null) as {}', () => {
    const validate = zodValidatorCompiler({ schema: updateReminderSchema });
    expect(validate(null)).toEqual({ value: {} });
  });
});

describe('errorHandler', () => {
  function handle(err) {
    const reply = fakeReply();
    const request = { log: { error: jest.fn() } };
    errorHandler(err, request, reply);
    return { status: reply.code.mock.calls[0][0], body: reply.send.mock.calls[0][0], log: request.log.error };
  }

  it('AppError -> its own status code', () => {
    const { status, body } = handle(new AppError(409, 'Busy'));
    expect({ status, body }).toEqual({ status: 409, body: { message: 'Busy' } });
  });

  it('zod error -> 400 with field names', () => {
    const result = createReminderSchema.safeParse({ dueAt: 'x' });
    const { status, body } = handle(result.error);
    expect(status).toBe(400);
    expect(body.details.map((d) => d.field)).toEqual(expect.arrayContaining(['title', 'dueAt']));
  });

  it('Sequelize validation error -> 400', () => {
    const err = new ValidationError('bad', [new ValidationErrorItem('too long', 'Validation error', 'title')]);
    const { status, body } = handle(err);
    expect({ status, body }).toEqual({
      status: 400,
      body: { message: 'Validation failed', details: [{ field: 'title', message: 'too long' }] },
    });
  });

  it("Fastify's own 4xx errors keep their status (e.g. broken JSON)", () => {
    const err = Object.assign(new Error('Body is not valid JSON'), { statusCode: 400 });
    expect(handle(err).status).toBe(400);
  });

  it('unknown error -> 500, logged, without leaking details', () => {
    const { status, body, log } = handle(new Error('secret connection string'));
    expect({ status, body }).toEqual({ status: 500, body: { message: 'Something went wrong' } });
    expect(log).toHaveBeenCalled();
  });

  it('notFoundHandler -> 404 with the route', () => {
    const reply = fakeReply();
    notFoundHandler({ method: 'GET', url: '/api/nope' }, reply);
    expect(reply.code).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith({ message: 'Route GET /api/nope not found' });
  });
});
