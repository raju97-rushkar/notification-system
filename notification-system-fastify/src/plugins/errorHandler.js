const fp = require('fastify-plugin');
const { ZodError } = require('zod');
const { ValidationError, DatabaseError } = require('sequelize');
const AppError = require('../utils/AppError');

// PostgreSQL error code for "invalid input syntax", e.g. "abc" is not a valid UUID
const PG_INVALID_TEXT = '22P02';

// Every error in the app ends up here. Handlers are async functions, and
// Fastify sends anything they throw to this function automatically.
function errorHandler(err, request, reply) {
  // 1. Request validation failed (zod, see plugins/validation.js)
  if (err instanceof ZodError) {
    const details = err.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message }));
    return reply.code(400).send({ message: 'Validation failed', details });
  }

  // 2. Errors we threw on purpose (401, 404, 409, ...)
  if (err instanceof AppError) {
    return reply.code(err.statusCode).send({ message: err.message });
  }

  // 3. Sequelize model validation failed (e.g. title longer than 200 characters)
  if (err instanceof ValidationError) {
    const details = err.errors.map((e) => ({ field: e.path, message: e.message }));
    return reply.code(400).send({ message: 'Validation failed', details });
  }

  // 4. Invalid value for a database column (ids are already checked by zod,
  //    this is a safety net)
  if (err instanceof DatabaseError && err.parent?.code === PG_INVALID_TEXT) {
    return reply.code(400).send({ message: 'Invalid id' });
  }

  // 5. Fastify's own client errors: broken JSON, empty JSON body, body too
  //    large, unsupported Content-Type, ... They come with a 4xx statusCode.
  if (err.statusCode >= 400 && err.statusCode < 500) {
    return reply.code(err.statusCode).send({ message: err.message });
  }

  // 6. Anything else is a bug: log it, but don't show details to the client
  request.log.error(err);
  return reply.code(500).send({ message: 'Something went wrong' });
}

// No route matched the URL
function notFoundHandler(request, reply) {
  return reply.code(404).send({ message: `Route ${request.method} ${request.url} not found` });
}

async function errorHandlerPlugin(app) {
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
}

module.exports = fp(errorHandlerPlugin, { name: 'error-handler' });
module.exports.errorHandler = errorHandler;
module.exports.notFoundHandler = notFoundHandler;
