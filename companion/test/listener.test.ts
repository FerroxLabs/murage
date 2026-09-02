// The MagicDNS name, and when it is allowed to be asked for again.
//
// The name is cached because asking Tailscale costs a subprocess. Cached is
// not the same as read-once, and the difference is the whole bug: someone who
// installs Tailscale, signs in, or brings it up after Murage is already
// running had a tailnet route that read as permanently unavailable until they
// restarted the app. For a product whose door is the tailnet, that is the
// worst failure mode there is.
//
// So the cache can be refreshed. Which introduces the second problem these
// tests pin: two probes in flight at once, each racing to write the same
// cache. A refresh asked for while the startup probe is still hunting must
// join that probe rather than start a competing one — a five-second CLI hunt
// spawned twice is two subprocesses per candidate, and whichever finishes
// last decides the answer regardless of which one actually found a name.
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Every CLI path the code under test actually tried to run. */
const attempted: string[] = [];

/** What the next `tailscale status --json` should do. Replaced per test. */
let respond: (cli: string) => Promise<{ error?: Error; stdout?: string }> = async () => ({
  error: new Error("not configured by this test"),
});

vi.mock("node:child_process", () => ({
  execFile: (
    cli: string,
    _args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    attempted.push(cli);
    void respond(cli).then(({ error, stdout }) => callback(error ?? null, stdout ?? "", ""));
  },
}));

const { refreshTailnetName, tailnetName, tailnetSelfAddress } = await import("../src/listener.ts");

/** A `tailscale status --json` body carrying one MagicDNS name, trailing dot
 * and all — the shape the real CLI emits. */
const status = (name: string): string => JSON.stringify({ Self: { DNSName: `${name}.` } });

beforeEach(() => {
  attempted.length = 0;
});

describe("refreshing the MagicDNS name", () => {
  it("joins a probe already in flight instead of starting a second one", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    respond = async () => {
      await held;
      return { stdout: status("macbook.tail1234.ts.net") };
    };

    // Startup asks; a person clicks "check again" while that hunt is still
    // running. One subprocess, not two — and crucially not two writers to
    // one cache, where the loser is decided by whichever CLI path hangs
    // longest rather than by which one found a name.
    const startup = refreshTailnetName();
    const clicked = refreshTailnetName();
    expect(attempted).toHaveLength(1);

    release();
    await Promise.all([startup, clicked]);

    expect(attempted).toHaveLength(1);
    expect(tailnetName()).toBe("macbook.tail1234.ts.net");
  });

  it("asks again once the previous probe has settled", async () => {
    respond = async () => ({ stdout: status("macbook.tail1234.ts.net") });

    await refreshTailnetName();
    expect(attempted).toHaveLength(1);

    // The coalescing slot has to be released when the probe finishes, or the
    // very failure this whole change exists to fix comes back in a new
    // costume: the first answer would be latched forever and Tailscale
    // brought up afterwards would still read as absent.
    await refreshTailnetName();
    expect(attempted).toHaveLength(2);
    expect(tailnetName()).toBe("macbook.tail1234.ts.net");
  });
});

// ── the address Tailscale itself claims ──────────────────────────────────
//
// `tailscaleAddress()` reads the interface table and takes the first address
// in 100.64.0.0/10. That is fine for printing a pairing candidate and not
// fine for choosing what a listener binds: 100.64/10 is CGNAT space, and a
// carrier-grade-NAT uplink or a second mesh VPN can put a real address there
// ahead of the one Tailscale issued. So the door asks Tailscale as well, and
// refuses when the two answers disagree.
//
// Read out of the same `status --json` the name comes from — `tailscale ip
// -4` is a formatter over `Self.TailscaleIPs` — so it costs no extra
// subprocess and cannot disagree with the name it shipped alongside.
describe("the address Tailscale reports for this node", () => {
  it("reads the IPv4 out of the same status the name came from", async () => {
    respond = async () => ({
      stdout: JSON.stringify({
        Self: {
          DNSName: "macbook.tail1234.ts.net.",
          // Both families, IPv6 included, exactly as the real CLI emits.
          TailscaleIPs: ["100.79.121.109", "fd7a:115c:a1e0::4d3b:796d"],
        },
      }),
    });
    await refreshTailnetName();
    expect(tailnetName()).toBe("macbook.tail1234.ts.net");
    expect(tailnetSelfAddress()).toBe("100.79.121.109");
    // One subprocess for both answers.
    expect(attempted).toHaveLength(1);
  });

  it("skips an IPv6-only node rather than handing back something unbindable", async () => {
    respond = async () => ({
      stdout: JSON.stringify({
        Self: { DNSName: "macbook.tail1234.ts.net.", TailscaleIPs: ["fd7a:115c:a1e0::4d3b:796d"] },
      }),
    });
    await refreshTailnetName();
    expect(tailnetSelfAddress()).toBeNull();
  });

  it("forgets the address when Tailscale stops answering", async () => {
    respond = async () => ({
      stdout: JSON.stringify({
        Self: { DNSName: "macbook.tail1234.ts.net.", TailscaleIPs: ["100.79.121.109"] },
      }),
    });
    await refreshTailnetName();
    expect(tailnetSelfAddress()).toBe("100.79.121.109");

    // Signed out, or uninstalled, between one probe and the next. A cached
    // address that outlived Tailscale would keep the door bound to an
    // interface on its way down, and "we could not ask" has to read as "we do
    // not know" rather than as last week's answer.
    respond = async () => ({ error: new Error("not running") });
    await refreshTailnetName();
    expect(tailnetName()).toBeNull();
    expect(tailnetSelfAddress()).toBeNull();
  });

  it("ignores anything in that field that is not a dotted quad", async () => {
    // This value decides what a listener binds, so it is validated rather
    // than trusted — the CLI is a subprocess whose output is parsed JSON.
    respond = async () => ({
      stdout: JSON.stringify({
        Self: { DNSName: "macbook.tail1234.ts.net.", TailscaleIPs: ["0.0.0.0 ; rm -rf /", { a: 1 }] },
      }),
    });
    await refreshTailnetName();
    expect(tailnetSelfAddress()).toBeNull();
  });
});
