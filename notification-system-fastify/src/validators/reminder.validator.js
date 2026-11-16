const { z } = require('zod');
const { isValidTimeZone } = require('../utils/time');
const { STATUS } = require('../models/reminder.model');

// Date must include a timezone offset, e.g. "2026-11-05T10:00:00+05:30" or "...Z".
// "2026-11-05T10:00:00" (no offset) is rejected, because we can't know whose 10:00 it is.
const dateWithTimezone = z.iso
  .datetime({ offset: true, message: 'Use ISO format with timezone, e.g. 2026-11-05T10:00:00+05:30' })
  .transform((value) => new Date(value));

const timezone = z.string().refine(isValidTimeZone, 'Invalid timezone, e.g. Asia/Kolkata');

const createReminderSchema = z.object({
  title: z.string().trim().min(1).max(200),
  message: z.string().max(2000).optional(),
  dueAt: dateWithTimezone,
  timezone: timezone.optional(),
});

// Same fields and rules as create, but every field is optional
const updateReminderSchema = createReminderSchema.partial();

// ?page=&limit= for every list endpoint. Query values always arrive as text,
// so z.coerce.number() turns "2" into 2.
const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
};

// Query string for GET /reminders
const listRemindersSchema = z
  .object({
    ...pagination,
    status: z.enum(Object.values(STATUS)).optional(),
    from: dateWithTimezone.optional(),
    to: dateWithTimezone.optional(),
    search: z.string().trim().max(200).optional(),
    sortBy: z.enum(['dueAt', 'createdAt', 'title']).default('createdAt'),
    order: z.enum(['asc', 'desc']).default('desc'),
  })
  // A range that ends before it starts is a client mistake: say so,
  // instead of quietly returning an empty list.
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    message: '"from" must be before "to"',
    path: ['from'],
  });

const listNotificationsSchema = z.object({
  ...pagination,
  unread: z.enum(['true', 'false']).optional(),
});

// URL params like /reminders/:id. A bad id gets a 400 here, before any
// database query runs.
const idParamsSchema = z.object({
  id: z.uuid({ message: 'Invalid id, must be a UUID' }),
});

module.exports = {
  idParamsSchema,
  createReminderSchema,
  updateReminderSchema,
  listRemindersSchema,
  listNotificationsSchema,
};
