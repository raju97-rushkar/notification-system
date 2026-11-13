const notificationService = require('../services/notification.service');

async function getNotifications(req, res) {
  const result = await notificationService.getNotifications(req.userId, req.validated);
  res.json(result);
}

async function markAsRead(req, res) {
  const notification = await notificationService.markAsRead(req.userId, req.params.id);
  res.json(notification);
}

module.exports = { getNotifications, markAsRead };
