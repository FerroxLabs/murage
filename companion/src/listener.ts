// The companion listener — a second HTTP socket, off by default, that a
// paired phone can reach. It runs the same request handler as the loopback
// server; the only difference is the `remote` flag the handler gets, which
// is what turns on authentication and turns off the routes a phone has no
// business calling.
//
// Two listeners rather than one bind on 0.0.0.0, deliberately. A single
// socket cannot tell "the desktop app on this machine" from "something else
// on the coffee-shop wifi" — `req.socket.localAddress` is 127.0.0.1 for both
// when a 0.0.0.0 listener is reached over loopback. Separate sockets make
// the distinction structural instead of a guess, so the trusted path stays
// exactly as trusted as it was before this file existed.
import { execFile } from "node:child_process";
import { createServer, type RequestListener, type Server } from "node:http";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";

/** Every IPv4 address a phone on the same network could dial. Link-local
 * (169.254/16) is dropped: it means DHCP failed and nothing will reach us. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (entry.address.startsWith("169.254.")) continue;
      out.push(entry.address);
    }
  }
  return out;
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
 * Worth having as well as the address, because a phone reaching a tailnet
 * over plain HTTP is on the wrong side of App Transport Security: iOS
 * exempts local networking, and 100.64/10 is CGNAT shared space rather than
 * one of the private ranges that exemption covers. A `ts.net` hostname can
 * be exempted by name, which an address cannot.
 *
 * Read once when the listener comes up and cached — asking Tailscale is a
 * subprocess, and nothing here is worth spawning one per request. */
let cachedTailnetName: string | null = null;

/** The MagicDNS name for this machine, if a refresh has found one. */
export function tailnetName(): string | null {
  return cachedTailnetName;
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
    "tailscale",
  ];
}

/** PATH with the usual package-manager locations added back, for the bare
 * `tailscale` attempt. Costs nothing when PATH was already complete. */
const searchPath = (): string =>
  [process.env.PATH ?? "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    .filter(Boolean)
    .join(":");

/** Ask the Tailscale CLI where it thinks we are.
 *
 * Every failure is survivable — not installed, not logged in, not running all
 * just mean "no name", and the address still works. But *silently* survivable
 * was the wrong call: a panel that says "turn on MagicDNS" to somebody who
 * has MagicDNS on is worse than no message, and there was no way to tell
 * which of these paths had been tried. `onAttempt` is how the caller can say.
 */
export async function refreshTailnetName(
  onAttempt?: (cli: string, outcome: string) => void,
): Promise<void> {
  for (const cli of tailscaleCandidates()) {
    const name = await new Promise<string | null>((resolve) => {
      execFile(
        cli,
        ["status", "--json"],
        { timeout: 5000, env: { ...process.env, PATH: searchPath() } },
        (error, stdout) => {
          if (error) {
            onAttempt?.(cli, error.message.split("\n")[0]);
            return resolve(null);
          }
          try {
            const dns = JSON.parse(stdout)?.Self?.DNSName;
            // MagicDNS names are fully qualified, trailing dot and all
            const trimmed = typeof dns === "string" && dns ? dns.replace(/\.$/, "") : null;
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
      cachedTailnetName = name;
      return;
    }
  }
  cachedTailnetName = null;
}

export interface RemoteState {
  enabled: boolean;
  port: number;
  addresses: string[];
  /** The tailnet address, when this machine is on one. */
  tailscale?: string;
  /** Its MagicDNS name, when Tailscale will tell us. */
  tailnetName?: string;
  /** Why the listener is not up despite being enabled (e.g. port in use). */
  error?: string;
}

export class RemoteListener {
  private server: Server | null = null;
  private lastError: string | undefined;
  private readonly handler: RequestListener;
  /** Serialises enable/disable — see `transition`. */
  private queue: Promise<unknown> = Promise.resolve();
  readonly port: number;

  // Plain assignments, not constructor parameter properties: the harness
  // runs straight off .ts through Node's strip-only type stripping, which
  // rejects any TypeScript syntax that emits code.
  constructor(handler: RequestListener, port: number) {
    this.handler = handler;
    this.port = port;
  }

  get running(): boolean {
    return this.server !== null;
  }

  /** Everything a caller needs to render the listener's status. */
  state(): RemoteState {
    const addresses = this.running ? lanAddresses() : [];
    const tailscale = tailscaleAddress(addresses);
    const name = tailnetName();
    return {
      enabled: this.running,
      port: this.port,
      addresses,
      ...(tailscale ? { tailscale } : {}),
      ...(tailscale && name ? { tailnetName: name } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  /**
   * Run one lifecycle change at a time.
   *
   * `enable` checks `this.server` and then awaits a bind, so two overlapping
   * calls both see null, both create a server, and both bind the same port.
   * The winner is whichever assigns `this.server` last; the other is left
   * bound, unreferenced and unclosable — a listener on the network that
   * nothing can turn off short of ending the process. `disable` racing
   * `enable` has the mirror problem: it clears a field the in-flight enable
   * is about to set, and the port stays open with the state saying otherwise.
   */
  private transition<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  /** Bind 0.0.0.0:port. Resolves with the new state either way — a port
   * conflict is a message the user can act on, never a crashed harness. */
  enable(): Promise<RemoteState> {
    return this.transition(() => this.enableNow());
  }

  private async enableNow(): Promise<RemoteState> {
    if (this.server) return this.state();
    const server = createServer(this.handler);
    // A bare `once("error")` is spent the first time it fires. Anything the
    // server emits afterwards — during the close below, or from a socket
    // that fails after a successful bind — reaches a server with no error
    // listener, and an unhandled 'error' event is an uncaught exception that
    // takes the sidecar down. This one stays for the server's whole life;
    // the bind-specific handler below is layered on top of it.
    server.on("error", () => {});
    this.lastError = undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server.removeListener("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.port, "0.0.0.0");
      });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      this.lastError =
        err.code === "EADDRINUSE"
          ? `port ${this.port} is already in use — close whatever is using it and try again`
          : err.message;
      try {
        server.close();
      } catch {
        /* never bound */
      }
      return this.state();
    }
    // A listener whose sockets keep the process alive would stop the harness
    // from exiting on SIGTERM while a phone holds an SSE stream open.
    server.unref();
    this.server = server;
    return this.state();
  }

  disable(): Promise<RemoteState> {
    return this.transition(() => this.disableNow());
  }

  /** Close the listener and drop live sockets. See disable(). */
  private async disableNow(): Promise<RemoteState> {
    const server = this.server;
    this.server = null;
    this.lastError = undefined;
    if (!server) return this.state();
    // close() waits for open connections, and an SSE stream never ends on
    // its own — drop the sockets so "turn it off" means off, now.
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return this.state();
  }
}
