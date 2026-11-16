const fp = require('fastify-plugin');
const AppError = require('../utils/AppError');

// Simple replacement for login/authentication.
// The client sends its user id in the "x-user-id" header.
// In a real app, this would verify a JWT token instead (e.g. @fastify/jwt).
// Same size as the user_id column (VARCHAR(255)). A longer id would make
// PostgreSQL reject the insert, which used to end as a 500 error.
const MAX_USER_ID_LENGTH = 255;

async function checkUser(request) {
  const userId = request.headers['x-user-id']?.trim();
  if (!userId) {
    throw new AppError(401, 'x-user-id header is required');
  }
  if (userId.length > MAX_USER_ID_LENGTH) {
    throw new AppError(400, `x-user-id must be at most ${MAX_USER_ID_LENGTH} characters`);
  }
  request.userId = userId;
}

async function authPlugin(app) {
  // Declare request.userId up front (Fastify keeps request objects fast this way)
  app.decorateRequest('userId', null);
  // app.checkUser can be used as a hook in any route plugin (see routes/index.js)
  app.decorate('checkUser', checkUser);
}

module.exports = fp(authPlugin, { name: 'auth' });
module.exports.checkUser = checkUser;
