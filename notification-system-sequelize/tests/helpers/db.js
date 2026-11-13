const { sequelize, connectDB, disconnectDB } = require('../../src/config/database');
const { Reminder } = require('../../src/models');

// Tests run on a real PostgreSQL, in a separate test database, so your real
// data is never touched. Real PostgreSQL matters: UNIQUE, ON CONFLICT,
// transactions and SKIP LOCKED are exactly what we want to test.

async function startDB() {
  await connectDB();
}

// Empty all tables between tests
async function clearDB() {
  await sequelize.query('TRUNCATE notifications, failed_attempts, reminders');
}

async function stopDB() {
  await disconnectDB();
}

// Insert a reminder directly (to prepare test data quickly)
// Example: insertReminder({ title: 'Old', dueAt: twoHoursAgo, status: 'cancelled' })
async function insertReminder({
  userId = 'user1',
  title = 'Test reminder',
  dueAt = new Date(Date.now() - 1000), // already due
  status = 'pending',
  maxAttempts = 3,
} = {}) {
  return Reminder.create({ userId, title, dueAt, nextRunAt: dueAt, status, maxAttempts });
}

module.exports = { startDB, clearDB, stopDB, insertReminder };
