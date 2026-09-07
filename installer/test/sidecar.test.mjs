/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * The installer must actually START the browser door, not merely look for one.
 *
 * `door-port.test.mjs` proves the proxy is aimed at 8813 rather than at the
 * harness. That was only half of it. Nothing in this installer had ever
 * started the companion sidecar, so on a fresh cloud box the probe at
 * `http://127.0.0.1:8813/enter` always failed, serve was always declined, and
 * `murage setup` ended by telling the operator to start a process it gave them
 * no way to start. The box finished "secured" with no way in.
 *
 * So, in order:
 *
 *   (a) the sidecar is found the same three ways Electron finds it;
 *   (b) the environment it is handed is the headless one — a `loopback`
 *       browser door, because `tailscale serve` dials 127.0.0.1 and a door
 *       that bound the tailnet address instead answers serve with nothing,
 *       and a device door that is `off` outright, because that one defaults
 *       to 0.0.0.0 for a phone on the LAN and a rented box has neither;
 *   (c) `murage setup` brings the door UP and only then configures serve, and
 *       leaves no sidecar behind when it exits;
 *   (d) `murage start` runs the door alongside the harness;
 *   (e) `murage status` reports whether the door is there at all.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import {
  companionEnv,
  resolveCompanionEntry,
  spawnCompanion,
  startupProbe,
  waitForDoor,
} from "../lib/companion.mjs";
import { readEnvFile } from "../lib/env-file.mjs";
import { serveOrigin } from "../lib/tailscale.mjs";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "murage.mjs");
/** The checkout, so the cross-lane guard can read the sidecar's own parser. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratchDirs = [];
const scratch = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "murage-sidecar-test-")));
  scratchDirs.push(dir);
  return dir;
};
after(() => { for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true }); });
const SECRET = "tskey-auth-kRDeadBeef-NEVERPUTMEINARGV";
const LOOPBACK_ONLY_SERVER = `server.listen(PORT, "127.0.0.1", () => {});`;

const RUNNING = JSON.stringify({
  BackendState: "Running",
  Self: {
    Online: true,
    TailscaleIPs: ["100.81.158.63"],
    DNSName: "box.tail0a48a4.ts.net.",
    Tags: ["tag:murage"],
  },
});

/** A port nothing is listening on right now. */
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

/**
 * A stand-in for the companion sidecar: opens `MURAGE_BROWSER_PORT`, answers
 * `GET /enter`, and writes the environment it was handed to a file so the
 * fork's env can be asserted from the outside.
 */
function fakeSidecar(dir, { envDump }) {
  const path = join(dir, "fake-companion.js");
  writeFileSync(
    path,
    [
      'import { createServer } from "node:http";',
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(envDump)}, JSON.stringify(process.env));`,
      'const port = Number(process.env.MURAGE_BROWSER_PORT);',
      'const server = createServer((req, res) => {',
      '  if ((req.url ?? "").split("?")[0] === "/enter") { res.writeHead(200); res.end("enter"); return; }',
      '  res.writeHead(404); res.end();',
      '});',
      'server.listen(port, "127.0.0.1");',
      'setInterval(() => {}, 1 << 30);',
    ].join("\n")
  );
  return path;
}

/**
 * A stub `tailscale` that logs its argv and answers the two JSON reads.
 *
 * `serve status` reports NOTHING until a `serve --bg` has actually been run,
 * which is the behaviour that matters here: a stub that reported a configured
 * proxy from the first call would let setup take its idempotent early exit and
 * every assertion below would pass without the door ever being started.
 */
function tailscaleStub(dir, { logFile, proxyTarget }) {
  const path = join(dir, "tailscale-stub");
  const web = proxyTarget
    ? `{"Web":{"box.tail0a48a4.ts.net:443":{"Handlers":{"/":{"Proxy":"${proxyTarget}"}}}}}`
    : "{}";
  const served = join(dir, "serve-configured");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `echo "$@" >> ${JSON.stringify(logFile)}`,
      'if [ "$1" = "serve" ] && [ "$2" = "status" ]; then',
      `  if [ -f ${JSON.stringify(served)} ]; then echo '${web}'; else echo '{}'; fi`,
      "  exit 0",
      "fi",
      'if [ "$1" = "serve" ] && [ "$2" = "--bg" ]; then',
      `  : > ${JSON.stringify(served)}`,
      "  exit 0",
      "fi",
      'if [ "$1" = "status" ]; then',
      `  echo '${RUNNING}'`,
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 }
  );
  return path;
}

/** Pre-arm the stub as though `serve` had already been configured. */
function alreadyServing(dir) {
  writeFileSync(join(dir, "serve-configured"), "");
}

/** Run the CLI asynchronously with stdin ignored, so prompts take defaults. */
function runCli(args, env, { killAfterMs = 0 } = {}) {
  return new Promise((res, rej) => {
    // An isolated install has no source/build fallback into the developer's
    // real companion. Missing-sidecar coverage must really mean missing.
    const installed = join(dirname(env.MURAGE_DATA_DIR), "installer");
    mkdirSync(join(installed, "bin"), { recursive: true });
    cpSync(join(dirname(dirname(CLI)), "lib"), join(installed, "lib"), { recursive: true });
    cpSync(CLI, join(installed, "bin", "murage.mjs"));
    const child = spawn(process.execPath, [join(installed, "bin", "murage.mjs"), ...args], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...env, NO_COLOR: "1" },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    let done = false;
    const killOwned = () => {
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {}
    };
    const finish = (error, code) => {
      if (done) return;
      done = true;
      clearTimeout(hard);
      if (soft) clearTimeout(soft);
      killOwned();
      child.stdout.destroy(); child.stderr.destroy();
      if (error) rej(error); else res({ status: code ?? 0, out });
    };
    // A dead launcher can leave a descendant holding stdout open. Kill only
    // this fixture's group and settle explicitly; never wait forever on close.
    const hard = setTimeout(() => finish(new Error(`CLI exceeded its 30s fixture budget:\n${out}`)), 30_000);
    const soft = killAfterMs ? setTimeout(() => child.kill("SIGTERM"), killAfterMs) : null;
    child.on("error", error => finish(error));
    child.on("close", code => finish(null, code));
  });
}

function baseEnv(home, extra = {}) {
  const entry = join(home, "index.js");
  writeFileSync(entry, LOOPBACK_ONLY_SERVER);
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    MURAGE_SERVER_ENTRY: entry,
    MURAGE_DATA_DIR: join(home, ".murage-server"),
    MURAGE_ENV_FILE: join(home, ".murage-server", "murage.env"),
    MURAGE_TS_AUTHKEY: SECRET,
    TS_AUTHKEY: "",
    TAILSCALE_AUTHKEY: "",
    ...extra,
  };
}

// ── (a) finding the sidecar ───────────────────────────────────────────────

test("the sidecar is found packaged first, then built, then from source", () => {
  const all = () => true;
  const packaged = resolveCompanionEntry("/i", "/r", all, {});
  assert.equal(packaged.entry, join("/i", "payload", "companion", "index.js"));
  assert.deepEqual(packaged.execArgv, []);

  const built = resolveCompanionEntry("/i", "/r", (p) => !p.includes("payload"), {});
  assert.equal(built.entry, join("/r", "dist-companion", "index.js"));
  assert.deepEqual(built.execArgv, []);

  const source = resolveCompanionEntry("/i", "/r", (p) => p.endsWith(".ts"), {});
  assert.equal(source.entry, join("/r", "companion", "src", "index.ts"));
  assert.deepEqual(
    source.execArgv,
    ["--experimental-strip-types"],
    "the TypeScript entry without the flag is a SyntaxError at spawn"
  );

  assert.equal(resolveCompanionEntry("/i", "/r", () => false, {}), null);
});

test("MURAGE_COMPANION_ENTRY wins, and carries the flag when it is TypeScript", () => {
  const js = resolveCompanionEntry("/i", "/r", () => true, { MURAGE_COMPANION_ENTRY: "/x/c.js" });
  assert.equal(js.entry, "/x/c.js");
  assert.deepEqual(js.execArgv, []);
  const ts = resolveCompanionEntry("/i", "/r", () => true, { MURAGE_COMPANION_ENTRY: "/x/c.ts" });
  assert.deepEqual(ts.execArgv, ["--experimental-strip-types"]);
  // An override that does not exist falls through rather than being spawned.
  const gone = resolveCompanionEntry("/i", "/r", (p) => !p.startsWith("/x"), {
    MURAGE_COMPANION_ENTRY: "/x/c.js",
  });
  assert.equal(gone.entry, join("/i", "payload", "companion", "index.js"));
});

// ── (b) the environment it is handed ──────────────────────────────────────

test("the door is forced onto loopback, whatever the operator's environment says", () => {
  const env = companionEnv({
    base: { MURAGE_BROWSER_BIND: "tailnet", PATH: "/usr/bin" },
    harnessPort: 8799,
    doorPort: 8813,
    dataDir: "/data",
  });
  assert.equal(
    env.MURAGE_BROWSER_BIND,
    "loopback",
    "`tailscale serve` dials 127.0.0.1; a tailnet-bound door answers it with nothing"
  );
  assert.equal(env.PATH, "/usr/bin", "the rest of the environment still travels");
});

test("the DEVICE door is switched off, whatever the operator's environment says", () => {
  // `lan` inherited from a desktop-shaped environment is the exact value that
  // must not survive: it is `0.0.0.0`, which on a rented box is the public
  // internet minus a security-group rule.
  const env = companionEnv({
    base: { MURAGE_COMPANION_BIND: "lan", PATH: "/usr/bin" },
    harnessPort: 8799,
    doorPort: 8813,
    dataDir: "/data",
  });
  assert.equal(
    env.MURAGE_COMPANION_BIND,
    "off",
    "a headless box has no LAN to pair a phone over, and absent beats bound-but-local"
  );
  assert.notEqual(env.MURAGE_COMPANION_BIND, "lan", "an inherited `lan` must not survive into the fork");

  // And with nothing inherited at all — the sidecar's own default is `lan`, so
  // leaving the name unset would be the same exposure by omission.
  const bare = companionEnv({ base: {}, harnessPort: 8799, doorPort: 8813, dataDir: "/d" });
  assert.equal(bare.MURAGE_COMPANION_BIND, "off", "unset means `lan` inside the sidecar; it must be stated");
});

test("the bind value the installer sets is one the sidecar actually accepts", () => {
  // The cross-lane drift guard. `companion/src/index.ts` REFUSES TO START on a
  // value that is not one of its four, deliberately, so a rename or a typo on
  // this side is not a warning — it is a box that will not boot. Read the
  // parser's own accepted spellings rather than trusting a comment.
  const parser = readFileSync(join(REPO_ROOT, "companion", "src", "index.ts"), "utf8");
  const accepted = new Set(
    [...parser.matchAll(/COMPANION_BIND_RAW\s*===\s*"([a-z]+)"/g)].map((m) => m[1])
  );
  accepted.add("lan"); // the empty-string default, spelled in the same ladder
  assert.ok(accepted.size >= 4, `the parser scan found only ${[...accepted]} — it is not reading the ladder`);

  const value = companionEnv({ base: {}, harnessPort: 8799, doorPort: 8813, dataDir: "/d" }).MURAGE_COMPANION_BIND;
  assert.ok(
    accepted.has(value),
    `the installer sets MURAGE_COMPANION_BIND=${JSON.stringify(value)}, which companion/src/index.ts does not ` +
      `accept (${[...accepted].join(", ")}) — the sidecar would refuse to start`
  );
  assert.equal(value, "off", "and of the four, `off` is the one that binds no device socket at all");
});

test("the harness port and the door port are both stated, and they differ", () => {
  const env = companionEnv({ base: {}, harnessPort: 8799, doorPort: 8813, dataDir: "/data" });
  assert.equal(env.MURAGE_PORT, "8799");
  assert.equal(env.MURAGE_BROWSER_PORT, "8813");
  assert.notEqual(env.MURAGE_PORT, env.MURAGE_BROWSER_PORT);
});

test("the Electron-only names are stripped rather than passed on", () => {
  const env = companionEnv({
    base: {
      MURAGE_COMPANION_INTERNAL_ORIGIN: "/run/murage-companion-origin-1-x/origin.sock",
      MURAGE_COMPANION_HOSTED_URL: "https://someone-elses-route.example",
    },
    harnessPort: 8799,
    doorPort: 8813,
    dataDir: "/data",
  });
  assert.equal(env.MURAGE_COMPANION_INTERNAL_ORIGIN, undefined, "there is no Electron here to own that socket");
  assert.equal(env.MURAGE_COMPANION_HOSTED_URL, undefined, "nothing here has verified a hosted route");
});

test("the scheme follows the VERIFIED front, and is http when there is none", () => {
  const none = companionEnv({ base: {}, harnessPort: 8799, doorPort: 8813, dataDir: "/d" });
  assert.equal(none.MURAGE_BROWSER_SCHEME, "http");
  assert.equal(none.MURAGE_BROWSER_PUBLIC_ORIGIN, "");

  const https = companionEnv({
    base: { MURAGE_BROWSER_PUBLIC_ORIGIN: "https://stale.example" },
    harnessPort: 8799,
    doorPort: 8813,
    dataDir: "/d",
    publicOrigin: "https://box.tail0a48a4.ts.net",
  });
  assert.equal(https.MURAGE_BROWSER_SCHEME, "https");
  assert.equal(https.MURAGE_BROWSER_PUBLIC_ORIGIN, "https://box.tail0a48a4.ts.net");

  // A stale inherited origin must not survive into a run with no proxy: it
  // would tell the door to advertise an address that stopped answering.
  const cleared = companionEnv({
    base: { MURAGE_BROWSER_PUBLIC_ORIGIN: "https://stale.example" },
    harnessPort: 8799,
    doorPort: 8813,
    dataDir: "/d",
  });
  assert.equal(cleared.MURAGE_BROWSER_PUBLIC_ORIGIN, "");
});

test("the sidecar's data dir is inside the data dir the systemd unit grants", () => {
  const env = companionEnv({ base: {}, harnessPort: 8799, doorPort: 8813, dataDir: "/srv/murage" });
  assert.equal(
    env.MURAGE_COMPANION_DIR,
    join("/srv/murage", "companion"),
    "the default is ~/.murage-companion, which ProtectHome=read-only makes unwritable"
  );
});

// ── the origin is read back, never composed ───────────────────────────────

test("serveOrigin answers only for a :443 listener that fronts this door", () => {
  const doc = {
    Web: { "box.tail0a48a4.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8813" } } } },
  };
  assert.equal(serveOrigin(doc, 8813), "https://box.tail0a48a4.ts.net");
  assert.equal(serveOrigin(doc, 8799), null, "a proxy to the harness is not this door's front");
  assert.equal(serveOrigin({ Web: {} }, 8813), null);
  assert.equal(serveOrigin(null, 8813), null);
  // A plain-HTTP listener is not claimed as https, because the scheme decides
  // whether the session cookie may carry `Secure`.
  const plain = { Web: { "box.tail0a48a4.ts.net:80": { Handlers: { "/": { Proxy: "http://127.0.0.1:8813" } } } } };
  assert.equal(serveOrigin(plain, 8813), null);
});

// ── waiting for the door ──────────────────────────────────────────────────

test("waitForDoor gives up the moment the sidecar has exited", async () => {
  let probes = 0;
  const r = await waitForDoor({
    probe: async () => {
      probes += 1;
      return { answered: false, reason: "connection refused" };
    },
    alive: () => false,
    attempts: 40,
    wait: async () => {},
  });
  assert.equal(r.up, false);
  assert.match(r.reason, /exited before its door came up/);
  assert.equal(probes, 0, "a dead child is not worth probing forty times");
});

test("waitForDoor returns as soon as the door answers", async () => {
  let n = 0;
  const r = await waitForDoor({
    probe: async () => ({ answered: ++n === 3, reason: "not yet" }),
    attempts: 10,
    wait: async () => {},
  });
  assert.deepEqual(r, { up: true });
  assert.equal(n, 3);
});

test("spawnCompanion's stop() resolves only once the process is actually gone", async () => {
  const home = scratch();
  const entry = join(home, "sleeper.js");
  writeFileSync(entry, "setInterval(() => {}, 1 << 30);");
  const sidecar = spawnCompanion({ resolved: { entry, execArgv: [] }, env: process.env, stdio: "ignore" });
  assert.equal(sidecar.alive(), true);
  await sidecar.stop();
  assert.equal(sidecar.alive(), false, "stop() must not return while the port is still held");
  await sidecar.stop(); // safe twice
});

test("spawnCompanion contains executable spawn errors and stop still resolves", async () => {
  const home = scratch();
  const sidecar = spawnCompanion({
    resolved: { entry: "unused", execArgv: [] }, env: {}, stdio: "ignore",
    spawnImpl: (_command, args, opts) => spawn(join(home,"missing-executable"),args,opts),
  });
  const error = await new Promise(resolve => sidecar.child.once("error",resolve));
  assert.equal(error.code,"ENOENT");
  assert.equal(sidecar.alive(),false);
  await sidecar.stop();
});

test("startupProbe is bounded and waits for its exact process to be gone", async () => {
  const home = scratch();
  const marker = join(home,"probe.pid");
  const source = `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
  const result = await startupProbe(process.execPath,["-e",source],{timeoutMs:500});
  assert.equal(result,null);
  assert.equal(existsSync(marker),true,"probe did not actually reach its stubborn-child stage");
  assert.throws(()=>process.kill(Number(readFileSync(marker,"utf8")),0),{code:"ESRCH"});
});

test("startupProbe does not spawn when startup is already cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(await startupProbe("must-not-execute",[],{signal:controller.signal}),null);
});

// ── (c) setup starts the door, then fronts it, then cleans up ─────────────

test("`murage setup` STARTS the sidecar and only then points serve at the door", async () => {
  const home = scratch();
  const door = await freePort();
  const log = join(home, "argv.log");
  const envDump = join(home, "child-env.json");
  const stub = tailscaleStub(home, { logFile: log, proxyTarget: `http://127.0.0.1:${door}` });
  const env = baseEnv(home, {
    MURAGE_TAILSCALE_BIN: stub,
    MURAGE_BROWSER_PORT: String(door),
    MURAGE_COMPANION_ENTRY: fakeSidecar(home, { envDump }),
  });

  const { status, out } = await runCli(["setup"], env);
  assert.equal(status, 0, out);

  // It said so, and it did it.
  assert.match(out, /Starting the companion sidecar/);
  assert.match(out, new RegExp(`browser door answered on 127\\.0\\.0\\.1:${door}`));

  const child = JSON.parse(readFileSync(envDump, "utf8"));
  assert.equal(child.MURAGE_BROWSER_PORT, String(door));
  assert.equal(child.MURAGE_BROWSER_BIND, "loopback");
  assert.equal(
    child.MURAGE_COMPANION_BIND,
    "off",
    "the REAL fork environment must carry the closed device door, not just the unit test's"
  );
  assert.equal(child.MURAGE_PORT, "8799", "the sidecar proxies to the harness, which has not moved");

  // ...and serve was configured, at the door, never at the harness.
  const serveLine = readFileSync(log, "utf8").split("\n").find((l) => l.startsWith("serve --bg"));
  assert.ok(serveLine, `no proxy was configured:\n${out}`);
  assert.ok(serveLine.includes(`http://127.0.0.1:${door}`), `wrong proxy target: ${serveLine}`);
  assert.ok(!serveLine.includes("8799"), `the proxy must never front the harness: ${serveLine}`);

  const envFile = readEnvFile(join(home, ".murage-server", "murage.env"));
  assert.equal(envFile.MURAGE_TRUSTED_PROXY, "1");
  assert.equal(envFile.MURAGE_PORT, "8799");
});

test("`murage setup` leaves no sidecar behind holding the door port", async () => {
  const home = scratch();
  const door = await freePort();
  const stub = tailscaleStub(home, { logFile: join(home, "argv.log"), proxyTarget: `http://127.0.0.1:${door}` });
  const env = baseEnv(home, {
    MURAGE_TAILSCALE_BIN: stub,
    MURAGE_BROWSER_PORT: String(door),
    MURAGE_COMPANION_ENTRY: fakeSidecar(home, { envDump: join(home, "e.json") }),
  });
  const { status, out } = await runCli(["setup"], env);
  assert.equal(status, 0, out);
  assert.match(out, /stopped the setup-time sidecar/);

  // The proof is the port, not the sentence: bind it. An orphan still holding
  // it would make `murage start` fail later for a reason nobody could see.
  const probe = createServer();
  await new Promise((res, rej) => {
    probe.once("error", rej);
    probe.listen(door, "127.0.0.1", res);
  });
  await new Promise((r) => probe.close(r));
});

test("`murage setup` says the device door is closed, and does not send anyone to a firewall", async () => {
  // This test replaces one that asserted the opposite. It used to be true that
  // the installer could only NAME the 0.0.0.0:8810 listener and print a
  // `ufw deny`, because nothing out here could switch it off. `MURAGE_COMPANION_BIND`
  // changed that, and stale security copy is worse than none: an operator who
  // reads "we opened a public port, go firewall it" will either firewall a port
  // nothing binds, or — far worse — conclude the deployment does have public
  // ingress and start reasoning from that.
  const home = scratch();
  const door = await freePort();
  const envDump = join(home, "e.json");
  const stub = tailscaleStub(home, { logFile: join(home, "argv.log"), proxyTarget: `http://127.0.0.1:${door}` });
  const env = baseEnv(home, {
    MURAGE_TAILSCALE_BIN: stub,
    MURAGE_BROWSER_PORT: String(door),
    MURAGE_COMPANION_ENTRY: fakeSidecar(home, { envDump }),
  });
  const { out } = await runCli(["setup"], env);

  // It states the posture, and states it by the name of the control.
  assert.match(out, /MURAGE_COMPANION_BIND=off/, "the operator is told which control closed the door");
  assert.match(out, /not opened/, "and told plainly that nothing is listening there");

  // It does not carry the old, now-false advice.
  assert.doesNotMatch(out, /ufw/i, "there is no port to firewall; telling anyone to is stale advice");
  assert.doesNotMatch(
    out,
    /0\.0\.0\.0:8810/,
    "nothing binds 0.0.0.0:8810 on this deployment, so setup must not claim it does"
  );

  // And the claim is backed by the fork, not only by the sentence.
  const child = JSON.parse(readFileSync(envDump, "utf8"));
  assert.equal(child.MURAGE_COMPANION_BIND, "off", "the printed claim must match the environment actually handed over");
});

// ── (d) start runs both ───────────────────────────────────────────────────

test("`murage start` runs the browser door alongside the harness", async () => {
  const home = scratch();
  const door = await freePort();
  const envDump = join(home, "child-env.json");
  const stub = tailscaleStub(home, { logFile: join(home, "argv.log"), proxyTarget: `http://127.0.0.1:${door}` });
  alreadyServing(home); // this box has been through `murage setup` already
  const env = baseEnv(home, {
    MURAGE_TAILSCALE_BIN: stub,
    MURAGE_BROWSER_PORT: String(door),
    MURAGE_COMPANION_ENTRY: fakeSidecar(home, { envDump }),
  });
  // The fake harness entry exits immediately, which would take the sidecar
  // down with it before it could write its env; give it a listener instead.
  writeFileSync(env.MURAGE_SERVER_ENTRY, "setInterval(() => {}, 1 << 30);");

  const { out } = await runCli(["start"], env, { killAfterMs: 3_000 });
  assert.match(out, /companion sidecar/, out);

  const child = JSON.parse(readFileSync(envDump, "utf8"));
  assert.equal(child.MURAGE_BROWSER_PORT, String(door));
  assert.equal(child.MURAGE_BROWSER_BIND, "loopback");
  assert.equal(
    child.MURAGE_BROWSER_PUBLIC_ORIGIN,
    "https://box.tail0a48a4.ts.net",
    "the daemon reports a :443 proxy at this door, so the door may advertise it"
  );
  assert.equal(child.MURAGE_BROWSER_SCHEME, "https");
  // The long-running sidecar, so this is the fork whose device door matters
  // most: `setup` runs for seconds, this one runs until the box is rebooted.
  assert.equal(
    child.MURAGE_COMPANION_BIND,
    "off",
    "the sidecar that runs for real must not open the device door either"
  );
  assert.match(
    out,
    /device door\s+not opened \(MURAGE_COMPANION_BIND=off\)/,
    "`murage start` must state the device door posture too — a box is restarted far more often " +
      `than it is set up, and setup's copy scrolls away years earlier. Got:\n${out}`
  );
});

test("`murage start` runs the harness anyway when the sidecar is missing, and says so", async () => {
  const home = scratch();
  const stub = tailscaleStub(home, { logFile: join(home, "argv.log"), proxyTarget: null });
  const env = baseEnv(home, {
    MURAGE_TAILSCALE_BIN: stub,
    MURAGE_COMPANION_ENTRY: join(home, "nothing-here.js"),
    // Point the ladder's last rung at a directory with no companion in it.
    MURAGE_BROWSER_PORT: String(await freePort()),
  });
  writeFileSync(env.MURAGE_SERVER_ENTRY, "setInterval(() => {}, 1 << 30);");
  const { out } = await runCli(["start"], env, { killAfterMs: 2_500 });
  assert.match(out, /companion sidecar is not in this install — starting the harness alone/, out);
});

test("`murage start` takes the harness down when the sidecar dies", async () => {
  const home = scratch();
  const door = await freePort();
  const stub = tailscaleStub(home, { logFile: join(home, "argv.log"), proxyTarget: null });
  // A sidecar that opens the door, proves it, and then exits — the silent
  // failure this whole change exists to remove, re-created on purpose.
  const dying = join(home, "dying-companion.js");
  writeFileSync(dying, 'setTimeout(() => process.exit(7), 400);');
  const env = baseEnv(home, {
    MURAGE_TAILSCALE_BIN: stub,
    MURAGE_BROWSER_PORT: String(door),
    MURAGE_COMPANION_ENTRY: dying,
  });
  writeFileSync(env.MURAGE_SERVER_ENTRY, "setInterval(() => {}, 1 << 30);");

  const { status, out } = await runCli(["start"], env, { killAfterMs: 20_000 });
  assert.match(out, /companion sidecar exited \(code 7\)/, out);
  assert.equal(status, 1, "a harness left running behind a 502 is not a success");
});

// ── (e) status tells the truth about the door ─────────────────────────────

test("`murage status` reports the door as NOT answering when nothing is there", async () => {
  const home = scratch();
  const stub = tailscaleStub(home, { logFile: join(home, "argv.log"), proxyTarget: null });
  const env = baseEnv(home, { MURAGE_TAILSCALE_BIN: stub, MURAGE_BROWSER_PORT: String(await freePort()) });
  const { out } = await runCli(["status"], env);
  assert.match(out, /browser door NOT answering/);
});

test("`murage status` reports the door as answering when the sidecar is up", async () => {
  const home = scratch();
  const door = await freePort();
  const stub = tailscaleStub(home, { logFile: join(home, "argv.log"), proxyTarget: `http://127.0.0.1:${door}` });
  const entry = fakeSidecar(home, { envDump: join(home, "e.json") });
  const env = baseEnv(home, { MURAGE_TAILSCALE_BIN: stub, MURAGE_BROWSER_PORT: String(door), MURAGE_COMPANION_ENTRY: entry });
  const sidecar = spawnCompanion({
    resolved: { entry, execArgv: [] },
    env: companionEnv({ base: env, harnessPort: 8799, doorPort: door, dataDir: join(home, "d") }),
    stdio: "ignore",
  });
  try {
    const waited = await waitForDoor({
      probe: async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${door}/enter`, { signal: AbortSignal.timeout(500) });
          return { answered: true, status: res.status };
        } catch (e) {
          return { answered: false, reason: String(e) };
        }
      },
      alive: sidecar.alive,
    });
    assert.equal(waited.up, true, waited.reason);
    const { out } = await runCli(["status"], env);
    assert.match(out, new RegExp(`browser door answering on 127\\.0\\.0\\.1:${door}`));
    assert.match(out, /companion sidecar present/);
  } finally {
    await sidecar.stop();
  }
});
