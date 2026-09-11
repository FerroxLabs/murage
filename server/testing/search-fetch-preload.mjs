// Test-process-only transport fixture. Production has no endpoint override.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const original = globalThis.fetch;
let calls = 0;
let imageCalls = 0;
const FIXTURE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
// Each image origin accepts only its own fake key. A key sent to another
// provider's origin fails the request, which is the exact-origin assertion.
const IMAGE_FIXTURE_KEYS = {
  "https://api.openai.com": "Bearer fixture-image-key",
  "https://api.x.ai": "Bearer xai-fixture-image-key",
  "https://openrouter.ai": "Bearer sk-or-fixture-image-key",
};
const IMAGE_POSTS = {
  "https://api.openai.com/v1/images/generations": "openai", "https://api.openai.com/v1/images/edits": "openai",
  "https://api.x.ai/v1/images/generations": "xai", "https://api.x.ai/v1/images/edits": "xai",
  "https://openrouter.ai/api/v1/images": "openrouter",
};
const OPENROUTER_QUALITY = { type: "enum", values: ["low", "medium", "high"] };
const IMAGE_READS = {
  "https://openrouter.ai/api/v1/images/models": () => ({ data: [{ id: "openai/gpt-image-2", name: "GPT Image 2", architecture: { output_modalities: ["image"] }, supported_parameters: { quality: OPENROUTER_QUALITY } }] }),
  // Mirrors the observed public record: no output_format key and a reference range.
  "https://openrouter.ai/api/v1/images/models/openai/gpt-image-2/endpoints": () => ({ endpoints: [{ provider_tag: "openai", supported_parameters: { quality: OPENROUTER_QUALITY, input_references: { type: "range", min: 0, max: 16 }, n: { type: "range", min: 1, max: 10 } } }] }),
};
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
function dataUrlHash(url) {
  const match = typeof url === "string" ? /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(url) : null;
  if (!match) throw new Error("Image fixture refused a non-data reference");
  return sha256(Buffer.from(match[2], "base64"));
}
async function imageFixture(url, init) {
  const { origin } = new URL(url);
  const authorization = new Headers(init?.headers).get("authorization");
  if ((init?.method ?? "GET") !== "POST") {
    if (authorization !== null) throw new Error("Image fixture refused a credential on a catalog read");
    if (!Object.hasOwn(IMAGE_READS, url)) throw new Error("Image fixture refused an unknown image catalog read");
    return Response.json(IMAGE_READS[url]());
  }
  if (!Object.hasOwn(IMAGE_POSTS, url)) throw new Error("Image fixture refused an unknown image route");
  if (authorization !== IMAGE_FIXTURE_KEYS[origin]) throw new Error("Image fixture refused a non-fixture credential");
  imageCalls++;
  let body, referenceHashes;
  if (typeof init.body === "string") {
    body = JSON.parse(init.body);
    const urls = body.image ? [body.image.url] : Array.isArray(body.images) ? body.images.map(item => item.url)
      : Array.isArray(body.input_references) ? body.input_references.map(item => item.image_url?.url) : [];
    referenceHashes = urls.map(dataUrlHash);
  } else {
    body = Object.fromEntries([...init.body.entries()].filter(([key]) => key !== "image[]"));
    referenceHashes = await Promise.all(init.body.getAll("image[]").map(async file => sha256(Buffer.from(await file.arrayBuffer()))));
  }
  writeFileSync(join(process.env.HOME, "image-fixture-calls.json"), JSON.stringify({
    calls: imageCalls, url, provider: IMAGE_POSTS[url], model: body.model, n: body.n, references: referenceHashes.length, referenceHashes,
    quality: body.quality ?? null, responseFormat: body.response_format ?? null, providerRouting: body.provider ?? null,
    singleImageField: Object.hasOwn(body, "image"), multiImageField: Object.hasOwn(body, "images"), redirect: init.redirect,
  }));
  return Response.json({ data: [{ b64_json: FIXTURE_PNG }], model: body.model });
}
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const parsed = URL.canParse(url) ? new URL(url) : null;
  // Every image path on a known image origin is intercepted: no real-provider pass-through.
  if (parsed && Object.hasOwn(IMAGE_FIXTURE_KEYS, parsed.origin) && /^\/(api\/)?v1\/images(\/|$)/.test(parsed.pathname)) return imageFixture(url, init);
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
