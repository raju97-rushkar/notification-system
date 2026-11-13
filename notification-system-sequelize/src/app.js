const express = require('express');
const cors = require('cors');
const routes = require('./routes');
const { notFound, errorHandler } = require('./middlewares/errorHandler');

// Creates the Express app. It does NOT start the server or connect to the DB,
// so the tests can use the app directly.
function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.use('/api', routes);

  app.use(notFound); // no route matched
  app.use(errorHandler); // must be the last middleware

  return app;
}

module.exports = { createApp };
