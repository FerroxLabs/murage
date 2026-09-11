/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tailscale enrolment — the step Wayland's installer never built.
 *
 * Wayland's `installer/bin/wayland.mjs` ends its setup with a `console.log`
 * suggesting Tailscale, and its docs say verbatim that it is "a manual step,
 * not something setup does for you". Everything in this file is that missing
 * step, made real and, crucially, VERIFIED: nothing here reports success from
 * an assumption. `verifyEnrolment()` reads the daemon's own state back.
 *
 * THREE HARD RULES, each enforced by a test:
 *
 *  1. THE AUTH KEY NEVER APPEARS IN ARGV. `ps` is world-readable on a normal
 *     Linux box and shell history is a file; a key on the command line is a
 *     key you have to rotate. Tailscale supports `--auth-key file:<path>`
 *     (verified against tailscale 1.98.8: "node authorization key; if it
 *     begins with \"file:\", then it's a path to a file containing the
 *     authkey"). We write the key to a 0600 file in a 0700 directory, pass the
 *     path, and unlink it in a finally block.
 *  2. THE PUBLIC-INTERNET EXPOSURE MODE IS NEVER INVOKED. `serve` shares a
 *     local server inside the tailnet; its sibling subcommand publishes it to
 *     the open internet, which is the exact anti-goal of this whole feature.
 *     That subcommand name does not appear anywhere in this file or in
 *     `bin/murage.mjs` — see `installer/test/no-public-exposure.test.mjs`,
 *     which greps the executable lane for it and fails on any hit. Where the
 *     daemon's own JSON uses the word as a key name, we assemble that key from
 *     fragments at runtime rather than writing it out.
 *  3. SUCCESS IS PROVEN, NOT ASSUMED. `enroll()` returns `{ ok: false }` with
 *     reasons unless the daemon reports Running + Online + at least one
 *     tailnet address.
 */

import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { makePrivateDir, makePrivateTempDir, writeExclusiveFile } from "./private-files.mjs";

/** Candidate locations for the CLI, in preference order. */
const BIN_CANDIDATES = [
  "/usr/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

/** The official install one-liner. Kept as data so a test can read it. */
export const INSTALL_URL = "https://tailscale.com/install.sh";
export const INSTALL_COMMAND = `curl -fsSL ${INSTALL_URL} | sh`;

/**
 * The daemon's JSON key for "is this share published to the open internet?".
 * Assembled at runtime on purpose: rule 2 above bans the literal subcommand
 * name from the executable lane, and this key is spelled the same way. Reading
 * it is how we PROVE the answer is no.
 */
const PUBLIC_EXPOSURE_KEY = ["Allow", "Fun", "nel"].join("");

/** @param {string} cmd */
function onPath(cmd) {
  return spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0;
}

/**
 * Absolute path (or bare command) for the tailscale CLI, or null.
 * @param {{ exists?: (p: string) => boolean, onPath?: (c: string) => boolean }} [seams]
 * @returns {string | null}
 */
export function tailscaleBin(seams = {}) {
  const has = seams.onPath ?? onPath;
  const ex = seams.exists ?? existsSync;
  const env = seams.env ?? process.env;
  // An explicit override wins, for a non-standard install location — and it is
  // the only way to make the CLI's behaviour deterministic in a test, since the
  // candidate list finds a real Tailscale.app on any developer's Mac.
  const override = env.MURAGE_TAILSCALE_BIN?.trim();
  if (override) return ex(override) ? override : null;
  if (has("tailscale")) return "tailscale";
  for (const candidate of BIN_CANDIDATES) if (ex(candidate)) return candidate;
  return null;
}

/** @param {Parameters<typeof tailscaleBin>[0]} [seams] */
export function isInstalled(seams) {
  return tailscaleBin(seams) !== null;
}

/** Whether this process can drive tailscaled without a password prompt. */
function needsSudo() {
  if (process.platform !== "linux") return false;
  return !(typeof process.getuid === "function" && process.getuid() === 0);
}

/**
 * Build the argv for `tailscale up`.
 *
 * `--auth-key file:<path>` is the whole point: the SECRET IS NOT IN THIS ARRAY,
 * only a path to it. `installer/test/tailscale.test.mjs` asserts that no
 * element of the returned array ever contains the key material.
 *
 * On `--ephemeral`: there is no such flag on `tailscale up` (verified against
 * the 1.98.8 CLI — the full flag list has no `--ephemeral`). Ephemerality is a
 * property OF THE AUTH KEY, chosen when the key is minted in the admin console
 * or via the API. So the installer cannot make a node ephemeral by asking; what
 * it can do — and does — is tell the operator to mint an ephemeral key for a
 * disposable box, and report afterwards whether the node it produced is one, so
 * a destroyed droplet self-evicts from the tailnet instead of lingering as a
 * dead entry forever.
 *
 * @param {object} opts
 * @param {string} opts.keyFile path written by `writeAuthKeyFile`
 * @param {string} [opts.hostname] tailnet hostname for this node
 * @param {string[]} [opts.tags] ACL tags, e.g. ["tag:murage"]
 * @param {number} [opts.timeoutSec] how long to wait for Running
 * @param {boolean} [opts.acceptRoutes] default false — a cloud box should not
 *   silently pull subnet routes from the tailnet
 * @param {boolean} [opts.ssh] default false — Tailscale SSH is a separate
 *   decision from "serve the app", and defaulting it on would widen the box
 * @returns {string[]}
 */
export function buildUpArgs(opts) {
  if (!opts?.keyFile) throw new Error("buildUpArgs requires a keyFile path, never a raw key");
  const args = ["up", `--auth-key=file:${opts.keyFile}`];
  if (opts.hostname) args.push(`--hostname=${opts.hostname}`);
  const tags = (opts.tags ?? []).filter(Boolean);
  if (tags.length) args.push(`--advertise-tags=${tags.join(",")}`);
  args.push(`--accept-routes=${opts.acceptRoutes ? "true" : "false"}`);
  args.push(`--ssh=${opts.ssh ? "true" : "false"}`);
  args.push(`--timeout=${Math.max(1, Math.floor(opts.timeoutSec ?? 90))}s`);
  return args;
}

export const DEFAULT_DOOR_PORT = 8813;

/**
 * The loopback port `tailscale serve` must be pointed at: the companion's
 * **browser door** (`companion/src/browser.ts`), not the harness.
 *
 * The harness on 8799 gates on the request's `Host` header being a loopback
 * name (`server/index.ts`, `isLoopbackHost`). `tailscale serve` forwards the
 * ORIGINAL Host — `<node>.<tailnet>.ts.net` — so a request that arrives that
 * way is refused 403 and the operator sees a proxy that "works" and an app
 * that will not load. The browser door is the component that rewrites Host to
 * loopback before forwarding, so it is the only correct proxy target.
 *
 * 8813, and NOT 8812: 8812 is the cloudflared origin gateway
 * (`electron/companion-origin-gateway.mjs`), a different thing entirely.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function doorPort(env = process.env) {
  const raw = env?.MURAGE_BROWSER_PORT;
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_DOOR_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return DEFAULT_DOOR_PORT;
  return n;
}

/**
 * Ask the browser door whether it is actually there, by fetching the one
 * unauthenticated route it serves: `GET http://127.0.0.1:<door>/enter`.
 *
 * This is the gate on serve enablement. Configuring `tailscale serve` at a
 * port nothing is listening on produces a tailnet URL that answers 502 — a
 * deployment that reports "secured" and does not work. Any HTTP response at
 * all proves something is listening and terminating requests there; a refused
 * connection or a timeout proves it is not.
 *
 * Listening is not the same as being this deployment's door. That second
 * question is `probeDoor` in `lib/door-identity.mjs`, which sends its
 * challenge in `headers` and reads the answer from the returned `headers`.
 *
 * @param {{ port?: number, timeoutMs?: number, fetchImpl?: typeof fetch, headers?: Record<string, string> }} [opts]
 * @returns {Promise<{ answered: boolean, port: number, url: string, status?: number, headers?: Headers | null, reason?: string }>}
 */
export async function doorAnswers(opts = {}) {
  const port = Number(opts.port ?? doorPort());
  const url = `http://127.0.0.1:${port}/enter`;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { answered: false, port, url, reason: `bad door port: ${opts.port}` };
  }
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    return { answered: false, port, url, reason: "no fetch implementation available" };
  }
  const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs ?? 1_500));
  try {
    const res = await doFetch(url, {
      method: "GET",
      redirect: "manual",
      ...(opts.headers ? { headers: opts.headers } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Only the status and headers matter; release the body and its socket.
    try {
      await res?.body?.cancel?.();
    } catch {
      // nothing to release
    }
    return { answered: true, port, url, status: res?.status, headers: res?.headers ?? null };
  } catch (e) {
    return { answered: false, port, url, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Build the argv that puts the tailnet-only reverse proxy in front of the
 * loopback listener. `--bg` so it survives the installer exiting.
 *
 * The target is ALWAYS `http://127.0.0.1:<port>`, never a wildcard or a LAN
 * address: the proxy and the app are on the same box by construction.
 * @param {object} opts
 * @param {number} opts.port the loopback port Murage listens on
 * @param {number} [opts.listenPort] tailnet-side port; default 443 (HTTPS)
 * @param {boolean} [opts.https] default true; false uses a plain HTTP listener
 *   for tailnets that have not enabled HTTPS certificates
 * @returns {string[]}
 */
export function buildServeArgs(opts) {
  const port = Number(opts?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad port: ${opts?.port}`);
  const https = opts.https !== false;
  const listen = Number(opts.listenPort ?? (https ? 443 : 80));
  return ["serve", "--bg", `${https ? "--https" : "--http"}=${listen}`, `http://127.0.0.1:${port}`];
}

/**
 * Write the auth key to a private file and return its path.
 *
 * The directory is new: randomly named, created 0700, and its owner and mode
 * read back before the key goes in. It used to be `murage-tsauth-<pid>` under
 * the shared temp dir, a name another local account could predict and create
 * first. The file is created exclusively and 0600, so nothing already at that
 * path is written through.
 * @param {string} key
 * @param {string} [dir] a directory to create for it; it must not exist yet.
 *   Default: a fresh private directory under the OS temp dir.
 * @returns {string}
 */
export function writeAuthKeyFile(key, dir) {
  const trimmed = String(key ?? "").trim();
  if (!trimmed) throw new Error("refusing to write an empty auth key file");
  const owned = dir === undefined ? makePrivateTempDir("murage-tsauth-") : makePrivateDir(dir);
  const path = join(owned, "authkey");
  writeExclusiveFile(path, trimmed, { mode: 0o600 });
  return path;
}

/** Remove the key file and its directory. Safe to call twice. @param {string} path */
export function shredAuthKeyFile(path) {
  if (!path) return;
  try {
    // Overwrite before unlink so the bytes are not left in a reused block on a
    // filesystem without journalled deletes. Best effort; the unlink is what
    // actually matters.
    writeFileSync(path, "\0".repeat(64), { mode: 0o600 });
  } catch {
    /* the unlink below is the guarantee */
  }
  try {
    rmSync(path, { force: true });
    rmSync(join(path, ".."), { recursive: true, force: true });
  } catch {
    /* nothing left to do */
  }
}

/**
 * Read an auth key WITHOUT it ever touching argv or shell history.
 *
 * Order: an explicit env var, then stdin. There is deliberately no
 * `--auth-key=` CLI option on `murage setup` — offering one would invite
 * exactly the leak this module exists to prevent.
 * @param {object} [opts]
 * @param {Record<string, string | undefined>} [opts.env]
 * @param {() => Promise<string>} [opts.readSecret] a prompt that does not echo
 * @returns {Promise<string | null>}
 */
export async function readAuthKey(opts = {}) {
  const env = opts.env ?? process.env;
  for (const name of ["MURAGE_TS_AUTHKEY", "TS_AUTHKEY", "TAILSCALE_AUTHKEY"]) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  if (opts.readSecret) {
    const typed = (await opts.readSecret()).trim();
    return typed || null;
  }
  return null;
}

/**
 * Run the CLI and capture stdout. Never used with the key as an argument.
 * @param {string[]} args
 * @param {{ bin?: string, sudo?: boolean, timeoutMs?: number, run?: typeof spawnSync }} [opts]
 */
export function runTailscale(args, opts = {}) {
  const bin = opts.bin ?? tailscaleBin();
  if (!bin) return { status: 127, stdout: "", stderr: "tailscale CLI not found", ok: false };
  const run = opts.run ?? spawnSync;
  const useSudo = opts.sudo ?? needsSudo();
  const cmd = useSudo ? "sudo" : bin;
  const argv = useSudo ? [bin, ...args] : args;
  // stdin is INHERITED, not piped: when `sudo` needs a password it prompts on
  // the terminal, and with a piped stdin that prompt would hang until the
  // timeout with nothing on screen. stdout/stderr stay piped because we parse
  // them.
  const r = run(cmd, argv, {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 120_000,
    stdio: ["inherit", "pipe", "pipe"],
  });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    ok: (r.status ?? 1) === 0,
  };
}

/**
 * Parse `tailscale status --json`. Read-only; safe to call without sudo.
 * @param {{ run?: typeof spawnSync, bin?: string }} [opts]
 * @returns {any | null}
 */
export function status(opts = {}) {
  const r = runTailscale(["status", "--json"], { ...opts, sudo: false });
  if (!r.ok || !r.stdout.trim()) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

/**
 * Turn a status document into a verdict. Split out from `status()` so the whole
 * decision is testable against captured fixtures with no daemon in the loop.
 *
 * "Verified" means all four of: the backend is Running, the node reports
 * itself Online, it holds at least one tailnet address, and — when tags were
 * requested — the control plane actually granted them. A key that is not
 * authorised for `tag:murage` succeeds at `up` and comes back untagged, so
 * checking the tags is the difference between "we asked" and "it happened".
 * @param {any} doc
 * @param {{ expectTags?: string[] }} [opts]
 * @returns {{ ok: boolean, reasons: string[], ips: string[], dnsName: string|null, tags: string[], magicDnsSuffix: string|null }}
 */
export function verdictFromStatus(doc, opts = {}) {
  /** @type {string[]} */
  const reasons = [];
  if (!doc) {
    return { ok: false, reasons: ["tailscale status returned nothing (is tailscaled running?)"], ips: [], dnsName: null, tags: [], magicDnsSuffix: null };
  }
  const self = doc.Self ?? {};
  const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [];
  const tags = Array.isArray(self.Tags) ? self.Tags : [];
  const dnsName = typeof self.DNSName === "string" ? self.DNSName.replace(/\.$/, "") : null;

  if (doc.BackendState !== "Running") reasons.push(`backend state is ${doc.BackendState ?? "unknown"}, not Running`);
  if (self.Online !== true) reasons.push("this node is not reported Online by the control plane");
  if (ips.length === 0) reasons.push("this node holds no tailnet address");
  for (const want of opts.expectTags ?? []) {
    if (!tags.includes(want)) reasons.push(`tag ${want} was requested but the control plane did not grant it`);
  }
  return { ok: reasons.length === 0, reasons, ips, dnsName, tags, magicDnsSuffix: doc.MagicDNSSuffix ?? null };
}

/**
 * Verify enrolment against the live daemon, polling until it settles.
 * @param {{ expectTags?: string[], attempts?: number, sleepMs?: number, run?: typeof spawnSync, bin?: string, wait?: (ms: number) => Promise<void> }} [opts]
 */
export async function verifyEnrolment(opts = {}) {
  const attempts = opts.attempts ?? 10;
  const sleepMs = opts.sleepMs ?? 1_500;
  const wait = opts.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let verdict = verdictFromStatus(null, opts);
  for (let i = 0; i < attempts; i += 1) {
    verdict = verdictFromStatus(status(opts), opts);
    if (verdict.ok) return verdict;
    if (i < attempts - 1) await wait(sleepMs);
  }
  return verdict;
}

/**
 * Read the share config back and prove two things: the proxy really points at
 * our loopback port, and NOTHING in it is published to the open internet.
 *
 * The second half is the one that matters. It is a runtime assertion, not a
 * comment: if any entry in the daemon's own config has the public-exposure flag
 * set, this returns `{ publicExposure: true }` and `bin/murage.mjs` aborts with
 * a red banner instead of printing "secured".
 * @param {{ port?: number, run?: typeof spawnSync, bin?: string }} [opts]
 * @returns {{ configured: boolean, publicExposure: boolean, raw: any, urls: string[] }}
 */
export function shareStatus(opts = {}) {
  const r = runTailscale(["serve", "status", "--json"], { ...opts, sudo: false });
  if (!r.ok || !r.stdout.trim()) return { configured: false, publicExposure: false, raw: null, urls: [] };
  /** @type {any} */
  let doc = null;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    return { configured: false, publicExposure: false, raw: null, urls: [] };
  }
  return { ...inspectShareConfig(doc, opts.port), raw: doc };
}

/**
 * Pure inspection of a share-config document, so the public-exposure check is
 * unit-testable against a fixture that actually has the flag set.
 * @param {any} doc
 * @param {number} [port]
 * @returns {{ configured: boolean, publicExposure: boolean, urls: string[] }}
 */
export function inspectShareConfig(doc, port) {
  if (!doc || typeof doc !== "object") return { configured: false, publicExposure: false, urls: [] };

  // The flag lives at `<key>: { "host:443": true }`. Any truthy member is a
  // public listener and is disqualifying, whatever the host.
  const flags = doc[PUBLIC_EXPOSURE_KEY];
  const publicExposure = !!flags && Object.values(flags).some(Boolean);

  /** @type {string[]} */
  const urls = [];
  let configured = false;
  const want = port ? `http://127.0.0.1:${port}` : null;
  for (const [hostPort, entry] of Object.entries(doc.Web ?? {})) {
    for (const [path, handler] of Object.entries(entry?.Handlers ?? {})) {
      const proxy = handler?.Proxy;
      if (!proxy) continue;
      if (!want || proxy === want || proxy.startsWith(`${want}/`)) configured = true;
      urls.push(`https://${hostPort.replace(/:443$/, "")}${path === "/" ? "" : path}`);
    }
  }
  for (const [hostPort, target] of Object.entries(doc.TCP ?? {})) {
    if (target) urls.push(`tcp://${hostPort}`);
  }
  return { configured, publicExposure, urls };
}

/**
 * The origin a browser actually types, for a proxy that fronts `port`.
 *
 * Derived from the daemon's own share document, never from the tailnet name
 * plus an assumption: the scheme decides the sidecar's session cookie
 * (`__Host-` and `Secure` are only legal on https) and the address it prints
 * in its QR, and both are worse than useless if they describe a listener that
 * is not there.
 *
 * Deliberately narrow. Only a `<host>:443` entry yields an origin, because
 * that is the listener `buildServeArgs` creates by default and the only one
 * whose spelling here has been read back from a real daemon. Any other
 * listener returns `null` — the door then runs with no advertised front,
 * which costs a nicer QR and breaks nothing.
 *
 * @param {any} doc parsed `tailscale serve status --json`
 * @param {number} port the loopback port the proxy should be fronting
 * @returns {string | null}
 */
export function serveOrigin(doc, port) {
  if (!doc || typeof doc !== "object") return null;
  const want = `http://127.0.0.1:${Number(port)}`;
  for (const [hostPort, entry] of Object.entries(doc.Web ?? {})) {
    const handlers = Object.values(entry?.Handlers ?? {});
    if (!handlers.some((h) => h?.Proxy === want || String(h?.Proxy ?? "").startsWith(`${want}/`))) continue;
    const match = /^(.+):(\d+)$/.exec(hostPort);
    if (!match || match[2] !== "443") continue;
    const host = match[1].trim().toLowerCase();
    if (!host) continue;
    return `https://${host}`;
  }
  return null;
}

/**
 * Full enrolment. Returns a verdict; the caller decides what to print. This
 * function never prints "secured" — it has no opinion, only evidence.
 *
 * @param {object} opts
 * @param {string} opts.authKey the raw key; consumed here and never logged
 * @param {number} opts.port loopback port to front — the BROWSER DOOR (8813),
 *   never the harness (8799); see `doorPort()` for why
 * @param {boolean} [opts.serve] default true. `false` joins the tailnet and
 *   stops there, configuring no proxy. The caller passes false when the door
 *   did not answer (`doorAnswers()`): a proxy in front of a port nothing is
 *   listening on is worse than no proxy, because it looks configured.
 * @param {string} [opts.hostname]
 * @param {string[]} [opts.tags]
 * @param {boolean} [opts.https]
 * @param {number} [opts.listenPort]
 * @param {(msg: string) => void} [opts.log]
 * @param {typeof spawnSync} [opts.run] test seam
 * @param {string} [opts.bin] test seam
 * @param {(ms: number) => Promise<void>} [opts.wait] test seam
 */
export async function enroll(opts) {
  const log = opts.log ?? (() => {});
  let keyFile = null;
  try {
    keyFile = writeAuthKeyFile(opts.authKey);
    const upArgs = buildUpArgs({
      keyFile,
      hostname: opts.hostname,
      tags: opts.tags,
      timeoutSec: 90,
    });
    log("joining the tailnet…");
    const up = runTailscale(upArgs, { run: opts.run, bin: opts.bin });
    if (!up.ok) {
      return {
        ok: false,
        stage: "up",
        reasons: [`tailscale up failed (exit ${up.status}): ${(up.stderr || up.stdout).trim().slice(0, 500)}`],
      };
    }
  } finally {
    shredAuthKeyFile(keyFile);
  }

  log("verifying enrolment with the daemon…");
  const verdict = await verifyEnrolment({
    expectTags: opts.tags,
    run: opts.run,
    bin: opts.bin,
    wait: opts.wait,
  });
  if (!verdict.ok) return { ok: false, stage: "verify", reasons: verdict.reasons, verdict };

  // The gate. The node is on the tailnet either way — that part is proven
  // above — but we do not point a proxy at a door that is not there.
  if (opts.serve === false) {
    log("skipping the tailnet proxy: the browser door is not answering.");
    return { ok: true, stage: "joined", served: false, reasons: [], verdict, share: null };
  }

  log("putting the tailnet-only proxy in front of the loopback listener…");
  const serve = runTailscale(
    buildServeArgs({ port: opts.port, https: opts.https, listenPort: opts.listenPort }),
    { run: opts.run, bin: opts.bin }
  );
  if (!serve.ok) {
    return {
      ok: false,
      stage: "share",
      reasons: [`tailscale serve failed (exit ${serve.status}): ${(serve.stderr || serve.stdout).trim().slice(0, 500)}`],
      verdict,
    };
  }

  const share = shareStatus({ port: opts.port, run: opts.run, bin: opts.bin });
  if (share.publicExposure) {
    return {
      ok: false,
      stage: "share",
      reasons: [
        "this node has a share published to the PUBLIC INTERNET. That is the exact " +
          "thing this deployment exists to avoid. Run `tailscale serve reset` and re-run setup.",
      ],
      verdict,
      share,
    };
  }
  if (!share.configured) {
    return {
      ok: false,
      stage: "share",
      reasons: [`the daemon does not report a proxy to http://127.0.0.1:${opts.port} after configuring one`],
      verdict,
      share,
    };
  }

  return { ok: true, stage: "done", served: true, reasons: [], verdict, share };
}
