const { ZodError } = require('zod');
const AppError = require('../utils/AppError');

// PostgreSQL error code for "invalid input syntax", e.g. "abc" is not a valid UUID
const PG_INVALID_TEXT = '22P02';

// Runs when no route matched the URL
function notFound(req, res, next) {
  next(new AppError(404, `Route ${req.method} ${req.originalUrl} not found`));
}

// Every error in the app ends up here (Express 5 also sends errors from
// async functions here automatically, so controllers need no try/catch).
function errorHandler(err, req, res, next) {
  // 1. Request validation failed (zod)
  if (err instanceof ZodError) {
    const details = err.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message }));
    return res.status(400).json({ message: 'Validation failed', details });
  }

  // 2. Errors we threw on purpose (404, 409, ...)
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ message: err.message });
  }

  // 3. Invalid id in the URL, e.g. /reminders/abc (not a UUID)
  if (err.code === PG_INVALID_TEXT) {
    return res.status(400).json({ message: 'Invalid id' });
  }

  // 4. Broken JSON in the request body
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Invalid JSON body' });
  }

  // 5. Anything else is a bug: log it, but don't show details to the client
  console.error(err);
  res.status(500).json({ message: 'Something went wrong' });
}

module.exports = { notFound, errorHandler };
