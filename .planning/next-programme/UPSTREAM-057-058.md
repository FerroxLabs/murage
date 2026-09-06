# Released upstream 0.1.57–0.1.58 reconciliation, including the 0.1.55–0.1.56 gap

Recorded 2026-09-06. Supporting ledger for the next programme; not a second roadmap.
Product baseline: Murage `03342b46` (documentation HEAD), released implementation
`ce1b3efb20a1afc89aa0e5cd52a1ab2919c47e11` / Murage 0.1.46.
The diff between those two commits contains only `.planning/STATE.md`.
No product ports, provider calls, upstream tests, or new releases were performed by this review.

Final execution ownership/dispositions are in the P02 table of `../MURAGE-PLAN.md`.
“Planned” below records a research candidate, not automatic authorization for an
entire upstream architecture. The controlling plan explicitly defers the full
bot-folder storage migration and managed Antigravity/native-client expansions,
while selecting bounded compatibility adapters and the named correctness ports.

## Contract and evidence boundary

Outcome: account for released upstream changes after the previous 0.1.54 review,
identify existing Murage equivalents and bounded adaptation packages, and prevent
057/058-only planning from dropping prerequisite or intervening work.
Scope: released source tags/notes and current Murage source. Unreleased upstream
main, Fuigo engine internals, and implementation are excluded.
Acceptance: pinned provenance, full interval manifest, grouped dispositions with
dependencies and verification requirements. Stop: ledger delivered to programme owner.

Method: GitHub release API, exact source-tag refs under `refs/audit/`, git history,
production diffs for the high-impact changes below, selected upstream test/source
inspection, and current-source searches. This is not an assertion that all lines
of every upstream test were audited. No upstream or native tests were run here.
The local fetch also auto-followed upstream tags; main and the worktree were not changed.

## Provenance — release feed is not application source

| Version | Published UTC | Source identity | Primary evidence |
|---|---|---|---|
| 0.1.54 baseline | 2026-09-05 06:17:40 | `f85fb3208332810323ede12fbde587e310ba6d59` | [release](https://github.com/milind-soni/openmausbot-releases/releases/tag/v0.1.54), existing UPSTREAM-RECONCILIATION.md |
| 0.1.55 | 2026-09-05 13:54:31 | Release-note comment pins `0e8b6ae2716f94611a159ee84e84fca6be38dfd3`; current source tag resolves `4c16f7790046b63a63dfdf626968482ca11f5208` | [release](https://github.com/milind-soni/openmausbot-releases/releases/tag/v0.1.55), [source-tag](https://github.com/milind-soni/OpenMausBot/tree/v0.1.55) |
| 0.1.56 | 2026-09-05 14:48:16 | `b230669eda31d7937fbcd4e0c8f2afd9752f6685` | [release](https://github.com/milind-soni/openmausbot-releases/releases/tag/v0.1.56) |
| 0.1.57 | 2026-09-06 08:01:10 | `c015c1d730fba669c33cdb0f34ffc15567e6b648` | [release](https://github.com/milind-soni/openmausbot-releases/releases/tag/v0.1.57), [source](https://github.com/milind-soni/OpenMausBot/tree/c015c1d730fba669c33cdb0f34ffc15567e6b648) |
| 0.1.58 | 2026-09-06 10:18:09 | `0d7b36f8e54ce810d8a0de2a8be29ab4be4bd65a` | [release](https://github.com/milind-soni/openmausbot-releases/releases/tag/v0.1.58), [source](https://github.com/milind-soni/OpenMausBot/tree/0d7b36f8e54ce810d8a0de2a8be29ab4be4bd65a) |

057/058 source tags and the source SHA embedded in published notes agree.
055 does **not**: the current source tag is three commits beyond the notes'
source SHA: `78924e80` serve tunnel, `f52704f7` room receipt/budget,
`4c16f779` recall provenance. Do not retroactively claim those three shipped
in the initial 055 artifacts. They are included in the conservative 054→056 gap
and are ancestors of the unambiguous 056 cutoff.

There are **61 non-merge commits** in the 054→058 interval. The full manifest
below prevents omissions from release-note grouping. The 056→058 source diff is
183 files, 12,456 insertions, 1,611 deletions; this is scope evidence, not work
completed. Source-release version bumps are provenance only: do not copy
OpenMausBot version numbers into Murage.

## Existing ledger reconciliation

The controlling previous cutoff is 054, not 056:
`.planning/UPSTREAM-RECONCILIATION.md`, `upstream-remaining-review.md`,
and `upstream-computer-ownership-review.md`. Their former unreleased trio
`eb1b4abc`, `a6c2b7a3`, `72d389ff` is now in the gap.
Clipboard source was adapted already; its former native-proof limitations are
not erased by this classification. Portable bot backup remains different from
Murage's implemented installation recovery. Team-map redesign remains a UI package.

Historical DEFER/REJECT entries are prior decisions, not permission to omit ideas
from Sean's newly requested whole programme. Carry them into named packages with
explicit prerequisites or exclusions. In particular, managed Antigravity,
browser replacement, native companion applications, full/custom approvals,
portable bot export, and release-channel expansion must remain visible.
The existing stronger Murage desktop/turn/restore authority is retained.

Disposition vocabulary: **Adapt now** means a bounded candidate for the next
implementation wave, not already ported. **Planned** means a cohesive dependency
package. **Equivalent/partial** names current source behavior, not native proof.
**Defer within package** identifies prerequisites; it does not discard the idea.

## 057 and 058 disposition ledger

| Released change / source | Current Murage evidence | Disposition and bounded work | Required checks / dependencies |
|---|---|---|---|
| 058 agent-browser fallback, PR844 `2e6701eb` | No `server/browser-engine.ts` or `browser-engine-release.ts`. `index.ts::browserIntegration` uses the desktop connection. `ComputerPanel.tsx:219` requires `window.muragebox.browser`. Windows browser safety gate remains. | **Planned browser-engine package.** Add pinned optional headless engine fallback and honest desktop/headless/unavailable capability; do not delete the working desktop surface as part of step 1. Adapt environment prefixes, installation ownership, cleanup, credential storage and guest/restored state. | Resolver precedence, exact size/digest rejection, executable/platform validation, read-error handling for existing encryption key, session isolation, guest no-save, restored-state separation, tools only on authorized live turn, process exit/cancel. Native Windows/Linux/macOS engine smoke. Headless stream/takeover is a later package, not delivered by 058. |
| 058 setup/auth error recovery, PR846 `217fa18c` | `server/drivers/antigravity.ts:1` is community `agy` stream-JSON, not managed ACP. No managed lifecycle/runtime files. Current `EngineSetup.tsx` primarily offers terminal commands. | **Defer within managed Antigravity migration**, plus reusable setup-language subtask. Keep fixed startup categories, preserve install failure across snapshot refresh, refresh in finally without masking original failure, use same discovery PATH for auth/chat. “Setup required” must not falsely mean “not installed”. | Requires 054 managed-runtime chain plus 057 confirmed process shutdown. Fake native stderr containing OAuth secrets must not leak; timeout/startup/refresh dual failure; reopen/retry; augmented PATH; native Windows extraction cleanup. |
| 057 Windows Antigravity installer, PR841 `5dd54dde`+`036e8341` | Managed installer absent; the old agy integration is different. | **Planned migration prerequisite.** Wait for verified runtime exit before promotion, retry only known file locks, scope extraction scratch cleanup, preserve original error and existing executable. | Hung/failed validation, locked destination, rename failure, confirmed child close, no cleanup while owned process lives; native Windows. Do not transplant global Gemini config or replace Fuigo ACP internals. |
| 057 bot folder / setup / settings, PR833 `5d69ece9` | Existing `SettingsPanel.tsx`, description/profile fields, profile editing and routine cards; no `bot-folder.ts`, `profile-requests.ts`, `profile-versions.ts`, `setup-mode.ts`, or new settings sections. | **Planned cohesive bot-profile package.** SOUL.md/private workspace, prompt preview, self-setup by chat, hash-bound confirm cards, profile history, overview facts, settings dialog. Split backend migration/authority first, then desktop UI, then companion overview. | Preserve current cwd, bots, conversations, role hierarchy, leases and restore review. Revalidate proposer/target/thread/revision/cwd at confirmation; superseded/replayed cards; durable receipt after partial settlement; mixed changes cannot restore revoked permissions; interrupted approval cleanup; Claude stopping/queue regression; bounded skill imports. UI accessible sections, overflow, narrow layout, full long-diff inspection. |
| 057 routine continuity PR829 `acf88c42` | `RoutineManager` persists outputs, but no continuity option/prompt carry exists in current source. | **Adapt as bounded routine-continuity package.** Opt-in, default off, latest completed redacted report only; bind to same bot/target/runOn. Carry text as fenced untrusted context, not executable instructions. | No carry after reassignment/destination change; exclude failed/cancelled/current run; truncate/redact; clear flag truly deletes it; cadence UI and durable proposal/approval reflect option; offline restored routines remain inactive. Tests upstream `routine-continuity.e2e`, routine manager/request cases adapted to Murage proof. |
| 057 Composio alias PR828 `b01d870d` | `connector-proxy.ts:149::connectorAdds` still returns string slugs; request body drops account alias. Prior pending-OAuth/backend identity fixes do not cover this. | **Adapt now**, end-to-end account intent. Propagate slug+alias through internal request/card/authorize/status completion; retain current capability and unreadable-inventory guards. | Second account cannot reuse first OAuth URL/card or complete from first account's ready status; canonical aliases/deduplication; rejected sender/expired turn makes no provider call; refresh failures preserve existing account. |
| 057 Local VM stream frames PR840 `06bf5cc1` | `containerComputerScreenshot` exists; `index.ts` assigns preview capture for Box/VPS/browser but lacks the new Local VM raw-frame helper. Web polling is not stream-only proof. | **Adapt now** raw `containerComputerFrame` + existing data-URL wrapper and turn-bound stream capture. | SSE-only client gets frames; unchanged web route; no capture under another thread's current VM lease, including final/in-flight screenshot after ownership transfer; cancellation stops poller. |
| 057 CUA MCP ping PR837 `3cf5b195` | Current `mcp-bridge.ts` contains the control gate but no near-side ping interceptor. | **Adapt now.** Handle ping locally and serialize both child and injected output by whole frames. | Ping ID exact echo, notifications no reply, no forwarded ping, tools/call still blocked during human control, fragmented/interleaved input/output and final-line flush; malformed/oversized frames preserve existing limits. |
| 057 unattended approval explanation PR809 `b668441d` | Current `auto-approve.ts` has unattended-block verdict; lacks upstream `approvalHeldReason` and Full/Custom policy model. | **Adapt now for truthful explanation**, dependent on Murage's actual policy. Do not copy “Full access keeps working unattended” until that separate policy is implemented and supported by the selected driver. | Distinguish provider-native, explicit sandbox approval, person/peer/webhook origin, permission versus question, deleted bot, unsupported engine; preserve no unattended privilege escalation. |
| 057 sidebar/hiding PR799 `d4cf6a46` | Murage already has hidden/archive, role-aware last-Chief protection, archive restore UI and bot-avatar support. Its current sidebar is richer and diverged. | **Partial equivalent; planned surgical UI adaptation.** Selected-row treatment, role/title clarity, busy-versus-waiting indicators, consistent Thinking avatar, archive/delete confirmation and focus restoration. Preserve actual fleet eligibility and persistent-computer guard. | Human browser tests for cancel/default focus/Escape/nested drawer, concurrent fleet change before confirm, archive undo, destructive delete, all densities/uploaded avatars. No wholesale Sidebar replacement. |
| 057 Android model settings PR736 `e638daca`+`d1b37416` | Native Android companion tree absent; desktop ModelPicker already exists. Android USB computer tooling is not this client. | **Planned native-companion package**, not a desktop port. Keep distinct display label versus selected model ID and server-authorized model writes. | Requires product/platform packaging and pairing baseline; capability-filtered catalogs, unknown/custom model preservation, signed-in state, real device UI. Mobile overview from PR833 belongs here too. |
| 057 downstream ownership PR650 `3d53d7a2` | Murage owns independent Ferrox release repo, numbering and signed artifacts; source notices retained. | **Equivalent concept; adapt documentation only where gaps remain.** State fork/license provenance and independent release/support channels. | No upstream secrets, destinations, branding or version automation imported. |

Primary diffs: [057](https://github.com/milind-soni/OpenMausBot/compare/b230669eda31d7937fbcd4e0c8f2afd9752f6685...c015c1d730fba669c33cdb0f34ffc15567e6b648),
[058](https://github.com/milind-soni/OpenMausBot/compare/c015c1d730fba669c33cdb0f34ffc15567e6b648...0d7b36f8e54ce810d8a0de2a8be29ab4be4bd65a).
Every short SHA above expands in the exact manifest.

## 055–056 gap: explicit packages, no title-only omissions

| Group / exact commit prefixes | Current state and disposition | Dependencies and acceptance |
|---|---|---|
| Computer destination grid + cloud preview PR800 `f2354e42` | **Planned UI + preview correction.** This is the six-card change: Auto, Cloud, Local VM, This computer, Browser, Off. Current Murage still uses the earlier segmented picker and stale-frame fallback. | Preserve passive Auto inspection, explicit start/wake and current local/VM/VPS capabilities. Fresh SSE frames supersede polls; stale SSE cannot suppress polling forever; cancellation/empty image/decode failure/retry shown truthfully. Browser card availability must use actual engine capability after headless package. |
| “computerAuto” terminology | Neither current Murage nor released058 has a `computerAuto` field in the inspected store/index/picker. Auto is absent `bot.computer`, with separate `autoStartVps`. | Document the existing representation; do not invent a new persistence field merely to match a brief label. Six cards are destinations, not six new engines. |
| macOS paste `eb1b4abc` | **Already adapted source**, recorded by previous ledger; do not duplicate. | Preserve existing items-first/de-duplicate/draft-retention behavior. Source equivalence does not erase any unfinished real native clipboard proof. |
| Additive team import/portable bot backup `a6c2b7a3`; team-map `72d389ff` | **Planned**, historical deferrals retained visibly. Murage installation backup/restore is broader and not a substitute for portable per-bot/team transfer. | Import only owned new IDs, no overwrite of existing conversations, transaction/rollback failures, disabled imported execution and credentials; schema compatibility with future SOUL/profile package. Team-map UI uses Murage hierarchy/design. |
| Native approval parity `23e0a2ae`, deterministic goals fixture `113aa61a` | **Planned policy/driver adaptation**, not blind Full/Custom port. Current Murage uses stronger targeted desktop/turn/shell/routine gates and multiple drivers. | Specify capability map and compatibility per provider; maintain native approval reasons, unattended restrictions and revocation. Goal fixture is test technique; retain current passing semantics. |
| Remote desktop-client chain PR753 + hardening PR802/803/805/807: `a965647b e2138e2f d4ed9a34 ab1021ee 35adc98b b12ad9d0 f8790a94 102157ae 54ad84a7 9d7dc0d7 ec5f353a 2efe9005 f510463c 7a87ec7a cfec1160 0332ec65 6b41a80b cbda93da 597b00f6 09225392 53c95a43 0031f7fb a1ddb6da` | **Planned remote-client package; partial Murage equivalent.** Murage already has private companion capabilities/relay and stricter desktop authority. New desktop-as-remote-client mode is not established by those server controls. Include original WIP commit only through its completed released chain. | Separate local renderer/remote-page capabilities; local-origin helpers declared before IPC use; session revocation closes streams; pairing proof/default-deny scopes; device-local speech; cloud/VPS previews and schedule interval semantics; no remote mutation privilege copied wholesale. |
| CLI serve/tunnel `1a7addd0 78924e80`, guardian/path fix `85de15b2`, VPS docs `9374725b` | **Planned headless deployment package.** Current Murage has installed desktop server/companion/guardian and no top-level Dockerfile or equivalent released serve UX. | Private auth/ownership before listeners, path-run CLI entry guard versus guardian entry, graceful cleanup, bounded tunnel child/no credentials in output, explicit public exposure choice, headless integration of browser fallback. Adapt public-health Docker probe to Murage own API. |
| npm/container release automation `9efaecb8 5d81cbda 59c22d99` | **Planned release-channel expansion** if programme includes npm/Docker. Current signed desktop release is a separate proven channel. | Independent package naming, trusted publishing identity, complete asset list, immutable tags, safe source/release-repo separation. Do not copy upstream destinations/credentials or automatically publish new channels. |
| iOS direct QR `7fab9c6e` | **Defer within explicit native-client package.** Existing iOS archive is historical, not a current shipped native client. | Paired identity/QR replay, revocation, native packaging and device acceptance; do not resurrect obsolete Swift silently. |
| Companion phone-write authentication `142593c1` | **Partial equivalent, reconcile before port.** Current `desktop-policy.ts`, private companion identity and parent/child capability channels are controlling. Upstream introduces a companion mutation token, not a reason to weaken desktop-only routes. | Exact allowed phone actions succeed; administration remains denied; token never browser-visible, wrong source/expired session rejected. |
| Recall across past sessions PR754 `fc53f052` and provenance `4c16f779` | **Planned memory/recall package.** Current runtime lacks `session_search`; current memory and replay are not equivalent. | Same-bot thread ownership, branch selection, bounded snippets, no cross-user/bot leakage; distinguish teammate ask from user-authored content and preserve input provenance. |
| Room receipts/reachability `f52704f7`; notifications/unread/provenance `fd0c41c0` | **Planned coordination correctness package**, building on prior room/peer capability deferrals. Current `index.ts:3128` unconditionally clears bot unread; peer initiation can therefore consume a human badge. Current peer-provenance/room-budget modules from upstream are absent. | Preserve unread on internal turns; human-required peer approval sets waiting state and targets actual room; mirror originating-room ask/reply; visible comm chip independent of tool display; API-origin provenance cannot pretend to be human or lift unattended state/rearm budgets; sanitize names/titles at ingress and prompt use; retain Murage richer reachability. |
| Tool error wrapper PR810 `a4efeaaa` | **Defer/rework within control-error package**, not a mechanical fix. Actual upstream change adds a generic exported wrapper and raw `console.error`; no demonstrated caller wiring in that commit. | Wire only evidenced control boundaries, fixed/redacted diagnostics, maintain error/status contract and no success-shaped loss of failure. A helper's presence is not improved runtime behavior. |
| Release bumps `1d993503 b230669e c015c1d7 0d7b36f8` | **Do not port numbering.** Provenance bookkeeping only. | Murage keeps independent versions and release owners. |

Gap source comparison: [054→056](https://github.com/milind-soni/OpenMausBot/compare/f85fb3208332810323ede12fbde587e310ba6d59...b230669eda31d7937fbcd4e0c8f2afd9752f6685).

## Browser and Antigravity boundaries requiring explicit plan language

058's `docs/plans/browser-engine.md` describes four steps. Only step 1 is
implemented in the released change. Desktop surface removal, watch/takeover,
human-held screenshot refusal, and tool-name adapter are future steps.
The prose example says `AGENT_BROWSER_RESTORE:"1"`, while shipped
`browser-engine.ts::agentBrowserIntegration` correctly uses the session name;
follow source, not that stale example. Guest sessions use random names and
`RESTORE_SAVE=never`. Stored profile session naming and encryption key reads
must fit Murage restore/installation ownership and OS credential constraints.
The released resolver reports a pinned version for an override/PATH hit without
executing that binary's version in the inspected function: independent binary
identity verification belongs in adaptation, not an assumed upstream guarantee.
Installer uses size/digest checks after reading the response body; preserve
Murage's bounded-download standards and scratch cleanup under interruption.

058 is not proof that agent-browser solves all Windows UI/browser needs.
Headless MCP availability is distinct from visible interactive browser takeover.
Do not remove current human-control, protected-field or per-turn browser
capabilities to make the fallback easy. Fuigo remains an independent engine:
test its declared MCP capabilities and cancellation without modifying Fuigo.

Managed Antigravity requires release table, runtime installer, ACP client,
profile isolation and OAuth controller introduced before 055. Include the prior
054 ledger's six deferred managed-runtime changes before PR841/846. The existing
community driver can remain available during explicit migration; do not claim
new setup/auth recovery applies to it unchanged.

## Licensing / adaptation

[Upstream LICENSE at 058](https://github.com/milind-soni/OpenMausBot/blob/0d7b36f8e54ce810d8a0de2a8be29ab4be4bd65a/LICENSE)
is Apache-2.0. Retain applicable copyright/NOTICE and mark modifications;
Murage branding, release owner and prefixes remain Ferrox's.
Upstream's browser plan identifies agent-browser as Apache-2.0; recheck the
exact pinned binary/source license and Chrome distribution terms before shipping
new third-party artifacts. Managed Antigravity runtime redistribution/installer
terms require their own review; an Apache wrapper is not a grant for every binary.
Existing separately licensed `enterprise/` remains excluded from copying;
an “activate all ideas” plan can specify equivalent product behavior without
transplanting restricted implementation.

## Recommended bounded dependency order

1. Restore explicit ledger coverage and select UI/authority contracts.
2. Independent correctness slices: ping, VM frames, connector alias,
   truthful unattended copy, fresh-preview recovery; keep existing authority.
3. Coordination provenance/unread/peer notification/room receipts, then recall.
4. Six-card picker + bot settings/profile/SOUL work (backend state/approval first),
   routine continuity with matching cards and recovery defaults.
5. Headless deployment + agent-browser step 1; managed Antigravity migration.
6. Separate browser desktop replacement/takeover and native companion packages;
   npm/Docker publishing follows explicit channel acceptance.
7. Bring forward remaining pre054 deferred work from the existing ledgers.
   This file supplements those ledgers and does not declare them complete.

## Exact non-merge manifest: 054→058

Every commit is assigned by feature chain above. Merge commits are excluded from
the count, but source release SHAs are preserved in provenance. Android's original
feature branch appears in this manifest even though it was merged in 057.

```text
0d7b36f8e54ce810d8a0de2a8be29ab4be4bd65a chore(release): bump version to 0.1.58 (#847)
217fa18cf0f750d0e59aff8ee951cca413d0df31 fix(antigravity): preserve setup failures and align sign-in discovery (#846)
2e6701eb887e68659855b982aca61210ba4b4983 feat(browser): agent-browser as the bots' browser engine (step 1: headless servers) (#844)
c015c1d730fba669c33cdb0f34ffc15567e6b648 chore(release): bump version to 0.1.57 (#842)
036e83416ee234930151573e88dd987ceb017c8e fix(antigravity): require confirmed shutdown and scope install cleanup
5dd54dde3655f2154df710fc52bf9c37c28c6d93 fix(antigravity): install on Windows — wait for the verified runtime to exit before renaming, retry file locks, never mask the real error
3cf5b1955e95d40c6435cbed83348a11904f710e fix(mcp): answer ping in the Cua stdio bridge
06bf5cc1c90aacb78e3e7ce150d9cfd107a989b2 fix(computer): publish Local VM screen frames to stream-only clients
5d69ece953a931cf66295263acdab69cdad9cc04 The bot is a folder: SOUL.md, self-setup by chat, bot settings dialog, mobile overview (#833)
acf88c424e1e57b14d68b96d7e2691346bd45e15 feat(routines): let a routine carry its last report into the next run (#829)
d1b374160a4432fdb955f2efdde3fa6000260113 fix(android): keep model picker labels distinct from selected values
b01d870d3b1c8797230d6a9ea22f00d07caf4358 fix(composio): carry chat-initiated second-account alias through to auth link (#828)
3d53d7a2c683eff5757e310eac0009ea5184a400 docs: clarify downstream release ownership (#650)
d4cf6a46397e81597ce2076e53e617ad5dafd752 Sidebar polish: chief row, title badge, working indicators, archive/delete confirmation, Thinking avatar (#799)
b668441da25d62671affaf842ffc690c64b65123 fix(approvals): say why Auto stopped when nobody started the turn (#809)
b230669eda31d7937fbcd4e0c8f2afd9752f6685 chore(release): bump version to 0.1.56 (#826)
a4efeaaab26e66ae8d1cf961c4cc5c4dcc42b644 fix(computer-control): add executeToolSafely error boundary wrapper (#810)
85de15b2d121402d4fe3997d2e9f656f7bd527c3 fix(cli): bundles run by path again (guardian split); docker e2e follows the public health probe (#823)
9374725bb10b8627ce6a6563b56568800fcf07cc docs: deploy OpenMausBot on a VPS, step by step, in the repo and on the docs site (#825)
59c22d9969f25a9e36e71e8b6687b281bc1e467f ci(npm): publish through npm trusted publishing and note the package on the release (#824)
5d81cbda8488ace822d04e3a0d7f8dd27486c353 ci(release): start the npm and Docker publishes on the tag the release just created (#822)
142593c1cf991cfa7abf4f6d4c337766b123401b fix(companion): authenticate paired phone writes to the desktop harness (#821)
9efaecb8ce10132ada58dff599dedaa7401f5cdb ci(npm): attach the package tarball to the GitHub release on release tags (#820)
7fab9c6e2d51ef1c6875aa5fa7901143942b62ce feat(ios): pair with a server directly from its QR (#819)
fd0c41c048eed4db90df5dead4decf52e3922f8c Silence for bots, never for the person waiting on one (#818)
4c16f7790046b63a63dfdf626968482ca11f5208 Recall labels a teammate's ask as the teammate's (#817)
f52704f71e6249d83ea0b298b632f67148da7a14 Room posts leave a receipt, and rooms say what a bot cannot reach (#816)
78924e801e36e177f62c488907519c0eadb40db3 feat(cli): `openmausbot serve --tunnel` — a public address with no domain, proxy or open port (#815)
1d993503cb2e8f66dc0e427529cebd3d56f9d2e2 chore(release): bump version to 0.1.55
fc53f0524d29766d713771889746a4df3cbf7800 feat(memory): let a bot recall its own past threads with session_search (#754)
1a7addd0917d5d62801ea25f995b83b750e3ab2f feat(cli): openmausbot serve — one command to run the server anywhere and pair devices (#804)
a1ddb6da67d18e5add856f723fcd4e97871abb2c test(desktop): pin the local-origin gate above the handlers that call it (#807)
0031f7fb42a29d1da6e69b310f4c5edd6632f820 fix(desktop): hoist the local-origin helpers above the IPC registrations (#805)
53c95a439a896317b1838a0e2ce4501ff569cf5d fix(remote): default-deny client scope, sessions end their streams, safer pairing
09225392be485a6a7eb357182ac03cb87ef327a8 fix(desktop): keep a remote server's page away from this computer (#802)
597b00f647a63cff5bf5c83ce8cacb7d72698032 wip: remote sessions hardening (tests pending, do not merge)
f2354e42103223f65ade76c2dad1756c51bdc5a4 fix(computer): restore cloud previews and clarify destination choices (#800)
113aa61ac095a91e841a49bc75d74da4c14f9b73 test(goals): gate busy worker completion deterministically
23e0a2aee6ab6b22d4d20326df39bb01dcf9cef1 feat(approvals): map permission modes across native providers
72d389ffa8b10ebf305c0de624b85c091219aae0 fix(team-map): simplify header and hierarchy connectors
a6c2b7a311271d42abca04f7a8d88d9a0f358774 fix: make team imports additive and add portable bot backups (#797)
eb1b4abc728d318f00cbe4523e8973cb05716696 fix(composer): support pasting images from clipboard on macOS (#789)
cbda93daf6080eef032f594bfbf3e0971cc7a003 fix: address sidebar and HPKE review feedback
6b41a80b2651cc4cde3ab2506d4e53d7fb2de862 fix: keep remote sidebar guard SSR-safe
0332ec65b58b1d212476874338c8d40404863b6b fix: close companion and skill cleanup races
cfec11604d6f776afc97537aac982bdf519ef9d5 fix: address companion access review feedback
7a87ec7a18a0e57c077f5577a3f05d8b3117334c docs: explain companion WebSocket upgrade wiring
f510463c00f71445890a8f892aeb40963c2a21e3 test: stabilize Node 24 verification suite
2efe9005a3157132ef46557e4554b6dc6dd4bf3c fix: preserve companion client mode on current main
ec5f353ae382c8fe5e6750908fe9e5651f666f52 fix: support interval schedules in remote previews
9d7dc0d749e8b9128353fb72d173548dcb522341 Harden desktop companion client features
54ad84a7afd2727ad94300b58d5258a567d53b19 feat: enable connected apps for remote clients
102157ae71fc104499f978834362c6d1c1342b1b feat: keep Mac client voices device-local
f8790a94dc343a4bfda5b1ea41ebc179543f3a86 feat: unify remote access across paired devices
b12ad9d0a699b1e8fd0e87a68fe06e7d4cc566ce fix: complete remote Mac voice calls
35adc98b65b5cd04f21486b7b60a6213f635e44a feat: mirror schedules in remote computer panel
ab1021ee6ac7bdd4b7004217c6c917d89305d3ea feat: add remote routines and VPS previews
d4ed9a3499357cd602f90aef4f1aa3d4d237366d feat: relay VPS desktops to companion clients
e2138e2fa3bf491d419d468a4bea9bdd2cc1e031 feat: support managed HTTPS desktop pairing
a965647bd02a4f3a747ca08ec0ba286cc9d9cd64 feat: add desktop companion client mode
e638dacac7bb5ab2b748c5f19f6a6e4c40e6843b feat(android): add bot model settings
```
