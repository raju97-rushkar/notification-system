const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const { connectDB, disconnectDB } = require('../../src/config/db');

// Tests use a real MongoDB that runs in memory (no install needed, deleted
// after the tests). Real MongoDB matters here: unique indexes and atomic
// updates are exactly what we want to test.
let mongoServer;

async function startDB() {
  mongoServer = await MongoMemoryServer.create();
  await connectDB(mongoServer.getUri());
}

async function clearDB() {
  const collections = Object.values(mongoose.connection.collections);
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
}

async function stopDB() {
  await disconnectDB();
  await mongoServer.stop();
}

module.exports = { startDB, clearDB, stopDB };
