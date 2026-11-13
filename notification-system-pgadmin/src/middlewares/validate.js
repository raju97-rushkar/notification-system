// Checks req.body (or req.query) against a zod schema.
// If it is valid, the clean data is saved in req.validated.
// If not, the ZodError goes to errorHandler, which sends a 400 response.
//
// Why req.validated and not req.query? In Express 5, req.query is read-only.
function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source] || {});
    if (!result.success) {
      return next(result.error);
    }
    req.validated = result.data;
    next();
  };
}

module.exports = validate;
