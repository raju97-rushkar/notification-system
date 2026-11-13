const express = require('express');
const validate = require('../middlewares/validate');
const { listNotificationsSchema } = require('../validators/reminder.validator');
const controller = require('../controllers/notification.controller');

const router = express.Router();

router.get('/', validate(listNotificationsSchema, 'query'), controller.getNotifications);
router.patch('/:id/read', controller.markAsRead);

module.exports = router;
