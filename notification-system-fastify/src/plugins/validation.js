const fp = require('fastify-plugin');

// Fastify validates requests with JSON Schema (Ajv) by default. We plug in
// zod instead, so the route schemas can also TRANSFORM data: e.g. turn
// "2026-11-05T10:00:00+05:30" into a Date, or "2" (query text) into 2.
//
// Fastify calls this once per route + part (body, querystring, params).
// The function it returns runs on every request:
//   { value } -> Fastify replaces request.body / request.query / request.params with it
//   { error } -> Fastify stops the request and passes the error to errorHandler (400)
function zodValidatorCompiler({ schema }) {
  return (data) => {
    // A missing body arrives as null; treat it as {} (like an empty JSON object)
    const result = schema.safeParse(data ?? {});
    return result.success ? { value: result.data } : { error: result.error };
  };
}

// fastify-plugin (fp) = don't encapsulate: the compiler applies to the whole app,
// not only inside this plugin.
async function validationPlugin(app) {
  app.setValidatorCompiler(zodValidatorCompiler);
}

module.exports = fp(validationPlugin, { name: 'validation' });
module.exports.zodValidatorCompiler = zodValidatorCompiler;
