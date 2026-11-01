// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Contract 4.2, strict: every route the real dispatcher answers has exactly
// one class in route-policy.ts, and a route nobody classified is
// desktop-only. (a) discovery over the real source, (b) an injected route in
// a fixture built on the real routing pattern and the real gate.
// route-policy-api.test.ts is (c), the sweep against a running server.
import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import { afterAll, describe, expect, it, vi } from "vitest";
import { cloudHomeCopy } from "./cloud-home/copy.ts";
import { createCloudRequestAuth, stepPurpose } from "./cloud-request-auth.ts";
import { CloudSessions, type CloudScope } from "./cloud-sessions.ts";
import { FolderTrustStore } from "./folder-trust.ts";
import { cloudRouteDecision, conversationSubject, DESKTOP_ONLY_SENTENCE, ROUTE_POLICY, routeAdmits, routeClass, routePolicy, routeRefusal, type RoutePolicyEntry } from "./route-policy.ts";
import { describeRoute, discoverRoutes, type DiscoveredRoute } from "./testing/route-discovery.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
describe("Cloud write classifications", () => {
  it("every real write entry carries an explicit reviewed policy", () => {
    const writes = ROUTE_POLICY.filter(entry => entry.methods === "*" || entry.methods.some(method => !["GET","HEAD","OPTIONS"].includes(method)));
    expect(writes.length).toBeGreaterThan(90);
    expect(writes.filter(entry => !entry.cloudWrite).map(entry => `${entry.methods} ${entry.path}`)).toEqual([]);
    expect(cloudRouteDecision("POST", "/api/unreviewed-permission-writer", "owner-desktop", {})).toBe("step-up required");
  });
  it("ordinary task and routine deletion and non-elevating bot edits remain ordinary", () => {
    for (const path of ["/api/bots/b1/tasks/t1", "/api/routines/r1"]) expect(cloudRouteDecision("DELETE",path,"owner-desktop",{})).toBe("allow");
    expect(cloudRouteDecision("PATCH","/api/bots/b1","owner-desktop",{autoApprove:false})).toBe("allow");
  });
});
const scratch = mkdtempSync(join(tmpdir(), "murage-route-policy-"));
afterAll(() => removeTempDirSync(scratch));

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

  // 1.0.3 R1.10: Settings > Storage's attachment list has its own desktop entry, and every caller but the desktop is refused.
  it("F31 (U36): the send lookup GET /api/sends/:threadId/:sendId is a conversation route, so a paired companion can ask too", () => {
    expect(routeClass("GET", "/api/sends/t1/s1")).toBe("conversation");
    expect(routePolicy("GET", "/api/sends/t1/s1")?.class).toBe("conversation");
  });

  it("the Storage attachment list is desktop class by an explicit entry; phone, door, bot and nobody are refused", () => {
    const entry = routePolicy("GET", "/api/storage/attachments");
    expect(entry?.class).toBe("desktop");
    expect(entry?.path).toBe("/api/storage/attachments");
    const nobody = { desktop: false, companion: false, door: false, bot: false };
    expect(routeAdmits("desktop", { ...nobody, desktop: true })).toBe(true);
    for (const who of ["companion", "door", "bot"] as const) expect(routeAdmits(routeClass("GET", "/api/storage/attachments"), { ...nobody, [who]: true }), who).toBe(false);
    expect(routeAdmits(routeClass("GET", "/api/storage/attachments"), nobody)).toBe(false);
    expect(routeAdmits(routeClass("GET", "/api/storage/attachments"), { ...nobody, companion: true, door: true })).toBe(false);
    expect(routeRefusal({ ...nobody, companion: true }, "desktop")).toEqual({ status: 403, body: { error: DESKTOP_ONLY_SENTENCE } });
    expect(routeRefusal(nobody, "desktop")).toEqual({ status: 404, body: { error: "no such route" } });
  });

  // 1.0.4 SL-H: Remove is desktop class, and refused on every Cloud scope, stepped up or not (local desktop only).
  it("Storage Remove is desktop class; phone, door, bot and nobody are refused, and every Cloud scope is denied", () => {
    const route = "/api/storage/attachments/remove";
    expect(routePolicy("POST", route)).toMatchObject({ class: "desktop", path: route });
    const nobody = { desktop: false, companion: false, door: false, bot: false };
    for (const who of ["companion", "door", "bot"] as const) expect(routeAdmits(routeClass("POST", route), { ...nobody, [who]: true }), who).toBe(false);
    expect(routeAdmits(routeClass("POST", route), nobody)).toBe(false);
    for (const scope of ["owner-desktop", "owner-phone", "browser", "service", "owner-browser", "anonymous"] as const) {
      for (const steppedUp of [false, true]) expect(cloudRouteDecision("POST", route, scope, { names: [] }, steppedUp), `${scope} ${steppedUp}`).toBe("deny");
    }
    // the list keeps its own answer
    expect(cloudRouteDecision("GET", "/api/storage/attachments", "owner-browser", null)).toBe("allow");
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

  it("the terms status is readable by a door caller without the launch proof; accepting stays on the companion", () => {
    const nobody = { desktop: false, companion: false, door: false, bot: false };
    expect(routeClass("GET", "/api/terms")).toBe("conversation");
    expect(routeAdmits(routeClass("GET", "/api/terms"), { ...nobody, door: true })).toBe(true);
    expect(routeAdmits(routeClass("GET", "/api/terms"), nobody)).toBe(false);
    expect(routeAdmits(routeClass("GET", "/api/terms"), { ...nobody, bot: true })).toBe(false);
    expect(routeClass("POST", "/api/terms/accept")).toBe("companion");
    expect(routeAdmits(routeClass("POST", "/api/terms/accept"), { ...nobody, door: true })).toBe(false);
    expect(routeAdmits(routeClass("POST", "/api/terms/accept"), { ...nobody, companion: true })).toBe(true);
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
            // the desktop (callRouteHeaders, voice-host.ts, and desktopCallerHeaders, live-events.ts, carry the proof)
            if (route.startsWith("/api/") && ["desktop", "companion"].includes(routeClass(method, route)) && !/x-murage-surface|desktopSurfaceHeaders|desktopCallerHeaders|callRouteHeaders/.test(options?.getText(sf) ?? ""))
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

describe("/api/folder-trust on a Cloud home (FUIGO-TRUST-V2 S7)", () => {
  const route = "/api/folder-trust";
  it("refuses the owner's phone on every method, stepped up or not, and keeps the other scopes as they were", () => {
    for (const method of ["GET", "HEAD", ...ALL_METHODS]) for (const steppedUp of [false, true]) {
      expect(cloudRouteDecision(method, route, "owner-phone", {}, steppedUp), `${method} ${steppedUp}`).toBe("deny");
    }
    for (const scope of ["owner-desktop", "owner-browser"] as const) {
      expect(cloudRouteDecision("GET", route, scope, {}), scope).toBe("allow");
      for (const method of ["POST", "DELETE"]) {
        expect(cloudRouteDecision(method, route, scope, {}), `${scope} ${method}`).toBe("step-up required");
        expect(cloudRouteDecision(method, route, scope, {}, true), `${scope} ${method} stepped up`).toBe("allow");
      }
    }
    for (const scope of ["remembered-owner", "browser", "service", "anonymous"] as const) expect(cloudRouteDecision("GET", route, scope, {}), scope).toBe("deny");
    // the phone keeps its ordinary owner reads
    expect(cloudRouteDecision("GET", "/api/bots", "owner-phone", {})).toBe("allow");
  });

  it("the real Cloud gate stops the phone before the store; the desktop and the passkey browser still read and forget", async () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    const origin = "https://home.example", rpId = "home.example";
    const root = mkdtempSync(join(tmpdir(), "route-policy-trust-")), file = join(root, "folder-trust.json");
    const sessions = new CloudSessions(new DatabaseSync(":memory:"), undefined, origin);
    const folderTrust = new FolderTrustStore(file);
    const folder = (name: string) => { const path = join(root, name); mkdirSync(path); return path; };
    const declined = folderTrust.remember(folder("declined"), "reject", "card")!;
    const pair = (scope: CloudScope) => {
      const key = generateKeyPairSync("ed25519"), factor = generateKeyPairSync("ed25519");
      const code = sessions.mint({ account: "owner", scope, publicKey: key.publicKey.export({ type: "spki", format: "pem" }).toString(), assertionKey: factor.publicKey.export({ type: "spki", format: "pem" }).toString() });
      const message = Buffer.from(`murage-pair:${sessions.environmentId}:${code}:owner`);
      const paired = sessions.redeem(code, "owner", sign(null, message, key.privateKey).toString("base64url"), sign(null, message, factor.privateKey).toString("base64url"));
      const stepUp = (method: string, path: string, body: unknown) => {
        const purpose = stepPurpose(method, path, body), challenge = sessions.challenge(paired.deviceId, purpose), at = Date.now();
        const signature = sign(null, Buffer.from(`murage:${sessions.environmentId}:${paired.deviceId}:${purpose}:${challenge}:${at}`), factor.privateKey).toString("base64url");
        return { "x-murage-step-up": Buffer.from(JSON.stringify({ challenge, at, signature })).toString("base64url") };
      };
      return { auth: { authorization: `Bearer ${paired.accessToken}` }, stepUp };
    };
    // The owner's passkey browser, as cloud-owner-browser.test.ts writes one: P-256 keys and a saved WebAuthn factor.
    const passkeyBrowser = () => {
      const pem = (key: { publicKey: KeyObject }) => key.publicKey.export({ format: "pem", type: "spki" }).toString();
      const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }), confirm = generateKeyPairSync("ec", { namedCurve: "prime256v1" }), id = randomUUID();
      sessions.db.prepare("INSERT OR IGNORE INTO cloud_meta VALUES ('account','owner')").run();
      sessions.db.prepare("INSERT INTO cloud_devices (id,account,scope,publicKey,assertionKey,revoked,addedAt,lastSeenAt) VALUES (?,?,?,?,?,0,?,?)").run(id, "owner", "browser", pem(key), pem(confirm), 0, 0);
      sessions.db.prepare("INSERT INTO cloud_browser_factors (device,payload) VALUES (?,?)").run(id, JSON.stringify({ origin, rpId, credentialId: "fixture-credential", counter: 1 }));
      const { accessToken, deviceId } = sessions.issue(id);
      let counter = 1;
      const stepUp = (method: string, path: string, body: unknown) => {
        const purpose = stepPurpose(method, path, body), challenge = sessions.challenge(deviceId, purpose), at = Date.now();
        const message = `murage:${sessions.environmentId}:${deviceId}:${purpose}:${challenge}:${at}`;
        const client = Buffer.from(JSON.stringify({ type: "webauthn.get", origin, crossOrigin: false, challenge: Buffer.from(message).toString("base64url") }));
        const authData = Buffer.alloc(37); createHash("sha256").update(rpId).digest().copy(authData); authData[32] = 5; authData.writeUInt32BE(++counter, 33);
        const signature = sign("sha256", Buffer.concat([authData, createHash("sha256").update(client).digest()]), confirm.privateKey).toString("base64url");
        return { "x-murage-step-up": Buffer.from(JSON.stringify({ challenge, at, webauthn: { credentialId: "fixture-credential", clientDataJSON: client.toString("base64url"), authenticatorData: authData.toString("base64url"), signature } })).toString("base64url") };
      };
      return { auth: { cookie: `__Host-murage=${accessToken}` }, stepUp };
    };
    // Stands in for the dispatcher's handler on the real store: anything that gets past the gate acts.
    let reached = 0;
    const gate = createCloudRequestAuth({ sessions, publicOrigin: origin, bootstrapSecret: () => "fixture-bootstrap-key-32-characters" });
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, origin);
      if (await gate(req, res, url)) return;
      reached++;
      if (req.method === "POST") folderTrust.remember(join(root, "declined"), "trust", "card");
      if (req.method === "DELETE") folderTrust.forgetKey(url.searchParams.get("key") ?? "");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ records: folderTrust.list() }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const call = (method: string, path: string, headers: Record<string, string>) => new Promise<{ status: number; body: any }>((resolve, reject) => {
      const data = method === "GET" ? undefined : Buffer.from("{}");
      const req = request({ host: "127.0.0.1", port, method, path, agent: false, headers: { host: "home.example", origin, "content-type": "application/json", ...(data ? { "content-length": String(data.length) } : {}), ...headers } }, res => {
        const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      req.on("error", reject); req.end(data);
    });
    try {
      const forget = (key: string) => `${route}?key=${encodeURIComponent(key)}`;
      const phone = pair("owner-phone"), desktop = pair("owner-desktop"), browser = passkeyBrowser();
      const before = readFileSync(file, "utf8");
      const refused = { status: 403, body: { error: cloudHomeCopy.phoneCredential } };
      expect(await call("GET", `${route}?folder=${encodeURIComponent(root)}`, phone.auth)).toEqual(refused);
      for (const [method, path] of [["POST", route], ["DELETE", forget(declined)]] as const) {
        expect(await call(method, path, phone.auth), method).toEqual(refused);
        expect(await call(method, path, { ...phone.auth, ...phone.stepUp(method, path, {}) }), `${method} signed`).toEqual(refused);
      }
      expect(reached).toBe(0);
      expect(readFileSync(file, "utf8")).toBe(before);

      // The owner's two surfaces keep what they had: a read, and a Forget and a Trust on a fresh step-up.
      for (const [name, owner] of [["desktop", desktop], ["passkey browser", browser]] as const) {
        const kept = folder(`kept-${name.replace(" ", "-")}`), key = folderTrust.remember(kept, "reject", "card")!;
        const read = await call("GET", route, owner.auth);
        expect(read.status, name).toBe(200);
        expect((read.body.records as Array<{ key: string }>).map(record => record.key), name).toContain(key);
        expect((await call("DELETE", forget(key), owner.auth)).status, name).toBe(403);
        expect(folderTrust.record(kept)?.decision, name).toBe("reject");
        const forgotten = await call("DELETE", forget(key), { ...owner.auth, ...owner.stepUp("DELETE", forget(key), {}) });
        expect(forgotten.status, name).toBe(200);
        expect(folderTrust.record(kept), name).toBeUndefined();
        expect((await call("POST", route, { ...owner.auth, ...owner.stepUp("POST", route, {}) })).status, name).toBe(200);
      }
    } finally {
      const closed = once(server, "close");
      server.close(); server.closeAllConnections(); await closed;
      sessions.db.close();
      removeTempDirSync(root);
      vi.unstubAllEnvs();
    }
  });
});

describe("the restore-hold routes are listed by name as desktop-only", () => {
  it("each has its own entry (not the default), is desktop class, and no other caller is admitted", () => {
    const own = (method: string, path: string) => ROUTE_POLICY.filter(entry => matches(entry, method, path));
    for (const [method, path] of [["GET", "/api/restore-holds"], ["POST", "/api/restore-holds/output_receipt/abc-1/release"], ["POST", "/api/restore-holds/shared_result/req_9/release"]] as const) {
      expect(own(method, path), `${method} ${path}`).toHaveLength(1);
      expect(routeClass(method, path)).toBe("desktop");
    }
    expect(own("POST", "/api/restore-holds/other_kind/abc/release")).toHaveLength(0);
    expect(own("DELETE", "/api/restore-holds")).toHaveLength(0);
  });
});
