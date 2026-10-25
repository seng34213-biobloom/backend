process.env.TZ = 'UTC';
// Jest's CLI defaults NODE_ENV to "test"; invoking jest.run() directly does not.
process.env.NODE_ENV ??= 'test';

require('jest').run();
