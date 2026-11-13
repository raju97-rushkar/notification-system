// Runs ONLY the background worker, without the API: npm run worker
// Useful to run several workers (set RUN_WORKER=false for the API in that case).

// Load .env first, so the files below can read process.env values
require('dotenv').config({ quiet: true });

const { connectDB, disconnectDB } = require('./config/database');
const { startReminderJob } = require('./jobs/reminder.job');

async function start() {
  await connectDB();
  const job = startReminderJob();

  process.on('SIGINT', async () => {
    console.log('Stopping worker...');
    await job.stop();
    await disconnectDB();
    process.exit(0);
  });
}

start().catch((error) => {
  console.error('Failed to start worker:', error.message);
  process.exit(1);
});
