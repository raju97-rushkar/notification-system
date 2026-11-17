const Fastify = require('fastify');
const validation = require('./plugins/validation');
const errorHandler = require('./plugins/errorHandler');
const database = require('./plugins/database');
const security = require('./plugins/security');
const auth = require('./plugins/auth');
const worker = require('./plugins/worker');
const routes = require('./routes');

// Builds the Fastify app out of plugins. It does NOT start listening, so tests
// can use app.inject() without opening a port.
//
//   logger  -> Fastify's built-in pino logger (false = silent, e.g. in tests)
//   worker  -> also run the background reminder worker in this process
//   api     -> register the HTTP routes (false = worker-only process)
//   rateLimitMax -> requests per minute per IP (default: RATE_LIMIT_MAX or 100, 0 = off)
//
// Plugins load in this order when app.ready() / app.listen() is called:
//   validation -> error handler -> database -> worker -> security -> auth -> routes
function buildApp({ logger = false, worker: runWorker = false, api = true, rateLimitMax } = {}) {
  const app = Fastify({
    logger,
    // Largest valid body (200 char title + 2000 char message) is < 10 KB.
    // Anything bigger is refused with 413 before it is parsed.
    bodyLimit: Number(process.env.BODY_LIMIT) || 16 * 1024,
    // A client that sends a request too slowly is cut off after 30 s
    requestTimeout: 30 * 1000,
    // Behind a proxy (nginx, load balancer) set TRUST_PROXY=true, so
    // request.ip (used by the rate limit) is the client's IP, not the proxy's.
    trustProxy: process.env.TRUST_PROXY === 'true',
  });

  app.register(validation);
  app.register(errorHandler);
  app.register(database);
  app.register(worker, { enabled: runWorker });

  if (api) {
    app.register(security, { rateLimitMax });
    app.register(auth);
    app.register(routes, { prefix: '/api' });
  }

  return app;
}

module.exports = { buildApp };
