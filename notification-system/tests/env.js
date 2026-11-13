// Runs before every test file. Keeps tests independent of your .env file.
process.env.NODE_ENV = 'test';
process.env.MAX_ATTEMPTS = '3';
process.env.SIMULATED_FAILURE_RATE = '0';
