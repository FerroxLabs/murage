// SEC-006 P7: the phone's approveWithDevice flow against a real, isolated
// desktop (server + companion), with the native channel replaced by
// e2e/freshauth/native-double.js.
//
//   MURAGE_DESKTOP_DIR=<desktop checkout> node e2e/freshauth/run.mjs
//
// What is real: the desktop server and companion processes, the browser door's
// /enter page and its /session pairing (install id, approval key and a relay
// statement in the fragment), the session cookie, the card the fake agent
// raises at the stop line, the 403 challenge, the digest check, the page code
// src/lib/fresh-auth.ts (bundled from the desktop checkout, read only), and
// the server's verification and single-use nonce.
// What is doubled: the Face ID / biometric prompt and the keystore (WebCrypto
// P-256 instead of a Secure Enclave), and the relay's statement key (a throwaway
// Ed25519 key pinned through MURAGE_RELAY_STATEMENT_KEYS).
//
// Isolated: a temp HOME and ports 28920-28933. Never 8799, 8810-8813 or ~/.murage.
import { spawn, spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign as nodeSign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, "../..");
const DESKTOP = resolve(process.env.MURAGE_DESKTOP_DIR ?? resolve(MOBILE, "../../../fresh-auth"));
if (!existsSync(join(DESKTOP, "server/index.ts"))) throw new Error(`MURAGE_DESKTOP_DIR is not a desktop checkout: ${DESKTOP}`);

const PORTS = { server: 28920, webhook: 28921, device: 28930, control: 28931, browser: 28933 };
const FORBIDDEN = new Set([8799, 8800, 8810, 8811, 8812, 8813]);
for (const port of Object.values(PORTS)) if (FORBIDDEN.has(port)) throw new Error("live port in the isolated block");
const LAUNCH_SECRET = randomBytes(32).toString("hex");
const KID = "e2e-test";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

// ---- the desktop's own tooling, read only -------------------------------
const pnpmDir = join(DESKTOP, "node_modules/.pnpm");
const find = (prefix) => {
  const name = spawnSync("ls", [pnpmDir], { encoding: "utf8" }).stdout.split("\n").filter((n) => n.startsWith(prefix)).sort().at(-1);
  if (!name) throw new Error(`${prefix} not installed in the desktop checkout`);
  return join(pnpmDir, name, "node_modules", prefix.split("@")[0]);
};
const esbuild = createRequire(join(DESKTOP, "package.json"))(join(find("esbuild@"), "lib/main.js"));
const { chromium } = createRequire(join(DESKTOP, "package.json"))(join(find("playwright@"), "index.js"));

// ---- isolated state -----------------------------------------------------
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "murage-p7-")));
const HOME = join(ROOT, "home");
const COMPANION_DIR = join(ROOT, "companion");
for (const dir of [join(HOME, ".murage"), COMPANION_DIR, join(ROOT, "tmp")]) mkdirSync(dir, { recursive: true });
const relay = generateKeyPairSync("ed25519");
const relayX = relay.publicKey.export({ format: "jwk" }).x;
const children = [];
let logs = "";

// The approver instance comes from the fixture file through merge-config.mjs: the command is never in this file.
const merged = spawnSync(process.execPath, [join(MOBILE, "e2e/host/merge-config.mjs"), join(HOME, ".murage/config.json"), join(DESKTOP, "server/testing/fake-acp-cli.ts")], { encoding: "utf8" });
if (merged.status !== 0) throw new Error(`merge-config failed: ${merged.stderr}`);
chmodSync(join(DESKTOP, "server/testing/fake-acp-cli.ts"), 0o755);

const baseEnv = {
  PATH: process.env.PATH ?? "",
  HOME,
  USERPROFILE: HOME,
  TMPDIR: join(ROOT, "tmp"),
  MURAGE_PORT: String(PORTS.server),
  MURAGE_WEBHOOK_PORT: String(PORTS.webhook),
  MURAGE_COMPANION_TOKEN: LAUNCH_SECRET,
  MURAGE_PUSH_RELAY_URL: "off",
  MURAGE_ALLOW_TEST_RELAY_KEYS: "1",
  MURAGE_RELAY_STATEMENT_KEYS: JSON.stringify({ [KID]: relayX }),
};
const start = (label, script, extra) => {
  const child = spawn(process.execPath, [script], { cwd: DESKTOP, env: { ...baseEnv, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (c) => (logs += `[${label}] ${c}`));
  child.stderr.on("data", (c) => (logs += `[${label}] ${c}`));
  children.push(child);
  return child;
};
const waitFor = async (what, read, ms) => {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const value = await read();
      if (value) return value;
    } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};
const stopAll = async () => {
  for (const child of children) child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 1500));
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
};
const cleanup = () => {
  // Only ever the temp dir this run made.
  if (ROOT.startsWith(realpathSync(tmpdir())) && ROOT.includes("murage-p7-")) rmSync(ROOT, { recursive: true, force: true });
};

// ---- HTTP helpers -------------------------------------------------------
const harness = `http://127.0.0.1:${PORTS.server}`;
let desktopHeaders = {};
const http = async (base, method, path, body, headers = {}) => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const desktop = (method, path, body) => http(harness, method, path, body, desktopHeaders);
const messages = async (threadId) => ((await desktop("GET", `/api/threads/${threadId}/messages?limit=200`)).body?.messages ?? []);
const cardOf = async (threadId, requestId) => (await messages(threadId)).find((m) => m.card?.requestId === requestId)?.card;

async function stoppedBot(name) {
  const created = await desktop("POST", "/api/bots", { name, modelSelection: { instanceId: "approver", model: "fake-model" } });
  if (created.status !== 201) throw new Error(`bot create ${created.status}`);
  const bot = created.body.bot;
  await desktop("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
  await desktop("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { fullAccess: true, acknowledgeFullAccess: true });
  await desktop("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "tidy my documents" });
  const live = await waitFor(`the stop-line card for ${name}`, async () => (await messages(bot.threadId)).find((m) => m.card?.requestId && m.card?.answered === undefined && !m.card?.dismissed), 60_000);
  return { bot, requestId: live.card.requestId };
}

// ---- the page bundle (desktop's src/lib/fresh-auth.ts, as the desktop would serve it) ----
async function buildPageBundle() {
  const entry = join(ROOT, "entry.ts");
  writeFileSync(entry, `import * as fa from ${JSON.stringify(join(DESKTOP, "src/lib/fresh-auth.ts"))};\nimport { approvalDigest } from ${JSON.stringify(join(DESKTOP, "shared/approval-digest.ts"))};\n(globalThis as any).__fa = { ...fa, approvalDigest };\n`);
  const out = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    alias: { "@": join(DESKTOP, "src") },
    absWorkingDir: DESKTOP,
    loader: { ".json": "json" },
    logLevel: "silent",
  });
  return out.outputFiles[0].text;
}

// ---- pairing the double through the real /enter fragment ---------------
const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
const point = Buffer.from(await crypto.subtle.exportKey("raw", keyPair.publicKey));
const approvalKey = point.toString("base64url");
function relayStatement(installId, atMs) {
  const hash = createHashHex(point);
  const payload = ["murage-approval-attestation/1", KID, "ios", "development", installId, hash, String(atMs), String(atMs + 600_000)].join("\n");
  const sig = nodeSign(null, Buffer.from(payload), createPrivateKey(relay.privateKey.export({ format: "pem", type: "pkcs8" })));
  return `${Buffer.from(payload).toString("base64url")}.${sig.toString("base64url")}`;
}
function createHashHex(buf) {
  return spawnSync("shasum", ["-a", "256"], { input: buf, encoding: "buffer" }).stdout.toString().split(" ")[0];
}
const mintToken = async () => {
  const res = await fetch(`http://127.0.0.1:${PORTS.control}/pairing`, { method: "POST", headers: { origin: `http://127.0.0.1:${PORTS.control}`, "content-type": "application/json" } });
  const body = await res.json();
  if (!body?.token) throw new Error(`pairing mint failed: HTTP ${res.status}`);
  return body.token;
};

let browser;
let exitCode = 1;
try {
  start("server", join(DESKTOP, "server/index.ts"), { MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1" });
  await waitFor("the harness", async () => (await fetch(`${harness}/api/health`)).ok, 150_000);
  const secret = await http(harness, "GET", "/api/desktop-secret");
  desktopHeaders = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret.body.secret };
  start("companion", join(DESKTOP, "companion/src/index.ts"), {
    MURAGE_COMPANION_PORT: String(PORTS.device),
    MURAGE_CONTROL_PORT: String(PORTS.control),
    MURAGE_BROWSER_PORT: String(PORTS.browser),
    MURAGE_COMPANION_BIND: "loopback",
    MURAGE_BROWSER_BIND: "loopback",
    MURAGE_COMPANION_DIR: COMPANION_DIR,
  });
  const door = `http://127.0.0.1:${PORTS.browser}`;
  await waitFor("the browser door", async () => (await fetch(`${door}/enter`)).status < 500, 60_000);

  const bundle = await buildPageBundle();
  browser = await chromium.launch();

  // ---- the app: user agent mark, native double at document start, pairing through /enter ----
  const calls = [];
  const app = await browser.newContext({ userAgent: "Mozilla/5.0 (iPhone) MurageApp/1.0" });
  await app.addInitScript((config) => { globalThis.__E2E_DOUBLE = config; }, { privateJwk, mode: "sign", calls });
  // `calls` is a copy inside the page; the run reads it back from the page.
  await app.addInitScript({ content: readFileSync(join(HERE, "native-double.js"), "utf8") });
  const page = await app.newPage();
  const installId = `p7-${randomUUID()}`;
  const statement = relayStatement(installId, Date.now());
  const token = await mintToken();
  await page.goto(`${door}/enter#${token}&installId=${installId}&approvalKey=${approvalKey}&approvalStatement=${statement}`);
  const paired = await waitFor("the app session cookie", async () => (await app.cookies(door)).length > 0, 20_000).catch(() => false);
  check("pairing through the real /enter fragment (install id + approval key + relay statement) opens a session", paired);
  await page.waitForURL(`${door}/`, { timeout: 20_000 });
  await page.waitForLoadState("load");
  await page.addScriptTag({ content: bundle });
  check("native channel double is present and lists approveWithDevice", await page.evaluate(async () => (Boolean(globalThis.__fa) && globalThis.murageNative.hello().methods.includes("approveWithDevice"))));

  // Everything below runs inside the page, through the door with the cookie.
  const inPage = (fn, arg) => page.evaluate(fn, arg);
  const setMode = (mode) => inPage((m) => { globalThis.__E2E_DOUBLE.mode = m; }, mode);
  const nativeCalls = () => inPage(() => globalThis.__E2E_DOUBLE.calls.length);
  const decide = (threadId, requestId, options) =>
    inPage(async ({ threadId, requestId, options }) => {
      const read = await fetch(`/api/threads/${threadId}/messages?limit=200`);
      const card = (await read.json()).messages.find((m) => m.card?.requestId === requestId)?.card;
      const shown = options.tamper ? { ...card, summary: `${card.summary} && echo tampered` } : card;
      const errors = [];
      const reports = [];
      const post = async (extra) => {
        const res = await fetch(`/api/threads/${threadId}/respond`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestId, behavior: options.decision ? "allow" : "deny", ...(options.decision === "allow-task" ? { allowForTask: true } : {}), ...(extra ?? {}) }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw Object.assign(new Error("http"), { status: res.status, body });
        return body;
      };
      await globalThis.__fa.decideWithFreshAuth(post, { threadId, requestId, decision: options.decision, card: shown, botName: "Approver" }, {
        showError: (e) => errors.push({ code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 120) }),
        onError: (message, code) => reports.push({ code: code ?? null }),
      });
      return { errors, reports, card: card ? { tool: card.tool } : null };
    }, { threadId, requestId, options });
  const answered = async (threadId, requestId) => (await cardOf(threadId, requestId))?.answered;

  // 1. one card, walked through every way the page can stop, then success
  const one = await stoppedBot("P7 card one");
  const before = await nativeCalls();
  const tampered = await decide(one.bot.threadId, one.requestId, { decision: "allow", tamper: true });
  check("a card whose text differs from the server's digest is refused before any Face ID prompt", tampered.errors[0]?.code === "changed" && (await nativeCalls()) === before, JSON.stringify(tampered.errors));
  await setMode("cancel");
  const cancelled = await decide(one.bot.threadId, one.requestId, { decision: "allow" });
  check("a Face ID cancel is silent: no error shown, card still waiting", cancelled.errors.length === 0 && cancelled.reports[0]?.code === "cancelled" && (await answered(one.bot.threadId, one.requestId)) === undefined, JSON.stringify(cancelled));
  await setMode("no_lock");
  const noLock = await decide(one.bot.threadId, one.requestId, { decision: "allow" });
  check("no screen lock on the phone shows the no-lock sentence and the card stays waiting", noLock.errors[0]?.code === "noLock" && (await answered(one.bot.threadId, one.requestId)) === undefined, JSON.stringify(noLock.errors));
  await setMode("sign");
  const promptsBefore = await nativeCalls();
  const allowed = await decide(one.bot.threadId, one.requestId, { decision: "allow" });
  const prompt = await inPage(() => globalThis.__E2E_DOUBLE.calls.at(-1));
  check("Allow: the double signs the contract bytes and the server accepts the proof", allowed.errors.length === 0 && (await waitFor("the answer", () => answered(one.bot.threadId, one.requestId), 15_000).catch(() => null)) === "allow");
  check("the prompt reason names the tool and the bot", (await nativeCalls()) === promptsBefore + 1 && /Approver/.test(prompt?.reason ?? "") && prompt.reason.includes(allowed.card.tool), prompt?.reason ?? "");

  // 2. replay: the same signed proof cannot be used twice
  const two = await stoppedBot("P7 card two");
  const replay = await inPage(async ({ threadId, requestId }) => {
    const url = `/api/threads/${threadId}/respond`;
    const send = async (extra) => {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId, behavior: "allow", ...(extra ?? {}) }) });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const challenge = (await send()).body.challenge;
    const { signature } = await globalThis.murageNative.approveWithDevice({ v: 1, threadId, requestId, decision: challenge.decision, digest: challenge.digest, nonce: challenge.nonce, expiresAt: challenge.expiresAt, reason: "Allow Approver: replay check" });
    const first = await send({ freshAuth: { nonce: challenge.nonce, signature } });
    const again = await send({ freshAuth: { nonce: challenge.nonce, signature } });
    return { first: first.status, again: { status: again.status, code: again.body?.code ?? null } };
  }, { threadId: two.bot.threadId, requestId: two.requestId });
  check("a signed proof works once and a replay is refused", replay.first === 200 && replay.again.status >= 400 && ["fresh_auth_failed", "fresh_auth_gone", "fresh_auth"].includes(replay.again.code), JSON.stringify(replay));

  // 3. Allow for this task signs its own decision
  const three = await stoppedBot("P7 card three");
  const task = await decide(three.bot.threadId, three.requestId, { decision: "allow-task" });
  const taskAnswer = await waitFor("answer", () => answered(three.bot.threadId, three.requestId), 15_000).catch(() => null);
  const taskPrompt = await inPage(() => globalThis.__E2E_DOUBLE.calls.at(-1));
  check("Allow for this task is signed as allow-task and accepted", task.errors.length === 0 && taskPrompt?.decision === "allow-task" && Boolean(taskAnswer), `answered=${JSON.stringify(taskAnswer)} ${JSON.stringify(task.errors)}`);

  // 4. Deny needs no prompt; a plain browser pairing cannot allow at all
  const four = await stoppedBot("P7 card four");
  const plain = await browser.newContext();
  const plainPage = await plain.newPage();
  await plainPage.goto(`${door}/enter#${await mintToken()}`);
  await plainPage.click("#go");
  await waitFor("the browser session", async () => (await plain.cookies(door)).length > 0, 20_000);
  await plainPage.waitForURL(`${door}/`, { timeout: 20_000 });
  await plainPage.waitForLoadState("load");
  await plainPage.addScriptTag({ content: bundle });
  const browserTry = await plainPage.evaluate(async ({ threadId, requestId }) => {
    const res = await fetch(`/api/threads/${threadId}/respond`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId, behavior: "allow" }) });
    return { status: res.status, code: (await res.json().catch(() => null))?.code ?? null };
  }, { threadId: four.bot.threadId, requestId: four.requestId });
  check("a plain browser pairing cannot Allow a stop-line card (approve on the computer)", browserTry.status === 403 && browserTry.code === "approve_on_computer", JSON.stringify(browserTry));
  const denyPrompts = await nativeCalls();
  const denied = await decide(four.bot.threadId, four.requestId, { decision: undefined });
  check("Deny from the app answers with no prompt", denied.errors.length === 0 && (await nativeCalls()) === denyPrompts && (await waitFor("answer", () => answered(four.bot.threadId, four.requestId), 15_000).catch(() => null)) === "deny", JSON.stringify(denied));

  exitCode = results.every((r) => r.ok) ? 0 : 1;
} catch (error) {
  console.error(`run failed: ${error?.message ?? error}`);
  console.error(logs.slice(-2000));
} finally {
  await browser?.close().catch(() => {});
  await stopAll();
  cleanup();
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  process.exit(exitCode);
}
