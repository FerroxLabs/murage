// Isolated existing-install fixture proof, not a fresh-install/package benchmark.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, platform, release, arch } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { freePortBlock } from "../server/testing/ports.ts";
import { removeTempDir, waitForExit } from "../server/testing/cleanup.ts";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), "murage-concurrency-"));
const dataDir = join(home, ".murage");
const gate = join(home, "load-gate");
const image = join(repository, "public/icons/murage-512.png");
const started = Date.now(), deadline = started + 120_000;
const secret = randomBytes(24).toString("hex");
let child: ChildProcess | undefined;
let stderrBytes = 0;
type ProcessSample = { pid: number; ppid: number; rssKiB: number; started: string };
const owned = new Map<number, string>();
function processTable(): ProcessSample[] {
  return execFileSync("ps", ["-axo", "pid=,ppid=,rss=,lstart="], { encoding: "utf8", timeout: 3000 }).trim().split("\n").flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]), started: match[4] }] : [];
  });
}
function sample(): { serverKiB: number; descendantsKiB: number; totalKiB: number; processes: number } {
  if (!child?.pid) return { serverKiB: 0, descendantsKiB: 0, totalKiB: 0, processes: 0 };
  const rows = processTable(); const ids = new Set([child.pid]);
  let changed = true;
  while (changed) { changed = false; for (const row of rows) if (ids.has(row.ppid) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; } }
  const found = rows.filter(row => ids.has(row.pid));
  for (const row of found) owned.set(row.pid, row.started);
  const serverKiB = found.find(row => row.pid === child!.pid)?.rssKiB ?? 0;
  const totalKiB = found.reduce((sum, row) => sum + row.rssKiB, 0);
  return { serverKiB, descendantsKiB: totalKiB - serverKiB, totalKiB, processes: found.length };
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function checkDeadline() { if (Date.now() >= deadline) throw new Error("Overall 120-second fixture deadline exceeded"); }
async function until(check: () => Promise<boolean>) {
  while (true) { checkDeadline(); if (await check()) return; await pause(80); }
}
type Message = { id: string; kind: string; text?: string; image?: unknown; media?: unknown; attachments?: unknown[] };
type Bot = { id: string; threadId: string; busy: boolean; messages: Message[] };
function nativeRows(threadId: string): any[] {
  const file = join(dataDir, "native", `${threadId}.ndjson`);
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}
const results: Record<string, unknown>[] = [];
const report: Record<string, unknown> = {
  fixture: "existing-install isolated HOME, explicit fake ACP engine only", sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
  sourceDirty: Boolean(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repository, encoding: "utf8" }).trim()),
  instrumentationSha256: Object.fromEntries(["scripts/bench-concurrency.ts", "server/testing/fake-acp-cli.ts"].map(path => [path, createHash("sha256").update(readFileSync(join(repository, path))).digest("hex")])),
  os: { platform: platform(), release: release(), arch: arch() }, node: process.version,
  expectedPerTurn: { payloadTextBytes: 64 * 1024, readyMarkerBytes: Buffer.byteLength("LOAD_PROOF_READY"), emittedImages: 3, imageBytes: readFileSync(image).length },
  levels: results, cleanupVerified: false,
  limitations: ["Source-checkout fixture, not installed package or fresh-start proof", "RSS is sampled process metadata, not an allocation/leak profile", "Images can deduplicate downstream", "No RSS acceptance threshold or real-provider capacity claim"],
};
try {
  if (platform() === "win32") throw new Error("This local benchmark requires POSIX ps; Windows proof remains separate");
  const port = await freePortBlock([0, 1]); const base = `http://127.0.0.1:${port}`;
  mkdirSync(dataDir); mkdirSync(join(home, ".grok")); mkdirSync(join(home, "static", "assets"), { recursive: true });
  writeFileSync(join(home, ".grok", "auth.json"), "{}");
  writeFileSync(join(home, "static", "index.html"), "<!doctype html><title>Isolated concurrency fixture</title>");
  writeFileSync(join(home, "static", "assets", "fixture.css"), "body{}");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ engineDiscovery: "explicit", instances: {
    fixtureLoad: { driver: "grokAgent", displayName: "Isolated load fixture", config: { cli: join(repository, "server/testing/fake-acp-cli.ts") } },
  } }));
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, MURAGE_DATA_DIR: dataDir, MURAGE_STATIC_DIR: join(home, "static"),
    MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_DEV_DESKTOP_SECRET: secret,
    FAKE_ACP_MODE: "load-proof", FAKE_LOAD_GATE: gate, FAKE_LOAD_IMAGE: image, FAKE_LOAD_TIMEOUT_MS: "30000",
    PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  child = spawn(process.execPath, [join(repository, "server/index.ts")], { cwd: repository, env, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr!.on("data", chunk => { stderrBytes += chunk.length; });
  const request = async (method: string, path: string, body?: unknown) => {
    checkDeadline();
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": secret }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now()))) });
    const value = await response.json();
    if (!response.ok) throw new Error(`Fixture HTTP ${response.status} on ${method} ${path.replace(/[a-f0-9-]{30,}/g, "<id>")}`);
    return value;
  };
  await until(async () => {
    if (child!.exitCode !== null) throw new Error(`Owned harness exited before readiness (code ${child!.exitCode}; ${stderrBytes} stderr bytes)`);
    try { await request("GET", "/api/health"); return true; } catch { return false; }
  });
  const instances = (await request("GET", "/api/instances")).instances;
  if (instances.length !== 1 || instances[0].instanceId !== "fixtureLoad") throw new Error("Fixture registry contains an unexpected engine");
  const snapshot = async (): Promise<Bot[]> => (await request("GET", "/api/bots?messages=1000")).bots;
  for (const concurrency of [1, 5, 10]) {
    const bots: Bot[] = [];
    for (let i = 0; i < concurrency; i++) {
      const bot = (await request("POST", "/api/bots", { modelSelection: { instanceId: "fixtureLoad", model: "grok-4.6" } })).bot;
      await request("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false, autoApprove: false, notifications: false });
      bots.push(bot);
    }
    for (let cycle = 1; cycle <= 2; cycle++) {
      if (existsSync(gate)) rmSync(gate);
      const before = await snapshot();
      const prior = new Map(bots.map(bot => [bot.id, new Set(before.find(row => row.id === bot.id)!.messages.map(message => message.id))]));
      const offsets = new Map(bots.map(bot => [bot.threadId, nativeRows(bot.threadId).length]));
      const begin = Date.now(); let peak = sample();
      const observe = () => { const current = sample(); if (current.totalKiB > peak.totalKiB) peak = current; };
      await Promise.all(bots.map(bot => request("POST", `/api/bots/${bot.id}/messages`, { text: `Isolated synthetic load cycle ${cycle}; do not access external services.` })));
      let simultaneousReady = 0;
      await until(async () => {
        observe(); const current = await snapshot();
        simultaneousReady = bots.filter(bot => {
          const row = current.find(item => item.id === bot.id)!;
          // Streaming text is not persisted as a chat message until flush.
          // Use the received ACP frame as readiness evidence before releasing
          // the gate; waiting for stored text here deadlocks the fixture.
          return row.busy && nativeRows(bot.threadId).slice(offsets.get(bot.threadId)!).some(entry =>
            entry.dir === "in" && entry.msg?.method === "session/update"
            && entry.msg.params?.update?.content?.text === "LOAD_PROOF_READY");
        }).length;
        return simultaneousReady === concurrency;
      });
      const readyMs = Date.now() - begin;
      writeFileSync(gate, "release"); const releaseAt = Date.now();
      await until(async () => { observe(); const current = await snapshot(); return bots.every(bot => current.find(row => row.id === bot.id)?.busy === false); });
      const settledMs = Date.now() - releaseAt;
      const final = await snapshot();
      const workload = bots.map(bot => {
        const all = nativeRows(bot.threadId); const offset = offsets.get(bot.threadId)!;
        if (all.length < offset) throw new Error("Native fixture log rotated; cycle evidence cannot be isolated");
        const rows = all.slice(offset);
        const blocks = rows.filter(row => row.dir === "in" && row.msg?.method === "session/update").map(row => row.msg.params?.update?.content).filter(Boolean);
        const textBytes = blocks.reduce((sum, block) => sum + (typeof block.text === "string" ? Buffer.byteLength(block.text) : 0), 0);
        const emittedImages = blocks.filter(block => block.type === "image").length;
        const completed = rows.some(row => row.dir === "in" && row.msg?.result?.stopReason === "end_turn");
        const messages = final.find(row => row.id === bot.id)!.messages.filter(message => !prior.get(bot.id)!.has(message.id));
        const storedImages = messages.filter(message => message.kind === "image" || message.image || message.media || message.attachments?.length).length;
        if (!completed || textBytes !== 65536 + Buffer.byteLength("LOAD_PROOF_READY") || emittedImages !== 3 || storedImages < 1) throw new Error(`Fixture workload mismatch: completed=${completed}, textBytes=${textBytes}, emittedImages=${emittedImages}, storedImageMessages=${storedImages}`);
        return { textBytes, emittedImages, storedImageMessages: storedImages, newMessages: messages.length };
      });
      await pause(250); const idle = sample();
      results.push({ concurrency, cycle, simultaneousReady, admissionToReadyMs: readyMs, gateToSettledMs: settledMs, totalMs: Date.now() - begin, peakRss: peak, idleRss: idle, workload });
    }
  }
  report.completed = true;
} catch (error) {
  report.completed = false; report.error = error instanceof Error ? error.message : "Fixture failed";
  process.exitCode = 1;
} finally {
  try {
    sample();
    // Compare start stamps before signaling to avoid killing a reused PID.
    const liveOwned = () => processTable().filter(row => owned.get(row.pid) === row.started);
    for (const row of liveOwned().filter(row => row.pid !== child?.pid).reverse()) { try { process.kill(row.pid, "SIGTERM"); } catch { /* exited */ } }
    await waitForExit(child, { signal: "SIGTERM", graceMs: 2000 });
    for (const row of liveOwned()) { try { process.kill(row.pid, "SIGKILL"); } catch { /* exited */ } }
    const cleanupDeadline = Date.now() + 3000;
    while (liveOwned().length && Date.now() < cleanupDeadline) await pause(50);
    const clean = (!child || child.exitCode !== null || child.signalCode !== null) && liveOwned().length === 0;
    report.cleanupVerified = clean;
    if (clean) { await removeTempDir(home); report.fixtureRemoved = !existsSync(home); }
    else { report.preservedFixture = home; process.exitCode = 1; }
  } catch { report.cleanupVerified = false; report.preservedFixture = home; process.exitCode = 1; }
  report.elapsedMs = Date.now() - started;
  console.log(JSON.stringify(report, null, 2));
}
