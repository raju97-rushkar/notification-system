// The worker as a Fastify PLUGIN: it starts with the app and stops on app.close().
// (Separate file: closing this app closes the shared DB pool.)
const { buildApp } = require('../src/app');
const { Notification } = require('../src/models');
const { clearDB, insertReminder } = require('./helpers/db');

async function waitFor(check, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!(await check()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

it('starts on app.ready(), processes due reminders, stops on app.close()', async () => {
  // worker: true + api: false is exactly what `npm run worker` builds
  const app = buildApp({ worker: true, api: false });
  await app.ready(); // database plugin connects -> worker plugin starts the cron job
  await clearDB();

  await insertReminder({ title: 'A' });
  await insertReminder({ title: 'B' });
  await waitFor(async () => (await Notification.count()) === 2); // cron runs every 5s

  expect(await Notification.count()).toBe(2);
  expect(app.hasRoute({ method: 'GET', url: '/api/health' })).toBe(false); // no HTTP routes

  await clearDB();
  // preClose stops the cron job, then onClose closes the pool. If the job were
  // still running it would now crash on a closed pool and fail the test run.
  await app.close();
});
