#!/usr/bin/env node
// The sidecar, as one command.
//
//   node companion/src/index.ts
//
// Three public/runtime sockets, and one optional private managed origin. The
// split between them is the whole security model:
//
//   :8810  0.0.0.0*   devices     token required, allowlisted, scrubbed.
//                                 0.0.0.0 by DEFAULT and on purpose: a phone
//                                 pairs over the LAN, and that is the whole
//                                 feature. `MURAGE_COMPANION_BIND` narrows it
//                                 — `loopback`, `tailnet`, or `off` for no
//                                 listener at all — and a headless box is
//                                 expected to set it. See the block below.
//   :8811  127.0.0.1  you         pairing and revocation — never off-machine
//   :8813  tailnet    browsers    cookie required, its OWN allowlist, its own
//                                 origin policy. Binds the Tailscale address
//                                 when there is one and loopback when there
//                                 is not, and moves between them without a
//                                 restart when Tailscale comes up later.
//                                 `tailscale serve` goes in front of the
//                                 loopback case. This door never binds
//                                 0.0.0.0 in any mode.
//   :8799  127.0.0.1  the harness spoken to as this machine, unmodified
//   UDS/pipe            one Electron-owned sidecar generation, never TCP
//
// The funnel subcommand is never used in front of any of them: it is public
// ingress, and this product has none. `tailscale serve` is tailnet-only and
// is the supported way to put something in front of a narrowed door.
//
// 8813 rather than 8812: electron/companion-origin-gateway.mjs already owns
// 8812 for the managed loopback gateway.
//
// 8810 rather than 8800, which is where these started: the harness opens a
// webhook receiver one port above its own, so 8800 is already taken by the
// app this is a sidecar to. Ten clear of the harness leaves it room to add
// another adjacent listener without taking this one out again.
//
// Running this process *is* the opt-in. There is no toggle, because a toggle
// inside a process you chose to start would be ceremony: stopping it is the
// off switch, and it is a more honest one than a flag in a file.
import { createServer } from "node:http";

import { createAddressWatcher } from "./advertise-watch.ts";
import {
  browserBindHost,
  browserDoorLocation,
  browserFront,
  createBrowserHandler,
  createSignInLimiter,
  rebindBrowserDoor,
  tailnetBindAddress,
  type BoundIdentity,
  type BrowserBindMode,
} from "./browser.ts";
import { createControlServer, hostCandidates } from "./control.ts";
import { createConnectedDeviceTracker } from "./connected-devices.ts";
import { DeviceRegistry } from "./devices.ts";
import { companionEndpointCandidates, hostedCompanionUrl } from "./endpoints.ts";
import {
  lanAddresses,
  refreshTailnetName,
  refreshBrowserServe,
  TAILSCALE_BUDGET_MS,
  tailnetName,
  tailnetSelfAddress,
  tailscaleAddress,
} from "./listener.ts";
import {
  advertisableAddresses,
  clampBytes,
  defaultHostName,
  dnsLabel,
  MdnsResponder,
  type ServiceInfo,
} from "./mdns.ts";
import { createProxyHandler } from "./proxy.ts";
import { companionOriginSocket, listenCompanionOrigin } from "./origin.ts";
import { answerDoorChallenge, takeDoorIdentity } from "./door-identity.ts";

const companionToken = process.env.MURAGE_COMPANION_TOKEN;
delete process.env.MURAGE_COMPANION_TOKEN;
/** The headless installer's door nonce, taken out of the environment for the
 * same reason as the token: no child of this process may inherit it. */
const doorIdentity = takeDoorIdentity(process.env);

/** A port from the environment, or the default. Anything that is not a whole
 * number in range is the default — a typo'd port must not become port 0. */
const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
};

const HARNESS_PORT = num(process.env.MURAGE_PORT, 8799);
const WEBHOOK_PORT = num(process.env.MURAGE_WEBHOOK_PORT, HARNESS_PORT + 1);
const COMPANION_PORT = num(process.env.MURAGE_COMPANION_PORT, 8810);
const CONTROL_PORT = num(process.env.MURAGE_CONTROL_PORT, 8811);
/** Where the DEVICE door binds. Unset is `lan`, which is `0.0.0.0`.
 *
 * `0.0.0.0` is the right answer on a desktop and is deliberately the default:
 * a phone on the same wifi dials this machine's LAN address, and narrowing
 * the bind to fix a cloud box would silently break the product's headline
 * feature on every laptop it ships to. So the default is exactly what it has
 * always been, and the narrowing is opt-in.
 *
 * It is opt-in because "your network" stopped meaning one thing. On a rented
 * box the same `0.0.0.0` is the public internet minus a security-group rule,
 * and this deployment's entire claim is that there is no public ingress. A
 * bearer token on every route is not the point: the listener itself is.
 *
 *   lan       0.0.0.0 — the default, and what a phone pairs against
 *   loopback  127.0.0.1 — nothing off-machine; put `tailscale serve` in front
 *   tailnet   the 100.64.0.0/10 address, and only that address
 *   off       no device door at all, not even on loopback
 *
 * `off` exists because loopback is not the same claim as absent, and a
 * headless deployment should be able to make the stronger one. The browser
 * door (8813) and the control page (8811) are unaffected by this, so `off` on
 * a cloud box still leaves the way in that box actually uses.
 *
 * Three things are fail-closed here, and all three are the browser door's
 * precedent applied to this one:
 *   - `tailnet` with no trustworthy tailnet address REFUSES TO START. It does
 *     not fall back to loopback and it certainly does not fall back to
 *     0.0.0.0. Someone who wrote `tailnet` down meant that address or nothing.
 *   - an unrecognised value REFUSES TO START rather than taking the default.
 *     This is stricter than `MURAGE_BROWSER_BIND` below, deliberately: there
 *     the unknown value lands on `auto`, which is narrow, and here it would
 *     land on `0.0.0.0`, which is the widest thing this process can do. A
 *     typo in a security control must never resolve outward.
 *   - there is no `auto`. The browser door has one because the right answer
 *     genuinely varies with whether Tailscale is up; this door's right answer
 *     on a desktop is always the LAN, and a mode that sometimes narrowed it
 *     would break pairing on the machines least able to explain why. */
type CompanionBindMode = "lan" | "loopback" | "tailnet" | "off";
const COMPANION_BIND_RAW = (process.env.MURAGE_COMPANION_BIND ?? "").trim().toLowerCase();
/** The parsed mode, or null for a value that is not one of the four. Parsed
 * here and rejected in `main`, so the refusal prints as a sentence rather
 * than as a module-scope stack trace. */
const COMPANION_BIND: CompanionBindMode | null =
  COMPANION_BIND_RAW === "" || COMPANION_BIND_RAW === "lan" ? "lan"
  : COMPANION_BIND_RAW === "loopback" ? "loopback"
  : COMPANION_BIND_RAW === "tailnet" ? "tailnet"
  : COMPANION_BIND_RAW === "off" ? "off"
  : null;
/** 8813, and not 8812. `electron/companion-origin-gateway.mjs:12` already
 * owns 8812 for the managed loopback gateway, so the security plan's ACL
 * example — which says 8812 — would have put the browser door on top of it. */
const BROWSER_PORT = num(process.env.MURAGE_BROWSER_PORT, 8813);
/** `loopback` puts `tailscale serve` in front (it terminates TLS and dials
 * the backend over 127.0.0.1 — measured); `tailnet` binds the 100.64.0.0/10
 * address directly. THIS door never binds 0.0.0.0 in any mode — the device
 * door above does, by default, which is a different door with a different
 * credential and a different reason (see `MURAGE_COMPANION_BIND`). `tailnet`
 * with no tailnet address refuses to start rather than falling back.
 *
 * Unset is `auto`, and that is what the desktop app forks with: the tailnet
 * address when there is a trustworthy one, loopback when there is not. The
 * two named modes stay exactly as strict as they were — an operator who wrote
 * one of them down meant it — but neither of them is a sane *default*.
 * `loopback` as the default is what left a signed-in tailnet with a door on
 * 127.0.0.1 and nothing in front of it, and `tailnet` as the default would
 * refuse to start on a machine that has not signed into Tailscale yet. */
const BROWSER_BIND: BrowserBindMode =
  process.env.MURAGE_BROWSER_BIND === "tailnet" ? "tailnet"
  : process.env.MURAGE_BROWSER_BIND === "loopback" ? "loopback"
  : "auto";
/** `https` once the tailnet has certificates and serve is in front — it
 * decides the cookie name (`__Host-`) and whether `Secure` is set.
 *
 * Configured, never derived from `X-Forwarded-Proto`. `tailscale serve` was
 * measured to strip a client-supplied copy of that header, but the door also
 * accepts direct connections, and a cookie attribute that a request header
 * can flip is not an attribute. */
const BROWSER_SCHEME: BoundIdentity["scheme"] = process.env.MURAGE_BROWSER_SCHEME === "https" ? "https" : "http";
/** The proxy standing in front of the door, when one was put there.
 *
 * The parent may supply a boot hint. Before binding, and before each rebind,
 * a read-only Serve observation replaces it with the currently owned front.
 * Loopback alone is never evidence of HTTPS.
 *
 * Two things follow from it, and both are the point:
 *   - `/state` advertises the front's address, so the QR is the portless
 *     `https://<name>/enter#…` a phone or a laptop can actually open, not
 *     `https://<name>:8813` which the certificate does not cover.
 *   - the front's scheme decides the session cookie, because the browser's
 *     view of the connection is the one the cookie has to match. */
let BROWSER_FRONT = browserFront(process.env.MURAGE_BROWSER_PUBLIC_ORIGIN);
/** What a browser sees. The front's scheme when there is a front, because
 * `serve` terminates TLS and the client is on HTTPS whatever this process
 * bound. Falls back to the configured scheme when nothing is in front. */
let BROWSER_CLIENT_SCHEME: BoundIdentity["scheme"] = BROWSER_FRONT?.scheme ?? BROWSER_SCHEME;
const SERVICE_TYPE = "_murage._tcp";
let hostedUrl = hostedCompanionUrl(process.env.MURAGE_COMPANION_HOSTED_URL);
const PRIVATE_ORIGIN = companionOriginSocket(process.env.MURAGE_COMPANION_INTERNAL_ORIGIN);

/** Ports the harness takes for itself, and what it uses each for.
 *
 * Checked up front rather than left to EADDRINUSE, because the collision is
 * a race and the loser is whoever started second: bind first and the harness
 * reports its webhook receiver unavailable instead, which surfaces nowhere
 * near here. "Port 8800 is the webhook receiver" is a sentence someone can
 * act on; "address already in use" sends them to `lsof`. */
const HARNESS_PORTS = new Map([
  [HARNESS_PORT, "the harness itself"],
  [WEBHOOK_PORT, "the harness's webhook receiver"],
]);

/** The address the browser door's socket is actually bound to, or null while
 * it is not listening.
 *
 * Tracked rather than derived from `BROWSER_BIND`: the bind mode says what was
 * asked for, and this says what happened. They differ in the case that
 * matters — a door asked to prefer the tailnet on a machine that had none at
 * boot is bound to loopback, and reporting the intention would tell a phone to
 * dial an address nothing is listening on. */
let browserBoundHost: string | null = null;

/** Where a phone points its browser, for `GET /state`. Recomputed per request:
 * the MagicDNS name can land after boot, and the door can be re-bound under a
 * running sidecar without the port or scheme changing. */
const browserDoor = () =>
  browserDoorLocation(
    BROWSER_CLIENT_SCHEME,
    BROWSER_PORT,
    browserBoundHost,
    browserBoundHost === "127.0.0.1" ? null : tailnetName(),
    browserBoundHost === "127.0.0.1" ? null : tailscaleAddress(),
    BROWSER_FRONT,
  );

/** Every authority the browser door will answer to, and nothing else.
 *
 * Read per request rather than captured: the tailnet address can change under
 * a running sidecar (a Tailscale restart, a re-auth, a node key rotation) and
 * a captured set would then refuse the very host the door is bound to.
 *
 * Loopback is in the set only when the door is bound to loopback, which is
 * the `tailscale serve` arrangement: serve forwards the client's `Host`
 * intact, so the MagicDNS name has to be accepted there too. */
const browserIdentity = (): BoundIdentity => {
  const hosts = new Set<string>();
  const name = tailnetName();
  if (name) hosts.add(name.toLowerCase());
  const tailnet = tailscaleAddress();
  if (tailnet) hosts.add(tailnet);
  // Keyed on where the door is actually bound, not on what was asked for.
  // Under `auto` those differ exactly when it matters: a door that fell back
  // to loopback must still answer to `localhost`, and one that reached the
  // tailnet must not start trusting a loopback Host it can no longer be
  // reached on.
  if (browserBoundHost === null ? BROWSER_BIND !== "tailnet" : browserBoundHost === "127.0.0.1") {
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]"]) hosts.add(host);
  }
  // The proxy forwards the client's Host intact, so the name it answers on
  // has to be in the door's allowlist. Added independently of `tailnetName()`
  // rather than relying on it: the MagicDNS probe can fail — a CLI that is
  // not where we looked, a `status --json` that timed out — on a machine
  // where `serve` is working perfectly, and a door that then 403s every
  // request through its own proxy is the worst version of this.
  if (BROWSER_FRONT) hosts.add(BROWSER_FRONT.host);
  for (const extra of (process.env.MURAGE_BROWSER_HOSTS ?? "").split(",")) {
    const trimmed = extra.trim().toLowerCase();
    if (trimmed) hosts.add(trimmed);
  }
  return { scheme: BROWSER_CLIENT_SCHEME, hosts };
};

/** Where the DEVICE door binds, or null when it is not to be opened at all.
 *
 * Called once, from `main`, and after the tailnet probe — `tailnet` mode has
 * nothing to resolve until Tailscale has been asked. Unlike the browser door
 * this never re-binds: the browser door moves because `tailscale serve` is
 * routinely turned on minutes after Murage starts, and a phone pairing over
 * the LAN has no equivalent event to wait for.
 *
 * `tailnetBindAddress` is the browser door's own resolver, imported rather
 * than reimplemented. It is the part that refuses a 100.64.0.0/10 address
 * that Tailscale and the interface table disagree about — CGNAT space is not
 * Tailscale's, and binding the wrong 100.64 address opens this door on a
 * network nobody chose. Two doors deciding that differently is how one of
 * them ends up wrong. */
const companionBindHost = (): string | null => {
  switch (COMPANION_BIND) {
    case "off":
      return null;
    case "loopback":
      return "127.0.0.1";
    case "tailnet": {
      const resolved = tailnetBindAddress(tailscaleAddress(), tailnetSelfAddress());
      if ("address" in resolved) return resolved.address;
      // Fail closed. Not loopback, which would be a door the operator did not
      // ask for, and emphatically not 0.0.0.0, which on the box that sets
      // this variable is the public internet.
      throw new Error(
        `MURAGE_COMPANION_BIND=tailnet, and the device door cannot bind the Tailscale address: ` +
          `${resolved.refused}. Bring Tailscale up, or set MURAGE_COMPANION_BIND=off to run with ` +
          `no device door at all. It will not fall back to a wider address.`,
      );
    }
    default:
      return "0.0.0.0";
  }
};

/** Where the door should be bound right now, given Tailscale as it is right
 * now. Throws only in the explicit `tailnet` mode. */
const desiredBrowserBindHost = (): string =>
  BROWSER_FRONT ? "127.0.0.1" : browserBindHost(BROWSER_BIND, tailscaleAddress(), tailnetSelfAddress(), (reason) =>
    console.log(`browser door staying on loopback: ${reason}`),
  );

/** A sentence naming what already owns this port, or null when nothing does. */
const conflict = (name: string, port: number): string | null => {
  const owner = HARNESS_PORTS.get(port);
  return owner ? `${name} is set to port ${port}, which is ${owner}` : null;
};

/** What the phone sees this computer called.
 *
 * Asked of the harness rather than invented here: it already knows whose
 * computer this is, from the profile collected during onboarding, and the
 * built-in companion used exactly this. A phone that paired before the move
 * should not suddenly find a differently-named computer in its list.
 *
 * Read once at startup and cached. An override wins, and a harness that is
 * not up or has no profile falls back rather than blocking — the name is a
 * label, and no part of pairing depends on it. */
let cachedName = process.env.MURAGE_COMPANION_NAME?.trim() || "";

/** What this computer is called on the phone. Never empty. */
const machineName = (): string => cachedName || "Murage";

/** Ask the harness whose computer this is, once, at startup. Every failure
 * is survivable: the name is a label, and no part of pairing depends on it. */
async function refreshMachineName(): Promise<void> {
  if (cachedName) return; // an explicit override is not ours to second-guess
  try {
    const res = await fetch(`http://127.0.0.1:${HARNESS_PORT}/api/config`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const config = (await res.json()) as { profile?: { name?: string } };
    const owner = config.profile?.name?.trim();
    if (owner) cachedName = `${owner}'s computer`;
  } catch {
    /* not up, or no profile — "Murage" is a fine thing to be called */
  }
}

const devices = new DeviceRegistry();
const mdns = new MdnsResponder();

/** ONE sign-in limiter, handed to both doors.
 *
 * `createProxyHandler` and `createBrowserHandler` each default to a private
 * limiter, which meant a client that burned its budget guessing pairing codes
 * on the device port arrived at the browser door with a full budget and did
 * it again. Two doors, one credential — the six-digit code redeems at either
 * — so a lockout that only holds at the door it was earned at is half a
 * lockout, and the half an attacker gets to choose.
 *
 * Constructed here rather than inside either door because neither of them can
 * own it: the shared thing has to be built by the thing that builds both. It
 * lives as long as this process and is in memory on purpose — a lockout that
 * survived a restart would need a file, and a file an unauthenticated peer
 * can provoke writes to is the worse trade. */
const signInLimiter = createSignInLimiter();

/** Keeps the Bonjour record matching the interface table: advertise when a
 * network appears, re-advertise when DHCP moves us, withdraw when it goes —
 * so `mdns.advertising` stays a true statement rather than a boot-time one. */
const watcher = createAddressWatcher({
  addresses: advertisableAddresses,
  // service() reads the current addresses, so a re-advertise carries them
  advertise: () => mdns.advertise(service()),
  withdraw: () => mdns.stop(),
  log: (line) => console.log(`bonjour: ${line}`),
});

/** This machine as a Bonjour record: one DNS label, the device port, and the
 * addresses a phone could reach it on. */
const service = (): ServiceInfo => ({
  // one DNS label: no dots, and inside the 63-byte limit
  name: dnsLabel(machineName()),
  type: SERVICE_TYPE,
  port: COMPANION_PORT,
  host: defaultHostName(),
  addresses: advertisableAddresses(),
  // TXT entries cap at 255 bytes, and this one is user-supplied — measured in
  // bytes, since that is the unit the wire format actually counts in, and
  // `slice` counts UTF-16 code units.
  txt: ["v=1", `name=${clampBytes(machineName(), 200)}`],
});

const connectedDevices = createConnectedDeviceTracker();
const proxy = createProxyHandler({
    harnessPort: HARNESS_PORT,
    companionToken,
    // `authenticate` also stamps lastSeenAt, which is what makes the control
    // page able to say when a phone was last heard from.
    authenticate: (token) => devices.authenticate(token),
    redeem: (code, deviceName, pairRequestId) => devices.redeem(code, deviceName, pairRequestId),
    serverName: machineName,
    // Recomputed per pairing rather than cached: addresses change when the
    // machine joins another network, and a pairing is exactly the moment the
    // list has to be right.
    hosts: () => hostCandidates(),
    endpoints: () => companionEndpointCandidates(COMPANION_PORT, undefined, undefined, hostedUrl),
    connected: connectedDevices.open,
    // The same instance the browser door gets, three lines down. Not a copy.
    signInLimiter,
  });
const companion = createServer(proxy);
const managedOrigin = PRIVATE_ORIGIN ? createServer(proxy) : null;

/** The browser door. A different handler in a different file, on purpose:
 * anything bolted onto `proxy` above is on the device port *and* the
 * tunnel-fronted managed origin by default, which is the exact failure this
 * separation exists to prevent. */
const browserRequests = createBrowserHandler({
  harnessPort: HARNESS_PORT,
  companionToken,
  identity: browserIdentity,
  devices,
  connected: connectedDevices.open,
  // The same instance the device door got. A lockout earned at either door
  // is spent at both, which is the only reading of "locked out" that means
  // anything when one credential opens two doors.
  signInLimiter,
});
/** The headless installer's "is this my door?" check (see `door-identity.ts`).
 * Answered before the door's own routing, so it rides on whatever the request
 * gets back. Inert unless an installer handed this process a nonce. */
const browser = createServer((req, res) => {
  answerDoorChallenge(req, res, doorIdentity);
  return browserRequests(req, res);
});

// A startup invariant, not a comment. index.ts once had two listeners on one
// handler, and that is how a device route becomes a public route without
// anyone deciding it.
if (managedOrigin && managedOrigin.listeners("request")[0] === browser.listeners("request")[0]) {
  throw new Error("the managed origin and the browser door share a request handler");
}

const control = createControlServer({
  devices,
  companionPort: COMPANION_PORT,
  hostedUrl: () => hostedUrl,
  setHostedUrl: (next) => {
    hostedUrl = next;
  },
  discovery: () => ({ advertising: mdns.advertising, name: service().name }),
  connectedDeviceIds: connectedDevices.ids,
  disconnectDevice: connectedDevices.disconnect,
  // The startup probe below is not the last word. Tailscale brought up after
  // this process started would otherwise read as absent for the lifetime of
  // the app; `refreshTailnetName` coalesces, so a click during the startup
  // hunt joins it rather than racing it.
  // Two steps, and the second is the point. Re-reading the MagicDNS name
  // fixes the *label*; moving the door fixes the *route*. Someone who
  // installs Tailscale while Murage is running and clicks "check again" wants
  // a door on the tailnet, not a correctly spelled name for a door that is
  // still only on loopback. The control route awaits this before it replies,
  // so the state it sends back describes the door as it now is.
  refreshTailscale: async () => {
    const deadline = Date.now() + TAILSCALE_BUDGET_MS;
    await refreshTailnetName();
    await moveBrowserDoor(deadline);
  },
  browserDoor,
});

/** Put the door where Tailscale now says it should be, without restarting
 * anything else. Nothing here can throw: it is called from a request handler
 * and from startup, and a door that could not move is a log line, not a dead
 * sidecar. */
let browserMove: Promise<void> | null = null;
function moveBrowserDoor(deadline?: number): Promise<void> {
  if (browserMove) return browserMove;
  const moving = (async () => {
    const observed = await refreshBrowserServe(BROWSER_PORT, {deadline});
    BROWSER_FRONT = observed.owner === "ours" ? browserFront(observed.origin) : null;
    BROWSER_CLIENT_SCHEME = BROWSER_FRONT?.scheme ?? "http";
    if (observed.problem) console.warn(`browser HTTPS: ${observed.problem}`);
    const preserveHost = observed.owner === "other" || observed.owner === "unknown" ? browserBoundHost : null;
    const result = await rebindBrowserDoor({
      server: browser,
      port: BROWSER_PORT,
      boundHost: browserBoundHost,
      desiredHost: () => preserveHost ?? desiredBrowserBindHost(),
      listen,
    });
    browserBoundHost = result.host;
    if (BROWSER_FRONT && result.host !== "127.0.0.1") {
      BROWSER_FRONT = null;
      BROWSER_CLIENT_SCHEME = "http";
      console.warn("browser HTTPS: the owned proxy could not be matched to a loopback listener; HTTPS is not advertised.");
    }
    if (!result.note.startsWith("already bound")) console.log(`browser door: ${result.note}`);
  })().finally(()=>{ if (browserMove === moving) browserMove = null; });
  browserMove = moving;
  return moving;
}

/** Bind a server, turning a bind failure into a sentence rather than a stack
 * trace, and leaving a handler behind for the errors that come after. */
const listen = (server: ReturnType<typeof createServer>, port: number, host: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      // A second copy of the sidecar is the usual cause once the harness's
      // own ports are ruled out above, and "close whatever is using it"
      // sends someone hunting through `lsof` for a process they started.
      const hint = ` — another copy of the companion may already be running; ${
        port === COMPANION_PORT
          ? "MURAGE_COMPANION_PORT"
          : port === BROWSER_PORT
            ? "MURAGE_BROWSER_PORT"
            : "MURAGE_CONTROL_PORT"
      } chooses a different one`;
      reject(
        error.code === "EADDRINUSE"
          ? new Error(`port ${port} is already in use${hint}`)
          : error,
      );
    };
    const onListening = () => {
      server.removeListener("error", onError);
      // Bound is not safe, and removing the startup handler while leaving
      // nothing in its place is how a running sidecar dies later. A listening
      // socket still emits `error` — EMFILE on accept, or an interface
      // disappearing under it — and an `error` with no listener is re-thrown
      // as an uncaught exception, which here means the sidecar dies and every
      // paired phone loses the machine over one refused connection. It is
      // worth a line on stderr and nothing more: the other listener, and
      // every connection on this one, carry on.
      server.on("error", (error: NodeJS.ErrnoException) => {
        console.warn(`companion: error on ${host}:${port} — ${error.message}`);
      });
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

/** Start the socket arrangement, in the order that makes a failure legible:
 * refuse an unreadable bind mode, refuse impossible ports, bind, learn this
 * machine's name, then advertise and print where to point the phone.
 *
 * Three sockets on a desktop, and as few as two on a headless box —
 * `MURAGE_COMPANION_BIND=off` leaves the control page and the browser door,
 * which is the whole arrangement that deployment actually uses. */
async function main(): Promise<void> {
  // Before anything binds. An unreadable bind mode is not a thing to warn
  // about and carry on from: carrying on means 0.0.0.0, and the person who
  // typed it was trying to avoid exactly that.
  if (COMPANION_BIND === null) {
    throw new Error(
      `MURAGE_COMPANION_BIND is set to "${COMPANION_BIND_RAW}", which is not one of ` +
        `lan, loopback, tailnet, off. Refusing to start rather than guessing — the guess would be ` +
        `"lan", which binds 0.0.0.0.`,
    );
  }
  // The device door may not exist at all, and a port nothing binds cannot
  // collide with anything. Checking it anyway would refuse to start a
  // perfectly good `off` deployment over an imaginary conflict.
  const deviceDoorOpen = COMPANION_BIND !== "off";
  const clash =
    (deviceDoorOpen ? conflict("MURAGE_COMPANION_PORT", COMPANION_PORT) : null) ??
    conflict("MURAGE_CONTROL_PORT", CONTROL_PORT) ??
    conflict("MURAGE_BROWSER_PORT", BROWSER_PORT);
  if (clash) throw new Error(`${clash}. Pick another port.`);
  if ((deviceDoorOpen && BROWSER_PORT === COMPANION_PORT) || BROWSER_PORT === CONTROL_PORT) {
    throw new Error(
      `MURAGE_BROWSER_PORT is set to port ${BROWSER_PORT}, which another sidecar socket already uses. ` +
        `The doors do not share a socket: they do not share an allowlist, a credential, or an origin policy. ` +
        `Pick another port.`,
    );
  }

  // The sidecar's own two ports, for the same reason as the harness's: bound
  // in order, the second one loses with a bare EADDRINUSE that reads as
  // "something else is using it" when the something else is this process.
  // Worth naming even though the hosts differ — 127.0.0.1 and 0.0.0.0 on one
  // port collide, and if they somehow did not the control plane would be
  // sharing a socket with the device port, which is the one thing the three
  // sockets exist to prevent.
  if (deviceDoorOpen && COMPANION_PORT === CONTROL_PORT) {
    throw new Error(
      `MURAGE_COMPANION_PORT and MURAGE_CONTROL_PORT are both port ${COMPANION_PORT}, and they cannot share one: ` +
        `the first is open to your network and the second must never be. Pick another port.`,
    );
  }

  await listen(control, CONTROL_PORT, "127.0.0.1");
  if (managedOrigin && PRIVATE_ORIGIN) {
    await listenCompanionOrigin(managedOrigin, PRIVATE_ORIGIN);
  }

  // Before advertising: the service name goes into the Bonjour record, and
  // re-advertising under a new name later would show the phone two computers.
  await refreshMachineName();

  // Asking Tailscale costs a subprocess, so it happens here rather than per
  // request. Not once, though — `POST /tailscale/refresh` asks again, because
  // Tailscale is commonly installed or signed into after this point. Silent
  // on every failure: not installed, not logged in, not running all just mean
  // "no name", and the address still works.
  const tailscaleTried: string[] = [];
  await refreshTailnetName((cli, outcome) => tailscaleTried.push(`  ${cli} — ${outcome}`)).catch(() => {});

  // After the tailnet name, because the bind host and the door's own host
  // allowlist both depend on it. Under `auto` a machine with no tailnet gets
  // loopback and the door still comes up; under the explicit `tailnet` mode
  // this throws rather than falling back, which is what that mode is for.
  // Tailscale arriving later moves the door — see `moveBrowserDoor`.
  await moveBrowserDoor();
  if (!browserBoundHost) {
    desiredBrowserBindHost(); // Preserve the explicit-tailnet refusal detail.
    throw new Error("the browser door could not bind; see its startup diagnostic");
  }

  // After the tailnet probe for the same reason the browser door is: the
  // `tailnet` mode has no address to bind until Tailscale has been asked.
  // Later in the sequence than it used to be, and nothing between here and
  // the top depends on the device socket — the control page, the managed
  // origin and the machine-name lookup are all independent of it.
  const deviceHost = companionBindHost();
  if (deviceHost !== null) await listen(companion, COMPANION_PORT, deviceHost);

  // Discovery failing is not an error anyone has to fix — port 5353 taken by
  // another responder, multicast off, a guest network that isolates its
  // clients. Pairing by typed address still works, and the control page says
  // so rather than pretending the list will fill in.
  //
  // Through the watcher rather than a single advertise: a laptop opened
  // before wifi associates has no addresses yet, and addresses change under
  // a running sidecar. The first check advertises (or says why not), and the
  // interval re-advertises on every change after that.
  // Only when something off this machine could actually reach the port the
  // record names. A Bonjour A record pointing at a door bound to 127.0.0.1 —
  // or to nothing — is not a discovery aid, it is a phone dialling a refused
  // connection and blaming the wifi.
  if (deviceHost === "0.0.0.0" || COMPANION_BIND === "tailnet") {
    await watcher.check();
    watcher.start();
  } else {
    console.log(`bonjour: not advertising — the device door is ${deviceHost === null ? "off" : "on loopback only"}`);
  }

  const addresses = lanAddresses();
  const tailscale = tailscaleAddress(addresses);
  const reach = tailnetName() ?? tailscale ?? addresses[0];
  console.log(
    deviceHost === null
      ? `companion  not listening  (MURAGE_COMPANION_BIND=off)`
      : `companion  http://${deviceHost}:${COMPANION_PORT}  →  harness 127.0.0.1:${HARNESS_PORT}`,
  );
  console.log(`pair here  http://127.0.0.1:${CONTROL_PORT}`);
  // Where it is bound, not where it was asked to bind. Under `auto` those
  // differ on exactly the machines where the difference matters.
  const door = browserDoor();
  console.log(
    `browser    ${door ? `${door.scheme}://${door.host}:${door.port}/enter` : "not listening"}` +
      (browserBoundHost === "127.0.0.1" ? "  (put `tailscale serve` in front — never `funnel`)" : ""),
  );
  // Only when a phone could actually get there. Printing an address for a
  // door bound to loopback is the same lie the Bonjour record would have been.
  if (reach && deviceHost === "0.0.0.0") console.log(`on your phone, enter  ${reach}:${COMPANION_PORT}`);
  if (tailscale && !tailnetName()) {
    // Do not tell someone to turn on MagicDNS when they may well have it on
    // already — say what was actually tried, so the difference between "off"
    // and "we could not find the CLI" is visible instead of guessed at.
    console.log("no MagicDNS name found. Tailscale CLI attempts:");
    for (const line of tailscaleTried) console.log(line);
  }
}

/** Withdraw the Bonjour record, drop the sockets, exit. Stopping this process
 * is the off switch, so it has to actually stop. */
const shutdown = async (signal: string): Promise<void> => {
  console.log(`\n${signal} — stopping`);
  // the watcher first, or a tick could re-advertise the record the next
  // line just withdrew
  watcher.stop();
  await mdns.stop().catch(() => {});
  // close() waits for open connections, and an SSE stream never ends on its
  // own — drop the sockets so "stop" means stopped, now.
  companion.closeAllConnections?.();
  control.closeAllConnections?.();
  browser.closeAllConnections?.();
  managedOrigin?.closeAllConnections?.();
  await Promise.all([
    new Promise<void>((r) => companion.close(() => r())),
    new Promise<void>((r) => control.close(() => r())),
    new Promise<void>((r) => browser.close(() => r())),
    ...(managedOrigin ? [new Promise<void>((r) => managedOrigin.close(() => r()))] : []),
  ]);
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
