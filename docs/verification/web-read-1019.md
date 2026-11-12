# G-WEB: browser reads and persistent engine notices

Base: `740842495` on `dev/1019-web-read-full`. This implements design r3 and
its parallel design review. The review added room/call notices, an explicit
active-page replay oracle, distinct sink mutants, and an unverified disposition
for installed engine exclusions. No review record has been fabricated.

The refused `cd`, `ls`, `curl`, and Python follow-on remains outside G-WEB.
Its observed result is retained as `followOn`; it cannot make a successful
page-read check fail. Round 2 left approval and card policy unchanged; the narrow round 3 correction is recorded below.

## One browser read route

| Route | Real entry point | Capture and continuation |
| --- | --- | --- |
| `headless` | Headless proxy JSON-RPC | `nativeReadPort` captures outerHTML once, checks URL equality and refuses incomplete responses. |
| `unified` | Mounted browser proxy → authenticated `POST /api/internal/unified-browser` → controller | Same native capture port, bracketed by sensitive-page and current-authority checks. |
| `extension` | Extension runtime/service dispatch → executor | Existing admitted, isolated-world capture through `routeBrowserRead`. |
| `builtin` | Browser proxy `browser_read` | Host-supplied complete text through the accepted-text port. Host/control revalidation precedes every continuation. |

All four call `routeBrowserRead`. The converter remains the canonical
implementation of conversion, redaction, source/view saving and untrusted-page
fencing. The static inventory explicitly permits that implementation module
(`browser-extension-engine-read.ts`) as well as the browser route and URL reader.
It checks fixed tool-reference line hashes, direct/aliased reader calls and
WebDocuments saves. Adding a route or reference requires updating its inventory.

The unified controller owns one document store per Entry. Scope comes only
from the authenticated internal claim, as `botId:threadId`. A different bot or
thread cannot continue a handle. Holds, owner changes, close, forget, delete
and not-running transitions dispose the store. The native relay rejects a
raw `agent_browser_read` before starting the engine, so a missed interception
fails closed. Listing tools and non-read dispatch preserve their existing paths.

Managed browser, direct CDP (Use my Chrome) and guest are driven through the
real HTTP route. Headless JSON-RPC, extension service dispatch and built-in
proxy calls each reconstruct a 40,000 UTF-16-unit source. Cloud-home and
pop-out carrier cases exercise their common controller boundary. These are
fake-transport proofs, not a running Cloud deployment, Chrome binary, or
Electron window test. The extension service fixture grants its site access
before reading, then fails if either site or action consent is requested.
Existing site-access consent policy is outside this change.

The URL reader remains a separate tool lane. Pages are saved once and served
in bounded ranges, with `handle`, `total_length`, `offset`, `next_offset`,
`eof` and `offset_unit: utf16`. Existing saved-origin admission, one-hour
expiry, aggregate capacity, Unicode boundaries, source handles for filtered
views, and truncation refusal remain covered by regression tests.

## Persistent notices

The exhaustive routing table and copy now live in `shared/web-read-routing.ts`.
The server stores `engine limit: web-read:<engine-id>` once per thread and
limited engine, not the English sentence, and skips prewarm. It scans the
whole stored thread so a long transcript does not cause repeated notices.
Switching to another limited engine adds that engine's notice once.

The real ChatView message list and GroupView transcript render the notice
before their Tool calls filters. Rooms also recognize it before the general
Murage/error-row branch and display the emitting bot's name. Full-screen
individual and room calls render the persistent note from their own transcript.
BotSettingsPane adds one self-contained row after the engine controls, with
no layout edits. Notices have `role="status"` and no buttons.

The DOM test mounts the production message list and room transcript, the
production settings pane, and the call notice component. It checks Tool calls
off and on, an ordinary tool row in the same render, exactly one notice, bot
identity in a room, and a JSON-reloaded transcript. It does not claim to run
microphone/audio hardware or mount an entire call session.

New English copy, pending Sol copy review (no approval record created):

- S1, with Kimi Code, Cursor, Cline, Muse Code or Antigravity: “{Engine} can still
  use its own web reader, which may cut long pages short. For pages you need in
  full, switch this bot to Fuigo, Claude, Codex or Gemini.”
- S2: “This custom engine controls its own web tools, so long pages may come
  back cut short. For pages you need in full, switch this bot to Fuigo, Claude,
  Codex or Gemini.”
- S3, with OpenClaw or Box Agent: “{Engine} reads web pages with its own tools,
  not Murage's, so long pages may come back cut short. For pages you need in
  full, switch this bot to Fuigo, Claude, Codex or Gemini.”
- S4: “This engine has not been checked for full web page reads, so long pages
  may come back cut short. For pages you need in full, switch this bot to
  Fuigo, Claude, Codex or Gemini.”
- Room identity fallback: “This bot”.
- Settings title: “Long web pages”. Each settings body uses the corresponding
  first sentence above, then “For pages you need in full, choose Fuigo, Claude,
  Codex or Gemini above.”
- Reader errors: “Browser read scope is required.”, “Browser page changed
  during reading.”, and “Network read must use the mediated reader.” The last
  sentence already existed at the extension sink and is reused at the native
  sink. Existing incomplete-document and inactive-read errors are reused.

## Replay oracle

The 13,342-character sales fixture remains unchanged, including Guarantee,
Fine print and Checkout after character 12,000. It is served inside an HTML
`div`, with text escaped, so active-page conversion yields exactly the original
canonical text without adding preformatted code fences. Its SHA-256 is
`3ce3ebf9e317e045ed4f2a380810426c63a5a1e2e67c700606ae41e1ca3523b4`.

Each fake engine discovers its actual mounted browser tools, opens `/sales`,
and starts `agent_browser_read({length:4000})` **without a URL**. It continues
with the saved handle and next offset. Navigation fetches the source once,
initial read captures the open DOM once, and the three continuations do
neither. The native fake would return only 12,000 units and a truncation marker
if the route and sink were both bypassed.

The gate records the bot's browser fields from GET, observed successful browser
tool events, and per-read unified route receipts. Receipts are correlated by
handle, offset, next offset and EOF to the reconstructed range chain. The
instrumented test loader observes the real route without replacing it. Its
route trace contains metadata only. The live mode installs only this trace,
not the fake native transport. Missing browser/engine availability stays
UNVERIFIED, never PASS.

`gweb` requires exact reconstruction, valid advancing ranges, one navigation,
one capture, three continuations, default browser configuration, successful
browser tool events, matching unified receipts, and zero cards. The old
`web_read` replay runs as a named secondary subcheck. Follow-on shell receipts
are reported separately. No card is approved to manufacture a pass.

## Installed exclusion disposition: P1-3 OPEN

Fake replay establishes Murage route behavior, not the availability of an
installed engine's own tools. Native-reader exclusion remains **UNVERIFIED**,
including both Codex/Sol and Droid/Sol. Closing P1-3 needs isolated installed
engine checks recording binary/version, effective controls, and observed
rejection or catalog absence. No paid engine or installed-engine check was
authorized or run in this job.

| Driver / engine | Routing and remaining limit |
| --- | --- |
| Claude | Agents mounted: `--disallowedTools WebFetch`. |
| Codex, GPT Sol on Codex | Agents mounted: native `web_search` disabled, including page-open. Murage search remains. |
| Droid, GPT Sol on Droid | Agents mounted: `exec -o acp --remove-tools FetchUrl`. |
| Fuigo / Flux | `FUIGO_WEB_FETCH=0`. |
| Gemini | Scoped `tools.exclude` includes `web_fetch`. |
| Qwen | `--exclude-tools=web_fetch`. |
| GitHub Copilot | Agents mounted: `--excluded-tools=web_fetch`, including the wrapper's real spawn path. |
| OpenCode | Inline configuration denies native `webfetch` for the top level and every built-in agent. |
| Grok ACP | Agents mounted: `--deny WebFetch` before `agent`. |
| Hermes | Agents mounted: managed `agent.disabled_toolsets` includes `web` and `browser`. This also removes native search; Murage search remains. Hook/card behavior is unchanged. |
| OpenAI-compatible chat, including Sol | Murage-owned tool catalog, no native page fetch; page transport overflow is an error. |
| Grok chat | Same Murage-owned chat catalog. |
| MiniMax chat | Same Murage-owned chat catalog. |
| pi | Scoped file/shell built-ins and mounted MCP; no native page fetch. |
| Kimi Code ACP | **Residual, visible warning.** No verified per-session Code ACP exclusion. Legacy Python Kimi agent YAML is a different implementation and is not treated as proof. |
| Cursor ACP | **Residual, visible warning.** No verified native reader exclusion independent of permission mode. |
| Cline ACP | **Residual, visible warning.** No verified native browser/page-fetch exclusion on this adapter. |
| Muse Code | **Residual, visible warning.** No verified app-server native reader exclusion. |
| Antigravity | **Residual, visible warning.** No verified native reader exclusion at every permission level. |
| Custom ACP | **Residual, visible warning.** Tool controls are supplied by the external executable; MCP acceptance is optional. |
| OpenClaw | **Unsupported full-page lane, visible warning.** Its gateway owns tools and does not mount Murage MCP. |
| Box Agent | **Unsupported full-page lane, visible warning.** Its remote box owns tools and does not mount Murage MCP. |


## Reproduction and evidence

All execution uses the required remote container wrapper, network none,
repository fake engines, and at most two containers. No Mac or live user data
is touched. Each server is launched with `launchVerificationServer`, the same
isolated control fixture as `control:murage launch`, and closed through its
owned-child lifecycle. Persistent server logs and workflow transcripts are
retained. Evidence directories are 0755 and files 0644, including under umask
077. Temporary fixture homes remain private and are removed at shutdown.

```sh
export IT_JOB=fix-webread-r2
export IT_W=/work/fuigo-builds/swarm-b/bld-webread/wt
export IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh
/work/fuigo-builds/tools/it-remote.sh 'node_modules/.bin/vitest run server/browser-read-route-inventory.test.ts src/components/EngineLimitRow.dom.test.ts scripts/web-read-replay/replay.test.mjs'
/work/fuigo-builds/tools/it-remote.sh 'WEBREAD_REVISION=<candidate-sha> node --experimental-strip-types scripts/web-read-replay/run.mjs --fake --out NEW_EVIDENCE_DIRECTORY'
/work/fuigo-builds/tools/it-remote.sh 'node scripts/web-read-replay/mutants.mjs NEW_MUTANT_DIRECTORY'
```

Evidence is under `.webread-evidence/r2/`. Baseline source snapshots contain
only tracked source from `740842495`; exporting the two existing transcript
components for mounting does not change baseline rendering. Setup/import errors
in early logs are not counted as behavioral RED evidence. The baseline replay
uses the new browser prompt and fake marker against the old routing, so it can
actually detect the old mounted-browser bypass.

The mutant runner restores every changed source in `finally`. It covers each
route, CDP, the native sink, static inventory, scope isolation, notice filters,
deduplication, settings, recognition, copy, rooms/calls, default-route checking
and permissions, plus all 14 prior round regressions. Interception removal
with the sink intact must produce a refused browser read. Removing both must
produce missing continuation evidence. These are separate five-engine mutants.

Round 1 historical evidence remains in `.webread-evidence/r1/` and
[web-read-1019-r1-evidence.json](web-read-1019-r1-evidence.json). Its old combined
follow-on verdict is superseded by the explicit G-WEB/followOn split above.

## Recorded results

All paths below are relative to `.webread-evidence/r2/`.

| Item | RED evidence | GREEN and mutation evidence |
| --- | --- | --- |
| 1: browser route | `red-item1.log` and `red-baseline/baseline-tests.log`: original unified read returns the native prefix without a handle; sink accepts a raw read. | `final-tests-confirmed.log`: all four routes, managed/CDP/guest HTTP and scope cases pass. All eight M1 mutants detected; `extension-mutant-confirmed/` repeats the extension mutant with both card callbacks forbidden on an already authorized site. |
| 2: persistent notice | `red-baseline/baseline-tests.log`: actual direct/room lists and settings lack the note, and turn deduplication fails. | Actual component, copy and dispatch tests pass. All seven M2 mutants detected, including room and call. |
| 3: default-browser replay | `red-baseline/baseline-replay/verdict.json`: all five fake lanes fail with no continuation evidence. | `replay-final/verdict.json`: all five browser lanes PASS, with exact text, one navigation, one capture, three continuations and zero cards. Secondary URL-reader subchecks pass. M3-gate, M3-route and M3-route-and-sink all detected. |
| 4: permissions | `red-permissions-modes.json`: original replay under umask 077 writes a 0700 directory and three 0600 files. | T4 passes under umask 077; M4 detected. The baseline mode observations were recorded before making its raw evidence readable. |

`final-tests-confirmed.log` records 25 passing tests. The wider regression run
in `regression.log` passed 305 tests and found one legacy diagnostics-copy
compatibility failure. Preserving that existing diagnostics helper fixed it;
its test is included in the final 25. Both server and UI TypeScript checks
passed (`types-server-release.log`, `types-ui-release.log`).

`mutants/results.json` records **33/33 detected**: 19 round-2 mutants plus all
14 prior mutants. Raw P1-4 replay logs and verdicts are retained with readable
permissions. The five final follow-on results are `REFUSED_OR_INCOMPLETE` and
remain outside G-WEB. Installed exclusions remain P1-3 OPEN / UNVERIFIED.
A fresh post-build round-3 review is still a separate review step.


## Round 3: first-read consent and release status

Base: `9e6f55e19857ca403bfec8723403090e1c29a724`. This round addresses only
the two P1 findings in `rev-webread-r3/REVIEW-from-last.txt`.

On a read-only extension call, the server supplies the effective conversation
level and proven turn audience. At No limits, an owner turn, paired owner
channel DM, or owner routine reads an ordinary never-granted site without a
site card. This applies to active-page capture and URL reads, including URL
destination admission. Automatic task access does not become a saved owner
Allow. An explicit Never site still reaches the site card and stays Never.
Protected-site checks remain in force. Ask/Auto and non-owner calls retain
their existing consent behavior.

The replay now records `routeVerdict` independently of `verdict` and prints
`Fake routes: ...` on its own line. Missing, OPEN or UNVERIFIED installed
exclusion proof makes G-WEB UNVERIFIED, even when every fake route passes.
The process exits 1 for that unmet release gate. The existing P1-3 disposition
remains OPEN; no installed-engine exclusion proof was claimed or attempted.

Reproduce inside the required network-none container wrapper, with
`IT_JOB=fix-webread-r3`, the same `IT_W` and `IT_ORIG` as above:

```sh
node_modules/.bin/vitest run server/browser-read-route-inventory.test.ts scripts/web-read-replay/replay.test.mjs server/browser-extension-service.test.ts server/browser-extension-c2-integration.test.ts server/browser-extension-decide.test.ts
node scripts/web-read-replay/round3-mutants.mjs .webread-evidence/r3/mutants
WEBREAD_REVISION=<candidate-sha> node --experimental-strip-types scripts/web-read-replay/run.mjs --fake --out NEW_EVIDENCE_DIRECTORY
node_modules/.bin/tsc -b && node_modules/.bin/tsc -p tsconfig.server.json && node_modules/.bin/tsc -p tools/flux-stream-conformance/tsconfig.json
```

The round 3 mutant runner also replays the two source snapshots from the base
revision in `.webread-evidence/r3/baseline/`. It restores sources in `finally`.
`RED-first-read-baseline.log` shows all four first-read cases reaching the old
site card. `RED-release-gate-baseline.log` and its retained fixture verdict show
the old false overall PASS alongside UNVERIFIED installed exclusions. Mutants
restore the old site-consent call, restore destination action cards, remove
the Never card, and promote route success to overall release PASS. Each must
fail a named behavioral assertion; import or setup errors do not count.

Evidence and command results are retained under `.webread-evidence/r3/`.
All server workflows use the isolated owned-child verification fixture, fake
engines and fixture-only pages. No Mac, live user app, or paid engine was used.

Round 3 results: **126 tests passed**, the complete three-command typecheck
passed, both baseline failures reproduced, and all **four mutants were killed**.
All five fake browser lanes passed with zero cards, one navigation, one
capture and three continuations each. The overall release verdict is
**UNVERIFIED** and exits 1. See
[the round 3 evidence summary](web-read-1019-r3-evidence.json) for the source
hashes and exact artifact paths. Leak guard v2 results are recorded separately
in the job evidence and completion report.

For a fresh checkout, prepare the baseline source snapshots with Git before
running the container-only mutant checks:

```sh
mkdir -p .webread-evidence/r3/baseline
git show 9e6f55e19857ca403bfec8723403090e1c29a724:server/browser-extension-service.ts > .webread-evidence/r3/baseline/browser-extension-service.ts
git show 9e6f55e19857ca403bfec8723403090e1c29a724:scripts/web-read-replay/run.mjs > .webread-evidence/r3/baseline/run.mjs
```

## Round 3 follow-up: authority lifetime and Never answers

Base: `99f2a23c11c96a648ae70f40342c78a7a7e6be5f`. This follow-up addresses
only the two BLOCK findings in `arev-fix-webread-r3/REVIEW-from-last.txt`.

Automatic No limits read access lasts for one dispatch. It is kept outside
`taskL1`, never saved as task consent, and removed from both policy and the
extension before the next call. Same-binding transitions to Ask, Auto or a
non-owner turn therefore ask again. Ordinary explicit task grants keep their
existing lifetime.

For an explicit Never site, an immediate Allow or a matching delayed approval
permits one read call. The saved Never rule remains unchanged, and another
call, including continuation, needs a fresh answer. Both active-page and URL
reads cover Never from the binding and from the owner's saved site settings.
Protected-target checks still apply.

Evidence is retained in `.webread-evidence/afix-r3/`. Reproduce baseline REDs
and mutants by preparing the source snapshot with Git, then running the
mutant script inside the required network-none container wrapper with
`IT_JOB=afix-fix-webread-r3` and the same `IT_W` / `IT_ORIG`:

```sh
mkdir -p .webread-evidence/afix-r3/baseline
git show 99f2a23c11c96a648ae70f40342c78a7a7e6be5f:server/browser-extension-service.ts > .webread-evidence/afix-r3/baseline/browser-extension-service.ts
# Run the following in the test container:
node scripts/web-read-replay/afix-round3-mutants.mjs .webread-evidence/afix-r3/mutants
```

The mutants restore automatic task consent, ignore immediate Allow, and skip
delayed approval consumption. The existing regression command and full
three-command typecheck above also apply. The installed-engine exclusion
proof remains OPEN / UNVERIFIED; this follow-up makes no new release claim.

Follow-up results: **141 tests passed**, including all 15 new regression cases.
The full typecheck passed, both baseline failures were reproduced, and all
**three mutants were killed**. See [the follow-up evidence summary](web-read-1019-afix-r3-evidence.json).
