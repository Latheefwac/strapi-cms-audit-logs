/**
 * Server-side unit and integration tests.
 *
 * The admin panel is excluded: it needs jsdom plus Strapi's own admin test
 * harness, and the behaviour worth guarding — what gets recorded, what gets
 * redacted, what gets populated — all lives on the server.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: ['server/src/**/*.ts', '!server/src/**/index.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tests/tsconfig.json' }],
  },
  clearMocks: true,
};
