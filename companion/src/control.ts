// The bit a person looks at: a small page on loopback for pairing a device
// and revoking one.
//
// This replaces the Settings → Companion panel that used to live inside the
// desktop app. Losing that panel is the real cost of moving out of the
// harness, and this is the honest replacement rather than a pretence that
// the cost is zero: it is a separate page at a separate address, and you
// have to know it exists.
//
// Loopback only, deliberately and non-negotiably. This surface can open a
// pairing window and revoke devices — it is the thing the companion listener
// refuses to expose to phones for exactly that reason. Serving it anywhere
// else would hand away the control plane the design just took care to
// withhold.
import { createServer, type Server, type ServerResponse } from "node:http";

import type { DeviceRegistry } from "./devices.ts";
import { lanAddresses, tailnetName, tailscaleAddress } from "./listener.ts";

export interface ControlOptions {
  devices: DeviceRegistry;
  /** Where a phone connects — for display, and for the pairing instructions. */
  companionPort: number;
  /** Whether Bonjour came up, and under what name. */
  discovery: () => { advertising: boolean; name: string };
}

/** `new URL()` keeps the brackets on an IPv6 hostname, so both spellings. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const json = (res: ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
};

export function companionState(options: ControlOptions) {
  const addresses = lanAddresses();
  const tailscale = tailscaleAddress(addresses);
  const name = tailnetName();
  const pairing = options.devices.pairing();
  return {
    port: options.companionPort,
    addresses,
    ...(tailscale ? { tailscale } : {}),
    ...(tailscale && name ? { tailnetName: name } : {}),
    lan: addresses.find((a) => a !== tailscale) ?? null,
    pairing: pairing ? { code: pairing.code, expiresAt: pairing.expiresAt } : null,
    devices: options.devices.list(),
    discovery: options.discovery(),
  };
}

export function createControlServer(options: ControlOptions): Server {
  return createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const method = req.method ?? "GET";

    // Belt and braces: this server binds 127.0.0.1, so a non-loopback Host
    // should be impossible. It is still worth refusing, because "impossible"
    // here rests on a bind argument three files away, and the cost of being
    // wrong is the control plane.
    const host = String(req.headers.host ?? "").split(":")[0].toLowerCase();
    if (host && host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]" && host !== "::1") {
      return json(res, 403, { error: "forbidden: loopback only" });
    }

    // The Host check above stops DNS rebinding, not CSRF. A POST from any page
    // on the internet is a *simple* request — no preflight, `mode: "no-cors"`
    // — and it arrives here with Host: 127.0.0.1 like any other. That page
    // cannot read the reply, but it does not need to: opening a pairing window
    // is the whole attack, and the code is then on screen for whoever is
    // watching. Origin is the one header page script cannot forge, so it is
    // where a browser somewhere else gets refused. The control page itself is
    // served from this origin, so it passes; a native client sends no Origin
    // at all and is unaffected.
    const origin = req.headers.origin;
    if (origin) {
      let originHost = "";
      try {
        // An opaque origin — a sandboxed frame, a data: URL — arrives as the
        // literal "null" and does not parse. That is not a pass: it is
        // precisely the shape an attacker reaches for, so it falls through to
        // the empty string and is refused with everything else foreign.
        originHost = new URL(String(origin)).hostname.toLowerCase();
      } catch {
        /* unparseable — treat as foreign */
      }
      if (!LOOPBACK_HOSTS.has(originHost)) {
        return json(res, 403, { error: "forbidden: cross-origin request" });
      }
    }

    if (method === "GET" && (path === "/" || path === "/index.html")) {
      const html = page();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html) });
      return res.end(html);
    }
    if (method === "GET" && path === "/state") return json(res, 200, companionState(options));
    if (method === "POST" && path === "/pairing") {
      const window = options.devices.openPairing();
      return json(res, 201, { ...companionState(options), code: window.code });
    }
    if (method === "DELETE" && path === "/pairing") {
      options.devices.closePairing();
      return json(res, 200, companionState(options));
    }
    const revoke = path.match(/^\/devices\/([\w-]+)$/);
    if (revoke && method === "DELETE") {
      if (!options.devices.revoke(revoke[1])) return json(res, 404, { error: "no such device" });
      return json(res, 200, companionState(options));
    }
    return json(res, 404, { error: `no route: ${method} ${path}` });
  });
}

/** One self-contained page. No build step and no assets on purpose — a
 * sidecar that needed bundling would be a much bigger thing to run. */
function page(): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenMausBot Companion</title>
<style>
  :root { color-scheme: light dark; --fg: #111; --dim: #666; --line: #0002; --bg: #fff; --card: #fafafa; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #eee; --dim: #999; --line: #fff2; --bg: #151515; --card: #1e1e1e; }
  }
  body { font: 15px/1.55 ui-sans-serif, system-ui, sans-serif; color: var(--fg); background: var(--bg);
         margin: 0; padding: 2.5rem 1.25rem; }
  main { max-width: 34rem; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin: 0 0 .35rem; }
  p.sub { color: var(--dim); margin: 0 0 1.75rem; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 12px;
            padding: 1rem 1.15rem; margin-bottom: 1rem; }
  h2 { font-size: .95rem; margin: 0 0 .5rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .code { font: 600 2rem/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .3em; }
  .dim { color: var(--dim); }
  button { font: inherit; padding: .4rem .8rem; border-radius: 8px; border: 1px solid var(--line);
           background: transparent; color: inherit; cursor: pointer; }
  button:hover { background: var(--line); }
  ul { list-style: none; padding: 0; margin: .5rem 0 0; }
  li { display: flex; align-items: center; gap: .75rem; padding: .5rem 0; border-top: 1px solid var(--line); }
  li .grow { flex: 1; min-width: 0; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
<main>
  <h1>OpenMausBot Companion</h1>
  <p class="sub">Your phone reaches this computer through here. Only pair a device you trust.</p>
  <section id="where"></section>
  <section id="pair"></section>
  <section id="devices"></section>
</main>
<script type="module">
const el = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ago = (at) => {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return m + " min ago";
  const h = Math.round(m / 60);
  return h < 24 ? h + " h ago" : Math.round(h / 24) + " d ago";
};

async function api(path, method) {
  const res = await fetch(path, { method: method ?? "GET" });
  return res.json();
}

function render(s) {
  // The tailnet name beats the address: iOS refuses plain HTTP to 100.64/10,
  // which is CGNAT space rather than one of the ranges its local-networking
  // exemption covers, and ATS exceptions match by name rather than subnet.
  const reach = s.tailnetName ?? s.tailscale ?? s.addresses[0];
  el("where").innerHTML =
    "<h2>Where to connect</h2>" +
    (reach
      ? "<p>Enter <code>" + esc(reach) + ":" + s.port + "</code> on your phone." +
        (s.tailnetName ? " That works from any network." : "") + "</p>"
      : "<p class=dim>No network address yet.</p>") +
    (s.tailnetName && s.lan ? "<p class=dim>On this network only: <code>" + esc(s.lan) + ":" + s.port + "</code></p>" : "") +
    (s.tailscale && !s.tailnetName
      ? "<p class=dim>On a tailnet, but this computer's MagicDNS name could not be read from Tailscale — either MagicDNS is off, or its command line tool is not where we looked. iPhones cannot connect to a bare tailnet address; the console output lists what was tried.</p>"
      : "") +
    (!s.tailscale
      ? "<p class=dim>Reachable on this network only. Install Tailscale on both this computer and your phone to reach it from anywhere — including networks that stop devices from seeing each other.</p>"
      : "") +
    (s.discovery.advertising
      ? "<p class=dim>Your phone can also find this computer as \\u201c" + esc(s.discovery.name) + "\\u201d.</p>"
      : "");

  el("pair").innerHTML = s.pairing
    ? "<h2>Pair a phone</h2><div class=code>" + esc(s.pairing.code) + "</div>" +
      "<p class=dim>Expires in <span id=left></span>s. Enter it on your phone.</p>" +
      "<button id=cancel>Cancel</button>"
    : "<h2>Pair a phone</h2><p class=dim>The code lasts two minutes.</p><button id=start>Start pairing</button>";

  el("devices").innerHTML =
    "<h2>Paired devices</h2>" +
    (s.devices.length
      ? "<ul>" + s.devices.map((d) =>
          "<li><div class='grow'><div class=name>" + esc(d.name) + "</div>" +
          "<div class=dim>Last seen " + ago(d.lastSeenAt) + "</div></div>" +
          "<button data-revoke='" + esc(d.id) + "'>Remove</button></li>").join("") + "</ul>"
      : "<p class=dim>No phones are paired yet.</p>");

  el("start")?.addEventListener("click", async () => render(await api("/pairing", "POST")));
  el("cancel")?.addEventListener("click", async () => render(await api("/pairing", "DELETE")));
  for (const b of document.querySelectorAll("[data-revoke]")) {
    b.addEventListener("click", async () => render(await api("/devices/" + b.dataset.revoke, "DELETE")));
  }
  if (s.pairing) {
    const tick = () => {
      const left = Math.max(0, Math.round((s.pairing.expiresAt - Date.now()) / 1000));
      const node = el("left");
      if (node) node.textContent = left;
    };
    tick();
  }
}

render(await api("/state"));
// While a code is on screen it has to count down — and the same tick is what
// notices the phone on the other end finishing the handshake.
setInterval(async () => render(await api("/state")), 1000);
</script>
`;
}
