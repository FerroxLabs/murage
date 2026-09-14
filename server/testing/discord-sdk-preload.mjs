import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "discord.js") return { url: new URL("./discord-sdk-fixture.mjs", import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("External network disabled in Discord API fixture");
  return originalFetch(input, init);
};
