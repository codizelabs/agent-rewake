// An agent that ignores SIGTERM and the end of its input, to test that the wrapper still exits.
process.on("SIGTERM", () => {});
process.stdin.resume();
setInterval(() => {}, 1000);
