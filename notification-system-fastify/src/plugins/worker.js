const fp = require('fastify-plugin');
const { startReminderJob, runWorkerOnce } = require('../jobs/reminder.job');

// Runs the background reminder worker (node-cron) as part of the Fastify app.
//
//   onReady  -> start the cron job once the DB is connected and routes are loaded
//   preClose -> stop it BEFORE the database plugin closes the connection pool
//
// enabled: false -> the plugin does nothing (API-only process, or tests).
async function workerPlugin(app, opts) {
  // Always available, e.g. to trigger one run by hand in tests or an admin route
  app.decorate('runWorkerOnce', runWorkerOnce);

  if (!opts.enabled) return;

  let task = null;
  app.addHook('onReady', async () => {
    task = startReminderJob(app.log);
  });
  app.addHook('preClose', async () => {
    if (task) await task.stop();
  });
}

module.exports = fp(workerPlugin, { name: 'worker', dependencies: ['database'] });
