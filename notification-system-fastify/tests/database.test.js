// The worker's indexes are partial (see docs/DATABASE.md, "Partial indexes").
const { sequelize } = require('../src/config/database');
const { startDB, stopDB } = require('./helpers/db');

beforeAll(startDB);
afterAll(stopDB);

async function indexDefinition(name) {
  const [row] = await sequelize.query('SELECT indexdef FROM pg_indexes WHERE indexname = :name', {
    replacements: { name },
    type: 'SELECT',
  });
  return row?.indexdef;
}

describe('Worker indexes', () => {
  it('the "due reminders" index only holds pending rows', async () => {
    const def = await indexDefinition('idx_reminders_pending_next_run');
    expect(def).toMatch(/\(next_run_at\)/);
    expect(def).toMatch(/WHERE \(status = 'pending'/);
  });

  it('the "stuck reminders" index only holds processing rows', async () => {
    const def = await indexDefinition('idx_reminders_processing_locked');
    expect(def).toMatch(/\(locked_until\)/);
    expect(def).toMatch(/WHERE \(status = 'processing'/);
  });

  it('the claim query can use the partial index', async () => {
    // Tiny test table -> PostgreSQL would pick a seq scan. Turn that off
    // (only in this transaction) to see whether the index is usable at all.
    const plan = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL enable_seqscan = off', { transaction });
      return sequelize.query(
        `EXPLAIN SELECT id FROM reminders WHERE status = 'pending' AND next_run_at <= now()
         ORDER BY next_run_at LIMIT 10 FOR UPDATE SKIP LOCKED`,
        { type: 'SELECT', transaction }
      );
    });
    expect(plan.map((r) => r['QUERY PLAN']).join('\n')).toMatch(/idx_reminders_pending_next_run/);
  });
});
