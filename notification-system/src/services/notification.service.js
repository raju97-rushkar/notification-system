const { Notification } = require('../models/notification.model');
const AppError = require('../utils/AppError');

const DUPLICATE_KEY_ERROR = 11000;

// Creates the notification for a reminder.
// SAFE TO CALL MANY TIMES: there is a unique index on reminderId, so a second
// call fails with error 11000. We treat that as "already created", not as an
// error, which is why retries never create duplicate notifications.
async function createNotification(reminder) {
  try {
    return await Notification.create({
      reminderId: reminder._id,
      userId: reminder.userId,
      title: reminder.title,
      message: reminder.message,
      scheduledFor: reminder.dueAt,
      delayMs: Math.max(0, Date.now() - reminder.dueAt.getTime()),
    });
  } catch (error) {
    if (error.code === DUPLICATE_KEY_ERROR) {
      return null; // already exists, nothing to do
    }
    throw error;
  }
}

async function getNotifications(userId, query) {
  const { page, limit, unread } = query;

  const filter = { userId };
  if (unread === 'true') filter.readAt = null;
  if (unread === 'false') filter.readAt = { $ne: null };

  const [notifications, total] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Notification.countDocuments(filter),
  ]);

  return {
    data: notifications,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

async function markAsRead(userId, id) {
  const notification = await Notification.findOne({ _id: id, userId });
  if (!notification) throw new AppError(404, 'Notification not found');

  // Only set readAt the first time
  if (!notification.readAt) {
    notification.readAt = new Date();
    await notification.save();
  }
  return notification;
}

module.exports = { createNotification, getNotifications, markAsRead };
