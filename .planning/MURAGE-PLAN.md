# Murage private MVP — active execution contract

## Queued upstream reconciliation: OpenMausBot 0.1.59 / 0.1.60

Sean requested investigation after current role-enforcement and browser-readiness
work. Compare exact released changes against current source, classify already
implemented/applicable fixes/intentional divergence/deferredfeatures, then apply
selected relevant changes with bounded proof. No wholesalemerge, rollback of
Murage behavior, automatic expansion into deferredgroups/marketplace, publication
or external state changes. Preserve current two-round limits per underlying issue.

Selected-port disposition after source review:
- e9d6b523 lightcodepalette: adapted to Murage's Light/Dark skins; user reproduced
  unreadablecode; nativebrowser light/dark/selection/cache-switch checkpassed.
- 351506e0 delayedthinking: ResizeObserver bottom-follow with detachedscrollback
  preserved; helpertests and sharedchat/group integration included.
- 45cc2cf0 Composio catalog: bounded multi-page direct/managed fetch, no partial
  catalogue silently presented as complete, cursorvalidation and lazyicons.
- dbfad94e/d6c9674e heldnote: adapted wording from existing verdictsource;
  no importedapprovalMode or permission decisions changed.
- dd7e4f16/b7133b3b Codexshutdown/lateoutput: explicitusercontinuation completed
  PID-before-observed-event fixture correction. Delayedexit/lateoutput regression
  passed; stop/stopAll/dispose now reject boundedtimeouts without releasing owned
  process/listeners, covered by a 5.5s native fake-process case. Prior36passes
  retained, targeted2passes andservertypesPASS. Archivedfailedpatch retained only
  as history; corrected implementation integrated locally, not in private.6.
- Browserengine replacement/recovery commits: architectural change, notported.
  Retain working Electron surface; separatelyreproducedreadinessrace stillopen.
- Native mobilelocalization/dictation/keyboard changes: no correspondingnative
  products in this fork. Newdeployment stacks and broaderAntigravitypermission
  modes deferred. VMroomauthority/Podmanownership/sandbox/font changes need
  separate compatible/nativeproof scope; no silentprivilege widening.
Full comparisons: UPSTREAM-59-60-RUNTIME.md and UPSTREAM-59-60-UI-PLATFORM.md.

## Approved build-list additions: library discovery and prose cleanup

Separate Bots, Teams and Skills in existinglibrary; teams expose purpose,
expectedoutcomes/examples and memberdescriptions from package metadata before
Addteam. Preserve importreview/IDs/localfirstbehavior; no newmarketplace or
bulkBotMRRimport. BotMRR inspected as optionalfuturetemplate source (20 listed
teams, portableMarkdown; sampleengineering identifiesMIT). Parser already
recognizes botmrr:1, but no newthirdpartytemplate installed by this pass.
Remove emdashes from userfacingprose/descriptions/sitehelp, preserve functional
symbols/emptyvalue placeholders/code/commands/requiredlicensing. No claims or
behaviorchanged. These additions are userauthorized, not verification discoveries.
Relevantfocusedtests/renderedproof+combinedbuild only, shared two-roundlimits.

## Current execution priority — private working build, not RC

Sean explicitly requested all listed integration work: Fuigo1.0.6, bounded sidebar
cleanup, finish Settings/Telegram UX and enginefirst/Firecrawl, consolidate a
private build with accurate install/version/checksum docs, close available native
and signing gates honestly. This authorizes the specifically listed single
Settingsbrowser continuation with adequate timeout; prior2roundhistory retained,
not a freshaudit. Telegram groups remain deferred futureplanning only.
No publicpublication, productionnetworking or installedappoverwrite implied.
Recommendations (not addedimplementation): existing-engine sign-in/reconnect
guidance useful now; new embeddedauthflow, advancedrecovery/isolatedteams deferred.

## Release-focused follow-through approved by Sean

Finish existing Settings/search integration, update Murage's pinned Fuigo from
1.0.4 to Sean's published1.0.6 with exactartifact/integration checks, then one
bounded sidebar cleanup: clearer grouping, readable bot names and reduced
secondary-row clutter while preserving hide/restore, roles, unread and routing.
Capture existing sidebar baseline before editing and freeze concrete changes.
Telegram groups/topics/multiple destinations are now authorized for detailed
planning below, NOT implementation before current release work/sidebar closure.

## Telegram destinations — detailed next-package plan

### Objective and sequencing

Extend the existing SINGLE-OWNER Murage installation to explicitly enrolled
Telegram groups/topics and multiple destinations. Group membership/admin status
never grants Murage authority. Keep one Telegram bot credential and one verified
owner identity; route by immutable IDs, not usernames or topic titles.
Execution order: finish current Settings/search integration, Fuigo1.0.6 and
sidebar; package the release candidate; then obtain execution approval for this
frozen Telegram plan. No multi-user/RBAC/platform expansion hidden in this work.

### Concrete examples

| Telegram destination | Murage target | Context and output |
|---|---|---|
| Sean's private DM with SableCOS_Bot | Sable | Existing owner conversation and private approvals. |
| Operations group, General topic | Sable | Group-scoped thread, not Sean's private Sable thread. |
| Operations group, Development topic | Finch | Its own topic-scoped thread; only Sean may request work. |
| Operations group, Finance topic | Carrie | Separate thread and explicitly selected resources. No automatic private-account disclosure. |
| A separate launch-project group | Assigned bot/team coordinator | Independent project conversation even if the same bot handles another group. |
| Announcements group | Selected published summaries | Outbound-only; group messages never start tasks. |

Multiple destinations means explicit mappings, not broadcasting all replies.
One message goes to one matched route. Same bot can serve several routes without
sharing those routes' transcripts. Unmapped topics do not inherit General's route.
Topic renames preserve ID binding. Topic deletion/group migration pauses affected
routes until revalidated; no automatic retargeting based on display name.

### Authority and information boundaries

1. Only the verified owner's immutable Telegram user ID may start work. Ignore
   non-owner messages before model dispatch/storage/cost; do not summarize the
   whole group or treat other members as delegated requesters by default.
2. Group admins can manage Telegram membership, not Murage permissions. Owner
   commands, replies and enrollment must match the exact group/topic mapping.
3. Require explicit bot-directed commands/replies in groups. Do not depend on
   the bot seeing every message or disable Telegram privacy mode implicitly.
4. Quoted/forwarded team content can be supplied by Sean as source material; its
   authors gain no authority. Forwarded pairing/approval messages never bind.
5. Permission buttons are sent only to Sean's verified private DM. Bind every
   button to connection, route, bot, thread, current request fingerprint, action,
   nonce, expiry and owner. Revoking a route invalidates outstanding decisions.
6. Separate EXECUTION approval from PUBLICATION approval. Allowing an action
   never authorizes posting its output to a group.
7. Group members can read group posts. Default substantive results go privately
   to Sean with a separate 'Post to <group/topic>' single-use button bound to
   the exact rendered text and destination. No model-controlled destination.
8. Group history excludes owner DM and other routes. Only explicitly shared
   persona/context is included, not private bot/section memories by default.
9. A separate transcript/system prompt is not a data sandbox. Existing engine
   inheritance, files and connected accounts may still reveal private material.
   Preserve intentional owner-private Fuigo behavior; do not promise isolation
   without enforcing and verifying the provider/tool/resource boundary.
10. Therefore auto-posted model output is OFF in the first implementation.
    A later optional restricted-context auto-post mode needs actual capability
    enforcement and leak tests; unsupported engines must not offer that mode.
    Fixed non-sensitive acknowledgements can post automatically once authorized.
11. Publication review only protects the Murage delivery path. Group-origin
    execution must not have an unrestricted alternate outbound-posting path.
    Enforce the route's tool/resource policy; if an engine cannot enforce it,
    surface the request privately for owner handling rather than advertise
    isolated autonomous group execution. No prompt-only security guarantee.

### User setup (Channels > Telegram > Add destination)

1. Add the existing Telegram bot to the group; explain minimal required Telegram
   permissions, with no blanket administrator request.
2. Murage creates a short-lived one-time enrollment command. Sean sends it in
   the intended group/topic. Receive/verify owner + bot + actual chat/topic IDs.
3. Show a confirmation card with group/topic name, target bot and its context.
   Defaults: 'Only you can request work'; 'Results privately to you for review'.
4. Save the route and send one fixed confirmation to the enrolled destination.
5. Destination row shows target, mode, status, pause/disconnect and setup help.
   Changing target or audience invalidates old pending work/approvals safely.
6. Owner may choose outbound-only announcements instead of accepting requests.
   Never ask for a BotFather token per Murage assistant.

### Data and implementation seams

- Connection: existing encrypted bot credential + bot identity + verified owner.
- Destination: generated routeId, connectionId, chatId, topicId (explicit optional
  value, never a wildcard), targetBotId, conversationId, inbound/outbound mode,
  enabled state and reviewed-publication policy. Name is display metadata only.
- Enforce a unique active (connectionId, chatId, topicId) mapping. Migrate current
  owner DM additively; do not discard token, chat history or user configuration.
- server/telegram-update.ts: preserve sender/group/topic/forward provenance;
  server/telegram-channel.ts and telegram-service.ts: route-aware enrollment,
  owner admission, durable dedup, polling and route-scoped revocation.
- shared/routine-event.ts and server/routines.ts: route provenance and FIFO per
  conversation; event budgets survive routing/delegation; no unrelated-thread
  interference or cross-route late-event settlement.
- server/index.ts: route-owned conversation/resource construction, existing
  permission resolver, private approval dispatch, content-bound publish decision.
- server/telegram-approvals.ts: distinct permission/publication action kinds,
  domain-separated one-use tokens, exact current request/content binding.
- Settings Channels/Telegram: destination setup/list/status with existing tokens,
  no new standalone administration UI. Add clear channel-origin labels in chat.
- Tests use isolated profiles and fake engines; live pilot uses one owned group,
  two topics and one non-owner test participant with consent. No customer data.

### Bounded implementation packages and acceptance

| Package | Deliverable | Frozen proof | Estimated focused effort |
|---|---|---|---|
| T1 | Destination schema, DM migration, owner enrollment | Existing DM retained; duplicate/forged/expired enrollment refused; no secret output | 3–4 h |
| T2 | Exact group/topic routing and sequential conversations | Two topics -> two correct targets/threads; non-owner/unmapped/forwarded input starts zero work | 4–6 h |
| T3 | Private execution approvals + owner-reviewed group publication | Correct owner/button only; exact action/content/destination; expiry/replay/revoke and target-change refusal; no private-history auto-post | 5–7 h |
| T4 | Add destination, status/pause/remove and clear errors | Keyboard/mobile setup; privacy defaults visible; no dead ends or unexpected broadcasts | 3–4 h |
| T5 | Integration, negative cases, one live pilot and handoff | Owner request in each topic, private decision, exact approved result in correct topic, non-owner ignored, route revoke verified | 5–9 h |

Estimate: 20–30 focused engineering hours, approximately 3–5 working days with
integration and owner pilot time. Confidence medium: current private-channel
plumbing exists, but group privacy/publication is new. Does not include current
release/sidebar work, service outages, new native platform acquisition, or
multi-user administration. Parallelize routing/settings after schema freeze;
root alone owns shared authority/context integration. More agents do not remove
the sequential identity/security/pilot dependencies.

One implementation verification round plus one targeted confirmation across the
package; keep known failure counts visible. No third exploratory audit. Scope
changes or remaining blocked requirements require an explicit decision.

### Not included / longer-term product direction

- No staff roles, invitations, delegated approvals, shared ownership or per-seat
  accounts. Murage remains single-owner with controlled external destinations.
- If a future team product is wanted, add explicit principals, role/resource
  permissions, per-principal quotas, membership revocation and audit attribution
  as a separate milestone. Telegram group membership cannot stand in for this.
- No automatic reading of all group traffic, automatic private-memory sharing,
  public autonomous publishing, cross-topic fan-out or permanent tool grants.
- No attachments/voice expansion or new messaging platforms in this package.

## Authorized engine-first search backup and provider pilot

Sean confirmed engine-managed remains preferred/default. Harness web_search is
available as fallback when the engine lacks search or a native search fails/hits
a limit; fallback uses existing Parallel -> DuckDuckGo. No hidden paid cascade.
Adapter-internal native searches cannot be transparently intercepted; expose the
fallback tool and clear engine instructions, and disclose this limit honestly.
Explicit paid choices Tavily/Exa/Firecrawl stay user-selected; Off stays off.
Add Firecrawl SEARCH only using existing/reference patterns, encrypted credential
custody, safe bounded results and current official API. Brave key gets one direct
API smoke, not an unapproved native provider/crawl feature. One harmless query per
supplied key; never print keys, preserve supplied files, no unlimited retries.
Checks: scoped fallback API+tool prompt tests, Firecrawl adapter/custody/parity,
search settings browser/types/build, single live provider query/citations. Two
verification rounds, reuse previous evidence, no fullsuite. Pending priorSettings
browser gate remains pending, not reset under this package.

## Authorized Settings and Telegram UX pass

Sean approved: separate Models & Engines, Tools & Connections, Channels with a
simple Telegram token/setup/pairing guide; replace raw framing with Telegram
label in chat; settled approval card shows outcome/removes buttons; show pairing
expiry and recovery. Preserve existing design/tokens and desktop-only credential
surfaces. Existing engines/connections deep-link ids retained; channels additive.
No token readback, permissions weakened, new channel integrations or auth flows.
Scope: Settings surfaces/type, rendering-only message helper, Telegram card edits
and expiry state. Root backend, AstraMedium Settings and transcript workers.
Acceptance: persisted/model messages unchanged; single-use decision remains final
even if card-edit fails; safe same-chat/message update; expired code never binds,
renewal is explicit; keyboard-friendly copy/setup/status, no secret screenshots.
Checks: focused unit/security cases, isolated browser checks+screenshots, types
and relevant builds, one private candidate. At most one verification round and
targeted confirmation; reuse existing live decision/history/formatting evidence.

## Authorized Telegram follow-up — shared history, approvals, formatting

Sean approved this bounded package after the live request/reply pilot passed.
Outcome: Telegram messages and replies use Sable's current conversation, with
sequential context; paired owner can allow once/deny exact live permission cards
through expiring single-use Telegram buttons; common Markdown renders safely.
Scope: Telegram transport/intake/service, scheduler thread selection, existing
permission resolver, formatter. No new channels, auth UI, public release or
permanent permission grants. Skill/package/routine proposals requiring richer
review remain in-app; text commands never establish approval authority.
Acceptance: visible same-thread messages and preserved follow-ups; FIFO/no overlap;
owner+chat+sent-card binding, exact pending-card fingerprint, expiry, replay and
revoke rejection; no arbitrary callback payload routed to engine; safe HTML with
bounded output. Keep existing approval and budget checks.
Verification: focused history/scheduler, callback/transport/normalization, formatting
and pending-action tests; server types/build; private app live history/formatting
and harmless permission allow/deny pilot with Sean. One round plus targeted
confirmation. Existing passing unrelated checks are reused. Stop on passing
contract or precise remaining blocked gate; no recursive audit.
Owners: root shared integration/approvals; Astra Medium workers formatter and
routine history. Preserve current profile; use fixtures for destructive/security
tests. Existing installed application and public distribution remain untouched.

Updated 2026-09-07 by Sean's explicit MVP rescope. This section supersedes the
broader programme below for current execution. Historical requirements remain
backlog, not automatic work. Deadline target: overnight Bangkok time; do not
claim a guaranteed finish or weaken a failed gate to meet that target.

## Goal and finish line

Deliver a private, usable Murage MVP: a fresh-installable application with working
engine/browser interactions, reviewed portable packages and starters, notifications,
useful search without a mandatory paid search account, and one safely paired
Telegram owner conversation routed to the Chief by default. Existing installations
and Fuigo's intentional inheritance must remain intact. No public publication.

Done means the integrated candidate starts with new and existing fixture data,
passes the named safety/user-journey checks, and has private artifacts with exact
version/commit/checksums and explicit platform limitations. Telegram requires an
actual owned-chat pilot before it is called working; a mocked adapter is not enough.
Unavailable native platforms or credentials remain explicit unverified gates,
never a cross-platform promise. A status/handoff must distinguish a usable private
Mac candidate from fully verified Windows/Linux installers.

## Frozen work packages and order

| ID | Outcome / ownership | Required evidence and stop condition |
|---|---|---|
| M1 | Root: fix packaged startup FIRST. Reuse the preserved bundler banner; initialize a genuinely absent installation safely before package recovery, retaining refusal for corrupt/unsafe existing roots. | Existing empty-HOME bundled-server/MCP smoke, missing-root regression, existing recovery refusal tests; private build starts without repository node_modules. No feature work before this blocker is settled. |
| M2 | Backend lane: finish minimum cumulative event create/handoff budget, continuation and Telegram-origin enforcement. Reuse paused implementation rather than rewrite. | Resolve existing fixture by naturally finishing the fake resumed turn; prove cumulative cap across continuation/delegation, explicit cancellation closure and ordinary-human control. No unlimited fallback for missing ledger. Room-goal/advanced cross-channel budget work is deferred unless required for enabled Telegram behavior. |
| M3 | Search lane: port Wayland Core's useful search behavior, not a new framework. Retain engine/MCP tools and existing Tavily/Exa; add keyless Parallel -> DuckDuckGo and Brave if its small existing adapter fits this bounded slice. | Verify current official free endpoint before claims; one explicit Auto/free choice with query-transfer disclosure, bounded total deadline/results, sanitized error and actual backend/fallback receipt. At most one fallback, no cancellation/off bypass, no hidden paid-provider cascade. Fixtures plus one non-sensitive live keyless search. A changed external service is reported, not chased with extra providers. |
| M4 | Telegram lane, after M2: finish existing transport/intake into one owner-bound private-chat channel. Desktop-initiated pairing, Chief default, replies to same chat, unpair/revoke, visible delivery failures. | Numeric sender/chat binding; unknown sender/forwarded pairing/replay rejection; durable intake before offset; no bot echo loops; uncertain sends not automatically duplicated; incoming text never attended authority or an approval. Keep approvals in existing Murage UI with useful Telegram guidance, rather than implement callback approval protocol tonight. Real owned-chat receive -> task -> reply and revoke pilot. No group/topic/multibot routing UI for MVP. |
| M5 | Root integration: combine accepted work, preserve existing functionality, create private candidate artifacts. | One combined relevant regression pass covering engine/Fuigo, browser, packages/starters, search, notifications, Telegram, restore exclusion; production frontend/server build and isolated bundled smoke. Mac package/native launch and existing-data fixture check; Windows/Linux build/installer checks only on available authorized targets, report absences. Never replace live app without coordination. |
| M6 | Root closure: private installation instructions, release notes, checksums and concise status/handoff. | One current evidence table for exact candidate, unresolved risks/platform gates and deferred scope; owned temporary resource cleanup. No marketplace, public download site or publication. |

M1 starts immediately. After startup passes, at most two independent workers run
M2/M3 or Telegram work with distinct file ownership; root alone edits shared routes.
Reuse all accepted implementations and unaffected evidence. Do not commission
additional broad audits or rebuild already passing features.

## Deferred from this MVP

- Telegram conversation continuity: current intake creates one routine task per
  message, so follow-up messages lack the previous task's conversation. User
  screenshot demonstrated this; keep as explicit limitation, not a delivery
  failure or a claim that Sable lacks identity. Persistent owner-chat threading
  needs a separately scoped design retaining budgets and revocation semantics.

- In-app engine authentication: Sean observed Claude's `/login` cannot be
  completed from Murage/Telegram. Add a supported engine sign-in/reconnect flow
  and actionable channel error guidance; never imply sending `/login` to a bot
  authenticates its desktop CLI. Explicitly deferred by Sean; current investigation
  remains the discrepancy between working terminal auth and Sable's failed turn.

- Slack, Discord and WhatsApp: coming soon, non-interactive labels only where a
  Channels screen exists. No adapter/pairing/approval implementation tonight.
- Marketplace, hosted/private/unlisted sharing, accounts service, moderation,
  signing infrastructure and public website launch. Offline file sharing stays.
- Advanced handoff/recall, reusable-outcome automation, expanded decision history,
  readiness dashboards, multi-hop workflows and time/spend budget UI. Basic safety,
  cancellation and duplicate protection are NOT deferred.
- Multi-trigger routine editor, GitHub/Teams/Linear/Sentry/PagerDuty adapters,
  Telegram group/topic routing, notification digests, additional localization,
  visual polish and new starter profiles.
- Full self-service VPS onboarding, physical-power-loss campaign and advanced
  recovery/isolated-team features. Preserve current private-host functionality and
  document its verified limits; no new production networking. Hetzner remains a
  build/test resource, not evidence of turnkey cloud readiness.
- Long-duration benchmarks and additional performance tuning without an evidenced
  blocker. Existing Mac/Linux 1/5/10 synthetic results remain valid within scope.

## Execution and verification budget

Sean's MVP execution direction authorizes a targeted continuation of the two
explicitly paused startup/budget repairs. Keep their previous failed checks and
attempt counts visible; this is an explicit scope decision, not a renamed reset.
For each, perform the known correction and one targeted confirmation; a further
failure gets a precise disposition, not a new exploratory cycle.

For new MVP work: freeze acceptance before changes; run one named check set, then
one targeted correction/confirmation if needed. Reuse unaffected passes. Fix only
acceptance failures and demonstrated Critical/High integration blockers. Other
findings go to the deferred backlog without implementation. Never suppress tests,
substitute mock proof for a required live pilot, or silently shrink the finish line.

Token economy: Astra medium; maximum two active workers plus root; concise task
briefs/results; no duplicate searches/full suites/reviews, broad source dumps,
translation campaigns or periodic token-heavy restatements. No numeric token cap
was supplied, so none is invented. Report package outcomes and blockers only.

Existing no-push/no-publication/no-production-change boundaries remain. No live
customer-data writes. Temporary resources only within existing authorization,
with IDs/results/cleanup recorded. Credentials never printed or placed in argv.

Tracker limitation: create_goal was attempted for this MVP but rejected because
the older goal is unfinished. Do not falsely complete the old goal. This document
and STATE are the authoritative user-rescoped objective until the tracker can be
replaced through the product UI. Automatic old-goal prompts do not reactivate
deferred packages.

## Archived broader programme — deferred unless included above

# Murage programme 2 — Connected Workspaces and Safe Sharing

Status: scope authorized; two requested review rounds complete. Final listed clarifications below are applied; local independent Wave 1 work may execute. Live-service gates remain explicit.
Distribution restriction: Sean subsequently requested Murage remain private. Both repositories and all release assets stay private until new explicit public-launch authorization. Website/marketplace/download packages are private preparation and staging only; earlier public-delivery wording below describes the intended eventual outcome, not current publication permission.
Immediate exception: README/install improvements and isolated current-build screenshots are authorized now, within that privacy restriction.
Controlling execution record: `.planning/STATE.md`. This document is the single programme plan; the original requirements are retained below for traceability.

## New goal and starting point

Sean explicitly reactivated the deferred programme and incorporated the September 6 product discussion: make Murage easy to install, configure, connect, automate and share; finish private/cloud deployment and recovery; preserve its local-first, single-user execution model. Document and cross-check the plan, then execute in parallel when the review gate passes. Do not require another approval for ordinary in-scope implementation.

Starting release: **0.1.46**, application `ce1b3efb20a1afc89aa0e5cd52a1ab2919c47e11`, release run `34026884990`, release `383546296` (now private by Sean's request). Historical postpublication run `34028288341` verified seven public downloads and the live packaged Linux updater before access was restricted. Source worktree: `/Volumes/Mando/WaylandBots/murage-astra`, integration branch `codex/murage-reliability`. Preserve that release and its evidence; do not overwrite release assets.

The release is not completion of the old five-stage goal. Full recovery, headless journeys, resource/concurrency work, shared-folder restoration, readiness, budgets, reusable workflows, localization and external channels remain in this programme. The actual scoped Fuigo tool/inheritance proof is **accepted**, per `.planning/fuigo-authorized-proof.json`; older blocked attempts in STATE are historical, not a reason to repeat it.

The goal-tracking API cannot replace an unfinished goal. Keep the prior goal incomplete; this user-authorized objective and its additive scope are recorded here rather than falsely marking the prior goal complete to replace it.

## Product brief — agreed outcomes

1. **Install without a scavenger hunt.** Product-first public README/website, direct platform binaries, truthful prerequisites, useful screenshots, credits and required notices at the bottom. Do not advertise npm installation unless a real supported distributable is published and tested.
2. **A useful workspace immediately.** Three curated starting points: Personal & Home, Solo Business, Business & Team; Start empty remains available. Suggest a small team and a first useful task. Existing installations get an additive preview, never a reset.
3. **Engines and models are not tools or channels.** Separate Engines & Models, Tools & Connections, Channels, and Computers. Detect existing CLIs and accounts, guide installation/sign-in, probe readiness, preserve working configuration.
4. **Clear computer selection.** Six consistent cards: Auto, Cloud, Local VM, This computer, Browser, Off. Auto resolves only to already-authorized, available capabilities and explains its current choice. No implicit paid cloud start, desktop grant or escalation.
5. **Routines respond to events.** A routine is a job; a schedule is one trigger. Support schedule/manual, Telegram/Slack/Discord messages, GitHub events and authenticated webhooks. Add WhatsApp through an official supported integration. Design later adapters for Teams, Linear, Sentry and PagerDuty without pretending they ship in the first adapter set.
6. **One trusted conversation, explicit routing.** Telegram starts with the Chief of Staff as the default entry point. Authorized owners can explicitly map chats/channels/topics to a bot or team. No automatic exposure of every bot or cross-team broadcast.
7. **Secure portable bots.** Export selected bot instructions, appearance, skills and routines with a preview and dependency manifest. Import creates fresh identities and inert automation, inspects dangerous content and asks for local permissions. File exchange works offline before hosted sharing exists.
8. **Sharing and discovery.** Revocable private invitations, clearly labelled unlisted links, public packages, and a curated marketplace on the Murage website. Official starters use the same package format and import checks. This does not introduce shared hosted customer-agent execution.
9. **Useful everyday polish.** Hide/unhide without silently deleting state, disabling routines or changing authority; actionable platform notifications with quiet hours/digests; a consistent web-search capability with selectable providers and honest setup states.
10. **Finish the retained programme.** Private VPS/headless bootstrap and remote administration, recovery provenance and failure handling, bounded resources, safe project-folder undo/isolation, evidence-backed completion, autonomy budgets, durable handoff and critical localization.

## Decisions and exclusions

- Preserve `DESIGN.md` and semantic tokens. Evolve existing roster, composer, settings, approvals and calendar; no rebrand or separate automation application. Use real rendered UI for visual acceptance, not ASCII/mock screenshots marketed as shipped features.
- Reuse `server/team-manifest.ts`, team/skill libraries, routines, webhooks, internal capabilities, install/recovery and provider registry contracts. Extract narrow seams from `server/index.ts` only when required; do not run an adjacent refactor programme.
- A **model tool connection is not an inbound messaging transport**. MCP/Composio can supply actions; Channels owns identity, incoming events, routing, replies and approval delivery across engines.
- Preserve Fuigo's intentional global/project inheritance. No changes inside the separate Fuigo engine, and no blanket isolation or invented native channel claims.
- Imported routines are disabled; imported skills do not run install scripts, fetch remote dependencies, grant authority or activate event subscriptions. Signatures prove provenance/integrity, not harmlessness. Inspection must never promise that all malicious prompts/code can be detected.
- Exclude credentials, session cookies, approval grants, conversation history, private memory and machine-local paths by default. Explicit export selection is not permission to export secrets. Dependencies are requirements, not copied accounts.
- Private sharing means identity-authorized recipients. Unlisted means anyone possessing the link; never label that private. Revocation blocks subsequent access/update, not a promise to erase downloaded copies.
- No paid marketplace checkout, revenue sharing, mandatory telemetry, mandatory hosted agent runtime, autonomous account creation, unofficial WhatsApp session scraping, or silent provider/model purchases in this programme.
- No writes to Sean's live Murage data, production Flux droplets or other agents' repositories. Read-only comparison with Wayland Desktop import/install patterns is allowed; code ports need licensing/provenance and Murage-specific tests.
- README/install edits remain authorized, but public access/publication is now explicitly withdrawn. New app releases, DNS/account-policy changes, paid services and production deployments keep their own authorization boundaries; use owned staging resources first and record any precise external gate. Never widen the release credential silently or reopen the private repository.

## Architecture and cross-cutting contracts

### Common event and permission boundary

Event adapters normalize into one envelope: event ID, source type, workspace/connection identity, sender identity, timestamp, routing target, bounded payload reference and provenance. Authenticate transport before admission; treat content as untrusted data. An event selects a routine/bot but never supplies its permissions. Use the existing internal-turn authority lifecycle and content-bound approval receipts.

Channel-originated turns retain origin class `channel`, including messages from an authenticated owner. A message cannot lift unattended restrictions, activate remembered grants beyond their existing policy, impersonate an attended desktop turn or rearm a budget. Only the normal content-bound single-use approval/control receipt can authorize the corresponding action; plain text such as “run it” is not that receipt.

Local transports are outbound-first: Telegram polling, Slack Socket Mode and Discord Gateway. GitHub polling is available where no ingress is configured. Generic private webhooks may use authenticated tailnet senders. Public SaaS webhooks (including official WhatsApp) require a separately authorized minimal HTTPS ingress/queue or the user's existing relay—not a public Murage control listener or Tailscale Funnel. The private runtime consumes the queue through outbound authenticated requests. The collector validates provider signatures, isolates owner/connection queues, bounds retention/rates, and has no agent-execution/admin authority. Without an approved collector, its dependent webhook modes show an explicit setup gate; local polling/socket modes continue working.

Deduplicate provider deliveries, bound queues/retries, record replay status and prevent bot-message loops. An admitted run has a persistent ID linking trigger, conditions, selected actor, budget, actions, approvals and result. Missed/offline events have an explicit retain/expire policy. The desktop cannot run while powered off; continuous execution requires the configured private host.

Loop lineage and budgets are server-owned, recovered from persisted outbound message IDs/run receipts rather than trusted from incoming headers or prompt text. Ignore self/bot echoes by default; explicitly enabled cross-channel workflows inherit the same budget and a default maximum of three transit hops. Test Slack→Discord→Slack loops and spoofed depth/parent fields. No adapter may reset depth or budget on redelivery.

### Portable package boundary

A versioned manifest binds files/hashes, exported role/instructions/appearance, selected skills, selected disabled routines, required engine/tool versions, declared capabilities and license/provenance. References are remapped to fresh local IDs in an atomic import transaction. Resolve collisions with preview; never overwrite an existing bot, Chief, secret or routine by a claimed ID.

Initial file-ingestion ceilings: 1,000 entries, 50 MiB expanded content, 100:1 expansion ratio, bounded processing deadline; reject traversal, symlinks, device files, duplicate/case-colliding paths and unsupported versions. Check both compressed and streamed expanded sizes. If legitimate packages need larger limits, document an explicit contract change rather than disable validation.

Executable skill assets remain inert until reviewed and executed through the normal sandbox/approval policy. Static checks, secret detection, dependency validation and malicious-instruction warnings are layers, not a safety certificate. Any package update produces a new preview, capability delta and immutable version/hash.

Signing custody: official package signing uses a Ferrox-maintainer-controlled Ed25519 key in an approved OS/hardware secret store or tightly scoped release signing service, never repository files, package payloads or prompts. The application pins a versioned official public-key set. Publisher keys are separate and bound to the publisher account by proof of possession; rotation/revocation updates the trust record and triggers re-review, not silent execution or deletion. Unsigned local file exchange remains allowed with explicit unsigned provenance and the full import policy. Official signing and hosted publication wait for `SIGNING_KEY_CUSTODY` (named maintainer, store/service, rotation and recovery procedure); test keys never become production trust anchors.

### UI and identity boundary

Keep engine installation, provider authentication, model selection, tool accounts and channel accounts distinct. Ready means a usable probe succeeded, not that an install command exited or a login window opened. Channel owners bind stable platform IDs to a Murage identity; usernames, forwarded messages and display names confer no authority. Approval callbacks bind issuer, recipient, request content, expiry and single-use state.

Auto computer mode is an unset/current policy value, not an invented parallel `computerAuto` field. Preserve existing `autoStartVps` semantics. Show the effective destination and reason; use explicit consent before changing cost or authority. Hiding is presentation; archiving, disabling and role changes are separate operations.

## Packages, ownership and acceptance

Each package freezes its exact command set/source SHA before verification. Listed new paths are planned files, not claims they exist. Root serializes shared routes/config/state integration. Owners may not modify another lane's files without coordination.

### P00 — Public README and installation entry point (immediate)
- Own: `README.md`; adapted public releases-repository README/brand/legal assets. Reuse `LICENSE` and `NOTICE`, do not remove them.
- Deliver: concise product lead; five direct stable binary links, versioned release link, platform prerequisites and real install steps; attribution at bottom. Separate public downloads from currently private source access. Inspect `apps/docs` install content for the later website package, not an unverified URL promise.
- Accept: anonymous binary URLs work, platform/architecture labels match assets, local references resolve, source commands match package scripts, npm claims match actual package publication. Public target updated, not merely an unmerged private-branch README.
- Current private-preview disposition: content/screenshots are delivered, repository visibility remains private, and anonymous URLs intentionally return 404. Public reachability becomes a launch gate only after renewed authorization. Five direct links are the convenient stable names (two DMGs, Windows installer, DEB, AppImage); seven hash-verified versioned payloads also include the two macOS updater ZIPs. ZIPs/blockmaps/feeds remain on the release, not duplicated as primary install choices.
- Depends: existing published release only. Two focused documentation checks; no full application suite.

### P01 — Privacy-safe current-build demo screenshots (immediate)
- Own: `docs/screenshots/` (new assets), isolated existing demo/Playwright fixture configuration under `.planning/next-programme/`.
- Deliver: 1–3 actual current UI screenshots using fictional people/company/tasks and disabled schedules in disposable data; connect to P00. Refresh screenshots at feature milestones rather than delaying usable release documentation.
- Accept: images inspected for readability, real implemented state and no personal data/secrets; deterministic recreation instructions and cleanup; never touch `/Applications/Murage.app`'s user data. Synthetic content labelled demo where it could be mistaken for live results.
- Depends: P00 coordination; does not depend on future starter/marketplace implementation.

### P02 — Released upstream reconciliation and selected compatibility ports
- Own: `.planning/next-programme/UPSTREAM-057-058.md` (supporting ledger), selected narrowly owned source/test changes after review.
- Deliver: source-backed disposition through **v0.1.58**, including v0.1.57, the v0.1.55/v0.1.56 gap and dependencies from the previously reviewed v0.1.54 baseline. Pin release-note SHA and source-tag SHA separately; record mismatches. No blanket merge or unreleased-main sweep.
- Initial findings: six-card picker is v0.1.55/PR800; v0.1.57 bot-folder/SOUL work is a large migration; v0.1.58 headless `agent-browser` is relevant to P03. Antigravity changes may depend on an absent managed runtime. Compare every selected change to local equivalents before porting.
- Binding ownership/dispositions are the table below. “Planned” in the research ledger denotes a candidate adaptation, not an implicit promise to port every upstream architecture. Every ledger row must resolve to one of these owners or an explicit defer/reject entry before P02 closes.
- Accept: each relevant released change has evidence and one disposition (equivalent, already present, adapt in named package, defer/reject with reason); selected ports have regression checks and preserved licensing. Freeze cutoff; later releases go to backlog unless explicitly selected.
- Depends: planning research now; port execution after plan review. Carries original Task26.

| Upstream group / released evidence | Binding owner or disposition |
|---|---|
| Account alias `b01d870d` | P06 Tools & Connections seam: preserve selected account through approval/OAuth/status. |
| Local VM frames `06bf5cc1`; six-card/preview `f2354e42` | P07, with turn/VM ownership and stale-frame regression checks. |
| CUA MCP ping `3cf5b195`; tool-error wrapper `a4efeaaa` | P03 transport/stream boundary; preserve human-control gates and typed errors. |
| Unattended explanation `b668441d`; native approval parity `23e0a2ae` | P21, adapt copy/capability mapping only to Murage's actual policy; no wholesale Full-access grant semantics. |
| Routine continuity `acf88c42` | P11 opt-in bounded prior-run context, retrieved from owned stored receipts, untrusted/fenced and never authority. |
| Bot-folder/SOUL `5d69ece9` | P09 implements bounded SOUL instruction interchange alongside current team manifests. Full private-folder storage migration, profile-history/backend rewrite and upstream settings replacement are explicitly deferred: not prerequisites for the requested starters/export, large compatibility surface. Preserve current storage/roles; do not silently port them under UI work. |
| Portable bot/team backup `a6c2b7a3`; team-map `72d389ff` | P09/P10 package compatibility; P16 only the compatible additive team presentation needed for starters. |
| Recall `fc53f052`/`4c16f779` | P22 owned-session recall with provenance, bounded snippets and cross-bot/thread isolation. |
| Room receipts/reachability `f52704f7`; unread/peer provenance `fd0c41c0` | P08 unread/notification behavior; P11/P12 implement origin-class enforcement and no-budget-rearm before channel consumers. P21 owns the later receipt/readiness display, not deferred authority enforcement. Root serializes shared routes. |
| Sidebar/hiding `d4cf6a46` | P08 only the missing role/title/wait-state/restore behavior, preserving the existing richer Sidebar and last-Chief guard. |
| macOS paste `eb1b4abc` | Already-adapted implementation retained; P23 closes any remaining actual native clipboard proof without rewriting the accepted draft-retention logic. |
| “computerAuto” terminology; deterministic goal fixture `113aa61a` | Existing-representation/test-technique reference only; P07 preserves unset computer policy and P24 retains applicable passing fixtures. No redundant fields or automatic rewrite. |
| Companion phone-write auth `142593c1`; remote desktop-client chain PR753/802–807 | P03 server/pairing/revocation dependencies and P23 native/client matrix. Full desktop-as-remote-client UX is deferred unless needed to complete the original private headless journey; no weakening of desktop-local authority. Record that decision before client implementation. |
| CLI serve/guardian/VPS `1a7addd0`/`78924e80`/`85de15b2`/`9374725b`; headless browser `2e6701eb` | P03 private bootstrap/headless browser. Public tunnel convenience is rejected for the private control plane; explicitly separate event ingress as above. |
| Managed Antigravity prerequisite/PR841/846 | Defer managed-runtime migration and those dependent fixes. P06 preserves current community `agy` discovery/setup; no claim that managed recovery shipped. |
| npm/container automation `9efaecb8`/`5d81cbda`/`59c22d99` | P03/P24 distribution decision gate: implement/test a standalone headless package/container only if it is the selected deployment path. Desktop npm install remains unsupported until an actual named published package and clean install are verified. No copying upstream publish destinations. |
| Native Android model settings `e638daca`/`d1b37416` and native companion overview | Defer native client feature ports: no corresponding released client tree in Murage. P23 documents supported browser companion separately from USB computer tools and never claims native parity. |
| Native iOS QR `7fab9c6e` | Defer native-client resurrection; P03/P23 cover supported private browser pairing, not archived Swift client distribution. |
| Downstream ownership `3d53d7a2`; release bumps `1d993503`/`b230669e`/`c015c1d7`/`0d7b36f8` | P00/P18 documentation equivalent, P24 independent Murage release numbering/provenance. Do not port upstream numbers, secrets or destinations. |
| Other ledger rows | P02 must classify as equivalent/already present or assign a named owner with regression criteria. Unselected enhancements remain explicit backlog entries; no silent omission or later automatic expansion. |

### P03 — Private/headless deployment and browser journey
- Own: `installer/`, `companion/`, headless browser adapters under `server/`, `electron/companion*`; assigned seams in `server/index.ts` through root.
- Exact Wave 1 ownership: P03 owns `server/mcp-bridge.ts`/`.test.ts`, its evidenced typed control-error boundaries, `installer/lib/{bind,companion,env-file,network-trust,systemd,tailscale,ui}.mjs` and their focused tests. Root alone edits shared `installer/bin/murage.mjs`, `installer/test/cli.test.mjs`, package scripts and harness startup seams. P04 does not concurrently edit these shared files.
- Deliver: clean private VPS install/bootstrap, non-default ports and space-containing paths, Tailscale pairing/revocation, headless operator administration, restart/reboot and exact-process cleanup. Adapt released headless browser support where appropriate; desktop Browser bridge remains supported.
- Accept: disposable Linux host plus native relevant clients complete install → pair → task → approval → revoke → reboot → reconnect; revoked devices cannot issue work; no public bind/tunnel exposure; owned descendants exit; browser test performs actual navigation/read/action without claiming desktop control. All credentials isolated.
- Headless browser storage uses a per-installation protected key and isolated profile/session directory, not an assumption that an interactive OS keychain exists. Creation is exclusive, unreadable/corrupt keys refuse rather than regenerate, and native owner-only permissions are verified. Guest sessions do not save. Restored installations use fresh authentication realms; portable packages never carry these keys/cookies. Do not introduce a global master-key environment variable as an unreviewed shortcut.
- Depends: P02 browser/dependency decision and existing release baseline. Exact private-host live proof required; unavailable access is an open gate, not a mock pass. Carries Task14.
- `PRIVATE_HOST_TARGET`: root-owned, newly provisioned Vultr Ubuntu 24.04 x64 staging VM under Sean's previously authorized audit account; concrete VM ID/IP/tailnet enrollment and teardown record required before host operations. No VM is provisioned at plan acceptance. This is READY TO PROVISION, not a passed host gate; allowlisted API source IP and access are rechecked without logging credentials. Hetzner is an alternative only after strict host-key verification succeeds. Local transport/installer work may start while this gate is open; live host-dependent verification may not.

### P04 — Complete installation recovery and provenance
- Own: `server/installation-*`, `electron/recovery*`, installer recovery commands/tests; current `.planning/RECOVERY-CLOSURE.md` defines unclosed criteria.
- Exact installer boundary: P04 owns recovery modules under `server/installation-*` and recovery-only test files (new `installer/test/recovery-flow.test.mjs` if needed); recovery subcommand integration in `installer/bin/murage.mjs` and shared CLI tests is root-serialized after P03's edits.
- Deliver: complete record/provenance inventory, damaged-state preservation export, relationship validation, inactive import/restore, explicit activation, credential reauthentication, migration and undo. Keep restoration distinct from portable bot-package import.
- Accept: all declared record kinds round-trip or have explicit supported migration/refusal; damaged bytes preserved; invalid/partial archives cannot replace live state; no replay of completed consequential actions; ENOSPC/fsync/rename failures and abrupt owned-VM power-off recover to a valid old/new state. Native macOS/Windows/Linux packaged dialog/startup/relaunch checks are separate from injected-dialog tests. State physical-power-loss limitations honestly.
- Depends: existing recovery increment; P03 for owned-VM proof. New authorization reopens only listed original unmet requirements, not the closed historical verification loop. Carries Task15.
- Sequencing: P04 can implement record/transaction fixtures concurrently with P03, but its abrupt-VM-power-off acceptance remains open until the P03 disposable host is available. It cannot close on injected filesystem tests alone.
- Two acceptance gates, not renamed verification cycles: P04-A records schema/transaction/fault-injection evidence during parallel local work; P04-B proves abrupt owned-VM interruption after P03 bootstrap. The full P04 package is accepted only after both. Independent waves may advance around an external host blocker, but P24 retains it as incomplete.

### P05 — Bounded resources and concurrency
- Own: SSE/event queues, diagnostic logs/transcript pagination/search and related tests; preserve accepted 64 KiB record/4 MiB segment and 16 MiB Inspector-read bounds.
- Deliver: bounded slow-client queues, explicit resync markers, queue admission/backpressure, cancellation and documented concurrency behavior; no silent deletion of user conversation history.
- Accept: fixed fixtures for 1/5/10 concurrent bots, image-heavy output and large history; per-SSE-client queue at most 4 MiB with recoverable resync, no unbounded retained queue after disconnect, stable idle memory after repeated load/cleanup cycles. Record machine/toolchain/peak RSS/latency and freeze further numeric budgets before changing admission defaults. Do not reduce useful concurrency merely to pass a benchmark.
- Depends: baseline only; integrate event-core changes with P11. Carries remaining Task19.

### P06 — Engines & Models settings and guided setup
- Own: `src/components/EnginesSettings.tsx`, `EngineSetup.tsx`, `ModelPicker.tsx`, provider install/discovery adapters and tests; settings navigation seam root-owned.
- Deliver: Detect → Install → Sign in → Test → Ready for supported Claude, Codex, Gemini, Grok and bundled Fuigo paths; preserve existing installs/accounts. Separate Engines & Models from Tools & Connections and Channels. Make OAuth/subscription vs API-key support explicit per provider.
- Accept: clean/already-installed/broken-install/cancelled-login/offline-probe cases on supported native platforms; no unknown package install commands from user packages, no credentials in argv/logs, no false-ready state. Real provider-auth pilot gates are identified; fake auth never counts as live success. No Fuigo engine rewrite.
- Depends: P02 managed-runtime decision. Native official distribution/installation docs must be checked when implementing each adapter.
- Antigravity remains the existing community `agy` CLI path with truthful terminal-command setup/discovery. The managed ACP installer and upstream PR841/846 recovery are deferred, not silently included. Account-alias port `b01d870d` belongs to this lane's Tools & Connections seam, with root-owned route integration.
- Community `agy` error copy is derived only from its actual PATH, process exit and bounded/redacted stream diagnostics; never display managed ACP daemon/runtime recovery claims for that driver.

### P07 — Six-card computer picker and explainable Auto
- Own: `src/components/ComputerPanel.tsx`, `CloudBackendPicker.tsx`, existing capability helpers/tests; root coordinates policy routes.
- Deliver: six cards from the reference direction with compact descriptions, keyboard selection and clear prerequisites. Auto shows effective destination/reason and never expands permissions or paid resource use silently.
- Accept: all six choices round-trip; desktop/phone/headless and unavailable-provider states remain truthful; Auto respects disabled desktop/cloud-start policies, revocation and budget; light/dark/mobile visual checks and accessible names/focus. Browser mode is not desktop mode.
- Depends: P02 picker port; headless acceptance joins P03. No whole upstream profile migration merely to obtain the cards.
- Browser-card availability follows verified platform/runtime capability: headless Browser stays unavailable with setup guidance until P03 is configured and proven. Auto preserves the existing cloud-start opt-in and cannot fall back to a paid destination without its explicit cost/authorization policy; unknown cost cannot satisfy a finite spend ceiling.

### P08 — Hide/unhide and actionable notifications
- Own: `src/components/Sidebar.tsx`, roster/archive helpers, native notification adapters and notification settings/tests.
- Deliver: Hide from sidebar + discoverable Hidden view + Restore; distinguish Archive/Disable. Notification preferences for approvals/completion/failure/digests, quiet hours, click-through to exact task and privacy-conscious lock-screen text.
- Evolve the existing hidden/archive/restore implementation surgically; do not rebuild Sidebar. Preserve the last-Chief guard for actual role/archive operations. Presentation-only hiding must not invoke the role-changing archive path. Apply selected peer-origin unread/notification corrections without consuming human unread badges on internal turns.
- Preserve/complete existing confirmation behavior, Escape/default focus, nested-drawer focus restoration and archive undo where the selected upstream Sidebar adaptation exposes a concrete gap.
- Accept: hide/unhide preserves roles, routines, conversations and permissions; hidden bots remain findable without accidental activation. Real native notification/click behavior verified per supported OS; unsupported desktop environments explained. Hidden status is not a grant/revocation operation.
- Depends: current role/capability rules; root serializes Sidebar integration with P16.

### P09 — Versioned package schema and selective export
- Own: `server/team-manifest.ts`, team/skill library export seams, new package-manifest/export helper and export UI.
- Deliver: bot/team packages with explicit selection of skills and routines, dependency/license manifest and human-readable export preview. Official starter packages use the same schema. File export works without the website.
- Accept: selective export includes exactly chosen content; secrets/history/private memory/machine paths/permission grants absent; malformed references and incompatible versions rejected; deterministic hashes; dependent skills clearly included or reported, never silently omitted.
- Depends: P02 bot-folder compatibility decision. Preserve backward import of supported existing team formats.
- Schema decision is now fixed: preserve current Murage storage and support its existing team-manifest formats plus a bounded SOUL.md instruction interchange adapter. Do not import upstream cwd, arbitrary folder contents, role grants or runtime configuration through SOUL. Emit only selected approved instructions; full upstream folder migration is deferred. Freeze this adapter/version contract before P10/P16 consume it.
- Scan all selected text/assets before export, not just credential fields: flag embedded tokens, private paths, cookies and local environment-derived values. Known secrets block export until removed; ambiguous findings require explicit review/redaction and never a “guaranteed safe” badge.

### P10 — Secure, transactional package import
- Own: package intake/scanning/preview/transaction helpers (new), `server/team-library.ts`, `skill-library.ts`, import UI; root owns route admission.
- Deliver: Wayland Desktop-style defense-in-depth adapted to Murage, not a claimed universal malware detector. Preview capabilities, executable content, external destinations and setup requirements; regenerate identities; import routines disabled; updates show diffs.
- Accept: traversal/zip-bomb/case-collision/symlink/device-file/secret/identity-smuggling/malicious dependency corpus; import never executes payload, fetches arbitrary dependencies, grants a Chief role or subscribes a trigger. Atomic rollback on failure; fresh local permissions required; signatures do not bypass inspection.
- Depends: P09 and P04 transaction/ownership primitives. Compare Wayland implementation read-only, with provenance/licensing for any port.

### P11 — Unified routine/event execution core
- Own: `server/routines.ts`, `routine-requests.ts`, `webhooks.ts`, new normalized event/trigger store, calendar/routine editor.
- Deliver: Create Routine with instructions, actor, multiple ANY-match triggers, optional conditions, result destination and approval/budget summary. Schedule is one adapter. Separate non-consequential Preview trigger from Run now; enable only after confirmation.
- Accept: scheduled/manual/webhook events pass through one authority path; persistent idempotency keys, retries/backoff, expiry, cancellation, loop prevention and bounded queues; same external event cannot duplicate consequential work. Imported routines stay inert. Delivery failure is visible, not success. Existing schedule behavior migrates without silently reenabling work.
- Optional continuity reads a bounded previous report from the same owned routine's stored run, with explicit opt-in and provenance. It is fenced untrusted context; incoming event payloads cannot nominate arbitrary history, change origin or supply permissions.
- P11 freezes persistent receipt fields, origin classification, inherited budget IDs and no-rearm enforcement in Wave 3 before P12/P13 consumers. P12 verifies platform identity bindings to that contract. P21 later renders/enriches receipts; it cannot postpone or replace these admission protections.
- Depends: existing routines, P05 admission budgets and P09 routine schema coordination.

### P12 — Channel identity/routing and Telegram
- Own: new Murage channel transport/admission modules, Channels settings and tests; reuse existing internal capabilities/approvals.
- Deliver: guided Telegram pairing with Chief of Staff default; explicit opt-in per bot/team/chat/topic mapping. Prefer local polling for private desktops; support authenticated webhook mode where explicitly deployed. Reply to the originating conversation unless configured otherwise.
- Accept: real owned Telegram chat pilot plus replayable adapter tests; stable sender/chat binding, unknown-sender refusal, unpair/revoke immediate, forwarded/replayed/expired approval callbacks rejected, group messages cannot impersonate owner; no cross-team data leakage. Desktop-off limitation and private-host option clear.
- Negative control: a paired owner's “run it” message cannot become an attended desktop-origin turn, bypass unattended holds, widen remembered shell grants or reset budgets. Only a verified content-bound decision receipt can authorize its stated action.
- Depends: P11 and P06 settings separation. External bot credentials are an explicit pilot dependency; do not manufacture live evidence.

### P13 — Slack and Discord transports
- Own: Slack/Discord channel adapters/settings/tests using official APIs, reusing P12 routing.
- Deliver: incoming mentions/DMs and explicitly selected channel events, threaded replies and authorized decision delivery. Reuse MCP/Composio for actions where appropriate, but do not call that an inbound channel implementation.
- Accept: workspace/guild/channel membership and sender permission tests, replay/signature checks, scope-limited subscriptions, bot-loop prevention, reconnect/rate-limit behavior; live owned Slack/Discord pilot demonstrates receive → routine/task → reply → authorized approval → revoke.
- Depends: P12 transport boundary and P11 event core.

### P14 — Official WhatsApp integration
- Own: official WhatsApp adapter and setup/status UI, using P12 identity/event contracts.
- Deliver: supported official business messaging setup, inbound messages and policy-compliant replies; no personal-session scraping or undocumented bridge. Explain provider/account prerequisites and delivery-window restrictions using current official documentation.
- Accept: owned test account/number live pilot, verified incoming signatures/identity, approved outbound templates when required, expiry/rate-limit/refusal/revoke cases. If account access is unavailable, this package stays visibly blocked while independent work advances; it is not removed from the goal.
- Depends: P12; live Meta/provider account authority is a named external dependency.
- WhatsApp's official public ingress uses the separate explicitly authorized collector/queue, not an exposed private control plane. Account approval/live pilot is tracked as Awaiting provider verification when unavailable; it blocks P14 acceptance but not independent P13/P15 sign-off or progression to Wave 6. Do not reclassify it as completed or remove it from whole-goal acceptance.

### P15 — Event adapters and routine usability
- Own: GitHub/webhook trigger adapters and condition editor; channel-trigger bindings consume P12/P13/P14.
- P15 also owns the optional standalone HTTPS event collector/reference service in new `services/event-ingress/`, plus its private-runtime queue consumer. It is not the Murage admin server or a marketplace executor. Gates before any live collector deployment: `INGRESS_HOST_TARGET`, `INGRESS_DOMAIN_AUTHORITY`, `INGRESS_PROVIDER_SECRETS`, `INGRESS_RETENTION_AND_QUOTAS`. Root records actual owner/target values; mutual per-owner authentication and provider-signature verification are mandatory, and an untrusted collector cannot mint user approvals. P14 consumes this interface; local fixtures can proceed before live collector authority, but no public endpoint is opened by default.
- Deliver: GitHub PR/issue/push selections, signed generic webhooks and connected messaging triggers; schedule choices include hourly/daily/weekdays/weekly/monthly/interval/advanced. Connected options first; unavailable options lead to setup, not dead ends.
- Accept: signature/replay/dedupe/filter tests; preview cannot execute work; Run now has explicit effects; event/run history links source, approvals and destination. Preserve existing webhook compatibility without accepting uncredentialed administrative writes.
- Depends: P11; channel adapters are independent additions. Teams/Linear/Sentry/PagerDuty remain explicitly later adapters, not false shipped menu entries.
- P15 collector/queue contract work is pulled forward alongside P11's Wave 3 schema freeze so P14 has an owned dependency before Wave 5; GitHub/condition UI and final channel adapters remain Wave 5. Live collector gates can stay open without blocking outbound Telegram/Slack/Discord modes.

### P16 — Three official workspace starter profiles
- Own: official package assets in existing libraries, `Onboarding.tsx` and additive workspace setup UI; coordinate Sidebar with P08.
- Deliver: Personal & Home, Solo Business, Business & Team plus Start empty; 1–3 suggested roles, one visible primary contact, optional helpers, first-task outcomes and only relevant setup requests. No always-running specialists by default.
- Accept: each profile imports through P10, has no privileged exception; new/partial/existing workspace flows preserve data, cannot replace an existing Chief without explicit local choice, leave suggested routines disabled until approved, and produce a useful first task from user-supplied information even without connected accounts. No invented calendar/inbox access.
- Depends: P06/P09/P10/P11; profiles are hypotheses for adoption, not a claimed 95% coverage statistic.
- Existing workspaces keep the current Chief by default. Suggested imported Chiefs arrive as ordinary agents through P10's atomic transaction unless the user explicitly completes the existing local role-reassignment flow; preserve P08's last-Chief/tier constraints. No dual-Chief state or silent demotion is introduced by starter selection.

### P17 — Consistent web-search capability
- Own: provider-neutral search contract/adapters and Tools & Connections UI; existing MCP/Composio/engine adapters reused when available.
- Deliver: one user-facing web-search capability with explicit provider selection (existing engine/tool, Tavily, Exa where supported), credential reuse, citations and cost/privacy indication. Do not force duplicate accounts or promise an engine's subscription covers third-party search.
- Accept: stable result shape/source URLs, untrusted-result handling, timeout/cancel/rate-limit/quota/offline behavior; no secret leakage; unavailable provider is actionable. Real provider pilot gates separate from fixtures; at least one configured end-to-end search path verified.
- No-provider state is deterministic: if no configured external provider or usable engine/tool search exists, return an immediate setup/refusal receipt. No hanging, fabricated results or silent provider purchase/fallback.
- Depends: P06; current official provider schemas/pricing/policy researched at implementation, not frozen from memory.

### P18 — Website, downloads and documentation
- Own: `apps/docs/app/`, `components/`, `content/docs/`, deployment configuration and verified product assets. Follow `apps/docs/AGENTS.md` and installed Next documentation before edits.
- Deliver: product-first public site, platform downloads/release notes, installation/engine/channel/routine/package documentation and current screenshots; credits/notices accessible at bottom. Explain local/private-host execution and known limits accurately.
- Accept: anonymous visitor can reach the right binary, verify version, install and find setup help; broken-link checks, accessibility/mobile checks and production build; source access/private sharing claims truthful. Live domain/deployment proof requires authorized target access; do not claim an unverified `murage.ai` endpoint works.
- Depends: P00/P01 for early landing; documentation expands with accepted packages. Live DNS/deployment authority remains explicit.

### P19 — Private sharing and curated marketplace
- Own: minimal hosted package metadata/blob/access service under `apps/docs` or a named adjacent service decided in its spec; desktop package discovery client; existing optional control-plane metering where retained.
- Deliver: signed/versioned package records, authenticated private invites, revocable expiring unlisted links, public listings/search, publisher attribution/reporting and moderation. Store packages/metadata, never customer engine credentials or hosted customer-agent execution. Keep offline P09/P10 usable without this service.
- Accept: private cross-account access denied, unlisted semantics explicit, revocation/expiry/enumeration/upload quotas/abuse tests, immutable versions and capability-diff updates; public/unlisted/private end-to-end import uses P10. Optional retained broker accounting failures bounded and anti-abuse identity stable. No payment-processing scope.
- Depends: P09/P10/P18 and authorized hosted account/storage choices. Staging proof before production; record exact operating/retention costs and data-deletion policy before enabling public uploads.
- Entry gates are explicit: `SHARING_IDENTITY_PROVIDER` (approved stable-account/OIDC or email-sign-in service), `SHARING_HOST_TARGET`, `SHARING_OBJECT_STORAGE`, `SHARING_DOMAIN_AUTHORITY`, `SHARING_RETENTION_AND_QUOTAS`. Name actual providers/accounts and owners in P19's frozen spec before implementation beyond interfaces/local fixtures. Until those values are approved/available, P19 is spec-only; offline packages and the public downloads website do not wait. Prefer existing authorized infrastructure after inspecting its fit, not automatic signup for a new service.
- P19's frozen spec must also date the retain/drop decision for optional broker metering before interface implementation, record `SIGNING_KEY_CUSTODY`, and name the human moderation/takedown owner. Private development may proceed; publishing listings, anonymous links or the website remains blocked on Sean's renewed public-launch authorization.

### P20 — Shared working-folder restore and isolated teams
- Own: `server/checkpoints.ts`, canonical working-directory leases, restore preview/undo UI and tests.
- Deliver: safe project-file checkpoint/restore and optional isolated team workspaces without confusing this with installation-state recovery or bot-package import.
- Accept: symlink/case/namespace aliases, concurrent writers, missing paths and interrupted restore cannot corrupt another task; preview and undo usable; source workspaces untouched during evaluation.
- Depends: P04 ownership/recovery primitives. Carries Task20.

### P21 — Readiness, decisions, completion evidence and autonomy budgets
- Own: existing diagnostics/Inspector/settings, `server/decision-log.ts`, goal/routine receipts and policy/usage UI.
- Deliver: one actionable readiness/recovery view; searchable explanations; receipts show deliverables, checks, uncertainty and next action; scoped time/turn/spend budgets inherited through routines/delegation with honest unknown-cost behavior.
- Accept: errors route to the right setup/recovery action, redaction holds, missing evidence cannot become success, stop/revoke prevents further admissions, unknown cost never means free/unlimited, keyboard/mobile flows work.
- Depends: P05/P06/P11/P12; carries Tasks21/22 and reuses existing approved authority semantics.

### P22 — Reusable outcomes and durable handoff
- Own: existing skill/playbook/team package and task recovery systems; use P09/P10 rather than another template format.
- Deliver: save a successful workflow as a versioned package, preview required accounts/permissions, resume with persisted receipts and explicit reconciliation of uncertain external effects.
- Accept: round-trip, missing prerequisites, changed package versions, interrupted tasks and repeated delivery do not silently duplicate external actions; untrusted learned content still needs review before execution.
- Depends: P09/P10/P11/P21; carries Task23.

### P23 — Critical localization and native integration matrix
- Own: `src/locales`, new critical flows, channel/help documentation and native test fixtures.
- Deliver: complete install/setup/import/approval/routine/recovery/error journeys in declared locales; channel/browser/notification/platform capability register matches what actually works.
- Accept: catalog validation and rendered long-text/mobile/keyboard checks, real per-platform notification and supported channel evidence; no inferred Windows browser support while its upstream sandbox gate remains closed. Record absent native/account tests rather than treating skips as passes.
- Depends: each accepted feature increment; final matrix joins all packages. Carries Task24 and remaining Task17 proof.

### P24 — Final integration, release and whole-program handoff
- Own: integration branch, CI/release tooling, this plan/STATE, release notes and exact handoff.
- Deliver: integrate accepted packages with one candidate identity, reconcile P02 selected changes and all old unmet requirements, release only with authority and passing required gates, run public download/update checks, clean owned temporary resources.
- Accept: every requirement below has artifact/runtime evidence or an explicit user-approved disposition; no whole-goal completion while a required live/platform/package gate remains open. Full regression once on final relevant candidate; reuse unaffected focused/native results. Record account-specific release-token blocker until actually fixed; never silently replace it with a broader credential.
- Depends: all required packages. Carries Task25; published 0.1.46 evidence remains historical baseline, not proof of new features.

## Parallel execution and integration order

At most three worker lanes plus root with the current runtime. More external reviewers are separate bounded CLI jobs, not overlapping source owners. All implementation uses Astra medium unless Sean explicitly changes routing; **Fable and Gemini 3.8 Flash are the requested plan reviewers**.

| Wave | Independent lanes | Integration gate |
|---|---|---|
| Now | P00 README; P01 demo images; P02 released-diff research | Immediate documentation can ship after its own checks; no feature execution before plan reviews. |
| 1 | P03 private/headless; P04 recovery; P06 engine/settings | Root integrates route/config/state changes one at a time. P02 small compatibility ports assigned to their owning lane. |
| 2 | P05 resources; P07 computer cards; P08 hide/notifications | Preserve existing grants and roles; rendered/native evidence per package. |
| 3 | P09/P10 package foundation; P11 event core; P18 website foundation | Freeze package/event schemas before adapters and starter assets depend on them. |
| 4 | P12 Telegram/identity; P16 starters; P17 search | Real first-use and channel pilot gates; account blockers do not stop independent lanes. |
| 5 | P13 Slack/Discord; P14 WhatsApp; P15 event adapters | Shared channel core changes root-serialized; no independent permission implementations. |
| 6 | P19 sharing/marketplace; P20 workspace restore; P21 readiness/budgets | Hosted/private ACL and ownership/evidence checks before enabling automation/sharing. |
| 7 | P22 durable outcomes; P23 cross-cutting localization/native proof; P24 closeout | Finish exact outstanding requirements, not a new audit programme. |

Packages within a combined lane are sequential when they share files or dependencies. Root reviews ownership before every dispatch; shared `server/index.ts`, `server/config.ts`, `src/state/store.tsx`, `src/components/SettingsModal.tsx`, `installer/bin/murage.mjs`, `installer/test/cli.test.mjs`, package manifests and lockfile are serialized. A worker returns changed files, source identity, check commands/results, limitations and next safe action. No worker pushes, publishes, changes DNS or touches live user data independently.

Named pilot gates: root records an actual consenting account/resource before live calls for `ENGINE_AUTH_PILOTS`, `TELEGRAM_PILOT_BOT`, `SLACK_PILOT_WORKSPACE`, `DISCORD_PILOT_GUILD`, `WHATSAPP_BUSINESS_ACCOUNT` and `SEARCH_PROVIDER_KEYS`. Channel tokens follow the protected secret-store rules and are never package content. Account-dependent acceptance remains open until real proof; fixtures are allowed for implementation but are not substitutes. Initial dispatch is limited to local/testable slices of P03/P04/P06 while host/account gates are established.

## Verification and review budget

1. Freeze each package's outcome, exclusions, acceptance, platform matrix and named checks before implementation verification. Use existing unit, Node, Playwright, installer and CI commands; add only regression fixtures needed for its contract.
2. Round 1 runs agreed checks and classifies results. Correct change-induced acceptance failures or evidenced blocking High/Critical defects only. Backlog unrelated findings with a destination.
3. Round 2 confirms eligible fixes and required integration. Reuse unaffected evidence. A new reviewer/session/subtask never resets the count. Sean's explicit travel authorization permitted cross-research and continued scoped fixes after two attempts; preserve that exception as explicit history, not an excuse for unbounded audits. Any future additional cycle must cite applicable user authority and a concrete changed hypothesis.
4. Planning gate: Fable and Gemini 3.8 Flash independently review the same versioned plan/context. Return PASS/FLAG/BLOCK with requirement IDs, file/section references, concrete impact and minimal corrections. Reconcile disagreements against source/user intent; fix material findings, then one bounded confirmation review. No silent reviewer substitution. If a requested route is unavailable, report the exact gate while P00/P01 continue.
5. UI follows `DESIGN.md`; inspect light/dark and narrow/desktop views with isolated data. Native capabilities need native checks. Mocked provider success, collected tests or an uploaded artifact are not live-service proof.
6. Source commands: Node 24 + `pnpm typecheck`; focused `pnpm exec vitest run ...`; `pnpm test:electron`; `pnpm broker:test`; `pnpm test:packaged-server`; `pnpm test:human`; installer `node --test installer/test/*.test.mjs`; `pnpm check:contrast`; docs package's declared build/type checks. Freeze exact selections at package entry. No duplicate runs while a handle is live.

## Principal risks and bounded responses

- **Supply-chain package disguised as a useful bot:** inert import, bounded extraction, explicit dependencies/capabilities, fresh IDs, provenance and runtime policy. Never trust a marketplace badge as execution permission.
- **A chat message becomes an administrative command:** authenticated transport + stable identity + scoped route + content-bound single-use approval; channel content remains untrusted.
- **Event storms or loops cause spend/repeated actions:** persistent dedupe, bounded admission/retry, run receipts, concurrency/cost budgets and source-loop metadata.
- **Auto sends private work to an unexpected machine:** only pre-authorized destinations, clear effective destination, explicit paid-start policy and refusal when no eligible destination exists.
- **Upstream migration overwrites Murage semantics:** pinned release diffs, compatibility disposition, additive migration/rollback and targeted negative controls; no wholesale bot-folder/runtime merge for cosmetic UI.
- **Hosted sharing compromises local-first trust:** public service holds packages/metadata only, explicit privacy levels and retention, scoped storage access; local execution and credentials remain customer-owned.
- **Verification churn obscures delivery:** one contract, two rounds, narrow ownership, evidence reuse and explicit external blockers; no renewed audit of the released baseline.

## Traceability to the original programme

| Original requirement | Programme 2 disposition |
|---|---|
| Tasks1–12 accepted release fixes | Preserve scoped evidence; P02/P24 reconcile any original unmet item, not blanket reacceptance. |
| Task13 Fuigo tools/inheritance | Accepted scoped proof retained; P06/P12/P23 test only relevant new integration effects. |
| Task14 private/headless | P03 |
| Task15 complete recovery | P04; P20 is separate project-folder work. |
| Tasks16/17 release/native | Existing release accepted; new release/native matrix P23/P24. |
| Task18 optional broker | P19 only for retained service; no unrequested billing/runtime expansion. |
| Task19 resource/concurrency | P05, accepted log/Inspector increments retained. |
| Tasks20/21/22/23/24 | P20/P21/P21/P22/P23 respectively. |
| Task25 full verification/handoff | P24, never satisfied solely by 0.1.46 publication. |
| Task26 upstream reconciliation | P02 through released0.1.58; all selected ports trace to owning packages. |
| New discussion | P00/P01/P06–P19 plus P21/P22. No lost npm/download, screenshot, starter, hiding, notification, channel or trigger requirement. |

## Review receipts

`.planning/next-programme/reviews/` contains exact reviewed-plan/context SHA256 receipts, requested/observed models, both rounds and reconciliation. Fable 5.1 and Gemini 3.8 Flash returned FLAG in round 2 and explicitly permitted Wave 1 once the listed local clarifications were applied, without another broad review. Those clarifications are now incorporated. Root's plan gate is CONDITIONAL PASS for independent private/local implementation; named live host/account/signing/publication gates remain open. No claim that reviewers returned unconditional PASS, and no third model review. The P02 binding table supersedes candidate wording in the research ledger, including tool-error-wrapper rework and surgical Sidebar focus/confirmation scope.

---

# Historical original five-stage programme — requirements retained above

User authorization: "Proceed ... creating it as a goal 1-5 and do it all" (2026-09-05).
Base: b445ff373edaefdd11f75e777a7cc8c46a137cac. Working branch: codex/murage-reliability.
Approved brief/research: ../notes/murage-audit-2026-09-05 (relative to the workspace parent; absolute /Volumes/Mando/WaylandBots/notes/murage-audit-2026-09-05).

## Constraints and verification contract

- Sean's latest verification constraint: no more than TWO verification rounds per change set. During verification, fix only Critical and High findings (including build-blocking failures). Record Medium/Low findings without extending the loop. Report unresolved findings after round two; do not reset the counter by renaming the same change set. This limits verification work, not the already approved implementation scope.

- Single user, their local machine or private VPS, private Tailscale access.
- No main advancement, push, release, publication, live networking or production-droplet changes without separate authorization.
- Preserve Fuigo's intentional inherited global/project context; changes inside Fuigo belong to its separate owner.
- Preserve the established Murage visual language; improvements use existing skins, semantic tokens and components.
- Code/tests run in this dedicated worktree or explicit disposable fixtures. Never use the user's live data for mutations.
- Record actual test exit status and logs. A behavioral fix needs a relevant failing test/probe or negative control; source presence is not runtime proof.
- Completion requires customer-facing acceptance evidence. Untested native platforms remain open gates.

## Stage 1 — Reproducible integrated baseline

1. [GPT-6] Capture pinned Node-24 full test baseline in a separate snapshot; verify all declared dependencies and record environment and skips. Paths: package.json, vite.config.ts, verification logs. Verify: complete runner result, not a partial log.
2. [GPT-6] Repair test-resource/environment isolation and stale UI expectations. Paths: server/testing/, src/e2e/, affected tests, catalog fixtures. Verify: clean checkout works without user keys, agents, untracked teams or live ports; exact approved user behavior asserted.
3. [GPT-6] Consolidate CI gates and bounded process cleanup, including installer tests. Paths: package.json, .github/workflows/ci.yml, installer/test/. Verify: full suite terminates and reports every required suite accurately.

## Stage 2 — Runtime, authority and recovery

4. [GPT-6] M01: contain malformed request parsing across harness, webhook and companion control. Paths: server/index.ts, server/webhook-ingress.ts, companion/src/control.ts and focused tests/helper. Verify: raw malformed request returns 400 and the same process continues normal requests.
5. [GPT-6] M02/M03: unify execution-policy writer authorization and explicit dev-secret sharing. Paths: server/index.ts, server/sse-visibility.ts, launchers, installer/, fixture bootstrap. Verify: direct uncredentialed writers fail; desktop/headless operator and scoped phone confirmations remain functional.
6. [GPT-6] M04: prevent narrow remembered shell grants expanding through operators/substitutions. Paths: server/auto-approve.ts and tests/approval copy. Verify: benign grant remains useful; chained/alternate execution cannot inherit it.
7. [GPT-6] M05: legacy routine cards require fresh content-bound review without disabling legitimate remote confirmations. Paths: server/routine-requests.ts and tests. Verify: legacy, tampered, duplicate, foreign-owner and cancellation cases.
8. [GPT-6] M08/M20: preserve unreadable/corrupt persisted state and expose recovery. Paths: server/store.ts, config/persistence helpers, recovery UI as needed. Verify: malformed schema, partial JSON and access errors preserve bytes and prevent empty-state overwrite.
9. [GPT-6] M10: surface handshake recovers from temporary HTTP errors and server restarts. Paths: src/lib/surface.ts, live-events integration and tests. Verify: no sticky remote downgrade, no permanent-refusal retry storm.

## Stage 3 — Existing customer fixes and Fuigo contract

10. [GPT-6] HTTPS/listener reconciliation and secure-context-compatible sends. Paths: companion/, electron/companion*, src/components/Composer.tsx, src/state/store.tsx, shared ID helper. Verify: all supported paths send/retry; proxy conflicts remain untouched; useful degraded states.
11. [GPT-6] Capability-aware remote controls and honest save states. Paths: PluginsPanel, RoutineCalendarPage, SettingsModal and request helpers. Verify: visible operations work or explain prerequisites; error responses never become saved configuration.
12. [GPT-6] MCP initialize sequencing, goal wait overflow, role and identity remnants. Paths: server/mcp-probe.ts, server/index.ts/config helper, role components, docs/releasing.md. Verify: focused false-handshake/overflow/role checks and syntax/type gates.
13. [GPT-6] Prove twelve Murage agent tools survive Fuigo inheritance. Paths: server/drivers/acp/fuigo.ts/core.ts, agents-proxy, integration tests/docs. Verify: safe real tool call returns through the harness under inherited configuration; approval/cancel and collision handling; no Fuigo wholesale isolation.

## Stage 4 — Private VPS and release readiness

14. [GPT-6] Complete headless package/bootstrap/pair/revoke/admin journey and owned-process lifecycle. Paths: installer/, companion/, build scripts. Verify: clean disposable environment, non-default ports, spaces, reboot/start-stop, no lingering descendants.
15. [GPT-6] Complete versioned installation backup/restore and migration. Paths: persistence service, installer commands, desktop recovery UI. Verify: consistent database state, safe credential reauthentication, relationships retained, no replay of consequential completed actions.
16. [GPT-6] Close release mutation/semver/API-error/rerun guards. Paths: release and prepare-release workflows, pure helper/tests. Verify: published state transition refuses uploads, auth failure differs from not-found, downgrade/undefined rejected; no workflow actually published.
17. [GPT-6] Validate candidate packages/native capability matrix. Paths: package config/scripts/docs, native tests. Verify: signed or locally staged candidate on actual supported macOS/Windows/Linux environments, updates/rollback; report absent environments honestly.
18. [GPT-6] Conditional optional-broker metering hardening only if retained in selected product. Paths: broker and service configuration. Verify: stable anti-abuse identity, bounded accounting failure; no SaaS/multi-tenant runtime expansion.

## Stage 5 — Performance and practical power

19. [GPT-6] Bound SSE/log/transcript resources and measure concurrency. Paths: event bus/native logs, server SSE, transcript storage/search. Verify: slow consumers, image-heavy output and large histories stay within documented resource budgets.
20. [GPT-6] Safe shared-working-folder restore and optional isolated team workflows. Paths: checkpoints/working-directory leases and related UI. Verify: canonical-path aliases and concurrent writers cannot corrupt each other; restore preview/undo remain useful.
21. [GPT-6] Unified readiness/recovery and searchable decision explanations. Paths: health/capability/diagnostics API, existing settings/inspector UI. Verify: errors route to correct action, credentials redacted, keyboard and mobile use.
22. [GPT-6] Evidence-backed completion and scoped autonomy budgets. Paths: goal/routine receipts, task policy, usage and control UI. Verify: deliverables/checks/uncertainty visible; budget inheritance/stop and unknown-cost behavior honest.
23. [GPT-6] Reusable successful outcome workflows and durable handoff/reconciliation. Paths: existing skill/team/playbook/package and task recovery systems. Verify: versioned template round trip, missing prerequisites, resumed tasks do not silently duplicate external actions.
24. [GPT-6] Complete critical localization journeys and external-channel support register/working integration. Paths: src/locales, critical UI, Murage-side Fuigo channel integration/docs. Verify: actual supported channels route identity/approvals/replies correctly; unsupported cases explicit; no inferred native channel support.
25. [GPT-6] Final full verification and local handoff. Verify all stages against customer brief, re-run meaningful regression/native gates, record remaining environment dependencies, provide exact local branch and evidence. No push/publication implied.

## Added goal requirement — upstream release reconciliation

Sean added this requirement on 2026-09-05, referencing
https://github.com/milind-soni/openmausbot-releases/releases.
It is part of whole-program completion, not a replacement for stages 1–5.

26. [GPT-6] Verify Murage's actual imported upstream baseline, then review
    every relevant released change since that baseline, including overlap with
    the prior selective v0.1.50+ sweep. Pin release/source SHAs and review time;
    distinguish released code from later unreleased main. Build a source-backed
    disposition ledger: already implemented, equivalent local fix, already
    planned, port/adapt now, defer with reason, or reject with reason. Inspect
    actual diffs and dependency chains, not release titles alone. Apply selected
    changes locally with meaningful regression evidence while preserving
    Murage's authority gates, private deployment model, Fuigo inheritance,
    identity, redistribution rights and separate engine ownership. No blanket
    merge, automatic version bump, push or release. Recheck the release feed
    before the final candidate is sealed; document the reviewed cutoff.

Task 25 cannot complete until this added requirement and all selected ports
have been reconciled against the final candidate. The initial cached release
page showed v0.1.51, but the direct GitHub API confirms v0.1.54 is latest,
published 2026-09-05T06:17:40Z. The prior plan was explicitly a selective
v0.1.50+ sweep, so package.json 0.1.44 is not evidence of upstream coverage.

## Execution strategy

First repair wave: request-boundary containment, remembered-shell grants, and surface-handshake recovery are independent file scopes and may run in parallel; the root owns baseline execution and integration. All server/index.ts policy edits after the boundary fix are serialized. UI design adjustments preserve current Murage skins; no new style selection is needed for corrective work.

Each task state, owner, evidence and remaining gate is tracked in STATE.md and the IJFW blackboard. Whole-goal completion is separate from finishing any single stage.
