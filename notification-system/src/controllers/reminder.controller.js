const reminderService = require('../services/reminder.service');

// Controllers only read the request, call the service, and send the response.
// All the logic lives in the service.

async function createReminder(req, res) {
  const reminder = await reminderService.createReminder(req.userId, req.validated);
  res.status(201).json(reminder);
}

async function getReminders(req, res) {
  const result = await reminderService.getReminders(req.userId, req.validated);
  res.json(result);
}

async function getReminderById(req, res) {
  const reminder = await reminderService.getReminderById(req.userId, req.params.id);
  res.json(reminder);
}

async function updateReminder(req, res) {
  const reminder = await reminderService.updateReminder(req.userId, req.params.id, req.validated);
  res.json(reminder);
}

async function cancelReminder(req, res) {
  const reminder = await reminderService.cancelReminder(req.userId, req.params.id);
  res.json(reminder);
}

async function retryReminder(req, res) {
  const reminder = await reminderService.retryReminder(req.userId, req.params.id);
  res.json(reminder);
}

async function getFailedAttempts(req, res) {
  const attempts = await reminderService.getFailedAttempts(req.userId, req.params.id);
  res.json(attempts);
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
