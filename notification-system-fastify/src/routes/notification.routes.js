const { listNotificationsSchema, idParamsSchema } = require('../validators/reminder.validator');
const controller = require('../controllers/notification.controller');

async function notificationRoutes(app) {
  app.get('/', { schema: { querystring: listNotificationsSchema } }, controller.getNotifications);
  app.patch('/:id/read', { schema: { params: idParamsSchema } }, controller.markAsRead);
}

module.exports = notificationRoutes;
