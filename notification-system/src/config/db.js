const mongoose = require('mongoose');

async function connectDB(uri) {
  await mongoose.connect(uri);
  console.log('MongoDB connected');

  // Create the indexes defined in our models (and remove old ones that are no
  // longer in the code). We wait for this because the worker depends on the
  // UNIQUE index on notifications to prevent duplicates.
  await mongoose.syncIndexes();
}

async function disconnectDB() {
  await mongoose.disconnect();
}

module.exports = { connectDB, disconnectDB };
