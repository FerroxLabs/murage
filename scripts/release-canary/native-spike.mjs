// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import {
  existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statfsSync, unlinkSync, writeFileSync,
} from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { startFeed } from "./feed.mjs";
import { click, clearOfPrompts, connectRenderer, readMemory, runTurn, screenshot, until, updaterState } from "./native-cdp.mjs";
import { feedWitness, sha256, waitForMemory } from "./native-evidence.mjs";
import {
  command, inside, listeningOnlyOnLoopback, mac, mainProcess, nativeSession, processRows,
  quitNative, sameProcess, signedIdentity, treeOf, underCanaryHome, win,
} from "./native-os.mjs";
import { logSlice, markLog, verifyQuit } from "./quit.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const json = path => JSON.parse(readFileSync(path, "utf8"));
const semver = /^\d+\.\d+\.\d+$/;
const shaPattern = /^[a-f0-9]{64}$/;
const debugArgument = /(?:^|\s)--(?:remote-debugging[-\w]*|proxy-server|ignore-certificate-errors-spki-list|user-data-dir)(?:[=\s]|$)/;
const denyRules = [
  /RELAY_SEALED/, /seals the relay/, /mount-relay-sealed/, /relay\.seal/, /\[mount-relay\].*failed/,
  /engine connection (error|closed)/, /ERR_MODULE_NOT_FOUND|Cannot find module/,
  /uncaughtException|unhandledRejection/, /render-process-gone|child-process-gone/,
];

const [spike, configFile] = process.argv.slice(2);
const receipt = { spike, platform: process.platform, verdict: "INCOMPLETE" };
const reasons = new Set([
  "NOT_CANARY_ACCOUNT", "OFFLINE", "NO_BACKGROUND_SESSION", "ISOLATION", "DISK", "RESTORE",
  "STALE_CACHE", "ARTIFACT_MISMATCH", "SIGNATURE", "IDENTITY", "RELAUNCH", "TEARDOWN", "FEED",
  "CONSUMED_MISMATCH", "WRONG_PIN_CONTROL", "NEVER_LIST_BLOCKED", "PROFILE_STALE", "SETUP",
  "CDP_UNAVAILABLE", "CDP_TARGET", "CDP_LISTENER", "CDP_INPUT", "CDP_CALL", "CDP_EVALUATE",
  "SCREENSHOT_BLANK", "UI_CONTROL", "NEW_THREAD", "TURN_TIMEOUT", "TURN_ERROR", "DATA_SMALL",
  "DATA_STALE", "DATA_COPY_LIVE", "MEMORY_STUCK", "NO_GRACEFUL_QUIT", "NATIVE_COMMAND",
]);
const setupError = error => reasons.has(error?.message) || /^LOG_DENY:D[1-9]$/.test(error?.message)
  ? error.message : error?.message?.startsWith("NO_GRACEFUL_QUIT") ? "NO_GRACEFUL_QUIT" : "SETUP";
const incomplete = new Set([
  "NOT_CANARY_ACCOUNT", "OFFLINE", "NO_BACKGROUND_SESSION", "ISOLATION", "DISK", "STALE_CACHE",
  "PROFILE_STALE", "SETUP", "DATA_SMALL", "DATA_STALE", "DATA_COPY_LIVE", "NATIVE_COMMAND",
]);

async function validatePack(file, dataDir) {
  const packFile = underCanaryHome(file);
  if (inside(dataDir, packFile)) throw Error("DATA_COPY_LIVE");
  const pack = json(packFile);
  const age = Date.now() - Date.parse(pack.created);
  if (!(age >= 0 && age <= 30 * 86400000)) throw Error("DATA_STALE");
  if (pack.scrub?.channels_disabled !== true || pack.scrub?.routines_paused !== true ||
      pack.scrub?.connector_credentials_removed !== true || pack.scrub?.secrets_removed !== true) {
    throw Error("DATA_COPY_LIVE");
  }
  if (!Number.isSafeInteger(pack.source_bytes) || pack.source_bytes < 1 || !Object.keys(pack.files ?? {}).length) {
    throw Error("DATA_SMALL");
  }
  const forbiddenRoots = new Set(["secrets", "providers", "server-home", "telegram", "whatsapp", "signal", "highlevel",
    "local-models", "browser-engine-key", "flux-composio-broker-token.json", "env"]);
  const files = new Set();
  for (const entry of readdirSync(dataDir, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.parentPath === dataDir && forbiddenRoots.has(entry.name)) throw Error("DATA_COPY_LIVE");
    } else if (entry.isFile()) {
      files.add(join(entry.parentPath, entry.name));
    } else throw Error("DATA_COPY_LIVE");
  }
  let total = 0;
  for (const [name, expected] of Object.entries(pack.files)) {
    const entry = resolve(dataDir, name);
    if (isAbsolute(name) || !inside(dataDir, entry) || !files.delete(entry) ||
        realpathSync(entry) !== entry || lstatSync(entry).nlink !== 1 || forbiddenRoots.has(name.split(/[\\/]/)[0])) {
      throw Error("DATA_COPY_LIVE");
    }
    if (!shaPattern.test(expected) || await sha256(entry) !== expected) throw Error("DATA_COPY_LIVE");
    total += lstatSync(entry).size;
  }
  if (files.size) throw Error("DATA_COPY_LIVE");
  const routines = join(dataDir, "routines.json");
  if (existsSync(routines)) {
    const record = json(routines);
    if (!Array.isArray(record.routines) || record.routines.some(row => row.enabled !== false)) {
      throw Error("DATA_COPY_LIVE");
    }
  }
  const free = statfsSync(dataDir);
  if (free.bavail * free.bsize < total * 2 + 10e9) throw Error("DISK");
  if (total < pack.source_bytes * 0.8) throw Error("DATA_SMALL");
  return { bytes: total, manifest_sha256: await sha256(packFile) };
}

function captureLogs(serverLog, since, thread) {
  const bytes = logSlice(serverLog, since);
  const lines = bytes.toString("utf8").split(/\r?\n/);
  const rule = denyRules.findIndex(pattern => lines.some(line => pattern.test(line)));
  if (rule >= 0) throw Error(`LOG_DENY:D${rule + 1}`);
  if (thread && lines.some(line => line.includes(`thread=${thread} `) &&
      /\[memory\] fence recovery .*refused=checking(?::|\s)/.test(line))) {
    throw Error("MEMORY_STUCK");
  }
  return { bytes: bytes.length, sha256: sha(bytes) };
}

async function main() {
  if (!["s0", "s1", "s5"].includes(spike) || !configFile || !(mac || win) ||
      Number(process.versions.node.split(".")[0]) < 22) throw Error("SETUP");
  const config = json(configFile);
  if (Object.keys(process.env).some(key => key.toUpperCase().startsWith("MURAGE_"))) throw Error("ISOLATION");
  const session = nativeSession(config.account, spike === "s0");
  if (!semver.test(config.installed?.version ?? "") || !shaPattern.test(config.installed?.exe_sha256 ?? "") ||
      !/^[a-zA-Z0-9]+$/.test(config.installed?.signer ?? "") ||
      spike === "s5" && config.installed.version !== "1.0.20") throw Error("SETUP");
  const home = realpathSync(homedir());
  const app = mac ? underCanaryHome(join(home, "Applications", "Murage.app")) : undefined;
  const exe = underCanaryHome(mac ? join(app, "Contents", "MacOS", "Murage") : config.exe);
  const resources = mac ? join(app, "Contents", "Resources") : join(dirname(exe), "resources");
  if (win && !inside(join(home, "AppData", "Local", "Programs"), exe)) throw Error("ISOLATION");
  const userData = underCanaryHome(mac ? join(home, "Library", "Application Support", "Murage")
    : join(home, "AppData", "Roaming", "Murage"));
  const dataDir = underCanaryHome(join(home, ".murage"));
  const logDir = underCanaryHome(mac ? join(home, "Library", "Logs", "Murage") : join(userData, "logs"));
  const serverLog = underCanaryHome(join(logDir, "server.log"));
  const disk = statfsSync(home);
  if (disk.bavail * disk.bsize < 10e9) throw Error("DISK");
  const out = underCanaryHome(config.out);
  if (out === dataDir || inside(dataDir, out) || out === userData || inside(userData, out)) throw Error("ISOLATION");
  const localOut = mkdtempSync(join(out, "canary-spike-"));
  const rows = () => processRows(exe);
  const current = () => mainProcess(rows(), exe, session);
  const guardSession = () => nativeSession(config.account, spike === "s0");
  if (current()) throw Error("RESTORE");

  async function identity(expected) {
    if (!semver.test(expected?.version ?? "") || !shaPattern.test(expected?.exe_sha256 ?? "") ||
        !/^[a-zA-Z0-9]+$/.test(expected?.signer ?? "") || (mac && !/^[a-f0-9]{40}$/.test(expected?.cdhash ?? ""))) {
      throw Error("SETUP");
    }
    const actual = signedIdentity(exe, app);
    const digest = await sha256(exe);
    if (actual.version !== expected.version && actual.version !== `${expected.version}.0` ||
        actual.signer.toLowerCase() !== expected.signer.toLowerCase() ||
        (mac && actual.cdhash !== expected.cdhash) || digest !== expected.exe_sha256) throw Error("IDENTITY");
    return { version: expected.version, exe_sha256: digest, ...(mac ? { cdhash: actual.cdhash } : {}) };
  }

  let active, native, renderer, feed, key, scanFrom, thread;
  const checkStopped = async tree => {
    await until(60000, "TEARDOWN", () => !rows().some(row => tree.some(old => sameProcess(old, row))));
    await pause(2000);
  };
  const stopRenderer = async () => {
    if (!active) return;
    if (!sameProcess(active, current())) throw Error("TEARDOWN");
    const beforeQuit = markLog(serverLog);
    const tree = treeOf(rows(), active);
    if (!renderer) {
      quitNative(active.pid);
    } else {
      await renderer.evaluate(() => {
        setTimeout(() => { void window.muragebox.quit(); }, 0);
        return true;
      });
      renderer.close();
      renderer = null;
    }
    await checkStopped(tree);
    active = null;
    verifyQuit(serverLog, beforeQuit);
  };
  const stopNative = async () => {
    if (!native) return;
    if (!sameProcess(native, current())) throw Error("TEARDOWN");
    const beforeQuit = markLog(serverLog);
    const tree = treeOf(rows(), native);
    quitNative(native.pid);
    await checkStopped(tree);
    native = null;
    verifyQuit(serverLog, beforeQuit);
  };

  const launch = async (args, maxMs) => {
    guardSession();
    const socket = net.createServer();
    const port = await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.listen(0, "127.0.0.1", () => {
        const { port } = socket.address();
        socket.close(() => resolve(port));
      });
    });
    const start = performance.now();
    const child = spawn(exe, ["--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`, ...args],
      { cwd: home, stdio: "ignore" });
    const spawned = await new Promise(resolve => {
      child.once("spawn", () => resolve(true));
      child.once("error", () => resolve(false));
    });
    if (!spawned) throw Error("OFFLINE");
    try {
      active = await until(15000, "CDP_UNAVAILABLE", () => {
        const process = current();
        return process?.pid === child.pid ? process : null;
      });
      renderer = await connectRenderer(port, () => listeningOnlyOnLoopback(active.pid, port), Math.max(1, maxMs - (performance.now() - start)), guardSession);
    } catch (error) {
      if (active && spike === "s5" && error.message === "CDP_UNAVAILABLE") throw Error("MEMORY_STUCK");
      throw error;
    }
    const state = await updaterState(renderer);
    if (state?.currentVersion !== config.installed.version) throw Error("IDENTITY");
    return start;
  };

  receipt.installed = await identity(config.installed);
  if (spike === "s5") receipt.pack = await validatePack(config.pack, dataDir);
  try {
    if (spike === "s0" || spike === "s5") {
      scanFrom = markLog(serverLog);
      const limit = config.memory_timeout_s ?? 300;
      if (!Number.isInteger(limit) || limit < 180 || limit > 3600) throw Error("SETUP");
      const start = await launch([], spike === "s5" ? limit * 1000 : 120000);
      if (spike === "s5") {
        const seen = [];
        receipt.memory = { states_seen: seen };
        receipt.memory = await waitForMemory(() => readMemory(renderer), () => (performance.now() - start) / 1000,
          () => pause(2000), limit, seen);
        receipt.memory_settle_candidate_s = Math.max(180, 3 * receipt.memory.settled_s);
      } else {
        await clearOfPrompts(renderer);
        const image = await screenshot(renderer);
        writeFileSync(join(localOut, "start.png"), image, { mode: 0o600, flag: "wx" });
        receipt.start_screenshot_sha256 = sha(image);
      }
      receipt.turn = await runTurn(renderer, guardSession, turnThread => { thread = turnThread; });
      guardSession();
      if (spike === "s0") {
        const image = await screenshot(renderer);
        writeFileSync(join(localOut, "turn.png"), image, { mode: 0o600, flag: "wx" });
        receipt.background = session.mode;
        receipt.turn_screenshot_sha256 = sha(image);
      } else if (await readMemory(renderer) !== "SETTLED") {
        throw Error("MEMORY_STUCK");
      }
      await stopRenderer();
      return;
    }

    const candidate = config.candidate;
    if (!semver.test(candidate?.version ?? "") || candidate.version === config.installed.version ||
        !shaPattern.test(candidate?.exe_sha256 ?? "") || !/^[a-zA-Z0-9]+$/.test(candidate?.signer ?? "") ||
        (mac && !/^[a-f0-9]{40}$/.test(candidate?.cdhash ?? "")) || !shaPattern.test(candidate?.manifest_sha256 ?? "")) {
      throw Error("SETUP");
    }
    const manifest = json(candidate.manifest);
    if (await sha256(candidate.manifest) !== candidate.manifest_sha256 || manifest.version !== candidate.version) {
      throw Error("ARTIFACT_MISMATCH");
    }
    const payload = mac ? `Murage-${candidate.version}-arm64.zip` : `Murage-${candidate.version}-setup.exe`;
    const channel = mac ? "latest-mac.yml" : "latest.yml";
    receipt.manifest_sha256 = candidate.manifest_sha256;
    if (!manifest.assets?.[payload] || !manifest.assets?.[channel]) throw Error("ARTIFACT_MISMATCH");
    const packagedFeed = readFileSync(join(resources, "app-update.yml"), "utf8");
    const cacheName = /^updaterCacheDirName:\s*['"]?([\w-]+)['"]?\s*$/m.exec(packagedFeed)?.[1];
    if (!cacheName) throw Error("SETUP");
    const cacheRoot = underCanaryHome(mac ? join(home, "Library", "Caches") : join(home, "AppData", "Local"));
    const pending = join(cacheRoot, cacheName, "pending");
    if (existsSync(join(pending, "update-info.json"))) throw Error("STALE_CACHE");
    const cert = join(localOut, "cert.pem");
    key = join(localOut, "key.pem");
    const log = join(localOut, "feed.log");
    command("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1",
      "-subj", "/CN=github.com", "-addext", "subjectAltName=DNS:github.com,DNS:api.github.com", "-out", cert, "-keyout", key]);
    const pin = createHash("sha256").update(new X509Certificate(readFileSync(cert)).publicKey.export({
      type: "spki", format: "der",
    })).digest("base64");
    feed = await startFeed({ dir: candidate.dir, manifest, from: config.installed.version, cert, key, log, proxyPort: 0 });
    const feedEvents = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
    const button = 'button[data-setting-control="updates-heading"]';
    const runCheck = async (spki, expected) => {
      await launch([`--proxy-server=http://127.0.0.1:${feed.proxyPort}`, `--ignore-certificate-errors-spki-list=${spki}`,
        `--user-data-dir=${userData}`], 120000);
      if (!await renderer.evaluate(selector => Boolean(document.querySelector(selector)?.getClientRects().length), button)) {
        await clearOfPrompts(renderer);
        await until(20000, "UI_CONTROL", () => click(renderer, 'button[aria-label="App settings"]', { optional: true }));
        await until(15000, "UI_CONTROL", () => click(renderer, 'button[data-settings-section="about"]', { optional: true }));
      }
      await clearOfPrompts(renderer);
      await until(12000, "UI_CONTROL", () => click(renderer, button, { label: "Check for updates", optional: true }));
      return until(60000, "FEED", async () => {
        await clearOfPrompts(renderer);
        const state = await updaterState(renderer);
        if (state?.status === "error" && expected !== "error") throw Error("FEED");
        return state?.status === expected ? state : null;
      });
    };

    const negative = await runCheck(randomBytes(32).toString("base64"), "error");
    if (!negative.tlsError || feedEvents().length || existsSync(join(pending, "update-info.json"))) {
      throw Error("WRONG_PIN_CONTROL");
    }
    await stopRenderer();
    receipt.wrong_pin = "TLS_REJECTED";

    const available = await runCheck(pin, "available");
    if (available.version !== candidate.version) throw Error("IDENTITY");
    await until(15000, "UI_CONTROL", () => click(renderer, button, { label: "Download", optional: true }));
    const downloaded = await until(600000, "FEED", async () => {
      await clearOfPrompts(renderer);
      const state = await updaterState(renderer);
      if (state?.status === "error") throw Error("FEED");
      return state?.status === "downloaded" ? state : null;
    });
    if (downloaded.version !== candidate.version) throw Error("IDENTITY");
    const info = json(underCanaryHome(join(pending, "update-info.json")));
    if (typeof info.fileName !== "string" || basename(info.fileName) !== info.fileName || !info.fileName) {
      throw Error("CONSUMED_MISMATCH");
    }
    const consumedPath = underCanaryHome(join(pending, info.fileName));
    if (dirname(consumedPath) !== pending || !lstatSync(consumedPath).isFile()) throw Error("CONSUMED_MISMATCH");
    const consumed = await sha256(consumedPath);
    if (consumed !== manifest.assets[payload].sha256) throw Error("CONSUMED_MISMATCH");
    receipt.consumed_sha256 = consumed;
    const events = feedEvents();
    receipt.feed = {
      mode: feedWitness(events, channel, payload), sha256: await sha256(log),
      sequence: events.map(({ route, status, name }) => ({ route, status, ...(name ? { name } : {}) })),
    };
    const previous = active;
    scanFrom = markLog(serverLog);
    await clearOfPrompts(renderer);
    await until(15000, "UI_CONTROL", () => click(renderer, button, { label: "Restart and install", optional: true }));
    const requested = performance.now();
    native = await until(180000, "RELAUNCH", () => {
      const found = current();
      return found && !sameProcess(found, previous) ? found : null;
    });
    active = null;
    if (!native.command || debugArgument.test(native.command)) throw Error("RELAUNCH");
    const relaunchS = Math.ceil((performance.now() - requested) / 1000);
    const verified = await identity(candidate);
    const launched = performance.now();
    while (performance.now() - launched < 45000) {
      if (!sameProcess(native, current())) throw Error("RELAUNCH");
      await pause(1000);
    }
    await stopNative();
    receipt.relaunch = { ...verified, appeared_s: relaunchS, stayed_up_s: 45, harness_switches: false, graceful: true };
  } finally {
    const failures = [];
    for (const cleanup of [stopNative, stopRenderer, () => renderer?.close(), () => feed?.close()]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (key && existsSync(key)) unlinkSync(key);
    if (scanFrom) receipt.log = captureLogs(serverLog, scanFrom, thread);
    if (failures.length) throw failures[0];
  }
}

try {
  await main();
  receipt.verdict = "PASS";
} catch (error) {
  receipt.reason = setupError(error);
  if (spike === "s0" && /^CDP_|^SCREENSHOT_BLANK$/.test(receipt.reason)) {
    receipt.detail = receipt.reason;
    receipt.reason = "NO_BACKGROUND_SESSION";
  }
  receipt.verdict = incomplete.has(receipt.reason) ? "INCOMPLETE" : "FAIL";
  process.exitCode = receipt.verdict === "FAIL" ? 1 : 2;
}
console.log(JSON.stringify(receipt));
