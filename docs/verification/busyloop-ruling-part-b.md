# Busyloop ruling Part B — OPEN pending release and upstream provenance

Base/origin were both `9839770eb7e53fe089ee08936ba728ff50d37568`.
The recorded copy review `2791a70dc11a54ef3ceb79e30444946dc6afd0db`
was merged first by fast-forward. Its focused 32-string acceptance test passes.

The ACP relay reads recognised `data.upstream.state` values before legacy
prose, and numeric `data.upstream.http_status` before legacy statuses. Invalid
upstream fields cannot re-enter through the legacy recursive scanner. With no
explicit status, JSON-RPC `-32003` or `data.error_kind = rate_limited` yields 429.
Retrying, exhausted and failed notices preserve upstream facts; terminal
notices do not send another cancellation. Diagnostics retain their numeric-only
status contract. Fuigo's frame handling lives in the shared ACP core; no spawn
or credential-routing change was needed in `fuigo.ts`.

The eight previous parser cases are named `synthetic-*`; the never-emitted
`data.http_status:429` and `data.error.state` shapes are documented as defensive
coverage. Typed contract and mutation tests are also explicitly synthetic.
They are not customer root-cause evidence.

## Real binary evidence and correction to the ruling

Eight frame files (S1–S4, twice each) came from the released 1.0.41 npm binary,
whose decompressed SHA256 matches `12c9b952ee9c9561e4ef36ed18973f3af2a443817f5dc928e89bee38dddddc07`.
The loopback stub and engine ran together with `--network none`, scratch homes,
and only a dummy key. `node:22-bookworm` was used because it supplies Python;
the recipe's slim variant does not. No retry-count override was set.

Frames, exact terminal S1/S2 quotes, script/body hashes and run provenance are in
[`__fixtures__/CAPTURE-FINDINGS.md`](../../server/drivers/acp/__fixtures__/CAPTURE-FINDINGS.md)
and [`PROVENANCE.json`](../../server/drivers/acp/__fixtures__/PROVENANCE.json).
The capture workspace is `/work/build/busyloop-capture/`.
The replay process writes the captured stdout lines unchanged except for
rebinding the terminal JSON-RPC routing id. Its session handshake acknowledges
the fixture's permission policy and MCP readiness; no refusal payload is built
by the replay process. R7 checks hashes, repeat determinism and exact-key masking
without rewriting unrelated frame bytes.

The capture corrects the ruling: **HTTP status is not entirely stripped**.
The terminal `data.message` has the Display prefix `API error (status 429 Too
Many Requests):`, and `data.verdicts.httpStatus` is 429. State/tier are absent
on S1, but its monthly-allowance words survive. S2's source-derived wrapper
preserves both the state fragment and those words within the truncation cap.
The ruling file has a capture addendum recording these findings.

On the unchanged baseline relay, R1/R2 already pass, and the isolated HTTP path
shows free-cap cards on sends 1, 2 and 3. Consequently disabling B2 cannot make
this actual R1 fail. B2's mutation test uses the honestly labelled status-less
synthetic contract; captured R1 stays green during that mutation.

R5 preserves busy/busy/repeated over three HTTP sends. R6 preserves the existing
`providerError.kind = credits`, HTTP 402 and normal credit card path; it does not
invent a gateway busy card. The existing real-card rendering test checks the
free-cap allowance copy and credit action; the HTTP fixture checks persisted
card reasons and retained user messages. It is not a packaged desktop smoke.

## Still open

- The available FluxRouter source snapshot is unversioned. Its exact file hashes
  and lines are recorded, but the 11-09 live commit and FluxMain production body
  have not been supplied. S2's wrapper is source-derived from LiteLLM 1.92.2,
  not verified against production. These real engine captures remain provisional
  upstream evidence and do not close P1.
- R3 has two active failing tests, one per S1/S2 scenario, not skips. It requires
  genuine pinned 1.0.42 captures, their own provenance, and the independent
  `scripts/fuigo-1.0.42-provenance.json` release receipt. Part A's release handoff
  still requires the release/capture/bundle lanes; its implementation commit
  alone is not a release binary pin. The retained B1 mutation proves only the
  synthetic contract, not R3.
- Per MAIN's 18:55Z full-run policy, no lane vtq/full suite was queued. Full-rig
  `NEW=0` belongs to the integration tip and remains integration evidence owed.

## Validation records

Logs and HTTP transcripts live in `evidence/ruling/`. All test commands used
`it-remote.sh` with `IT_JOB=bfix-busyloop*`, this worktree and
`IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh`. The shared remote lock
was occupied, so `NETARG=--network=none` selected the helper's local-container
fallback while keeping networking disabled. No more than two job containers
ran at once; observed host load stayed below 60. No local whole-suite run,
live-app mutation or real credential was used.

- `red-contract.log`: six failures before B1/B2; explicit-status control passed.
- `red-retry-contract.log`: three typed RetryState failures before the fix.
- `red-captured.log`: baseline real replay/HTTP tests: 12 pass; only absent R3 fails.
- `red-diagnostic-guard.log`: three diagnostic validation failures exposed while
  implementing B2, then corrected without loosening the existing assertions.
- `copy-review.log`: the recorded copy review's focused acceptance check passes.
- `tsc-status.txt`: client, server and stream-conformance TypeScript checks pass.

- `current-captured-and-contract.log`: 36 pass; only the missing R3 capture
  fails. No runtime skip was added to R3.
- `mutation-b1.log`: disabling typed upstream extraction causes six failures.
- `mutation-b2.log`: disabling 429 inference causes three failures; genuine R1
  still passes because the actual frames already carry status evidence.
- `green-diagnostic-guard.log`: all 61 selected diagnostic assertions pass.

- `green-acp.log`: the final complete ACP file passes 486/486 tests. Together
  with the seven passing neighbour files (231 tests), the touched/neighbour
  checks pass 717 tests. The earlier four ACP failures remain recorded in
  `green-neighbours.log`; the final rerun supersedes them.
- `commands.txt` retains exact test invocations; `source-hashes.json` confirms
  the baseline relay was byte-equal to `9839770eb` for the captured RED run.

The release/capture dependencies above remain OPEN despite these green checks.


## cfix-busyloop review follow-up

Base and origin were both `5a91303f707de4f453f0ecf6eee45faf45c6bcdd`.
The review's P2 code gap is fixed: R3 compares the capture's `binary.sha256`
with the independent release receipt's `packages[target=linux-x64].binarySha256`,
requires the exact 1.0.42 release version and Linux package identity, and checks
that `binary.version` identifies the release `source` commit. An arbitrary
64-character digest no longer passes. No release receipt was fabricated.

R3 preserves the captured bytes while mocking only `fluxRefusalCode` (the legacy
classifier) to return undefined. It requires `LimitTurns.gatewayCode` to be
`free_cap_reached`, and checks the resulting card with empty `errorText`. Thus
surviving legacy words cannot hide removal of B1. A real 1.0.41 S1 capture is a
negative control: it still renders freeCap from its text, but fails this stronger
typed-state assertion. This control is not 1.0.42 root-cause evidence.

`fuigo-capture-proof.test.ts` uses explicitly synthetic validator inputs to
reject unrelated hashes, source commits, versions and platform receipts, duplicate
Linux receipts, and text-only classification. Six of those regressions failed
against the prior checks before the fix; all eight validator tests pass after it.
Logs and the exact RED helper are in `evidence/cfix-busyloop/`. The initial
missing-vitest setup failure is not counted as RED.

The remaining handoffs are precise:

- **P1 production provenance OPEN:**
  `/work/build/busyloop-capture/flux-prod-429/` was absent.
  `server/drivers/acp/__fixtures__/PROVENANCE.json` still awaits a verified
  `body_sources.status`, the missing `body_sources.S1.commit` (live FluxRouter
  source commit), and a verified `body_sources.S2.wrapper` with the sanitized
  production-body cross-check. The sanitized body and source receipt must arrive
  before recapturing and replacing provisional fixtures; their hashes cannot be
  retroactively relabelled as production evidence.
- **P1 R3 OPEN:**
  `server/drivers/acp/__fixtures__/fuigo-1.0.42-free-cap-S1-1.jsonl` and
  `fuigo-1.0.42-free-cap-S2-1.jsonl`, plus
  `server/drivers/acp/__fixtures__/PROVENANCE-1.0.42.json` (`binary`, `files` and
  capture/body provenance) and `scripts/fuigo-1.0.42-provenance.json` (`version`,
  `source`, Linux package `binarySha256`) are missing. Once supplied, run R3 and
  the captured B1 mutation command in `evidence/cfix-busyloop/commands.txt`.
  A missing-file failure is not mutation evidence. The release/bundle and
  cross-platform release qualification remain with their assigned lanes.
- **Integration full-rig NEW=0 OPEN:** no lane full run or vtq was queued, per
  the current integration-tip-only instruction.

The stronger guards close P2's implementation defect, not either P1 dependency.

Final cfix validation: the seven touched/neighbour files report **761 passed,
2 failed**; only the two absent 1.0.42 capture scenarios fail. This includes
486 ACP tests, 165 Fuigo driver tests, 81 release-workflow checks, the eight
proof guards, and isolated HTTP S1/S2/S3 three-send flows. Client, server and
stream-conformance TypeScript checks all exit 0. HTTP launch metadata, requests,
messages and server log are retained in `evidence/cfix-busyloop/http/`. Test
containers used no network; the workspace dependency directories and generated
TypeScript build metadata were removed after verification using `safeWipe`.
