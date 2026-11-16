// Test-only module substitution: no product flag or live Slack connection exists.
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "@slack/socket-mode" || specifier === "@slack/web-api")
    return { url: new URL("./slack-sdk-fixture.mjs", import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("External network disabled in Slack API fixture");
  return originalFetch(input, init);
};
// The fixture server is spawned with an IPC channel. If the test worker dies (a run killed from outside skips every teardown), the channel
// closes: exit then, so no server outlives its test. A server started without a channel is untouched.
if (typeof process.send === "function") process.once("disconnect", () => process.exit(0));
