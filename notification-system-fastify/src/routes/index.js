const reminderRoutes = require('./reminder.routes');
const notificationRoutes = require('./notification.routes');

// Registered with prefix "/api" in app.js.
async function routes(app) {
  // Health check: is the server running and connected to the database?
  // Not rate limited: monitoring tools may call it often.
  app.get('/health', { config: { rateLimit: false } }, async (request, reply) => {
    try {
      await app.sequelize.authenticate();
      return { server: 'ok', database: 'connected' };
    } catch {
      return reply.code(503).send({ server: 'ok', database: 'disconnected' });
    }
  });

  // Everything registered inside this child plugin needs the x-user-id header.
  // Fastify ENCAPSULATION: the hook only applies to routes in this plugin,
  // so /health above stays public.
  // onRequest runs before the body is parsed/validated -> 401 comes before 400.
  app.register(async (protectedRoutes) => {
    protectedRoutes.addHook('onRequest', app.checkUser);
    protectedRoutes.register(reminderRoutes, { prefix: '/reminders' });
    protectedRoutes.register(notificationRoutes, { prefix: '/notifications' });
  });
}

module.exports = routes;
