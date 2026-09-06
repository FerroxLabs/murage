// Test-process-only transport fixture. Production has no endpoint override.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const original = globalThis.fetch;
let calls = 0;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url !== "https://api.tavily.com/search" && url !== "https://api.exa.ai/search") return original(input, init);
  calls++;
  writeFileSync(join(process.env.HOME, "search-fixture-calls.json"), JSON.stringify({ calls, url,
    bearerPresent: new Headers(init?.headers).get("authorization") === "Bearer native-search-fixture-key",
    body: JSON.parse(init.body), redirect: init.redirect }));
  return Response.json({ results: [{ title: "Fixture source", url: "https://example.com/source",
    content: "Untrusted source excerpt.", highlights: ["Untrusted source excerpt."] }] });
};
