// Test-process-only transport fixture. Production has no endpoint override.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const original = globalThis.fetch;
let calls = 0;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.telegram.org/bot")) {
    if (url.endsWith("/getMe")) return Response.json({ ok: true, result: { id: 123, is_bot: true, username: "fixture_bot" } });
    if (url.endsWith("/getUpdates")) return Response.json({ ok: true, result: [] });
    return Response.json({ ok: false, error_code: 400 });
  }
  if (url === "https://search.parallel.ai/mcp") {
    const message = JSON.parse(init.body);
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize" ? {} : {
      structuredContent: { results: [{ title: "Free fixture source", url: "https://example.com/free", excerpts: ["Untrusted free-search excerpt"] }] },
    } });
  }
  if (url !== "https://api.tavily.com/search" && url !== "https://api.exa.ai/search") return original(input, init);
  calls++;
  writeFileSync(join(process.env.HOME, "search-fixture-calls.json"), JSON.stringify({ calls, url,
    bearerPresent: new Headers(init?.headers).get("authorization") === "Bearer native-search-fixture-key",
    body: JSON.parse(init.body), redirect: init.redirect }));
  return Response.json({ results: [{ title: "Fixture source", url: "https://example.com/source",
    content: "Untrusted source excerpt.", highlights: ["Untrusted source excerpt."] }] });
};
