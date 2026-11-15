const { buildApp } = require('../../src/app');

// Builds ONE Fastify app for the test file (no logger, no background worker).
// app.ready() loads the plugins (connects to the test database),
// app.close() runs the close hooks (closes the connection pool).
function setupApp() {
  const app = buildApp();
  beforeAll(() => app.ready());
  afterAll(() => app.close());
  return app;
}

// Small HTTP client on top of app.inject().
// inject() sends a fake request straight into Fastify: no port is opened,
// but routing, hooks, validation and the error handler all run for real.
//
//   const api = createClient(app);
//   const res = await api.post('/api/reminders', { title: 'x', dueAt }, 'user1');
//   res.status, res.body
//
// user: value of the x-user-id header ('user1' by default, null = no header)
function createClient(app) {
  async function send(method, url, { body, user = 'user1', headers = {} } = {}) {
    const res = await app.inject({
      method,
      url,
      payload: body,
      headers: { ...(user ? { 'x-user-id': user } : {}), ...headers },
    });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  }

  return {
    get: (url, user) => send('GET', url, { user }),
    post: (url, body, user) => send('POST', url, { body, user }),
    patch: (url, body, user) => send('PATCH', url, { body, user }),
    send,
  };
}

module.exports = { setupApp, createClient };
