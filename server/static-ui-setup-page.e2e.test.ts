// SPDX-License-Identifier: AGPL-3.0-or-later
// WIN-NOROUTE-1019 T8 (design A10): the REAL server entry (server/index.ts) with MURAGE_STATIC_DIR at a temp ui folder,
// an isolated data dir and a free port. With no index.html a page load gets the HTML setup page (503), never
// {"error":"no route"}; when index.html is back the very next load is the app. Every other request keeps the JSON bytes.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const NAV = { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none", accept: "text/html,*/*;q=0.8" };

it.skipIf(process.platform === "win32")("T8 the real server answers a page load with the setup page while index.html is missing, and the app the moment it is back", async () => {
  const home = mkdtempSync(join(tmpdir(), "murage-setup-page-")), data = join(home, "data"), staticDir = join(home, "static");
  mkdirSync(data); mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Packaged Murage</title>");
  writeFileSync(join(staticDir, "assets", "smoke.css"), "body{color:white}");
  const port = await freePortBlock([0, 1]);
  let child: ChildProcess | undefined, stderr = "", stdout = "";
  const get = (path: string, headers: Record<string, string> = NAV, method = "GET") => new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let body = ""; res.setEncoding("utf8"); res.on("data", (c) => { body += c; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject); req.end();
  });
  const noRoute = (method: string, path: string) => JSON.stringify({ error: `no route: ${method} ${path}` });
  try {
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, MURAGE_DATA_DIR: data, MURAGE_STATIC_DIR: staticDir, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_DEV_DESKTOP_SECRET: "ab".repeat(32), MURAGE_STATIC_UI_TRACE: "1", PATH: process.env.PATH };
    child = spawn(process.execPath, [join(root, "server/index.ts")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr!.on("data", (c) => { stderr += c; }); child.stdout!.on("data", (c) => { stdout += c; });
    await expect.poll(async () => { if (child!.exitCode !== null) throw new Error(stderr); try { return (await get("/api/health", {})).status; } catch { return 0; } }, { timeout: 30000 }).toBe(200);

    // With the app in place a page load is the app.
    const app = await get("/");
    expect(app.status).toBe(200);
    expect(app.body).toContain("Packaged Murage");

    // The files go away (an update copying, antivirus): a page load is the setup page.
    renameSync(join(staticDir, "index.html"), join(staticDir, "index.html.away"));
    const setup = await get("/");
    expect(setup.status).toBe(503);
    expect(String(setup.headers["content-type"])).toBe("text/html; charset=utf-8");
    expect(setup.headers["retry-after"]).toBe("3");
    expect(setup.headers["cache-control"]).toBe("no-store");
    expect(String(setup.headers["content-security-policy"])).toContain("default-src 'none'");
    expect(setup.body).toContain('http-equiv="refresh"');
    expect(setup.body).not.toMatch(/"error"|no route/);
    expect((await get("/deep/route?x=1")).status).toBe(503);
    const head = await get("/", NAV, "HEAD");
    expect(head.status).toBe(503);
    expect(head.body).toBe("");
    // The same request as an accept-html fetch with no sec-fetch headers (an older shell) is still a page load.
    expect((await get("/", { accept: "text/html" })).status).toBe(503);

    // Everything that is not a page load keeps today's JSON 404, byte for byte.
    for (const [path, headers] of [["/", { accept: "application/json" }], ["/", { accept: "*/*" }], ["/missing.js", { "sec-fetch-dest": "script", "sec-fetch-mode": "no-cors", accept: "*/*" }], ["/", { "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate", accept: "text/html" }], ["/.hidden", NAV], ["/a//b", NAV]] as const) {
      const res = await get(path, { ...headers });
      expect([path, res.status, res.body]).toEqual([path, 404, noRoute("GET", path)]);
      expect(String(res.headers["content-type"])).toContain("application/json");
    }
    const api404 = await get("/api/nope", NAV); // /api never gets the setup page, whatever the headers say
    expect([api404.status, String(api404.headers["content-type"])]).toEqual([404, "application/json"]);
    expect((await get("/assets/smoke.css", { "sec-fetch-dest": "style", accept: "text/css" })).status).toBe(200);
    expect((await get("/api/health", {})).status).toBe(200);

    // The files come back: the very next load is the app.
    renameSync(join(staticDir, "index.html.away"), join(staticDir, "index.html"));
    const back = await get("/deep/route");
    expect(back.status).toBe(200);
    expect(back.body).toContain("Packaged Murage");

    // server.log: the reason once, the setup page line once, and (trace on) every document response with its type.
    expect(stdout).toContain("static ui: cannot serve the app page (missing ENOENT)");
    expect(stdout.match(/static ui: served the setup page \(missing ENOENT\)/g)?.length).toBe(1);
    expect(stdout).toMatch(/static ui: page 503 text\/html/);
    expect(stdout).toMatch(/static ui: page 200 text\/html/);
  } finally {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  }
}, 120_000);
