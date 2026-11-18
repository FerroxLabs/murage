// These suites create their own temporary files and fake children. They need
// no application server, engine, browser or global reserved control port.
export default { test: { include: ["scripts/signal-runtime.test.mjs", "server/channels/signal/**/*.test.ts"], environment: "node" } };
