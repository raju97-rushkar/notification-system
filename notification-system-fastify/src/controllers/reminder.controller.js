const reminderService = require('../services/reminder.service');

// Controllers only read the request, call the service, and return the result.
// All the logic lives in the service.
//
// Fastify handlers are async: whatever they RETURN is sent as JSON (status 200).
// request.body / request.query / request.params are already validated and
// transformed by the route schema (e.g. dueAt is a Date, page is a number).
// request.userId was set by the checkUser hook.

async function createReminder(request, reply) {
  const reminder = await reminderService.createReminder(request.userId, request.body);
  return reply.code(201).send(reminder);
}

async function getReminders(request) {
  return reminderService.getReminders(request.userId, request.query);
}

async function getReminderById(request) {
  return reminderService.getReminderById(request.userId, request.params.id);
}

async function updateReminder(request) {
  return reminderService.updateReminder(request.userId, request.params.id, request.body);
}

async function cancelReminder(request) {
  return reminderService.cancelReminder(request.userId, request.params.id);
}

async function retryReminder(request) {
  return reminderService.retryReminder(request.userId, request.params.id);
}

async function getFailedAttempts(request) {
  return reminderService.getFailedAttempts(request.userId, request.params.id);
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
