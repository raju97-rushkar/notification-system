const {
  createReminderSchema,
  updateReminderSchema,
  listRemindersSchema,
  idParamsSchema,
} = require('../validators/reminder.validator');
const controller = require('../controllers/reminder.controller');

// Each route declares its schemas. Fastify validates (and transforms) the
// request with them BEFORE the handler runs, see plugins/validation.js.
async function reminderRoutes(app) {
  const byId = { params: idParamsSchema };

  app.post('/', { schema: { body: createReminderSchema } }, controller.createReminder);
  app.get('/', { schema: { querystring: listRemindersSchema } }, controller.getReminders);
  app.get('/:id', { schema: byId }, controller.getReminderById);
  app.patch('/:id', { schema: { ...byId, body: updateReminderSchema } }, controller.updateReminder);
  app.post('/:id/cancel', { schema: byId }, controller.cancelReminder);
  app.post('/:id/retry', { schema: byId }, controller.retryReminder);
  app.get('/:id/attempts', { schema: byId }, controller.getFailedAttempts);
}

module.exports = reminderRoutes;
