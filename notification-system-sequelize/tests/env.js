// Runs before every test file (before any app code is loaded).
// Keeps tests independent of your .env file.
process.env.NODE_ENV = 'test';
process.env.MAX_ATTEMPTS = '3';
process.env.SIMULATED_FAILURE_RATE = '0';

// Tests use a SEPARATE database, so they never touch your real data.
// It is created automatically. Change it here if your password/port is different.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5433/notification_system_sequelize_test';
