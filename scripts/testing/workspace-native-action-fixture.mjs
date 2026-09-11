// Isolated fixture proof for F4-T5: /api/workspace-files/native over real HTTP.
//
// Starts one server of its own on a temporary data directory and home, with a
// pinned development desktop secret, pins a bot to a fixture desk, then checks
// the route the Electron main process calls before a native open/reveal. It
// touches nothing outside its own temporary directory and stops only the child
// it started.
//
//   node scripts/testing/workspace-native-action-fixture.mjs
//
// MURAGE_FIXTURE_PORT overrides the port (default 9424; the webhook port is
// one above it).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, statSync, writeFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PORT = Number(process.env.MURAGE_FIXTURE_PORT ?? 9424);
const SECRET = randomBytes(32).toString("hex");
const base = realpathSync(mkdtempSync(join(tmpdir(), "murage-f4t5-fixture-")));
const dataDir = join(base, "data");
const desk = join(base, "desk");
mkdirSync(dataDir, { recursive: true });
mkdirSync(join(desk, "outputs"), { recursive: true });
writeFileSync(join(desk, "outputs", "report.md"), "# Report\n");
writeFileSync(join(desk, "MEMORY.md"), "private\n");
writeFileSync(join(base, "outside.md"), "private\n");
symlinkSync(join(base, "outside.md"), join(desk, "escape.md"));

const logPath = join(base, "server.log");
const log = openSync(logPath, "a", 0o600);
const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server", "index.ts")], {
  cwd: ROOT, stdio: ["ignore", log, log],
  env: {
    HOME: dataDir, USERPROFILE: dataDir, TMPDIR: join(base, "tmp"),
    XDG_CONFIG_HOME: join(dataDir, ".config"), XDG_CACHE_HOME: join(dataDir, ".cache"), XDG_DATA_HOME: join(dataDir, ".local", "share"),
    MURAGE_DATA_DIR: dataDir, MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", MURAGE_DEV_DESKTOP_SECRET: SECRET,
    MURAGE_PORT: String(PORT), MURAGE_WEBHOOK_PORT: String(PORT + 1), FAKE_CLAUDE_MODE: "happy", PATH: "",
  },
});
console.log("server pid", child.pid, "log", logPath);

const desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": SECRET, "content-type": "application/json" };
const url = (p) => `http://127.0.0.1:${PORT}${p}`;
const results = [];
let failures = 0;
const check = (name, ok, detail) => { results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failures++; };

async function main() {
  const deadline = Date.now() + 40_000;
  for (;;) {
    try { const r = await fetch(url("/api/health")); if (r.ok) break; } catch {}
    if (Date.now() > deadline) throw new Error("server did not start");
    await new Promise(r => setTimeout(r, 300));
  }
  const created = await (await fetch(url("/api/bots"), { method: "POST", headers: desktop, body: JSON.stringify({ name: "Desk bot" }) })).json();
  const bot = created.bot ?? created;
  const patched = await fetch(url(`/api/bots/${bot.id}`), { method: "PATCH", headers: desktop, body: JSON.stringify({ cwd: desk }) });
  check("bot pinned to the fixture desk", patched.ok, String(patched.status));
  const q = `botId=${bot.id}&threadId=${bot.threadId}`;

  const remote = await fetch(url(`/api/workspace-files/native?${q}&path=outputs/report.md`));
  check("hidden from a non-desktop caller", remote.status === 404, `status ${remote.status}`);

  const ok = await fetch(url(`/api/workspace-files/native?${q}&path=outputs/report.md`), { headers: desktop });
  const body = await ok.json();
  const stat = statSync(join(desk, "outputs", "report.md"));
  const expected = JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
  check("authorizes a regular workspace file", ok.status === 200 && body.root === desk && body.relativePath === "outputs/report.md"
    && body.identity === expected && body.bytes === stat.size, `${ok.status} ${JSON.stringify(body)}`);

  for (const [path, status, code] of [
    ["MEMORY.md", 403, "private-file"],
    ["escape.md", 409, "linked-file"],
    ["gone.md", 404, "not-found"],
    ["../outside.md", 400, "invalid-path"],
    ["outputs", 409, "not-regular-file"],
  ]) {
    const response = await fetch(url(`/api/workspace-files/native?${q}&path=${encodeURIComponent(path)}`), { headers: desktop });
    const refusal = await response.json();
    check(`refuses ${path}`, response.status === status && refusal.code === code, `${response.status} ${JSON.stringify(refusal)}`);
  }

  const wrongMethod = await fetch(url(`/api/workspace-files/native?${q}&path=outputs/report.md`), { method: "POST", headers: desktop, body: "{}" });
  check("GET only", wrongMethod.status === 400, `status ${wrongMethod.status}`);
}

main().then(() => {
  console.log(results.join("\n"));
  console.log(failures ? `FAILURES: ${failures}` : "ALL CHECKS PASSED");
}).catch((error) => {
  console.log(results.join("\n"));
  console.error("ERROR", error);
  failures++;
}).finally(() => {
  child.kill("SIGTERM");
  setTimeout(() => { rmSync(base, { recursive: true, force: true }); process.exit(failures ? 1 : 0); }, 1500);
});
