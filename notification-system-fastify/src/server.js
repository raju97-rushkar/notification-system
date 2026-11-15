// Entry point: npm start / npm run dev

// Load the .env file into process.env. This MUST be the first line,
// so every file required below can already read process.env values
// (config/database.js reads DATABASE_URL as soon as it is loaded).
require('dotenv').config({ quiet: true });

const { buildApp } = require('./app');

// 3003, so it can run next to the other versions (3000, 3001, 3002)
const PORT = Number(process.env.PORT) || 3003;
const HOST = process.env.HOST || 'localhost'; // use 0.0.0.0 inside Docker
// false = don't run the worker here (run it separately with `npm run worker`)
const RUN_WORKER = process.env.RUN_WORKER !== 'false';

const app = buildApp({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  worker: RUN_WORKER,
});

// Ctrl+C (SIGINT) or Docker/PM2 stop (SIGTERM).
// app.close() runs the plugins' close hooks in the right order:
// stop the worker (preClose) -> stop accepting requests -> close the DB pool (onClose).
// A reminder that was mid-processing is picked up again by crash recovery.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    app.log.info(`${signal} received, shutting down...`);
    await app.close();
    process.exit(0);
  });
}

// listen() first loads all plugins (connects to PostgreSQL, creates tables),
// then opens the port.
app.listen({ port: PORT, host: HOST }).catch((error) => {
  app.log.error(error, 'Failed to start');
  process.exit(1);
});
