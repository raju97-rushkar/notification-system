const { connectDB, disconnectDB, query } = require('../../src/config/db');

// Tests run on a real PostgreSQL, but in a separate test database
// ("notification_system_test"), so your real data is never touched.
// Real PostgreSQL matters: UNIQUE, ON CONFLICT and SKIP LOCKED are
// exactly what we want to test.

async function startDB() {
  await connectDB(process.env.TEST_DATABASE_URL);
}

// Empty all tables between tests
async function clearDB() {
  await query('TRUNCATE notifications, failed_attempts, reminders');
}

async function stopDB() {
  await disconnectDB();
}

// Insert a reminder row directly (to prepare test data quickly).
// Example: insertReminder({ title: 'Old', dueAt: twoHoursAgo, status: 'cancelled' })
async function insertReminder({
  userId = 'user1',
  title = 'Test reminder',
  dueAt = new Date(Date.now() - 1000), // already due
  status = 'pending',
  maxAttempts = 3,
} = {}) {
  const result = await query(
    `INSERT INTO reminders (user_id, title, due_at, next_run_at, status, max_attempts)
     VALUES ($1, $2, $3, $3, $4, $5)
     RETURNING *`,
    [userId, title, dueAt, status, maxAttempts]
  );
  return result.rows[0];
}

// Read one reminder row (snake_case columns)
async function getReminderRow(id) {
  const result = await query('SELECT * FROM reminders WHERE id = $1', [id]);
  return result.rows[0];
}

// Count rows in a table, optionally with a WHERE condition
async function countRows(table, where = 'TRUE', params = []) {
  const result = await query(`SELECT COUNT(*)::int AS count FROM ${table} WHERE ${where}`, params);
  return result.rows[0].count;
}

module.exports = { startDB, clearDB, stopDB, insertReminder, getReminderRow, countRows, query };
