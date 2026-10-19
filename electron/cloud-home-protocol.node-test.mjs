import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProxyRequest, cloudPartition, createCloudHomeHandler, createLastEventIdTracker, isValidHomeId,
  resolveStaticPath, sanitizeResponseHeaders,
} from "./cloud-home-protocol.mjs";

const ORIGIN = "https://h-abc.murage.ai";

test("static allow-list accepts plain dist paths", () => {
  assert.equal(resolveStaticPath("/"), "index.html");
  assert.equal(resolveStaticPath("/assets/app-1a2b.js"), "assets/app-1a2b.js");
  assert.equal(resolveStaticPath("/settings/"), "settings");
  assert.equal(resolveStaticPath("/a%20b.png"), "a b.png");
});

test("static allow-list refuses traversal, encoded separators, absolute lookalikes and /api", () => {
  for (const p of [
    "/../etc/passwd", "/assets/../../x", "/%2e%2e/x", "/%2E%2E/x", "/assets/%2e%2e/%2e%2e/x", "/..%2fx", "/a%2f..%2fb",
    "/a%5c..%5cb", "/a\\b", "/%00", "/a%00.js", "//evil.example/x", "/https://evil.example/x", "/%68ttps://evil/x",
    "/%252e%252e/x", "/%zz", "/./x", "/a//b", "x", "", "/api/x", "/api", "/%61pi/x", "/API/x", "/file:/x", "/ x",
  ]) assert.equal(resolveStaticPath(p), null, p);
});

test("home id and partition", () => {
  assert.equal(cloudPartition("h-abc"), "persist:cloud-h-abc");
  for (const bad of ["", "A", "-a", "a.b", "a/b", "a b", "a".repeat(64), null]) assert.equal(isValidHomeId(bad), false, String(bad));
  assert.throws(() => cloudPartition("../x"));
});

function req(url, { method = "GET", headers = {}, body } = {}) {
  return { url, method, headers: new Headers(headers), body };
}

test("proxy adds Bearer + Origin and strips secrets, cookies and the renderer's own auth", () => {
  const built = buildProxyRequest(
    req("murage-home://h-abc/api/threads?a=1&surfaceSecret=S&SURFACESECRET=T&b=2", {
      headers: {
        "x-murage-surface-secret": "S", "X-Surface-Secret-Extra": "n", authorization: "Bearer renderer", origin: "murage-home://h-abc",
        cookie: "k=v", referer: "murage-home://h-abc/", host: "h-abc", "content-type": "application/json", "x-keep": "1",
      },
    }),
    { origin: ORIGIN, token: "TOK" },
  );
  assert.equal(built.url, `${ORIGIN}/api/threads?a=1&b=2`);
  const h = built.init.headers;
  assert.equal(h.get("authorization"), "Bearer TOK");
  assert.equal(h.get("origin"), ORIGIN);
  for (const name of ["x-murage-surface-secret", "cookie", "referer", "host", "x-surface-secret-extra"]) assert.equal(h.has(name), false, name);
  assert.equal(h.get("x-keep"), "1");
  assert.equal(h.get("content-type"), "application/json");
  assert.equal(built.init.redirect, "manual");
});

test("proxy without a token sends no Authorization and never forwards the renderer's", () => {
  const built = buildProxyRequest(req("murage-home://h-abc/api/health", { headers: { authorization: "Bearer renderer" } }), { origin: ORIGIN, token: null });
  assert.equal(built.init.headers.has("authorization"), false);
});

test("proxy streams request bodies for writes and not for GET", () => {
  const body = new ReadableStream();
  const post = buildProxyRequest(req("murage-home://h-abc/api/x", { method: "POST", body }), { origin: ORIGIN, token: "t" });
  assert.equal(post.init.body, body);
  assert.equal(post.init.duplex, "half");
  assert.equal("body" in buildProxyRequest(req("murage-home://h-abc/api/x"), { origin: ORIGIN, token: "t" }).init, false);
});

test("proxy refuses non-api and traversal paths, and cannot leave the home origin", () => {
  for (const u of ["murage-home://h-abc/x", "murage-home://h-abc/api/%2e%2e/admin", "murage-home://h-abc/api/a%2fb", "murage-home://h-abc/api/a%5cb", "murage-home://h-abc/apix"]) {
    assert.equal(buildProxyRequest(req(u), { origin: ORIGIN, token: "t" }), null, u);
  }
  const built = buildProxyRequest(req("murage-home://h-abc/api//evil.example/x"), { origin: ORIGIN, token: "t" });
  assert.equal(new URL(built.url).origin, ORIGIN);
});

test("proxy injects Last-Event-ID only when the request has none", () => {
  const a = buildProxyRequest(req("murage-home://h-abc/api/events"), { origin: ORIGIN, token: "t", lastEventId: "41" });
  assert.equal(a.init.headers.get("last-event-id"), "41");
  const b = buildProxyRequest(req("murage-home://h-abc/api/events", { headers: { "last-event-id": "7" } }), { origin: ORIGIN, token: "t", lastEventId: "41" });
  assert.equal(b.init.headers.get("last-event-id"), "7");
});

test("HTML from /api is sandboxed with nosniff; cookies and stale encoding headers are dropped", () => {
  const h = sanitizeResponseHeaders(new Headers({ "content-type": "text/html; charset=utf-8", "set-cookie": "a=b", "content-encoding": "gzip", "content-length": "9" }));
  assert.equal(h.get("content-security-policy"), "sandbox");
  assert.equal(h.get("x-content-type-options"), "nosniff");
  for (const n of ["set-cookie", "content-encoding", "content-length"]) assert.equal(h.has(n), false);
  const j = sanitizeResponseHeaders(new Headers({ "content-type": "application/json" }));
  assert.equal(j.has("content-security-policy"), false);
  assert.equal(sanitizeResponseHeaders(new Headers({ "content-type": "application/xhtml+xml" })).get("content-security-policy"), "sandbox");
});

function sse(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(enc.encode(x)); c.close(); } });
}
async function drain(stream) { const r = stream.getReader(); while (!(await r.read()).done); }

test("Last-Event-ID tracker records dispatched ids across split chunks and CRLF", async () => {
  const t = createLastEventIdTracker();
  await drain(t.tee("k", sse([": open\n\ni", "d: 1\ndata: a\n\nid: 2\r", "\ndata: b\r\n\r\nid: 3\ndata: no-blank-line-yet\n"])));
  assert.equal(t.get("k"), "2", "id 3 never dispatched");
  await drain(t.tee("k", sse(["id: 9\ndata: x\n\n"])));
  assert.equal(t.get("k"), "9");
  await drain(t.tee("k", sse(["id:\ndata: x\n\n"])));
  assert.equal(t.get("k"), null, "empty id resets");
});

test("Last-Event-ID tracker is bounded", async () => {
  const t = createLastEventIdTracker({ maxKeys: 2 });
  for (const k of ["a", "b", "c"]) await drain(t.tee(k, sse(["id: 1\n\n"])));
  assert.equal(t.get("a"), null);
  assert.equal(t.get("c"), "1");
});

function harness({ home = { homeId: "h-abc", origin: ORIGIN, getAccessToken: () => "TOK" }, files = { "index.html": Buffer.from("<html>app</html>"), "assets/a.js": Buffer.from("1") }, upstream } = {}) {
  const calls = [];
  const handler = createCloudHomeHandler({
    homeId: "h-abc",
    home: () => home,
    netFetch: async (url, init) => { calls.push({ url, init }); return upstream ? upstream(url, init) : new Response("{}", { headers: { "content-type": "application/json" } }); },
    readAsset: async (rel) => files[rel] ?? null,
  });
  return { handler, calls };
}

test("handler serves static files from dist and never calls the home for them", async () => {
  const { handler, calls } = harness();
  const r = await handler(req("murage-home://h-abc/assets/a.js"));
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /javascript/);
  assert.equal(await r.text(), "1");
  assert.equal((await handler(req("murage-home://h-abc/"))).status, 200);
  assert.equal(await (await handler(req("murage-home://h-abc/some/route"))).text(), "<html>app</html>", "extensionless route falls back to the app shell");
  assert.equal((await handler(req("murage-home://h-abc/missing.js"))).status, 404);
  assert.equal(calls.length, 0);
});

test("handler refuses bad paths, other homes, writes to static and credentials in the URL", async () => {
  const { handler, calls } = harness();
  assert.equal((await handler(req("murage-home://h-abc/%252e%252e/secret"))).status, 400);
  // %2e%2e is a dot segment: the URL parser folds it before the handler runs, so it can only land inside dist/.
  assert.equal(new URL("murage-home://h-abc/%2e%2e/%2e%2e/secret").pathname, "/secret");
  assert.equal((await handler(req("murage-home://h-other/"))).status, 404);
  assert.equal((await handler(req("murage-home://h-abc/", { method: "POST" }))).status, 405);
  assert.equal((await handler(req("murage-home://u:p@h-abc/"))).status, 400);
  assert.equal((await handler(req("https://h-abc/"))).status, 404);
  assert.equal(calls.length, 0);
});

test("handler proxies /api with Bearer and Origin and returns sandboxed HTML", async () => {
  const { handler, calls } = harness({ upstream: () => new Response("<script>1</script>", { headers: { "content-type": "text/html" } }) });
  const r = await handler(req("murage-home://h-abc/api/page?surfaceSecret=S", { headers: { "x-murage-surface-secret": "S" } }));
  assert.equal(r.headers.get("content-security-policy"), "sandbox");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(calls[0].url, `${ORIGIN}/api/page`);
  assert.equal(calls[0].init.headers.get("authorization"), "Bearer TOK");
  assert.equal(calls[0].init.headers.get("origin"), ORIGIN);
  assert.equal(calls[0].init.headers.has("x-murage-surface-secret"), false);
});

test("handler: unpaired home, unreachable home and redirects fail closed", async () => {
  assert.equal((await harness({ home: null }).handler(req("murage-home://h-abc/api/health"))).status, 503);
  assert.equal((await harness({ home: { homeId: "h-x", origin: ORIGIN, getAccessToken: () => "t" } }).handler(req("murage-home://h-abc/api/health"))).status, 503);
  assert.equal((await harness({ upstream: () => { throw new Error("down"); } }).handler(req("murage-home://h-abc/api/health"))).status, 502);
  assert.equal((await harness({ upstream: () => new Response(null, { status: 302, headers: { location: "https://evil/" } }) }).handler(req("murage-home://h-abc/api/x"))).status, 502);
  const throwing = harness({ home: { homeId: "h-abc", origin: ORIGIN, getAccessToken: () => { throw new Error("locked"); } } });
  await throwing.handler(req("murage-home://h-abc/api/health"));
  assert.equal(throwing.calls[0].init.headers.has("authorization"), false);
});

test("handler: SSE reconnect gets Last-Event-ID injected from the teed stream", async () => {
  let n = 0;
  const { handler, calls } = harness({
    upstream: () => new Response(sse(n++ === 0 ? ["id: 1\ndata: a\n\nid: 2\ndata: b\n\n"] : ["id: 3\ndata: c\n\n"]), { headers: { "content-type": "text/event-stream" } }),
  });
  const first = await handler(req("murage-home://h-abc/api/events"));
  assert.equal(first.headers.get("content-type"), "text/event-stream");
  await drain(first.body);
  assert.equal(calls[0].init.headers.has("last-event-id"), false);
  await drain((await handler(req("murage-home://h-abc/api/events"))).body);
  assert.equal(calls[1].init.headers.get("last-event-id"), "2");
  await handler(req("murage-home://h-abc/api/events?other=1"));
  assert.equal(calls[2].init.headers.has("last-event-id"), false, "keyed per path+query");
  await drain((await handler(req("murage-home://h-abc/api/events"))).body);
  assert.equal(calls[3].init.headers.get("last-event-id"), "3");
});
