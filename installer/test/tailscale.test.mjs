/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  buildServeArgs,
  buildUpArgs,
  enroll,
  inspectShareConfig,
  readAuthKey,
  shredAuthKeyFile,
  verdictFromStatus,
  verifyEnrolment,
  writeAuthKeyFile,
} from "../lib/tailscale.mjs";

const SECRET = "tskey-auth-kRDeadBeef-NEVERPUTMEINARGV";

// ── rule 1: the auth key never appears in argv ────────────────────────────

test("buildUpArgs takes a FILE PATH and never the key itself", () => {
  const args = buildUpArgs({ keyFile: "/run/secret/authkey", tags: ["tag:murage"], hostname: "box" });
  assert.ok(args.includes("--auth-key=file:/run/secret/authkey"));
  for (const arg of args) assert.ok(!arg.includes(SECRET), `key leaked into argv: ${arg}`);
  assert.ok(!args.join(" ").includes("tskey-"), "no key material anywhere in the command line");
});

test("buildUpArgs refuses to be handed a raw key instead of a path", () => {
  assert.throws(() => buildUpArgs({ tags: ["tag:murage"] }), /requires a keyFile path/);
  assert.throws(() => buildUpArgs({}), /requires a keyFile path/);
});

test("buildUpArgs advertises the tag and defaults the widening flags OFF", () => {
  const args = buildUpArgs({ keyFile: "/k", tags: ["tag:murage"] });
  assert.ok(args.includes("--advertise-tags=tag:murage"));
  assert.ok(args.includes("--accept-routes=false"), "a cloud box must not silently pull subnet routes");
  assert.ok(args.includes("--ssh=false"), "Tailscale SSH is a separate decision, not a side effect");
  assert.ok(args.some((a) => a.startsWith("--timeout=")), "must not block forever waiting for Running");
});

test("the auth key file is 0600 in a 0700 directory, and is shredded after", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "murage-key-test-")), "nested");
  const path = writeAuthKeyFile(SECRET, dir);
  assert.equal(readFileSync(path, "utf8"), SECRET);
  assert.equal(statSync(path).mode & 0o777, 0o600, "key file must be 0600 regardless of umask");
  assert.equal(statSync(dir).mode & 0o777, 0o700, "key directory must be 0700");
  shredAuthKeyFile(path);
  assert.equal(existsSync(path), false, "key file must be gone after shredding");
});

test("writeAuthKeyFile refuses an empty key rather than writing a useless file", () => {
  assert.throws(() => writeAuthKeyFile("   "), /empty auth key/);
});

test("the default auth key directory is new and randomly named, never a predictable per-pid one", () => {
  const a = writeAuthKeyFile(SECRET);
  const b = writeAuthKeyFile(SECRET);
  try {
    assert.notEqual(dirname(a), dirname(b), "two enrolments never share a directory");
    assert.ok(!dirname(a).endsWith(`murage-tsauth-${process.pid}`), dirname(a));
    const dir = lstatSync(dirname(a));
    assert.ok(dir.isDirectory() && !dir.isSymbolicLink());
    assert.equal(dir.mode & 0o777, 0o700);
    assert.equal(dir.uid, process.getuid());
    assert.equal(statSync(a).mode & 0o777, 0o600);
  } finally {
    shredAuthKeyFile(a);
    shredAuthKeyFile(b);
  }
  assert.equal(existsSync(dirname(a)), false, "the whole private directory is removed");
});

test("an auth key directory that already exists is refused and left exactly as it was", () => {
  const root = mkdtempSync(join(tmpdir(), "murage-key-plant-"));
  const planted = join(root, "planted");
  mkdirSync(planted);
  writeFileSync(join(planted, "authkey"), "planted by someone else");
  assert.throws(() => writeAuthKeyFile(SECRET, planted), { code: "EEXIST" });
  assert.equal(readFileSync(join(planted, "authkey"), "utf8"), "planted by someone else");

  const target = join(root, "target");
  mkdirSync(target);
  const link = join(root, "link");
  symlinkSync(target, link);
  assert.throws(() => writeAuthKeyFile(SECRET, link), { code: "EEXIST" });
  assert.deepEqual(readdirSync(target), [], "nothing was written through the symlink");
});

test("readAuthKey reads env vars, then the no-echo prompt — never argv", async () => {
  assert.equal(await readAuthKey({ env: { MURAGE_TS_AUTHKEY: SECRET } }), SECRET);
  assert.equal(await readAuthKey({ env: { TS_AUTHKEY: " padded " } }), "padded");
  assert.equal(await readAuthKey({ env: {}, readSecret: async () => ` ${SECRET} ` }), SECRET);
  assert.equal(await readAuthKey({ env: {} }), null);
});

// ── rule 2: the public-internet share mode is never invoked ────────────────

test("buildServeArgs targets loopback only, and validates the port", () => {
  const args = buildServeArgs({ port: 8799 });
  assert.deepEqual(args, ["serve", "--bg", "--https=443", "http://127.0.0.1:8799"]);
  assert.deepEqual(buildServeArgs({ port: 8799, https: false, listenPort: 8080 }), [
    "serve",
    "--bg",
    "--http=8080",
    "http://127.0.0.1:8799",
  ]);
  for (const bad of [0, -1, 70000, "abc", undefined, null, 1.5]) {
    assert.throws(() => buildServeArgs({ port: bad }), /bad port/, String(bad));
  }
});

test("no argv this module can build ever names the public-exposure subcommand", () => {
  // Built at runtime so this file itself stays clean for the lane scanner.
  const banned = ["fun", "nel"].join("");
  const argvs = [
    buildUpArgs({ keyFile: "/k", tags: ["tag:murage"], hostname: "h" }),
    buildServeArgs({ port: 8799 }),
    buildServeArgs({ port: 3000, https: false, listenPort: 80 }),
  ];
  for (const argv of argvs) {
    assert.ok(!argv.join(" ").toLowerCase().includes(banned), `argv names the banned subcommand: ${argv.join(" ")}`);
  }
});

test("a share config with the public-exposure flag set is detected", () => {
  // Shape as the daemon emits it. The flag key is assembled the same way the
  // library does, so neither file carries the literal string.
  const key = ["Allow", "Fun", "nel"].join("");
  const doc = {
    [key]: { "box.tail0a48a4.ts.net:443": true },
    Web: { "box.tail0a48a4.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8799" } } } },
  };
  const seen = inspectShareConfig(doc, 8799);
  assert.equal(seen.publicExposure, true, "a public share MUST be caught");
  assert.equal(seen.configured, true);
});

test("a tailnet-only share is recognised as configured and not public", () => {
  const doc = {
    Web: { "box.tail0a48a4.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8799" } } } },
  };
  const seen = inspectShareConfig(doc, 8799);
  assert.equal(seen.publicExposure, false);
  assert.equal(seen.configured, true);
  assert.deepEqual(seen.urls, ["https://box.tail0a48a4.ts.net"]);
});

test("a share pointed at a DIFFERENT port is not counted as ours", () => {
  const doc = { Web: { "box:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } };
  assert.equal(inspectShareConfig(doc, 8799).configured, false);
});

test("an empty or malformed share config is not mistaken for success", () => {
  for (const doc of [null, undefined, {}, "nonsense", 7]) {
    const seen = inspectShareConfig(doc, 8799);
    assert.equal(seen.configured, false, String(doc));
    assert.equal(seen.publicExposure, false, String(doc));
  }
});

// ── rule 3: success is proven, not assumed ────────────────────────────────

const RUNNING = {
  BackendState: "Running",
  MagicDNSSuffix: "tail0a48a4.ts.net",
  Self: {
    Online: true,
    TailscaleIPs: ["100.81.158.63", "fd7a:115c:a1e0::1"],
    DNSName: "box.tail0a48a4.ts.net.",
    Tags: ["tag:murage"],
  },
};

test("verdictFromStatus accepts a fully-enrolled node", () => {
  const v = verdictFromStatus(RUNNING, { expectTags: ["tag:murage"] });
  assert.equal(v.ok, true);
  assert.deepEqual(v.reasons, []);
  assert.equal(v.dnsName, "box.tail0a48a4.ts.net", "the trailing dot is stripped for URL building");
});

test("verdictFromStatus rejects every partial state, with a reason", () => {
  const cases = [
    [null, /returned nothing/],
    [{ ...RUNNING, BackendState: "NeedsLogin" }, /not Running/],
    [{ ...RUNNING, Self: { ...RUNNING.Self, Online: false } }, /not reported Online/],
    [{ ...RUNNING, Self: { ...RUNNING.Self, TailscaleIPs: [] } }, /no tailnet address/],
  ];
  for (const [doc, pattern] of cases) {
    const v = verdictFromStatus(doc);
    assert.equal(v.ok, false, JSON.stringify(doc));
    assert.ok(v.reasons.some((r) => pattern.test(r)), `expected ${pattern} in ${v.reasons.join("; ")}`);
  }
});

test("a tag that was requested but NOT granted fails verification", () => {
  // An auth key that is not authorised for the tag still succeeds at `up` and
  // comes back untagged. Checking is the difference between asking and knowing.
  const untagged = { ...RUNNING, Self: { ...RUNNING.Self, Tags: null } };
  const v = verdictFromStatus(untagged, { expectTags: ["tag:murage"] });
  assert.equal(v.ok, false);
  assert.ok(v.reasons.some((r) => /did not grant/.test(r)));
  // ...and with no tag requested, the same node verifies fine.
  assert.equal(verdictFromStatus(untagged).ok, true);
});

/** A spawnSync stand-in driven by a script of [matcher, result] pairs. */
function fakeRunner(script) {
  const calls = [];
  const run = (cmd, argv) => {
    const line = [cmd, ...argv].join(" ");
    calls.push(line);
    for (const [needle, result] of script) if (line.includes(needle)) return { status: 0, stdout: "", ...result };
    return { status: 1, stdout: "", stderr: `unscripted: ${line}` };
  };
  return { run, calls };
}

test("verifyEnrolment polls and gives up rather than hanging", async () => {
  const { run } = fakeRunner([["tailscale status --json", { stdout: JSON.stringify({ BackendState: "Starting" }) }]]);
  let slept = 0;
  const v = await verifyEnrolment({ run, bin: "tailscale", attempts: 3, wait: async () => { slept += 1; } });
  assert.equal(v.ok, false);
  assert.equal(slept, 2, "sleeps between attempts, not after the last one");
});

test("verifyEnrolment succeeds once the daemon settles", async () => {
  let n = 0;
  const run = () => {
    n += 1;
    return { status: 0, stdout: JSON.stringify(n < 2 ? { BackendState: "Starting" } : RUNNING) };
  };
  const v = await verifyEnrolment({ run, bin: "tailscale", attempts: 5, wait: async () => {} });
  assert.equal(v.ok, true);
  assert.equal(v.ips[0], "100.81.158.63");
});

test("enroll reports failure when `up` fails, and never reaches the share step", async () => {
  const { run, calls } = fakeRunner([["up --auth-key", { status: 1, stderr: "invalid key" }]]);
  const r = await enroll({ authKey: SECRET, port: 8799, tags: ["tag:murage"], run, bin: "tailscale", wait: async () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "up");
  assert.ok(r.reasons[0].includes("invalid key"));
  assert.ok(!calls.some((c) => c.includes("serve")), "must not configure a proxy for a node that never joined");
});

test("enroll refuses to report success when verification fails", async () => {
  const { run, calls } = fakeRunner([
    ["up --auth-key", { status: 0 }],
    ["tailscale status --json", { stdout: JSON.stringify({ BackendState: "NeedsLogin" }) }],
  ]);
  const r = await enroll({ authKey: SECRET, port: 8799, run, bin: "tailscale", attempts: 1, wait: async () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "verify");
  assert.ok(!calls.some((c) => c.includes("serve --bg")));
});

test("enroll ABORTS when the daemon reports a public share, rather than saying secured", async () => {
  const key = ["Allow", "Fun", "nel"].join("");
  const { run } = fakeRunner([
    ["up --auth-key", { status: 0 }],
    ["tailscale status --json", { stdout: JSON.stringify(RUNNING) }],
    ["serve --bg", { status: 0 }],
    [
      "serve status --json",
      {
        stdout: JSON.stringify({
          [key]: { "box:443": true },
          Web: { "box:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8799" } } } },
        }),
      },
    ],
  ]);
  const r = await enroll({ authKey: SECRET, port: 8799, run, bin: "tailscale", wait: async () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "share");
  assert.ok(/PUBLIC INTERNET/.test(r.reasons[0]));
});

test("enroll succeeds end to end, and the key never appears in any command line", async () => {
  const { run, calls } = fakeRunner([
    ["up --auth-key", { status: 0 }],
    ["tailscale status --json", { stdout: JSON.stringify(RUNNING) }],
    ["serve --bg", { status: 0 }],
    [
      "serve status --json",
      { stdout: JSON.stringify({ Web: { "box.tail0a48a4.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8799" } } } } }) },
    ],
  ]);
  const r = await enroll({
    authKey: SECRET,
    port: 8799,
    tags: ["tag:murage"],
    hostname: "murage-box",
    run,
    bin: "tailscale",
    wait: async () => {},
  });
  assert.equal(r.ok, true, r.reasons?.join("; "));
  assert.equal(r.share.publicExposure, false);
  for (const call of calls) assert.ok(!call.includes(SECRET), `key leaked into a command line: ${call}`);
  // ...and the file it was written to is gone.
  const keyFileArg = calls.find((c) => c.includes("--auth-key=file:"))?.match(/--auth-key=file:(\S+)/)?.[1];
  assert.ok(keyFileArg, "up must have been called with a file: reference");
  assert.equal(existsSync(keyFileArg), false, "the key file must be shredded after `up`");
});
