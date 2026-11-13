const { Reminder, STATUS } = require('../models/reminder.model');
const { FailedAttempt } = require('../models/failedAttempt.model');
const AppError = require('../utils/AppError');

// Makes user text safe to use inside a regex (".*" becomes "\.\*")
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    message: data.message,
    dueAt: data.dueAt,
    timezone: data.timezone || 'UTC',
    nextRunAt: data.dueAt, // the worker picks it up at dueAt
    maxAttempts: Number(process.env.MAX_ATTEMPTS) || 3, // from .env, default 3
  });
}

async function getReminders(userId, query) {
  const { page, limit, status, from, to, search, sortBy, order } = query;

  // 1. Build the filter. Always filter by userId: a user only sees their own reminders.
  const filter = { userId };
  if (status) filter.status = status;
  if (from || to) {
    filter.dueAt = {};
    if (from) filter.dueAt.$gte = from;
    if (to) filter.dueAt.$lte = to;
  }
  if (search) filter.title = { $regex: escapeRegex(search), $options: 'i' };

  // 2. Sort. _id is added as a tie-breaker so pages never show the same item twice.
  const direction = order === 'asc' ? 1 : -1;
  const sort = { [sortBy]: direction, _id: direction };

  // 3. Run both queries at the same time (faster than one after another)
  const [reminders, total] = await Promise.all([
    Reminder.find(filter).sort(sort).skip((page - 1) * limit).limit(limit),
    Reminder.countDocuments(filter),
  ]);

  return {
    data: reminders,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

async function getReminderById(userId, id) {
  const reminder = await Reminder.findOne({ _id: id, userId });
  if (!reminder) throw new AppError(404, 'Reminder not found');
  return reminder;
}

async function updateReminder(userId, id, data) {
  const changes = { ...data };
  if (data.dueAt) {
    checkDateIsInFuture(data.dueAt);
    changes.nextRunAt = data.dueAt; // rescheduled: worker should use the new time
  }

  // IMPORTANT: "status: pending" is part of the filter.
  // If the worker has already started processing this reminder, nothing
  // matches and we return 409. Check + update happen in ONE atomic step,
  // so there is no race condition with the worker.
  const reminder = await Reminder.findOneAndUpdate(
    { _id: id, userId, status: STATUS.PENDING },
    { $set: changes },
    { returnDocument: 'after' }
  );

  if (!reminder) await throwNotFoundOrConflict(userId, id, 'update');
  return reminder;
}

async function cancelReminder(userId, id) {
  // Same idea as update: only a pending reminder can be cancelled.
  const reminder = await Reminder.findOneAndUpdate(
    { _id: id, userId, status: STATUS.PENDING },
    { $set: { status: STATUS.CANCELLED } },
    { returnDocument: 'after' }
  );

  if (!reminder) await throwNotFoundOrConflict(userId, id, 'cancel');
  return reminder;
}

// Try a "failed" reminder again (manual retry by the user)
async function retryReminder(userId, id) {
  const reminder = await Reminder.findOneAndUpdate(
    { _id: id, userId, status: STATUS.FAILED },
    { $set: { status: STATUS.PENDING, nextRunAt: new Date(), attempts: 0, lastError: null } },
    { returnDocument: 'after' }
  );

  if (!reminder) await throwNotFoundOrConflict(userId, id, 'retry');
  return reminder;
}

async function getFailedAttempts(userId, id) {
  await getReminderById(userId, id); // makes sure the reminder belongs to this user
  return FailedAttempt.find({ reminderId: id }).sort({ createdAt: -1 });
}

// When an update finds nothing, tell the client WHY:
// 404 = reminder doesn't exist, 409 = it exists but its status doesn't allow this action
async function throwNotFoundOrConflict(userId, id, action) {
  const reminder = await Reminder.findOne({ _id: id, userId });
  if (!reminder) throw new AppError(404, 'Reminder not found');
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
