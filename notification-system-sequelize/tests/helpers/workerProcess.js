// A real, separate worker PROCESS used by multiprocess.test.js.
// It has its own Sequelize connection pool, like `npm run worker` would.
// The DATABASE_URL (test database) is inherited from the test process.
//
// Protocol: sends "ready" -> waits for "go" -> processes until nothing is due
// -> sends its totals -> exits.

// Safety: never run against a real database by accident
if (process.env.NODE_ENV !== 'test' || !/_test$/.test(new URL(process.env.DATABASE_URL || 'x:/').pathname)) {
  console.error('workerProcess.js only runs against a *_test database');
  process.exit(1);
}

const { sequelize } = require('../../src/config/database');
require('../../src/models');
const { runWorkerOnce } = require('../../src/jobs/reminder.job');

const workerId = process.argv[2];

process.on('message', async (message) => {
  if (message !== 'go') return;
  const totals = { completed: 0, failed: 0 };
  try {
    for (;;) {
      const result = await runWorkerOnce(workerId);
      totals.completed += result.completed;
      totals.failed += result.failed;
      if (result.completed + result.failed === 0) break; // nothing left
    }
    process.send({ workerId, ...totals });
  } catch (error) {
    process.send({ workerId, error: error.message });
  } finally {
    await sequelize.close();
    process.disconnect();
  }
});

sequelize.authenticate().then(() => process.send('ready'));
