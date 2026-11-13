const express = require('express');
const validate = require('../middlewares/validate');
const {
  createReminderSchema,
  updateReminderSchema,
  listRemindersSchema,
} = require('../validators/reminder.validator');
const controller = require('../controllers/reminder.controller');

const router = express.Router();

router.post('/', validate(createReminderSchema), controller.createReminder);
router.get('/', validate(listRemindersSchema, 'query'), controller.getReminders);
router.get('/:id', controller.getReminderById);
router.patch('/:id', validate(updateReminderSchema), controller.updateReminder);
router.post('/:id/cancel', controller.cancelReminder);
router.post('/:id/retry', controller.retryReminder);
router.get('/:id/attempts', controller.getFailedAttempts);

module.exports = router;
