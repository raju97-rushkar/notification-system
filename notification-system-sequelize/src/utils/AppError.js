// An error we throw on purpose, with the HTTP status code to send back.
// Example: throw new AppError(404, 'Reminder not found')
class AppError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

module.exports = AppError;
