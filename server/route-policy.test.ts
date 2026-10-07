// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Contract 4.2, strict: every route the real dispatcher answers has exactly
// one class in route-policy.ts, and a route nobody classified is
// desktop-only. (a) discovery over the real source, (b) an injected route in
// a fixture built on the real routing pattern and the real gate.
// route-policy-api.test.ts is (c), the sweep against a running server.
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import { conversationSubject, DESKTOP_ONLY_SENTENCE, ROUTE_POLICY, routeAdmits, routeClass, routeRefusal, type RoutePolicyEntry } from "./route-policy.ts";
import { describeRoute, discoverRoutes, type DiscoveredRoute } from "./testing/route-discovery.ts";

const ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const scratch = mkdtempSync(join(tmpdir(), "murage-route-policy-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const matches = (entry: RoutePolicyEntry, method: string, path: string) =>
  (entry.methods === "*" || entry.methods.includes(method)) && (typeof entry.path === "string" ? entry.path === path : entry.path.test(path));

/** Each discovered route's requests with the entries that match them. */
function requests(routes: DiscoveredRoute[]) {
  return routes.flatMap(route => (route.methods ?? ALL_METHODS).flatMap(method => route.samples.map(sample => ({ route, method, sample,
    entries: ROUTE_POLICY.filter(entry => matches(entry, method, sample)) }))));
}

describe("route policy (strict)", () => {
  it("(a) every discovered route has exactly one class, and every entry is a route", () => {
    const routes = discoverRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(200);
    const all = requests(routes);
    const unclassified = all.filter(item => item.entries.length === 0).map(item => `${item.method} ${item.sample}  <- ${describeRoute(item.route)}`);
    const ambiguous = all.filter(item => new Set(item.entries.map(entry => entry.class)).size > 1)
      .map(item => `${item.method} ${item.sample}: ${item.entries.map(entry => entry.class).join(" / ")}`);
    const arrived = ROUTE_POLICY.filter(entry => entry.arrives && all.some(item => item.entries.includes(entry)));
    const stale = ROUTE_POLICY.filter(entry => !entry.arrives && !all.some(item => item.entries.includes(entry)));
    // Classify a new route in server/route-policy.ts, with the reason.
    expect(unclassified, "routes with no class").toEqual([]);
    expect(ambiguous, "requests two entries classify differently").toEqual([]);
    expect(stale.map(entry => `${entry.methods} ${entry.path}`), "entries that match no route").toEqual([]);
    expect(arrived.map(entry => `${entry.arrives}: ${entry.methods} ${entry.path}`), "a lane's routes arrived: drop `arrives`").toEqual([]);
    for (const entry of ROUTE_POLICY) expect(entry.why.length, `${entry.path}`).toBeGreaterThan(10);
  });

  // Audit C5: walk the table, do not hand-list. Every request the dispatcher
  // answers whose class is conversation is refused with the plain 404 when the
  // caller proved nothing (a bare loopback request, a bot's shell without its
  // credential) and admitted for each proof the real callers hold.
  it("(C5) a bare loopback request gets the unknown-route 404 on every conversation-class route", () => {
    const nobody = { desktop: false, companion: false, door: false, bot: false };
    const conversation = requests(discoverRoutes()).filter(item => item.entries.length > 0 && item.entries[0].class === "conversation");
    expect(conversation.length).toBeGreaterThanOrEqual(40);
    const open: string[] = [];
    for (const item of conversation) {
      const klass = routeClass(item.method, item.sample);
      if (routeAdmits(klass, nobody)) open.push(`${item.method} ${item.sample}`);
      else expect(routeRefusal(nobody), `${item.method} ${item.sample}`).toEqual({ status: 404, body: { error: "no such route" } });
      for (const who of ["desktop", "companion", "door"] as const) expect(routeAdmits(klass, { ...nobody, [who]: true }), `${who} ${item.method} ${item.sample}`).toBe(true);
      // a bot's capability is never proof on a conversation route, and gets the unknown-route 404
      expect(routeAdmits(klass, { ...nobody, bot: true }), `bot ${item.method} ${item.sample}`).toBe(false);
      expect(routeRefusal({ ...nobody, bot: true }, klass), `bot ${item.method} ${item.sample}`).toEqual({ status: 404, body: { error: "no such route" } });
    }
    expect(open, "conversation routes a caller with no proof reaches").toEqual([]);
  });

  it("an unclassified route is desktop-only; the named holes are closed", () => {
    expect(routeClass("POST", "/api/a-route-added-tomorrow")).toBe("desktop");
    expect(routeClass("GET", "/api/decisions")).toBe("desktop");
    expect(routeClass("GET", "/api/flux-connection")).toBe("desktop");
    expect(routeClass("POST", "/api/flux-connection/test")).toBe("desktop");
    expect(routeClass("GET", "/api/media/bytes/asset-1")).toBe("media");
    expect(routeClass("POST", "/api/internal/ask-bot")).toBe("internal");
    expect(routeClass("GET", "/api/inbox")).toBe("companion");
    expect(routeClass("POST", "/api/bots/b1/messages")).toBe("conversation");
    expect(routeClass("PATCH", "/api/bots/b1/cards/m1")).toBe("companion");
  });

  it("refuses with the sentence only a caller that proved who it is", () => {
    const nobody = { desktop: false, companion: false, door: false, bot: false };
    expect(routeAdmits("desktop", nobody)).toBe(false);
    expect(routeAdmits("desktop", { ...nobody, desktop: true })).toBe(true);
    expect(routeAdmits("companion", nobody)).toBe(false);
    expect(routeAdmits("companion", { ...nobody, companion: true })).toBe(true);
    expect(routeAdmits("companion", { ...nobody, bot: true })).toBe(false);
    for (const open of ["health", "internal", "media", "extension"] as const) expect(routeAdmits(open, nobody)).toBe(true);
    // Audit C5: a conversation route needs a proven caller; a bare loopback request is nobody.
    expect(routeAdmits("conversation", nobody)).toBe(false);
    for (const who of ["desktop", "companion", "door"] as const) expect(routeAdmits("conversation", { ...nobody, [who]: true }), who).toBe(true);
    // a bot's own capability admits no conversation route, whatever else it holds
    expect(routeAdmits("conversation", { ...nobody, bot: true })).toBe(false);
    expect(routeAdmits("conversation", { ...nobody, bot: true, door: false, companion: false })).toBe(false);
    expect(routeRefusal({ ...nobody, bot: true }, "conversation")).toEqual({ status: 404, body: { error: "no such route" } });
    expect(routeRefusal({ ...nobody, door: true })).toEqual({ status: 404, body: { error: "no such route" } });
    expect(routeRefusal(nobody)).toEqual({ status: 404, body: { error: "no such route" } });
    expect(routeRefusal({ ...nobody, bot: true })).toEqual({ status: 403, body: { error: DESKTOP_ONLY_SENTENCE } });
    expect(routeRefusal({ ...nobody, companion: true })).toEqual({ status: 403, body: { error: DESKTOP_ONLY_SENTENCE } });
    expect(DESKTOP_ONLY_SENTENCE).toBe("This needs the Murage app on your computer.");
  });

  // The renderer reaches desktop routes through api() and the other helpers
  // that add the desktop's proof. A bare fetch of a desktop route answers
  // 404 on the desktop itself: PATCH /api/bots/:id/cards/:m did, silently.
  it("every renderer fetch of a desktop route carries the desktop's proof", () => {
    const root = join(import.meta.dirname, "..", "src");
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { if (name !== "e2e") walk(path); continue; }
        if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
        const sf = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        const visit = (node: ts.Node) => {
          if (ts.isCallExpression(node) && node.expression.getText(sf) === "fetch" && node.arguments[0]) {
            const target = node.arguments[0];
            const text = ts.isStringLiteral(target) || ts.isNoSubstitutionTemplateLiteral(target) ? target.text
              // an id after a slash; a query string or suffix glued on otherwise
              : ts.isTemplateExpression(target) ? target.templateSpans.reduce((out, span) => out + (out.endsWith("/") ? "x1" : "") + span.literal.text, target.head.text) : "";
            const options = node.arguments[1];
            const methodProperty = options && ts.isObjectLiteralExpression(options)
              ? options.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(sf) === "method") as ts.PropertyAssignment | undefined : undefined;
            const method = methodProperty && ts.isStringLiteral(methodProperty.initializer) ? methodProperty.initializer.text : "GET";
            const route = text.replace(/[?#].*$/, "");
            // desktop and companion routes both answer 404 to a bare fetch from
            // the desktop (callRouteHeaders, voice-host.ts, carries the proof)
            if (route.startsWith("/api/") && ["desktop", "companion"].includes(routeClass(method, route)) && !/x-murage-surface|desktopSurfaceHeaders|callRouteHeaders/.test(options?.getText(sf) ?? ""))
              found.push(`${path.slice(root.length + 1)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${method} ${route}`);
          }
          ts.forEachChild(node, visit);
        };
        visit(sf);
      }
    };
    walk(root);
    expect(found).toEqual([]);
  });

  // The hidden-bot rule at the gate covers every route a caller that is not
  // the desktop may use on one bot or one room (Kimi round 3, M1). A new
  // conversation route under /api/bots/:id or /api/groups/:id fails here
  // until conversationSubject names it, or the reason it checks itself is
  // written down below.
  it("the hidden-bot rule covers every non-desktop route on one bot or room", () => {
    const OWN_CHECK: Record<string, string> = {
      voice: "voice-host and call-note check visibility in callAccess",
      browser: "the browser relay checks visibleToCompanion itself",
      join: "computer/join checks the bot and the phone's per-device capability",
    };
    const all = requests(discoverRoutes());
    const uncovered = all.filter(item => item.entries.length > 0 && !["desktop", "internal", "media", "health"].includes(item.entries[0].class)
      && /^\/api\/(?:bots|groups)\/[^/]+\/./.test(item.sample) && !conversationSubject(item.sample))
      .filter(item => !(/\/(?:voice-host|call-note)$/.test(item.sample) || /\/browser(?:\/frame)?$/.test(item.sample) || item.sample.endsWith("/computer/join")))
      .map(item => `${item.method} ${item.sample}`);
    expect(uncovered).toEqual([]);
    expect(Object.keys(OWN_CHECK)).toHaveLength(3);
    expect(conversationSubject("/api/bots/b1/messages")).toEqual({ scope: "bot", botId: "b1" });
    expect(conversationSubject("/api/bots/b1/messages/m1/edit")).toEqual({ scope: "bot", botId: "b1" });
    expect(conversationSubject("/api/groups/g1/tasks/t1")).toEqual({ scope: "group", groupId: "g1" });
    expect(conversationSubject("/api/bots/b1/memory")).toBeNull();
  });

  // (b) A fixture built the way server/index.ts is: a createServer if-chain
  // behind the same gate, with a route added and never classified. The
  // discovery sees it, the strict check names it, and at runtime a bot's
  // token gets the sentence while a plain request learns nothing.
  it("(b) an injected unclassified route is desktop-only, and the strict check names it", async () => {
    const root = join(scratch, "fixture");
    mkdirSync(join(root, "server"), { recursive: true });
    writeFileSync(join(root, "server", "index.ts"), [
      'import { createServer } from "node:http";',
      "const server = createServer(async (req, res) => {",
      '  const path = new URL(req.url ?? "/", "http://x").pathname, method = req.method ?? "GET";',
      '  if (method === "GET" && path === "/api/bots") return;',
      '  if (method === "POST" && path === "/api/fixture-new-admin") return;',
      "});",
    ].join("\n"));
    const found = requests(discoverRoutes(root)).filter(item => item.entries.length === 0).map(item => `${item.method} ${item.sample}`);
    expect(found).toEqual(["POST /api/fixture-new-admin"]);

    const BOT_TOKEN = "Bearer " + "b".repeat(48);
    const DESKTOP = "fixture-desktop-secret";
    const callerOf = (req: IncomingMessage) => ({ desktop: req.headers["x-fixture-desktop"] === DESKTOP, companion: false, door: false, bot: req.headers.authorization === BOT_TOKEN });
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://x").pathname, method = req.method ?? "GET";
      const reply = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      const caller = callerOf(req);
      const klass = routeClass(method, path);
      if (!routeAdmits(klass, caller)) { const refusal = routeRefusal(caller, klass); return reply(refusal.status, refusal.body); }
      if (method === "GET" && path === "/api/bots") return reply(200, { bots: [] });
      if (method === "POST" && path === "/api/fixture-new-admin") return reply(200, { changed: true });
      return reply(404, { error: "no such route" });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as { port: number };
    const call = async (headers: Record<string, string>) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/fixture-new-admin`, { method: "POST", headers });
      return { status: response.status, body: await response.json() };
    };
    try {
      expect(await call({ authorization: BOT_TOKEN })).toEqual({ status: 403, body: { error: DESKTOP_ONLY_SENTENCE } });
      expect(await call({})).toEqual({ status: 404, body: { error: "no such route" } });
      expect(await call({ "x-fixture-desktop": DESKTOP })).toEqual({ status: 200, body: { changed: true } });
      // a bot's capability never opens a conversation route
      expect(await (await fetch(`http://127.0.0.1:${port}/api/bots`, { headers: { authorization: BOT_TOKEN } })).json()).toEqual({ error: "no such route" });
      expect((await fetch(`http://127.0.0.1:${port}/api/bots`, { headers: { "x-fixture-desktop": DESKTOP } })).status).toBe(200);
    } finally {
      server.close();
    }
  });
});
