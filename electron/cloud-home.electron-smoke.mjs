// Live smoke for Murage Cloud B3 WP1. Run under Electron (xvfb on Linux):
//   MURAGE_DESKTOP_CLOUD=1 CLOUD_SMOKE_ORIGIN=https://<home> CLOUD_SMOKE_OUT=<file.json> electron electron/cloud-home.electron-smoke.mjs
// Loads murage-home://test/ from the built dist/ and proxies /api/health to the home.
// READ-ONLY: every upstream call that is not GET/HEAD is refused and recorded.
import { app, BrowserWindow, net, protocol, session, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installCloudHome } from "./cloud-home-window.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.env.CLOUD_SMOKE_OUT || path.join(here, "cloud-home-smoke.json");
const origin = process.env.CLOUD_SMOKE_ORIGIN;
if (process.env.CLOUD_SMOKE_NOSANDBOX === "1") for (const s of ["no-sandbox", "disable-gpu", "disable-dev-shm-usage"]) app.commandLine.appendSwitch(s);

const result = { electron: process.versions.electron, platform: `${process.platform}/${process.arch}`, origin, upstream: [], checks: {} };
const finish = (code) => { fs.writeFileSync(out, JSON.stringify(result, null, 1)); app.exit(code); };
const check = (name, ok, detail) => { result.checks[name] = { ok: Boolean(ok), detail }; };

const guardedNet = {
  fetch: (input, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    if (headers.authorization) headers.authorization = "Bearer <redacted>";
    const refused = method !== "GET" && method !== "HEAD";
    delete headers["user-agent"];
    result.upstream.push({ method, url: String(input).replace(origin, "<origin>"), headers, ...(refused ? { refusedByReadOnlyGuard: true } : {}) });
    if (refused) return Promise.reject(new Error("smoke is read-only"));
    return net.fetch(input, init);
  },
};

// Pre-ready, exactly like main.mjs: the flag decides whether the scheme exists.
const cloud = installCloudHome({
  protocol, session, BrowserWindow, shell, net: guardedNet, env: process.env, packaged: app.isPackaged, distDir: path.join(here, "..", "dist"),
  warn: (m) => { (result.warnings ||= []).push(m); },
});
check("flag_on_installs", Boolean(cloud), process.env.MURAGE_DESKTOP_CLOUD);

app.whenReady().then(async () => {
  try {
    if (!cloud || !origin) throw new Error("need MURAGE_DESKTOP_CLOUD=1 and CLOUD_SMOKE_ORIGIN");
    // WP2 test double: the provider interface, no pairing.
    cloud.setProvider((homeId) => (homeId === "test" ? { homeId, origin, getAccessToken: () => "smoke-token-not-a-real-credential" } : null));
    const win = cloud.open("test");
    await new Promise((resolve, reject) => { win.webContents.once("did-finish-load", resolve); win.webContents.once("did-fail-load", (_e, c, d) => reject(new Error(`load failed ${c} ${d}`))); });
    const wc = win.webContents;
    result.location = wc.getURL();
    check("top_frame_from_scheme", result.location.startsWith("murage-home://test/"), result.location);
    result.title = wc.getTitle();
    check("static_served_from_dist", (await wc.executeJavaScript("document.documentElement.outerHTML.length")) > 200);
    const health = await wc.executeJavaScript("fetch('/api/health').then(async r => ({ status: r.status, type: r.headers.get('content-type'), body: await r.text() }))");
    result.health = { status: health.status, type: health.type, body: health.body.slice(0, 400) };
    check("api_health_proxied", health.status === 200, `status ${health.status}`);
    const hit = result.upstream.find((u) => u.url === "<origin>/api/health");
    check("proxy_origin_header", hit?.headers.origin === origin, hit?.headers.origin);
    check("proxy_bearer_added", hit?.headers.authorization === "Bearer <redacted>");
    check("proxy_no_cookie_or_secret", hit && !hit.headers.cookie && !hit.headers["x-murage-surface-secret"]);
    // Top frame must not be steerable onto /api or off the scheme.
    await wc.executeJavaScript("location.href = 'murage-home://test/api/health'").catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    check("top_frame_cannot_navigate_to_api", wc.getURL().startsWith("murage-home://test/") && !wc.getURL().includes("/api/"), wc.getURL());
    const direct = await wc.executeJavaScript(`fetch(${JSON.stringify(origin + "/api/health")}).then(() => "reached", () => "blocked")`);
    check("partition_blocks_direct_https", direct === "blocked", direct);
    check("read_only", result.upstream.filter((u) => !u.refusedByReadOnlyGuard).every((u) => u.method === "GET" || u.method === "HEAD"), `${result.upstream.filter((u) => u.refusedByReadOnlyGuard).length} write(s) from the app refused before leaving the machine`);
    const failed = Object.entries(result.checks).filter(([, v]) => !v.ok).map(([k]) => k);
    result.verdict = failed.length ? `FAIL ${failed.join(",")}` : "PASS";
    finish(failed.length ? 1 : 0);
  } catch (error) {
    result.error = String(error?.stack || error);
    result.verdict = "ERROR";
    finish(2);
  }
});
