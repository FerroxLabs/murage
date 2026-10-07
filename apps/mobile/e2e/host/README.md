# Isolated E2E host

A throwaway Murage (fake engine, temp data) for the phone E2E runs in P25, P26 and P27.
It never touches the live app: its ports are 28799/28800 (server) and 28810/28811/28813
(door), both processes start under `env -i` with `HOME` in a fresh `/tmp/murage-e2e-data-*`,
and Tailscale Serve is changed only on `:8444`.

```bash
cd apps/mobile
e2e/host/build-web-dist.sh          # once per web change: vite build on build-host, dist copied to e2e/host/web-dist
e2e/host/run-host.sh                # server + door; writes host.env (chmod 600, per-run companion token)
e2e/host/serve.sh up                # snapshot Serve, refuse if :8444 is taken, add :8444 -> 127.0.0.1:28813
e2e/host/mint.sh                    # one pairing: {"address","code","url"}; single use, this host only
e2e/host/seed.sh                    # seeds a small org (bots + team rooms) via the normal API; idempotent, 127.0.0.1:28799 only
e2e/host/door.sh reset              # forget every phone: the next page load is a 401 (re-pair)
e2e/host/serve.sh down              # remove :8444 only if it is our proxy, diff against the snapshot (fails loudly), close the cycle
e2e/host/stop-host.sh               # stop both, delete the temp data, companion-data and host.env
```

Always end with `serve.sh down` then `stop-host.sh`, even after a failed run. `run-host.sh` takes
`host.lock` (a directory, made atomically) and `stop-host.sh` releases it, so two runs can never
both start a host; a refused start says "is busy" or "host.env exists", and an E2E script that sees
either arms no teardown, because the host it would stop is another run's. `host.lock/pid` is the
process that asked for the host (the E2E script, or your shell). A lock is taken over only when it
is clearly stale: no `host.env`, that pid is gone, and no 28xxx port is listening. `stop-host.sh`
without a `host.env` releases the lock only if its caller owns it. By hand, after checking nothing
runs (`lsof -nP -iTCP:28813`), `rm -rf e2e/host/host.lock` recovers a lock nothing will clear. `serve.sh up` refuses while
a cycle is open (`serve-before.json` exists); a successful `down` renames it to `serve-restored.json`.
`down` changes nothing when :8444 is anything but our proxy to 127.0.0.1:28813. `door.sh` and
`stop-host.sh` kill a PID only when it is the listener on its 28xxx port or the isolated node process
(`own-pid.sh`); otherwise they refuse and say so.

## Before any native build (P25, P26, P27)

Run `pnpm build && pnpm sync` in `apps/mobile` first. `pnpm sync` is `cap sync` only; the
build before it refreshes `dist`, and the sync regenerates
`ios/App/App/capacitor.config.json` and `android/app/src/main/assets/capacitor.config.json`
from `capacitor.config.ts`. `src/e2e-harness.test.ts` fails if either synced copy leaves
`CapacitorCookies` or `CapacitorHttp` enabled, so run the vitest suite after the sync.

## Never

- Ports 8799 or 8810-8813, the data under `~/Library/Application Support/*Murage*` or
  `~/.murage-companion`, or any Serve entry other than `:8444`.
- Printing or committing a minted code, token or `host.env`. Record the shape only.
