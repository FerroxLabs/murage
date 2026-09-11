/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  RUNTIME_FLOOR,
  SETUP_NOT_SECURED,
  installerVersion,
  planStart,
  resolveServerEntry,
  runtimePreflight,
  runtimeRequirement,
  serverSupportsBindAddress,
  serverSupportsResetPass,
} from "../bin/murage.mjs";
import { envFilePermissions, readEnvFile } from "../lib/env-file.mjs";
import { UNIT_PATH, stageUnit, unitText } from "../lib/systemd.mjs";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "murage.mjs");
// Real paths: a CLI copy under macOS's /var -> /private/var symlink would not
// recognise itself as the entry point, and would exit 0 having run nothing.
const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "murage-cli-test-")));

// A server build that hardcodes 127.0.0.1, which is what Murage 0.1.44 does.
const LOOPBACK_ONLY_SERVER = `server.listen(PORT, "127.0.0.1", () => {});`;
// A hypothetical build that has taken the patch request in the plan doc.
const BIND_AWARE_SERVER = `const HOST = process.env.MURAGE_BIND_ADDRESS ?? "127.0.0.1";\nserver.listen(PORT, HOST);`;

function serverFile(source, name = "index.js") {
  const path = join(scratch(), name);
  writeFileSync(path, source);
  return path;
}

test("planStart binds loopback by default", () => {
  const entry = serverFile(LOOPBACK_ONLY_SERVER);
  const plan = planStart({}, { entry, supportsBindAddress: false });
  assert.equal(plan.go, true);
  assert.equal(plan.address, "127.0.0.1");
  assert.equal(plan.port, 8799);
});

test("planStart REFUSES a wildcard bind however it is spelled", () => {
  const entry = serverFile(BIND_AWARE_SERVER);
  for (const env of [{ HOST: "0.0.0.0" }, { MURAGE_BIND_ADDRESS: "::" }, { MURAGE_HOST: "0.0.0.0" }]) {
    const plan = planStart(env, { entry, supportsBindAddress: true });
    assert.equal(plan.go, false, JSON.stringify(env));
    assert.equal(plan.code, "WILDCARD_REFUSED");
  }
});

test("planStart refuses tailnet mode on a server that cannot honour it", () => {
  // Refusing here is the honest answer: binding loopback anyway would leave the
  // operator believing the app is on their tailnet address when it is not.
  //
  // The verdict must NOT depend on whether the machine running the test happens
  // to be on a tailnet. It did once: on a macOS host with a tailnet this
  // returned SERVER_CANNOT_BIND_TAILNET, and on a bare Debian droplet the
  // address lookup failed first and it returned NO_TAILNET_ADDRESS. Caught by
  // running the suite on a real Linux box.
  const entry = serverFile(LOOPBACK_ONLY_SERVER);
  const plan = planStart({ MURAGE_BIND_MODE: "tailnet" }, { entry, supportsBindAddress: false });
  assert.equal(plan.go, false);
  assert.equal(plan.code, "SERVER_CANNOT_BIND_TAILNET");
  assert.match(plan.error, /hardcodes its listener/);
});

test("planStart refuses tailnet mode on a bind-aware server with no tailnet address", () => {
  const entry = serverFile(BIND_AWARE_SERVER);
  const plan = planStart({ MURAGE_BIND_MODE: "tailnet" }, { entry, supportsBindAddress: true });
  // On a host WITH a tailnet this resolves; on one without, it must refuse.
  if (plan.go) assert.match(plan.address, /^(100\.|fd7a:)/);
  else assert.equal(plan.code, "NO_TAILNET_ADDRESS");
});

test("planStart rejects a nonsense port instead of coercing it", () => {
  const entry = serverFile(LOOPBACK_ONLY_SERVER);
  for (const port of ["abc", "0", "70000", "-1"]) {
    const plan = planStart({ MURAGE_PORT: port }, { entry, supportsBindAddress: false });
    assert.equal(plan.go, false, port);
    assert.equal(plan.code, "BAD_PORT");
  }
});

test("server capability probing reads the build rather than assuming", () => {
  assert.equal(serverSupportsBindAddress(serverFile(LOOPBACK_ONLY_SERVER)), false);
  assert.equal(serverSupportsBindAddress(serverFile(BIND_AWARE_SERVER)), true);
  assert.equal(serverSupportsBindAddress("/no/such/file"), false, "an unreadable build is assumed incapable");
  assert.equal(serverSupportsResetPass(serverFile(LOOPBACK_ONLY_SERVER)), false);
  assert.equal(serverSupportsResetPass(serverFile(`if (argv.includes("--resetpass")) reset();`)), true);
});

test("resolveServerEntry prefers the packaged payload, then a repo build", () => {
  const found = resolveServerEntry("/inst", "/repo", (p) => p === "/repo/dist-server/index.js");
  assert.equal(found.entry, "/repo/dist-server/index.js");
  const packaged = resolveServerEntry("/inst", "/repo", (p) => p.startsWith("/inst/payload") || p.startsWith("/repo"));
  assert.equal(packaged.entry, "/inst/payload/server/index.js");
  assert.equal(resolveServerEntry("/inst", "/repo", () => false), null);
});

const DEPLOY = { user: "deploy", uid: 1001, gid: 1001, group: "deploy", home: "/home/deploy" };

test("the systemd unit orders after tailscaled and does not widen the box", () => {
  const text = unitText({
    execPath: "/usr/bin/node",
    cliPath: "/opt/murage/installer/bin/murage.mjs",
    dataDir: "/home/deploy/.murage-server",
    envFile: "/home/deploy/.murage-server/murage.env",
    tailscale: true,
    account: DEPLOY,
  });
  assert.match(text, /After=tailscaled\.service/, "starting before the tailnet daemon comes up unreachable");
  assert.match(text, /Wants=tailscaled\.service/);
  assert.match(text, /NoNewPrivileges=true/);
  assert.match(text, /ProtectHome=read-only/);
  assert.match(text, /Environment=PATH=\/usr\/bin:/, "systemd's minimal PATH excludes the node bindir");
  assert.match(text, /^User=deploy$/m, "a unit without User= runs the agent stack as root (I1)");
  assert.ok(!/0\.0\.0\.0/.test(text));
  assert.ok(!/ALLOW_REMOTE/.test(text));

  const noTs = unitText({ execPath: "/usr/bin/node", cliPath: "/x.mjs", dataDir: "/srv/d", envFile: "/e", account: DEPLOY });
  assert.ok(!/tailscaled/.test(noTs));
});

// I4 replaced the fixed /tmp/murage.service staging path and its `sudo mv`
// with a private directory and a digest-checked `install`; systemd.test.mjs
// covers that in full.
test("stageUnit stages privately and hands back the commands, installing nothing", () => {
  const root = scratch();
  const r = stageUnit(
    { execPath: "/usr/bin/node", cliPath: "/x.mjs", dataDir: "/srv/d", envFile: "/e", tailscale: true, account: DEPLOY },
    { stagingRoot: root }
  );
  assert.equal(dirname(dirname(r.stagedPath)), root);
  assert.match(readFileSync(r.stagedPath, "utf8"), /Description=Murage headless server/);
  assert.ok(r.commands[0].includes(`sudo install -o root -g root -m 0644 ${r.stagedPath} ${UNIT_PATH}`), r.commands[0]);
  assert.ok(!r.commands.some((cmd) => cmd.includes("/tmp/murage.service")));
});

test("setup refuses a stray argument before doing anything, and does not echo it", () => {
  const home = scratch();
  const log = join(home, "argv.log");
  const stub = join(home, "tailscale-stub");
  writeFileSync(stub, `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\necho '{}'\n`, { mode: 0o755 });
  const stray = "tskey-auth-kSTRAYARGV-MUSTNOTECHO";
  let status = 0;
  let out = "";
  try {
    out = execFileSync(process.execPath, [CLI, "setup", stray], {
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        MURAGE_SERVER_ENTRY: serverFile(LOOPBACK_ONLY_SERVER),
        MURAGE_DATA_DIR: join(home, ".murage-server"),
        MURAGE_ENV_FILE: join(home, ".murage-server", "murage.env"),
        MURAGE_TAILSCALE_BIN: stub,
        NO_COLOR: "1",
      },
    });
  } catch (e) {
    status = e.status ?? 0;
    out = (e.stdout ?? "") + (e.stderr ?? "");
  }
  assert.equal(status, 2, out);
  assert.match(out, /--service-user/);
  assert.ok(!out.includes("STRAYARGV"), out);
  assert.equal(existsSync(join(home, ".murage-server")), false, "nothing was created");
  assert.equal(existsSync(log), false, "tailscale was never called");
});

test("the CLI runs, prints help, and exits 0 without touching the network", () => {
  const out = execFileSync(process.execPath, [CLI, "help"], { encoding: "utf8", timeout: 20_000 });
  assert.match(out, /murage setup/);
  assert.match(out, /never taken as a CLI argument/, "the key-handling promise is on the help screen");
  assert.ok(!/--auth-key/.test(out), "help must not advertise a flag that would leak the key into argv");
});

test("an unknown subcommand prints help rather than doing something surprising", () => {
  const out = execFileSync(process.execPath, [CLI, "nuke-everything"], { encoding: "utf8", timeout: 20_000 });
  assert.match(out, /murage setup/);
});

test("setup exits non-zero when it could not secure the box", () => {
  // A provisioning script must be able to tell "on the tailnet" from "reachable
  // only through an SSH tunnel". A green exit code for both would be the same
  // lie as a green banner.
  //
  // Made deterministic with a stub CLI: PATH manipulation is not enough, because
  // the candidate list finds a real /Applications/Tailscale.app on any Mac.
  const entry = serverFile(LOOPBACK_ONLY_SERVER);
  const home = scratch();
  const stub = join(home, "tailscale-stub");
  writeFileSync(stub, '#!/bin/sh\necho \'{"BackendState":"NeedsLogin"}\'\n', { mode: 0o755 });

  let status = 0;
  let out = "";
  try {
    out = execFileSync(process.execPath, [CLI, "setup"], {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        MURAGE_SERVER_ENTRY: entry,
        MURAGE_DATA_DIR: join(home, ".murage-server"),
        MURAGE_ENV_FILE: join(home, ".murage-server", "murage.env"),
        MURAGE_TAILSCALE_BIN: stub,
        MURAGE_TS_AUTHKEY: "",
        TS_AUTHKEY: "",
        TAILSCALE_AUTHKEY: "",
        NO_COLOR: "1",
      },
    });
  } catch (e) {
    status = e.status ?? 0;
    out = (e.stdout ?? "") + (e.stderr ?? "");
  }
  assert.equal(status, SETUP_NOT_SECURED, `expected exit ${SETUP_NOT_SECURED}, got ${status}\n${out}`);
  assert.match(out, /NOT secured/);
  assert.match(out, /Setup will not pretend otherwise/);
  assert.match(out, /ssh -N -L/, "an unsecured box must be told the only safe way in");
  // ...and it still wrote a usable, private env file rather than leaving a mess.
  const envPath = join(home, ".murage-server", "murage.env");
  assert.equal(envFilePermissions(envPath).private, true);
  assert.equal(readEnvFile(envPath).MURAGE_BIND_MODE, "loopback");
  assert.equal(readEnvFile(envPath).MURAGE_TRUSTED_PROXY, undefined, "no proxy was configured, so none is declared");
});

test("rerunning setup and pressing Enter at the key prompt keeps what was already configured (I3)", () => {
  const home = scratch();
  const dataDir = mkdtempSync(join(home, "data-"));
  const envPath = join(dataDir, "murage.env");
  const stored = {
    MURAGE_DATA_DIR: dataDir,
    MURAGE_PORT: "9100",
    MURAGE_BIND_MODE: "loopback",
    NODE_ENV: "production",
    ANTHROPIC_API_KEY: "sk-ant-STORED-ONE",
    OPENAI_API_KEY: "sk-STORED-TWO",
    MURAGE_BROWSER_PORT: "9313",
    MURAGE_TRUSTED_PROXY: "1",
    CUSTOM_SETTING: "kept",
  };
  const text = `# Written by an earlier murage setup\n${Object.entries(stored).map(([k, v]) => `${k}=${v}`).join("\n")}\n`;
  writeFileSync(envPath, text, { mode: 0o600 });
  const stub = join(home, "tailscale-stub");
  writeFileSync(stub, '#!/bin/sh\necho \'{"BackendState":"NeedsLogin"}\'\n', { mode: 0o755 });

  let status = 0;
  let out = "";
  try {
    out = execFileSync(process.execPath, [CLI, "setup"], {
      encoding: "utf8",
      timeout: 60_000,
      // Two blank answers: no auth key, then Enter at the provider-key prompt.
      // Piped rather than closed, so the provider prompt is actually asked.
      input: "\n\n",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        MURAGE_SERVER_ENTRY: serverFile(LOOPBACK_ONLY_SERVER),
        MURAGE_DATA_DIR: dataDir,
        MURAGE_ENV_FILE: envPath,
        MURAGE_TAILSCALE_BIN: stub,
        MURAGE_TS_AUTHKEY: "",
        TS_AUTHKEY: "",
        TAILSCALE_AUTHKEY: "",
        MURAGE_PORT: "",
        MURAGE_BROWSER_PORT: "",
        NO_COLOR: "1",
      },
    });
  } catch (e) {
    status = e.status ?? 0;
    out = (e.stdout ?? "") + (e.stderr ?? "");
  }
  assert.equal(status, SETUP_NOT_SECURED, out);
  assert.deepEqual(readEnvFile(envPath), stored, "every stored key and setting survives a skipped key and a failed enrolment");
  assert.equal(envFilePermissions(envPath).private, true);
  assert.equal(existsSync(`${envPath}.previous`), false, "nothing was replaced, so there is no recovery copy");
  assert.match(out, /Enter to keep/);
  assert.match(out, /ANTHROPIC_API_KEY/, "the operator is told which keys are already configured");
  assert.ok(!out.includes("STORED"), "stored key values are never printed");
  assert.match(out, /ssh -N -L 9100:127\.0\.0\.1:9100/, "the stored harness port is the one setup uses");
});

test("setup refuses to rewrite an env file it cannot carry over, and changes nothing", () => {
  const home = scratch();
  const dataDir = mkdtempSync(join(home, "data-"));
  const envPath = join(dataDir, "murage.env");
  const text = "ANTHROPIC_API_KEY=sk-ant-KEEPME\nsk-proj-PASTEDONITSOWNLINE\n";
  writeFileSync(envPath, text, { mode: 0o600 });
  const log = join(home, "argv.log");
  const stub = join(home, "tailscale-stub");
  writeFileSync(stub, `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\necho '{}'\n`, { mode: 0o755 });
  let status = 0;
  let out = "";
  try {
    out = execFileSync(process.execPath, [CLI, "setup"], {
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        MURAGE_SERVER_ENTRY: serverFile(LOOPBACK_ONLY_SERVER),
        MURAGE_DATA_DIR: dataDir,
        MURAGE_ENV_FILE: envPath,
        MURAGE_TAILSCALE_BIN: stub,
        NO_COLOR: "1",
      },
    });
  } catch (e) {
    status = e.status ?? 0;
    out = (e.stdout ?? "") + (e.stderr ?? "");
  }
  assert.equal(status, 2, out);
  assert.match(out, /line 2 is not KEY=value/);
  assert.ok(!/KEEPME|PASTEDONITSOWNLINE/.test(out), out);
  assert.equal(readFileSync(envPath, "utf8"), text);
  assert.equal(existsSync(log), false, "refused before tailscale was touched");
});

// ── I6: the runtime is checked against the payload before anything happens ──

test("the runtime floor is node 24: 20, 22 and 23 are refused, not warned about", () => {
  const requirement = runtimeRequirement("/no/installer", "/no/repo", () => {
    throw new Error("ENOENT");
  });
  assert.deepEqual([...requirement.min], [24, 0, 0]);
  assert.deepEqual([...RUNTIME_FLOOR], [24, 0, 0]);
  for (const version of ["20.19.0", "22.12.0", "23.11.1", "v22.5.0"]) {
    const verdict = runtimePreflight(version, requirement);
    assert.equal(verdict.ok, false, version);
    assert.match(verdict.reason, /requires node >=24\.0\.0/);
  }
  for (const version of ["24.0.0", "24.20.0", "v25.1.0"]) assert.deepEqual(runtimePreflight(version, requirement), { ok: true }, version);
  assert.equal(runtimePreflight("banana", requirement).ok, false);
});

test("the requirement comes from the distributed manifest, payload first, and never drops below the floor", () => {
  const files = {
    "/inst/payload/package.json": JSON.stringify({ engines: { node: ">=24.3" } }),
    "/inst/package.json": JSON.stringify({ engines: { node: ">=20" } }),
    "/repo/package.json": JSON.stringify({ engines: { node: ">=26" } }),
  };
  const read = (p) => {
    if (!(p in files)) throw new Error("ENOENT");
    return files[p];
  };
  assert.deepEqual(runtimeRequirement("/inst", "/repo", read), { min: [24, 3, 0], range: ">=24.3", source: "/inst/payload/package.json" });
  delete files["/inst/payload/package.json"];
  assert.deepEqual([...runtimeRequirement("/inst", "/repo", read).min], [24, 0, 0], "a manifest asking for less than the server needs does not loosen the floor");
  delete files["/inst/package.json"];
  assert.deepEqual(runtimeRequirement("/inst", "/repo", read), { min: [26, 0, 0], range: ">=26", source: "/repo/package.json" });
  files["/repo/package.json"] = JSON.stringify({ engines: { node: "24 || 26" } });
  assert.deepEqual([...runtimeRequirement("/inst", "/repo", read).min], [24, 0, 0], "a range this installer cannot read falls back to the floor");
  assert.equal(installerVersion("/inst", "/repo", read), "unknown");

  const checkout = resolve(dirname(CLI), "..", "..");
  const manifest = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8"));
  assert.equal(runtimeRequirement(resolve(dirname(CLI), ".."), checkout).range, manifest.engines.node, "this checkout's manifest is the one read");
  assert.equal(installerVersion(resolve(dirname(CLI), ".."), checkout), manifest.version);
});

test("setup and start refuse an incompatible runtime before doing anything (I6)", () => {
  // A copy of the CLI whose distributed manifest asks for a node nobody has,
  // run on the real runtime executing this test.
  const root = scratch();
  mkdirSync(join(root, "installer", "bin"), { recursive: true });
  cpSync(join(dirname(dirname(CLI)), "lib"), join(root, "installer", "lib"), { recursive: true });
  cpSync(CLI, join(root, "installer", "bin", "murage.mjs"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "murage", version: "0.0.0-test", engines: { node: ">=99" } }));
  const cli = join(root, "installer", "bin", "murage.mjs");
  const log = join(root, "argv.log");
  const stub = join(root, "tailscale-stub");
  writeFileSync(stub, `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\necho '{}'\n`, { mode: 0o755 });
  const harnessRan = join(root, "harness-ran");
  const entry = join(root, "server.mjs");
  writeFileSync(entry, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(harnessRan)}, "ran");`);
  const env = {
    ...process.env,
    MURAGE_SERVER_ENTRY: entry,
    MURAGE_DATA_DIR: join(root, "data"),
    MURAGE_ENV_FILE: join(root, "data", "murage.env"),
    MURAGE_TAILSCALE_BIN: stub,
    MURAGE_COMPANION_ENTRY: join(root, "no-companion.mjs"),
    NO_COLOR: "1",
  };
  for (const command of ["setup", "start"]) {
    let status = 0;
    let out = "";
    try {
      out = execFileSync(process.execPath, [cli, command], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"], env });
    } catch (e) {
      status = e.status ?? 0;
      out = (e.stdout ?? "") + (e.stderr ?? "");
    }
    assert.equal(status, 1, `${command}: ${out}`);
    assert.match(out, new RegExp(`node ${process.versions.node.replaceAll(".", "\\.")} cannot run this Murage server: .*package\\.json requires node >=99`), out);
    assert.match(out, /Nothing has been changed/);
  }
  assert.equal(existsSync(join(root, "data")), false, "no data dir, env file or door identity was created");
  assert.equal(existsSync(log), false, "tailscale was never called");
  assert.equal(existsSync(harnessRan), false, "the harness was never started");
});

test("MURAGE_TAILSCALE_BIN points at a specific CLI, and a missing one is not found", async () => {
  const { tailscaleBin } = await import("../lib/tailscale.mjs");
  assert.equal(tailscaleBin({ env: { MURAGE_TAILSCALE_BIN: "/opt/ts/tailscale" }, exists: (p) => p === "/opt/ts/tailscale" }), "/opt/ts/tailscale");
  assert.equal(tailscaleBin({ env: { MURAGE_TAILSCALE_BIN: "/gone" }, exists: () => false }), null);
  assert.equal(tailscaleBin({ env: {}, onPath: () => true, exists: () => false }), "tailscale");
  assert.equal(tailscaleBin({ env: {}, onPath: () => false, exists: () => false }), null);
});
