// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 N2 bootprog: while the start screen waits on a slow start it names the inner step the server is in. The shell already reads the
// server's start-up note (server/boot-progress.ts: step name and sequence number, its own child's only) for the 5-minute wait
// (electron/boot-progress-watch.mjs); the same readings now reach the start screen as one plain line, "Step 37 · Opening your memory", after
// the first 5 s, with no new probe and no change to the wait. Here a real child runs the real heartbeat thread and moves through real
// steps; main.mjs's own startServerOn (taken from its source and run) starts the real watcher on that child's pid and passes each reading
// through main.mjs's own showBootStep to the real start screen, whose real page script is run on a small document to see what the owner reads.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import vm from "node:vm";
import { test } from "vitest";

import { withHideInherit } from "../shared/win-hide-child-process.mjs";
import { readDataVersion, showsNewerDataScreen } from "../shared/data-version-marker.mjs";
import { MEMORY_INDEX_STOPPED } from "./memory-upgrade-status.mjs";
import { readBootProgress, watchBootProgress } from "./boot-progress-watch.mjs";
import { SPLASH_SCRIPT, createStartupSplash } from "./startup-splash.mjs";

const realDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
const between = (a, b) => { const at = source.indexOf(a); assert.ok(at >= 0, `main.mjs has ${a}`); return source.slice(at, source.indexOf(b, at)); };
// the words module is new in this change: on the base it is missing, and every case below says so instead of failing to load
const words = await import("./boot-step-words.mjs").catch(() => ({}));

/** A child that starts the real note and moves to the next real step (setBootStep) each time the test asks. */
async function steppingChild(dir) {
  const script = join(dir, "stepper.mjs");
  writeFileSync(script, `import { setBootStep, startBootProgress } from ${JSON.stringify(new URL("../server/boot-progress.ts", import.meta.url).href)};
startBootProgress(process.argv[2], { intervalMs: 20, step: "modules" });
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { for (const line of chunk.split("\\n")) if (line) setBootStep(line); });
console.log("beating");
`);
  const child = spawn(process.execPath, [script, dir], { stdio: ["pipe", "pipe", "inherit"] });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("beating")) resolve(); });
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  const step = async (name) => {
    child.stdin.write(`${name}\n`);
    for (let i = 0; i < 250; i += 1) { if (readBootProgress(dir, { pid: child.pid })?.step === name) return; await realDelay(20); }
    throw new Error(`the note never showed step ${name}`);
  };
  return { child, closed, step, stop: async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; } };
}

/** The real start screen in a window that only records what the shell runs in it, and the real page script on a small document. */
function startScreen(options = {}) {
  const page = {};
  const element = (id) => (page[id] ??= { id, textContent: "", style: {}, dataset: {}, classList: { toggle() {} }, setAttribute() {}, removeAttribute() {}, addEventListener() {} });
  const document = { body: { dataset: { layout: "tip" } }, documentElement: {}, title: "", getElementById: element, querySelector: () => null };
  const ctx = vm.createContext({ document, window: {}, performance, requestAnimationFrame: () => 0, setInterval: () => 0, clearInterval() {}, matchMedia: () => ({ matches: true }) });
  vm.runInContext(SPLASH_SCRIPT, ctx);
  class Window {
    constructor() { this.webContents = { setWindowOpenHandler() {}, on() {}, executeJavaScript: (code) => { vm.runInContext(code, ctx); return Promise.resolve(); } }; }
    on() {} loadURL() { return Promise.resolve(); } setSize() {} center() {} setMinimizable() {} setSkipTaskbar() {} show() {} isDestroyed() { return false; } destroy() {}
  }
  const timers = { setTimeout: () => ({}), clearTimeout() {} };
  const splash = createStartupSplash({ BrowserWindow: Window, mode: "tip", language: "en", timers, ...options });
  return { splash, line: () => element("c").textContent, stageLine: () => element("p").textContent };
}

/** main.mjs's own startServerOn (and showBootStep), run from its source with the real watcher and the real start screen. The child is a stub
 * process object carrying the real child's pid; the server-identity poll is the one stubbed part, and it is where the test drives the steps.
 * On a tree without the fix every name below still resolves (showBootStep / bootStepLine just are not there), so the cases fail at what the owner reads. */
async function startThroughMain({ screen, dir, pid, language = "en", drive }) {
  let clock = 0;
  let watch = null;
  const proc = Object.assign(new EventEmitter(), { pid, postMessage() {} });
  const scope = {
    withHideInherit, readDataVersion, showsNewerDataScreen, MEMORY_INDEX_STOPPED,
    bootStepLine: words.bootStepLine, startupSplash: screen.splash, systemLanguage: () => language, desktopShutdownStarted: false,
    path, process: { platform: "linux", env: {}, resourcesPath: "/fixture/resources" }, restoredConnections: null, restoredHarnessEnvironment: (env) => env,
    app: { isPackaged: true, getVersion: () => "1.0.0", getPath: () => "/fixture/user-data", getAppPath: () => "/fixture/resources/app.asar" },
    companionToken: "private-companion", modelProviderCommitToken: "private-model-provider-commit", mcpCommitToken: "private-mcp-commit",
    secureCredentials: {}, credentialStoreUnavailable: false, desktopSurfaceSecret: "", browserHost: null,
    launchSecretVia: () => ({}), sendLaunchSecretParent() {}, managedComposioChildEnvironment: (_url, _keys, env) => env, composioBrokerUrl: () => null,
    fluxComposioBrokerUrlValue: () => "", composioLegacyUntilValue: () => "", phoneSecretsEnv: () => "{}", harnessResourceEnvironment: () => ({}),
    packagedGepaManifestEnvironment: () => ({ MURAGE_GEPA_MANIFEST_SHA256: "" }), workspaceCredentialEnv: () => ({}), desktopFluxEnvironment: () => ({}),
    secretSaveRefusedReason: async () => "", slog() {}, compileCacheEnvironment: () => ({}), desktopMark() {},
    utilityProcess: { fork: () => proc }, receiveDesktopSurfaceSecret: () => false, receiveBrowserControlHold: () => false, receiveBrowserLifecycleCleanup: () => false,
    syncBrowserConnection() {}, portAvailable: async () => true, SERVER_BOOT_TIMEOUT_MS: 25, SERVER_BOOT_SLOW_LIMIT_MS: 25,
    desktopDataOwner: { utilityServerLeaseEnvironment: () => ({ MURAGE_INTERNAL_DATA_DIR_LEASE: "private-fixture-capability" }) }, desktopDataDir: dir,
    closedControlDirectory: () => dir, assertDesktopStartupActive() {}, cancelComposioChild() {}, launchIdOf: () => "launch",
    trackOwnedServerChild: () => ({ exit: new Promise(() => {}), exited: false, failed: false, stop: async () => {} }),
    watchMemoryUpgrade: () => ({ stop() {}, active: () => false, fresh: () => false, status: () => null, feed() {} }), showMemoryUpgradeProgress() {}, closeMemoryUpgradeWindow() {},
    readMemoryUpgradeStatus: () => null, clearMemoryUpgradeStatus() {}, memoryUpgradeBlocked: null, upgradeTimeoutCode: () => "", isOneTimeIndexNote: () => false,
    bootSystemSuspended: false, crypto: globalThis.crypto, setTimeout, clearTimeout, Promise, Array, Uint8Array, Date, Error, String, Object,
    // the real watcher; only its clock and timer are held, so a test spends no real 5 seconds
    watchBootProgress: (options) => (watch = watchBootProgress({ ...options, now: () => clock, setTimer: () => ({}), clearTimer: () => {} })),
    pollServerIdentity: async () => { await drive({ tick: (ms) => { clock = ms; watch.tick(); }, watch: () => watch }); return { outcome: "ready" }; },
  };
  const ctx = vm.createContext(scope);
  vm.runInContext(between("function closeMemoryUpgradeWindow(", "function syncBrowserConnection(") + between("async function startServerOn(", "async function startServerPackaged("), ctx);
  const result = await ctx.startServerOn(8799);
  assert.ok(result?.proc, "the start went ready");
}

test("W1 a slow start names its inner step on the start screen: nothing in the first 5 s, then 'Step N · <plain words>' following the real note", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "boot-step-"));
  const run = await steppingChild(dir);
  try {
    const screen = startScreen();
    await startThroughMain({ screen, dir, pid: run.child.pid, drive: async ({ tick, watch }) => {
      await run.step("database.wal");
      tick(2_000);
      assert.equal(screen.line(), "", "a start still inside its first 5 s shows no step line (a fast start looks as before)");
      tick(5_000);
      const walSeq = readBootProgress(dir, { pid: run.child.pid }).seq;
      assert.equal(screen.line(), `Step ${walSeq} · Finishing what was saved last time`);
      await run.step("database.memory");
      tick(5_400);
      const memorySeq = readBootProgress(dir, { pid: run.child.pid }).seq;
      assert.ok(memorySeq > walSeq, "the step number is the note's own sequence number, moving with each step");
      assert.equal(screen.line(), `Step ${memorySeq} · Opening your memory`);
      await run.step("wiring.10671");
      tick(5_800);
      assert.match(screen.line(), /^Step \d+ · Getting things ready$/);
      assert.doesNotMatch(screen.line(), /wiring|10671/, "the raw step id never reaches the owner");
      assert.equal(watch().fresh(), true, "the wait rules are unchanged: an advancing note is still fresh");
      // listen removes the note: the step line goes with it
      rmSync(join(dir, "boot-progress.json"), { force: true });
      await run.stop();
      rmSync(join(dir, "boot-progress.json"), { force: true });
      tick(6_200);
      assert.equal(screen.line(), "", "the line clears once the note is gone");
    } });
  } finally {
    await run.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1b an earlier launch's note (another pid) never names a step on this start's screen, while this child's own note does", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "boot-step-"));
  const run = await steppingChild(dir);
  try {
    // positive control on the same note: the start of the child that wrote it does show its step (so the empty line below is the pid fence, not a missing feature)
    const own = startScreen();
    await startThroughMain({ screen: own, dir, pid: run.child.pid, drive: async ({ tick }) => {
      await run.step("database.memory");
      tick(30_000);
      const seq = readBootProgress(dir, { pid: run.child.pid }).seq;
      assert.equal(own.line(), `Step ${seq} · Opening your memory`);
    } });
    const screen = startScreen();
    await startThroughMain({ screen, dir, pid: run.child.pid + 1, drive: async ({ tick }) => {
      tick(30_000);
      assert.equal(screen.line(), "");
      assert.equal(readBootProgress(dir, { pid: run.child.pid })?.step, "database.memory", "the note is there, and is another child's");
    } });
  } finally {
    await run.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W2 every step name the server writes gets a plain phrase in all eight languages on the start screen; the raw id is never shown", { timeout: 120_000 }, async () => {
  // every fixed step name passed to startupMark/bootStep/setBootStep under server/ (the names come from the source, so a new step is covered)
  const names = new Set(["modules", "boot"]);
  const files = ["server/index.ts", "server/database.ts", "server/read-only-start.ts", "server/team-lifecycle.ts", "server/routines.ts"];
  for (const file of files) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    for (const m of text.matchAll(/(?:startupMark|bootStep|bootStepAsync|setBootStep)\("([A-Za-z0-9._:-]+)"/g)) names.add(m[1]);
  }
  assert.ok(names.size > 40, `found the server's step names (${names.size})`);
  const dir = mkdtempSync(join(tmpdir(), "boot-step-"));
  const run = await steppingChild(dir);
  try {
    let at = 6_000;
    for (const language of ["en", "de", "es", "fr", "hi", "ja", "pt", "zh", "xx-YY", undefined]) {
      const screen = startScreen();
      await startThroughMain({ screen, dir, pid: run.child.pid, language, drive: async ({ tick }) => {
        for (const step of names) {
          await run.step(step);
          at += 400;
          tick(at);
          const line = screen.line();
          const seq = readBootProgress(dir, { pid: run.child.pid }).seq;
          assert.match(line, new RegExp(`^\\S+ ${seq} · \\S`), `${language}/${step}: the owner reads a numbered step line, got "${line}"`);
          assert.ok(!line.includes(step) || !/[._]/.test(step), `${language}/${step}: raw id shown in "${line}"`);
          assert.doesNotMatch(line, /undefined|null|\{/, `${language}/${step}`);
        }
        await run.step("migrate.schema");
        tick((at += 400));
        const seq = readBootProgress(dir, { pid: run.child.pid }).seq;
        if (language === "de") assert.equal(screen.line(), `Schritt ${seq} · Deine Daten werden für diese Version aktualisiert`);
        if (language === "en") assert.equal(screen.line(), `Step ${seq} · Updating your data for this version`);
      } });
    }
  } finally {
    await run.stop();
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(words.bootStepLine({ step: "teams.reconcileIdentities", seq: 40 }, { language: "en", sinceMs: 6_000 }), "Step 40 · Loading your teams");
  assert.equal(words.bootStepLine({ step: "database.memory", seq: 4 }, { language: "en", sinceMs: 4_999 }), null, "inside the first 5 s: nothing");
  assert.equal(words.bootStepLine(null, { language: "en", sinceMs: 60_000 }), null, "no note: nothing");
  assert.equal(words.bootStepLine({ step: "database.memory" }, { language: "en", sinceMs: 60_000 }), null, "a note without a step number: nothing");
});

test("W3 while a memory-upgrade view owns the window the step line is ignored; the stage line is never touched", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "boot-step-"));
  const run = await steppingChild(dir);
  try {
    const screen = startScreen();
    await startThroughMain({ screen, dir, pid: run.child.pid, drive: async ({ tick }) => {
      await run.step("database.memory");
      tick(6_000);
      const seq = readBootProgress(dir, { pid: run.child.pid }).seq;
      assert.equal(screen.line(), `Step ${seq} · Opening your memory`, "before the upgrade view the step line is shown");
      assert.equal(screen.stageLine(), "", "the step line has its own slot, not the stage line");
      screen.splash.set({ kind: "upgrade", mode: "copying", title: "Upgrading", line: "Copying", counter: { kind: "text", text: "1 of 2" } });
      await run.step("wiring.10671");
      tick(6_400);
      assert.equal(screen.line(), "1 of 2", "an upgrade view owns the text");
    } });
  } finally {
    await run.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W4 startServerOn (run from main.mjs) hands the watcher's readings for its own child to the start screen, in the owner's language", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "boot-step-"));
  const run = await steppingChild(dir);
  try {
    const screen = startScreen();
    await startThroughMain({ screen, dir, pid: run.child.pid, language: "de", drive: async ({ tick }) => {
      await run.step("database.memory");
      tick(7_000);
      const seq = readBootProgress(dir, { pid: run.child.pid }).seq;
      assert.equal(screen.line(), `Schritt ${seq} · Dein Gedächtnis wird geöffnet`);
    } });
  } finally {
    await run.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
