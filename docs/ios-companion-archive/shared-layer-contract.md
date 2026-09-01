# The shared layer, as the retired client described it

Extracted from `docs/ios-companion.md` (deleted in A6) before deletion. These
are the sections that describe the **protocol both ends speak** — connectivity
routes, the pairing and device-security contract, and the stream/state model.
The Xcode, SwiftPM, simulator, and release-sequencing halves of that file were
deliberately left out; they died with the client.

The full original is kept verbatim at `reference/ios-companion.md` for anything
this extract clipped.

One line below is now **false** and is marked inline: the ATS claim in
"Tailscale". See `ats-decision-record.md`.

---

## Connectivity

### Same Wi-Fi

The QR code is still the primary path on the same Wi-Fi. If it is unavailable,
the user can open **Other ways to connect** and choose a nearby computer or
enter the address shown in desktop Phone settings. Nearby discovery does not
run until the user opens that fallback.

Nearby discovery uses Bonjour and direct LAN traffic. Use it only on a network
you trust.

Choosing a nearby computer or manually entering a LAN address is therefore an
explicit fallback. Once the app is using a hosted or Tailscale route,
automatic reconnection stays within those protected transports. Moving back to
direct LAN requires choosing that computer or address again.

### Tailscale

Tailscale is an optional route away from home and on Wi-Fi networks that
isolate clients. When both devices share a tailnet, choose **Pair over
Tailscale** in the desktop setup alternatives. Murage then places the
Mac's MagicDNS name in that dedicated QR; it never silently replaces the
default hosted HTTPS route. Manual entry remains available as a fallback.

The URL is still `http`, but the path is encrypted and authenticated by
WireGuard inside the tailnet. Use the MagicDNS name rather than the
`100.64.0.0/10` address: App Transport Security exceptions are domain-based,
and `ios/project.yml` narrowly allows insecure HTTP for `ts.net` subdomains.
> **No longer true for the browser door (A7).** The ATS rule above was an Apple
> client constraint. A browser has no equivalent, so the bare `100.64.0.0/10`
> address is a working candidate again and `hostCandidates()` now emits it.
> See `ats-decision-record.md`.

Tailscale is optional. The direct path does not use an Murage-operated
relay or create a cloud copy of local transcript data.

### Optional hosted HTTPS

In desktop **Settings → Phone**, **Use your phone anywhere** accepts a
passwordless email code and provisions one HTTPS address for that computer.
This desktop sign-in is only for hosted HTTPS. The iPhone never signs in; it
trusts the computer through the same pairing QR. Nearby, manual, and Tailscale
connections continue to work without an account.

The desktop runs an outbound connector to Cloudflare, so no inbound router
configuration or Tailscale installation is required. The hosted address is
included in a pairing invitation only after it is ready. The default setup
waits for that HTTPS address instead of silently substituting Tailscale;
Tailscale pairing remains an explicit choice under the alternative routes.

Cloudflare terminates and proxies the encrypted connection to the connector.
The Murage control plane stores account and installation metadata plus
opaque tunnel/DNS identifiers in D1, but not bots, transcripts, approvals,
screen frames, pairing tokens, or connector tokens. See `docs/ios-privacy.md`
for data and deletion details.

The connector does not point at the reusable LAN port. Electron launches one
private sidecar socket (or Windows pipe) and a guardian that owns both the
fixed loopback gateway and `cloudflared`. If Electron or that sidecar exits,
the guardian first makes forwarding unavailable, confirms the connector is
dead, and only then releases the gateway. Another process that later binds a
local port cannot inherit the public route.

## Pairing and device security

1. On the Mac, open **Settings → Phone**, turn on phone access, and choose
   **Set up a phone**.
2. On the iPhone, choose **Connect my computer** and scan the QR.
3. Confirm the computer name and the displayed transport — **HTTPS connection**,
   **Tailscale connection**, or **Trusted local connection**. The phone stores
   its trust securely in Keychain; no iPhone account is required.
4. If scanning is unavailable, open **Other ways to connect** for a nearby
   computer, manual address, or six-digit code.
5. Revoking the phone on the Mac removes its access and lets it pair again.

To add another Mac, open **Settings → Computers → Connect another computer**
on the iPhone and scan that Mac's QR. The existing computer stays usable if
the new pairing fails or is cancelled. Switching computers replaces the live
event stream and in-memory chat state, but keeps every saved pairing; removing
one computer deletes only that computer's Keychain credential from the phone.
An app upgrade migrates the previous single saved pairing automatically.

The Mac must remain awake with Murage running for chats, approvals, and
routines to work, including through hosted HTTPS or Tailscale.

After pairing, the phone periodically reads the authenticated, sidecar-owned
`GET /api/companion/endpoints` snapshot. This lets an existing phone learn a
new hosted address—or its withdrawal—without another pairing ceremony. The
route never reaches the harness and returns only the computer name plus a
bounded list of connection origins.

An Murage account is not required for nearby, manual, or Tailscale
connections. Only the desktop owner signs in when enabling the optional hosted
HTTPS route; the iPhone always uses the same QR trust flow.

The device-facing socket rejects browser `Origin` headers before reading a
token. Its route policy in `companion/src/routes.ts` is default-deny: a new
harness route remains unreachable until it is deliberately added.

Allowed in the first release:

- Read the fleet, rooms, instances, configuration status, and transcripts.
- Fetch settled screen images and opt into live screen frames.
- Request a fresh interactive cloud-desktop viewer only when the computer
  owner has enabled that capability for this specific paired phone.
- Send messages, interrupt bots, answer approvals/questions, and mark chats
  read.
- Create a basic bot.

The write surface uses purpose-built `read` and `always-allow` endpoints. The
general bot and room `PATCH` endpoints are not reachable through the sidecar.
An always-allow request succeeds only when its server-issued key is still on a
pending approval for that bot, so possession of a device token is not enough
to invent a broad execution grant.

Intentionally refused:

- API keys and provider configuration.
- Pairing, device revocation, or companion lifecycle control.
- Local VM lifecycle, webhooks, connectors, routines, team import/export, and
  internal peer-agent routes.
- Cloud computer provisioning, sleep, shell execution, and screenshot APIs.
  The phone receives only the fresh `join` viewer URL, never the provider key.
- New harness routes that have not been reviewed for phone access.

## Stream and state model

`CompanionCore` contains the wire models, client, raw-byte SSE parser, and pure
state fold. The SwiftUI target owns lifecycle and presentation only.

On connection, the server sends a `hello` frame containing a cursor and whether
the requested gap was replayed. The client:

1. resumes from its last `<streamId>:<seq>` cursor;
2. folds replayed and live frames when the gap is available;
3. hydrates the newest page of each visible conversation when it is not; and
4. paginates older transcript pages on demand.

Unknown message and frame kinds degrade safely instead of failing an entire
response, and one malformed fleet record does not hide every healthy chat.
Screen frames are off by default and enabled only while a computer view is
visible. Backgrounding keeps the stream for only the short grace period iOS
allows, then closes it; foregrounding reconnects from the saved cursor. A hello
cursor is committed only after a cold hydration succeeds; replayed streams
advance it one folded frame at a time, so a disconnect during recovery cannot
skip the remaining gap.
