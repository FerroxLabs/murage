// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.61 L0a (plan 4.2a): the route discovery reads the real dispatcher.
// The harness has no route table (server/index.ts is a createServer if-chain
// plus delegated handler modules), so the deny-by-default policy is checked
// against what server/testing/route-discovery.ts reads out of the source.
// These tests hold the reader to the shapes the dispatcher uses, on a
// fixture and on the real server; route-policy.test.ts classifies what it
// finds.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { describeRoute, discoverRoutes, regexSamples, type DiscoveredRoute } from "./testing/route-discovery.ts";

const scratch = mkdtempSync(join(tmpdir(), "murage-route-discovery-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const find = (routes: DiscoveredRoute[], pattern: string, kind?: DiscoveredRoute["kind"]) => routes.find(route => route.pattern === pattern && (!kind || route.kind === kind));

describe("route discovery", () => {
  it("reads every routing shape the dispatcher uses, with its methods", () => {
    mkdirSync(join(scratch, "server"), { recursive: true });
    writeFileSync(join(scratch, "server", "prefixes.ts"), 'export const FILES_PREFIX = "/api/files-tree";\nexport const FILES_ROUTES = { list: `${FILES_PREFIX}/list` } as const;\n');
    writeFileSync(join(scratch, "server", "files.ts"), [
      'import { FILES_PREFIX, FILES_ROUTES } from "./prefixes.ts";',
      "export function filesRoute(request: { method: string; path: string }) {",
      "  const rest = request.path.slice(FILES_PREFIX.length);",
      '  if (request.path === FILES_ROUTES.list && request.method === "GET") return 1;',
      '  if (rest === "/stats") return 2;',
      "  return 0;",
      "}",
    ].join("\n"));
    writeFileSync(join(scratch, "server", "index.ts"), [
      'import { createServer } from "node:http";',
      'import { filesRoute } from "./files.ts";',
      'import { FILES_PREFIX } from "./prefixes.ts";',
      'const HOOK = /^\\/api\\/hooks\\/([\\w-]+)$/;',
      "const server = createServer(async (req, res) => {",
      '  const path = new URL(req.url ?? "/", "http://x").pathname, method = req.method ?? "GET";',
      "  let m: RegExpMatchArray | null = null;",
      '  if (method === "GET" && path === "/api/plain") return;',
      '  if ((method === "GET" || method === "POST") && /^\\/api\\/bots\\/([\\w-]+)$/.test(path)) return;',
      '  m = path.match(/^\\/api\\/rooms\\/([\\w-]+)\\/(read|seen)$/);',
      '  if (m && method === "POST") return;',
      '  const hook = HOOK.exec(path);',
      '  if (hook && ["PUT", "DELETE"].includes(method)) return;',
      '  if (path.startsWith("/api/tree/")) { if (path === "/api/tree/leaf") return; }',
      '  if (["/api/one", "/api/two"].includes(path) && method === "POST") return;',
      "  const prefix = [FILES_PREFIX].find(item => path === item || path.startsWith(`${item}/`));",
      "  if (prefix) return filesRoute({ method, path });",
      '  if (!path.startsWith("/api/")) return;',
      '  const label = path === "/api/label" ? "a" : "b";',
      "});",
    ].join("\n"));
    const routes = discoverRoutes(scratch);
    const shown = routes.map(describeRoute).join("\n");
    expect(find(routes, "/api/plain")?.methods, shown).toEqual(["GET"]);
    expect(find(routes, "^\\/api\\/bots\\/([\\w-]+)$")?.methods, shown).toEqual(["GET", "POST"]);
    expect(find(routes, "^\\/api\\/rooms\\/([\\w-]+)\\/(read|seen)$"), shown).toMatchObject({ methods: ["POST"], samples: ["/api/rooms/a/read", "/api/rooms/a/seen"] });
    expect(find(routes, "^\\/api\\/hooks\\/([\\w-]+)$")?.methods, shown).toEqual(["DELETE", "PUT"]);
    expect(find(routes, "/api/tree", "prefix")?.methods, shown).toBeNull();
    expect(find(routes, "/api/tree/leaf")?.kind, shown).toBe("exact");
    expect(find(routes, "/api/one")?.methods, shown).toEqual(["POST"]);
    expect(find(routes, "/api/two")?.methods, shown).toEqual(["POST"]);
    // the find(prefix => ...) idiom, and the module it hands the path to
    expect(find(routes, "/api/files-tree", "prefix"), shown).toBeDefined();
    expect(find(routes, "/api/files-tree/list"), shown).toMatchObject({ file: "server/files.ts", methods: ["GET"] });
    expect(find(routes, "/api/files-tree/stats")?.file, shown).toBe("server/files.ts");
    // `!path.startsWith(...)` and a path compared to pick a value are not routes
    expect(find(routes, "/api"), shown).toBeUndefined();
    expect(find(routes, "/api/label"), shown).toBeUndefined();
  });

  it("regex samples cover every alternative and optional part, and match their regex", () => {
    expect(regexSamples(/^\/api\/routines\/([\w-]+)\/always-allow(\/remove)?$/)).toEqual(["/api/routines/a/always-allow", "/api/routines/a/always-allow/remove"]);
    expect(regexSamples(/^\/api\/artifacts\/([a-f0-9-]{36})$/)).toEqual([`/api/artifacts/${"a".repeat(36)}`]);
    expect(regexSamples(/^\/api\/mcp\/servers\/([a-z][a-z0-9_-]{0,31})$/)).toEqual(["/api/mcp/servers/aa"]);
  });

  it("finds at least 200 routes on the real server, each with a request path it answers", () => {
    const routes = discoverRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(200);
    expect(routes.filter(route => route.samples.length === 0).map(describeRoute)).toEqual([]);
    // A route narrowed to no method at all would be checked for none (audit round 2, Kimi M4).
    expect(routes.filter(route => route.methods !== null && route.methods.length === 0).map(describeRoute)).toEqual([]);
    // house-rules.ts answers GET, PUT and a 405 for any other method, so
    // every method is checked (audit round 3, Astra r2 M4: PUT was dropped)
    expect(find(routes, "/api/house-rules")?.methods).toBeNull();
    expect(find(routes, "/api/about-me")?.methods ?? ["GET", "PUT"]).toEqual(expect.arrayContaining(["GET", "PUT"]));
    // Each shape is seen on the real dispatcher and its delegated modules.
    expect(find(routes, "/api/decisions")?.methods).toEqual(["GET"]);
    expect(find(routes, "/api/internal", "prefix")).toBeDefined();
    expect(find(routes, "^\\/api\\/bots\\/([\\w-]+)\\/voice-host$")?.methods).toEqual(["POST"]);
    expect(find(routes, "/api/media/bytes", "prefix")).toBeDefined();
    expect(find(routes, "/api/workspace-files/read")?.file).toBe("server/workspace-files.ts");
    expect(find(routes, "/api/local-models/preflight")?.file).toBe("server/local-models.ts");
    expect(find(routes, "/api/internal/memory/search")?.file).toBe("server/memory/routes.ts");
    expect(find(routes, "/api/provider-connections/replace")?.methods).toEqual(["POST"]);
    // `if (path !== MEDIA_ROUTES.resolve) return ...` (audit round 1, Astra M6)
    expect(find(routes, "/api/media/resolve")?.file).toBe("server/media-assets.ts");
  });
});
