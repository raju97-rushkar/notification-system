const fp = require('fastify-plugin');
const helmet = require('@fastify/helmet');
const cors = require('@fastify/cors');
const rateLimit = require('@fastify/rate-limit');

// "a.com, b.com" -> ['a.com', 'b.com']. Not set -> true (any origin, fine for
// local development). In production set CORS_ORIGIN to the frontend's URL.
function corsOrigin(value = process.env.CORS_ORIGIN) {
  if (!value) return true;
  return value.split(',').map((origin) => origin.trim()).filter(Boolean);
}

// Security settings for the HTTP API (only registered when api: true).
//
//   helmet     -> safe HTTP response headers (X-Content-Type-Options: nosniff,
//                 Strict-Transport-Security, no X-Powered-By, ...)
//   cors       -> which websites may call the API from a browser
//   rate-limit -> at most `rateLimitMax` requests per minute per IP address,
//                 then 429 with a Retry-After header. 0 = off (used in tests).
//
// The rate limit is keyed by IP, NOT by x-user-id: the header is not a real
// login, so a client could send a new id on every request to get around it.
//
// RATE_LIMIT_MAX not set, empty or not a number -> 100. Only an explicit 0 turns it off.
function rateLimitFromEnv(value) {
  const max = Number(value);
  return value?.trim() && Number.isFinite(max) ? max : 100;
}

async function securityPlugin(app, { rateLimitMax = rateLimitFromEnv(process.env.RATE_LIMIT_MAX) } = {}) {
  await app.register(helmet);
  await app.register(cors, { origin: corsOrigin() });

  if (rateLimitMax > 0) {
    await app.register(rateLimit, { max: rateLimitMax, timeWindow: '1 minute' });
  }
}

module.exports = fp(securityPlugin, { name: 'security' });
module.exports.corsOrigin = corsOrigin;
module.exports.rateLimitFromEnv = rateLimitFromEnv;
