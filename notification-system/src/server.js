// Entry point: npm start / npm run dev

// Load the .env file into process.env. This MUST be the first line,
// so every file required below can already read process.env values.
require('dotenv').config({ quiet: true });

const { connectDB, disconnectDB } = require('./config/db');
const { createApp } = require('./app');
const { startReminderJob } = require('./jobs/reminder.job');

const PORT = Number(process.env.PORT) || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/notification_system';
// false = don't run the worker here (run it separately with `npm run worker`)
const RUN_WORKER = process.env.RUN_WORKER !== 'false';

async function start() {
  // 1. Connect to MongoDB first (nothing works without it)
  await connectDB(MONGO_URI);

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

  // 4. Ctrl+C: stop the worker and close the DB connection cleanly
  process.on('SIGINT', async () => {
    console.log('Shutting down...');
    if (job) await job.stop();
    await disconnectDB();
    process.exit(0);
  });
}

start().catch((error) => {
  console.error('Failed to start:', error.message);
  process.exit(1);
});
