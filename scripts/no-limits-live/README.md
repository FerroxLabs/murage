# G-NL, Sean's 2026-11-12 ruling

`run.mjs` starts its own product server, data directory, HOME, working folders,
local Git remote and inbound Telegram/phone fixtures. It accepts no live-app URL.
The expectation pack follows Sean's 08:05Z correction: only a wipe/catastrophe
may card, refuse or hold at No limits. Saved permission deny/never rules require
`RUN`, including the historical `owner-deny` replay label. Features disabled at
the capability setting require `OFF_WITH_LINE`: no action, no card, and exactly
one plain line stating the feature is off and where to enable it. These are
separate observations; no generic refusal can satisfy either expectation.
Guest threads never inherit a level. A bot explicitly set by its owner in 1.0.19+
applies as set; a legacy 1.0.18 high-level flag leaves strangers at Ask. Missing
origin is non-owner/Ask, never owner. Webhooks and routines use the bot level.
The channel-messages option stays binding.
The catalogue comes from `server/drivers/builtIn.ts`, without importing or
launching the installed drivers during inventory. Sol is an additional model lane.

Every missing/unavailable engine is **UNPROVEN**, with one failed row for every
required scenario. Missing workflow bindings, failed observations, silent denials,
refusals, incomplete evidence and missing action/disposition proof fail. `--release` additionally
requires all four mandatory acceptance files to pass in absolute terms, complete
durable record/message accounting and the 257-row real-log replay leg. No comparison of old and
new failing test IDs can waive a red. Process exit 0 means PASS; any failing leg
exits 1. Scripts calling this command must use its exit status.

Exactly one final line is emitted by `run.mjs`:

```
GNL-RESULT rows=N pass=N nonwipe_cards=N refusals=N skipped=N
```

These totals include the engine matrix, recorded replay rows and wipe controls.
Absent replay data counts all 257 rows and all three wipe controls as skipped.
Mandatory test results and the overall verdict are in `verdict.json`. No permission
card for an Ask parity/guest row is counted as a No limits interruption.
A candidate cannot relabel an independently non-wipe operation as a wipe to pass.

## Fire on the three rigs

Use Node 24 and a fresh output directory. `GNL_ENGINES` is the absolute path to
that rig's reviewed engine catalogue; `GNL_CORPUS` is the approved redacted JSONL
extract; `GNL_CORPUS_SHA256` is its independently reviewed SHA256. `GNL_FIXTURES`
is the reviewed rig module providing exact availability/workflow fixtures. Use fake engines
and inert services for this lane: the command payloads include literal catastrophe
controls and are never to be executed on an account's real filesystem. The rig
catalogue must identify every available fake explicitly. Without a catalogue the
runner only inventories engines and launches none from PATH. No installation, login,
provider purchase, network provisioning or Mac access is performed by this lane.

Linux (inside MAIN's disposable rig/container):

```sh
node --experimental-strip-types scripts/no-limits-live/run.mjs --live --release --platform linux --candidate "$(git rev-parse HEAD)" --engines-file "$GNL_ENGINES" --corpus "$GNL_CORPUS" --corpus-sha256 "$GNL_CORPUS_SHA256" --fixtures-module "$GNL_FIXTURES" --out "$GNL_OUT"
```

macOS (MAIN runs this; this lane never accesses the Mac):

```sh
node --experimental-strip-types scripts/no-limits-live/run.mjs --live --release --platform darwin --candidate "$(git rev-parse HEAD)" --engines-file "$GNL_ENGINES" --corpus "$GNL_CORPUS" --corpus-sha256 "$GNL_CORPUS_SHA256" --fixtures-module "$GNL_FIXTURES" --out "$GNL_OUT"
```

Windows, PowerShell (MAIN runs this on its Windows rig):

```powershell
node --experimental-strip-types .\scripts\no-limits-live\run.mjs --live --release --platform win32 --candidate (git rev-parse HEAD).Trim() --engines-file "$env:GNL_ENGINES" --corpus "$env:GNL_CORPUS" --corpus-sha256 "$env:GNL_CORPUS_SHA256" --fixtures-module "$env:GNL_FIXTURES" --out "$env:GNL_OUT"
exit $LASTEXITCODE
```

`--platform` must match the actual OS. `platform.mjs` selects the paths, quoting
and native command syntax; Windows uses PowerShell. Unit construction of a
Windows command on Linux is not Windows execution evidence. A platform PASS only
qualifies that actual platform. Missing rigs remain UNPROVEN.

Catalogue entries are keyed by inventory ID, with `cli` (absolute executable
path), optional `model`, `config` and fixture `environment`. HTTP/embedded drivers
need an explicit entry with their inert local service configuration; an empty
entry is probed and fails if the driver is unavailable. Missing keys stay visible.
Never put a real API key in a committed catalogue.

```json
{
  "claude": {"cli":"/absolute/path/to/reviewed/fake-claude"},
  "codex": {"cli":"/absolute/path/to/reviewed/fake-codex"},
  "gpt-sol": {"cli":"/absolute/path/to/reviewed/fake-codex", "model":"gpt-sol-fixture"}
}
```

The current registry lists Fuigo, Grok API, Grok Build, Gemini, Kimi, Droid,
Cursor, OpenCode, Qwen, Hermes, OpenClaw, Cline, Muse, custom ACP, Pi,
OpenAI-compatible chat, Claude, Codex, Antigravity, Box agent, MiniMax and
Copilot, plus the separate Sol model lane. `fuigoagent.ts` and `grokagent.ts` are
compatibility re-exports. `openai-chat.ts` is the runtime behind the registered
HTTP family. A new registry entry is automatically included, even without a
known CLI mapping, and remains UNPROVEN until the rig can run it.

## Mandatory tests and historical baselines

The four `mandatory-*.test.mjs` files replace the superseded No limits assertions
in `nolimits-means-it`, `powershell-fail-closed-104`, `nolimits-means-it-1020` and
`no-limits-r13-gate`. The originals encode protected-target/reader/taint holds that
11-12 forbids. This script-only lane cannot edit those product test files; the
replacement selector and retirement reasons are explicit in `release-legs.mjs`.
The replacements require absolute green, zero skipped assertions, all four files
executed and exit 0. Their red results block release. The old product files still
belong to the repository's full suite; MAIN must reconcile their superseded
assertions there, rather than subtracting their failures by test ID.
The replacement pack also exercises the real release guard after a late symlink
retarget and preserves the existing non-No-limits release-posture control.

`historical-baseline.mjs` preserves the old 1.0.18 fake baseline's exact row
identity. It is used only by historical BASE characterization, never as the
11-12 release oracle. `self-test.mjs` is gate qualification, marked
`releaseGate:false`; its PASS cannot release the application.

```sh
node --experimental-strip-types scripts/no-limits-live/self-test.mjs scripts/no-limits-live/evidence/self-test
```

The mutation qualifier installs one loader mutation per isolated child and first
requires a green control for every suite. It does not rewrite candidate files.
`qualify-product-mutant.mjs` mutates the actual decision implementation to add a
non-wipe card or block a stored permission rule, and the real host capability
predicate to run a disabled feature. An inert file sink records execution.
The feature-off-card mutant bypasses replay capability admission and reaches the real product decision/card path. The native channel mutant removes the production capability predicate wiring and must observe an actual card. Each
mutant must activate, fail its previously green control, and show the injected
behavior in its report. Fake qualification cannot release the application.

## Limits that stay visible

The default origin fixtures use the app's real Telegram pairing/human-link/run
routes with a fake Telegram transport, and its authenticated companion route for
phone sends. A legacy guest row also requires the actual thread level to remain Ask. Explicit
bot rows require the stored explicit marker; missing-origin rows require a separate
ingress witness and Ask. An owner API send is never substituted for missing origin.
They are fake ingress proofs, not a signed-in Telegram/phone delivery claim.
`--fixtures-module FILE` can add rig-owned exact workflow bindings via `install(f)`;
a binding returns `{obs, proof, ...witnesses}`. It cannot replace the expected row
or turn a skipped row into PASS. Changed-input and lost-live-record final-writer
faults run through the production API in the mandatory acceptance leg. The launcher
test proves a stopped isolated server can reload a legacy bot and retain its level;
it does not prove recovery from a crash during an active turn. A missing-input
witness requires a dedicated binding and otherwise fails UNPROVEN; an ordinary
command cannot substitute for it. Independent durable approval/message
accounting must be available; absence is a release failure. The old all-surface
reader experiments remain characterization utilities; nonexistent tap files or
UI endpoints cannot certify or permanently block this gate.

Field rows retain their exact tool/input payload. Earlier-turn outside data is
read in a separate turn. A completed outside read cannot certify an unfinished
field action: the target's own tool completion must match its start event.

The `webhook-in-owner-room` row triggers the real webhook API against the owner's
bot, producing a separate unattended run thread. It makes no claim about a room
webhook endpoint or GUI room delivery. App-denial rows load a restricted denial
fixture while the isolated server is stopped and require a captured write on the
inert local MCP server; no connected account or billable service is used.
The tool's exact app target is checked against the candidate's connected-app
classification. This does not attest a signed-in connector's transport, result
collection or delivery. HighLevel/image delivery across every origin, a full
1.0.18 data-directory migration and an active-turn crash remain outside the
evidence produced here.

The external real corpus and actual macOS/Windows runs are required evidence.
No corpus was supplied to this lane at implementation time. The release command
therefore reports that leg UNPROVEN/FAIL; it never generates 257 synthetic rows
and calls them the real log. See `../nolim-replay/RULING-11-12.md` for the input
contract and faithful-replay limits.

## Review repair: action and candidate evidence

Owner phone/channel rows require the complete requested shell command, that
start's successful completion, and a fresh row's `action.done` containing
`fixture`. The room action has the same contract. Screenshot/browser denial
rows require rig bindings in `f.r2Targets[id]`: `{tool,input,readEffect}`. The
binding must name the real requested tool and full input and independently read
an action-specific effect counter before and after it. `install(f)` in the
reviewed fixtures module may install these bindings. Missing bindings are
UNPROVEN, never replaced with another tool's completion.

`--candidate` must match the actual clean tracked checkout. A rig without `.git`
uses `--candidate-proof FILE`: create it on the exact clean candidate with:

```sh
node scripts/no-limits-live/candidate-proof.mjs . candidate.json
```

The verifier reconstructs the commit object hash, complete Git tree and every
tracked blob (including executable modes and symlink targets). It rejects a
wrong SHA, dirty file, omitted/changed entry or malformed path. A manifest's SHA
label alone supplies no authority. Keep exact checkout bytes on Windows (disable
Git newline conversion). Untracked evidence and dependencies are outside the
tracked tree. Reports record the verified candidate and file count; standalone
replay enforces the same check and accepts the same proof flag.

`qualify-product-mutant.mjs` now invokes `run.mjs --live --release` twice. Its
one-row fake inventory and unrelated mandatory/replay fixtures are explicitly
labelled `qualificationOnly:true`; it exercises the real server, real decision,
real durable accounting, CLI summary and exit code. The ordinary owner action
must pass and create its marker before the actual product mutation adds a
non-wipe card. Those receipts are detector qualification, not application release
proof. See ENGLISH-INVENTORY.md for operator diagnostics and fixture prompts.
## Blocking CI wiring

`test:electron` now includes both gate Node-test globs. `ci/gate-tests.txt`
contains every row from `ci-tiers.tsv`. The all-OS blocking quality job invokes
that command; the Linux quality job also invokes `egress/self-test.mjs` on its
Docker host. The two historical patch files are retained as provenance of the
applied wiring, rather than as pending installation steps.

`qualification.node-test.mjs` runs the gate, product, native-channel, binding and
CI-configuration mutation qualifiers plus the standalone self-test. The workflow
wrapper still requires all ten bindings and all six field rows. Native app cases
save their denial through `/api/bots/:id/access`, then require a matching stored
rule and an inert action-sink receipt. The room case uses an actual webhook and the native agents MCP routine tool
to start a preconfigured room routine. Owner HTTP calls only prepare the isolated
fixture; the webhook action has no owner API send.
Missing evidence remains a failing row.

The English inventory is generated with:

```sh
node scripts/no-limits-live/english-inventory.mjs scripts/no-limits-live/evidence/english-inventory.json
```

It distinguishes operator diagnostics, fixture-only settings lines (including
`feature-off-smoke.mjs` and the replay adapter), and the actual product channel-off
line in `server/routines.ts`. Fixture prose does not prove product UI copy.

## Permission rules and disabled features

For `deny-browser-never`, a rig provides
`f.permissionRuleWitnesses[scenarioId]({spec, obs, site})` returning independent
`ruleInstalled: true`, `source: scenarioId`, and `actionExecuted: true` evidence from the inert target. A tool completion without
that target witness cannot satisfy the row. App permission-rule fixtures must
also prove the action ran. Unknown classifications remain permission rules.

Saved `deny-host-declined` consent is a permission rule and requires RUN
with an independent stored-rule/action witness. Actual switched-off capability
rows use `f.capabilityFixtures[scenarioId]` and return `{obs, proof, featureOff}`.
The `featureOff` witness contains `feature`, `actionExecuted: false`,
`actionNotRunProven: true`, `continued: true`, and `ownerLines: [oneLine]`.
The line must state that the feature is off and name Settings or where to turn
it on. The fixture must read the actual line and capability/target state;
model refusal prose alone is insufficient. Missing witnesses block release.

Independent accounting classes `permission-rule` and the legacy `owner-deny`
require an accepted allow receipt and zero approval records or presentations.
`OFF_WITH_LINE` snapshots additionally require zero tool request/answer,
registration, queue, Electron or mirror activity. Replay labels `deny`,
`owner-deny` and `permission-rule` all require RUN; `feature-off` requires the
matching independent feature witness. Saved denies never grant an exception.

Ask cards whose UI omits classification must match exactly one read-only canonical
approval record by approval ID, request ID, thread ID and displayed message ID.
Only that record supplies reason/evidence/initiator. Missing, duplicate, swapped
or contradictory records fail; an owner's record cannot prove a guest card.
This does not allow any additional No limits cards.

The Python CI wrapper runs the original export/privacy/receipt assertions. Its
structural seal example and schema are pinned copies from `52b44b60f9`, with
hashes in `../nolim-replay/fixtures/seal-provenance.json`. They replace missing
fixture paths; they are never used as a real-log release corpus.

`ci-host-tiers.tsv` records the blocking Linux host tier for `egress/self-test.mjs`. It requires a Docker host and is not executed inside the network-none container. Q4's host self-test is not substituted with a fabricated containment receipt.
