const { query } = require('../config/db');
const { toNotification } = require('../models/notification.model');
const AppError = require('../utils/AppError');

// Creates the notification for a reminder.
// SAFE TO CALL MANY TIMES: reminder_id is UNIQUE in the table.
// "ON CONFLICT DO NOTHING" means: if a notification for this reminder already
// exists, insert nothing and don't throw an error. That's why retries never
// create duplicate notifications.
// Returns the new notification, or null if it already existed.
async function createNotification(reminder) {
  const delayMs = Math.max(0, Date.now() - reminder.dueAt.getTime());

  const result = await query(
    `INSERT INTO notifications (reminder_id, user_id, title, message, scheduled_for, delay_ms)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (reminder_id) DO NOTHING
     RETURNING *`,
    [reminder.id, reminder.userId, reminder.title, reminder.message, reminder.dueAt, delayMs]
  );
  return toNotification(result.rows[0]);
}

async function getNotifications(userId, filters) {
  const { page, limit, unread } = filters;

  let where = 'user_id = $1';
  if (unread === 'true') where += ' AND read_at IS NULL';
  if (unread === 'false') where += ' AND read_at IS NOT NULL';

  const [rowsResult, countResult] = await Promise.all([
    query(
      `SELECT * FROM notifications WHERE ${where}
       ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [userId, limit, (page - 1) * limit]
    ),
    query(`SELECT COUNT(*)::int AS total FROM notifications WHERE ${where}`, [userId]),
  ]);

  const total = countResult.rows[0].total;
  return {
    data: rowsResult.rows.map(toNotification),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

async function markAsRead(userId, id) {
  // COALESCE(read_at, now()) keeps the first read time if it was already read
  const result = await query(
    `UPDATE notifications SET read_at = COALESCE(read_at, now()), updated_at = now()
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [id, userId]
  );
  if (result.rowCount === 0) throw new AppError(404, 'Notification not found');
  return toNotification(result.rows[0]);
}

module.exports = { createNotification, getNotifications, markAsRead };
