// Only Rewake's own tests: video/ holds a demo project with its own (node:test) tests.
export default { test: { setupFiles: ["test/setup.ts"], include: ["test/**/*.test.ts"] } };
