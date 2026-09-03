// Where the DEVICE door binds, asserted against real sockets.
//
// This file exists because of a one-word decision that was invisible in code
// review: `listen(companion, COMPANION_PORT, "0.0.0.0")` with no environment
// variable that changed it, eleven lines below a comment claiming "nothing
// binds 0.0.0.0". On a desktop that bind is CORRECT — a phone on the same
// wifi is the feature — and on a rented box it is a listener on the public
// internet minus a security-group rule, in a product whose entire claim is
// that there is no public ingress.
//
// So the two things worth testing are opposites, and both are here:
//
//   - `MURAGE_COMPANION_BIND` unset still binds 0.0.0.0 and a phone on the
//     LAN still reaches it. Fixing the cloud by narrowing the default would
//     have broken pairing on every laptop, silently.
//   - every narrowed mode is actually narrow, checked by dialling the socket
//     rather than by reading the log line next to it.
//
// Asserted by connecting, not by parsing stdout. A banner is a claim about a
// bind; `connect()` is the bind. The one that guards the regression is
// `off`: it needs no LAN address to be conclusive, so it is red on any
// machine the moment the device door binds something it was not asked to.
import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { lanAddresses, tailscaleAddress } from "../src/listener.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "..", "src", "index.ts");

/** Ports well clear of the defaults and of the rest of the suite. The harness
 * port is pointed at nothing on purpose: `refreshMachineName` fetches it and
 * is meant to fail, which is the "harness not up" path it already handles. */
const PORTS = {
  MURAGE_PORT: "9710",
  MURAGE_COMPANION_PORT: "9720",
  MURAGE_CONTROL_PORT: "9721",
  MURAGE_BROWSER_PORT: "9722",
};

/** The child's environment: the suite's throwaway HOME and companion dir have
 * to travel or `DeviceRegistry` — built at module scope, before anything this
 * file cares about runs — reads the developer's real paired fleet. Same
 * reasoning as `ports.test.ts`, which is where this list came from.
 *
 * MURAGE_BROWSER_BIND is pinned to `loopback` so the browser door cannot
 * wander onto a tailnet address on a developer machine that has one; this
 * file is about the *other* door, and a browser door that failed to bind
 * would fail these tests for an unrelated reason. */
const childEnv = (extra: Record<string, string>): Record<string, string> => ({
  ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
  ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}),
  ...(process.env.MURAGE_COMPANION_DIR ? { MURAGE_COMPANION_DIR: process.env.MURAGE_COMPANION_DIR } : {}),
  ...PORTS,
  MURAGE_BROWSER_BIND: "loopback",
  ...extra,
});

let running: ChildProcess | null = null;

afterEach(async () => {
  if (!running) return;
  const child = running;
  running = null;
  // Already gone is the normal case for the refusal tests — waiting on a
  // `close` that fired before this hook ran would hang the whole file.
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.on("close", () => resolve()));
});

/** Start the sidecar and wait until it has finished `main()`.
 *
 * The signal is the `pair here` banner, which prints after every listen this
 * file cares about. Polling a port instead would be a race the wrong way
 * round: the control port comes up first, so a probe that saw it could still
 * be ahead of the device door's bind and would read "not listening" as a
 * pass. */
const boot = (extra: Record<string, string>): Promise<{ out: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], {
      env: childEnv(extra),
      stdio: ["ignore", "pipe", "pipe"],
    });
    running = child;
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c;
      if (out.includes("pair here")) resolve({ out });
    });
    child.stderr.on("data", (c: Buffer) => (err += c));
    child.on("close", (code) => reject(new Error(`sidecar exited ${code} before starting: ${err || out}`)));
    setTimeout(() => reject(new Error(`sidecar never finished starting: ${err || out}`)), 25_000).unref?.();
  });

/** Start the sidecar expecting it NOT to start, and collect why. */
const bootFails = (extra: Record<string, string>): Promise<{ code: number | null; err: string }> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY], { env: childEnv(extra), stdio: ["ignore", "ignore", "pipe"] });
    running = child;
    let err = "";
    child.stderr.on("data", (c: Buffer) => (err += c));
    child.on("close", (code) => resolve({ code, err }));
    setTimeout(() => child.kill("SIGKILL"), 20_000).unref?.();
  });

/** Is anything accepting connections at this address:port?
 *
 * A refused connection is the answer, not an error — that is the whole
 * measurement. A timeout is reported as its own outcome rather than folded
 * into "closed", because a filtered port and an absent listener are different
 * facts and quietly merging them is how this kind of test goes green wrongly. */
const reachable = (host: string, port: number): Promise<"open" | "refused" | "timeout"> =>
  new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (outcome: "open" | "refused" | "timeout") => {
      socket.destroy();
      resolve(outcome);
    };
    socket.setTimeout(3000);
    socket.on("connect", () => done("open"));
    socket.on("timeout", () => done("timeout"));
    socket.on("error", () => done("refused"));
  });

const DEVICE_PORT = Number(PORTS.MURAGE_COMPANION_PORT);
/** A non-loopback address this machine actually holds — the stand-in for the
 * cloud box's public NIC, and for the wifi a phone is on. Tailscale addresses
 * are excluded: they are reachable in `tailnet` mode by design, so leaving
 * one in would make "narrowed" and "wide" indistinguishable. */
const OFF_MACHINE = lanAddresses().filter((a) => a !== tailscaleAddress())[0] ?? null;

describe("the device door binds where it was asked to and nowhere else", () => {
  // THE GUARD. Needs no LAN address, so it is conclusive on any machine: if
  // the device door binds anything at all when told `off`, loopback finds it.
  it("opens no device-door listener at all under MURAGE_COMPANION_BIND=off", async () => {
    const { out } = await boot({ MURAGE_COMPANION_BIND: "off" });

    expect(await reachable("127.0.0.1", DEVICE_PORT)).toBe("refused");
    if (OFF_MACHINE) expect(await reachable(OFF_MACHINE, DEVICE_PORT)).toBe("refused");

    // and the deployment is still a working one: the doors a headless box
    // actually uses came up. `off` must be "no device door", not "no sidecar".
    expect(await reachable("127.0.0.1", Number(PORTS.MURAGE_CONTROL_PORT))).toBe("open");
    expect(await reachable("127.0.0.1", Number(PORTS.MURAGE_BROWSER_PORT))).toBe("open");
    expect(out).toContain("not listening");
  }, 40_000);

  it("binds only loopback under MURAGE_COMPANION_BIND=loopback", async () => {
    await boot({ MURAGE_COMPANION_BIND: "loopback" });
    expect(await reachable("127.0.0.1", DEVICE_PORT)).toBe("open");
    // The half that would be green on a hardcoded 0.0.0.0 is the half above;
    // this is the half that names the actual exposure.
    if (OFF_MACHINE) expect(await reachable(OFF_MACHINE, DEVICE_PORT)).toBe("refused");
  }, 40_000);

  // The desktop, unchanged. If this ever goes red the cloud fix broke phone
  // pairing, which is the failure this whole change was shaped to avoid.
  it("still binds 0.0.0.0 with nothing set, so a phone on the LAN still pairs", async () => {
    const { out } = await boot({});
    expect(out).toContain(`http://0.0.0.0:${DEVICE_PORT}`);
    expect(await reachable("127.0.0.1", DEVICE_PORT)).toBe("open");
    if (OFF_MACHINE) expect(await reachable(OFF_MACHINE, DEVICE_PORT)).toBe("open");
    else console.warn("no non-loopback address on this machine — LAN reachability not asserted");
  }, 40_000);

  // `lan` written out is the same thing as unset. Worth a line: an installer
  // that sets the variable explicitly on a desktop must get the desktop.
  it("treats MURAGE_COMPANION_BIND=lan as the default", async () => {
    const { out } = await boot({ MURAGE_COMPANION_BIND: "lan" });
    expect(out).toContain(`http://0.0.0.0:${DEVICE_PORT}`);
  }, 40_000);

  // Fail closed on a typo. The default is the widest bind this process can
  // make, so "unrecognised" must not resolve to it.
  it("refuses to start on an unrecognised bind mode rather than defaulting to 0.0.0.0", async () => {
    const { code, err } = await bootFails({ MURAGE_COMPANION_BIND: "127.0.0.1" });
    expect(code).toBe(1);
    expect(err).toContain("MURAGE_COMPANION_BIND");
    expect(err).toContain("127.0.0.1");
    expect(err).toContain("lan, loopback, tailnet, off");
    expect(await reachable("127.0.0.1", DEVICE_PORT)).toBe("refused");
  }, 40_000);

  // `tailnet` is "that address or nothing", so on a machine with no tailnet
  // it must not start. Conditional because the outcome genuinely depends on
  // the machine — and the branch that is skipped is stated, not hidden.
  it("refuses to start on tailnet mode with no tailnet address", async () => {
    if (tailscaleAddress()) {
      console.warn("this machine has a Tailscale address — the tailnet refusal path is not exercised here");
      return;
    }
    const { code, err } = await bootFails({ MURAGE_COMPANION_BIND: "tailnet" });
    expect(code).toBe(1);
    expect(err).toContain("MURAGE_COMPANION_BIND=tailnet");
    // fail closed, and say so: no falling back to loopback and certainly not
    // to the address the operator was avoiding
    expect(err).toContain("will not fall back");
    expect(await reachable("127.0.0.1", DEVICE_PORT)).toBe("refused");
  }, 40_000);
});
