// Security plugin: response headers, CORS, rate limit, body size limit.
const { buildApp } = require('../src/app');
const { corsOrigin, rateLimitFromEnv } = require('../src/plugins/security');

// Small limit so the test can reach it quickly. ONE app for the whole file
// (the apps share one database pool, closing a second app would close it).
const app = buildApp({ rateLimitMax: 3 });
beforeAll(() => app.ready());
afterAll(() => app.close());

// The rate limit counts per IP, so each test uses its own fake client IP
// and the tests don't eat each other's limit.
let ipCounter = 1;
function clientFromNewIp() {
  const remoteAddress = `10.0.0.${ipCounter++}`;
  return (options) => app.inject({ remoteAddress, ...options, headers: { 'x-user-id': 'user1', ...options.headers } });
}

describe('Security headers (helmet)', () => {
  it('adds safe headers to API responses', async () => {
    const res = await clientFromNewIp()({ method: 'GET', url: '/api/reminders' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('CORS', () => {
  it('answers a browser preflight request', async () => {
    const res = await clientFromNewIp()({
      method: 'OPTIONS',
      url: '/api/reminders',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('CORS_ORIGIN is read as a comma separated list (not set = any origin)', () => {
    expect(corsOrigin(undefined)).toBe(true);
    expect(corsOrigin('https://a.com, https://b.com,')).toEqual(['https://a.com', 'https://b.com']);
  });
});

describe('Rate limit', () => {
  it('gives 429 with Retry-After after too many requests from one IP', async () => {
    const send = clientFromNewIp();
    for (let i = 0; i < 3; i++) {
      const ok = await send({ method: 'GET', url: '/api/reminders' });
      expect(ok.statusCode).toBe(200);
      expect(Number(ok.headers['x-ratelimit-remaining'])).toBe(2 - i);
    }

    const limited = await send({ method: 'GET', url: '/api/reminders' });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.json().message).toMatch(/rate limit exceeded/i);
  });

  it('counts by IP, not by x-user-id (a new id does not reset the limit)', async () => {
    const send = clientFromNewIp();
    for (let i = 0; i < 3; i++) await send({ method: 'GET', url: '/api/reminders', headers: { 'x-user-id': `u${i}` } });

    const res = await send({ method: 'GET', url: '/api/reminders', headers: { 'x-user-id': 'brand-new' } });
    expect(res.statusCode).toBe(429);
  });

  it('RATE_LIMIT_MAX: unset, empty or invalid -> 100, only an explicit 0 turns it off', () => {
    expect(rateLimitFromEnv(undefined)).toBe(100);
    expect(rateLimitFromEnv('')).toBe(100);
    expect(rateLimitFromEnv('abc')).toBe(100);
    expect(rateLimitFromEnv('20')).toBe(20);
    expect(rateLimitFromEnv('0')).toBe(0);
  });

  it('another IP still gets through', async () => {
    expect((await clientFromNewIp()({ method: 'GET', url: '/api/reminders' })).statusCode).toBe(200);
  });

  it('the health check is not rate limited', async () => {
    const send = clientFromNewIp();
    for (let i = 0; i < 5; i++) {
      expect((await send({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    }
  });
});

describe('Body size limit', () => {
  it('a body over 16 KB gives 413, before it is parsed', async () => {
    const res = await clientFromNewIp()({
      method: 'POST',
      url: '/api/reminders',
      payload: { title: 'x', message: 'a'.repeat(20 * 1024), dueAt: new Date(Date.now() + 60000).toISOString() },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ message: 'Request body is too large' });
  });

  it('the largest valid body still fits', async () => {
    const res = await clientFromNewIp()({
      method: 'POST',
      url: '/api/reminders',
      // multi-byte characters: 2000 x 3 bytes = 6 KB of message
      payload: { title: 'é'.repeat(200), message: '€'.repeat(2000), dueAt: new Date(Date.now() + 60000).toISOString() },
    });
    expect(res.statusCode).toBe(201);
  });
});
