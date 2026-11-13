const fs = require('fs');
const path = require('path');
const { Client, Pool } = require('pg');

// A "pool" keeps a few database connections open and reuses them,
// instead of opening a new connection for every query (that would be slow).
let pool = null;

// Creates the database (e.g. "notification_system") if it doesn't exist yet,
// so you don't have to create it by hand in pgAdmin.
async function createDatabaseIfMissing(databaseUrl) {
  const url = new URL(databaseUrl);
  const dbName = url.pathname.slice(1); // "/notification_system" -> "notification_system"

  url.pathname = '/postgres'; // connect to the default "postgres" database first
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const result = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (result.rowCount === 0) {
      // Names can't be $1 parameters in CREATE DATABASE, so we quote it safely.
      await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
      console.log(`Database "${dbName}" created`);
    }
  } finally {
    await client.end();
  }
}

async function connectDB(databaseUrl) {
  await createDatabaseIfMissing(databaseUrl);

  pool = new Pool({ connectionString: databaseUrl, max: 10 });
  await pool.query('SELECT 1'); // check the connection works
  console.log('PostgreSQL connected');

  await createTables();
}

// Runs schema.sql (safe to run every time, it uses IF NOT EXISTS).
// If the API and a worker start at the same moment, both would run CREATE TABLE
// together and one could fail. The advisory lock makes them take turns.
async function createTables() {
  const schema = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(424242)'); // released at COMMIT
    await client.query(schema);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// All files use this to run SQL. Always pass values as params ($1, $2 ...),
// never put user input inside the SQL string -> protects against SQL injection.
function query(sql, params) {
  if (!pool) throw new Error('Database is not connected');
  return pool.query(sql, params);
}

async function disconnectDB() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { connectDB, disconnectDB, query };
