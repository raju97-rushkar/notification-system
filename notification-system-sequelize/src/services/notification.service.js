const { Op } = require('sequelize');
const { Notification } = require('../models');
const AppError = require('../utils/AppError');

// Creates the notification for a reminder, inside the worker's transaction.
//
// SAFE TO CALL MANY TIMES: reminderId is UNIQUE.
// ignoreDuplicates: true -> Sequelize writes "INSERT ... ON CONFLICT DO NOTHING".
// If a notification for this reminder already exists, nothing is inserted and
// NO error is thrown. (A normal create() would throw a unique error, and in
// PostgreSQL any error inside a transaction cancels the whole transaction.)
async function createNotification(reminder, transaction) {
  await Notification.bulkCreate(
    [
      {
        reminderId: reminder.id,
        userId: reminder.userId,
        title: reminder.title,
        message: reminder.message,
        scheduledFor: reminder.dueAt,
        delayMs: Math.max(0, Date.now() - reminder.dueAt.getTime()),
      },
    ],
    { ignoreDuplicates: true, transaction }
  );
}

async function getNotifications(userId, filters) {
  const { page, limit, unread } = filters;

  const where = { userId };
  if (unread === 'true') where.readAt = null; // IS NULL
  if (unread === 'false') where.readAt = { [Op.ne]: null }; // IS NOT NULL

  const { rows, count } = await Notification.findAndCountAll({
    where,
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit,
    offset: (page - 1) * limit,
  });

  return {
    data: rows,
    pagination: { page, limit, total: count, totalPages: Math.ceil(count / limit) },
  };
}

async function markAsRead(userId, id) {
  const notification = await Notification.findOne({ where: { id, userId } });
  if (!notification) throw new AppError(404, 'Notification not found');

  // Only set readAt the first time
  if (!notification.readAt) {
    await notification.update({ readAt: new Date() });
  }
  return notification;
}

module.exports = { createNotification, getNotifications, markAsRead };
