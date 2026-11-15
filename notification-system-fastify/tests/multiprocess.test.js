// Duplicate prevention with REAL separate worker processes (not just
// Promise.all inside one process). Each process has its own connection pool,
// exactly like running `npm run worker` several times.
const path = require('path');
const { fork } = require('child_process');
const { Notification, FailedAttempt, Reminder } = require('../src/models');
const { startDB, clearDB, stopDB } = require('./helpers/db');

const WORKER_SCRIPT = path.join(__dirname, 'helpers', 'workerProcess.js');
const PROCESS_COUNT = 4;
const REMINDER_COUNT = 200;

beforeAll(startDB);
afterEach(clearDB);
afterAll(stopDB);

// Starts a worker process and resolves once it is connected and waiting
function startWorkerProcess(workerId) {
  // env must be passed explicitly: Jest gives each test file its own copy of
  // process.env, so the child would otherwise not see the TEST DATABASE_URL.
  const child = fork(WORKER_SCRIPT, [workerId], {
    env: { ...process.env },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const ready = new Promise((resolve, reject) => {
    child.once('message', (m) => (m === 'ready' ? resolve() : reject(new Error(String(m)))));
    child.once('error', reject);
  });
  const result = new Promise((resolve, reject) => {
    child.on('message', (m) => m !== 'ready' && resolve(m));
    child.once('exit', (code) => code !== 0 && reject(new Error(`${workerId} exited with ${code}`)));
  });
  return { child, ready, result };
}

it(`${PROCESS_COUNT} worker processes, ${REMINDER_COUNT} due reminders: exactly 1 notification each`, async () => {
  const dueAt = new Date(Date.now() - 1000);
  await Reminder.bulkCreate(
    Array.from({ length: REMINDER_COUNT }, (_, i) => ({ userId: 'user1', title: `R${i}`, dueAt, nextRunAt: dueAt }))
  );

  const workers = Array.from({ length: PROCESS_COUNT }, (_, i) => startWorkerProcess(`process-${i + 1}`));
  await Promise.all(workers.map((w) => w.ready));

  // Start them all at the same moment
  workers.forEach((w) => w.child.send('go'));
  const results = await Promise.all(workers.map((w) => w.result));

  results.forEach((r) => expect(r.error).toBeUndefined());
  const totalCompleted = results.reduce((sum, r) => sum + r.completed, 0);

  expect(totalCompleted).toBe(REMINDER_COUNT); // nobody processed a reminder twice
  expect(await Notification.count()).toBe(REMINDER_COUNT); // no duplicates in the table
  expect(await Reminder.count({ where: { status: 'completed' } })).toBe(REMINDER_COUNT);
  expect(await FailedAttempt.count()).toBe(0);

  // More than one process actually did work (it was a real race)
  expect(results.filter((r) => r.completed > 0).length).toBeGreaterThan(1);
});
