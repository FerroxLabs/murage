# bld-hlpw — OPEN

The requested desktop `users.create` workflow is **not implemented or qualified**. This commit supplies tested foundations. It does not enable the operation. The existing refusal in `server/highlevel/operations/users.ts` is retained. The form and protection coordinator are not mounted by the application; the admission/body helpers do not install a route.

Baseline: `93ffcee3ddca91dfeed4318671538d1997f831ca`, already the tip of `origin/dev/1019-hlf6` after `git fetch origin dev/1019-hlf6 && git merge --ff-only FETCH_HEAD`.

Authoritative requirements:

- `/work/build/des-hlf6/DESIGN-HL-USERPW.md`
- `/work/build/des-hlf6/REVIEW-HLPW-d1.md` (AMEND 5 wins)

The memory prelude tool was not available; `.ijfw/memory` was absent. No subagents were used. No Mac, real HighLevel account, real password, billable service, or live application data was used.

## Delivered foundations

- Web Crypto generator, rejection sampling, mandatory classes, 20 characters, unbiased Fisher–Yates shuffle, no weak fallback. Shared exact custom-password validation.
- An unmounted dialog with private uncontrolled input, protection-before-generation, success retention, explicit close/expiry cleanup, custom validation, focus trap, duplicate-action exclusion, and prevention of native copy/cut/context-menu/drag export. Protection and dedicated submission are mandatory injected dependencies; no application store or generic API helper handles its password.
- One-use memory-only password envelopes and nonces bound to action, digest, desktop session, turn and expiry. Authentication is mandatory when issuing the nonce, and authority/expiry are checked again when the secret is consumed after waits. Invalid submissions consume their nonce. Parser errors are fixed and body buffers are zeroed.
- An unmounted protection coordinator that serializes openings, fences before draining queued bot work, and refuses absent native protection. Clipboard copying refuses ordinary Electron/process-local timer adapters. The module has no general clipboard read method.
- A local-filesystem SQLite identity claim shared across connections/processes, synchronous FULL WAL commits, unique dispatch owner and irrevocable dispatch barrier. Only the live holder can release an unsent claim. Partial/foreign/duplicate inventories fail closed. No provider dispatch or automatic retry is implemented by this helper.
- Test-only leak guard v2: binary scanning, literal/JSON/unicode/URL/base64/base64url/hex/UTF-16 forms, gzip and zip decoding, positive controls, unreadable/missing evidence refusal, and interception wrappers for six outbound sink classes. Tests scan **their primitive fixture**, including SQLite/WAL, journals, diagnostics and archives before shutdown and after restart. This does not establish a clean full-app secret workflow.

## Required work still open

1. Production native capture/input protection and draining across all bots, desktop IPC provenance, and actual renderer/main/server diagnostic/dump prevention. Crashpad still starts in the existing application. The standalone coordinator is not a substitute for wiring these protections.
2. Independent, ownership-aware clipboard retention across process death, quit and suspend, with history/sync protection and failed-clear handling. No production adapter was supplied; copying must stay closed.
3. The MAIN-owned schema/frozen-snapshot, incomplete held-template, action approval, journaled client dispatch, review/approval route and recovery amendments, plus F6 user preparation/fake integration. `manifest-data.json`, `schemas/common.ts`, and the prior membership fixes were not edited. No independent route-level provider call was added.
4. Actual local transport/launch proof, immutable direct-desktop-owner ancestry and nonce issuance/submission routes. The helper's proof facts are inputs to be supplied by trusted code, not authentication by themselves.
5. Application-wide instrumented leak/crash tests, recovery after all specified crash points, and full R1–R12/M1–M12 acceptance. Packaged macOS/Windows/Linux flow, five-second usability and copy review remain unqualified. The Mac prohibition was respected.

Threat boundary: no claim is made about OS swap/hibernation, external clipboard managers, external capture or deliberate owner sharing. The intended production boundary must exclude/prevent these explicitly before exposing secrets. JavaScript strings cannot be reliably overwritten. Dropping references is not universal memory erasure.

## R/M acceptance table

“Partial” means a foundation was tested; the complete design acceptance criterion remains OPEN. “Killed variants” are the actual primitive mutations, not a claim that all design mutants were executed.

| # | Required R status | Required M status |
|---|---|---|
| 1 | OPEN — real host/tool schema and create review not integrated | OPEN — restore tool password |
| 2 | Partial — bound nonce, auth, expiry and post-wait consumption | 2 helper variants killed; full trusted connection/dispatch mutant OPEN |
| 3 | Partial — fail-closed proof facts and nonce issuance | Launch-proof variant killed; actual forwarding/policy/bot-input bypass OPEN |
| 4 | GREEN — generator and exact custom validation | Random fallback, modulo bias and missing-class variants killed |
| 5 | Partial — isolated dialog lifecycle, visibility, duplicate and export controls | Persistence and automatic-close variants killed; full app persistence OPEN |
| 6 | Partial — refuses unsupported copying and process-local adapters | Unprotected-copy variant killed; real timer/newer-content mutants OPEN |
| 7 | Partial — secret echo rejection and safe envelope error | Echo-guard variant killed; actual client/provider projection OPEN |
| 8 | Partial — real process race, durable barrier and restart hold | Non-atomic-claim variant killed; POST/replay/crash matrix OPEN |
| 9 | Partial — incomplete/duplicate/foreign inventories and uncertain claim hold | Partial-inventory variant killed; recovery resend mutant OPEN |
| 10 | Partial — scanner positive controls, fake sinks and primitive fixture artifacts | Secret-serialization variant killed by R10; full application journal/wire mutant OPEN |
| 11 | Partial — coordinator fences/drains and fails closed | Bot-access variant killed; real Crashpad/capture/crash mutants OPEN |
| 12 | OPEN — packaged OS workflow and usability | Hidden-entry and focus-trap variants killed in jsdom; packaged qualification OPEN |

## Verification and evidence

All executions used `/work/fuigo-builds/tools/it-remote.sh`, with `IT_JOB=bld-hlpw`, `IT_W=/work/build/hlf6/wt`, `IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh`, and network disabled. At most two owned containers ran at once; mutations ran serially. The initial helper allowed one remote run while build host load was 80; this violates the requested wait rule and is recorded here. Subsequent invocations used a job-local load check waiting while the one-minute load exceeded 60. Final wrapper also explicitly sets `NETARG='--network none'`.

Evidence resides outside the commit at `/work/build/bld-hlpw/evidence/`. `commands.txt`, `runs.json`, and `SHA256SUMS` identify the exact runs and files. The initial RED batches preceded implementation of the corresponding modules and failed assertion checks for missing exports. New coverage was added during implementation, so this is not a claim of every final assertion having a separately recorded pre-implementation RED.

The isolated fixture was launched through `node --experimental-strip-types scripts/control-murage.ts launch`, driven with the shared `doctor --url <fixture>` control path, then interrupted with SIGINT and checked for data-directory removal. Launch URL, PID, dataDir, original log path, doctor JSON, server log and cleanup JSON are retained. This proves fixture readiness only, not the requested password workflow.

English copy inventory: [COPY-REVIEW.md](COPY-REVIEW.md).
