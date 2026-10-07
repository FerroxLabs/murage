# flux-stream-conformance

A conformance suite for the Flux streaming transcription contract (contract A, WebSocket, subprotocol `flux.stt.v1`). It opens real sessions against a URL, drives them with 12 recorded speech fixtures, and checks the protocol, auth, validation, turn, lifecycle, backpressure, fault and metering behaviour, plus four protocol latency gates. It needs node 24 or later and nothing else.

The same suite runs against the offline simulator in this repo, so a pass there and a pass on staging mean the same checks.

## Running it

From the artifact (`flux-stream-conformance-<version>.tgz`):

```
tar xzf flux-stream-conformance-<version>.tgz
export FLUX_KEY=... FLUX_KEY2=... FLUX_FREE_KEY=... FLUX_RESTRICTED_KEY=...
node flux-stream-conformance/run.mjs --mode acceptance --target flux --url wss://<host>/v1 \
  --key-env FLUX_KEY --key2-env FLUX_KEY2 --free-key-env FLUX_FREE_KEY --restricted-key-env FLUX_RESTRICTED_KEY \
  --flux-faults --report report.json
```

From the repo (it builds the bundle into `dist/flux-stream-conformance/` first):

```
pnpm flux-stream:conformance -- --mode dev --target flux --url ws://127.0.0.1:8787/v1 --key-env FLUX_KEY --sim
pnpm flux-stream:conformance:pack      # writes dist/flux-stream-conformance/flux-stream-conformance-<version>.tgz
pnpm flux-stream:owner-replay -- <bake-off run dir> <recording dir>
```

`node run.mjs --help` (or `pnpm flux-stream:conformance -- --help`) prints every flag. `--list-checks` prints the check ids as JSON. The package's `manifest.json` lists the version, the contract file's sha256, the check ids and the run command.

## Authentication

The API key goes in the `Authorization` header. It is read from an environment variable whose NAME you pass with `--key-env`; it is never read from argv, and it is never put in a URL. There is no ticket flow for Flux. The other keys are optional in dev mode and required in acceptance mode, because they drive checks that need them:

| flag | variable holds | check |
|---|---|---|
| `--key-env` (default `FLUX_KEY`) | a key that may stream | every check |
| `--key2-env` | a key on a second account | X01, isolation between accounts |
| `--free-key-env` | a key on a plan without streaming | A04, refused 4402 |
| `--restricted-key-env` | a key restricted from streaming | A07, refused 4403 |

## Modes and targets

- `--mode dev` (default) is for iteration. Its report says "dev run (not an acceptance run)" at the top. A check that cannot run is skipped or excluded.
- `--mode acceptance` runs a fixed inventory and fails on a false green: a required check that did not run (a missing credential, missing fault support, a skip) is a failure, a gate with fewer samples than fixtures is a failure, and `--only` is refused.
- `--target flux` is Flux's acceptance: the contract checks and the four protocol latency gates (T-text-p50, T-text-p90, T-eot-p50, T-eot-p90). It is required with `--mode acceptance`.
- `--target murage` adds Murage's call profile checks and their gates. It is not Flux's to pass.

## Flags

| flag | meaning |
|---|---|
| `--url <ws base>` | the stream base, ending `/v1`, for example `wss://<host>/v1`. Alias: `--base` |
| `--mode acceptance\|dev` | see above |
| `--target flux\|murage` | see above |
| `--key-env`, `--key2-env`, `--free-key-env`, `--restricted-key-env` | names of the environment variables holding the keys |
| `--flux-faults` | the server accepts provider fault injection (staging with test faults on). Checks B02, F01, F02 and the coalescing half of P04 and L06 need it; acceptance fails without it |
| `--sim` | the base is the simulator (magic keys, sim faults, traces) |
| `--no-latency` | no real speech provider behind the base: skip the latency and accuracy checks (dev mode) |
| `--profile` | also run Murage's profile checks (implied by `--target murage`) |
| `--starts-per-minute <n>` | the server's fleet-wide session start cap, for check L10 (default 90) |
| `--max-inflight <n>` | sessions open at once during L10's burst (default 4, the per-account concurrency limit) |
| `--eagerness low\|medium\|high`, `--min-silence <ms>`, `--max-silence <ms>` | the session policy sent on every session |
| `--commit on\|off` | Murage's punctuation commit in the profile runs (default on) |
| `--only P01,T05` | run only these checks (dev mode only; an unknown or empty list exits 2) |
| `--owner-recording <dir>` | the owner-voice qualification (needs `--target murage`); numbers only |
| `--report <file>` | write the full report as JSON: counts, codes and WER, never transcript text |
| `--list-checks`, `--version`, `--help` | inventory, suite version, usage |

## The start-cap check (L10)

The session start cap (90 starts a minute) is fleet-wide. Over it the server refuses with a retryable `error` (code `service_unavailable`, type `api_error`, fatal, a numeric `retry_after_ms` above 0) and then closes 4503. Check L10 opens sessions on `--key-env` until one is refused, up to cap + 1 attempts, closing each accepted one at once. It asserts the refusal has exactly that shape and comes on attempt cap + 1, no earlier. It is required in acceptance mode for both targets and runs last, so its burst cannot refuse another check's connect.

The burst is pipelined: at most `--max-inflight` sessions are open, each is closed the moment it starts, and starts are numbered in open order. The check passes when the first refusal is start number cap + 1 with the exact shape. With no refusal it fails as "burst too slow" if the burst took over 60 s (raise `--max-inflight`) or "cap not enforced" if not. An early refusal reads by cause: `service_unavailable` is an early fleet-cap refusal (the burst is retried once after `retry_after_ms` plus 60 s), `concurrency_limit` means lower `--max-inflight`.

Against a real server this spends cap + 1 short sessions (91 by default). On a shared staging fleet other traffic counts toward the cap too, so a refusal on an earlier attempt is reported as a failure with the attempt number. The check first waits for this run's own earlier starts to leave the 60 s window, which can add up to a minute to the end of a run.

Check A06 (client tokens) is report-only: it is skipped by design on a Flux acceptance run, and a skip of it does not fail the run.

## Exit codes

| code | meaning |
|---|---|
| 0 | pass |
| 1 | one or more checks or gates failed |
| 2 | usage error (unknown flag, bad or empty `--only`, a missing key variable, a bad `--mode`, `--target`, `--commit`, `--starts-per-minute` or `--max-inflight`, a missing `--url`) |

## Notes

A full acceptance run takes several minutes: the lifecycle checks wait out real timers (a 90 second session, a 125 second metering session). Reports carry counts, codes and WER only, never transcript text.
