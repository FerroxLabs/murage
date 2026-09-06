/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * The sidecar, for a box with no Electron on it.
 *
 * On the desktop, `electron/companion.mjs` forks `companion/src/index.ts` and
 * hands it the ports and the bind mode. On a headless cloud box there is no
 * Electron to do that, and until this file existed nothing did: `murage setup`
 * probed `http://127.0.0.1:8813/enter`, found nothing listening — because
 * nothing ever starts it — declined to configure the tailnet proxy, and the
 * box finished "secured" with no way in at all. `murage start` ran the harness
 * and only the harness.
 *
 * So this is `electron/companion.mjs`'s fork environment, minus the parts that
 * only make sense inside a desktop app:
 *
 *   - `MURAGE_COMPANION_INTERNAL_ORIGIN` is NOT set. That is the UDS the
 *     Electron main process allocates and owns (`companion/src/origin.ts`
 *     accepts only the exact shape Electron mints); there is no Electron here,
 *     and `companion/src/index.ts:430` binds it only when both it and the
 *     managed origin exist. Absent is the correct value, not a missing one.
 *   - `MURAGE_COMPANION_HOSTED_URL` is NOT set, and is stripped if inherited.
 *     It advertises a managed cloud route the desktop verifies before passing;
 *     nothing here has verified anything, so nothing here may claim it.
 *
 * and plus the two bind modes the desktop leaves at their defaults, one per
 * door, because on a headless box neither default is right:
 *
 *   - `MURAGE_BROWSER_BIND=loopback`, unconditionally. `tailscale serve`
 *     connects to `http://127.0.0.1:<door>`; a door that took the desktop's
 *     `auto` preference and bound the tailnet address instead has nothing
 *     listening where serve dials, and serve answers 502 while every local
 *     probe calls the door healthy. On this deployment serve is the ONLY way
 *     in, so loopback is not a preference to weigh — it is the arrangement.
 *   - `MURAGE_COMPANION_BIND=off`, unconditionally. That is the DEVICE door
 *     (8810), and its default is `0.0.0.0` on purpose — a phone pairs against
 *     this machine's LAN address, and that is the desktop product's headline
 *     feature. A rented cloud box has no such LAN: the same `0.0.0.0` there is
 *     the public internet minus a security-group rule, and there is no phone
 *     on it to pair. So the feature the wide bind exists for cannot happen
 *     here, and the exposure it costs is the one thing this deployment claims
 *     it does not have.
 *
 *     `off` rather than `loopback` because absent is a stronger claim than
 *     bound-but-local, and this is the deployment that should be making the
 *     stronger one: `loopback` still means a listener, an allowlist, and a
 *     token check that any local process — or anything that gets a request
 *     proxied to 127.0.0.1 — can reach for. Nothing on this box dials 8810,
 *     so nothing is given up. `companion/src/index.ts` handles `off` by
 *     binding no device socket at all while still bringing up the control
 *     page (8811) and the browser door (8813), which are the two this
 *     deployment actually uses.
 *
 *     Spelling matters more than usual: `companion/src/index.ts` REFUSES TO
 *     START on a value that is not one of `lan`, `loopback`, `tailnet`, `off`,
 *     precisely so a typo in a security control cannot resolve outward to the
 *     `0.0.0.0` default.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Poll interval and budget for "is the door up yet". */
export const DOOR_WAIT_ATTEMPTS = 40;
export const DOOR_WAIT_SLEEP_MS = 250;

/**
 * Where the sidecar actually is, and the Node flags it needs.
 *
 * Same packaged/built/source ladder as `electron/companion-entry.mjs`, for the
 * same reason it is pure there: the failure mode is silent. `execArgv` travels
 * with the entry because the two are one decision — the TypeScript source
 * without `--experimental-strip-types` is a SyntaxError at spawn.
 *
 * @param {string} installerRoot
 * @param {string} repoRoot
 * @param {(p: string) => boolean} [exists]
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ entry: string, execArgv: string[], kind: string } | null}
 */
export function resolveCompanionEntry(installerRoot, repoRoot, exists = existsSync, env = process.env) {
  const override = env?.MURAGE_COMPANION_ENTRY?.trim();
  const candidates = [
    override && {
      entry: override,
      execArgv: override.endsWith(".ts") ? ["--experimental-strip-types"] : [],
      kind: "MURAGE_COMPANION_ENTRY",
    },
    { entry: join(installerRoot, "payload", "companion", "index.js"), execArgv: [], kind: "packaged payload" },
    { entry: join(repoRoot, "dist-companion", "index.js"), execArgv: [], kind: "repo build (pnpm build:companion)" },
    {
      entry: join(repoRoot, "companion", "src", "index.ts"),
      execArgv: ["--experimental-strip-types"],
      kind: "repo source (type-stripped)",
    },
  ].filter(Boolean);
  for (const candidate of candidates) if (exists(candidate.entry)) return candidate;
  return null;
}

/**
 * The environment the sidecar is started with.
 *
 * Built by copying a base and then OVERWRITING the seven names this deployment
 * owns, rather than by filling in blanks: an inherited `MURAGE_BROWSER_BIND`,
 * an inherited `MURAGE_COMPANION_BIND`, or a stale
 * `MURAGE_BROWSER_PUBLIC_ORIGIN` left over from another run would otherwise
 * decide where this box's doors bind and which origin they claim, and all of
 * those are this file's answer to give.
 *
 * @param {object} opts
 * @param {Record<string, string|undefined>} [opts.base] usually `process.env`
 * @param {number} opts.harnessPort the loopback harness (8799)
 * @param {number} opts.doorPort the browser door (8813)
 * @param {string} opts.dataDir
 * @param {string|null} [opts.publicOrigin] the origin `tailscale serve`
 *   actually answers on, when one was VERIFIED to be configured. It decides
 *   the session cookie (`__Host-` + `Secure` on https) and the QR the door
 *   prints, so it is passed only when the proxy is known to be there.
 * @returns {Record<string, string>}
 */
export function companionEnv(opts) {
  const base = { ...(opts.base ?? {}) };
  // Electron-owned, and meaningless — worse, misleading — without Electron.
  delete base.MURAGE_COMPANION_INTERNAL_ORIGIN;
  delete base.MURAGE_COMPANION_HOSTED_URL;

  const origin = typeof opts.publicOrigin === "string" ? opts.publicOrigin.trim() : "";
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = String(v);
  out.MURAGE_PORT = String(opts.harnessPort);
  out.MURAGE_BROWSER_PORT = String(opts.doorPort);
  // Neither of these is negotiable here; see the header. The device door is
  // closed outright rather than narrowed, because on this box there is no
  // phone to pair and `0.0.0.0` is the public internet.
  out.MURAGE_BROWSER_BIND = "loopback";
  out.MURAGE_COMPANION_BIND = "off";
  out.MURAGE_BROWSER_SCHEME = origin.startsWith("https://") ? "https" : "http";
  out.MURAGE_BROWSER_PUBLIC_ORIGIN = origin;
  // `companion/src/state.ts` defaults this to `~/.murage-companion`. The
  // staged systemd unit sets `ProtectHome=read-only`, so a sidecar left on
  // the default would fail its first write under the unit and nowhere else —
  // the worst place for a difference between "works when I run it" and
  // "works at boot". Kept inside the data dir the unit already grants.
  out.MURAGE_COMPANION_DIR = opts.dataDir ? join(opts.dataDir, "companion") : out.MURAGE_COMPANION_DIR;
  if (!out.MURAGE_COMPANION_DIR) delete out.MURAGE_COMPANION_DIR;
  return out;
}

/**
 * Wait for the browser door to answer, or give up and say so. Never throws.
 * @param {object} opts
 * @param {() => Promise<{ answered: boolean, reason?: string }>} opts.probe
 * @param {() => boolean} [opts.alive] false once the child has exited
 * @param {number} [opts.attempts]
 * @param {number} [opts.sleepMs]
 * @param {(ms: number) => Promise<void>} [opts.wait]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ up: boolean, reason?: string }>}
 */
export async function waitForDoor(opts) {
  const attempts = Math.max(1, Math.floor(opts.attempts ?? DOOR_WAIT_ATTEMPTS));
  const sleepMs = Math.max(0, Math.floor(opts.sleepMs ?? DOOR_WAIT_SLEEP_MS));
  const wait = opts.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let reason = "the browser door never answered";
  for (let i = 0; i < attempts; i += 1) {
    if (opts.signal?.aborted) return { up: false, reason: "door startup cancelled" };
    if (opts.alive && !opts.alive()) return { up: false, reason: "the sidecar exited before its door came up" };
    const r = await opts.probe();
    if (opts.signal?.aborted) return { up: false, reason: "door startup cancelled" };
    if (r.answered) return { up: true };
    reason = r.reason ?? reason;
    if (i < attempts - 1) await wait(sleepMs);
  }
  return { up: false, reason };
}

/**
 * Spawn the sidecar. Returns the child and a `stop()` that actually waits for
 * it to be gone — a `kill()` that returns before the process has released 8813
 * makes the next start race a socket that is still held, which is exactly the
 * failure this deployment cannot afford to have look like "the door is down".
 *
 * @param {object} opts
 * @param {{ entry: string, execArgv: string[] }} opts.resolved
 * @param {Record<string, string>} opts.env
 * @param {"inherit"|"ignore"|"pipe"} [opts.stdio]
 * @param {typeof spawn} [opts.spawnImpl] test seam
 * @returns {{ child: import("node:child_process").ChildProcess, alive: () => boolean, stop: () => Promise<void> }}
 */
export function spawnCompanion(opts) {
  const run = opts.spawnImpl ?? spawn;
  const child = run(process.execPath, [...opts.resolved.execArgv, opts.resolved.entry], {
    env: opts.env,
    stdio: opts.stdio ?? "inherit",
  });
  return ownChild(child);
}

/** Own a child immediately, including failed spawns. Stop is idempotent and
 * resolves on observed exit, never merely because a signal was sent. */
export function ownChild(child, { graceMs = 5_000, killWaitMs = 1_000 } = {}) {
  let exited = child.exitCode !== null || child.signalCode !== null;
  child.on("exit", () => { exited = true; });
  // A failed spawn emits error instead of exit. Install this listener before
  // returning so it cannot become an uncaught launcher error.
  child.on("error", () => { if (!child.pid) exited = true; });
  let stopping;
  const stop = (signal = "SIGTERM") => {
    if (stopping) return stopping;
    if (exited) return Promise.resolve();
    stopping = new Promise((resolve, reject) => {
      let escalation;
      let deadline;
      const finish = (error) => {
        clearTimeout(escalation); clearTimeout(deadline);
        child.off("exit", onExit); child.off("error", onError);
        if (error) reject(error); else resolve();
      };
      const onExit = () => finish();
      const onError = error => finish(child.pid ? error : undefined);
      child.once("exit", onExit); child.once("error", onError);
      escalation = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch (error) { finish(error); return; }
        deadline = setTimeout(() => finish(new Error(`child ${child.pid} did not exit after SIGKILL`)), killWaitMs);
      }, graceMs);
      try { child.kill(signal); } catch (error) { finish(error); }
    });
    return stopping;
  };
  return { child, alive: () => !exited, stop };
}

/** A bounded, abortable read-only startup command. No shell and no inherited
 * output pipes: a slow Tailscale status must not block signal processing. */
export async function startupProbe(command, args, { env, signal, timeoutMs = 3_000 } = {}) {
  if (signal?.aborted) return null;
  const owned = ownChild(spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] }), { graceMs: 250 });
  const { child } = owned;
  return new Promise((resolve, reject) => {
    let output = "";
    let cancelled = false;
    let finished = false;
    let timer;
    const finish = (value, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (error) reject(error); else resolve(value);
    };
    const cancel = () => {
      cancelled = true;
      void owned.stop().then(() => finish(null), error => finish(null, error));
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      output += chunk;
      if (Buffer.byteLength(output) > 512 * 1024) { child.stdout.pause(); cancel(); }
    });
    child.stderr.resume();
    child.once("error", () => finish(null));
    child.once("close", code => finish(!cancelled && code === 0 ? output : null));
    timer = setTimeout(cancel, timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
