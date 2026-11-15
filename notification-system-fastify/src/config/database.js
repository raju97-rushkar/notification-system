const { Sequelize } = require('sequelize');
const { Client } = require('pg');

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5433/notification_system_fastify';

// ONE Sequelize instance for the whole app. Every model is attached to it.
// Sequelize keeps a pool of connections and reuses them.
const sequelize = new Sequelize(DATABASE_URL, {
  dialect: 'postgres',
  logging: false, // set to console.log to see every SQL query Sequelize runs
  pool: { max: 10, min: 0, idle: 10000 },
});

// Creates the database (e.g. "notification_system_fastify") if it doesn't
// exist yet, so you don't have to create it by hand in pgAdmin.
// Sequelize can't do this itself (it needs an existing database to connect to),
// so we use the plain "pg" client once.
async function createDatabaseIfMissing(log) {
  const url = new URL(DATABASE_URL);
  const dbName = url.pathname.slice(1); // "/my_db" -> "my_db"

  url.pathname = '/postgres'; // connect to the default "postgres" database first
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const result = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (result.rowCount === 0) {
      await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
      log.info(`Database "${dbName}" created`);
    }
  } finally {
    await client.end();
  }
}

// log: Fastify's logger (app.log) when called from plugins/database.js
async function connectDB(log = console) {
  await createDatabaseIfMissing(log);

  await sequelize.authenticate(); // checks the connection works
  log.info('PostgreSQL connected (Sequelize)');

  // Load the models (this also sets up their relationships)
  require('../models');

  // Create tables + indexes that don't exist yet. Existing tables are NOT changed.
  // (In a big project you'd use migrations with sequelize-cli instead of sync.)
  // The advisory lock makes the API and a worker that start at the same moment
  // take turns, so they don't both try to CREATE TABLE at once.
  await sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(424243)', { transaction });
    await sequelize.sync({ transaction });
  });
}

async function disconnectDB() {
  await sequelize.close();
}

module.exports = { sequelize, connectDB, disconnectDB };
