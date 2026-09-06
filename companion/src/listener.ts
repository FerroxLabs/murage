// Where this computer can be reached, and what it is called there.
//
// The addresses a phone might dial, the tailnet one told apart from the rest,
// and the MagicDNS name read out of the Tailscale CLI. Nothing here binds
// anything: the sidecar owns its own sockets in index.ts, and this file only
// answers the question the pairing page has to print.
//
// It used to hold a `RemoteListener` as well — the socket the harness opened
// for a phone back when the companion lived inside it. Moving out made it a
// class with no callers, and a second implementation of a socket lifecycle
// nobody runs is a thing that rots. index.ts owns the listeners now.
import { execFile, type ExecFileException } from "node:child_process";
import { homedir, networkInterfaces } from "node:os";
import { delimiter, join, win32 } from "node:path";

/** Interfaces that exist to tunnel, bridge or mesh traffic — utun (Tailscale
 * and every other VPN), vmnet/bridge (VMs, containers, internet sharing),
 * awdl/llw (AirDrop's side channels), feth/tap/tun. Their addresses stay in
 * the list, because the tailnet one is exactly what a phone off-network
 * dials — but a phone on the same wifi can reach none of them, so none of
 * them may come first. */
const VIRTUAL_INTERFACES = /^(utun|tun|tap|bridge|vmnet|awdl|llw|feth)/;

/** Lower sorts earlier. `en0`, `en1`, … are macOS's built-in wifi and
 * ethernet — the networks a phone is actually standing on. */
const interfaceRank = (name: string): number => {
  if (/^en\d+$/.test(name)) return 0;
  if (VIRTUAL_INTERFACES.test(name)) return 2;
  return 1;
};

/** Every IPv4 address a phone on the same network could dial, most reachable
 * first. Link-local (169.254/16) is dropped: it means DHCP failed and nothing
 * will reach us.
 *
 * Ranked, not merely collected: `networkInterfaces()` promises nothing about
 * order, callers put the first non-tailnet entry into the pairing QR, and on
 * a Mac with a VPN or a VM running the first entry can be a utun or bridge100
 * address the phone cannot route to. Real interfaces lead, tunnels and
 * bridges trail; the sort is stable, so enumeration order still breaks ties.
 * The parameter exists for tests — the interface table is the machine's. */
export function lanAddresses(interfaces = networkInterfaces()): string[] {
  const found: Array<{ rank: number; address: string }> = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (entry.address.startsWith("169.254.")) continue;
      found.push({ rank: interfaceRank(name), address: entry.address });
    }
  }
  return found.sort((a, b) => a.rank - b.rank).map((entry) => entry.address);
}

/** Tailscale hands its nodes an address in 100.64.0.0/10 — the CGNAT range
 * RFC 6598 set aside, which is why it never collides with a home network.
 *
 * Worth telling apart from a LAN address because it behaves completely
 * differently: it does not change when you join another wifi, it works from
 * anywhere the tailnet reaches, and it survives the guest network that
 * isolates its clients. For a companion it is the *better* address, and the
 * only one that keeps working when you leave the house. */
export function tailscaleAddress(addresses: string[] = lanAddresses()): string | null {
  for (const address of addresses) {
    const [first, second] = address.split(".").map(Number);
    if (first === 100 && second >= 64 && second <= 127) return address;
  }
  return null;
}

/** The machine's MagicDNS name, e.g. `macbook.tail1234.ts.net`.
 *
 * Worth having as well as the address because it is stable: Tailscale can
 * re-issue a node's 100.64/10 address, and a client holding only the address
 * then has a candidate that resolves to nothing. The name outlives that. It is
 * also the half a human can read off a screen and type into a phone.
 *
 * It is *not* the only dialable candidate. It used to be, for one client only:
 * iOS refused plain HTTP to 100.64/10 under App Transport Security — CGNAT
 * space is outside the local-networking exemption, and ATS matches exceptions
 * by name, so only a `ts.net` name could be allowed. That client is retired
 * and no browser has the equivalent rule, so `hostCandidates()` now offers the
 * bare address too. See `docs/ios-companion-archive/ats-decision-record.md`.
 *
 * Read when the listener comes up and cached — asking Tailscale is a
 * subprocess, so ordinary state reads stay cheap. Cached is not read-once,
 * though: Tailscale is routinely installed, signed into, or switched on after
 * Murage is already running, and a name read only at boot would leave the
 * tailnet — the route this product leads with — reading as permanently
 * unavailable until someone restarted the app. An explicit setup action can
 * refresh this cache when Tailscale changes later. */
let cachedTailnetName: string | null = null;
let cachedTailnetSelfAddress: string | null = null;
let activeTailnetRefresh: Promise<void> | null = null;
let cachedTailscaleCli: string | null = null;

/** The cached MagicDNS name, or null until `refreshTailnetName` finds one. */
export function tailnetName(): string | null {
  return cachedTailnetName;
}

/** The IPv4 address **Tailscale itself** says this node has — the same value
 * `tailscale ip -4` prints, read out of the same `status --json` the name
 * comes from rather than costing a second subprocess.
 *
 * Worth having as a separate answer from `tailscaleAddress()`, which reads the
 * interface table and takes the first address in 100.64.0.0/10. That range is
 * CGNAT space, and Tailscale is not the only thing that lives there: a carrier
 * -grade-NAT uplink or another mesh VPN puts an address the machine really has
 * in front of the one Tailscale issued. For printing a candidate that mistake
 * costs a failed connection. For *binding a door* it costs the door being
 * opened on a network nobody chose, which is why the two are cross-checked
 * before anything binds — see `browserBindHost`.
 *
 * Null until a refresh finds one, and null again when Tailscale goes away. */
export function tailnetSelfAddress(): string | null {
  return cachedTailnetSelfAddress;
}

/** Every place the Tailscale CLI is plausibly installed, best first. */
export function tailscaleCandidates(home = homedir()): string[] {
  // Absolute paths first, PATH last: a process the desktop app forks inherits
  // whatever PATH the app was launched with, and an app opened from Finder
  // gets /usr/bin:/bin:/usr/sbin:/sbin — no Homebrew, no /usr/local. Relying
  // on the lookup alone works in a terminal and fails in the real app, which
  // is exactly the way round that is hardest to notice.
  return [
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    join(home, "Applications", "Tailscale.app", "Contents", "MacOS", "Tailscale"),
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
    "/usr/bin/tailscale",
    "/run/current-system/sw/bin/tailscale",
    // Windows GUI launches may omit Tailscale from PATH. Use the OS install
    // roots when supplied (including custom drives), with standard defaults.
    // execFile takes these space-containing paths as one unquoted argument.
    win32.join(process.env.ProgramFiles || "C:\\Program Files", "Tailscale", "tailscale.exe"),
    win32.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Tailscale", "tailscale.exe"),
    "tailscale",
  ];
}

/** How long the whole CLI hunt may take, across every candidate path. */
export const TAILSCALE_BUDGET_MS = 5000;

/** PATH with the usual package-manager locations added back, for the bare
 * `tailscale` attempt. Costs nothing when PATH was already complete. */
const searchPath = (): string =>
  [process.env.PATH ?? "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    .filter(Boolean)
    .join(delimiter);

/** Ask the Tailscale CLI where it thinks we are.
 *
 * Every failure is survivable — not installed, not logged in, not running all
 * just mean "no name", and the address still works. But *silently* survivable
 * was the wrong call: a panel that says "turn on MagicDNS" to somebody who
 * has MagicDNS on is worse than no message, and there was no way to tell
 * which of these paths had been tried. `onAttempt` is how the caller can say.
 */
/** The first IPv4 out of Tailscale's `TailscaleIPs`, which carries both
 * families. Anything that is not a dotted quad is ignored rather than
 * trusted: this value decides what a listener binds. */
function firstIPv4(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    if (typeof entry === "string" && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(entry)) return entry;
  }
  return null;
}

async function refreshTailnetNameOnce(
  onAttempt?: (cli: string, outcome: string) => void,
): Promise<void> {
  // A budget for the whole loop, not per probe. Seven candidates at five
  // seconds each is thirty-five seconds of startup in the case where several
  // hang — and they hang together, since the reason is usually the same one.
  // Nothing here is load-bearing: the address works without a name.
  const deadline = Date.now() + TAILSCALE_BUDGET_MS;
  // Cleared before the hunt, not after it: a stale address that outlived
  // Tailscale being signed out would keep a door bound to an interface that
  // is on its way down, and "we could not ask" must read as "we do not know"
  // rather than as last week's answer.
  cachedTailnetSelfAddress = null;
  for (const cli of tailscaleCandidates()) {
    const left = deadline - Date.now();
    if (left <= 0) {
      onAttempt?.(cli, "skipped — out of time looking for the Tailscale CLI");
      continue;
    }
    const name = await new Promise<string | null>((resolve) => {
      execFile(
        cli,
        ["status", "--json"],
        {
          timeout: Math.max(250, left),
          // SIGTERM is a request, and the budget above is only worth as much
          // as the thing that enforces it: a wedged CLI that ignores the
          // polite signal would sit there past the deadline it was supposed
          // to be bounded by. SIGKILL is not a request.
          killSignal: "SIGKILL",
          // `status --json` describes every peer in the tailnet, and the
          // default cap is 1 MiB — a large enough tailnet fails the probe with
          // ENOBUFS, which the code below reads as "no MagicDNS name" and
          // which looks from outside exactly like "Tailscale is not
          // installed". That is a wrong answer rather than a missing one.
          // Generous, and still a bound: the alternative is a subprocess
          // deciding how much memory this process uses.
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, PATH: searchPath() },
        },
        (error, stdout) => {
          if (error) {
            onAttempt?.(cli, error.message.split("\n")[0]);
            return resolve(null);
          }
          try {
            const self = JSON.parse(stdout)?.Self;
            const dns = self?.DNSName;
            // MagicDNS names are fully qualified, trailing dot and all
            const trimmed = typeof dns === "string" && dns ? dns.replace(/\.$/, "") : null;
            // Same JSON, same probe: `tailscale ip -4` is a formatter over
            // this field, so reading it here is the CLI's own answer without
            // a second process and a second chance to disagree with itself.
            cachedTailnetSelfAddress = firstIPv4(self?.TailscaleIPs);
            onAttempt?.(cli, trimmed ? `ok: ${trimmed}` : "ran, but no MagicDNS name in status");
            resolve(trimmed);
          } catch {
            onAttempt?.(cli, "ran, but its output was not JSON");
            resolve(null);
          }
        },
      );
    });
    if (name) {
      cachedTailscaleCli = cli;
      cachedTailnetName = name;
      return;
    }
  }
  cachedTailnetName = null;
}

/** Coalesce startup and user-triggered probes onto one hunt.
 *
 * Two probes in flight means two writers to one cache, each spawning a
 * subprocess per candidate path, and the answer is then decided by whichever
 * finishes last rather than by which one actually found a name — so a slow
 * failure can overwrite a successful MagicDNS result that a caller was
 * already told about. The slot is cleared when the hunt settles, because a
 * promise latched forever would reintroduce the read-once bug in a new
 * costume. */
export function refreshTailnetName(
  onAttempt?: (cli: string, outcome: string) => void,
): Promise<void> {
  if (activeTailnetRefresh) return activeTailnetRefresh;
  const refresh: Promise<void> = refreshTailnetNameOnce(onAttempt).finally(() => {
    if (activeTailnetRefresh === refresh) activeTailnetRefresh = null;
  });
  activeTailnetRefresh = refresh;
  return refresh;
}

export interface BrowserServeObservation {
  owner: "none" | "ours" | "other" | "unknown";
  origin: string | null;
  problem: string | null;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Read-only ownership check for the browser listener. Match the whole 443
 * arrangement, not the first matching route. No configuration is ever changed. */
export function inspectBrowserServe(raw: string, port: number): BrowserServeObservation {
  const refused = (owner: "other" | "unknown", problem: string): BrowserServeObservation => ({owner,origin:null,problem});
  let config: unknown;
  try { config = raw.trim() ? JSON.parse(raw) : {}; }
  catch { return refused("unknown","Tailscale Serve output is not valid JSON; HTTPS was not adopted."); }
  if (!record(config) || (config.Web !== undefined && !record(config.Web))) {
    return refused("unknown","Tailscale Serve configuration has an unknown shape; HTTPS was not adopted.");
  }
  const web = record(config.Web) ? config.Web : {};
  const entries = Object.entries(web).filter(([key])=>key.endsWith(":443"));
  if (!entries.length) {
    if (record(config.TCP) && config.TCP["443"] !== undefined) {
      return refused("other","Tailscale port 443 has an unowned listener; it was left unchanged.");
    }
    return {owner:"none",origin:null,problem:null};
  }
  if (entries.length !== 1) return refused("other","Tailscale port 443 has mixed routes; all were left unchanged.");
  const [key, value] = entries[0]!;
  const publicExposure = config[["Allow", "Fun", "nel"].join("")];
  if (record(publicExposure) && publicExposure[key]) {
    return refused("other","A public Tailscale route occupies 443; it was not adopted or changed.");
  }
  const handlers = record(value) && record(value.Handlers) ? value.Handlers : null;
  const root = handlers?.["/"];
  if (!handlers || Object.keys(handlers).length !== 1 || !record(root) || typeof root.Proxy !== "string") {
    return refused("other","Tailscale port 443 has unowned handlers; they were left unchanged.");
  }
  let target: URL;
  let front: URL;
  const host = key.slice(0,-4);
  try {
    target = new URL(root.Proxy.includes("://") ? root.Proxy : `http://${root.Proxy}`);
    front = new URL(`https://${host}`);
  } catch { return refused("unknown","Tailscale Serve contains an invalid target or host; HTTPS was not adopted."); }
  if (target.protocol !== "http:" || !["localhost","127.0.0.1"].includes(target.hostname) ||
      Number(target.port || 80) !== port || target.pathname !== "/" || target.search || target.hash || target.username || target.password) {
    return refused("other",`Tailscale 443 proxies to ${root.Proxy}, not this door; it was left unchanged.`);
  }
  if (front.hostname !== host.toLowerCase() || front.port || front.username || front.password || front.pathname !== "/" || front.search || front.hash) {
    return refused("unknown","Tailscale Serve has an invalid HTTPS host; it was not adopted.");
  }
  return {owner:"ours",origin:front.origin,problem:null};
}

/** Bounded Serve observation, independent of the remembered desktop toggle. */
export async function refreshBrowserServe(port: number, options: {
  run?: typeof execFile;
  candidates?: string[];
  deadline?: number;
} = {}): Promise<BrowserServeObservation> {
  const deadline = options.deadline ?? Date.now() + TAILSCALE_BUDGET_MS;
  const candidates = options.candidates ?? [...new Set([cachedTailscaleCli,...tailscaleCandidates()].filter((value): value is string=>Boolean(value)))];
  const run = options.run ?? execFile;
  for (const cli of candidates) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    const result = await new Promise<{error: ExecFileException | null; output: string}>(resolve=>{
      run(cli,["serve","status","--json"],{
        timeout:Math.max(1,left),killSignal:"SIGKILL",maxBuffer:1024*1024,
        env:{...process.env,PATH:searchPath()},
      },(error,stdout)=>resolve({error,output:String(stdout ?? "")}));
    });
    if (!result.error) return inspectBrowserServe(result.output,port);
    if (result.error.code !== "ENOENT") break;
  }
  return {owner:"unknown",origin:null,problem:"Tailscale Serve could not be verified; HTTPS is not advertised."};
}
