# The paid tier, and the tunnel that already exists

**Status:** decided in principle, deliberately not built. Written 2026-09-02.
**Decision owner:** Sean.

## The question this answers

Sean asked, when told the inherited Cloudflare stack was dead weight worth deleting:

> "Does that actually help us with the web UI? If we do a secure, tunneled system
> and create an account, this could be used for a paid or cloud version later.
> Build it with the end in mind. Would this actually benefit us?"

It does. The earlier recommendation to delete was wrong and is withdrawn. But the
sequencing matters more than the answer, because one route decides it.

## The fact that governs everything here

Murage has execution primitives reachable from its own UI surface:

| Route | What it does |
|---|---|
| `POST /api/cli-test` | spawns a caller-supplied binary path |
| `PATCH /api/instances/:id` | installs one as the engine for every later turn |
| `POST /api/bots/:id/computer/exec` | arbitrary shell on the provisioned box |

All three are now desktop-surface-only (`07bf5c7c`, `f3ba4f59`). Before that they
were gated by a `content-type: application/json` check whose own comment calls it
anti-CSRF for a loopback server — which a fetch from our own page passes.

**Behind the tailnet, that is the owner's own machine and the owner's own decision.
Behind a public tunnel, one leaked credential is remote code execution.** Not a
data leak. Code execution.

The tunnel is cheap. Making the app *safe to expose publicly* is the expensive
part, and nobody has costed it. That asymmetry is the whole plan.

## The stack is two things, with opposite risk profiles

Inherited from OpenMausBot, ~6,600 LOC across source and tests, currently inert.

| | Value | Risk | Verdict |
|---|---|---|---|
| **Account system** — email/OTP, installation credential, control plane client | **High. It is the billing substrate.** Composio metering needs identity regardless of any tunnel. | Low | **Keep** |
| **Cloudflare tunnel** — bundled `cloudflared`, guardian, 8812 origin gateway, `hosted` endpoint | Moderate: "works away from home" with no client to install | **High: public ingress to a host with execution primitives** | **Keep dark until the precondition is met** |

Separating them is what makes "build with the end in mind" cheap instead of
expensive. Sean needs the account for billing whether or not a tunnel ever opens.

## Why it is inert today, precisely

- `electron/companion-account-service.mjs:12` — `DEFAULT_COMPANION_CONTROL_PLANE_URL = "https://accounts.murage.ai"`.
- That string is a **find-and-replace of upstream's `accounts.openmausbot.com`**. Sean never provisioned it. `dig accounts.murage.ai` returns no record at all.
- It resolves to `""` unless `isPackaged` — and there are **zero published releases**.
- The tunnel starts from `startManagedCompanionConnection()`, gated on account credentials that cannot be obtained.

So it opens no port and never has. It is dead weight, not a hole. That is why
keeping it costs nothing.

Two things the earlier analysis got wrong, corrected here: the managed origin is a
**0600 Unix socket**, not a TCP port, and the 8812 gateway binds `127.0.0.1`. The
claim that public ingress runs independently of the `hosted` endpoint kind is
false in the way that matters.

## Sequence

1. **Web UI over Tailscale.** `tailscale serve` fronts the browser door. Measured
   2026-09-02: `Host` survives intact, `Tailscale-User-*` identity headers are
   injected and **client-supplied copies are stripped** (forgery attempted, failed),
   SSE passes through with event ids intact, TLS verified against a real
   Let's Encrypt cert. Tailscale owns renewal — the cert expires **30 Nov 2026** and
   Tailscale renews only when something asks; `serve` asks, a file-reading listener
   does not.
2. **Cloud Deploy.** Self-host to a VPS, joined to the user's *own* tailnet with the
   user's *own* auth key. Zero hosting cost, zero liability, no Ferrox
   infrastructure in the path, nothing for us to keep alive.
3. **The tunnel, for the paid tier only, and only after the precondition below.**

**Build the door transport-agnostic from the start.** `tailscale serve` and a
cloudflared tunnel both terminate TLS and forward to the same listener. One door,
two possible fronts. Then the cloud tier is a transport swap plus an account that
already exists — not a rebuild. This is the whole reason to decide it now and build
it later.

## Precondition — non-negotiable before any public ingress

1. Every execution route surface-gated. **Done**, four routes, negative-controlled.
2. The browser door stamps its own surface marker into a **fresh** header object.
   `requestSurface` honours `?surface=desktop` from the query string because
   `EventSource` cannot set headers — and a browser can type that into a URL bar.
   The companion proxy is safe only because it stamps `x-murage-companion: "1"`,
   which is checked first. A door that forwards without stamping hands any browser
   tab an unscoped transcript grep with one query parameter.
3. A real audit of what a session credential reaches, by someone who did not build it.
4. A decision about breach liability, because from that point we are in the data path.

## The trade, stated honestly

- **Tailscale** — zero hosting cost, zero liability, no uptime obligation, no data
  in our path. But it is a genuine drop-off cliff: install a client on two devices,
  make an account, join a tailnet. We lose the non-technical user, which is exactly
  the user a paid tier is for.
- **Cloudflare tunnel** — works instantly in any browser, no client. But we are in
  the data path, on the hook for uptime, holding a breach liability, and running a
  control plane that has to stay alive.

That is a business, and it is a reasonable one. It just is not free, and the cost
is mostly not the code — the code is already written.

## Open question for Sean

**Is the paid tier this quarter, or someday?** If this quarter, the remaining
hardening moves ahead of the three essentials. If someday, this document is the
decision and nothing changes until it is revisited.
