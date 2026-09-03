# `murage` — headless cloud deploy

Deploy Murage's server to a cloud box so it is reachable **only over your
Tailscale tailnet**, and never from the internet.

```sh
murage setup      # join the tailnet, wire a key, start the door, front it, verify it
murage start      # run the harness AND the companion's browser door
murage status     # verify the posture at any time
murage resetpass  # break-glass admin reset, if this build has one
murage help
```

Design, threat model, and the full "what we did differently from Wayland and
why" write-up: [`docs/plans/cloud-deploy/PLAN.md`](../docs/plans/cloud-deploy/PLAN.md).

## The one thing to know

There is **no configuration that makes this bind `0.0.0.0`.** The only two
answers `lib/bind.mjs` will give are `127.0.0.1` and this host's own tailnet
address, and the tailnet answer *refuses to resolve* when the box holds no
tailnet address — so a failed enrolment stops the server rather than quietly
leaving it reachable some other way.

## Two processes, not one

The thing `tailscale serve` fronts is **not** the harness. The harness (8799)
rejects any request whose `Host` is not a loopback name — a DNS-rebinding
defence — and `serve` forwards the client's original `Host`, so a proxy aimed
at 8799 answers 403 on a box that just reported itself secured. The companion
sidecar's **browser door** (8813) is the component that speaks to the harness
as this machine, and it is the only correct proxy target.

So `murage start` runs both, and `murage setup` starts the door itself —
briefly — to prove it comes up before it configures any proxy in front of it.
It stops that one again when it exits; `murage start` is what runs it for real.

### The one door the sidecar does *not* open here

On a desktop the sidecar also opens a **device door on `0.0.0.0:8810`**, so a
phone on the same wifi can pair against this machine's LAN address. That is the
right default there and the wrong one on a rented box, where the same `0.0.0.0`
is the public internet minus a security-group rule and there is no phone on the
LAN to pair anyway.

So this installer does not open it. Every sidecar it starts — the brief one in
`setup` and the long-running one in `start` — is given
**`MURAGE_COMPANION_BIND=off`**, and the sidecar then binds no device socket at
all. Nothing is listening on 8810, so there is no firewall rule to get right.

**You do not need a `ufw deny 8810/tcp`.** Earlier versions of this installer
told you to add one, because back then there was no way to switch the door off
from out here. There is now.

The control page (`127.0.0.1:8811`) and the browser door (8813) are unaffected
by that setting and still come up — they are the whole arrangement this
deployment uses. If you ever *do* want the device door on a box like this, set
`MURAGE_COMPANION_BIND` yourself to `tailnet` (the tailnet address and only
that address) rather than to `lan`; an unrecognised value makes the sidecar
refuse to start rather than fall back to `0.0.0.0`.

## The auth key

Never pass it as an argument. There is no flag for it, on purpose: `/proc/<pid>/cmdline`
is world-readable and shell history is a file.

```sh
murage setup                       # prompts, no echo
MURAGE_TS_AUTHKEY=tskey-… murage setup   # unattended
```

Internally it goes to a `0600` file in a `0700` directory, is passed as
`--auth-key=file:<path>`, and is shredded in a `finally` block.

For a disposable box, mint an **ephemeral** key. That is a property of the key,
chosen when you create it — there is no `tailscale up` flag for it, so setup
cannot choose it for you. With one, a destroyed droplet evicts itself from your
tailnet instead of lingering as a dead entry.

## Environment

| Variable | Meaning |
| --- | --- |
| `MURAGE_BIND_MODE` | `loopback` (default) or `tailnet` |
| `MURAGE_BIND_ADDRESS` | explicit address; must be loopback or a tailnet address of this host |
| `MURAGE_PORT` | default `8799` — the **harness** listener |
| `MURAGE_BROWSER_PORT` | default `8813` — the companion's **browser door**, and the only thing the tailnet proxy is ever pointed at (the harness refuses a non-loopback `Host`, so a proxy aimed at 8799 answers 403). Setup will not configure the proxy at all unless `GET http://127.0.0.1:8813/enter` answers |
| `MURAGE_DATA_DIR` | default `~/.murage-server` |
| `MURAGE_ENV_FILE` | default `$MURAGE_DATA_DIR/murage.env`, mode `0600` |
| `MURAGE_SERVER_ENTRY` | explicit path to the bundled server |
| `MURAGE_COMPANION_ENTRY` | explicit path to the sidecar; otherwise `payload/companion/index.js`, then `dist-companion/index.js` (`pnpm build:companion`), then `companion/src/index.ts` |
| `MURAGE_COMPANION_DIR` | set by `start`/`setup` to `$MURAGE_DATA_DIR/companion`; the sidecar's own default is `~/.murage-companion`, which the staged systemd unit cannot write |
| `MURAGE_COMPANION_BIND` | forced to `off` by `start`/`setup`, overwriting whatever is inherited — the **device door** (8810) binds nothing here. The sidecar's own default is `lan` (`0.0.0.0`), which is right for a desktop and is public ingress on a rented box |
| `MURAGE_BROWSER_BIND` | forced to `loopback` by `start`/`setup`, overwriting whatever is inherited — `tailscale serve` dials `127.0.0.1`, and a door bound to the tailnet address instead answers it with nothing |
| `MURAGE_TS_AUTHKEY`, `TS_AUTHKEY` | auth key for an unattended setup |
| `MURAGE_TAILSCALE_BIN` | explicit path to the `tailscale` CLI (non-standard installs, tests) |
| `MURAGE_TRUSTED_PROXY` | set to `1` by setup only when the tailnet proxy was actually configured |

`ALLOW_REMOTE` is deliberately **not** a variable here. `HOST=0.0.0.0` is
refused by name.

## Tests

```sh
node --test installer/test/*.test.mjs
```

No config, no dependencies, no build step. Includes a scanner that fails the
build if Tailscale's public-internet sharing subcommand — the one this whole
deployment exists to avoid, which is NEVER used here — appears anywhere in the
executable lane, comments included, extension-less shell wrappers included.
Alongside the denylist there is now an allowlist: `up`, `status` and `serve`
are the only subcommands any call site may hand the CLI, so a future exposure
subcommand under a new name fails without anybody having predicted it.
