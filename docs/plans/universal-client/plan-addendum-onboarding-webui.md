# Addendum — the onboarding step and the WebUI toggle

**From Sean, 2026-09-02.** Fold into the master plan; the design tracks were already running when this
arrived.

## The ask

The onboarding step that currently offers to install the iOS app becomes the **security** step instead:

> *"Do you want to connect your phone or another device?"* — and separately, *"do you want the web UI
> enabled at all?"*, with the WebUI **off by default** and turned on in the backend, the way Wayland does it.

This is not cosmetic. It reframes the moment: today it asks the user to install an app, which is a
distribution ask. The replacement asks the user to make a security decision, which is the honest framing
for something that opens a door.

## The slot already exists

`src/components/Onboarding.tsx:8, :349` already renders `PhoneSetupFlow` as a step, with
`track("phone_setup_skipped")` and `track("phone_setup_completed")` at `:353` and `:357`. The comment at
`:13` says the step "can always be resumed from Settings → Phone." So this is a **replacement of that
step's content**, not a new step, and the resume-from-settings affordance already exists and should be
kept pointing at the new flow.

## Wayland has shipped this exact pattern — port it, do not invent it

| Piece | Wayland | Note |
|---|---|---|
| Off by default | `webserver/index.ts:256` `startWebServerWithInstance(port, allowRemote = false)` | the default is the safe one |
| Settings surface | `renderer/components/settings/SettingsModal/contents/WebuiModalContent.tsx` | a `Switch`, a port, a status |
| Connect by QR | `QRCodeSVGLazy` in that file; server side `webserver/index.ts:179` `generateQRLoginUrlDirect(port, allowRemote)` | QR generated when the server starts |
| Server-rendered login | `webserver/routes/authRoutes.ts:573` `GET /qr-login` → POST `/api/auth/qr-login` (`:525`), nonce-gated inline script | Ferrox's own fix for AionUi, whose `/qr-login` falls through to a HashRouter SPA with no such route |
| Status to the UI | `IWebUIStatus` over `common/adapter/ipcBridge` | |

**The find that matters most: `withCsrfToken` from `@process/webserver/middleware/csrfClient`**, imported at
`WebuiModalContent.tsx:22`. The security track was asked to design a replacement for Murage's
`content-type: application/json` gates, which become decorative the moment a browser is same-origin with
the harness. Wayland already has a real CSRF layer. **Read it before designing anything new.**

## What Murage must NOT copy from Wayland here

- Wayland's QR mints an **unscoped admin session** — `bridge/webuiQR.ts` fetches
  `UserRepository.getPrimaryWebUIUser()` and issues that user's full session, no device identity, no
  per-device revocation. Murage's `companion/src/devices.ts` is already better (32-byte random, SHA-256 at
  rest, `timingSafeEqual`, 120s TTL, 5 attempts, per-device revocation). **Keep Murage's device model and
  borrow only Wayland's browser-facing flow.**
- Wayland's `isLocalIP` (`webuiQR.ts:37-58`) omits `100.64.0.0/10`, the tailnet CGNAT range, and the gate is
  disabled entirely in remote mode (`:72`). Do not reproduce either.
- Wayland points `tailscale funnel` (public ingress) at the port that also serves its WebUI. Filed as a bug
  in `~/dev/wayland/docs/bugs/2026-09-01-webui-exposed-by-webhook-tunnel.md`. Murage must never front a
  UI-serving or harness-serving port with a tunnel.

## The two questions, and why they are separate

They are different decisions and the UI must not conflate them:

1. **"Enable the web UI?"** — does this machine answer a browser at all. Off by default. This is the door.
2. **"Connect a device?"** — pair a specific phone or laptop, which issues that device its own credential
   with its own revocation. This is the key.

Answering yes to (2) implies (1), but yes to (1) alone is a real state: a laptop on the same tailnet with no
pairing yet. Model both.

## Copy direction

The step should say what actually happens, not sell a feature. It opens a door on the user's own machine,
so the honest framing is the reassuring one:

- Name the perimeter plainly — reachable over your Tailscale network, not the internet.
- Say the default: off until you turn it on, and it can be turned off again here.
- Say what a connected device can and cannot do, because the answer is genuinely reassuring: read and reply,
  approve requests — not change engine settings, install skills, or reach the computer.
- Per-device revocation is the sentence that closes it: lose the phone, revoke that one device, everything
  else keeps working.

Avoid the word "install". Nothing is installed. Avoid "server" as the user-facing noun.

## Where this lands in the sequence

This is the **user-facing half of the security track**, so it ships with it, not before. It is worth
noting that this step is also the natural home for the PWA's "add to home screen" prompt: the user has just
scanned a QR on their phone, the browser is already open on the right page, and that is the only moment they
will ever be one tap from installing it.
