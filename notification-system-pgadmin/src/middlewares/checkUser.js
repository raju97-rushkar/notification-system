const AppError = require('../utils/AppError');

// Simple replacement for login/authentication.
// The client sends its user id in the "x-user-id" header.
// In a real app, this would verify a JWT token instead.
function checkUser(req, res, next) {
  const userId = req.header('x-user-id');
  if (!userId) {
    return next(new AppError(401, 'x-user-id header is required'));
  }
  req.userId = userId;
  next();
}

module.exports = checkUser;
