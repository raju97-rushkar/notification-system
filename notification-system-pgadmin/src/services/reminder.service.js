const { query } = require('../config/db');
const { STATUS, toReminder } = require('../models/reminder.model');
const { toFailedAttempt } = require('../models/failedAttempt.model');
const AppError = require('../utils/AppError');

// API sort names -> database column names. Only these are allowed, so the
// user can never put their own text into ORDER BY (SQL injection).
const SORT_COLUMNS = { dueAt: 'due_at', createdAt: 'created_at', title: 'title' };

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

  // next_run_at = due_at ($4 is used twice): the worker picks it up at dueAt
  const result = await query(
    `INSERT INTO reminders (user_id, title, message, due_at, timezone, next_run_at, max_attempts)
     VALUES ($1, $2, $3, $4, $5, $4, $6)
     RETURNING *`,
    [
      userId,
      data.title,
      data.message || '',
      data.dueAt,
      data.timezone || 'UTC',
      Number(process.env.MAX_ATTEMPTS) || 3, // from .env, default 3
    ]
  );
  return toReminder(result.rows[0]);
}

async function getReminders(userId, filters) {
  const { page, limit, status, from, to, search, sortBy, order } = filters;

  // 1. Build the WHERE part step by step. Always filter by user_id:
  //    a user only sees their own reminders.
  const conditions = ['user_id = $1'];
  const values = [userId];

  // Adds a condition like "status = $2" and its value
  function addCondition(column, operator, value) {
    values.push(value);
    conditions.push(`${column} ${operator} $${values.length}`);
  }

  if (status) addCondition('status', '=', status);
  if (from) addCondition('due_at', '>=', from);
  if (to) addCondition('due_at', '<=', to);
  if (search) addCondition('title', 'ILIKE', `%${escapeLike(search)}%`); // ILIKE = case-insensitive

  const where = conditions.join(' AND ');

  // 2. Sort. id is added as a tie-breaker so pages never show the same row twice.
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  const orderBy = `${SORT_COLUMNS[sortBy]} ${direction}, id ${direction}`;

  // 3. Run both queries at the same time (faster than one after another)
  const offset = (page - 1) * limit;
  const [rowsResult, countResult] = await Promise.all([
    query(
      `SELECT * FROM reminders WHERE ${where} ORDER BY ${orderBy}
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    ),
    query(`SELECT COUNT(*)::int AS total FROM reminders WHERE ${where}`, values),
  ]);

  const total = countResult.rows[0].total;
  return {
    data: rowsResult.rows.map(toReminder),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

async function getReminderById(userId, id) {
  const result = await query('SELECT * FROM reminders WHERE id = $1 AND user_id = $2', [id, userId]);
  if (result.rowCount === 0) throw new AppError(404, 'Reminder not found');
  return toReminder(result.rows[0]);
}

async function updateReminder(userId, id, data) {
  if (data.dueAt) checkDateIsInFuture(data.dueAt);

  // Build "SET title = $1, due_at = $2, ..." only for the fields that were sent
  const columns = { title: 'title', message: 'message', dueAt: 'due_at', timezone: 'timezone' };
  const sets = [];
  const values = [];
  for (const [field, column] of Object.entries(columns)) {
    if (data[field] !== undefined) {
      values.push(data[field]);
      sets.push(`${column} = $${values.length}`);
    }
  }
  if (sets.length === 0) throw new AppError(400, 'Nothing to update');

  if (data.dueAt) {
    values.push(data.dueAt);
    sets.push(`next_run_at = $${values.length}`); // rescheduled: worker uses the new time
  }

  values.push(id, userId);

  // IMPORTANT: "status = 'pending'" is part of the WHERE.
  // If the worker has already started processing this reminder, no row
  // matches and we return 409. Check + update happen in ONE statement,
  // so there is no race condition with the worker.
  const result = await query(
    `UPDATE reminders SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $${values.length - 1} AND user_id = $${values.length} AND status = 'pending'
     RETURNING *`,
    values
  );

  if (result.rowCount === 0) await throwNotFoundOrConflict(userId, id, 'update');
  return toReminder(result.rows[0]);
}

async function cancelReminder(userId, id) {
  // Same idea as update: only a pending reminder can be cancelled.
  const result = await query(
    `UPDATE reminders SET status = $3, updated_at = now()
     WHERE id = $1 AND user_id = $2 AND status = 'pending'
     RETURNING *`,
    [id, userId, STATUS.CANCELLED]
  );

  if (result.rowCount === 0) await throwNotFoundOrConflict(userId, id, 'cancel');
  return toReminder(result.rows[0]);
}

// Try a "failed" reminder again (manual retry by the user)
async function retryReminder(userId, id) {
  const result = await query(
    `UPDATE reminders
     SET status = 'pending', next_run_at = now(), attempts = 0, last_error = NULL, updated_at = now()
     WHERE id = $1 AND user_id = $2 AND status = 'failed'
     RETURNING *`,
    [id, userId]
  );

  if (result.rowCount === 0) await throwNotFoundOrConflict(userId, id, 'retry');
  return toReminder(result.rows[0]);
}

async function getFailedAttempts(userId, id) {
  await getReminderById(userId, id); // makes sure the reminder belongs to this user
  const result = await query(
    'SELECT * FROM failed_attempts WHERE reminder_id = $1 ORDER BY created_at DESC',
    [id]
  );
  return result.rows.map(toFailedAttempt);
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
