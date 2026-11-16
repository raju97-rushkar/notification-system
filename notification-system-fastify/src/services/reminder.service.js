const { Op } = require('sequelize');
const { Reminder, FailedAttempt, STATUS } = require('../models');
const AppError = require('../utils/AppError');
const { paginate } = require('../utils/paginate');

// In LIKE, "%" and "_" are wildcards. Escape them so a search for "50%" works.
function escapeLike(text) {
  return text.replace(/[\\%_]/g, '\\$&');
}

function checkDateIsInFuture(date) {
  const oneMinuteAgo = Date.now() - 60 * 1000; // small allowance for clock differences
  if (date.getTime() < oneMinuteAgo) {
    throw new AppError(400, 'dueAt must be in the future');
  }
}

async function createReminder(userId, data) {
  checkDateIsInFuture(data.dueAt);

  return Reminder.create({
    userId,
    title: data.title,
    message: data.message || '',
    dueAt: data.dueAt,
    timezone: data.timezone || 'UTC',
    nextRunAt: data.dueAt, // the worker picks it up at dueAt
    maxAttempts: Number(process.env.MAX_ATTEMPTS) || 3,
  });
}

async function getReminders(userId, filters) {
  const { page, limit, status, from, to, search, sortBy, order } = filters;

  // 1. Build the WHERE object. Always filter by userId:
  //    a user only sees their own reminders.
  const where = { userId };
  if (status) where.status = status;
  if (from || to) {
    where.dueAt = {};
    if (from) where.dueAt[Op.gte] = from; // >=
    if (to) where.dueAt[Op.lte] = to; // <=
  }
  if (search) where.title = { [Op.iLike]: `%${escapeLike(search)}%` }; // case-insensitive

  // 2. "id" is a tie-breaker so pages never show the same row twice.
  //    sortBy/order are already checked by zod (only allowed values reach here).
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  return paginate(Reminder, {
    where,
    order: [
      [sortBy, direction],
      ['id', direction],
    ],
    page,
    limit,
  });
}

async function getReminderById(userId, id) {
  const reminder = await Reminder.findOne({ where: { id, userId } });
  if (!reminder) throw new AppError(404, 'Reminder not found');
  return reminder;
}

// Shared by update, cancel and retry: change a reminder ONLY if it is still
// in the status that allows this action.
//
// The status is part of the WHERE, so Sequelize runs ONE SQL statement:
//   UPDATE reminders SET ... WHERE id = ? AND user_id = ? AND status = 'pending'
// If the worker has already started processing the reminder, no row matches.
// No race condition with the worker.
//
// No row changed -> tell the client WHY:
//   404 = the reminder doesn't exist (or belongs to someone else)
//   409 = it exists, but its status doesn't allow this action
async function updateIfStatus(userId, id, { allowedStatus, changes, action }) {
  const [updatedCount, rows] = await Reminder.update(changes, {
    where: { id, userId, status: allowedStatus },
    returning: true, // PostgreSQL gives back the updated row
  });
  if (updatedCount > 0) return rows[0];

  const reminder = await getReminderById(userId, id); // throws 404 if missing
  throw new AppError(409, `Cannot ${action} a reminder with status "${reminder.status}"`);
}

async function updateReminder(userId, id, data) {
  if (Object.keys(data).length === 0) throw new AppError(400, 'Nothing to update');

  const changes = { ...data };
  if (data.dueAt) {
    checkDateIsInFuture(data.dueAt);
    changes.nextRunAt = data.dueAt; // rescheduled: worker uses the new time
  }

  return updateIfStatus(userId, id, { allowedStatus: STATUS.PENDING, changes, action: 'update' });
}

async function cancelReminder(userId, id) {
  return updateIfStatus(userId, id, {
    allowedStatus: STATUS.PENDING,
    changes: { status: STATUS.CANCELLED },
    action: 'cancel',
  });
}

// Try a "failed" reminder again (manual retry by the user)
async function retryReminder(userId, id) {
  return updateIfStatus(userId, id, {
    allowedStatus: STATUS.FAILED,
    changes: { status: STATUS.PENDING, nextRunAt: new Date(), attempts: 0, lastError: null },
    action: 'retry',
  });
}

async function getFailedAttempts(userId, id) {
  await getReminderById(userId, id); // makes sure the reminder belongs to this user
  return FailedAttempt.findAll({ where: { reminderId: id }, order: [['createdAt', 'DESC']] });
}

module.exports = {
  createReminder,
  getReminders,
  getReminderById,
  updateReminder,
  cancelReminder,
  retryReminder,
  getFailedAttempts,
};
