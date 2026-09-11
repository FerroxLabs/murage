/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * `murage setup` with nobody at the keyboard.
 *
 * The one-person cloud deployment is the foundation of a hosted service, and
 * provisioning cannot answer prompts. So every question the installer asks has
 * an equivalent input that can be supplied ahead of time, and a run that is
 * missing one FAILS — listing all of them at once, with exit code 2, having
 * changed nothing — instead of blocking on a prompt forever.
 *
 * What is proven here, in order:
 *
 *   (a) the option grammar, including the refusal of any flag that would put a
 *       secret into `ps`;
 *   (b) secrets read from a file or stdin, first line only, never printed;
 *   (c) the missing-input list: everything at once, not one per round trip;
 *   (d) a full non-interactive setup against fakes — fresh box to exit 0 —
 *       with the auth key never appearing in the tailscale argv or the output;
 *   (e) a rerun keeping what the first run configured;
 *   (f) the interactive path, unchanged (cli.test.mjs proves the rest of it).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { envFilePermissions, readEnvFile } from "../lib/env-file.mjs";
import { InteractivePromptRefused, ask, askSecret, refuseInteractivePrompts } from "../lib/ui.mjs";
import {
  EXIT,
  PROVIDER_ENV,
  boolFromEnv,
  inferProviderEnvName,
  isUnattended,
  readSecretFile,
  resolveUnattendedPlan,
  splitUnattendedArgs,
} from "../lib/unattended.mjs";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "murage.mjs");
const scratchDirs = [];
const scratch = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "murage-unattended-test-")));
  scratchDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/** Never a real key. Asserted absent from argv logs and from every byte of output. */
const AUTH_SECRET = "tskey-auth-kUNATTENDED-NEVERINARGV";
const PROVIDER_SECRET = "sk-ant-api03-UNATTENDEDPROVIDERSECRET";
const LOOPBACK_ONLY_SERVER = `server.listen(PORT, "127.0.0.1", () => {});`;

const RUNNING = JSON.stringify({
  BackendState: "Running",
  Self: { Online: true, TailscaleIPs: ["100.81.158.63"], DNSName: "box.tail0a48a4.ts.net.", Tags: ["tag:murage"] },
});
const NEEDS_LOGIN = JSON.stringify({ BackendState: "NeedsLogin" });

// ── (a) the option grammar ────────────────────────────────────────────────

test("a flag that would carry a secret in argv is refused by name, and its value is not echoed", () => {
  for (const flag of ["--tailscale-auth-key", "--auth-key", "--authkey", "--ts-authkey", "--provider-key", "--api-key"]) {
    for (const argv of [[flag, AUTH_SECRET], [`${flag}=${AUTH_SECRET}`]]) {
      const split = splitUnattendedArgs(argv);
      assert.ok("error" in split, `${flag} must be refused`);
      assert.match(split.error, /ps/, split.error);
      assert.ok(!split.error.includes("NEVERINARGV"), "the refusal must not echo the secret it refused");
      assert.match(split.error, /-file <path>/, "the refusal names the way to do it instead");
    }
  }
});

test("unattended options are pulled off argv and everything else is left for parseSetupArgs", () => {
  const split = splitUnattendedArgs([
    "--non-interactive",
    "--service-user",
    "murage",
    "--tailscale-auth-key-file",
    "/run/secrets/ts",
    "--provider-key-file=/run/secrets/anthropic",
    "--provider",
    "anthropic",
    "--tailnet-tag=tag:cloud",
    "--tailnet-hostname",
    "murage-box",
    "--no-https",
    "--systemd",
    "--no-provider-key",
  ]);
  assert.ok(!("error" in split), JSON.stringify(split));
  assert.deepEqual(split.rest, ["--service-user", "murage"], "--service-user stays with its own parser");
  assert.deepEqual(split.options, {
    nonInteractive: true,
    authKeyFile: "/run/secrets/ts",
    providerKeyFile: "/run/secrets/anthropic",
    provider: "anthropic",
    tag: "tag:cloud",
    hostname: "murage-box",
    https: false,
    systemd: true,
    skipProviderKey: true,
  });
  assert.deepEqual(splitUnattendedArgs(["-y"]).options, { nonInteractive: true });
  assert.deepEqual(splitUnattendedArgs(["--yes"]).options, { nonInteractive: true });
});

test("a self-contradicting or valueless option is refused rather than silently resolved", () => {
  assert.match(splitUnattendedArgs(["--https", "--no-https"]).error, /contradicts/);
  assert.match(splitUnattendedArgs(["--systemd", "--no-systemd"]).error, /contradicts/);
  assert.match(splitUnattendedArgs(["--provider"]).error, /needs a value/);
  assert.match(splitUnattendedArgs(["--tailnet-tag", "--systemd"]).error, /needs a value/);
  assert.match(splitUnattendedArgs(["--provider="]).error, /needs a value/);
  assert.match(splitUnattendedArgs(["--non-interactive=1"]).error, /does not take a value/);
  assert.match(splitUnattendedArgs(["--provider", "a", "--provider", "b"]).error, /twice with different values/);
  // The same answer twice is a script being repetitive, not a contradiction.
  assert.ok(!("error" in splitUnattendedArgs(["--https", "--https"])));
});

test("MURAGE_NON_INTERACTIVE is a tri-state, and an unreadable spelling is an error", () => {
  assert.equal(isUnattended({}, { MURAGE_NON_INTERACTIVE: "1" }).nonInteractive, true);
  assert.equal(isUnattended({}, { MURAGE_NON_INTERACTIVE: "yes" }).nonInteractive, true);
  assert.equal(isUnattended({}, { MURAGE_NON_INTERACTIVE: "0" }).nonInteractive, false);
  assert.equal(isUnattended({}, {}).nonInteractive, false);
  assert.equal(isUnattended({}, { MURAGE_NON_INTERACTIVE: "" }).nonInteractive, false);
  assert.equal(isUnattended({ nonInteractive: true }, {}).nonInteractive, true);
  const bad = isUnattended({}, { MURAGE_NON_INTERACTIVE: "please" });
  assert.match(bad.error, /must be one of/);
  assert.ok(!bad.error.includes("please"), "the value is not echoed; it could be a secret");
  assert.deepEqual(boolFromEnv("X", undefined), {});
  assert.deepEqual(boolFromEnv("X", "OFF"), { value: false });
});

test("provider inference reads the prefix, longest-specific first", () => {
  assert.equal(inferProviderEnvName("sk-ant-api03-x"), PROVIDER_ENV.anthropic);
  assert.equal(inferProviderEnvName("sk-proj-x"), PROVIDER_ENV.openai);
  assert.equal(inferProviderEnvName("AIzaSyX"), PROVIDER_ENV.gemini);
  assert.equal(inferProviderEnvName("xai-x"), PROVIDER_ENV.xai);
  assert.equal(inferProviderEnvName("hunter2"), null);
});

// ── (b) secrets from a file ───────────────────────────────────────────────

test("a secret file gives its first line, and says what is wrong when it cannot", () => {
  const dir = scratch();
  const good = join(dir, "key");
  writeFileSync(good, `${AUTH_SECRET}\n# the rest is ignored\n`, { mode: 0o600 });
  const read = readSecretFile(good);
  assert.equal(read.value, AUTH_SECRET);
  assert.equal(read.warning, undefined, "0600 draws no warning");

  const loose = join(dir, "loose");
  writeFileSync(loose, `${AUTH_SECRET}\n`, { mode: 0o644 });
  const warned = readSecretFile(loose);
  assert.equal(warned.value, AUTH_SECRET);
  assert.match(warned.warning, /other accounts on this box can read/);
  assert.ok(!warned.warning.includes("NEVERINARGV"), "the warning names the path, never the secret");

  const empty = join(dir, "empty");
  writeFileSync(empty, "\n\n", { mode: 0o600 });
  assert.match(readSecretFile(empty).error, /is empty/);
  assert.match(readSecretFile(join(dir, "nope")).error, /does not exist/);

  const link = join(dir, "link");
  symlinkSync(good, link);
  assert.match(readSecretFile(link).error, /not a regular file/, "a planted symlink is not followed");
});

// ── (c) every missing input at once ───────────────────────────────────────

const FRESH = { installed: true, enrolled: false };
const base = (over = {}) => ({ options: {}, env: {}, storedProviderKeys: [], tailscale: FRESH, ...over });

test("a bare --non-interactive run on a fresh box lists BOTH missing secrets, in one go", async () => {
  const result = await resolveUnattendedPlan(base());
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 2, JSON.stringify(result.problems));
  assert.ok(result.problems.some((p) => /Tailscale auth key/.test(p)), JSON.stringify(result.problems));
  assert.ok(result.problems.some((p) => /provider API key/.test(p)), JSON.stringify(result.problems));
  for (const problem of result.problems) {
    assert.match(problem, /--\S+-file <path>|--provider-key-file|MURAGE_/, problem);
  }
});

test("defaults match what a human pressing Enter would choose", async () => {
  const result = await resolveUnattendedPlan(
    base({ options: { authKeyFile: "/k", skipProviderKey: true }, readFile: () => ({ value: AUTH_SECRET }) })
  );
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.plan.installTailscale, true, "interactive default: install Tailscale");
  assert.equal(result.plan.https, true, "interactive default: HTTPS on the tailnet");
  assert.equal(result.plan.reenroll, false, "interactive default: keep an existing enrolment");
  assert.equal(result.plan.systemd, false, "interactive default: do not stage a unit");
  assert.equal(result.plan.wantTailscale, true);
  assert.equal(result.plan.tag, null, "null means the caller's DEFAULT_TAG");
  assert.equal(result.plan.authKeySource, "/k");
});

test("an already-enrolled box needs no auth key, which is what makes a rerun idempotent", async () => {
  const enrolled = { installed: true, enrolled: true };
  const kept = await resolveUnattendedPlan(base({ tailscale: enrolled, options: { skipProviderKey: true } }));
  assert.equal(kept.ok, true, JSON.stringify(kept.problems));
  assert.equal(kept.plan.authKey, null);

  // ...unless the operator asked to re-enrol, which needs a fresh key.
  const again = await resolveUnattendedPlan(base({ tailscale: enrolled, options: { reenroll: true, skipProviderKey: true } }));
  assert.equal(again.ok, false);
  assert.ok(again.problems.some((p) => /Tailscale auth key/.test(p)));
});

test("a provider key already in the env file satisfies the requirement; nothing else does silently", async () => {
  const stored = await resolveUnattendedPlan(base({ tailscale: { installed: true, enrolled: true }, storedProviderKeys: ["ANTHROPIC_API_KEY"] }));
  assert.equal(stored.ok, true, JSON.stringify(stored.problems));
  assert.equal(stored.plan.providerKey, null, "nothing new to write; the stored key is simply carried over");

  const none = await resolveUnattendedPlan(base({ tailscale: { installed: true, enrolled: true } }));
  assert.equal(none.ok, false);
  assert.ok(none.problems.some((p) => /--no-provider-key/.test(p)), "the way to opt out is named");
});

test("an unrecognisable provider key demands --provider instead of guessing", async () => {
  const guessless = await resolveUnattendedPlan(
    base({
      tailscale: { installed: true, enrolled: true },
      options: { providerKeyFile: "/run/secrets/k" },
      readFile: () => ({ value: "some-corporate-gateway-token" }),
    })
  );
  assert.equal(guessless.ok, false);
  assert.equal(guessless.problems.length, 1);
  assert.match(guessless.problems[0], /--provider/);
  assert.match(guessless.problems[0], /\/run\/secrets\/k/, "the source is named");
  assert.ok(!guessless.problems[0].includes("corporate-gateway-token"), "the key itself is never printed");

  const named = await resolveUnattendedPlan(
    base({
      tailscale: { installed: true, enrolled: true },
      options: { providerKeyFile: "/run/secrets/k", provider: "openai" },
      readFile: () => ({ value: "some-corporate-gateway-token" }),
    })
  );
  assert.equal(named.ok, true, JSON.stringify(named.problems));
  assert.equal(named.plan.providerEnvName, "OPENAI_API_KEY");

  const wrong = await resolveUnattendedPlan(
    base({
      tailscale: { installed: true, enrolled: true },
      options: { providerKeyFile: "/k", provider: "mistral" },
      readFile: () => ({ value: "abc" }),
    })
  );
  assert.equal(wrong.ok, false);
  assert.match(wrong.problems[0], /anthropic, openai, gemini, xai/);
});

test("stdin is one stream, and two secrets cannot both claim it", async () => {
  const clash = await resolveUnattendedPlan(
    base({ options: { authKeyStdin: true, providerKeyStdin: true }, readStdin: async () => AUTH_SECRET })
  );
  assert.equal(clash.ok, false);
  assert.ok(clash.problems.some((p) => /stdin is one stream/.test(p)), JSON.stringify(clash.problems));

  const piped = await resolveUnattendedPlan(
    base({ options: { authKeyStdin: true, skipProviderKey: true }, readStdin: async () => `${AUTH_SECRET}\n` })
  );
  assert.equal(piped.ok, true, JSON.stringify(piped.problems));
  assert.equal(piped.plan.authKey, AUTH_SECRET, "the trailing newline is not part of the key");
  assert.equal(piped.plan.authKeySource, "stdin");
});

test("an unreadable secret file is reported as a problem, not as a missing input", async () => {
  const result = await resolveUnattendedPlan(
    base({ options: { authKeyFile: "/run/secrets/gone", skipProviderKey: true }, readFile: () => ({ error: "/run/secrets/gone does not exist" }) })
  );
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /Tailscale auth key: \/run\/secrets\/gone does not exist/);
});

test("MURAGE_* environment forms answer the same questions as the flags", async () => {
  const result = await resolveUnattendedPlan(
    base({
      env: {
        MURAGE_TS_AUTHKEY: AUTH_SECRET,
        MURAGE_PROVIDER_KEY_FILE: "/run/secrets/p",
        MURAGE_TAILNET_TAG: "tag:cloud",
        MURAGE_TAILNET_HOSTNAME: "box-7",
        MURAGE_TAILNET_HTTPS: "no",
        MURAGE_STAGE_SYSTEMD: "yes",
        MURAGE_TAILSCALE_REENROLL: "false",
      },
      readFile: () => ({ value: PROVIDER_SECRET }),
    })
  );
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.plan.authKeySource, "$MURAGE_TS_AUTHKEY");
  assert.equal(result.plan.providerEnvName, "ANTHROPIC_API_KEY");
  assert.equal(result.plan.tag, "tag:cloud");
  assert.equal(result.plan.hostname, "box-7");
  assert.equal(result.plan.https, false);
  assert.equal(result.plan.systemd, true);
});

test("--no-install-tailscale on a box without it is named as the contradiction it is", async () => {
  const result = await resolveUnattendedPlan(
    base({ tailscale: { installed: false, enrolled: false }, options: { installTailscale: false, authKeyFile: "/k", skipProviderKey: true }, readFile: () => ({ value: AUTH_SECRET }) })
  );
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /--install-tailscale/);
  assert.match(result.problems[0], /--no-tailscale/);
});

test("--no-tailscale drops the auth-key requirement, because there is no tailnet to join", async () => {
  const result = await resolveUnattendedPlan(
    base({ tailscale: { installed: false, enrolled: false }, options: { wantTailscale: false, skipProviderKey: true } })
  );
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.plan.wantTailscale, false);
  assert.equal(result.plan.authKey, null);
});

// ── the safety net under every guarded prompt ─────────────────────────────

test("with prompts refused, a question is a loud failure instead of a hang", async () => {
  refuseInteractivePrompts(true);
  try {
    await assert.rejects(() => ask("  Which provider is this key for? "), InteractivePromptRefused);
    await assert.rejects(() => askSecret("  Tailscale auth key: "), (error) => {
      assert.equal(error.code, "INTERACTIVE_PROMPT_REFUSED");
      assert.match(error.message, /--non-interactive/);
      return true;
    });
  } finally {
    refuseInteractivePrompts(false);
  }
});

// ── (d)(e)(f) the CLI, end to end, against fakes ──────────────────────────

/** A port nothing is listening on right now. */
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

/**
 * A stateful stub `tailscale`: NOT enrolled until an `up` has run, and no
 * proxy configured until a `serve --bg` has. A stub that reported a finished
 * box from its first call would let setup take an early exit and every
 * assertion below would pass without the work happening.
 */
function tailscaleStub(dir, { logFile, doorPort }) {
  const path = join(dir, "tailscale-stub");
  const upDone = join(dir, "up-done");
  const served = join(dir, "serve-configured");
  const web = `{"Web":{"box.tail0a48a4.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:${doorPort}"}}}}}`;
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
      'if [ "$1" = "up" ]; then',
      `  : > ${JSON.stringify(upDone)}`,
      "  exit 0",
      "fi",
      'if [ "$1" = "status" ]; then',
      `  if [ -f ${JSON.stringify(upDone)} ]; then echo '${RUNNING}'; else echo '${NEEDS_LOGIN}'; fi`,
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 }
  );
  return path;
}

/** Stands in for the companion sidecar: opens the browser door and proves its identity. */
function fakeSidecar(dir) {
  const path = join(dir, "fake-companion.js");
  writeFileSync(
    path,
    [
      'import { createHmac } from "node:crypto";',
      'import { createServer } from "node:http";',
      "const port = Number(process.env.MURAGE_BROWSER_PORT);",
      'const nonce = process.env.MURAGE_DOOR_NONCE ?? "";',
      'const version = process.env.MURAGE_DOOR_VERSION ?? "unknown";',
      "const server = createServer((req, res) => {",
      '  const challenge = req.headers["x-murage-door-challenge"];',
      '  if (/^[a-f0-9]{64}$/.test(nonce) && typeof challenge === "string" && /^[a-f0-9]{64}$/.test(challenge)) {',
      '    res.setHeader("x-murage-door-version", version);',
      '    res.setHeader("x-murage-door-proof", createHmac("sha256", Buffer.from(nonce, "hex")).update(`murage-door-identity/1\\n${challenge}\\n${version}`).digest("hex"));',
      "  }",
      '  if ((req.url ?? "").split("?")[0] === "/enter") { res.writeHead(200); res.end("enter"); return; }',
      "  res.writeHead(404); res.end();",
      "});",
      'server.listen(port, "127.0.0.1");',
      "setInterval(() => {}, 1 << 30);",
    ].join("\n")
  );
  return path;
}

/** Run the CLI from an isolated copy, with no terminal and (by default) no stdin. */
function runCli(args, env, { input = null } = {}) {
  return new Promise((res, rej) => {
    const installed = join(dirname(env.MURAGE_DATA_DIR), "installer");
    if (!existsSync(installed)) {
      mkdirSync(join(installed, "bin"), { recursive: true });
      cpSync(join(dirname(dirname(CLI)), "lib"), join(installed, "lib"), { recursive: true });
      cpSync(CLI, join(installed, "bin", "murage.mjs"));
    }
    const child = spawn(process.execPath, [join(installed, "bin", "murage.mjs"), ...args], {
      detached: process.platform !== "win32",
      stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"],
      env: { ...env, NO_COLOR: "1" },
    });
    if (input !== null) {
      child.stdin.end(input);
    }
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    let done = false;
    const finish = (error, code) => {
      if (done) return;
      done = true;
      clearTimeout(hard);
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      child.stdout.destroy();
      child.stderr.destroy();
      if (error) rej(error);
      else res({ status: code ?? 0, out });
    };
    const hard = setTimeout(() => finish(new Error(`CLI exceeded its 60s fixture budget:\n${out}`)), 60_000);
    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish(null, code));
  });
}

/** A scratch install: the CLI's package root, a server payload, and an env. */
function box(extra = {}) {
  const home = scratch();
  writeFileSync(join(home, "package.json"), JSON.stringify({ name: "murage", version: "0.1.52-test", engines: { node: ">=24" } }));
  const entry = join(home, "index.js");
  writeFileSync(entry, LOOPBACK_ONLY_SERVER);
  return {
    home,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      MURAGE_SERVER_ENTRY: entry,
      MURAGE_DATA_DIR: join(home, ".murage-server"),
      MURAGE_ENV_FILE: join(home, ".murage-server", "murage.env"),
      // Nothing inherited from the developer's shell may answer a question.
      MURAGE_TS_AUTHKEY: "",
      TS_AUTHKEY: "",
      TAILSCALE_AUTHKEY: "",
      MURAGE_NON_INTERACTIVE: "",
      MURAGE_PROVIDER: "",
      MURAGE_PROVIDER_KEY_FILE: "",
      MURAGE_TAILSCALE_AUTHKEY_FILE: "",
      MURAGE_SERVICE_USER: "",
      ...extra,
    },
  };
}

test("a full non-interactive setup takes a fresh box to exit 0, with no prompt and no secret in sight", async () => {
  const { home, env } = box();
  const door = await freePort();
  const log = join(home, "argv.log");
  const keyFile = join(home, "ts.key");
  writeFileSync(keyFile, `${AUTH_SECRET}\n`, { mode: 0o600 });
  const providerFile = join(home, "provider.key");
  writeFileSync(providerFile, `${PROVIDER_SECRET}\n`, { mode: 0o600 });

  const { status, out } = await runCli(
    [
      "setup",
      "--non-interactive",
      "--tailscale-auth-key-file",
      keyFile,
      "--provider-key-file",
      providerFile,
      "--tailnet-tag",
      "tag:murage",
      "--tailnet-hostname",
      "murage-box",
    ],
    {
      ...env,
      MURAGE_TAILSCALE_BIN: tailscaleStub(home, { logFile: log, doorPort: door }),
      MURAGE_BROWSER_PORT: String(door),
      MURAGE_COMPANION_ENTRY: fakeSidecar(home),
    }
  );

  assert.equal(status, EXIT.OK, out);
  assert.match(out, /on your tailnet and is NOT reachable from the internet/, out);

  // The env file is the deployment. It is private, it names the key, and it
  // declares the proxy this run actually verified.
  const envPath = join(home, ".murage-server", "murage.env");
  assert.equal(envFilePermissions(envPath).private, true);
  const bag = readEnvFile(envPath);
  assert.equal(bag.ANTHROPIC_API_KEY, PROVIDER_SECRET, "the key from the file is what was stored");
  assert.equal(bag.MURAGE_BIND_MODE, "loopback");
  assert.equal(bag.MURAGE_TRUSTED_PROXY, "1", "a proxy was verified this run, so it is declared");

  // The whole point: neither secret reached argv or the terminal.
  const argv = readFileSync(log, "utf8");
  assert.match(argv, /^up --reset --auth-key=file:/m, "the key goes in by file path, never as an argument");
  assert.ok(!argv.includes(AUTH_SECRET), `the auth key leaked into tailscale's argv:\n${argv}`);
  assert.ok(!argv.includes(PROVIDER_SECRET), argv);
  assert.ok(!out.includes(AUTH_SECRET), "the auth key was printed");
  assert.ok(!out.includes(PROVIDER_SECRET), "the provider key was printed");
  assert.match(out, /using the Tailscale auth key from/, "the SOURCE is reported, so a provisioning log is readable");
  assert.ok(out.includes(keyFile), "and the source is the path, which is not a secret");
  assert.match(argv, /--advertise-tags=tag:murage/);
  assert.match(argv, /--hostname=murage-box/);
});

test("a rerun changes nothing it was not told to change, and needs no auth key for a box already on the tailnet", async () => {
  const { home, env } = box();
  const door = await freePort();
  const log = join(home, "argv.log");
  const keyFile = join(home, "ts.key");
  writeFileSync(keyFile, `${AUTH_SECRET}\n`, { mode: 0o600 });
  const providerFile = join(home, "provider.key");
  writeFileSync(providerFile, `${PROVIDER_SECRET}\n`, { mode: 0o600 });
  const stubEnv = {
    ...env,
    MURAGE_TAILSCALE_BIN: tailscaleStub(home, { logFile: log, doorPort: door }),
    MURAGE_BROWSER_PORT: String(door),
    MURAGE_COMPANION_ENTRY: fakeSidecar(home),
  };

  const first = await runCli(
    ["setup", "--non-interactive", "--tailscale-auth-key-file", keyFile, "--provider-key-file", providerFile],
    stubEnv
  );
  assert.equal(first.status, EXIT.OK, first.out);
  const envPath = join(home, ".murage-server", "murage.env");
  const before = readEnvFile(envPath);

  // The second run carries no secrets at all: the box is enrolled and the key
  // is already in the file, so nothing is missing.
  const again = await runCli(["setup", "--non-interactive"], stubEnv);
  assert.equal(again.status, EXIT.OK, again.out);
  assert.deepEqual(readEnvFile(envPath), before, "a rerun preserves the whole configuration");
  assert.equal(existsSync(`${envPath}.previous`), false, "nothing was replaced, so no recovery copy was needed");
  assert.match(again.out, /already on the tailnet/, again.out);
  assert.match(again.out, /keeping the stored ANTHROPIC_API_KEY/, again.out);
  assert.ok(!again.out.includes(PROVIDER_SECRET), "the stored key is named, never printed");
});

test("a non-interactive run with nothing supplied exits 2, lists everything missing, and changes nothing", async () => {
  const { home, env } = box();
  const log = join(home, "argv.log");
  const { status, out } = await runCli(["setup", "--non-interactive"], {
    ...env,
    MURAGE_TAILSCALE_BIN: tailscaleStub(home, { logFile: log, doorPort: 8813 }),
  });
  assert.equal(status, EXIT.USAGE, out);
  assert.match(out, /cannot ask/, out);
  assert.match(out, /Tailscale auth key/, out);
  assert.match(out, /provider API key/, out);
  assert.match(out, /Nothing has been changed/, out);
  assert.equal(existsSync(join(home, ".murage-server", "murage.env")), false, "no env file was written");
  // The preflight is allowed to READ the daemon (that is how it knows whether a
  // key is needed) but must not have changed anything.
  const argv = existsSync(log) ? readFileSync(log, "utf8") : "";
  assert.ok(!/^up /m.test(argv), `the box was enrolled despite a refused run:\n${argv}`);
  assert.ok(!/^serve --bg/m.test(argv), argv);
});

test("a secret file the run cannot read is named exactly, and the run still changes nothing", async () => {
  const { home, env } = box();
  const { status, out } = await runCli(
    ["setup", "--non-interactive", "--tailscale-auth-key-file", join(home, "not-there"), "--no-provider-key"],
    { ...env, MURAGE_TAILSCALE_BIN: tailscaleStub(home, { logFile: join(home, "argv.log"), doorPort: 8813 }) }
  );
  assert.equal(status, EXIT.USAGE, out);
  assert.match(out, /Tailscale auth key: .*not-there does not exist/, out);
  assert.equal(existsSync(join(home, ".murage-server", "murage.env")), false);
});

test("unattended answers without --non-interactive are refused, not silently ignored into a hang", async () => {
  const { home, env } = box();
  const keyFile = join(home, "ts.key");
  writeFileSync(keyFile, `${AUTH_SECRET}\n`, { mode: 0o600 });
  const { status, out } = await runCli(["setup", "--tailscale-auth-key-file", keyFile], {
    ...env,
    MURAGE_TAILSCALE_BIN: tailscaleStub(home, { logFile: join(home, "argv.log"), doorPort: 8813 }),
  });
  assert.equal(status, EXIT.USAGE, out);
  assert.match(out, /only apply to an unattended run/, out);
  assert.match(out, /--non-interactive/, out);
  assert.ok(!out.includes(AUTH_SECRET), out);
});

test("a flag carrying a secret is refused by the CLI before anything happens, without echoing it", async () => {
  const { home, env } = box();
  const log = join(home, "argv.log");
  const { status, out } = await runCli(["setup", "--non-interactive", `--tailscale-auth-key=${AUTH_SECRET}`], {
    ...env,
    MURAGE_TAILSCALE_BIN: tailscaleStub(home, { logFile: log, doorPort: 8813 }),
  });
  assert.equal(status, EXIT.USAGE, out);
  assert.ok(!out.includes("NEVERINARGV"), out);
  assert.match(out, /--tailscale-auth-key-file/, out);
  assert.equal(existsSync(log), false, "tailscale was never called");
  assert.equal(existsSync(join(home, ".murage-server")), false, "nothing was created");
});

test("--no-tailscale deploys an unsecured box, says so, and exits 3", async () => {
  const { home, env } = box();
  const log = join(home, "argv.log");
  const { status, out } = await runCli(["setup", "--non-interactive", "--no-tailscale", "--no-provider-key"], {
    ...env,
    MURAGE_TAILSCALE_BIN: tailscaleStub(home, { logFile: log, doorPort: 8813 }),
  });
  assert.equal(status, 3, out);
  assert.match(out, /NOT secured/, out);
  assert.match(out, /--no-tailscale was given/, out);
  assert.match(out, /ssh -N -L/, out);
  const argv = existsSync(log) ? readFileSync(log, "utf8") : "";
  assert.ok(!/^up /m.test(argv), argv);
  // It is still a real deployment: the env file exists and is private.
  assert.equal(envFilePermissions(join(home, ".murage-server", "murage.env")).private, true);
});

test("start accepts the same switches, asks nothing, and refuses arguments it does not know", async () => {
  const { env } = box();
  const stray = await runCli(["start", "definitely-not-a-flag"], env);
  assert.equal(stray.status, EXIT.USAGE, stray.out);
  assert.match(stray.out, /takes no arguments/, stray.out);

  // With no env file and no tailnet address, `start` refuses on its bind policy
  // — the point here is that --non-interactive reached that decision without
  // stopping to ask anything.
  const run = await runCli(["start", "--non-interactive"], { ...env, MURAGE_BIND_MODE: "tailnet" });
  assert.equal(run.status, 1, run.out);
  assert.ok(!/\?/.test(run.out.split("\n").find((line) => /\[Y\/n\]|\[y\/N\]/.test(line)) ?? ""), "no prompt was printed");
});

test("the interactive path is untouched: the prompts still run and still take piped answers", async () => {
  const { home, env } = box();
  const log = join(home, "argv.log");
  // Three blank answers: no auth key, then Enter at the provider-key prompt.
  const { status, out } = await runCli(["setup"], {
    ...env,
    MURAGE_TAILSCALE_BIN: tailscaleStub(home, { logFile: log, doorPort: 8813 }),
  }, { input: "\n\n\n" });
  assert.equal(status, 3, out);
  assert.match(out, /Paste a Tailscale auth key/, "the interactive key prompt is still there");
  assert.match(out, /Paste a provider API key/, "and so is the provider prompt");
  assert.match(out, /NOT secured/, out);
});
