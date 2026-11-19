// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owners: fprod4-sqlite-build4-par owns boot validation; trainred-proofschema owns proof installation/readers and these witnesses.
// The memory lane owns the reclaim transaction in memory/root-set-reclaim.ts.
// The reclaim hands back memory_session_roots (it has since 1.0.2), and the table's two proof triggers go with it. The next start must still open
// the file: before this fix the boot check wanted those two triggers and the server exited with MEMORY_SCHEMA_UNSUPPORTED.
import { createHmac, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { stepPurpose } from "./cloud-request-auth.ts";
import { ROOT_SET_RECLAIM_TABLES } from "./memory/root-set-reclaim.ts";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const serverDirectory = dirname(fileURLToPath(import.meta.url));
const root = join(serverDirectory, "..");
const fakeCli = join(serverDirectory, "testing", "fake-claude-cli.ts");
const children: ChildProcess[] = [];
const homes: string[] = [];

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "murage-proof-reclaim-"));
  homes.push(home);
  const data = join(home, "data");
  mkdirSync(data);
  writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { quiet: { driver: "claudeAgent", config: { cli: fakeCli } } } }));
  return { home, data };
}

const cloudOrigin = "https://home.example.test";
const bootstrapSecret = randomBytes(32).toString("hex");
async function launch(home: string, data: string, cloud = false) {
  const port = await freePortBlock([0, 1]);
  const preload = join(home, "cloud-control.mjs");
  if (cloud) {
    const control = pathToFileURL(join(serverDirectory, "cloud-home/control-state-verification.fixture.mjs")).href;
    const signingKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    writeFileSync(preload, `import { isMainThread } from "node:worker_threads"; if (isMainThread) { const { installVerificationControl } = await import(${JSON.stringify(control)}); installVerificationControl(${JSON.stringify(cloudOrigin)}, ${JSON.stringify(signingKey)}); }`);
  }
  const child = spawn(process.execPath, [...(cloud ? ["--import", pathToFileURL(preload).href] : []), join(serverDirectory, "index.ts")], {
    windowsHide: true,
    cwd: root,
    env: {
      PATH: dirname(process.execPath),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, MURAGE_DATA_DIR: data,
      ...(cloud ? { MURAGE_CLOUD_ROLE: "home", MURAGE_PUBLIC_ORIGIN: cloudOrigin, MURAGE_CLOUD_SECRETS_FD: "3", MURAGE_TRUSTED_PROXY: `unix:${join(data, "proxy.sock")}` } : {}),
      MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1",
    },
    stdio: ["ignore", "pipe", "pipe", "pipe", "ipc"],
  });
  if (cloud) (child.stdio[3] as import("node:stream").Writable).on("error", () => {}).end(JSON.stringify({ version: 1, bootstrapSecret, credentials: {} }));
  children.push(child);
  let output = "";
  const keep = (chunk: Buffer) => { output = (output + chunk).slice(-16_000); };
  child.stdout!.on("data", keep);
  child.stderr!.on("data", keep);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) return { child, base, ready: false, output: () => output };
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) });
      const health = await response.json() as { pid?: number };
      if (response.ok && health.pid === child.pid) return { child, base, ready: true, output: () => output };
    } catch { /* still starting */ }
    if (Date.now() >= deadline) throw new Error(`startup timed out: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

const objects = (file: string, names: readonly string[]) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return names.filter(name => db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name)); } finally { db.close(); }
};
async function until<T>(what: string, read: () => Promise<T> | T, done: (value: T) => boolean, ms = 90_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() >= deadline) throw new Error(`${what}: last ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) await waitForExit(child, { signal: "SIGTERM" });
  for (const home of homes.splice(0)) await removeTempDir(home);
});

const ROOT_TRIGGERS = ["memory_session_proof_root_insert", "memory_session_proof_root_update"] as const;
const RECEIPT_LINE_TRIGGERS = ["memory_session_proof_receipt_line_insert", "memory_session_proof_receipt_line_update"] as const;

for (const cloud of [false, true]) it(`starts again after the root-set reclaim handed back memory_session_roots (cloud=${cloud})`, async () => {
  const { home, data } = fixture();
  const file = join(data, "messages.db");
  const first = await launch(home, data, cloud);
  expect(first.ready, first.output()).toBe(true);
  let authority: Record<string, string> = {};
  let confirmReclaim: (() => Promise<string>) | undefined;
  if (cloud) {
    expect(await (await fetch(`${first.base}/api/health`)).json()).toMatchObject({ role: "home" });
    const request = (path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(first.base + path, {
      method: body === undefined ? "GET" : "POST", headers: { host: "home.example.test", origin: cloudOrigin, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const environment = await (await request("/.well-known/murage/environment")).json() as { environmentId: string };
    const key = generateKeyPairSync("ed25519"), factor = generateKeyPairSync("ed25519");
    const body = { account: "fixture-owner", scope: "owner-desktop", publicKey: key.publicKey.export({ type: "spki", format: "pem" }).toString(), assertionKey: factor.publicKey.export({ type: "spki", format: "pem" }).toString(), timestamp: Date.now() / 1000, nonce: randomUUID() };
    const minted = await request("/api/cloud/pairing", body, { "x-murage-signature": createHmac("sha256", bootstrapSecret).update(JSON.stringify(body)).digest("hex") });
    expect(minted.status, await minted.clone().text()).toBe(200);
    const { code } = await minted.json() as { code: string };
    const message = Buffer.from(`murage-pair:${environment.environmentId}:${code}:fixture-owner`);
    const redeemed = await request("/api/cloud/pair", { code, account: "fixture-owner", signature: sign(null, message, key.privateKey).toString("base64url"), assertionSignature: sign(null, message, factor.privateKey).toString("base64url") });
    expect(redeemed.status, await redeemed.clone().text()).toBe(200);
    const session = await redeemed.json() as { deviceId: string; accessToken: string };
    authority = { host: "home.example.test", origin: cloudOrigin, authorization: `Bearer ${session.accessToken}` };
    confirmReclaim = async () => {
      const purpose = stepPurpose("POST", "/api/memory/storage/reclaim", undefined);
      const response = await request("/api/cloud/challenge", { deviceId: session.deviceId, purpose }, authority);
      expect(response.status).toBe(200);
      const { challenge } = await response.json() as { challenge: string }, at = Date.now();
      const signature = sign(null, Buffer.from(`murage:${environment.environmentId}:${session.deviceId}:${purpose}:${challenge}:${at}`), factor.privateKey).toString("base64url");
      return Buffer.from(JSON.stringify({ challenge, at, signature })).toString("base64url");
    };
  }
  // the owner's data: a bot with its conversation
  const created = await fetch(`${first.base}/api/bots`, {
    method: "POST", headers: { ...authority, "content-type": "application/json" },
    body: JSON.stringify({ name: "Reclaim sentinel", modelSelection: { instanceId: "quiet", model: "claude-sonnet-5" } }),
  });
  expect(created.status).toBe(201);
  const { bot } = await created.json() as { bot: { id: string } };
  expect(typeof bot.id).toBe("string");
  expect(objects(file, ["memory_session_roots", ...ROOT_TRIGGERS, ...RECEIPT_LINE_TRIGGERS])).toHaveLength(5);
  // the real hand-back, through the owner's button (the sliced steps need no idle wait)
  let desktop = authority;
  if (!cloud) {
    const secret = await fetch(`${first.base}/api/desktop-secret`);
    expect(secret.status).toBe(200);
    const proof = await secret.json() as { secret: string };
    desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret, "content-type": "application/json" };
  }
  await until("storage ready to hand back", async () => {
    const response = await fetch(`${first.base}/api/memory/storage`, { headers: desktop });
    return { status: response.status, body: await response.text() };
  }, read => read.status === 200 && (JSON.parse(read.body) as { state: string }).state === "reclaim-available");
  const reclaim = await fetch(`${first.base}/api/memory/storage/reclaim`, { method: "POST", headers: { ...desktop, ...(confirmReclaim ? { "x-murage-step-up": await confirmReclaim() } : {}) } });
  expect(reclaim.status, await reclaim.text()).toBe(202);
  await until("memory_session_roots handed back", () => objects(file, ["memory_session_roots"]).length, n => n === 0);
  expect(objects(file, ROOT_TRIGGERS)).toEqual([]);
  await waitForExit(first.child, { signal: "SIGTERM" });

  const second = await launch(home, data, cloud);
  expect(second.output()).not.toContain("MEMORY_SCHEMA_UNSUPPORTED");
  expect(second.ready, second.output()).toBe(true);
  if (cloud) expect(await (await fetch(`${second.base}/api/health`)).json()).toMatchObject({ role: "home" });
  // the owner's data is still there, and the proof triggers on the tables that remain are in place
  const bots = await (await fetch(`${second.base}/api/bots?messages=0`, { headers: authority })).json() as { bots: Array<{ id: string }> };
  expect(bots.bots.map(entry => entry.id)).toContain(bot.id);
  expect(objects(file, [...RECEIPT_LINE_TRIGGERS])).toEqual([...RECEIPT_LINE_TRIGGERS]);
  await waitForExit(second.child, { signal: "SIGTERM" });

  // and a third start (the file as the second start left it) opens too
  const third = await launch(home, data, cloud);
  expect(third.output()).not.toContain("MEMORY_SCHEMA_UNSUPPORTED");
  expect(third.ready, third.output()).toBe(true);
  if (cloud) expect(await (await fetch(`${third.base}/api/health`)).json()).toMatchObject({ role: "home" });
  const botsAgain = await (await fetch(`${third.base}/api/bots?messages=0`, { headers: authority })).json() as { bots: Array<{ id: string }> };
  expect(botsAgain.bots.map(entry => entry.id)).toContain(bot.id);
  expect(objects(file, [...RECEIPT_LINE_TRIGGERS])).toEqual([...RECEIPT_LINE_TRIGGERS]);
}, 300_000);

for (const cut of ["before-commit", "after-commit"] as const) it(`root DROP and its marker survive a real process crash atomically (${cut})`, async () => {
  const { home, data } = fixture(), file = join(data, "messages.db");
  const first = await launch(home, data);
  expect(first.ready, first.output()).toBe(true);
  await waitForExit(first.child, { signal: "SIGTERM" });
  const db = new DatabaseSync(file);
  try {
    expect(db.prepare("SELECT count(*) AS n FROM memory_session_roots").get()?.n).toBe(0);
    for (const table of ROOT_SET_RECLAIM_TABLES) if (table !== "memory_session_roots") db.exec(`DROP TABLE IF EXISTS ${table}`);
    // Start the DROP step with mark=0 so a previous clear batch cannot hide a missing or separately committed DROP marker.
    db.exec("UPDATE memory_lineage_lsn_meta SET value=0 WHERE key='root_sets_dropped'; PRAGMA wal_checkpoint(TRUNCATE)");
  } finally { db.close(); }
  const source = `
    import { DatabaseSync } from "node:sqlite";
    import { nextReclaimStep, runReclaimStep } from ${JSON.stringify(new URL("./memory/root-set-reclaim.ts", import.meta.url).href)};
    const db = new DatabaseSync(process.argv[1]), cut = process.argv[2];
    db.exec("PRAGMA synchronous=FULL");
    const step = nextReclaimStep(db);
    if (step.kind !== "drop-table" || step.name !== "memory_session_roots") throw new Error("wrong crash boundary");
    const exec = db.exec.bind(db); let dropped = false;
    db.exec = sql => {
      exec(sql);
      if (sql === "DROP TABLE IF EXISTS memory_session_roots") {
        dropped = true;
        if (cut === "before-commit") process.kill(process.pid, "SIGKILL");
      }
      if (sql === "COMMIT" && dropped && cut === "after-commit") process.kill(process.pid, "SIGKILL");
    };
    runReclaimStep(db);
    throw new Error("crash boundary was not reached");
  `;
  const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", source, file, cut], { cwd: root, encoding: "utf8", windowsHide: true });
  expect(crashed.signal, crashed.stderr).toBe("SIGKILL");
  const reopened = await launch(home, data);
  expect(reopened.output()).not.toContain("MEMORY_SCHEMA_UNSUPPORTED");
  expect(reopened.ready, reopened.output()).toBe(true);
  expect(objects(file, ["memory_session_roots", ...ROOT_TRIGGERS])).toEqual(cut === "before-commit" ? ["memory_session_roots", ...ROOT_TRIGGERS] : []);
  const check = new DatabaseSync(file, { readOnly: true });
  try { expect(check.prepare("SELECT value FROM memory_lineage_lsn_meta WHERE key='root_sets_dropped'").get()?.value).toBe(cut === "before-commit" ? 0 : 1); }
  finally { check.close(); }
});
