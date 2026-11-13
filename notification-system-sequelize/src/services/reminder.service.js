const { Op } = require('sequelize');
const { Reminder, FailedAttempt, STATUS } = require('../models');
const AppError = require('../utils/AppError');

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

  // 2. findAndCountAll = the page of rows + the total count, in one call.
  //    "id" is a tie-breaker so pages never show the same row twice.
  //    sortBy/order are already checked by zod (only allowed values reach here).
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  const { rows, count } = await Reminder.findAndCountAll({
    where,
    order: [
      [sortBy, direction],
      ['id', direction],
    ],
    limit,
    offset: (page - 1) * limit,
  });

  return {
    data: rows,
    pagination: { page, limit, total: count, totalPages: Math.ceil(count / limit) },
  };
}

async function getReminderById(userId, id) {
  const reminder = await Reminder.findOne({ where: { id, userId } });
  if (!reminder) throw new AppError(404, 'Reminder not found');
  return reminder;
}

async function updateReminder(userId, id, data) {
  if (Object.keys(data).length === 0) throw new AppError(400, 'Nothing to update');

  const changes = { ...data };
  if (data.dueAt) {
    checkDateIsInFuture(data.dueAt);
    changes.nextRunAt = data.dueAt; // rescheduled: worker uses the new time
  }

  // IMPORTANT: "status: pending" is part of the WHERE.
  // Sequelize turns this into ONE SQL statement:
  //   UPDATE reminders SET ... WHERE id = ? AND user_id = ? AND status = 'pending'
  // If the worker has already started processing this reminder, no row
  // matches and we return 409. No race condition with the worker.
  const [updatedCount, rows] = await Reminder.update(changes, {
    where: { id, userId, status: STATUS.PENDING },
    returning: true, // PostgreSQL gives back the updated rows
  });

  if (updatedCount === 0) await throwNotFoundOrConflict(userId, id, 'update');
  return rows[0];
}

async function cancelReminder(userId, id) {
  // Same idea as update: only a pending reminder can be cancelled.
  const [updatedCount, rows] = await Reminder.update(
    { status: STATUS.CANCELLED },
    { where: { id, userId, status: STATUS.PENDING }, returning: true }
  );

  if (updatedCount === 0) await throwNotFoundOrConflict(userId, id, 'cancel');
  return rows[0];
}

// Try a "failed" reminder again (manual retry by the user)
async function retryReminder(userId, id) {
  const [updatedCount, rows] = await Reminder.update(
    { status: STATUS.PENDING, nextRunAt: new Date(), attempts: 0, lastError: null },
    { where: { id, userId, status: STATUS.FAILED }, returning: true }
  );

  if (updatedCount === 0) await throwNotFoundOrConflict(userId, id, 'retry');
  return rows[0];
}

async function getFailedAttempts(userId, id) {
  await getReminderById(userId, id); // makes sure the reminder belongs to this user
  return FailedAttempt.findAll({ where: { reminderId: id }, order: [['createdAt', 'DESC']] });
}

// When an update changes no row, tell the client WHY:
// 404 = reminder doesn't exist, 409 = it exists but its status doesn't allow this action
async function throwNotFoundOrConflict(userId, id, action) {
  const reminder = await getReminderById(userId, id); // throws 404 if missing
  throw new AppError(409, `Cannot ${action} a reminder with status "${reminder.status}"`);
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
