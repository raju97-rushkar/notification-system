// Runs ONLY the background worker, without the HTTP API: npm run worker
// Useful to run several workers (set RUN_WORKER=false for the API in that case).
//
// It reuses the same Fastify plugins (database + worker), just without routes
// and without opening a port. That gives the same logger and clean shutdown.

// Load .env first, so the files below can read process.env values
require('dotenv').config({ quiet: true });

const { buildApp } = require('./app');

const app = buildApp({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  worker: true,
  api: false,
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    app.log.info(`${signal} received, stopping worker...`);
    await app.close();
    process.exit(0);
  });
}

// ready() loads the plugins: connect to PostgreSQL, then start the cron job
app.ready().catch((error) => {
  app.log.error(error, 'Failed to start worker');
  process.exit(1);
});
