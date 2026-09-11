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
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BindRefused, resolveBindFromEnv } from "../lib/bind.mjs";
import { companionEnv, ownChild, resolveCompanionEntry, spawnCompanion, startupProbe, waitForDoor } from "../lib/companion.mjs";
import { envFilePermissions, readEnvFile, writeEnvFile } from "../lib/env-file.mjs";
import { tailnetAddresses } from "../lib/network-trust.mjs";
import {
  ServiceAccountRefused,
  accountCanReach,
  chooseServiceUser,
  lookupAccount,
  parseSetupArgs,
  prepareDataDir,
  setupPaths,
} from "../lib/service-account.mjs";
import { stageUnit } from "../lib/systemd.mjs";
import * as ts from "../lib/tailscale.mjs";
import { ask, askSecret, c, closeRl, confirm, fail, heading, ok, qrBlock, warn } from "../lib/ui.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALLER_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(INSTALLER_ROOT, "..");

const DATA_DIR = process.env.MURAGE_DATA_DIR || join(homedir(), ".murage-server");
const ENV_FILE = process.env.MURAGE_ENV_FILE || join(DATA_DIR, "murage.env");
const DEFAULT_PORT = 8799;
/**
 * The port `tailscale serve` is pointed at, which is NOT `DEFAULT_PORT`.
 *
 * 8799 is the harness (`server/index.ts`). It gates on the request's `Host`
 * header being a loopback name (`isLoopbackHost`), and `tailscale serve`
 * forwards the original Host — the tailnet name — so every request through a
 * proxy aimed at 8799 comes back 403. 8813 is the companion's browser door
 * (`companion/src/browser.ts`), which rewrites Host to loopback before
 * forwarding. It is the only correct target. (Not 8812: that is the
 * cloudflared origin gateway, a different thing.)
 *
 * `DEFAULT_PORT` deliberately stays the harness port for `MURAGE_PORT`,
 * `planStart()` and the env file. Only the two serve-facing call sites — the
 * enrolment and `status` — use this one.
 */
const DOOR_PORT = ts.doorPort(process.env);
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
 * @param {SetupContext} ctx
 * @param {number} [port] the port the proxy will front — the BROWSER DOOR,
 *   not the harness. See `DOOR_PORT`.
 * @returns {Promise<{ ok: boolean, served?: boolean, verdict?: any, share?: any, reasons?: string[] }>}
 */
async function enrolTailnet(ctx, port = DOOR_PORT, harnessPort = DEFAULT_PORT) {
  const already = ts.verdictFromStatus(ts.status());
  if (already.ok) {
    ok(`already on the tailnet as ${c.b(already.dnsName ?? already.ips[0])}`);
    if (!(await confirm("  Re-run enrolment with a new auth key?", false))) {
      // `served` has to be answered even on this path, or an already-enrolled
      // box with a working proxy would be reported as having none.
      const share = ts.shareStatus({ port });
      if (share.configured && !share.publicExposure) {
        return { ok: true, verdict: already, reenrolled: false, served: true };
      }
      // Enrolled, but with no proxy in front of the door — which is exactly the
      // state a box is left in by an earlier setup that could not find a door
      // to front. Re-running setup has to be able to FIX that without demanding
      // a fresh auth key for a node that is already on the tailnet.
      return { ...(await frontTheDoor(ctx, port, harnessPort)), verdict: already, reenrolled: false };
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

  // The proxy is only offered if the thing it would front is actually there.
  // A `tailscale serve` pointed at a dead port is a tailnet URL that answers
  // 502 on a box that just told you it was secured.
  //
  // "Actually there" used to mean "somebody else started it", which on a fresh
  // cloud box is nobody: nothing in this installer had ever started the
  // sidecar, so the probe below always failed, serve was always declined, and
  // setup finished by telling the operator to start a process it gave them no
  // way to start. Now the door is brought UP for the length of setup, proven,
  // and stopped again — `murage start` is what runs it for real.
  const brought = await bringDoorUp(ctx, port, harnessPort);
  let https = false;
  if (brought.up) {
    https = await confirm("  Front it with HTTPS on the tailnet? (needs HTTPS certificates enabled for your tailnet)", true);
  }

  try {
    const result = await ts.enroll({
      authKey,
      port,
      tags,
      hostname,
      https,
      serve: brought.up,
      log: (m) => console.log(c.dim(`  ${m}`)),
    });
    return { ...result, doorStarted: brought.started };
  } finally {
    // Whatever happened above, this process does not leave a sidecar behind.
    // An orphan holding 8813 is a port collision the operator meets later, as
    // `murage start` failing for a reason that has nothing to do with them.
    await brought.stop();
  }
}

/**
 * Get the browser door answering, starting the sidecar if nothing else has.
 *
 * Returns a `stop()` in every branch, including the ones that started nothing,
 * so the caller never has to ask whether there is something to clean up.
 * @param {SetupContext} ctx
 * @param {number} port the door port
 * @param {number} harnessPort the harness the sidecar proxies to
 * @returns {Promise<{ up: boolean, started: boolean, stop: () => Promise<void> }>}
 */
async function bringDoorUp(ctx, port, harnessPort) {
  const noop = async () => {};
  const already = await ts.doorAnswers({ port });
  if (already.answered) {
    ok(`the browser door is already answering on ${c.dim(`127.0.0.1:${port}`)}`);
    return { up: true, started: false, stop: noop };
  }

  const resolved = resolveCompanionEntry(INSTALLER_ROOT, REPO_ROOT);
  if (!resolved) {
    warn(`the browser door is not running: ${c.dim(already.url)} did not answer.`);
    console.log(c.dim("  The companion sidecar is not in this install either, so setup cannot start"));
    console.log(c.dim("  it: no payload/companion/index.js, no dist-companion/index.js (pnpm"));
    console.log(c.dim("  build:companion), no companion/src/index.ts."));
    console.log(c.dim("  Not configuring a tailnet proxy — it would point at a port nothing is"));
    console.log(c.dim("  listening on, and the tailnet URL would answer 502."));
    return { up: false, started: false, stop: noop };
  }

  console.log(c.dim(`\n  Starting the companion sidecar to bring the browser door up…`));
  console.log(c.dim(`  ${resolved.entry} (${resolved.kind})`));
  announceDeviceDoorClosed();
  const startup = new AbortController();
  let sidecar;
  let waiting = Promise.resolve();
  let stopping;
  const stop = () => {
    if (stopping) return stopping;
    startup.abort();
    stopping = (async () => {
      try {
        const results = await Promise.allSettled([sidecar?.stop(), waiting]);
        const failed = results.find(result => result.status === "rejected");
        if (failed) throw failed.reason;
        console.log(c.dim(`  stopped the setup-time sidecar; \`murage start\` runs it for real.`));
      } finally {
        process.off("SIGINT", interrupted);
        process.off("SIGTERM", terminated);
      }
    })();
    return stopping;
  };
  const end = code => {
    void stop().then(() => { closeRl(); process.exit(code); }, error => {
      fail(`could not stop the setup-time sidecar: ${error.message}`);
      process.exit(1);
    });
  };
  const interrupted = () => end(130);
  const terminated = () => end(143);
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", terminated);
  let waited;
  try {
    sidecar = spawnCompanion({
      resolved,
      env: {
        ...companionEnv({ base: process.env, harnessPort, doorPort: port, dataDir: ctx.dataDir }),
        // Root acting for the service account: the sidecar runs as that
        // account, so what it writes under the data dir is that account's.
        ...(ctx.spawnAs ? { HOME: ctx.account.home, USER: ctx.account.user, LOGNAME: ctx.account.user } : {}),
      },
      stdio: "ignore",
      as: ctx.spawnAs,
    });
    sidecar.child.once("error", error => {
      if (stopping) return;
      fail(`the setup-time sidecar could not start: ${error.message}`);
      end(1);
    });
    sidecar.child.once("exit", code => {
      if (stopping) return;
      fail(`the setup-time sidecar exited unexpectedly (code ${code})`);
      end(1);
    });
    waiting = waitForDoor({
      signal: startup.signal,
      alive: sidecar.alive,
      probe: () => ts.doorAnswers({ port, fetchImpl: (url, options) => fetch(url, {
        ...options, signal: AbortSignal.any([options.signal, startup.signal]),
      }) }),
    });
    waited = await waiting;
  } catch (error) {
    await stop();
    throw error;
  }
  if (!waited.up) {
    warn(`the browser door is not running: ${c.dim(already.url)} did not answer — ${waited.reason}`);
    console.log(c.dim("  Not configuring a tailnet proxy — it would point at a port nothing is"));
    console.log(c.dim("  listening on, and the tailnet URL would answer 502."));
    await stop();
    return { up: false, started: true, stop: noop };
  }
  ok(`the browser door answered on ${c.dim(`127.0.0.1:${port}`)}`);
  return { up: true, started: true, stop };
}

/**
 * Put the tailnet proxy in front of the door on a node that is ALREADY
 * enrolled. Everything `enroll()` does after `up`, and nothing it does before.
 *
 * @param {SetupContext} ctx
 * @param {number} port the door port
 * @param {number} harnessPort
 * @returns {Promise<{ ok: boolean, served: boolean, reasons: string[], share?: any }>}
 */
async function frontTheDoor(ctx, port, harnessPort) {
  const brought = await bringDoorUp(ctx, port, harnessPort);
  try {
    if (!brought.up) return { ok: true, served: false, reasons: [] };
    const https = await confirm(
      "  Front it with HTTPS on the tailnet? (needs HTTPS certificates enabled for your tailnet)",
      true
    );
    console.log(c.dim("  putting the tailnet-only proxy in front of the loopback listener…"));
    const serve = ts.runTailscale(ts.buildServeArgs({ port, https }));
    if (!serve.ok) {
      return {
        ok: false,
        served: false,
        reasons: [`tailscale serve failed (exit ${serve.status}): ${(serve.stderr || serve.stdout).trim().slice(0, 500)}`],
      };
    }
    const share = ts.shareStatus({ port });
    if (share.publicExposure) {
      return {
        ok: false,
        served: false,
        share,
        reasons: [
          "this node has a share published to the PUBLIC INTERNET. That is the exact " +
            "thing this deployment exists to avoid. Run `tailscale serve reset` and re-run setup.",
        ],
      };
    }
    if (!share.configured) {
      return {
        ok: false,
        served: false,
        share,
        reasons: [`the daemon does not report a proxy to http://127.0.0.1:${port} after configuring one`],
      };
    }
    return { ok: true, served: true, reasons: [], share };
  } finally {
    await brought.stop();
  }
}

/**
 * Say what starting the sidecar does NOT open, before it is started.
 *
 * The sidecar's DEVICE door (8810) defaults to `0.0.0.0`, which is right on a
 * desktop — a phone pairs against the LAN address — and is the public internet
 * minus a security-group rule on a rented box. This installer used to be able
 * only to name that and hand the operator a `ufw deny`, because there was no
 * way to switch it off from out here.
 *
 * There is now: `companion/src/index.ts` reads `MURAGE_COMPANION_BIND`, and
 * `companionEnv` sets it to `off` for every sidecar this installer starts —
 * both the short-lived one in `setup` and the long-running one in `start`. So
 * the device socket is never bound at all, and there is no firewall rule to
 * get right. The control page (8811) and the browser door (8813) are unaffected
 * and still come up, which is the whole arrangement this deployment uses.
 *
 * Stated out loud rather than left silent: the operator was told to firewall
 * this port by earlier versions of this installer, and "we closed it for you"
 * is the sentence that stops them acting on stale advice.
 */
function announceDeviceDoorClosed() {
  ok(`the device door on ${c.b("8810")} is ${c.b("not opened")} — the sidecar is started with MURAGE_COMPANION_BIND=off.`);
  console.log(c.dim("  Nothing binds that port, so there is no 0.0.0.0 listener to firewall. The"));
  console.log(c.dim("  control page (8811) and the browser door (8813) still come up as normal."));
  console.log(c.dim("  Pairing a phone over the LAN is a desktop feature; a cloud box has no LAN"));
  console.log(c.dim("  to pair over, and reaching this box goes through the tailnet instead."));
}

// ── commands ──────────────────────────────────────────────────────────────

/**
 * @typedef {object} SetupContext
 * @property {string} dataDir
 * @property {string} envFile
 * @property {ReturnType<typeof lookupAccount> | null} account the account the
 *   service runs as (Linux only; null elsewhere, where no unit is staged)
 * @property {{ uid: number, gid: number } | null} owner who setup's files
 *   belong to, when root prepares them for another account
 * @property {{ uid: number, gid: number } | null} spawnAs the account the
 *   setup-time sidecar runs as, when root acts for another account
 */

/**
 * Decide, before setup touches anything, which account the service runs as
 * and where its data lives. Exits 2 with the reason when it has to refuse.
 * @param {string[]} argv
 * @returns {SetupContext}
 */
function resolveSetupContext(argv) {
  const parsed = parseSetupArgs(argv);
  if (parsed.error) {
    fail(parsed.error);
    process.exit(2);
  }
  if (process.platform !== "linux") {
    if (parsed.serviceUser) {
      fail("--service-user names the account of the systemd unit, and setup stages one on Linux only.");
      process.exit(2);
    }
    return { dataDir: DATA_DIR, envFile: ENV_FILE, account: null, owner: null, spawnAs: null };
  }
  const euid = typeof process.geteuid === "function" ? process.geteuid() : null;
  try {
    const current = userInfo();
    const chosen = chooseServiceUser({
      flag: parsed.serviceUser,
      euid,
      sudoUser: process.env.SUDO_USER,
      invokingUser: current.username,
    });
    const account = lookupAccount(chosen.name, { current });
    if (euid !== 0 && account.uid !== euid) {
      throw new ServiceAccountRefused(
        "SERVICE_USER_NEEDS_ROOT",
        `setup is running as uid ${euid}, and only root can prepare a service for ${account.user}. ` +
          `Run setup as ${account.user}, or as root with --service-user ${account.user}.`
      );
    }
    const paths = setupPaths({ env: process.env, account, euid, home: homedir() });
    prepareDataDir(paths.dataDir, account, { euid });
    ok(`service account: ${c.b(`${account.user}:${account.group}`)} (uid ${account.uid}; ${chosen.source}), home ${c.dim(account.home)}`);
    ok(`data dir: ${c.dim(paths.dataDir)} (owned by ${account.user}, 0700)`);
    const forAnother = euid === 0 && account.uid !== 0 ? { uid: account.uid, gid: account.gid } : null;
    return { ...paths, account, owner: forAnother, spawnAs: forAnother };
  } catch (error) {
    if (!(error instanceof ServiceAccountRefused)) throw error;
    fail(error.message);
    process.exit(2);
  }
}

async function setup(argv = []) {
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
  const ctx = resolveSetupContext(argv);

  const port = Number(process.env.MURAGE_PORT || DEFAULT_PORT);

  // 1. Tailscale FIRST. Everything after it depends on knowing whether this box
  //    has a secure path in, and there is no point wiring a provider key into a
  //    box we are about to tell the operator not to trust.
  const installed = await ensureTailscaleInstalled();
  let enrolment = { ok: false, reasons: ["tailscale not installed"] };
  // NOTE the port: the proxy fronts the browser door, not `port` (the harness).
  if (installed) enrolment = await enrolTailnet(ctx, DOOR_PORT, port);

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
  // Only when a proxy was actually configured. If serve was skipped because the
  // door is not up, nothing is proxying and declaring a trusted proxy would be
  // a claim about a component that is not running.
  if (enrolment.ok && enrolment.served) bag.MURAGE_TRUSTED_PROXY = "1";
  writeEnvFile(ctx.envFile, bag, { owner: ctx.owner });
  ok(`wrote ${c.dim(ctx.envFile)} (mode 0600)`);

  // 4. Report — honestly.
  console.log("");
  if (enrolment.ok) {
    const v = enrolment.verdict;
    const url = v?.dnsName ? `https://${v.dnsName}` : null;
    ok(c.g("This box is on your tailnet and is NOT reachable from the internet."));
    console.log(`      tailnet name : ${c.b(v?.dnsName ?? "?")}`);
    console.log(`      tailnet ips  : ${c.dim((v?.ips ?? []).join(", "))}`);
    console.log(`      acl tags     : ${c.dim((v?.tags ?? []).join(", ") || "(none)")}`);
    console.log(`      listener     : ${c.dim(`127.0.0.1:${port}`)} (harness)`);
    if (enrolment.served) {
      console.log(`      tailnet proxy: ${c.dim(`127.0.0.1:${DOOR_PORT}`)} (browser door)`);
    } else {
      console.log(`      tailnet proxy: ${c.r("none")} — the browser door on ${DOOR_PORT} could not be brought up`);
    }
    console.log(`      public share : ${c.g("none")}`);
    if (url && enrolment.served) {
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

  await maybeSystemd(ctx, enrolment.ok);

  console.log(c.b("\n  Next:"));
  console.log(`    ${c.o("murage start")}     ${c.dim("# run the harness AND the browser door (foreground)")}`);
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

/**
 * Offer to stage the unit, for the account `resolveSetupContext` chose.
 *
 * Before staging, checks that the account can actually run the node runtime
 * and read the installer at the paths the unit will name: a runtime under
 * root's home is a unit that fails at every boot.
 * @param {SetupContext} ctx
 * @param {boolean} tailscaleConfigured
 */
async function maybeSystemd(ctx, tailscaleConfigured) {
  if (process.platform !== "linux" || !ctx.account) return false;
  if (!(await confirm("\n  Stage a systemd unit so it runs 24/7 and restarts on reboot?", false))) return false;
  const { account } = ctx;
  const cliPath = fileURLToPath(import.meta.url);
  for (const [path, need, what] of [
    [process.execPath, 5, "run the node runtime"],
    [cliPath, 4, "read the installer"],
  ]) {
    const reach = accountCanReach(path, account, need);
    if (!reach.ok) {
      fail(`${account.user} cannot ${what} at ${path} (no access at ${reach.blockedAt}), so the unit would fail at boot. Not staging it.`);
      console.log(c.dim(`  Install node and murage somewhere ${account.user} can read, such as /usr/local or /opt, then re-run setup.`));
      return false;
    }
  }
  try {
    const staged = stageUnit({
      execPath: process.execPath,
      cliPath,
      dataDir: ctx.dataDir,
      envFile: ctx.envFile,
      tailscale: tailscaleConfigured,
      account,
    });
    console.log(`\n  The unit runs as ${c.b(`${account.user}:${account.group}`)} (uid ${account.uid}), HOME=${account.home}, data in ${ctx.dataDir}.`);
    console.log(c.dim(`  Staged privately at ${staged.stagedPath}`));
    console.log(c.dim(`  sha256 ${staged.sha256}`));
    console.log(c.dim("  Review it, then run these. The first installs it only if the staged bytes still match:"));
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

async function start() {
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
  // A headless deployment never exposes a desktop developer credential,
  // including when the operator launched it from a development shell.
  env.MURAGE_NO_DEV_DESKTOP_SECRET = "1";
  env.MURAGE_COMPANION_TOKEN = randomBytes(32).toString("hex");

  console.log(c.dim(`  binding ${plan.address}:${plan.port} (${plan.mode})`));
  const args = found.entry.endsWith(".ts") ? ["--experimental-strip-types", found.entry] : [found.entry];
  const startup = new AbortController();
  let harness;
  let sidecar;
  let starting = Promise.resolve();
  let stopping = false;
  let shuttingDown;
  const shutdown = (code, signal = "SIGTERM") => {
    if (stopping) return shuttingDown;
    stopping = true;
    startup.abort();
    shuttingDown = (async () => {
      const results = await Promise.allSettled([harness?.stop(signal), sidecar?.stop(signal), starting]);
      const failed = results.find(result => result.status === "rejected");
      if (failed) fail(`startup or shutdown failed: ${failed.reason?.message ?? failed.reason}`);
      // These are the exact owned children. Exit only after their departure
      // and the aborted startup probe have been observed.
      process.exit(failed ? 1 : code);
    })();
    return shuttingDown;
  };
  // Register before the first spawn, not after potentially slow startup work.
  process.on("SIGINT", () => { void shutdown(130, "SIGINT"); });
  process.on("SIGTERM", () => { void shutdown(143); });
  try {
    harness = ownChild(spawn(process.execPath, args, { env, stdio: "inherit" }));
    harness.child.once("error", error => {
      if (!stopping) fail(`the harness could not start: ${error.message}`);
      void shutdown(1);
    });
    harness.child.once("exit", (code) => { void shutdown(code ?? 1); });
    starting = startSidecar(env, plan.port, {
      signal: startup.signal,
      onStarted: child => { sidecar = child; },
      onError: error => {
        if (!stopping) fail(`the companion sidecar could not start: ${error.message}`);
        void shutdown(1);
      },
      onExit: code => {
        if (stopping) return;
        fail(`the companion sidecar exited (code ${code}) — taking the harness down so both restart together.`);
        void shutdown(1);
      },
    });
    await starting;
  } catch (error) {
    if (!stopping) fail(`could not start Murage: ${error.message}`);
    await shutdown(1);
  }
}

/**
 * Start the companion sidecar next to the harness, or say precisely why not.
 *
 * A missing payload is not fatal. A box with a harness and no door is degraded — reachable over
 * an SSH tunnel, not over the tailnet — and that is worth saying out loud and
 * continuing, rather than refusing to run the app at all.
 *
 * @param {Record<string,string|undefined>} env the harness's resolved env
 * @param {number} harnessPort
 * @returns {Promise<{ stop: () => Promise<void> } | null>}
 */
export async function startSidecar(env, harnessPort, deps = {}) {
  const resolve_ = deps.resolveCompanionEntry ?? resolveCompanionEntry;
  const spawn_ = deps.spawnCompanion ?? spawnCompanion;
  const front = deps.doorFront ?? doorFront;
  const log = deps.log ?? console.log;
  const say = deps.warn ?? warn;

  if (deps.signal?.aborted) return null;
  const resolved = resolve_(INSTALLER_ROOT, REPO_ROOT, existsSync, env);
  if (!resolved) {
    say("the companion sidecar is not in this install — starting the harness alone.");
    log(c.dim("  Nothing will be listening on the browser door, so the tailnet URL will 502."));
    log(c.dim("  Build it (pnpm build:companion) or set MURAGE_COMPANION_ENTRY, then restart."));
    return null;
  }
  const door = ts.doorPort(env);
  const origin = await front(door, { env, signal: deps.signal });
  if (deps.signal?.aborted) return null;
  log(c.dim(`  companion sidecar ${resolved.entry} (${resolved.kind})`));
  log(c.dim(`  browser door 127.0.0.1:${door}${origin ? ` behind ${origin}` : " (no verified proxy in front)"}`));
  // The long-running sidecar, so this is the one whose posture matters most.
  // Said here as well as in `setup` because a box that was set up months ago
  // is restarted far more often than it is set up.
  log(c.dim("  device door  not opened (MURAGE_COMPANION_BIND=off)"));
  const sidecar = spawn_({
    resolved,
    env: companionEnv({
      base: env,
      harnessPort,
      doorPort: door,
      dataDir: env.MURAGE_DATA_DIR || DATA_DIR,
      publicOrigin: origin,
    }),
    stdio: "inherit",
  });
  deps.onStarted?.(sidecar);
  if (deps.onError) sidecar.child.on("error", deps.onError);
  if (deps.onExit) sidecar.child.on("exit", (code) => deps.onExit(code));
  return sidecar;
}

/**
 * The origin the tailnet proxy actually answers on for this door, read back
 * from the daemon — or null.
 *
 * Read, not composed. Handing the sidecar an origin nobody verified is how a
 * door ends up issuing `Secure` cookies for an https listener that was never
 * configured, and printing a QR for an address that does not resolve.
 * @param {number} door
 * @returns {Promise<string | null>}
 */
async function doorFront(door, { env = process.env, signal } = {}) {
  // Resolve without spawning a synchronous `which` after the harness starts.
  const bin = ts.tailscaleBin({ env, onPath: command =>
    String(env.PATH ?? "").split(delimiter).some(path => existsSync(join(path, command))) });
  if (!bin) return null;
  const output = await startupProbe(bin, ["serve", "status", "--json"], { env, signal });
  if (!output) return null;
  let doc;
  try { doc = JSON.parse(output); } catch { return null; }
  const share = ts.inspectShareConfig(doc, door);
  if (!share.configured || share.publicExposure) return null;
  return ts.serveOrigin(doc, door);
}

async function status() {
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

  await reportDoor();

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

  // The proxy fronts the browser door, not the harness — see `DOOR_PORT`. Ask
  // about the port the proxy is supposed to point at, or a correct deployment
  // reads as unconfigured.
  const share = ts.shareStatus({ port: DOOR_PORT });
  if (share.publicExposure) {
    fail(c.r("A SHARE ON THIS NODE IS PUBLISHED TO THE PUBLIC INTERNET. Run `tailscale serve reset`."));
  } else if (share.configured) {
    ok(
      `tailnet-only proxy is fronting the browser door 127.0.0.1:${DOOR_PORT}` +
        `${share.urls.length ? c.dim(` → ${share.urls.join(", ")}`) : ""}`
    );
    ok("no public share on this node");
  } else {
    warn(`no tailnet proxy in front of the browser door 127.0.0.1:${DOOR_PORT} — re-run \`murage setup\``);
  }
  console.log("");
}

/**
 * The half of the posture the old `status` never looked at: is the thing the
 * proxy points at actually running, and is it even present on this box?
 *
 * Both questions, not one. "Not running" is a `murage start` away; "not
 * installed" is a build step away, and a status that conflated them sent
 * people to restart a process that does not exist here.
 */
async function reportDoor() {
  const resolved = resolveCompanionEntry(INSTALLER_ROOT, REPO_ROOT);
  if (resolved) ok(`companion sidecar present: ${c.dim(resolved.entry)} (${resolved.kind})`);
  else fail("the companion sidecar is NOT in this install — nothing can serve the browser door");

  const door = await ts.doorAnswers({ port: DOOR_PORT });
  if (door.answered) ok(`browser door answering on ${c.dim(`127.0.0.1:${DOOR_PORT}`)} (HTTP ${door.status})`);
  else fail(`browser door NOT answering on ${c.dim(`127.0.0.1:${DOOR_PORT}`)} — ${door.reason}`);
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
      ${c.dim("[--service-user <account>]")}  the account the systemd unit runs as; required when run as root
  ${c.b("murage start")}       Run the server and the companion sidecar (refuses any non-loopback, non-tailnet bind)
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
  if (cmd === "setup") await setup(process.argv.slice(3));
  else if (cmd === "start") await start();
  else if (cmd === "status") await status();
  else if (cmd === "resetpass" || cmd === "reset-password") resetpass();
  else if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    try {
      console.log(JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version);
    } catch {
      console.log("unknown");
    }
  } else help();
}
