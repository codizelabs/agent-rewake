// Only Rewake's own tests: video/ holds a demo project with its own (node:test) tests.
// Windows runners start processes several times slower than macOS and Linux: tests that spawn the
// bundle or a fake agent get more time there instead of timing out at the default 5 seconds.
export default {
  test: {
    setupFiles: ["test/setup.ts"],
    include: ["test/**/*.test.ts"],
    testTimeout: process.platform === "win32" ? 20_000 : 5_000,
  },
};
