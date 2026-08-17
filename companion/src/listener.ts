// Where this computer can be reached, and what to call it.
//
// This file used to own the listener socket as well, back when the companion
// lived inside the harness and a `RemoteListener` class turned it on and off.
// The sidecar opens its own sockets in index.ts, so that class went with it —
// what is left is the part nothing else duplicates: working out which of this
// machine's addresses a phone could actually dial, telling a tailnet address
// apart from a LAN one, and asking Tailscale for the MagicDNS name that iOS
// insists on. The name stayed because the answers are still about the
// listener; only the socket moved.
import { execFile } from "node:child_process";
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
        {
          timeout: 5000,
          env: { ...process.env, PATH: searchPath() },
          // `tailscale status --json` describes every peer in the tailnet, and
          // Node's default 1 MiB cap turns a large one into ENOBUFS — read as
          // "no MagicDNS name" by the code below, which is a wrong answer
          // rather than a missing one. The ceiling is only there to bound a
          // runaway subprocess; it does not need to be tight.
          maxBuffer: 16 * 1024 * 1024,
        },
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
