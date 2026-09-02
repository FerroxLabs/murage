# `murage` — headless cloud deploy

Deploy Murage's server to a cloud box so it is reachable **only over your
Tailscale tailnet**, and never from the internet.

```sh
murage setup      # join the tailnet, wire a key, front the app, verify it
murage start      # run the server
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
| `MURAGE_PORT` | default `8799` |
| `MURAGE_DATA_DIR` | default `~/.murage-server` |
| `MURAGE_ENV_FILE` | default `$MURAGE_DATA_DIR/murage.env`, mode `0600` |
| `MURAGE_SERVER_ENTRY` | explicit path to the bundled server |
| `MURAGE_TS_AUTHKEY`, `TS_AUTHKEY` | auth key for an unattended setup |
| `MURAGE_TAILSCALE_BIN` | explicit path to the `tailscale` CLI (non-standard installs, tests) |
| `MURAGE_TRUSTED_PROXY` | set to `1` by setup when the tailnet proxy is configured |

`ALLOW_REMOTE` is deliberately **not** a variable here. `HOST=0.0.0.0` is
refused by name.

## Tests

```sh
node --test installer/test/*.test.mjs
```

No config, no dependencies, no build step. Includes a scanner that fails the
build if Tailscale's public-internet sharing subcommand — the one this whole
deployment exists to avoid, which is NEVER used here — appears anywhere in the
executable lane, comments included.
