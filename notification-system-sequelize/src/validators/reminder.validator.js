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

const updateReminderSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  message: z.string().max(2000).optional(),
  dueAt: dateWithTimezone.optional(),
  timezone: timezone.optional(),
});

// Query string for GET /reminders. Query values always arrive as text,
// so z.coerce.number() turns "2" into 2.
const listRemindersSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  status: z.enum(Object.values(STATUS)).optional(),
  from: dateWithTimezone.optional(),
  to: dateWithTimezone.optional(),
  search: z.string().trim().optional(),
  sortBy: z.enum(['dueAt', 'createdAt', 'title']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

const listNotificationsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  unread: z.enum(['true', 'false']).optional(),
});

module.exports = {
  createReminderSchema,
  updateReminderSchema,
  listRemindersSchema,
  listNotificationsSchema,
};
