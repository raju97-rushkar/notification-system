const Fastify = require('fastify');
const cors = require('@fastify/cors');
const validation = require('./plugins/validation');
const errorHandler = require('./plugins/errorHandler');
const database = require('./plugins/database');
const auth = require('./plugins/auth');
const worker = require('./plugins/worker');
const routes = require('./routes');

// Builds the Fastify app out of plugins. It does NOT start listening, so tests
// can use app.inject() without opening a port.
//
//   logger  -> Fastify's built-in pino logger (false = silent, e.g. in tests)
//   worker  -> also run the background reminder worker in this process
//   api     -> register the HTTP routes (false = worker-only process)
//
// Plugins load in this order when app.ready() / app.listen() is called:
//   validation -> error handler -> database -> auth -> worker -> routes
function buildApp({ logger = false, worker: runWorker = false, api = true } = {}) {
  const app = Fastify({ logger });

  app.register(validation);
  app.register(errorHandler);
  app.register(database);
  app.register(worker, { enabled: runWorker });

  if (api) {
    app.register(cors);
    app.register(auth);
    app.register(routes, { prefix: '/api' });
  }

  return app;
}

module.exports = { buildApp };
