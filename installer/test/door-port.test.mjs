/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * The proxy must point at the DOOR, not at the harness.
 *
 * `tailscale serve` is a same-host reverse proxy that forwards the ORIGINAL
 * `Host` header — `<node>.<tailnet>.ts.net`. Murage's harness (8799) refuses
 * any request whose Host is not a loopback name (`server/index.ts`,
 * `isLoopbackHost`), so a proxy aimed at 8799 produces a tailnet URL that
 * answers 403 on a box the installer has just called "secured". The companion's
 * browser door (8813, `companion/src/browser.ts`) rewrites Host to loopback
 * before forwarding, so it is the only correct target. 8813 and NOT 8812: 8812
 * is the cloudflared origin gateway.
 *
 * Two things are therefore asserted here, and they pull in opposite directions:
 *
 *   - everything the proxy touches uses the DOOR port;
 *   - everything the SERVER touches still uses the harness port, 8799. The
 *     naive version of this fix moved `DEFAULT_PORT` and silently relocated the
 *     listener; `planStart` below is the guard against that coming back.
 *
 * And the gate: a proxy in front of a port nothing is listening on is worse
 * than no proxy, because it looks configured. So serve is only enabled once
 * `GET http://127.0.0.1:<door>/enter` actually answers.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { planStart } from "../bin/murage.mjs";
import {
  DOOR_CHALLENGE_HEADER,
  DOOR_NONCE_FILE,
  DOOR_PROOF_HEADER,
  DOOR_VERSION_HEADER,
  createDoorNonce,
  doorProof,
  probeDoor,
  readDoorNonce,
  writeDoorNonce,
} from "../lib/door-identity.mjs";
import { readEnvFile } from "../lib/env-file.mjs";
import { DEFAULT_DOOR_PORT, buildServeArgs, doorAnswers, doorPort, enroll } from "../lib/tailscale.mjs";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "murage.mjs");
const scratchDirs = [];
const scratch = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "murage-door-test-")));
  scratchDirs.push(dir);
  return dir;
};
after(() => { for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true }); });
const SECRET = "tskey-auth-kRDeadBeef-NEVERPUTMEINARGV";
const LOOPBACK_ONLY_SERVER = `server.listen(PORT, "127.0.0.1", () => {});`;

const RUNNING = {
  BackendState: "Running",
  Self: { Online: true, TailscaleIPs: ["100.81.158.63"], DNSName: "box.tail0a48a4.ts.net.", Tags: [] },
};

/** @param {[string, object][]} script */
function fakeRunner(script) {
  /** @type {string[]} */
  const calls = [];
  const run = (cmd, argv) => {
    const line = [cmd, ...argv].join(" ");
    calls.push(line);
    for (const [needle, reply] of script) if (line.includes(needle)) return { status: 0, stdout: "", ...reply };
    return { status: 0, stdout: "" };
  };
  return { run, calls };
}

/** A stub `tailscale` that logs its argv and answers the two JSON reads. */
function tailscaleStub(dir, { logFile, proxyTarget, firstStatusNeedsLogin = false }) {
  const path = join(dir, "tailscale-stub");
  const web = proxyTarget
    ? `{"Web":{"box.tail0a48a4.ts.net:443":{"Handlers":{"/":{"Proxy":"${proxyTarget}"}}}}}`
    : "{}";
  // The stub is driven through the real `murage setup`, which advertises the
  // default ACL tag — so the control plane it fakes has to have granted it.
  const running = JSON.stringify({ ...RUNNING, Self: { ...RUNNING.Self, Tags: ["tag:murage"] } });
  const counter = join(dir, "status-calls");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `echo "$@" >> ${JSON.stringify(logFile)}`,
      'if [ "$1" = "serve" ] && [ "$2" = "status" ]; then',
      `  echo '${web}'`,
      "  exit 0",
      "fi",
      'if [ "$1" = "status" ]; then',
      ...(firstStatusNeedsLogin
        ? [
            `  if [ ! -f ${JSON.stringify(counter)} ]; then`,
            `    : > ${JSON.stringify(counter)}`,
            `    echo '{"BackendState":"NeedsLogin"}'`,
            "    exit 0",
            "  fi",
          ]
        : []),
      `  echo '${running}'`,
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 }
  );
  return path;
}

/**
 * A stand-in for the companion's browser door: answers `GET /enter`.
 *
 * With `identity`, it also answers the identity challenge the way the real
 * door does (`companion/src/door-identity.ts`); without one it is any other
 * HTTP server that happens to hold the port. `status` plays a broken door.
 * `requests()` counts what reached it, so a test can show it was probed and
 * left running rather than stopped.
 */
async function fakeDoor({ identity = null, status = 200 } = {}) {
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    const challenge = req.headers[DOOR_CHALLENGE_HEADER];
    if (identity && typeof challenge === "string" && /^[a-f0-9]{64}$/.test(challenge)) {
      res.setHeader(DOOR_VERSION_HEADER, identity.version);
      res.setHeader(DOOR_PROOF_HEADER, doorProof(identity.nonce, challenge, identity.version));
    }
    if ((req.url ?? "").split("?")[0] === "/enter") {
      res.writeHead(status, { "content-type": "text/html" });
      res.end("<!doctype html><title>enter</title>");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, requests: () => requests, close: () => new Promise((r) => server.close(r)) };
}

/**
 * Run the CLI ASYNCHRONOUSLY. Not `execFileSync`: the fake door lives in this
 * process, and a synchronous child blocks the event loop, so the server never
 * accepts the probe and every test would "prove" the door was down.
 * @returns {Promise<{ status: number, out: string }>}
 */
function runCli(args, env) {
  return new Promise((res, rej) => {
    // Exercise this CLI as a standalone install. A missing fixture payload
    // must never fall through into the developer's actual companion source.
    const installed = join(dirname(env.MURAGE_DATA_DIR), "installer");
    mkdirSync(join(installed, "bin"), { recursive: true });
    cpSync(join(dirname(dirname(CLI)), "lib"), join(installed, "lib"), { recursive: true });
    cpSync(CLI, join(installed, "bin", "murage.mjs"));
    const child = spawn(process.execPath, [join(installed,"bin","murage.mjs"), ...args], {
      detached: process.platform !== "win32",
      // stdin IGNORED, so every prompt resolves to its default and nothing hangs.
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...env, NO_COLOR: "1" },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    let done = false;
    const finish = (error, code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Kill only this fixture's group, including descendants holding pipes
      // after a regressed launcher exits. Never wait indefinitely on close.
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid,"SIGKILL");
      } catch {}
      child.stdout.destroy(); child.stderr.destroy();
      if (error) rej(error); else res({ status: code ?? 0, out });
    };
    const timer = setTimeout(() => finish(new Error(`CLI exceeded its 30s fixture budget:\n${out}`)), 30_000);
    child.on("error", error => finish(error));
    child.on("close", code => finish(null, code));
  });
}

/**
 * Give the scratch install a manifest, the way a real one has one: `runCli`
 * puts the installer at `<home>/installer`, so `<home>` is its package root.
 * The door identity carries this version. Returns it.
 */
function installerManifest(home, version = "0.1.52-test") {
  writeFileSync(join(home, "package.json"), JSON.stringify({ name: "murage", version, engines: { node: ">=24" } }));
  return version;
}

/** Record a door identity the way `murage start` does, and return it. */
function recordStart(home) {
  const nonce = createDoorNonce();
  writeDoorNonce(join(home, ".murage-server"), nonce);
  return nonce;
}

function setupEnv(home, extra = {}) {
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
    MURAGE_BROWSER_PORT: "",
    MURAGE_COMPANION_ENTRY: join(home,"missing-companion.mjs"),
    ...extra,
  };
}

// ── (a) the proxy targets the door ────────────────────────────────────────

test("the door port is 8813 — not the harness, and not the cloudflared gateway", () => {
  assert.equal(DEFAULT_DOOR_PORT, 8813);
  assert.equal(doorPort({}), 8813);
  assert.notEqual(DEFAULT_DOOR_PORT, 8799, "8799 is the harness; serve through it is a 403");
  assert.notEqual(DEFAULT_DOOR_PORT, 8812, "8812 is the cloudflared origin gateway, a different thing");
  assert.deepEqual(buildServeArgs({ port: doorPort({}) }), [
    "serve",
    "--bg",
    "--https=443",
    "http://127.0.0.1:8813",
  ]);
});

test("enrolment points the proxy at the door port, never at the harness", async () => {
  const { run, calls } = fakeRunner([
    ["up --reset --auth-key", { status: 0 }],
    ["tailscale status --json", { stdout: JSON.stringify(RUNNING) }],
    ["serve --bg", { status: 0 }],
    [
      "serve status --json",
      { stdout: JSON.stringify({ Web: { "box:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8813" } } } } }) },
    ],
  ]);
  const r = await enroll({ authKey: SECRET, port: doorPort({}), run, bin: "tailscale", wait: async () => {} });
  assert.equal(r.ok, true, r.reasons?.join("; "));
  assert.equal(r.served, true);
  const serve = calls.find((c) => c.includes("serve --bg"));
  assert.ok(serve, "a proxy should have been configured");
  assert.ok(serve.includes("http://127.0.0.1:8813"), `proxy target is not the door: ${serve}`);
  assert.ok(!serve.includes("8799"), `the proxy must never front the harness: ${serve}`);
});

test("`murage setup` sends the proxy to the door, and `murage status` reads it back there", async () => {
  // The listener is the door the last `murage start` here recorded, so it can
  // answer the identity challenge. (It used to be any HTTP server; I7 below.)
  const home = scratch();
  const version = installerManifest(home);
  const nonce = recordStart(home);
  const door = await fakeDoor({ identity: { nonce, version } });
  const log = join(home, "argv.log");
  const stub = tailscaleStub(home, {
    logFile: log,
    proxyTarget: `http://127.0.0.1:${door.port}`,
    firstStatusNeedsLogin: true,
  });
  try {
    const env = setupEnv(home, { MURAGE_TAILSCALE_BIN: stub, MURAGE_BROWSER_PORT: String(door.port) });
    const { status, out } = await runCli(["setup"], env);
    assert.equal(status, 0, out);

    const argv = readFileSync(log, "utf8");
    const serveLine = argv.split("\n").find((l) => l.startsWith("serve --bg"));
    assert.ok(serveLine, `no proxy was configured:\n${argv}\n---\n${out}`);
    assert.ok(
      serveLine.includes(`http://127.0.0.1:${door.port}`),
      `the proxy fronts the wrong port: ${serveLine}`
    );
    assert.ok(!serveLine.includes("8799"), `the proxy must never front the harness: ${serveLine}`);
    assert.match(out, /browser door/);
    assert.match(out, /proved it is this deployment's door \(installer 0\.1\.52-test\)/);

    // The env file — the thing the SERVER reads — still says 8799.
    const envFile = readEnvFile(join(home, ".murage-server", "murage.env"));
    assert.equal(envFile.MURAGE_PORT, "8799", "the harness port must not move");
    assert.equal(envFile.MURAGE_TRUSTED_PROXY, "1", "a proxy was configured, so declare it");

    // ...and `status` asks about the door port, so a correct deployment reads
    // as configured rather than as "no proxy".
    const { out: statusOut } = await runCli(["status"], env);
    assert.match(statusOut, new RegExp(`proxy is fronting the browser door 127\\.0\\.0\\.1:${door.port}`));
    assert.match(statusOut, new RegExp(`browser door answering on 127\\.0\\.0\\.1:${door.port} \\(HTTP 200\\), and proved it is this deployment's door`));
  } finally {
    await door.close();
  }
});

test("`murage status` does NOT call a proxy aimed at the harness configured", async () => {
  // The regression this whole item exists for: a serve pointed at 8799 is
  // broken, and status must not report it as a working deployment.
  const home = scratch();
  const door = await fakeDoor();
  const port = door.port;
  await door.close();
  const stub = tailscaleStub(home, { logFile: join(home, "argv.log"), proxyTarget: "http://127.0.0.1:8799" });
  const { out } = await runCli(["status"], setupEnv(home, { MURAGE_TAILSCALE_BIN: stub, MURAGE_BROWSER_PORT: String(port) }));
  assert.match(out, new RegExp(`no tailnet proxy in front of the browser door 127\\.0\\.0\\.1:${port}`));
});

// ── (b) the harness port does not move ────────────────────────────────────

test("the harness port is still 8799, whatever the door port is", () => {
  const entry = join(scratch(), "index.js");
  writeFileSync(entry, LOOPBACK_ONLY_SERVER);
  // planStart is the call site that the naive `DEFAULT_PORT = 8813` fix broke.
  assert.equal(planStart({}, { entry, supportsBindAddress: false }).port, 8799);
  assert.equal(planStart({ MURAGE_BROWSER_PORT: "9999" }, { entry, supportsBindAddress: false }).port, 8799);
  // ...and an explicit MURAGE_PORT still wins for the harness.
  assert.equal(planStart({ MURAGE_PORT: "9100" }, { entry, supportsBindAddress: false }).port, 9100);
});

// ── (c) the env override ──────────────────────────────────────────────────

test("MURAGE_BROWSER_PORT overrides the door port, and nonsense falls back to 8813", () => {
  assert.equal(doorPort({ MURAGE_BROWSER_PORT: "9313" }), 9313);
  assert.deepEqual(buildServeArgs({ port: doorPort({ MURAGE_BROWSER_PORT: "9313" }) }), [
    "serve",
    "--bg",
    "--https=443",
    "http://127.0.0.1:9313",
  ]);
  for (const bad of ["", "  ", "nope", "0", "70000", "-1", "88.5"]) {
    assert.equal(doorPort({ MURAGE_BROWSER_PORT: bad }), 8813, `bad value ${JSON.stringify(bad)}`);
  }
  assert.equal(doorPort(undefined), doorPort(process.env));
});

// ── (d) the gate: no door, no proxy ───────────────────────────────────────

test("doorAnswers says yes to a live door and no to a dead port", async () => {
  const door = await fakeDoor();
  try {
    const live = await doorAnswers({ port: door.port, timeoutMs: 5_000 });
    assert.equal(live.answered, true, live.reason);
    assert.equal(live.status, 200);
    assert.equal(live.url, `http://127.0.0.1:${door.port}/enter`);
    await door.close();
    const dead = await doorAnswers({ port: door.port, timeoutMs: 2_000 });
    assert.equal(dead.answered, false, "a closed port is not a door");
    assert.ok(dead.reason);
  } finally {
    await door.close().catch(() => {});
  }
});

test("doorAnswers refuses a bad port instead of probing something else", async () => {
  const called = [];
  const fetchImpl = async (u) => {
    called.push(u);
    return { status: 200 };
  };
  const r = await doorAnswers({ port: 0, fetchImpl });
  assert.equal(r.answered, false);
  assert.deepEqual(called, []);
});

test("enroll skips the proxy entirely when the door is not answering", async () => {
  const { run, calls } = fakeRunner([
    ["up --reset --auth-key", { status: 0 }],
    ["tailscale status --json", { stdout: JSON.stringify(RUNNING) }],
  ]);
  const r = await enroll({
    authKey: SECRET,
    port: 8813,
    serve: false,
    run,
    bin: "tailscale",
    wait: async () => {},
  });
  // The node really did join — that part is proven, so say so.
  assert.equal(r.ok, true, r.reasons?.join("; "));
  assert.equal(r.served, false);
  assert.equal(r.stage, "joined");
  assert.ok(!calls.some((c) => c.includes("serve --bg")), `configured a proxy with no door:\n${calls.join("\n")}`);
});

test("`murage setup` may finish enrollment without a proxy when the sidecar is absent", async () => {
  const home = scratch();
  const log = join(home, "argv.log");
  const stub = tailscaleStub(home, { logFile: log, proxyTarget: null, firstStatusNeedsLogin: true });
  const door = await fakeDoor();
  const port = door.port;
  await door.close();
  const env = setupEnv(home, { MURAGE_TAILSCALE_BIN: stub, MURAGE_BROWSER_PORT: String(port) });
  const { status, out } = await runCli(["setup"], env);
  assert.equal(status, 0, out);
  assert.match(out, /browser door is not running/);
  assert.match(out, /sidecar is not in this install/);
  assert.match(out, new RegExp(`http://127\\.0\\.0\\.1:${port}/enter`));

  const argv = readFileSync(log, "utf8");
  assert.ok(
    !argv.split("\n").some((l) => l.startsWith("serve --bg")),
    `serve must not be configured with no door behind it:\n${argv}`
  );
  // No proxy exists, so nothing may claim one.
  const envFile = readEnvFile(join(home, ".murage-server", "murage.env"));
  assert.equal(envFile.MURAGE_TRUSTED_PROXY, undefined);
  assert.equal(envFile.MURAGE_PORT, "8799");
});

test("`murage setup` fails closed when its installed temporary sidecar crashes", async () => {
  const home = scratch();
  const log = join(home,"argv.log");
  const stub = tailscaleStub(home,{logFile:log,proxyTarget:null,firstStatusNeedsLogin:true});
  const door = await fakeDoor();
  const port = door.port;
  await door.close();
  const sidecar = join(home,"failed-sidecar.mjs");
  const marker = join(home,"failed-sidecar.pid");
  writeFileSync(sidecar, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},String(process.pid));process.exit(7);`);
  const {status,out} = await runCli(["setup"],setupEnv(home,{
    MURAGE_TAILSCALE_BIN:stub,MURAGE_BROWSER_PORT:String(port),MURAGE_COMPANION_ENTRY:sidecar,
  }));
  assert.equal(status,1,out);
  assert.match(out,/setup-time sidecar exited unexpectedly \(code 7\)/);
  assert.match(out,/Not configuring a tailnet proxy/);
  assert.ok(existsSync(marker),"the intended sidecar fixture never ran");
  assert.throws(()=>process.kill(Number(readFileSync(marker,"utf8")),0),{code:"ESRCH"});
  const commands = readFileSync(log,"utf8").trim().split("\n");
  assert.ok(!commands.some(line=>line.startsWith("serve --bg")),"configured a proxy after sidecar failure");
  assert.ok(!commands.some(line=>line.startsWith("up ")),"continued enrollment after sidecar failure");
  assert.equal(existsSync(join(home,".murage-server","murage.env")),false,"failed setup wrote a success configuration");
});

// ── (e) I7: answering is not being the door ──────────────────────────────

test("a recorded door identity is private, regular, owned and well formed, or it proves nothing", () => {
  const dataDir = join(scratch(), "data");
  const missing = readDoorNonce(dataDir);
  assert.equal(missing.nonce, null);
  assert.match(missing.error, /no `murage start` has recorded a door identity/);

  const nonce = createDoorNonce();
  assert.match(nonce, /^[a-f0-9]{64}$/);
  assert.notEqual(createDoorNonce(), nonce, "every start gets its own");
  const path = writeDoorNonce(dataDir, nonce);
  assert.equal(path, join(dataDir, DOOR_NONCE_FILE));
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readDoorNonce(dataDir), { nonce, error: null });
  assert.throws(() => writeDoorNonce(dataDir, "not-a-nonce"), /malformed/);
  assert.deepEqual(readDoorNonce(dataDir), { nonce, error: null }, "a refused write leaves the recorded identity alone");

  if (process.platform !== "win32") {
    assert.match(readDoorNonce(dataDir, { owner: process.geteuid() + 1 }).error, /does not belong to the account/);
    chmodSync(path, 0o640);
    assert.match(readDoorNonce(dataDir).error, /readable by other accounts/);
    chmodSync(path, 0o600);

    const elsewhere = join(scratch(), "real-identity");
    writeFileSync(elsewhere, `${nonce}\n`, { mode: 0o600 });
    const linked = join(scratch(), "data");
    mkdirSync(linked);
    symlinkSync(elsewhere, join(linked, DOOR_NONCE_FILE));
    assert.match(readDoorNonce(linked).error, /symlink/);
  }
  writeFileSync(path, "garbage\n");
  assert.match(readDoorNonce(dataDir).error, /does not hold a door identity/);
});

test("probeDoor matches only a proof under the recorded nonce from this installer version, and is ready only below 500", async () => {
  const nonce = createDoorNonce();
  const version = "0.1.52-test";
  const unproven = /did not answer the identity challenge/;
  const cases = [
    ["an unrelated server answering 200", { status: 200 }, "mismatch", false, unproven],
    ["an unrelated server answering 404", { status: 404 }, "mismatch", false, unproven],
    ["a crashed server answering 500", { status: 500 }, "mismatch", false, unproven],
    ["a door from an earlier start", { identity: { nonce: createDoorNonce(), version } }, "mismatch", false, /does not match/],
    ["a door from another installer version", { identity: { nonce, version: "0.1.51" } }, "mismatch", false, /installer 0\.1\.51, and this installer is 0\.1\.52-test/],
    ["this deployment's door, not ready", { identity: { nonce, version }, status: 503 }, "match", false, /HTTP 503/],
    ["this deployment's door", { identity: { nonce, version } }, "match", true, null],
  ];
  for (const [label, opts, identity, ready, reason] of cases) {
    const door = await fakeDoor(opts);
    try {
      const r = await probeDoor({ port: door.port, nonce, version, timeoutMs: 5_000 });
      assert.equal(r.answered, true, label);
      assert.equal(r.identity, identity, label);
      assert.equal(r.ready, ready, label);
      if (reason) assert.match(r.reason, reason, label);
      else assert.equal(r.reason, undefined, label);
      assert.equal(r.doorVersion, identity === "match" ? version : null, label);
    } finally {
      await door.close();
    }
  }

  // With no recorded identity, even the real door is unproven, and says why.
  const door = await fakeDoor({ identity: { nonce, version } });
  try {
    const r = await probeDoor({ port: door.port, nonce: null, nonceError: "no `murage start` has recorded a door identity in /x", version, timeoutMs: 5_000 });
    assert.equal(r.identity, "mismatch");
    assert.match(r.reason, /no `murage start` has recorded a door identity/);
  } finally {
    await door.close();
  }

  // Nothing listening is not a mismatch. It is nothing.
  const gone = await fakeDoor();
  const port = gone.port;
  await gone.close();
  const nothing = await probeDoor({ port, nonce, version, timeoutMs: 2_000 });
  assert.equal(nothing.answered, false);
  assert.equal(nothing.identity, "unknown");
});

test("`murage setup` neither adopts nor fronts a listener that cannot prove it is this deployment's door, and does not stop it (I7)", async () => {
  const notOurs = /something is already listening on 127\.0\.0\.1:\d+, and it is not this deployment's browser door: /;
  const cases = [
    ["an unrelated server answering 200", () => ({ status: 200 }), [notOurs, /did not answer the identity challenge/]],
    ["an unrelated server answering 404", () => ({ status: 404 }), [notOurs, /did not answer the identity challenge/]],
    ["a crashed server answering 500", () => ({ status: 500 }), [notOurs, /did not answer the identity challenge/]],
    ["a door from an earlier start", ({ version }) => ({ identity: { nonce: createDoorNonce(), version } }), [notOurs, /does not match the door `murage start` last started here/]],
    ["a door from another installer version", ({ nonce }) => ({ identity: { nonce, version: "0.1.51" } }), [notOurs, /started by installer 0\.1\.51/]],
    ["this deployment's door answering 503", ({ nonce, version }) => ({ identity: { nonce, version }, status: 503 }), [/this deployment's browser door answers on 127\.0\.0\.1:\d+ but is not ready \(it answered HTTP 503\)/]],
  ];
  for (const [label, doorOpts, expected] of cases) {
    const home = scratch();
    const version = installerManifest(home);
    const nonce = recordStart(home);
    const door = await fakeDoor(doorOpts({ nonce, version }));
    const log = join(home, "argv.log");
    const stub = tailscaleStub(home, { logFile: log, proxyTarget: null, firstStatusNeedsLogin: true });
    try {
      const env = setupEnv(home, { MURAGE_TAILSCALE_BIN: stub, MURAGE_BROWSER_PORT: String(door.port) });
      const { status, out } = await runCli(["setup"], env);
      assert.equal(status, 0, `${label}: the node still joined, so setup completes:\n${out}`);
      for (const pattern of expected) assert.match(out, pattern, label);
      assert.ok(door.requests() > 0, `${label}: setup never asked the listener`);
      assert.doesNotMatch(out, /Starting the companion sidecar|sidecar is not in this install/, `${label}: setup went on to start a sidecar of its own on an occupied port`);

      const argv = readFileSync(log, "utf8");
      assert.ok(!argv.split("\n").some((l) => l.startsWith("serve --bg")), `${label}: fronted a listener that is not the door:\n${argv}`);
      assert.equal(readEnvFile(join(home, ".murage-server", "murage.env")).MURAGE_TRUSTED_PROXY, undefined, `${label}: declared a proxy that was not configured`);

      // Not setup's to stop: it is still there, and the recorded identity is untouched.
      const still = await doorAnswers({ port: door.port, timeoutMs: 5_000 });
      assert.equal(still.answered, true, `${label}: the listener setup did not start is gone`);
      assert.deepEqual(readDoorNonce(join(home, ".murage-server")), { nonce, error: null }, `${label}: setup rewrote the recorded identity`);
    } finally {
      await door.close();
    }
  }
});

test("`murage status` reports a listener that fails the proof as not this deployment's door (I7)", async () => {
  const home = scratch();
  installerManifest(home);
  recordStart(home);
  const foreign = await fakeDoor();
  try {
    const stub = tailscaleStub(home, { logFile: join(home, "argv.log"), proxyTarget: null });
    const { out } = await runCli(["status"], setupEnv(home, { MURAGE_TAILSCALE_BIN: stub, MURAGE_BROWSER_PORT: String(foreign.port) }));
    assert.match(out, new RegExp(`something answers on 127\\.0\\.0\\.1:${foreign.port} \\(HTTP 200\\), but it is NOT this deployment's browser door: it did not answer the identity challenge`));
    assert.doesNotMatch(out, /browser door answering on/);
    assert.ok(foreign.requests() > 0);
  } finally {
    await foreign.close();
  }
});

// ── (d) status looks where setup put things ───────────────────────────────

test("`murage status --service-user` (or MURAGE_SERVICE_USER) reads the deployment setup made for that account", async () => {
  // Live on Ubuntu 24.04 (0.1.52 Linux proof): after `sudo murage setup
  // --service-user murage`, a `sudo murage status` looked in /root and said
  // "no env file" and "NOT this deployment's browser door" about a deployment
  // that was fine. `status` now resolves the account's paths the way `setup`
  // does. Root-for-another-account needs root, so this runs the same-account
  // case and pins the argument handling; `setupPaths` covers the mapping.
  if (process.platform !== "linux") return;
  const home = scratch();
  const me = userInfo().username;
  const stub = tailscaleStub(home, { logFile: join(home, "argv.log"), proxyTarget: "http://127.0.0.1:8813" });
  const env = setupEnv(home, { MURAGE_TAILSCALE_BIN: stub });
  mkdirSync(join(home, ".murage-server"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".murage-server", "murage.env"), "MURAGE_PORT=8799\n", { mode: 0o600 });

  const flag = await runCli(["status", "--service-user", me], env);
  assert.match(flag.out, new RegExp(`service account: ${me}:`), flag.out);
  assert.match(flag.out, new RegExp(`env file ${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.murage-server/murage\\.env is 0600`), flag.out);

  const fromEnv = await runCli(["status", "--non-interactive"], { ...env, MURAGE_SERVICE_USER: me });
  assert.match(fromEnv.out, new RegExp(`service account: ${me}:`), fromEnv.out);
  assert.match(fromEnv.out, /murage\.env is 0600/, fromEnv.out);

  const stray = await runCli(["status", "--bogus"], env);
  assert.equal(stray.status, 2, stray.out);
  assert.match(stray.out, /status does not take argument #1/, stray.out);

  const unknown = await runCli(["status", "--service-user", "no-such-account-0152"], env);
  assert.equal(unknown.status, 2, unknown.out);
});
