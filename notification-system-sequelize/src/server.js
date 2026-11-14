// Entry point: npm start / npm run dev

// Load the .env file into process.env. This MUST be the first line,
// so every file required below can already read process.env values
// (config/database.js reads DATABASE_URL as soon as it is loaded).
require('dotenv').config({ quiet: true });

const { connectDB, disconnectDB } = require('./config/database');
const { createApp } = require('./app');
const { startReminderJob } = require('./jobs/reminder.job');

// 3002, so it can run next to the MongoDB (3000) and raw-SQL (3001) projects
const PORT = Number(process.env.PORT) || 3002;
// false = don't run the worker here (run it separately with `npm run worker`)
const RUN_WORKER = process.env.RUN_WORKER !== 'false';

async function start() {
  // 1. Connect to PostgreSQL and create the tables (nothing works without it)
  await connectDB();

  // 2. Start the API
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  // 3. Start the background worker (unless it runs as a separate process)
  let job = null;
  if (RUN_WORKER) {
    job = startReminderJob();
  }

  // 4. Ctrl+C (SIGINT) or Docker/PM2 stop (SIGTERM): stop the worker and close
  //    the DB connections cleanly. A reminder that was mid-processing is picked
  //    up again by crash recovery once its lock expires.
  const shutdown = async () => {
    console.log('Shutting down...');
    if (job) await job.stop();
    await disconnectDB();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

start().catch((error) => {
  console.error('Failed to start:', error.message);
  process.exit(1);
});
