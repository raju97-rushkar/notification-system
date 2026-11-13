const express = require('express');
const { query } = require('../config/db');
const checkUser = require('../middlewares/checkUser');
const reminderRoutes = require('./reminder.routes');
const notificationRoutes = require('./notification.routes');

const router = express.Router();

// Health check: is the server running and connected to the database?
router.get('/health', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ server: 'ok', database: 'connected' });
  } catch {
    res.status(503).json({ server: 'ok', database: 'disconnected' });
  }
});

// Every reminder/notification route needs the x-user-id header
router.use('/reminders', checkUser, reminderRoutes);
router.use('/notifications', checkUser, notificationRoutes);

module.exports = router;
