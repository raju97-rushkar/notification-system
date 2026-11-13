const express = require('express');
const mongoose = require('mongoose');
const checkUser = require('../middlewares/checkUser');
const reminderRoutes = require('./reminder.routes');
const notificationRoutes = require('./notification.routes');

const router = express.Router();

// Health check: is the server running and connected to the database?
router.get('/health', (req, res) => {
  const dbConnected = mongoose.connection.readyState === 1;
  res.status(dbConnected ? 200 : 503).json({ server: 'ok', database: dbConnected ? 'connected' : 'disconnected' });
});

// Every reminder/notification route needs the x-user-id header
router.use('/reminders', checkUser, reminderRoutes);
router.use('/notifications', checkUser, notificationRoutes);

module.exports = router;
