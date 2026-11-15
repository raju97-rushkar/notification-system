const fp = require('fastify-plugin');
const { sequelize, connectDB, disconnectDB } = require('../config/database');

// Connects Sequelize when the app starts and closes the pool when it stops.
//
// Fastify waits for this plugin before it starts listening, so no request can
// arrive before the tables exist. app.close() (Ctrl+C, tests) runs the onClose
// hook, so the connection pool is always closed cleanly.
async function databasePlugin(app) {
  await connectDB(app.log);

  // Available everywhere as app.sequelize and app.models (handy in routes/tests)
  app.decorate('sequelize', sequelize);
  app.decorate('models', require('../models'));

  app.addHook('onClose', async () => {
    await disconnectDB();
  });
}

module.exports = fp(databasePlugin, { name: 'database' });
