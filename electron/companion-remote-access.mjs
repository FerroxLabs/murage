// `tailscale serve`, as the desktop app drives it.
//
// The browser door works without any of this: bound to the tailnet address it
// answers plain HTTP on 100.64.x.x and the MagicDNS name, over WireGuard,
// which is the encryption. That path is the fallback and it stays working.
//
// What `serve` adds is the address a person can actually use. It terminates
// TLS on 443 under the node's own certificate and proxies to the door on
// loopback, so the link becomes `https://<name>/enter#…` — no port to type,
// no certificate warning, and `Secure` cookies become available. That is the
// difference between a QR a phone opens and a QR a phone refuses.
//
// Two rules are load-bearing here and neither is negotiable:
//
//   1. `serve`, never `funnel`. Serve is tailnet-scoped: only devices signed
//      into this tailnet can reach it. Funnel is the public internet. They are
//      one word apart in the CLI and a universe apart in consequence, so the
//      funnel subcommand is not written anywhere in this file and the status
//      reader treats an existing funnel on our port as a conflict rather than
//      as something to reuse.
//
//   2. Never clobber somebody else's config. `serve` holds one config per
//      node, and `--https=443` with a different target silently replaces
//      whatever was there. If 443 already forwards somewhere that is not our
//      door, this module refuses and names the target — the user gets a
//      sentence, not a broken deployment they have to reconstruct.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/** The port `serve` terminates TLS on. 443 and nothing else: it is the only
 * port a portless `https://<name>/…` URL can mean, and the portless URL is
 * the entire reason this module exists. */
export const SERVE_PORT = 443;

/** How long the whole CLI hunt may take, across every candidate path. The
 * same budget `companion/src/listener.ts` gives its own hunt, for the same
 * reason: several candidates hang together when they hang at all. */
export const TAILSCALE_BUDGET_MS = 6000;

/** Every place the Tailscale CLI is plausibly installed, best first.
 *
 * Kept in step with `companion/src/listener.ts:tailscaleCandidates` on
 * purpose — that file finds the CLI for the sidecar, this one for the desktop
 * app, and a machine where one of them can see Tailscale and the other cannot
 * is a bug report nobody can read. Absolute paths first, bare `tailscale`
 * last: an app opened from Finder inherits `/usr/bin:/bin:/usr/sbin:/sbin`,
 * so a PATH lookup alone works in a terminal and fails in the shipped app. */
export function tailscaleCandidates(home = homedir()) {
  return [
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    join(home, "Applications", "Tailscale.app", "Contents", "MacOS", "Tailscale"),
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
    "/usr/bin/tailscale",
    "/run/current-system/sw/bin/tailscale",
    "tailscale",
  ];
}

/** PATH with the usual package-manager locations added back. */
const searchPath = () =>
  [process.env.PATH ?? "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    .filter(Boolean)
    .join(":");

/** Run one Tailscale subcommand. Resolves either way — a non-zero exit is an
 * answer with a message in it, not an exception to unwind. */
const runTailscale = (cli, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      cli,
      args,
      {
        timeout: Math.max(250, timeoutMs),
        // SIGTERM is a request; the budget is only worth what enforces it.
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, PATH: searchPath() },
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: String(stdout ?? ""),
          // Tailscale writes its refusals to stderr and its data to stdout.
          // Both are kept: `serve status --json` on an unconfigured node
          // prints nothing useful to either, and telling those cases apart
          // needs the pair.
          stderr: String(stderr ?? "") || (error ? String(error.message ?? "") : ""),
        });
      },
    );
  });

/** The CLI that answers, or null. Found once per operation rather than
 * cached: Tailscale is routinely installed while the app is already running,
 * and a cached "not installed" would outlive the install. */
export async function findTailscale({ run = runTailscale, candidates = tailscaleCandidates() } = {}) {
  const deadline = Date.now() + TAILSCALE_BUDGET_MS;
  for (const cli of candidates) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    const result = await run(cli, ["version"], left);
    if (result.ok) return cli;
  }
  return null;
}

/** What `serve status --json` says about our port, in the two words a caller
 * can act on.
 *
 * The shape, measured on 1.98:
 *
 *   {"TCP":{"443":{"HTTPS":true}},
 *    "Web":{"host:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8813"}}}},
 *    "AllowFunnel":{"host:443":true}}
 *
 * An unconfigured node prints `{}`. Anything unparseable is read as "we do not
 * know", which is not the same as "nothing is there" — a caller that treated
 * a parse failure as an empty config would overwrite the config it failed to
 * read, which is the exact accident rule 2 exists to prevent.
 *
 * Returns one of:
 *   { owner: "none" }                  — 443 is free
 *   { owner: "ours", host }            — 443 already proxies to our door
 *   { owner: "other", conflict, host } — somebody else's, with a sentence
 *   { owner: "unknown", conflict }     — could not read it; refuse to write
 */
export function readServeStatus(raw, { proxyTarget, port = SERVE_PORT } = {}) {
  const text = String(raw ?? "").trim();
  if (!text) return { owner: "none" };
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    return {
      owner: "unknown",
      conflict: "Tailscale's serve configuration could not be read, so Murage will not overwrite it.",
    };
  }
  if (!config || typeof config !== "object") return { owner: "none" };

  const suffix = `:${port}`;
  const web = config.Web && typeof config.Web === "object" ? config.Web : {};
  const entries = Object.entries(web).filter(([key]) => key.endsWith(suffix));
  if (entries.length === 0) {
    // A TCP forward on 443 with no Web handler is still somebody using the
    // port — `serve --https` would replace it.
    const tcp = config.TCP && typeof config.TCP === "object" ? config.TCP : {};
    const onPort = tcp[String(port)];
    if (onPort && typeof onPort === "object" && !onPort.HTTPS) {
      return {
        owner: "other",
        host: null,
        conflict:
          `Tailscale is already forwarding raw TCP on port ${port} on this machine. ` +
          "Murage will not replace it — turn that off first, or leave browser access on plain HTTP.",
      };
    }
    return { owner: "none" };
  }

  for (const [key, value] of entries) {
    const host = key.slice(0, -suffix.length);
    const funnel = config.AllowFunnel && typeof config.AllowFunnel === "object"
      ? config.AllowFunnel[key]
      : undefined;
    if (funnel === true) {
      // Funnel is the public internet. Never adopted, never quietly turned
      // off: it was somebody's deliberate act and it is not ours to reverse.
      return {
        owner: "other",
        host,
        conflict:
          `Tailscale Funnel is switched on for ${key}, which publishes it to the public internet. ` +
          "Murage only ever serves to your own tailnet and will not touch a Funnel you set up — " +
          "turn Funnel off for that port first.",
      };
    }
    const handlers = value && typeof value === "object" && value.Handlers && typeof value.Handlers === "object"
      ? value.Handlers
      : {};
    const mounts = Object.entries(handlers);
    const root = mounts.find(([mount]) => mount === "/");
    const ours = root && typeof root[1]?.Proxy === "string" && sameTarget(root[1].Proxy, proxyTarget);
    if (ours && mounts.length === 1) return { owner: "ours", host };
    const described = mounts.length === 0
      ? "something with no handler"
      : mounts
          .map(([mount, handler]) => `${mount} → ${describeHandler(handler)}`)
          .join(", ");
    return {
      owner: "other",
      host,
      conflict:
        `Tailscale is already serving ${key} (${described}) on this machine. ` +
        "Murage will not overwrite a serve configuration it did not create — " +
        `run \`tailscale serve --https=${port} off\` yourself if you want Murage to take it over.`,
    };
  }
  return { owner: "none" };
}

const describeHandler = (handler) => {
  if (!handler || typeof handler !== "object") return "an unreadable handler";
  if (typeof handler.Proxy === "string") return `proxy ${handler.Proxy}`;
  if (typeof handler.Path === "string") return `files from ${handler.Path}`;
  if (typeof handler.Text === "string") return "static text";
  return "an unrecognised handler";
};

/** Whether two proxy targets are the same place.
 *
 * `serve` normalises what it stores: `127.0.0.1:8813` is written back as
 * `http://127.0.0.1:8813`, and a trailing slash comes and goes. Comparing the
 * raw strings would report our own configuration as somebody else's and
 * refuse to turn on a switch that is already on. */
export function sameTarget(left, right) {
  const normalize = (value) => {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    try {
      const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
      const port = url.port || (url.protocol === "https:" ? "443" : "80");
      const host = url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
      return `${url.protocol}//${host}:${port}`;
    } catch {
      return null;
    }
  };
  const a = normalize(left);
  const b = normalize(right);
  return a !== null && a === b;
}

/** Turn a failed `serve` invocation into a reason a person can act on.
 *
 * Failing opaquely is the specific thing this module was built not to do. The
 * three real causes each have a different next step, and "command failed" is
 * the next step for none of them. */
export function classifyServeFailure(stderr) {
  const text = String(stderr ?? "");
  const lower = text.toLowerCase();
  if (/not (yet )?logged in|logged out|needslogin|please log ?in|not running/.test(lower)) {
    return {
      reason: "logged-out",
      message:
        "Tailscale is installed but not signed in on this computer. Sign in to your tailnet, then turn this on again.",
    };
  }
  if (/cert|https is (not enabled|disabled)|enable https|magicdns/.test(lower)) {
    return {
      reason: "no-certificates",
      message:
        "Your tailnet does not have HTTPS certificates enabled, so Tailscale cannot serve a secure address. " +
        "Enable HTTPS (and MagicDNS) for your tailnet in the Tailscale admin console, then turn this on again. " +
        "Browser access still works over plain HTTP on your tailnet in the meantime.",
    };
  }
  if (/flag provided but not defined|unknown flag|unknown subcommand/.test(lower)) {
    return {
      reason: "unsupported",
      message:
        "This version of the Tailscale CLI does not understand `tailscale serve --bg --https=443`. " +
        "Update Tailscale, or leave browser access on plain HTTP over your tailnet.",
    };
  }
  const first = text.split("\n").map((line) => line.trim()).find(Boolean);
  return {
    reason: "failed",
    message: first
      ? `Tailscale could not put a secure address in front of Murage: ${first}`
      : "Tailscale could not put a secure address in front of Murage.",
  };
}

/** Read the current serve arrangement without changing anything.
 *
 * Safe to call on every state read: it is one short subprocess and it never
 * writes. Returns the same discriminated shape the callers of `enable` and
 * `disable` get back, so the panel renders one thing. */
export async function serveState({ run = runTailscale, cli: known, proxyTarget, port = SERVE_PORT } = {}) {
  const cli = known ?? (await findTailscale({ run }));
  if (!cli) {
    return {
      available: false,
      on: false,
      host: null,
      reason: "missing",
      message:
        "Tailscale is not installed on this computer. Install it and sign in, and Murage can serve a secure " +
        "address your other devices can open.",
    };
  }
  const status = await run(cli, ["serve", "status", "--json"], TAILSCALE_BUDGET_MS);
  if (!status.ok) {
    // An unconfigured node exits non-zero on some versions with nothing to
    // say. Treat an empty complaint as "no config", and a real one as itself.
    const complaint = status.stderr.trim();
    if (!complaint || /no serve config|not configured/i.test(complaint)) {
      return { available: true, on: false, host: null, reason: null, message: null, cli };
    }
    const { reason, message } = classifyServeFailure(complaint);
    return { available: true, on: false, host: null, reason, message, cli };
  }
  const read = readServeStatus(status.stdout, { proxyTarget, port });
  if (read.owner === "ours") {
    return { available: true, on: true, host: read.host, reason: null, message: null, cli };
  }
  if (read.owner === "other" || read.owner === "unknown") {
    return {
      available: true,
      on: false,
      host: read.host ?? null,
      reason: "conflict",
      message: read.conflict,
      cli,
    };
  }
  return { available: true, on: false, host: null, reason: null, message: null, cli };
}

/** Put `tailscale serve` in front of the door, tailnet-only, in the
 * background, on 443.
 *
 * Idempotent by construction: an arrangement that is already ours returns
 * without running a write at all, and running the same `serve` command twice
 * is a no-op anyway. A config that belongs to something else is refused
 * before any write happens — that check is the whole reason this reads before
 * it writes. */
export async function enableServe({ run = runTailscale, proxyTarget, port = SERVE_PORT } = {}) {
  const before = await serveState({ run, proxyTarget, port });
  if (!before.available) return before;
  if (before.reason === "conflict") return before;
  if (before.on) return before;

  const cli = before.cli;
  // `--bg` is what makes this a configuration rather than a foreground
  // process that dies with the app. `--https=<port>` is serve's tailnet-only
  // HTTPS front; there is no funnel flag here and there never will be.
  const applied = await run(
    cli,
    ["serve", "--bg", `--https=${port}`, proxyTarget],
    TAILSCALE_BUDGET_MS,
  );
  if (!applied.ok) {
    const { reason, message } = classifyServeFailure(applied.stderr || applied.stdout);
    return { available: true, on: false, host: null, reason, message, cli };
  }
  // Read back rather than trust the exit code. The host in the config is the
  // authority on what a browser types — it is the name Tailscale issued the
  // certificate for, which is not necessarily the name any other probe found.
  const after = await serveState({ run, cli, proxyTarget, port });
  if (after.on && after.host) return after;
  return {
    available: true,
    on: false,
    host: null,
    reason: "failed",
    message:
      "Tailscale accepted the request but is not serving Murage yet. Check `tailscale serve status`, " +
      "then try again. Browser access still works over plain HTTP on your tailnet.",
    cli,
  };
}

/** Take it back down.
 *
 * Only ever removes an arrangement that is ours. A config belonging to
 * something else is left exactly as found and reported, because "turn my
 * thing off" has never meant "turn your thing off too". */
export async function disableServe({ run = runTailscale, proxyTarget, port = SERVE_PORT } = {}) {
  const before = await serveState({ run, proxyTarget, port });
  if (!before.available) return { ...before, on: false };
  if (!before.on) {
    // Nothing of ours is there. A conflict stays reported, so the panel can
    // still explain why the secure address is unavailable.
    return before;
  }
  const removed = await run(before.cli, ["serve", `--https=${port}`, "off"], TAILSCALE_BUDGET_MS);
  if (!removed.ok) {
    const { reason, message } = classifyServeFailure(removed.stderr || removed.stdout);
    return { ...before, reason, message };
  }
  return { available: true, on: false, host: null, reason: null, message: null, cli: before.cli };
}
