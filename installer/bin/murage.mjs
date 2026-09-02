#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * `murage` — deploy Murage's headless server to a cloud box so that it is
 * reachable ONLY over your Tailscale tailnet, and never from the internet.
 *
 *   murage setup      join the tailnet, wire a provider key, front the app
 *   murage start      run the server (refuses any bind that is not loopback
 *                     or this host's own tailnet address)
 *   murage status     what is actually true right now, verified, not assumed
 *   murage resetpass  break-glass admin reset, if this build has one
 *   murage help
 *
 * The shape of `setup`/`start`/`resetpass` and the scriptable-readline trick
 * come from Wayland's shipped `getwayland` installer, which proved the UX. The
 * network posture is deliberately the opposite of Wayland's — see
 * docs/plans/cloud-deploy/PLAN.md, "What we did differently, and why".
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BindRefused, resolveBindFromEnv } from "../lib/bind.mjs";
import { envFilePermissions, readEnvFile, writeEnvFile } from "../lib/env-file.mjs";
import { tailnetAddresses } from "../lib/network-trust.mjs";
import { stageUnit } from "../lib/systemd.mjs";
import * as ts from "../lib/tailscale.mjs";
import { ask, askSecret, c, closeRl, confirm, fail, heading, ok, qrBlock, warn } from "../lib/ui.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALLER_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(INSTALLER_ROOT, "..");

const DATA_DIR = process.env.MURAGE_DATA_DIR || join(homedir(), ".murage-server");
const ENV_FILE = process.env.MURAGE_ENV_FILE || join(DATA_DIR, "murage.env");
const DEFAULT_PORT = 8799;
const DEFAULT_TAG = "tag:murage";

/** Provider env names Murage's own config recognises (server/config.ts). */
const PROVIDER_ENV = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  xai: "XAI_API_KEY",
};

// ── payload resolution ────────────────────────────────────────────────────

/**
 * Where the bundled server actually is. Checked in order; the first that exists
 * wins. A packaged npm tarball carries `payload/`; a repo checkout has
 * `dist-server/` after `pnpm build:server`.
 * @returns {{ entry: string, kind: string } | null}
 */
export function resolveServerEntry(root = INSTALLER_ROOT, repo = REPO_ROOT, exists = existsSync) {
  const candidates = [
    process.env.MURAGE_SERVER_ENTRY && { entry: process.env.MURAGE_SERVER_ENTRY, kind: "MURAGE_SERVER_ENTRY" },
    { entry: join(root, "payload", "server", "index.js"), kind: "packaged payload" },
    { entry: join(root, "payload", "index.js"), kind: "packaged payload" },
    { entry: join(repo, "dist-server", "index.js"), kind: "repo build (pnpm build:server)" },
    { entry: join(repo, "dist-server", "server", "index.js"), kind: "repo build (pnpm build:server)" },
  ].filter(Boolean);
  for (const candidate of candidates) if (exists(candidate.entry)) return candidate;
  return null;
}

/**
 * Does this server build understand an explicit bind address?
 *
 * Asked rather than assumed: as of Murage 0.1.44 the listener is
 * `server.listen(PORT, "127.0.0.1")` with the address hardcoded, so tailnet
 * bind mode is not yet honourable and `start` must say so instead of quietly
 * binding loopback while the operator believes otherwise.
 * @param {string} entry
 * @returns {boolean}
 */
export function serverSupportsBindAddress(entry, read = readFileSync) {
  try {
    return String(read(entry, "utf8")).includes("MURAGE_BIND_ADDRESS");
  } catch {
    return false;
  }
}

/** @param {string} entry @returns {boolean} */
export function serverSupportsResetPass(entry, read = readFileSync) {
  try {
    return String(read(entry, "utf8")).includes("--resetpass");
  } catch {
    return false;
  }
}

// ── prerequisites ─────────────────────────────────────────────────────────

function has(cmd) {
  return spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0;
}

function aptInstall(packages, label) {
  if (!has("apt-get")) return false;
  const root = typeof process.getuid === "function" && process.getuid() === 0;
  const sudo = root ? "" : "sudo ";
  console.log(c.dim(`  Installing ${label}…`));
  const r = spawnSync(
    "bash",
    ["-c", `${sudo}apt-get update -qq >/dev/null 2>&1; ${sudo}apt-get install -y -qq ${packages.join(" ")} >/dev/null 2>&1`],
    { stdio: "inherit" }
  );
  return (r.status ?? 1) === 0;
}

/** Node major version this server bundle needs. */
const MIN_NODE_MAJOR = 20;
const RECOMMENDED_NODE_MAJOR = 24;

function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < MIN_NODE_MAJOR) {
    fail(`node ${process.versions.node} is too old; Murage's server needs node ${MIN_NODE_MAJOR}+.`);
    return false;
  }
  if (major < RECOMMENDED_NODE_MAJOR) {
    warn(`node ${process.versions.node}; the app targets node ${RECOMMENDED_NODE_MAJOR}+. It should run, but that is the tested version.`);
  }
  return true;
}

// ── tailscale enrolment ───────────────────────────────────────────────────

async function ensureTailscaleInstalled() {
  if (ts.isInstalled()) {
    ok("tailscale is installed");
    return true;
  }
  console.log(c.dim("\n  Tailscale is not installed. It is what keeps this box off the public internet."));
  if (!(await confirm("  Install Tailscale now?", true))) {
    fail("Skipped. Without Tailscale this deployment has no secure path in — setup will not claim otherwise.");
    return false;
  }
  if (process.platform !== "linux") {
    fail(`Automatic install is Linux-only here. Install Tailscale for ${process.platform} from https://tailscale.com/download, then re-run setup.`);
    return false;
  }
  if (!has("curl")) aptInstall(["curl"], "curl");
  console.log(c.dim(`  Running: ${ts.INSTALL_COMMAND}`));
  const r = spawnSync("bash", ["-c", ts.INSTALL_COMMAND], { stdio: "inherit" });
  if ((r.status ?? 1) !== 0 || !ts.isInstalled()) {
    fail("Tailscale install failed. Install it manually (https://tailscale.com/download) and re-run setup.");
    return false;
  }
  ok("tailscale installed");
  return true;
}

/**
 * Prompt for and apply the tailnet enrolment.
 * @returns {Promise<{ ok: boolean, verdict?: any, share?: any, reasons?: string[] }>}
 */
async function enrolTailnet(port) {
  const already = ts.verdictFromStatus(ts.status());
  if (already.ok) {
    ok(`already on the tailnet as ${c.b(already.dnsName ?? already.ips[0])}`);
    if (!(await confirm("  Re-run enrolment with a new auth key?", false))) {
      return { ok: true, verdict: already, reenrolled: false };
    }
  }

  console.log(c.dim("\n  Paste a Tailscale auth key. Mint one at:"));
  console.log(c.dim(`    ${c.o("https://login.tailscale.com/admin/settings/keys")}`));
  console.log(c.dim("  For a disposable cloud box choose an EPHEMERAL key: the node then evicts"));
  console.log(c.dim("  itself from your tailnet when the box is destroyed, instead of lingering"));
  console.log(c.dim("  forever as a dead entry. (Ephemeral is a property of the KEY — there is no"));
  console.log(c.dim("   `tailscale up` flag for it, so setup cannot choose it for you.)"));
  console.log(c.dim("  The key is read without echo and written to a 0600 file; it is never passed"));
  console.log(c.dim("  as a command-line argument, so it cannot leak via `ps` or shell history.\n"));

  const authKey = await ts.readAuthKey({ readSecret: () => askSecret("  Tailscale auth key: ") });
  if (!authKey) {
    fail("No auth key given. Setup will not report this box as secured.");
    return { ok: false, reasons: ["no auth key supplied"] };
  }

  const tagAnswer = await ask(`  ACL tag to advertise [${DEFAULT_TAG}, or "none"]: `);
  const tagChoice = (tagAnswer || DEFAULT_TAG).trim();
  const tags = tagChoice.toLowerCase() === "none" ? [] : [tagChoice.startsWith("tag:") ? tagChoice : `tag:${tagChoice}`];
  const hostname = (await ask("  Tailnet hostname for this box [leave blank for the OS hostname]: ")) || undefined;
  const https = await confirm("  Front it with HTTPS on the tailnet? (needs HTTPS certificates enabled for your tailnet)", true);

  const result = await ts.enroll({
    authKey,
    port,
    tags,
    hostname,
    https,
    log: (m) => console.log(c.dim(`  ${m}`)),
  });
  return result;
}

// ── commands ──────────────────────────────────────────────────────────────

async function setup() {
  heading("Murage — headless cloud deploy (tailnet only)");

  const found = resolveServerEntry();
  if (!found) {
    fail("Server payload not found.");
    console.log(c.dim("  In a repo checkout: pnpm build:server"));
    console.log(c.dim("  From npm: reinstall the package, or set MURAGE_SERVER_ENTRY=/path/to/index.js"));
    process.exit(1);
  }
  ok(`server payload: ${c.dim(found.entry)} (${found.kind})`);
  if (!checkNode()) process.exit(1);

  const port = Number(process.env.MURAGE_PORT || DEFAULT_PORT);

  // 1. Tailscale FIRST. Everything after it depends on knowing whether this box
  //    has a secure path in, and there is no point wiring a provider key into a
  //    box we are about to tell the operator not to trust.
  const installed = await ensureTailscaleInstalled();
  let enrolment = { ok: false, reasons: ["tailscale not installed"] };
  if (installed) enrolment = await enrolTailnet(port);

  // 2. Provider key.
  console.log("");
  const entry = await askSecret("  Paste a provider API key (Anthropic / OpenAI / Gemini / xAI), or Enter to skip: ");
  /** @type {Record<string,string>} */
  const providerEnv = {};
  if (entry) {
    let name = null;
    if (/^sk-ant-/i.test(entry)) name = PROVIDER_ENV.anthropic;
    else if (/^AIza/.test(entry)) name = PROVIDER_ENV.gemini;
    else if (/^xai-/i.test(entry)) name = PROVIDER_ENV.xai;
    else if (/^sk-/i.test(entry)) name = PROVIDER_ENV.openai;
    if (!name) {
      const which = (await ask("  Which provider is this key for? [anthropic/openai/gemini/xai] ")).toLowerCase();
      name = PROVIDER_ENV[which] ?? null;
    }
    if (name) providerEnv[name] = entry;
    else warn("Unrecognised provider — skipping the key. Re-run setup to add one.");
  }

  // 3. Env file. Note what is NOT here: no ALLOW_REMOTE, no HOST, nothing that
  //    can produce a wildcard bind. MURAGE_BIND_MODE=loopback is the whole
  //    statement about reachability.
  const bag = {
    MURAGE_DATA_DIR: DATA_DIR,
    MURAGE_PORT: String(port),
    MURAGE_BIND_MODE: "loopback",
    NODE_ENV: "production",
    ...providerEnv,
  };
  // `tailscale serve` is a same-host reverse proxy: verified on a live tailnet,
  // a request through it reaches the app with remoteAddress AND localAddress
  // both 127.0.0.1. So under serve, "the peer is loopback" no longer means "the
  // human at the console" — declare the proxy so no trust check reads it that way.
  if (enrolment.ok) bag.MURAGE_TRUSTED_PROXY = "1";
  writeEnvFile(ENV_FILE, bag);
  ok(`wrote ${c.dim(ENV_FILE)} (mode 0600)`);

  // 4. Report — honestly.
  console.log("");
  if (enrolment.ok) {
    const v = enrolment.verdict;
    const url = v?.dnsName ? `https://${v.dnsName}` : null;
    ok(c.g("This box is on your tailnet and is NOT reachable from the internet."));
    console.log(`      tailnet name : ${c.b(v?.dnsName ?? "?")}`);
    console.log(`      tailnet ips  : ${c.dim((v?.ips ?? []).join(", "))}`);
    console.log(`      acl tags     : ${c.dim((v?.tags ?? []).join(", ") || "(none)")}`);
    console.log(`      listener     : ${c.dim(`127.0.0.1:${port}`)} fronted by the tailnet proxy`);
    console.log(`      public share : ${c.g("none")}`);
    if (url) {
      console.log(`\n  Open it from any device on your tailnet:\n    ${c.o(url)}\n`);
      printQr(url);
    }
  } else {
    fail(c.r("This box is NOT secured. Setup will not pretend otherwise."));
    for (const reason of enrolment.reasons ?? []) console.log(`      ${c.dim("- " + reason)}`);
    console.log(c.dim("\n  The server will still start, but it binds 127.0.0.1 only — so until"));
    console.log(c.dim("  Tailscale is enrolled, the only way in is an SSH tunnel:"));
    console.log(c.dim(`    ssh -N -L ${port}:127.0.0.1:${port} <user>@<this-box>`));
  }

  await maybeSystemd(enrolment.ok);

  console.log(c.b("\n  Next:"));
  console.log(`    ${c.o("murage start")}     ${c.dim("# run it (foreground)")}`);
  console.log(`    ${c.o("murage status")}    ${c.dim("# verify the posture at any time")}\n`);
  closeRl();

  // Exit non-zero when the box was NOT secured, even though setup otherwise
  // completed. A provisioning script that pipes answers into `murage setup`
  // has to be able to tell "deployed and on the tailnet" from "deployed and
  // reachable only through an SSH tunnel", and a green exit code for both
  // would be the same lie as a green banner.
  if (!enrolment.ok) process.exit(SETUP_NOT_SECURED);
}

/** `murage setup` finished, but the box is not on the tailnet. */
export const SETUP_NOT_SECURED = 3;

function printQr(url) {
  const block = qrBlock(url);
  if (block) {
    console.log(block);
    return;
  }
  console.log(c.dim("  (install `qrencode` for a scannable QR here: sudo apt-get install -y qrencode)"));
  console.log(c.dim("  Remember: the phone must be signed into the same tailnet to open that URL."));
}

async function maybeSystemd(tailscaleConfigured) {
  if (process.platform !== "linux") return false;
  if (!(await confirm("\n  Stage a systemd unit so it runs 24/7 and restarts on reboot?", false))) return false;
  try {
    const staged = stageUnit({
      execPath: process.execPath,
      cliPath: fileURLToPath(import.meta.url),
      dataDir: DATA_DIR,
      envFile: ENV_FILE,
      tailscale: tailscaleConfigured,
    });
    console.log(c.dim(`\n  Unit staged at ${staged.stagedPath}. Review it, then run:`));
    for (const cmd of staged.commands) console.log(`    ${cmd}`);
    return true;
  } catch (e) {
    fail(`could not stage the unit: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * Compute the start decision without side effects, so it is testable.
 * @param {Record<string,string|undefined>} env
 * @param {{ entry: string, supportsBindAddress: boolean }} server
 * @returns {{ go: true, address: string, mode: string, port: number } | { go: false, error: string, code: string }}
 */
export function planStart(env, server) {
  const cannotBindTailnet = {
    go: false,
    code: "SERVER_CANNOT_BIND_TAILNET",
    error:
      "MURAGE_BIND_MODE=tailnet, but this server build hardcodes its listener to 127.0.0.1 " +
      "and does not read MURAGE_BIND_ADDRESS. Refusing to start and let you believe the app " +
      "is on your tailnet address when it is not. Use MURAGE_BIND_MODE=loopback with " +
      "`tailscale serve` in front (that is the supported path), or update the server.",
  };

  let bind;
  try {
    bind = resolveBindFromEnv(env);
  } catch (e) {
    if (!(e instanceof BindRefused)) throw e;
    // A host with no tailnet address AND a server that could not use one anyway
    // has two reasons to refuse. Report the one the operator can act on: no
    // amount of `tailscale up` makes this build bind a tailnet address. Without
    // this, the message you get depends on whether the box happens to be
    // enrolled — which is how a Linux box and a macOS box disagreed here.
    if (e.code === "NO_TAILNET_ADDRESS" && !server.supportsBindAddress) return cannotBindTailnet;
    return { go: false, error: e.message, code: e.code };
  }
  if (bind.mode === "tailnet" && !server.supportsBindAddress) return cannotBindTailnet;
  const port = Number(env.MURAGE_PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { go: false, code: "BAD_PORT", error: `invalid MURAGE_PORT: ${env.MURAGE_PORT}` };
  }
  return { go: true, address: bind.address, mode: bind.mode, port };
}

function start() {
  const found = resolveServerEntry();
  if (!found) {
    fail("Server payload not found. Run `murage setup`, or set MURAGE_SERVER_ENTRY.");
    process.exit(1);
  }
  const env = { ...process.env, ...readEnvFile(ENV_FILE) };
  const plan = planStart(env, {
    entry: found.entry,
    supportsBindAddress: serverSupportsBindAddress(found.entry),
  });
  if (!plan.go) {
    fail(plan.error);
    process.exit(1);
  }

  env.MURAGE_DATA_DIR = env.MURAGE_DATA_DIR || DATA_DIR;
  env.MURAGE_PORT = String(plan.port);
  env.MURAGE_BIND_ADDRESS = plan.address;
  env.MURAGE_BIND_MODE = plan.mode;
  env.NODE_ENV = env.NODE_ENV || "production";

  console.log(c.dim(`  binding ${plan.address}:${plan.port} (${plan.mode})`));
  const args = found.entry.endsWith(".ts") ? ["--experimental-strip-types", found.entry] : [found.entry];
  const child = spawn(process.execPath, args, { env, stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
}

function status() {
  heading("Murage — deployment status");

  const perms = envFilePermissions(ENV_FILE);
  if (!perms.exists) warn(`no env file at ${ENV_FILE} — run \`murage setup\``);
  else if (!perms.private) fail(`${ENV_FILE} is mode 0${perms.mode.toString(8)} — it holds API keys and must be 0600`);
  else ok(`env file ${c.dim(ENV_FILE)} is 0600`);

  const env = { ...process.env, ...readEnvFile(ENV_FILE) };
  try {
    const bind = resolveBindFromEnv(env);
    ok(`bind policy: ${c.b(`${bind.address}`)} (${bind.mode}) — ${bind.reason}`);
  } catch (e) {
    fail(`bind policy REFUSES to start: ${e instanceof Error ? e.message : String(e)}`);
  }

  const addrs = [...tailnetAddresses()];
  if (addrs.length) ok(`this host holds tailnet addresses: ${c.dim(addrs.join(", "))}`);
  else warn("this host holds no tailnet address (network-trust probe)");

  if (!ts.isInstalled()) {
    fail("tailscale is not installed — there is no secure path into this box");
    return;
  }
  const verdict = ts.verdictFromStatus(ts.status());
  if (verdict.ok) {
    ok(`tailnet: ${c.b(verdict.dnsName ?? "?")} ${c.dim(verdict.ips.join(", "))}`);
    if (verdict.tags.length) ok(`acl tags: ${c.dim(verdict.tags.join(", "))}`);
  } else {
    fail("tailnet enrolment NOT verified:");
    for (const r of verdict.reasons) console.log(`      ${c.dim("- " + r)}`);
  }

  const port = Number(env.MURAGE_PORT || DEFAULT_PORT);
  const share = ts.shareStatus({ port });
  if (share.publicExposure) {
    fail(c.r("A SHARE ON THIS NODE IS PUBLISHED TO THE PUBLIC INTERNET. Run `tailscale serve reset`."));
  } else if (share.configured) {
    ok(`tailnet-only proxy is fronting 127.0.0.1:${port}${share.urls.length ? c.dim(` → ${share.urls.join(", ")}`) : ""}`);
    ok("no public share on this node");
  } else {
    warn(`no tailnet proxy in front of 127.0.0.1:${port} — re-run \`murage setup\``);
  }
  console.log("");
}

function resetpass() {
  const found = resolveServerEntry();
  if (!found) {
    fail("Server payload not found.");
    process.exit(1);
  }
  if (!serverSupportsResetPass(found.entry)) {
    heading("murage resetpass");
    fail("This Murage server build has no password authentication to reset.");
    console.log(c.dim("  Murage's harness ships no admin login: it was written as a loopback server"));
    console.log(c.dim("  for the desktop app, and access control is the network, not a password."));
    console.log(c.dim("  On this deployment the boundary is therefore, in order:"));
    console.log(c.dim("    1. the listener binds 127.0.0.1 only;"));
    console.log(c.dim("    2. only the tailnet proxy can reach it;"));
    console.log(c.dim("    3. your tailnet ACL decides who reaches the proxy."));
    console.log(c.dim("\n  To revoke access, revoke it there — remove the device or tighten the ACL:"));
    console.log(`    ${c.o("https://login.tailscale.com/admin/machines")}`);
    console.log(c.dim("  To evict this box from the tailnet right now:"));
    console.log(`    ${c.o("sudo tailscale logout")}\n`);
    process.exit(2);
  }
  const env = { ...process.env, ...readEnvFile(ENV_FILE) };
  env.MURAGE_DATA_DIR = env.MURAGE_DATA_DIR || DATA_DIR;
  const child = spawn(process.execPath, [found.entry, "--resetpass", ...process.argv.slice(3)], {
    env,
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

function help() {
  console.log(`
  ${c.o("murage")} — deploy Murage's headless server, reachable only over your tailnet

  ${c.b("murage setup")}       Join the tailnet, wire a provider key, front the app, verify it
  ${c.b("murage start")}       Run the server (refuses any non-loopback, non-tailnet bind)
  ${c.b("murage status")}      Verify the posture: bind policy, enrolment, no public share
  ${c.b("murage resetpass")}   Break-glass admin reset, if this build has one
  ${c.b("murage help")}        This message

  Data dir : ${c.dim(DATA_DIR)}   ${c.dim("(override with MURAGE_DATA_DIR)")}
  Env file : ${c.dim(ENV_FILE)}   ${c.dim("(0600)")}

  ${c.dim("The auth key is never taken as a CLI argument. Pass it on the prompt, or")}
  ${c.dim("in MURAGE_TS_AUTHKEY / TS_AUTHKEY for an unattended install.")}
`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cmd = (process.argv[2] || "help").toLowerCase();
  if (cmd === "setup") await setup();
  else if (cmd === "start") start();
  else if (cmd === "status") status();
  else if (cmd === "resetpass" || cmd === "reset-password") resetpass();
  else if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    try {
      console.log(JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version);
    } catch {
      console.log("unknown");
    }
  } else help();
}
