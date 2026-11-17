// secret-scan: fixture (fake addresses and fake tokens)
// 1.0.19 Settings email Keep/Remove screen (restore-park r3.4b): the real section over the real HTTP client with the owner routes
// mocked in their final shapes (GET /api/email/status; POST /api/email/bots/:botId/keep|remove; POST /api/email/other-setups/:inboxId/remove),
// at a desktop and a phone (390x844) viewport. A restore window refuses with restore_finishing; once it is over a Remove carries the token
// of the latest view, the plain bot-row Keep sends no token at all, and a refusal's line is shown exactly as the server gave it.
import { test, expect } from "./page-error-guard";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let vite: ViteDevServer, origin: string;
const WINDOW_LINE = "A restore is finishing. Try again in a minute.";
const RECONFIRM = "Choose Keep or Remove again for this bot's email.";
const FAILED_LINE = "That restore did not finish. Nothing changed. You can try again.";

test.beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "murage-email-keep-remove-"));
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  vite = await createServer({ configFile: false, root: repo, envFile: false, cacheDir: join(root, "vite-cache"),
    resolve: { alias: { "@": join(repo, "src") } }, server: { host: "127.0.0.1", watch: null, hmr: false }, plugins: [react(), tailwindcss(), {
      name: "email-keep-remove-fixture", enforce: "pre",
      resolveId(id) {
        if (id === "/__ekr.js") return "\0ekr-fixture";
        if (id === "@/state/store" || /\/src\/state\/store(?:\.tsx?)?$/.test(id)) return "\0ekr-api";
      },
      load(id) {
        // The real api() contract: JSON in and out, and a refusal is an Error that carries its status and body.
        if (id === "\0ekr-api") return "export async function api(path,init){const r=await fetch(path,{...init,headers:{'content-type':'application/json',...(init&&init.headers)}});const data=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(data.error||r.statusText),{status:r.status,body:data});return data;}";
        if (id !== "\0ekr-fixture") return;
        return `import React from 'react';import {createRoot} from 'react-dom/client';import {EmailKeepRemoveSection} from '/src/components/settings/pages/EmailKeepRemove.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement('div',{style:{padding:'16px'}},React.createElement(EmailKeepRemoveSection,{})));`;
      },
      configureServer(server) { server.middlewares.use((req, res, next) => {
        if (new URL(req.url ?? "/", "http://fixture").pathname !== "/__ekr") return next();
        res.setHeader("content-type", "text/html");
        res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__ekr.js"></script>');
      }); },
    }] });
  await vite.listen();
  const address = vite.httpServer?.address();
  origin = `http://127.0.0.1:${address && typeof address === "object" ? address.port : 5173}`;
});
test.afterAll(async () => { await vite?.close(); });

for (const [name, size] of [["desktop", { width: 1280, height: 800 }], ["phone", { width: 390, height: 844 }]] as const) {
  test(`Keep and Remove on the owner view shapes, window then result, on ${name}`, async ({ page }) => {
    await page.setViewportSize(size);
    let window: boolean = true;
    let minted = 0;
    let live = new Map<string, string>(); // token -> path
    const mint = (path: string) => { minted += 1; const token = `v1.${1_900_000_000_000 + minted}.sig${minted}-Zq_9`; live.set(token, path); return token; };
    let parked = true, other = true, marked = true, refuseOtherOnce = true;
    const action = (kind: string, path: string, token = true) => ({ kind, tokenId: token ? mint(path) : null, enabled: true, path });
    const view = () => {
      live = new Map();
      return {
        enabled: true,
        rows: [
          ...(window ? [{ rowId: "home:restore", section: "home", botId: null, inboxId: null, keyIds: [], threadId: "email-owner", target: null, address: null, botName: null, line: WINDOW_LINE, actions: [] }] : []),
          ...["a", "b", "c", "d", "e", "f<b>"].map((letter) => ({ rowId: `kept:${letter}`, section: "kept", botId: `k${letter.length}${letter.charCodeAt(0)}`, inboxId: null, keyIds: [], threadId: "email-owner", target: null, address: `${letter}@example.test`, botName: null, line: "", actions: [] })),
          ...(parked ? [{ rowId: "parked:p1", section: "parked", botId: "p1", inboxId: null, keyIds: [], threadId: "email-owner", target: "park:p1", address: "old@example.test", botName: null, line: "", actions: [action("keep", "/api/email/parked/p1/keep"), action("remove", "/api/email/parked/p1/remove")] }] : []),
          { rowId: "bot:b1", section: "bot", botId: "b1", inboxId: "also-set", keyIds: ["k1"], threadId: "thr-b1", target: null, address: "nova@example.test", botName: "Nova", line: marked ? RECONFIRM : "", actions: [action("keep", "/api/email/bots/b1/keep", false), action("remove", "/api/email/bots/b1/remove")] },
          ...(other ? [{ rowId: "other_setup:ib-1", section: "other_setup", botId: null, inboxId: "ib-1", keyIds: [], threadId: "email-owner", target: "inbox:ib-1", address: "else@example.test", botName: null, line: "", actions: [action("remove", "/api/email/other-setups/ib-1/remove")] }] : []),
        ],
      };
    };
    const posted: Array<{ path: string; raw: string }> = [];
    const tokensSeen: string[] = [];
    await page.route("**/api/email/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === "GET") { const body = view(); tokensSeen.push(...live.keys()); return route.fulfill({ json: body }); }
      const raw = request.postData() ?? "";
      const body = JSON.parse(raw) as { token?: string; target?: string };
      posted.push({ path, raw });
      if (window) return route.fulfill({ status: 409, json: { error: WINDOW_LINE, code: "restore_finishing" } });
      if (path.includes("/other-setups/") && refuseOtherOnce) { refuseOtherOnce = false; return route.fulfill({ status: 409, json: { error: FAILED_LINE, code: "restore_failed", rowId: "other_setup:ib-1" } }); }
      if (body.token !== undefined && live.get(body.token) !== path) return route.fulfill({ status: 409, json: { error: "Look again, then choose.", code: "confirm_expired" } });
      if (path.endsWith("/remove")) { if (path.includes("/parked/p1/")) parked = false; else if (path.includes("/ib-1/")) other = false; }
      else if (path === "/api/email/bots/b1/keep") marked = false;
      return route.fulfill({ json: view() });
    });
    await page.goto(`${origin}/__ekr`);
    const section = page.getByTestId("email-keep-remove");
    await expect(section.getByText(WINDOW_LINE)).toBeVisible();
    await expect(section.getByText("and 1 more")).toBeVisible();
    await expect(section.getByText("a@example.test", { exact: true })).toBeVisible();
    await expect(section.getByText(RECONFIRM)).toBeVisible();
    // 1: inside the window every decision is refused restore_finishing: the server's line, the token and target as the view gave them
    const firstView = [...tokensSeen];
    await section.getByRole("button", { name: "Keep old@example.test" }).click();
    await expect.poll(() => posted.length).toBe(1);
    expect(posted[0]!.path).toBe("/api/email/parked/p1/keep");
    expect(JSON.parse(posted[0]!.raw)).toEqual({ token: firstView[0], target: "park:p1" });
    await expect(section.getByTestId("email-row-note")).toHaveText(WINDOW_LINE);
    // 2: the window is over; the reload reads a new view, and a Remove carries its token, not the old one
    window = false;
    await page.reload();
    await expect(section.getByText(WINDOW_LINE)).toHaveCount(0);
    const latest = [...live.keys()];
    expect(latest.every((token) => !firstView.includes(token))).toBe(true);
    await section.getByRole("button", { name: "Remove old@example.test" }).click();
    await expect(section.getByRole("button", { name: "Remove old@example.test" })).toHaveCount(0);
    expect(posted[1]!.path).toBe("/api/email/parked/p1/remove");
    const removeBody = JSON.parse(posted[1]!.raw) as { token: string; target: string; confirm?: boolean };
    expect(removeBody.target).toBe("park:p1");
    expect("confirm" in removeBody).toBe(false);
    expect(tokensSeen).toContain(removeBody.token);
    expect(firstView).not.toContain(removeBody.token);
    // 3: a Keep with no token and no target sends exactly that, and the server's reconfirm line goes with the next view
    await section.getByRole("button", { name: "Keep nova@example.test" }).click();
    await expect(section.getByText(RECONFIRM)).toHaveCount(0);
    expect(posted[2]).toEqual({ path: "/api/email/bots/b1/keep", raw: "{}" });
    // 4: an address from another setup: its own route (by its inbox); the refusal's line is shown on its row exactly as given, then it goes through
    await section.getByRole("button", { name: "Remove else@example.test" }).click();
    await expect(section.getByTestId("email-row-note")).toHaveText(FAILED_LINE);
    await section.getByRole("button", { name: "Remove else@example.test" }).click();
    await expect(section.getByRole("button", { name: "Remove else@example.test" })).toHaveCount(0);
    expect(posted[3]!.path).toBe("/api/email/other-setups/ib-1/remove");
    expect(posted[4]!.path).toBe("/api/email/other-setups/ib-1/remove");
    const box = await section.getByRole("button", { name: "Keep nova@example.test" }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  });
}
