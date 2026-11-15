const notificationService = require('../services/notification.service');

async function getNotifications(request) {
  return notificationService.getNotifications(request.userId, request.query);
}

async function markAsRead(request) {
  return notificationService.markAsRead(request.userId, request.params.id);
}

module.exports = { getNotifications, markAsRead };
