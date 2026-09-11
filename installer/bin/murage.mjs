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
import { createDoorNonce, deploymentOwner, doorVersion, probeDoor, readDoorNonce, writeDoorNonce } from "../lib/door-identity.mjs";
import { envFilePermissions, inspectEnvFile, readEnvFile, retainRecoveryCopy, writeEnvFile } from "../lib/env-file.mjs";
import { tailnetAddresses } from "../lib/network-trust.mjs";
import { NotPlainFile, asAccount } from "../lib/private-files.mjs";
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
import { ask, askSecret, c, closeRl, confirm, fail, heading, ok, qrBlock, refuseInteractivePrompts, warn } from "../lib/ui.mjs";
import {
  EXIT,
  PROVIDER_ENV,
  inferProviderEnvName,
  isUnattended,
  readAllStdin,
  resolveUnattendedPlan,
  splitUnattendedArgs,
} from "../lib/unattended.mjs";

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

/**
 * The oldest Node this installer runs the server on, whatever a manifest says:
 * the server imports `node:sqlite`, and the shipped package requires 24. This
 * used to be 20, with a warning that 20–23 "should run"; they cannot.
 */
export const RUNTIME_FLOOR = Object.freeze([24, 0, 0]);

/** `>=X[.Y[.Z]]` or `^X[.Y[.Z]]`, the only engine spellings trusted here. */
function parseNodeFloor(range) {
  const m = /^\s*(?:>=|\^)\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(String(range));
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The Node requirement of the server this installer would run: read from the
 * distributed manifest (the payload's first, then the package's, then a
 * checkout's), and never below RUNTIME_FLOOR. Never inferred from source text.
 * @returns {{ min: readonly number[], range: string, source: string }}
 */
export function runtimeRequirement(installerRoot = INSTALLER_ROOT, repoRoot = REPO_ROOT, read = readFileSync) {
  const floor = { min: RUNTIME_FLOOR, range: `>=${RUNTIME_FLOOR.join(".")}`, source: "this installer (the server needs node:sqlite)" };
  for (const path of [join(installerRoot, "payload", "package.json"), join(installerRoot, "package.json"), join(repoRoot, "package.json")]) {
    let range;
    try {
      range = JSON.parse(String(read(path, "utf8")))?.engines?.node;
    } catch {
      continue;
    }
    if (typeof range !== "string") continue;
    const min = parseNodeFloor(range);
    if (!min || compareVersions(min, RUNTIME_FLOOR) < 0) return floor;
    return { min, range: range.trim(), source: path };
  }
  return floor;
}

/**
 * Can this runtime run that server? Checked by `setup` and by `start` before
 * either does anything else.
 * @param {string} nodeVersion e.g. `process.versions.node`
 * @param {ReturnType<typeof runtimeRequirement>} requirement
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function runtimePreflight(nodeVersion, requirement) {
  const have = String(nodeVersion).replace(/^v/, "").split(".").slice(0, 3).map((part) => Number.parseInt(part, 10));
  if (have.length === 0 || have.some((n) => !Number.isInteger(n))) {
    return { ok: false, reason: `could not read the node version (${nodeVersion}); ${requirement.source} requires node ${requirement.range}.` };
  }
  if (compareVersions(have, requirement.min) >= 0) return { ok: true };
  return { ok: false, reason: `node ${nodeVersion} cannot run this Murage server: ${requirement.source} requires node ${requirement.range}.` };
}

/** This installer's version, recorded with the door identity. */
export function installerVersion(installerRoot = INSTALLER_ROOT, repoRoot = REPO_ROOT, read = readFileSync) {
  for (const path of [join(installerRoot, "package.json"), join(repoRoot, "package.json")]) {
    try {
      const version = JSON.parse(String(read(path, "utf8")))?.version;
      if (typeof version === "string" && version.trim()) return version.trim();
    } catch {
      // the next candidate
    }
  }
  return "unknown";
}

/** Sent with the door identity, so a door started by another installer version is not adopted. */
const INSTALLER_VERSION = doorVersion(installerVersion());

function checkNode() {
  const verdict = runtimePreflight(process.versions.node, runtimeRequirement());
  if (verdict.ok) return true;
  fail(verdict.reason);
  console.log(c.dim("  Install node 24 or newer and re-run with it. Nothing has been changed."));
  return false;
}

// ── tailscale enrolment ───────────────────────────────────────────────────

/** @param {UnattendedPlan | null} plan */
async function ensureTailscaleInstalled(plan) {
  if (ts.isInstalled()) {
    ok("tailscale is installed");
    return true;
  }
  console.log(c.dim("\n  Tailscale is not installed. It is what keeps this box off the public internet."));
  if (!(plan ? plan.installTailscale : await confirm("  Install Tailscale now?", true))) {
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
 * @param {number} [harnessPort]
 * @param {UnattendedPlan | null} [plan] the answers an unattended run supplied
 *   ahead of time; null for an interactive run, which asks instead.
 * @returns {Promise<{ ok: boolean, served?: boolean, verdict?: any, share?: any, reasons?: string[] }>}
 */
async function enrolTailnet(ctx, port = DOOR_PORT, harnessPort = DEFAULT_PORT, plan = null) {
  const already = ts.verdictFromStatus(ts.status());
  if (already.ok) {
    ok(`already on the tailnet as ${c.b(already.dnsName ?? already.ips[0])}`);
    if (!(plan ? plan.reenroll : await confirm("  Re-run enrolment with a new auth key?", false))) {
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
      return { ...(await frontTheDoor(ctx, port, harnessPort, plan)), verdict: already, reenrolled: false };
    }
  }

  if (plan) {
    // The source, never the key. A path or an environment variable NAME is not
    // a secret; the bytes behind it are, and they are not printed anywhere.
    ok(`using the Tailscale auth key from ${c.dim(plan.authKeySource ?? "(none)")}`);
  } else {
    console.log(c.dim("\n  Paste a Tailscale auth key. Mint one at:"));
    console.log(c.dim(`    ${c.o("https://login.tailscale.com/admin/settings/keys")}`));
    console.log(c.dim("  For a disposable cloud box choose an EPHEMERAL key: the node then evicts"));
    console.log(c.dim("  itself from your tailnet when the box is destroyed, instead of lingering"));
    console.log(c.dim("  forever as a dead entry. (Ephemeral is a property of the KEY — there is no"));
    console.log(c.dim("   `tailscale up` flag for it, so setup cannot choose it for you.)"));
    console.log(c.dim("  The key is read without echo and written to a 0600 file; it is never passed"));
    console.log(c.dim("  as a command-line argument, so it cannot leak via `ps` or shell history.\n"));
  }

  const authKey = plan ? plan.authKey : await ts.readAuthKey({ readSecret: () => askSecret("  Tailscale auth key: ") });
  if (!authKey) {
    fail("No auth key given. Setup will not report this box as secured.");
    return { ok: false, reasons: ["no auth key supplied"] };
  }

  const tagAnswer = plan ? (plan.tag ?? "") : await ask(`  ACL tag to advertise [${DEFAULT_TAG}, or "none"]: `);
  const tagChoice = (tagAnswer || DEFAULT_TAG).trim();
  const tags = tagChoice.toLowerCase() === "none" ? [] : [tagChoice.startsWith("tag:") ? tagChoice : `tag:${tagChoice}`];
  const hostname = plan
    ? (plan.hostname ?? undefined)
    : (await ask("  Tailnet hostname for this box [leave blank for the OS hostname]: ")) || undefined;

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
    https = plan
      ? plan.https
      : await confirm("  Front it with HTTPS on the tailnet? (needs HTTPS certificates enabled for your tailnet)", true);
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
  // Answering is not enough. The listener has to prove it is the door the
  // last `murage start` here started (lib/door-identity.mjs); anything else is
  // neither adopted nor fronted, and it is never stopped.
  const euid = typeof process.geteuid === "function" ? process.geteuid() : null;
  const recorded = readDoorNonce(ctx.dataDir, { owner: ctx.account?.uid ?? euid });
  const already = await probeDoor({
    port,
    nonce: recorded.nonce,
    nonceError: recorded.error ?? undefined,
    version: INSTALLER_VERSION,
  });
  if (already.answered) {
    if (already.identity === "match" && already.ready) {
      ok(`the browser door is already answering on ${c.dim(`127.0.0.1:${port}`)}, and proved it is this deployment's door (installer ${already.doorVersion})`);
      return { up: true, started: false, stop: noop };
    }
    if (already.identity === "match") {
      warn(`this deployment's browser door answers on ${c.dim(`127.0.0.1:${port}`)} but is not ready (${already.reason}); not configuring a tailnet proxy in front of it.`);
    } else {
      fail(`something is already listening on ${c.dim(`127.0.0.1:${port}`)}, and it is not this deployment's browser door: ${already.reason}.`);
      console.log(c.dim("  Not configuring a tailnet proxy in front of it, and not stopping it: it is not setup's to stop."));
      console.log(c.dim("  If it is an older `murage start`, restart that with this installer. Otherwise free the port, or"));
      console.log(c.dim("  set MURAGE_BROWSER_PORT to one nothing else uses, and re-run setup."));
    }
    return { up: false, started: false, stop: noop };
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
  // This sidecar's own identity. Not recorded: it lives only as long as setup.
  // Waiting for its proof, not for any answer, is what tells it apart from
  // something else that took the port in the meantime.
  const ownNonce = createDoorNonce();
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
        ...companionEnv({
          base: process.env,
          harnessPort,
          doorPort: port,
          dataDir: ctx.dataDir,
          doorNonce: ownNonce,
          doorVersion: INSTALLER_VERSION,
        }),
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
      probe: async () => {
        const proof = await probeDoor({
          port,
          nonce: ownNonce,
          version: INSTALLER_VERSION,
          fetchImpl: (url, options) => fetch(url, { ...options, signal: AbortSignal.any([options.signal, startup.signal]) }),
        });
        if (proof.identity === "match" && proof.ready) return { answered: true };
        if (proof.identity === "mismatch") {
          // Not a startup delay: whatever answered is not the sidecar setup
          // started (or is a companion too old to answer the challenge).
          return { answered: false, refused: true, reason: `127.0.0.1:${port} answered, but not as the sidecar setup started: ${proof.reason}` };
        }
        return { answered: false, reason: proof.reason };
      },
    });
    waited = await waiting;
  } catch (error) {
    await stop();
    throw error;
  }
  if (!waited.up) {
    warn(`the browser door is not running: ${c.dim(already.url)} — ${waited.reason}`);
    console.log(c.dim("  Not configuring a tailnet proxy — it would point at a port nothing is"));
    console.log(c.dim("  listening on, and the tailnet URL would answer 502."));
    await stop();
    return { up: false, started: true, stop: noop };
  }
  ok(`the browser door answered on ${c.dim(`127.0.0.1:${port}`)} and proved it is the sidecar setup started`);
  return { up: true, started: true, stop };
}

/**
 * Put the tailnet proxy in front of the door on a node that is ALREADY
 * enrolled. Everything `enroll()` does after `up`, and nothing it does before.
 *
 * @param {SetupContext} ctx
 * @param {number} port the door port
 * @param {number} harnessPort
 * @param {UnattendedPlan | null} [plan]
 * @returns {Promise<{ ok: boolean, served: boolean, reasons: string[], share?: any }>}
 */
async function frontTheDoor(ctx, port, harnessPort, plan = null) {
  const brought = await bringDoorUp(ctx, port, harnessPort);
  try {
    if (!brought.up) return { ok: true, served: false, reasons: [] };
    const https = plan
      ? plan.https
      : await confirm(
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
 * @property {{ uid: number, gid: number, groups?: number[] } | null} owner who
 *   setup's files belong to, when root prepares them for another account. Setup
 *   also does that file work AS this account (`asAccount`), because it happens
 *   inside a directory the account controls.
 * @property {{ uid: number, gid: number } | null} spawnAs the account the
 *   setup-time sidecar runs as, when root acts for another account
 */

/**
 * @typedef {Awaited<ReturnType<typeof resolveUnattendedPlan>> extends { plan: infer P } ? P : never} _PlanShape
 * @typedef {{
 *   nonInteractive: true,
 *   wantTailscale: boolean,
 *   installTailscale: boolean,
 *   reenroll: boolean,
 *   https: boolean,
 *   systemd: boolean,
 *   authKey: string | null,
 *   authKeySource: string | null,
 *   tag: string | null,
 *   hostname: string | null,
 *   providerKey: string | null,
 *   providerEnvName: string | null,
 *   providerKeySource: string | null,
 * }} UnattendedPlan
 */

/**
 * Decide, before setup touches anything, which account the service runs as
 * and where its data lives. Exits 2 with the reason when it has to refuse.
 * @param {string[]} argv what is left after `splitUnattendedArgs`
 * @param {string | null} [serviceUserFromEnv] MURAGE_SERVICE_USER, used only
 *   when `--service-user` was not given — so provisioning can name the account
 *   in its environment file instead of its command line.
 * @returns {SetupContext}
 */
function resolveSetupContext(argv, serviceUserFromEnv = null) {
  const parsed = parseSetupArgs(argv);
  if (parsed.error) {
    fail(parsed.error);
    process.exit(2);
  }
  if (!parsed.serviceUser && serviceUserFromEnv) {
    const fromEnv = parseSetupArgs(["--service-user", serviceUserFromEnv]);
    if (fromEnv.error) {
      fail(fromEnv.error.replace("--service-user", "MURAGE_SERVICE_USER"));
      process.exit(2);
    }
    parsed.serviceUser = fromEnv.serviceUser;
  }
  if (process.platform !== "linux") {
    if (parsed.serviceUser) {
      fail("--service-user names the account of the systemd unit, and setup stages one on Linux only.");
      process.exit(2);
    }
    // The data directory is tightened here, once, through an fd; the env file
    // write no longer chmods whatever directory it finds (see `writeEnvFile`).
    if (process.platform !== "win32") {
      const euid = typeof process.geteuid === "function" ? process.geteuid() : null;
      const gid = typeof process.getegid === "function" ? process.getegid() : 0;
      try {
        prepareDataDir(resolve(DATA_DIR), { user: userInfo().username, uid: euid ?? 0, gid }, { euid });
      } catch (error) {
        if (!(error instanceof ServiceAccountRefused)) throw error;
        fail(error.message);
        process.exit(2);
      }
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
    return { ...paths, account, owner: forAnother && { ...forAnother, groups: account.groups }, spawnAs: forAnother };
  } catch (error) {
    if (!(error instanceof ServiceAccountRefused)) throw error;
    fail(error.message);
    process.exit(2);
  }
}

/**
 * Pull the unattended options off the command line and decide whether this run
 * is one. Exits 2 on anything wrong, before the run touches a thing.
 * @param {string[]} argv
 * @param {string} command for the "only applies with --non-interactive" message
 * @returns {{ options: Record<string, any>, rest: string[], nonInteractive: boolean }}
 */
function unattendedMode(argv, command) {
  const split = splitUnattendedArgs(argv);
  if ("error" in split) {
    fail(split.error);
    process.exit(EXIT.USAGE);
  }
  const mode = isUnattended(split.options, process.env);
  if (mode.error) {
    fail(mode.error);
    process.exit(EXIT.USAGE);
  }
  if (!mode.nonInteractive) {
    // Supplying an unattended answer but not asking for unattended mode is how
    // a provisioning run ends up blocked on a prompt with its answers already
    // in hand. Named, not ignored.
    const given = Object.keys(split.options).filter((key) => key !== "nonInteractive");
    if (given.length) {
      fail(
        `${command}: those options only apply to an unattended run. Add --non-interactive (or set ` +
          "MURAGE_NON_INTERACTIVE=1), or drop them and answer the prompts."
      );
      process.exit(EXIT.USAGE);
    }
  } else {
    // Belt and braces: from here a prompt is a bug, and must not hang.
    refuseInteractivePrompts();
  }
  return { options: split.options, rest: split.rest, nonInteractive: mode.nonInteractive };
}

/**
 * Resolve every unattended answer, or exit 2 having listed everything that is
 * missing or wrong. Runs before the first thing setup changes.
 * @param {Record<string, any>} options
 * @param {Record<string, string>} storedBag the validated current env file
 * @returns {Promise<UnattendedPlan>}
 */
async function unattendedPreflight(options, storedBag) {
  const installed = ts.isInstalled();
  const enrolled = installed ? ts.verdictFromStatus(ts.status()).ok : false;
  const resolved = await resolveUnattendedPlan({
    options,
    env: process.env,
    storedProviderKeys: Object.values(PROVIDER_ENV).filter((key) => storedBag[key]),
    tailscale: { installed, enrolled },
    readStdin: () => readAllStdin(),
  });
  if (!resolved.ok) {
    fail("this run is --non-interactive, and it cannot ask. Nothing has been changed. Still needed:");
    for (const problem of resolved.problems) console.log(`      ${c.dim("- " + problem)}`);
    console.log(c.dim("\n  `murage help` lists every unattended input and what it defaults to."));
    closeRl();
    process.exit(EXIT.USAGE);
  }
  for (const warning of resolved.warnings) warn(warning);
  return /** @type {UnattendedPlan} */ (resolved.plan);
}

async function setup(argv = []) {
  heading("Murage — headless cloud deploy (tailnet only)");

  const mode = unattendedMode(argv, "murage setup");
  const found = resolveServerEntry();
  if (!found) {
    fail("Server payload not found.");
    console.log(c.dim("  In a repo checkout: pnpm build:server"));
    console.log(c.dim("  From npm: reinstall the package, or set MURAGE_SERVER_ENTRY=/path/to/index.js"));
    process.exit(1);
  }
  ok(`server payload: ${c.dim(found.entry)} (${found.kind})`);
  if (!checkNode()) process.exit(1);
  const ctx = resolveSetupContext(mode.rest, process.env.MURAGE_SERVICE_USER?.trim() || null);

  // A rerun edits the existing env file rather than starting it over, so it is
  // read and validated before anything else happens. A file setup cannot
  // carry over whole is not rewritten at all.
  //
  // When root runs setup for the service account, every env-file operation
  // runs AS that account (`asAccount`). The file lives in a directory the
  // account owns, and the account has the whole Tailscale enrolment and key
  // prompt to swap the file or the directory for a symlink. Done as root, the
  // recovery copy would then copy /etc/shadow into a file the account can
  // read, and the write would chmod /etc. Done as the account, a redirect
  // reaches only what the account could reach anyway. The bytes checked here
  // are the bytes the recovery copy keeps; the path is not read twice.
  const current = asAccount(ctx.owner, () => inspectEnvFile(ctx.envFile, { uid: ctx.owner ? ctx.owner.uid : null }));
  if (current.problems.length) {
    fail(`setup will not rewrite ${ctx.envFile}: it could not carry every line over.`);
    for (const problem of current.problems) console.log(`      ${c.dim("- " + problem)}`);
    console.log(c.dim("  Fix or remove those lines by hand (nothing has been changed), then re-run setup."));
    process.exit(2);
  }

  const port = Number(process.env.MURAGE_PORT || current.bag.MURAGE_PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`invalid MURAGE_PORT (${process.env.MURAGE_PORT ? "from the environment" : `in ${ctx.envFile}`}); nothing has been changed.`);
    process.exit(2);
  }

  // 0. Every unattended answer, resolved and checked before the first change.
  //    Placed here rather than earlier because the provider-key requirement
  //    depends on what the existing env file already holds, and the auth-key
  //    requirement on whether this node is already enrolled — both read-only
  //    facts, both known by now, and neither of them a change to this box.
  /** @type {UnattendedPlan | null} */
  const plan = mode.nonInteractive ? await unattendedPreflight(mode.options, current.bag) : null;

  // 1. Tailscale FIRST. Everything after it depends on knowing whether this box
  //    has a secure path in, and there is no point wiring a provider key into a
  //    box we are about to tell the operator not to trust.
  const skipTailnet = Boolean(plan && !plan.wantTailscale);
  if (skipTailnet) warn("--no-tailscale: this box will NOT be enrolled, and setup will not report it as secured.");
  const installed = skipTailnet ? false : await ensureTailscaleInstalled(plan);
  let enrolment = {
    ok: false,
    reasons: [skipTailnet ? "--no-tailscale was given: this box was never enrolled" : "tailscale not installed"],
  };
  // NOTE the port: the proxy fronts the browser door, not `port` (the harness).
  if (installed) enrolment = await enrolTailnet(ctx, DOOR_PORT, port, plan);

  // 2. Provider key. Enter keeps whatever is already stored; it never clears.
  //    Unattended, "Enter" is `--no-provider-key` or simply having one already
  //    in the file — the preflight refused the run if neither was true, so a
  //    provisioning rerun keeps the keys it wrote the first time.
  console.log("");
  const storedKeys = Object.values(PROVIDER_ENV).filter((key) => current.bag[key]);
  /** @type {Record<string,string>} */
  const providerEnv = {};
  if (plan) {
    if (plan.providerKey && plan.providerEnvName) {
      providerEnv[plan.providerEnvName] = plan.providerKey;
      ok(`provider key for ${c.b(plan.providerEnvName)}, read from ${c.dim(plan.providerKeySource ?? "?")}`);
    } else if (storedKeys.length) {
      ok(`no provider key supplied this run; keeping the stored ${storedKeys.join(", ")}`);
    } else {
      warn("no provider API key (--no-provider-key): the server has no model to call until one is added.");
    }
  } else {
    const entry = await askSecret(
      storedKeys.length
        ? `  Paste a provider API key to add or replace one (configured: ${storedKeys.join(", ")}), or Enter to keep them: `
        : "  Paste a provider API key (Anthropic / OpenAI / Gemini / xAI), or Enter to skip: "
    );
    if (entry) {
      let name = inferProviderEnvName(entry);
      if (!name) {
        const which = (await ask("  Which provider is this key for? [anthropic/openai/gemini/xai] ")).toLowerCase();
        name = PROVIDER_ENV[which] ?? null;
      }
      if (name) providerEnv[name] = entry;
      else warn(`Unrecognised provider — not stored.${storedKeys.length ? " The keys already configured are kept." : ""} Re-run setup to add one.`);
    }
  }

  // 3. Env file, merged onto the existing one (see `setupEnvBag`). Note what is
  //    NOT added here: no ALLOW_REMOTE, no HOST, nothing that can produce a
  //    wildcard bind. MURAGE_BIND_MODE=loopback is the whole statement about
  //    reachability.
  //
  // `tailscale serve` is a same-host reverse proxy: verified on a live tailnet,
  // a request through it reaches the app with remoteAddress AND localAddress
  // both 127.0.0.1. So under serve, "the peer is loopback" no longer means "the
  // human at the console" — declare the proxy so no trust check reads it that way.
  // Declared when this run verified a proxy; never withdrawn by a run that
  // could not see one (see `setupEnvBag`).
  const merged = setupEnvBag({
    existing: current.bag,
    processEnv: process.env,
    dataDir: ctx.dataDir,
    providerEnv,
    proxyVerified: Boolean(enrolment.ok && enrolment.served),
  });
  try {
    asAccount(ctx.owner, () => {
      if (merged.replaced.length) {
        const copy = retainRecoveryCopy(ctx.envFile, { owner: ctx.owner, bytes: current.bytes });
        warn(`replacing the stored ${merged.replaced.join(", ")}; the previous file is kept as ${c.dim(String(copy))} (mode 0600).`);
      }
      for (const key of merged.changed) warn(`${key} in ${ctx.envFile} is now ${merged.bag[key]}, the value this setup uses.`);
      writeEnvFile(ctx.envFile, merged.bag, { owner: ctx.owner });
    });
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error)?.code;
    if (!(error instanceof NotPlainFile) && code !== "EACCES" && code !== "EPERM") throw error;
    fail(`setup did not write ${ctx.envFile}: ${/** @type {Error} */ (error).message}`);
    console.log(c.dim("  The env file, if there was one, is unchanged. Fix that path, then re-run setup."));
    process.exit(2);
  }
  const carried = Object.keys(current.bag).length;
  ok(`wrote ${c.dim(ctx.envFile)} (mode 0600${current.exists ? `; ${carried} existing setting${carried === 1 ? "" : "s"} carried over` : ""})`);

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

  await maybeSystemd(ctx, enrolment.ok, plan);

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

/**
 * The env file a setup run writes, merged onto the one already there.
 *
 * A rerun used to build a fresh bag of defaults plus whatever key was typed,
 * so pressing Enter at the key prompt deleted every stored provider key and
 * every custom setting. Now:
 *
 *  - everything already in the file survives unless named below;
 *  - provider keys change only when one is entered; Enter keeps them all;
 *  - MURAGE_DATA_DIR is where this setup put the data (reported if it moved);
 *  - MURAGE_PORT keeps the stored value unless setup's own environment sets
 *    one; MURAGE_BIND_MODE keeps a valid stored value; NODE_ENV is only filled
 *    in when absent;
 *  - MURAGE_TRUSTED_PROXY is set when this run verified a proxy in front of
 *    the door, and otherwise left as it was. Removing it is the unsafe
 *    direction: without it a request arriving through a proxy that still
 *    exists reads as a loopback peer, so a run that could not see the proxy
 *    does not get to take the declaration away.
 *
 * Pure, so every one of those is testable without a tailnet.
 * @param {object} opts
 * @param {Record<string, string>} opts.existing the validated current file ({} when none)
 * @param {Record<string, string | undefined>} opts.processEnv setup's own environment
 * @param {string} opts.dataDir
 * @param {Record<string, string>} opts.providerEnv keys entered this run ({} when skipped)
 * @param {boolean} opts.proxyVerified this run verified a tailnet proxy in front of the door
 * @returns {{ bag: Record<string, string>, replaced: string[], changed: string[] }}
 */
export function setupEnvBag({ existing, processEnv, dataDir, providerEnv, proxyVerified }) {
  /** @type {Record<string, string>} */
  const bag = { ...existing };
  /** @type {string[]} */
  const changed = [];
  const select = (key, value) => {
    if (bag[key] !== undefined && bag[key] !== value) changed.push(key);
    bag[key] = value;
  };
  select("MURAGE_DATA_DIR", dataDir);
  if (processEnv.MURAGE_PORT) select("MURAGE_PORT", String(processEnv.MURAGE_PORT));
  else if (!bag.MURAGE_PORT) bag.MURAGE_PORT = String(DEFAULT_PORT);
  if (bag.MURAGE_BIND_MODE !== "loopback" && bag.MURAGE_BIND_MODE !== "tailnet") select("MURAGE_BIND_MODE", "loopback");
  if (!bag.NODE_ENV) bag.NODE_ENV = "production";
  /** @type {string[]} */
  const replaced = [];
  for (const [key, value] of Object.entries(providerEnv)) {
    if (bag[key] !== undefined && bag[key] !== value) replaced.push(key);
    bag[key] = value;
  }
  if (proxyVerified) bag.MURAGE_TRUSTED_PROXY = "1";
  return { bag, replaced, changed };
}

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
 * @param {UnattendedPlan | null} [plan]
 */
async function maybeSystemd(ctx, tailscaleConfigured, plan = null) {
  if (process.platform !== "linux" || !ctx.account) return false;
  const wanted = plan ? plan.systemd : await confirm("\n  Stage a systemd unit so it runs 24/7 and restarts on reboot?", false);
  if (!wanted) return false;
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

async function start(argv = []) {
  // `start` asks nothing — it reads the env file setup wrote and runs. The
  // flags are accepted so that one provisioning script can pass the same
  // `--non-interactive` to every subcommand, and `refuseInteractivePrompts`
  // then proves the claim rather than asserting it: if a prompt is ever added
  // here without an unattended equivalent, this run fails loudly.
  const mode = unattendedMode(argv, "murage start");
  if (mode.rest.length) {
    fail("murage start takes no arguments (the only options are --non-interactive / --yes).");
    process.exit(EXIT.USAGE);
  }
  const found = resolveServerEntry();
  if (!found) {
    fail("Server payload not found. Run `murage setup`, or set MURAGE_SERVER_ENTRY.");
    process.exit(1);
  }
  // Before anything is spawned or written: a runtime that cannot run the
  // server is a restart loop under systemd, not a start.
  if (!checkNode()) process.exit(1);
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
  // This start's door identity (lib/door-identity.mjs): recorded 0600 for
  // `setup` and `status`, handed to the sidecar only. An inherited one belongs
  // to some other start, and the harness has no use for it.
  delete env.MURAGE_DOOR_NONCE;
  delete env.MURAGE_DOOR_VERSION;
  const doorNonce = createDoorNonce();
  try {
    writeDoorNonce(env.MURAGE_DATA_DIR, doorNonce);
  } catch (error) {
    warn(`could not record the door identity in ${env.MURAGE_DATA_DIR} (${error.message}); \`murage setup\` and \`murage status\` will not recognise this door.`);
  }

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
      doorNonce,
      doorVersion: INSTALLER_VERSION,
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
      doorNonce: deps.doorNonce ?? null,
      doorVersion: deps.doorVersion ?? INSTALLER_VERSION,
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

  await reportDoor(env.MURAGE_DATA_DIR || DATA_DIR);

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
 *
 * And a third: whatever answers has to prove it is the door the last
 * `murage start` here started (lib/door-identity.mjs). An unrelated server on
 * the port is reported as exactly that, not as a healthy door.
 * @param {string} dataDir
 */
async function reportDoor(dataDir) {
  const resolved = resolveCompanionEntry(INSTALLER_ROOT, REPO_ROOT);
  if (resolved) ok(`companion sidecar present: ${c.dim(resolved.entry)} (${resolved.kind})`);
  else fail("the companion sidecar is NOT in this install — nothing can serve the browser door");

  const recorded = readDoorNonce(dataDir, { owner: deploymentOwner(dataDir) });
  const door = await probeDoor({ port: DOOR_PORT, nonce: recorded.nonce, nonceError: recorded.error ?? undefined, version: INSTALLER_VERSION });
  const where = c.dim(`127.0.0.1:${DOOR_PORT}`);
  if (!door.answered) fail(`browser door NOT answering on ${where} — ${door.reason}`);
  else if (door.identity === "match" && door.ready) {
    ok(`browser door answering on ${where} (HTTP ${door.status}), and proved it is this deployment's door (installer ${door.doorVersion})`);
  } else if (door.identity === "match") fail(`this deployment's browser door answers on ${where} but is not ready (${door.reason})`);
  else fail(`something answers on ${where} (HTTP ${door.status}), but it is NOT this deployment's browser door: ${door.reason}`);
}

/**
 * Hand the break-glass reset to the server build, if it has one.
 * @param {string[]} argv everything after `resetpass`
 */
function resetpass(argv = []) {
  // The unattended switches are consumed here, never forwarded: the server's
  // own flags are its business, and passing it options it does not know would
  // turn a reset into an argument error.
  const mode = unattendedMode(argv, "murage resetpass");
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
  // Declared to the server too, so a build that does have a password to reset
  // can refuse to prompt instead of hanging a provisioning run.
  if (mode.nonInteractive) env.MURAGE_NON_INTERACTIVE = "1";
  const child = spawn(process.execPath, [found.entry, "--resetpass", ...mode.rest], {
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

  ${c.b("Unattended setup (provisioning)")}
  ${c.dim("--non-interactive (or --yes / -y, or MURAGE_NON_INTERACTIVE=1) never prompts.")}
  ${c.dim("Anything it still needs is listed in one go and the run exits 2, changing nothing.")}

    ${c.o("--tailscale-auth-key-file <path>")}  ${c.dim("MURAGE_TAILSCALE_AUTHKEY_FILE — first line is the key")}
    ${c.o("--tailscale-auth-key-stdin")}        ${c.dim("read it from stdin instead")}
    ${c.o("--provider-key-file <path>")}        ${c.dim("MURAGE_PROVIDER_KEY_FILE")}
    ${c.o("--provider-key-stdin")}              ${c.dim("(only one secret may come from stdin)")}
    ${c.o("--provider <name>")}                 ${c.dim("MURAGE_PROVIDER: anthropic|openai|gemini|xai")}
    ${c.o("--no-provider-key")}                 ${c.dim("deploy without one (keys already in the env file are kept)")}
    ${c.o("--service-user <account>")}          ${c.dim("MURAGE_SERVICE_USER")}
    ${c.o("--tailnet-tag <tag|none>")}          ${c.dim(`MURAGE_TAILNET_TAG (default ${DEFAULT_TAG})`)}
    ${c.o("--tailnet-hostname <name>")}         ${c.dim("MURAGE_TAILNET_HOSTNAME (default: the OS hostname)")}
    ${c.o("--https / --no-https")}              ${c.dim("MURAGE_TAILNET_HTTPS (default: https)")}
    ${c.o("--install-tailscale / --no-…")}      ${c.dim("MURAGE_INSTALL_TAILSCALE (default: install)")}
    ${c.o("--reenroll / --no-reenroll")}        ${c.dim("MURAGE_TAILSCALE_REENROLL (default: keep an existing enrolment)")}
    ${c.o("--systemd / --no-systemd")}          ${c.dim("MURAGE_STAGE_SYSTEMD (default: do not stage a unit)")}
    ${c.o("--no-tailscale")}                    ${c.dim("deploy with no tailnet at all (exits 3)")}

  ${c.b("Exit codes")}
    ${c.o("0")}  ${c.dim("done, and the box is on your tailnet")}
    ${c.o("1")}  ${c.dim("this environment cannot run it (no server payload, unusable node, failed install)")}
    ${c.o("2")}  ${c.dim("the request was wrong or incomplete; nothing was changed")}
    ${c.o("3")}  ${c.dim("setup finished, but the box is NOT on the tailnet")}

  ${c.dim("A secret is never taken as a CLI argument: `ps` shows arguments to every user")}
  ${c.dim("on the box. Pass a file path or stdin, or MURAGE_TS_AUTHKEY / TS_AUTHKEY.")}
`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cmd = (process.argv[2] || "help").toLowerCase();
  if (cmd === "setup") await setup(process.argv.slice(3));
  else if (cmd === "start") await start(process.argv.slice(3));
  else if (cmd === "status") await status();
  else if (cmd === "resetpass" || cmd === "reset-password") resetpass(process.argv.slice(3));
  else if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    try {
      console.log(JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version);
    } catch {
      console.log("unknown");
    }
  } else help();
}
