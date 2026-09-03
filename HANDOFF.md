# Murage — session handoff

> Read this, then the QUEUE section. Everything below the HISTORY separator is
> record, not a to-do list.

## THE PROTOCOL — Sean set this, follow it exactly

1. **Research it properly.** Verify every claim against the code first. This
   repo has now produced ~30 cases where measurement contradicted a written
   plan, including several written the same day.
2. **Cross-audit the plan** before building. 3. **Execute.**
4. **Cross-audit the result, ONCE.** 5. **Fix only Critical and High.**

**Swarm it.** Parallel agents, strictly disjoint files. Agents NEVER run a git
command that writes; the orchestrator commits by explicit path.

## HOW TO BRIEF AN AGENT — this is what makes the swarm work

- **Tell them to contradict you, and mean it.** Twelve lanes across two sessions
  have now corrected the orchestrator and **every single one was right**.
  Working phrasing: *"tell me plainly if any premise I have handed you does not
  survive contact with the code."* Last night that phrasing caught: a brief that
  had ogg/webm support backwards, a premise asserting behaviour that never
  existed, a wrong hypothesis about credential allowlisting, and a third wiring
  point whose absence would have shipped a feature that did nothing.
- **Registering a thing is not creating a thing — verify by BOOTING, not by
  testing.** The worst defect of the night: a driver was added to
  `BUILT_IN_DRIVERS`, every unit test passed, the commit was titled "X is an
  engine now", and the engine was still completely unreachable. Why:
  `BUILT_IN_DRIVERS` populates `driversByKind`, while `instanceConfigs()`
  (`server/config.ts:780`) is the ONLY source of instances. The tests passed
  because they drove `support.spawnArgs`/`transformEnv` directly and never
  touched instance seeding. **Always finish by booting the real harness on a
  spare port and asking it what it actually has:**
      MURAGE_PORT=18877 node scripts/dev-server.mjs
      curl -s localhost:18877/api/instances
  That single check is what turned "all green" into "the feature does not
  exist", and then into `fuigo | fuigoAgent | available | models: 83`.
- **The orchestrator owns the contended files.** `server/index.ts` and
  `server/flux-routing.ts` were mine last night; every lane wrote NEW modules
  and handed back an exact diff with surrounding lines quoted. Five lanes, zero
  collisions. Do this again.
- **`git show HEAD:<file>`, never the file on disk**, when checking whether code
  "already exists". An auditor once read a live lane's UNCOMMITTED work and
  reported it as pre-existing.
- **Controls that share a production rule are NOT independent.** Run them one at
  a time. Applying two masks both and yields a false green.
- **Expect green controls, and treat one as a bug in the TEST.** Four more
  turned up last night, and each was worth having: a test named "refuses a
  declared oversize body without reading it" passed with the precheck deleted;
  a control removing the word `trading` did nothing because `trade` survived and
  matching is prefix-based; a control that failed on the wrong error entirely.
- **Ask for a POSITIVE control too**, so a green means a guard working rather
  than a harness observing nothing.
- **Never run two full server suites at once** — spurious boot failures that
  read as real bugs. Tell auditors NOT to run suites at all; static reading plus
  "describe the test you would write" is higher signal anyway.
- **A suite result older than the last commit is worthless.**
- **Do not let an agent fabricate to satisfy a brief.** The best outcome last
  night was a lane REFUSING to report a `--version` string it could not obtain,
  which is how a wedged machine got diagnosed instead of a phantom packaging bug.
- **API 500/529 kills agents mid-flight.** Work survives because agents never
  git-write. Resume with SendMessage; state persists on disk.

## THE ENVIRONMENT WILL LIE TO YOU — check it before you debug code

Two hours went to this across two sessions. Check both before believing a
symptom.

- **`syspolicyd` can wedge.** On 2026-09-03 it sat at 99.8% CPU with 7h25m of
  CPU time across 6 days of uptime, and **no newly created binary would run at
  all** — a freshly compiled hello-world hung at `_dyld_start`, as did a fresh
  copy of a known-good binary. It presents as "the new build is broken".
  Diagnose with: compile a hello-world and run it. Fix with
  `sudo killall syspolicyd` (it respawns clean). After the fix, first launch of
  any new binary costs ~3.5s to Gatekeeper validation, then 0.00-0.03s.
- **`nohup ... &` from a tool call gets killed** when the call's shell exits.
  Two full suite runs were lost to this, both leaving a 223-byte log that looks
  like a hang. Use the harness's own background mechanism.
- **`npx vitest` is rewritten to `rtk vitest` by a hook**, which tees the real
  output elsewhere and returns nothing until it finishes. A running suite
  therefore looks like a 0-byte log, indistinguishable from a hang. The real
  path is printed at the end as `[full output: ~/Library/Application
  Support/rtk/tee/<id>_vitest_run.log]`.
- **Another session on the same machine competes.** Load average hit 61 with a
  second project's full suite running. A slow suite may not be your suite.

## STATE — 15 commits this session, pushed, `main` in sync

**Five build lanes, then a three-way cross-audit, then three repair lanes.** The
audit found 10 real defects in work that was already committed and green, and
the single worst one was in a commit I had titled as finished. That is the
argument for running it: every lane's tests passed the whole time.

Everything below is committed and green. Highlights from the last session, all
verified rather than relayed:

- **Fuigo is an engine.** It was 165MB of shipped shelf-ware with zero callers.
  Verified by booting the harness, not by a test: `fuigo | fuigoAgent |
  available | models: 83`, first in the fleet. A cross-audit caught that the
  first attempt registered the DRIVER but created no INSTANCE, so it was still
  unreachable — see the briefing note above, it is the most useful thing here.
- **Fuigo 1.0.4**, scoped `@fuigo/*`, six targets pinned, twelve digests.
- **Phone dictation**, server-side, on Groq.
- **Paste-and-extract keys**, where the pasted blob is never React state.
- **The ferret matcher**, 391ms -> 5.4ms and 26 of 27 queries correct.
- **Composio's terms question closed** — multi-tenancy is the product.

### What the cross-audit caught, after everything was "green"

- **The engine had no instance.** `BUILT_IN_DRIVERS` populates `driversByKind`;
  `instanceConfigs()` is the only source of instances. Fuigo was unreachable and
  `defaultSelection()`'s preference was dead code. Fixed in BOTH fleets —
  `DEFAULT_FLEET` alone reaches nobody who has ever launched Murage before.
- **"available" does not mean usable.** `snapshot()` sets available iff
  `--version` exits 0. Murage ships the binary, so Fuigo was about to always win
  and hand every new bot `model: ""`.
- **The matcher's remaining 559 terms.** Not the ~57 the audit first estimated:
  probing all 849 curated terms found 559 that alone produce a one-press confirm
  card. "please save my marriage" offered Customer Success Org. 264 removed.
- **PasteKeys addressed rows by array index across an async boundary**, marking
  the WRONG key saved and destroying its value; and every extracted key really
  was in React state and props despite a header comment saying otherwise.
- **Dictation discarded up to two minutes of speech** if you typed while it
  transcribed, and was an unmetered billable path from a phone.
- **On Windows the bundled binary shadowed a user's own newer install**, because
  `findCliCandidates` could never match a name that already carries `.exe`.

Four of my own written claims were wrong and are corrected in place rather than
left standing: the ogg/webm support order, a `fluxConfigured` justification, a
memo-TTL guarantee, and a comment about vite not collecting `shared/`.

## QUEUE — what is actually left

The six-item queue from the previous handoff is DONE except where an external
dependency blocks it. What follows is the real remainder.

### 1. IMAGE TOOL — specced, built nothing, blocked on Flux and RE-VERIFIED SO
`docs/plans/flux-image-tool.md` is current and carries a dated live-probe block.
**Do not start until `GET /v1/models` carries `capability`, `display_name`,
`list_price_microcents` and `entitlement`.** Probed 2026-09-03: 105 rows whose
keys are exactly `created, id, max_input_tokens, max_output_tokens, object,
owned_by`. Flux reports Request 1 as built, route wiring left.

**Traps already paid for, do not rediscover:**
- Default is `flux-image-nano-banana-2` -> `gemini-3.1-flash-image`, live.
- `flux-image-gpt2` and `-gpt2-low` ARE live now; gpt-image-2 rolled.
- `flux-image-gpt2-high` and `-gpt2-xl` are WIRED, PRICED AND WITHHELD (164.7s
  measured against a ~100s edge cap; they would 524 for every caller).
- **`flux-image-nano-banana-pro-2k` DOES NOT EXIST** and would 400 for every
  caller. The live arms are `-pro` and `-pro-4k`. The old price table is wrong.
- `flux-image-together-flux` is retired but STILL ADVERTISED in `/v1/models`.
- **Image generation answers `402 premium_locked` on our key.** So
  `premium_locked` is the FIRST thing a new user hits, not an edge case. Reuse
  the vocabulary `server/voice/flux-voice.ts` already established for the same
  distinction — the key is fine, the plan is not.

### 2. FLUX-SIDE WORK, already written up and handed over
- `docs/plans/HANDOFF-TO-FLUX-ROUTER-CONNECTIONS.md` — front Composio's broker
  on the Flux key. Murage's half is CONFIG: `activeBroker()`
  (`server/composio.ts:195`) is the one choke point and `brokerRequest` resolves
  through it, so no caller can route around it. The one piece of real work is
  the **OAuth callback, which is stateful and will not survive a naive
  pass-through** — it completes the browser flow and then fails to attach.
- The terms question is CLOSED. Composio's API is keyed on an end-user id and
  Murage already mints one per person (`server/composio.ts:520`). Multi-tenancy
  is the product. `docs/plans/composio-behind-flux.md` has the evidence; do not
  re-litigate it from the public terms page, which reads two ways.

### 3. THE FUIGO LOGIN GAP — known, accepted, written down
A user signed in with `fuigo login` (its own OAuth, `~/.fuigo/auth.json`) and
NO Flux key in App Settings: `fluxConfigured()` is false, so `routableEngine`
(`server/flux-surface.ts:129`) is false, so every `flux-*` row is stripped from
their picker and a persisted `flux-auto` is refused at spawn — even though fuigo
could have run it on its own login. Shipped deliberately: it is strictly better
than the alternative, since without the `FLUX_SURFACE` entry fuigo has no
catalog at all. **The fix requires the gate to know about a second credential
source**, which is its own change and its own controls.

### 4. TWO SMALL, REAL HOLES FOUND IN PASSING
- **`FUIGO_API_KEY` / `FUIGO_CODE_API_KEY` are in NONE of
  `PROVIDER_CREDENTIAL_ENV`, `WORKSPACE_CREDENTIAL_ENV` or `ROUTING_ENV`**
  (`server/config.ts`). So an ambient one in the user's own shell currently
  rides into EVERY driver's child env. The fuigo driver clears both for itself
  when Murage has a key, but the general hole is in config.ts.
- **`executableTarget()` (`scripts/prepare-cloudflared.mjs`) has no aarch64 or
  ARM64 support** — only ELF `0x3e` and PE `0x8664`. That is why
  `linux-arm64`/`win32-arm64` are pinned-but-unstageable behind an explicit
  guard in `prepare-fuigo.mjs`. Adding ELF `0xb7` and PE `0xaa64` is a two-value
  change; it must land together with removing that guard and its comment, or
  the comment becomes a lie.

### 5. THE FERRET'S SURVIVING CASE — deliberate, do not "fix" half of it
"book a table for four at eight" reaches a book-writing profile. `book` is
genuinely the topic word of six profiles and a verb in English, and removing it
breaks "I want to write a book" — the sentence those profiles exist for. A test
pins BOTH halves so nobody fixes one and silently breaks the other.

### 6. COSMETIC, YOUR CALL
`src/components/ProviderIcons.tsx:127` `ProviderMark` has no `fuigoAgent` case,
so the engine Murage leads with renders a grey letter "F" where every other
engine has a real mark. Fuigo ships only terminal braille/ASCII logo art
(`crates/codegen/fuigo-pager/assets/logo/`) — there is no vector asset to
reuse, so this needs a real design decision from Sean rather than an invented
mark.

Also: `registry.describe()`'s `cliCandidates` uses `findCliCandidates("fuigo")` ->
`augmentedPath()`, which does not include `MURAGE_FUIGO_DIR`, so the BUNDLED
engine never appears in the Engines panel's "detected" dropdown. It works
regardless. Arguably a shipped engine should not read as a "detected install".

## RUNNING THE APP — this cost an hour once, do not pay it twice
Dev does NOT fork the harness. Three processes:
  `npx vite` (5199) · `node scripts/dev-server.mjs` (8799) · `npx electron .`
`--experimental-strip-types` does NOT hot-reload, so a server change needs the
harness restarted, and **a harness older than your commits makes a fixed feature
look broken**. Check its start time against `git log` before debugging anything.

Note `knownDirs()` (`server/env-path.ts:38`) already includes `~/.fuigo/bin`, so
a user's own fuigo install is found in dev even though `MURAGE_FUIGO_DIR` is
only set for packaged builds.

--- HISTORY ---` is record, not a to-do list.

--- HISTORY ---

## SESSION 2026-09-03 — superseded by the head above

# Murage — session handoff

> Read this, then §QUEUE. Below `--- HISTORY ---` is record, not a to-do list.

## THE PROTOCOL — Sean set this, follow it exactly

1. **Research it properly.** Verify every claim against the code first. This
   repo has now produced ~20 cases where measurement contradicted a written
   plan, including several written the same day.
2. **Cross-audit the plan** before building. 3. **Execute.**
4. **Cross-audit the result, ONCE.** 5. **Fix only Critical and High.**

**Swarm it.** Parallel agents, strictly disjoint files. Agents NEVER run a git
command that writes; the orchestrator commits by explicit path.

## HOW TO BRIEF AN AGENT — this is what made the session work

- **Tell them to contradict you, and mean it.** Seven lanes corrected the
  orchestrator and every one was right. Working phrasing: *"tell me plainly if
  any premise I have handed you does not survive contact with the code."*
- **`git show HEAD:<file>`, never the file on disk**, when checking whether code
  "already exists". An auditor read a live lane's UNCOMMITTED work and reported
  it as pre-existing; that error was relayed to a lane as a correction.
- **Controls that share a production rule are NOT independent.** Run them one at
  a time. Applying two masks both and yields a false green.
- **Expect one green control per lane.** Seven turned up. Each was a test that
  had never failed and never could. A green control means the test is wrong.
- **Ask for a POSITIVE control too**: prove the rig notices the opposite case,
  so a green means a guard working rather than a harness observing nothing.
- **Never run two full server suites at once** — spurious boot failures that
  read as real bugs.
- **A suite result older than the last commit is worthless.** Two lanes reported
  failures already fixed by a commit landing mid-run.
- **Do not let an agent fabricate to satisfy a brief.** One was asked for a
  toast reading "7 of 9 skills"; the denominator does not exist in the response.
  It counted what failed and added a test forbidding `of <N>`.
- **API 500/529 kills agents mid-flight.** Work survives because agents never
  git-write. Resume with SendMessage; state persists on disk. Verify with
  typecheck + targeted suite before trusting it, then finish the control pass
  yourself if it keeps dying.

## STATE — 24 commits, pushed, tree clean

Everything below is committed, negative-controlled and green. Full list in
`git log`. Highlights: conversational intake replacing the quiz; the matcher
architecture fix (whole catalogue tiered, bm25 demoted to tie-break, so the
right profile is no longer eliminated before the gate); device-door 0.0.0.0
exposure closed; `/api/pair` DoS closed; nine uninstallable skills that ranked
#1 in live search; skill index 8.1s -> 2.2s; a base64 DoS 330ms -> 0.84ms;
installer actually starts the sidecar; Fuigo 1.0.2; the whole Flux surface.

## QUEUE — in the order I would do it

### 1. FUIGO AS THE DEFAULT ENGINE — biggest gap, and it is not close
Murage downloads, checksums, decompresses and ships a **165MB binary that
nothing spawns**. `resolveFuigoCli` (server/env-path.ts:390) has **zero
callers**. No driver, no catalog entry, no way to select it. Bumping to 1.0.2
made the bundled binary correct, not reachable. A fresh user with no CLIs and a
Flux key still has nothing to run, which is the entire zero-terminal pitch.

**VERIFIED THIS SESSION, act on it:** Fuigo is at
`/Volumes/Mando/WaylandBots/Fuigo/fuigo`. It is a Rust fork of Grok Build,
declares `agent-client-protocol` in Cargo.toml, and ships ACP filesystem
adapters (`crates/codegen/fuigo-workspace/src/file_system/acp_fs.rs`). **So it
speaks ACP and goes through `server/drivers/acp/`.**

**Start here:** `server/drivers/acp/grok.ts` already exists and Fuigo is a Grok
Build fork, so it is the closest analog by construction. Read it beside
`qwen.ts` (the simplest ACP driver, 9.4K) for the minimum shape: `DRIVER_KIND`,
the `command` block, a catalog, and `applyFluxSurface(DRIVER_KIND, env, model,
fluxKey())`. Resolve the binary through `resolveFuigoCli`, which already
prefers a user's own install over the bundled copy and fails loudly naming both
paths checked. Then add it to `FLUX_SURFACE`/`FLUX_CAPABILITY` in
flux-routing.ts, and make `defaultSelection()` (server/index.ts:768) prefer it
on a fresh install.

### 2. IMAGE TOOL — specced, unblocked, waiting on their roll
`docs/plans/flux-image-tool.md` is current and revised against flux-router's
reply. Build when `/v1/models` rolls with `capability`/`display_name`/
`list_price_microcents`/`entitlement`; then drop the static seed and the
unverified-price labelling.
**Traps already paid for:** `flux-image-gpt2-high` and `-xl` are WIRED, PRICED
AND WITHHELD (164.7s measured vs a ~100s edge cap; they would 524 for every
caller). `together-flux` is RETIRED and answers 400. Default is
`flux-image-nano-banana-2` -> `gemini-3.1-flash-image`, live today, $0.0806.
`entitlement` fails OPEN, so order and warn on it, never hard-disable.

### 3. PHONE DICTATION — half built, and it fixes a real complaint
Sean cannot use voice on his phone: dictation is a native macOS helper
(`electron/resources/Murage Speech.app`, Apple NSSpeechRecognition, permission
at electron/main.mjs:1949). A phone browser cannot reach it.
`server/voice/flux-voice.ts` (`transcribe()`) is BUILT and tested. Missing: a
route beside the TTS routes at server/index.ts:9762, and the recorder UI.
**Two facts already paid for:** record `audio/ogg;codecs=opus`, NOT the
MediaRecorder webm default, because Flux has no Matroska parser and webm falls
to the slow accuracy arm. And `getUserMedia` needs a secure context, which
`tailscale serve --https=443` already provides. Capture pattern exists at
`src/components/SkillRecorderPage.tsx:208`. It is batch push-to-talk, not
streaming; Flux rejects `stream: true`.

### 4. THE FERRET — the last matcher defect
"ferret keeps escaping the hutch" -> customer-success-org on the word `keeps`;
"gutters need doing before winter" -> validate-before-build on `before`, a word
taken from a profile's own NAME. The gate fires on one whole-word hit against a
bag including 25 skill manifests of prose.
**Do not retry a threshold.** Four axes were measured and good and garbage
overlap on all of them: smart-trader/`trading` and customer-success-org/`keeps`
both score exactly one hit, which is why removing the short-circuit broke
trading. The long-term answer is curated `matches:` terms per profile.

### 5. COMPOSIO BEHIND FLUX — cheap, but check the terms first
`activeBroker()` (server/composio.ts:195) is already the single choke point and
already resolves a URL + token, with a user's own key winning. So pointing
`MURAGE_COMPOSIO_BROKER_URL` at Flux is config, not a rebuild. Flux already has
the entitlement, pricing and metering machinery.
**Do NOT reimplement Composio inside Flux** — OAuth lifecycle across 250+ apps
is a product with a maintenance treadmill, not a routing layer.
**Blocking, non-technical: read Composio's ToS on proxying/reselling.** Then the
OAuth callback flow, which is stateful and will not survive a naive proxy.

### 6. PASTE-AND-EXTRACT KEYS — not started
Paste a blob, extract each key, confirm individually, never echo a secret.
Note: you CANNOT harvest a key from a native subscription (`~/.claude.json`
holds hashes only), so this only ever finds real keys.

## THE FLUX RELATIONSHIP — it works, keep it working
`docs/plans/HANDOFF-TO-FLUX-ROUTER.md` and their reply at
`~/dev/flux-router-evidence/REPLY-TO-MURAGE-2026-09-03.md`. Citing file:line
made three of our four items resolvable without debate. They corrected us twice
and were right both times. Do the same back.
**In flight on their side:** gpt-image-2 rolling, Request 1 built not rolled,
streaming dispatcher built, route wiring left.

## RUNNING THE APP — this cost an hour
Dev does NOT fork the harness. Three processes:
  `npx vite` (5199) · `node scripts/dev-server.mjs` (8799) · `npx electron .`
The app says so on screen when the harness is missing. `--experimental-strip-types`
does NOT hot-reload, so a server change needs the harness restarted, and a
harness older than your commits will make a fixed feature look broken. Check its
start time against `git log` before debugging anything.

## SESSION 2026-09-03 (earlier head) — superseded

# Murage — session handoff

> **Read this section, then §OPEN. Everything below `--- HISTORY ---` is the
> record of earlier sessions and is not a to-do list.**

## THE PROTOCOL — Sean set this explicitly, follow it exactly

1. **Research it properly.** Verify every claim against the code before planning
   on it. This repo has now produced *fourteen* cases where measurement
   contradicted a written plan, five of them in one session. Assume the same.
2. **Cross-audit the plan** before building, from independent angles.
3. **Execute.**
4. **Cross-audit the result, ONCE.**
5. **Fix only Critical and High.** Record Medium and Low; do not fix them.

**Swarm it.** Parallel subagents on strictly disjoint files.

## WHAT THE 2026-09-03 SWARM TAUGHT — read this before briefing any agent

Fifteen lanes ran. These cost real time or nearly shipped a defect.

- **Brief agents to contradict you, and mean it.** Five separate lanes corrected
  the orchestrator and every one of them was right. The instruction that worked:
  *"tell me plainly if any premise I have handed you does not survive contact
  with the code. I would rather you contradict me than build on my error."*
- **Check `git show HEAD:<file>`, not the file on disk,** before believing any
  claim that code "already exists". An auditor read a live lane's *uncommitted*
  work and reported it as pre-existing; that error was relayed to the lane as a
  correction. The lane caught it with one `git show`.
- **Controls that share a production rule are NOT independent.** Applying two at
  once masks each other and yields a false green. Run them one at a time. This
  was discovered the hard way and then confirmed twice more.
- **Six negative controls came back GREEN across the session.** Every one was a
  test that had never failed and never could. Expect roughly one per lane and
  say so in the brief. A green control means the test is wrong, not the code.
- **Seven tests went stale by pinning a location or a sentence** rather than a
  contract, and every one went red on an *improvement*. Grepping a function body
  for a literal line pins where code lives, not what it does.
- **A scoped suite run misses cross-file breakage.** One lane ran
  `vitest run scripts/` and missed a server test its own change broke.
- **Never run more than one full server suite at a time.** Three concurrently
  produced spurious "server never came up" boot failures that look like real
  bugs. Serialise.
- **A suite result older than the last commit is worthless.** Two lanes reported
  failures that were already fixed by a commit landing mid-run. Re-run before
  believing a red.
- **Do not fabricate a number to satisfy a brief.** A toast was specified as
  "installed 7 of 9 skills". The denominator does not exist in the response. The
  lane counted what went wrong instead and added a test forbidding `of <N>`.

## LANE DISCIPLINE

- Assign every agent an explicit file list AND an explicit forbidden list.
- **Agents never run a git command that writes.** The orchestrator commits, by
  explicit path, after checking `git diff --cached --name-only` for strays.
- A `.output` file of 0 bytes means RUNNING, not dead.
- Negative-control every test: make it pass, revert the production change,
  confirm RED, restore, report the real red text per test.
- Consider a **positive** control too: prove the rig notices the opposite case,
  so a green means a guard working rather than a harness observing nothing.

## STATE — 14 commits, pushed to `main`

Everything below shipped this session, each with negative controls.

**Security**
- The device door bound `0.0.0.0:8810` unconditionally. `MURAGE_COMPANION_BIND`
  now closes it (`off` for headless), fails closed on an unknown value, and the
  desktop LAN default is proven unchanged by dialling the real LAN address.
- `POST /api/pair` had no rate limiter, so an unauthenticated tailnet peer could
  burn anyone's pairing window. It shares the browser door's limiter now, and
  the two doors share one lockout instead of half a lockout each.
- A base64 detector regex cost 330ms of CPU on a crafted 256KB file, on a path
  that ingests user-supplied skills. Now 0.84ms.
- The installer never started the sidecar, so its correct door logic was dead
  code. It starts it, and closes the device door while doing so.

**Correctness**
- Nine skills were catalogued, downloadable, and could never install, ranking
  **#1** in live search for "security auditor" and three others. 2237/2237 now
  resolve, and a guard walks the whole library through the installer's own rules.
- The search index and the catalogue builder each had their own weaker copy of
  those rules. Both delegate to the installer now.
- The team-import undo could not restore the workspace Chief: `ArchivedTeamBot`
  had nowhere to put her tier, and the guard meant to catch it was dead code
  because the archive erased the field it tested.
- Connectors failed silently three different ways through one ternary. Five
  named states now, in both the 1:1 and the room prompt.
- A team import that could not install a skill logged it and told the user it
  succeeded. Reported now, and rendered in the toast.

**Product**
- Thirty rotating openers, no em dash, replacing one hardcoded greeting.
- Five profiles that could never be offered are now matchable, verified against
  41 probes with zero off-topic queries stolen.
- The typed sign-in code is on screen with its address. It was actively hidden
  in the laptop case by a helper that fired whenever a QR could be built.
- The cold skill-index build went 8.1s to 2.2s and is prewarmed off the click.

## OPEN — the real list

- **The intake matcher.** Two distinct defects, both traced and neither fixed.
  (a) The gate fires on a single whole-word hit against a bag that includes 25
  skill manifests of prose, so "ferret keeps escaping the hutch" matches on
  `keeps` and "gutters need doing before winter" on `before`, a word taken from
  a profile's own *name*. (b) bm25 ranks only catalogue entry text and hands the
  gate the top 8, but the gate reads those entries' *skills' manifests* — so for
  "chasing invoices" the one correct profile is eliminated *before* the gate that
  would have recognised it. **No threshold separates good from garbage**: four
  axes were measured and they overlap; `smart-trader`/`trading` and
  `customer-success-org`/`keeps` both score exactly one exact hit, which is why
  removing the short-circuit broke trading. The answer is the conversation, and
  long term, curated match terms per profile.
- **Sean's paid tier** is after Monday. Public-ingress hardening waits on it.
- `server/index.test.ts:2065` declares a required app with no `reason`, and
  typechecks only because that literal never meets the type.
- `src/components/TeamLibraryPanel.tsx:844` hardcodes `skillErrors: []` on the
  scout path. True today, silently stale if project imports gain skills.
- `scanSkillText`'s `curl|sh` pattern is the same bounded-backtracker class as
  the base64 one, now the largest remaining scanner cost.
- `src/state/store.tsx` carries two import conventions for `shared/`.

## SEAN'S DECISIONS — settled, act on these

- **Cross-audit replaces his approval pass** on mechanical questions. His
  reasoning: a machine can check whether a skill reference resolves and he
  cannot. It was the right call for a reason neither of us predicted — the audit
  caught the *orchestrator* feeding a lane a false premise.
- **Paid tier: after Monday.** Ship what exists as it is.
- Everything in the prior sessions' decision list below still stands.


## SESSION 2026-09-03 (earlier) — superseded by the section above

# Murage — session handoff

> **Read this section, then §NEXT. Everything below `--- HISTORY ---` is the
> record of earlier sessions and is not a to-do list.**

## THE PROTOCOL — Sean set this explicitly, follow it exactly

For every item in §NEXT:

1. **Research it properly.** Verify every claim against the code before planning
   on it. This repo has produced *nine* cases where measurement contradicted a
   written plan. Assume the same until you have checked.
2. **Cross-audit the plan** before building — independent agents, different
   angles (feasibility · experience · local-first & security). One generic
   reviewer finds one class of problem.
3. **Execute.**
4. **Cross-audit the result, ONCE.**
5. **Fix only Critical and High.** Record Medium and Low; do not fix them.

**Swarm it.** Parallel subagents on strictly disjoint files. That is not
optional flavour — it is the only thing that made the last two sessions fast.

## LANE DISCIPLINE — this cost real time twice, do not relearn it

- **Assign every agent an explicit file list, and an explicit forbidden list.**
  Two agents in one file produced duplicate imports and a silently-clobbered
  288-line change.
- **Agents never run a git command that writes.** The orchestrator commits, by
  explicit path, after checking `git diff --cached --name-only` for strays.
- **After adding a file, re-run the suite for the lane you touched.** A commit
  shipped red because the server suite was run after a *renderer* test landed.
- **A workflow whose `.output` file is 0 bytes is RUNNING, not dead.** Check
  with `TaskStop`/`TaskOutput`, never file size. Believing otherwise started
  the collision above.
- **Negative-control every test**: make it pass, revert the production change,
  confirm RED, restore, report per test. Several controls have come back GREEN
  and been rewritten — that is the discipline working. A test nobody has seen
  fail is not a test.

## STATE — everything is committed and pushed to `main` (`a75d16b0`)

Suites: **src 632/632 · companion 281/281 · electron 385 (+4 skipped) · server
1998/1**. The one failure is `server/control-murage.test.ts`, host-dependent —
it hardcodes `["claude"]` and this machine has a real `qwen` on PATH. Proven
pre-existing by swapping in `git show f3ba4f59:server/index.ts`. All four gates
exit 0.

**Shipped in the 2026-09-02 session, newest first:**

| Commit | What |
|---|---|
| `746d7221` | The pairing screen stopped advertising the deleted iOS app |
| `388ae731` | **New Bot asks what you need, and becomes it** |
| `e2dfca31` | Tailscale installed after boot no longer needs a restart (upstream #669) |
| `ccc5f07d` | **The cloud installer**, with Wayland's defaults inverted |
| `491a5abc` | Nine skill-less assistants got their skills |
| `995c37c3` | Public ingress no longer outranks the tailnet |
| `415e67e8` | **The browser door**, on 8813 with its own allowlist |
| `f3ba4f59` | **Shell injection via a bot's display name**, and `computer/exec` gated |
| `07bf5c7c` | `cli-test` and the instance CLI override gated to desktop |

**Four execution routes are gated** — `server/index.ts:7710`, `:8506`, `:8535`,
`:9112`. That is the precondition on any public ingress, and it is met.

**Then three audits ran over all of it, and two more over the plan.** Every lane's
suite was green and the audits still found two Criticals and seven Highs — because
no test crossed a lane boundary and the orchestrator's end-to-end proof was `curl`.
Happy paths are real. Failure paths were never tested. The plan's Wave 0b is the fix
for the *method*: Playwright human-path specs, scratch data, a CI job, and a LANE
DISCIPLINE rule that no UI lane is committed without its spec.

## THE ONE THING THAT BLOCKS THE WEB UI FROM BEING USABLE

The browser door is built, tested (34 negative controls) and smoke-tested on a
real tailnet — but **nothing launches it and nothing points at it yet**:

1. **`electron/` does not start the door.** It needs `MURAGE_BROWSER_*` env and a
   launch alongside the sidecar.
2. **The pairing QR carries a bare credential**, not the `/enter#<token>` URL the
   door's first-contact page expects. Until that is wired the pairing screen has
   no client at all — which is why its copy now names none.
3. **`tailscale serve` must front the door on 8813, NEVER the harness on 8799.**
   Measured: `Host: 127.0.0.1` → 200, `Host: <tailnet name>` → **403 forbidden:
   loopback host required**. That gate is the DNS-rebinding defence; do not widen
   it. The door already rewrites Host to loopback, which is the correct fix.

Do those three and the web UI is reachable from a phone.

---

## TONIGHT — the web UI is real, and a phone found eight defects

**Sean's Android phone reached Murage over his tailnet, and his desktop app is
served HTTPS on a MagicDNS name with a real certificate.** 21 commits. Neither
Wayland nor AionUI ever got this far: both stayed on plain HTTP, which is why
neither ever got an installable PWA.

**Read this first, because it is the lesson.** Every defect below passed its
tests AND passed hand-built requests I wrote to reproduce them. A real phone
found all of them. Three times a pre-existing test actively defended the wrong
assumption and I trusted it over a measurement. When a live device disagrees
with a green suite, the device is right.

| What was wrong | Why it survived |
|---|---|
| Door refused every browser | `Sec-Fetch-*` is secure-context only; no browser sends it over plain HTTP. The gate required it. My curl added it by hand |
| `SameSite=Strict` | Withheld the cookie on any cross-site NAVIGATION — tapping your own link from a chat app. Session was valid on disk the whole time |
| 120-second pairing window | Measured against a flow where you already hold the phone. Reads as "credential is not right", not as expiry |
| Link-preview crawlers spent the token | Fragment protects logs, not renderers. Sign-in is now a BUTTON |
| Phone got the desktop's first run | Welcome gate, engine scan, phone-setup screen. Renderer did not know where it ran |
| API keys rendered on the phone | SettingsModal was out of the lane's reach |
| The desktop was told it was a phone | `resolveDesktopSurface` let a fetched "remote" outrank the Electron bridge |
| Skill Remove ate its own click | `window.confirm`; an auto-dismissed dialog is indistinguishable from Cancel |

**Live configuration right now — READ BEFORE TOUCHING ANYTHING.**
- Harness 8799 serves a **frozen production build** from a git worktree at
  `<scratchpad>/frozen`, NOT the working tree. Electron runs with
  `ELECTRON_START_URL=http://127.0.0.1:8799`. This insulates Sean's app from
  lanes editing the tree. **After any renderer change you must rebuild that
  worktree and restart, or Sean sees stale code and reports a fixed bug.**
- Door 8813 bound to **loopback**, fronted by `tailscale serve --https=443`
  (tailnet only; **funnel is never to be used**). Undo: `tailscale serve
  --https=443 off`.
- Sean's bookmark: `https://seans-macbook-pro.tail0a48a4.ts.net/`
- A production bundle served by a harness Electron did not fork has **no path
  to the desktop secret**. The preload bridge is what saves it. Do not
  reintroduce a fetch-first precedence.

**In flight when this was written:** one lane building the desktop
"Enable WebUI for Remote Access" page — Wayland's own settings screen is the
agreed design (Sean sent screenshots; skeleton, three-step strip, consequence
modal, copyable access URL, QR with expiry + refresh, paired devices, recent
activity). Take the shape; do NOT copy its username/password, its
bind-to-0.0.0.0 model, or its paired-devices list, which is a facade whose
register function has zero call sites.

**Known open, not started:** web app manifest + icons (this is the "no logo"
report AND the last thing blocking home-screen install); the door still
advertises its internal port in generated links now that serve fronts it;
phones lost copy/reply/speak on messages when the hover rail became
`display:none` and need a touch affordance; the catalog recall gap
("reading my trading charts" finds nothing while "read my own charts" finds
Smart Trader); `installer/` still not wired into CI; cloud installer still
needs Sean's Tailscale auth key.

## SESSION 2026-09-03 — the web UI is done; the intake matcher is the open wound

21 commits. **All six web-UI items are shipped.** Read the three traps first —
every one of them cost real time today.

### THE TRAPS

**1. Sean's app runs a FROZEN BUILD from a separate worktree.** Harness 8799
serves `<scratchpad>/frozen/dist`, Electron points at it. A renderer change is
invisible to him until that worktree is checked out to HEAD and rebuilt. He
reported "Make Chief of Staff" still showing after it was fixed — the served
bundle was correct, his window was stale. **Verify what is actually served
before believing a bug report:** `curl -s :8799/ | grep -o 'assets/index-[^"]*'`
then grep that file for the string.
**Never rebuild it while he is using the app** — that probably caused an
earlier blank screen by 404-ing chunks under a live window.

**2. Two layout bugs today, both the same cause, and no test could see them.**
A flex item keeps `min-width/height: auto` and refuses to shrink below its
content. First the settings step strip put a horizontal scrollbar across the
modal; then — much worse — the composer's `absolute … h-[50vh]` ground hung
404px past the viewport and **scrolled the whole document 369.5px**, sliding
the app up and leaving a black band. It looked like the app broke. Nothing
throws, no error boundary fires, nothing in any log. `#root` is now
`overflow: hidden`, which forecloses the class. **Measure layout in a real
browser** — chrome-devtools MCP against 8799 found both in minutes.

**3. A capability with no path to it is not a capability.** This shipped
THREE times today: `create_bot` gained a lead flag the tool schema never
declared; `requirements.apps` is read by nothing but re-export; the desktop
secret had no production route. Whenever you add a server capability, check
the caller can actually reach it.

### DONE — the web UI, all six

| | |
|---|---|
| Remote-access page, QR, OFF | `91a7089f` — door advertises the FRONT's portless address |
| Manifest, icons, favicon, install | `2e570aac` `98e7d093` — three icon families; harness MIME fixed |
| Silent session renewal | `2ca41df5` — rotates in place, revoke still kills it |
| 60-day idle window | `0d0fc06e` — renewal stays 24h, decoupled from the window |
| Desktop secret production path | `87b7aa3b` — the DEV guard was never the lock |
| Touch affordances on phone | `61a7f4ce` — tap the bubble, bottom sheet; width unchanged to 0.1px |
| Install invite | `4c1b38ae` — Android button, iOS hint, SILENT over HTTP |

### DONE — the org chart

`597b5afb` team leads no longer wear the Chief's colour or get offered her job ·
`ab7e4f21` Chief is single-holder, 409 before any write; `create_bot` can stand
up a team's first lead · `1e07b9c9` **the client half of the Chief-vanishes bug**
— both reducers were still demoting her, and the server never corrects it
because nothing changed server-side · `6d7a1ea3` the tool wiring that made the
lead flag reachable · `a5f9a23d` teams now rank above auto-created bot chats,
and the guard covers the tier-less `chiefOfStaff: true` shape.

### DONE — connectors and profiles

**The bridge WORKS.** A real Gmail read returned three subjects end to end.
**The broker was never blocked** — `composioBrokerUrl()` only returns a URL
when `app.isPackaged`, so every dev run gets `mode: "unavailable"` and the copy
called a permanent packaging gate a temporary outage. `c02a7bda` inverts
precedence so a pasted key beats the broker (it used to `void cfg`), because
a packaged run silently orphaned 18 connected toolkits. `3eadca14` makes three
silent bridge failures loud — dropped error bodies, a request never answered
(hangs forever), and one request answered with another's frame.
`791af593` `27182ff7` seven mainstream profiles, 70 skills all resolving.

### OPEN — in priority order

1. **THE INTAKE MATCHER. This is the big one.** Measured against the shipped
   catalogue: "my ferret keeps escaping the hutch" → customer-success-org,
   "the gutters need doing before winter" → validate-before-build, "our
   badminton club needs new nets" → a personal-finance auditor. Every one a
   confident wrong specialist shown as "here is your match".
   **Cause found:** `vocabularyMatches` (`src/lib/onboarding-intake.ts`)
   declares `needed = min(2, tokens.length)` then begins
   `if (vocabulary.has(token)) return true` — short-circuiting on the first
   exact hit and never counting. The vocabulary is the whole summary split
   into words, so one common English word decides it.
   **I tried three fixes and reverted all three**; each traded one regression
   for another (the last broke "help me read my trading charts" →
   smart-trader). Do NOT guess a fourth. Cross-research is running
   (`<scratchpad>/matcher/{kimi,codex}.md`).
   **Sean's framing is the design constraint:** *"there's not just gonna be a
   general usage one and a lot of people will have general chats and that's
   fine."* "No specialist fits" must be a common, confident, correctly-labelled
   outcome — not a near-failure. Build a labelled eval set first.
2. **Concierge only works if it is the default first-run bot.** It cannot win
   a matcher that rewards specific vocabulary and must not be made to — padding
   its summary is what made the bare word "say" match Researcher. It is wired
   as the answer to "nothing matched" (≥3 words, tokens present), which is
   honest but rarely fires while the matcher confidently matches nonsense.
3. **`requiredApps` is write-only** and every bot a Chief creates lands
   `composio: false` with the system-prompt hint gated on the same flag — so it
   is not even told the tools exist. Five of Sean's bots are in this state.
   Make it loud.
4. **Organiser/PA** — approved, deferred until one connector-aware skill class
   exists. Zero of 2,237 skills reference Composio or MCP.
5. **Team-import undo** restores an archived Chief without her tier.
6. Ship gates: `installer/` into CI, cloud installer (needs Sean's Tailscale
   auth key), first release.

### IN FLIGHT AT HANDOFF
One lane building **typed-code sign-in** so a laptop — or a browser hitting a
future cloud instance — can pair without a camera. Owns `companion/src/{browser,
devices,routes}.ts` and `companion/test/`. `companion/src/devices.ts` is
mid-edit and currently fails typecheck (`'spent' is declared but never read`);
that is the lane's, not a regression.

### SEAN'S LIVE STATE
Sable = workspace Chief. Ben (Coach) = War Room lead. Kessler exists but is
`hidden: true`. Composio on his own key, 18 toolkits, 5 Gmail accounts.
Bookmark `https://seans-macbook-pro.tail0a48a4.ts.net`, `tailscale serve`
fronting 8813. `tailscale` is NOT on PATH — it is at
`/Applications/Tailscale.app/Contents/MacOS/Tailscale`.

## WHAT "FINISHED" MEANS — do these in this order

Sean's bar, in his words: **"tested, polished and professional looking."** He
has been using this on a real phone all night and reporting what he sees. That
is the standard: not that a suite is green, but that he opens it and it looks
and behaves like a product.

### 1. The remote-access page — ONE LANE MAY STILL BE IN FLIGHT. Check before starting.
Desktop action: "Enable WebUI for Remote Access" → starts the door on
**loopback**, turns on `tailscale serve --https=443` (tailnet only, **never
funnel**), shows a QR of the portless HTTPS link plus the six-digit code, and
has a working OFF. Design is Wayland's own WebUI settings screen — Sean sent
screenshots; take the skeleton, the numbered three-step strip, the consequence
modal whose primary button repeats the action, the copyable access URL that
reflects the ACTUAL mode, the QR with expiry + copy + refresh, paired devices,
recent activity.

**Do NOT copy from Wayland:** its username/password (we have none and want
none — the credential is the pairing token then a device session); its
"Allow Remote Access" meaning bind `0.0.0.0` over plaintext (ours is tailnet +
certificate, strictly safer, and the copy must say what is true for us); its
paired-devices card, which is a **facade** whose `registerDevice` has zero call
sites while its dialog claims revoke kills the session. Ours is real — devices
register on sign-in and `revoke()` kills every session on that device.

Two fixes this lane must not miss: **the door still advertises its internal
port**, so every generated link and QR is wrong now that serve fronts it on
443; and the paired-devices card must genuinely list and revoke.

### 2. Web app manifest + icons — the "no logo" report, and the last thing blocking install
There is **no manifest and no favicon in the app at all** (`public/` has only
`app-icon.svg` and two logo PNGs). HTTPS was the hard half and it is done, so
"Add to Home Screen" now fails only for want of a manifest. Needs: a
`.webmanifest` (standalone display, correct `start_url`/`scope`, 192 and 512
icons), a `favicon.ico` fallback, the iOS meta tags, and the door's static
allowlist widened to serve them (`companion/src/routes.ts` already lists
`/app-icon.svg` and `/murage-logo*.png` by name). A service worker is optional
now and required if offline shell caching is ever wanted.

### 3. Silent session renewal — or the bookmark dies at the worst moment
Sessions are 14 days idle / **90 days absolute**, then re-pair. Fine weekly;
useless for the machine you reach from a hotel twice a quarter. Wayland and
AionUI both built a refresh endpoint and **never called it from the browser**,
which is why their "30-day cookie" is really a 24-hour one. Do not repeat that:
build renewal AND call it, on load and on a timer, rotating within the device
record so revoke still kills it.

### 4. Touch affordances on messages — a regression I introduced
Below `md`, copy / reply / regenerate / speak / pin are now `display:none`
rather than invisible-but-present (they were reserving ~130px of every row on a
phone, which is what made the transcript 74% wide). Nothing visible was lost,
but a phone now has no way to copy or reply to a message. Needs a real touch
affordance — long-press or an overflow sheet. Design decision, not a width fix.

### 5. The desktop secret has no path in the current shape
A renderer served as a **production bundle** by a harness Electron did not fork
cannot obtain the per-launch secret; the dev fetch is behind
`import.meta.env.DEV` and compiled out. The preload bridge rescues it (and must
keep winning — see `resolveDesktopSurface`), but that is a rescue, not a
design. Close it properly.

### 6. The intake's recall gap — the product one
`"read my own charts"` finds Smart Trader with 11 skills. `"reading my trading
charts"` — **the card's own placeholder text** — finds nothing. The relevance
gate is not the cause (proved: it passes that phrase); the local catalog
ranking never surfaces the profile into the candidate window. New-bot
onboarding is one of the three things Sean called essential and it currently
fails on its own example.

### Then the ship gates
`installer/` into CI (needs a `test:installer` script in `package.json`; adding
it to `vite.config.ts` will NOT work — they are `node:test` files). The cloud
installer against a real tailnet — **blocked on a Tailscale auth key only Sean
can mint**; use one droplet prefixed `murage-test-`, destroy before reporting,
never touch the four `flux-pool-r2-*` production droplets. Then the first
release.

### How to work on this
Lanes with disjoint file ownership, negative control on every fix (revert →
confirm RED → restore), and **measure rather than assert** — the transcript
width lane printed real pixel numbers at 390 and 1440 and that is why its fix
was right the first time. Playwright is installed: `pnpm test:human`, scratch
ports 8853/5253, never Sean's data. Specs share one scratch workspace, so run
them one at a time.

## NEXT — read `docs/plans/next-session/PLAN.md`. It supersedes this section.

The plan was built from **three audits of today's ten commits** (security ·
experience with Playwright against the real renderer · integration across every
lane seam) and then **cross-audited twice** (feasibility · completeness). Everything
below in this file is state and record; the plan is the work.

**Start at Wave 0** — two hours, serial, orchestrator only. Then Wave 0b installs
Playwright (unbudgeted before; nothing in Wave 1 or 2 can be verified as a person
without it). Wave 1 (intake safety) and Wave 2a (door reaches a phone) run in
parallel; Wave 2b is serial after Wave 1; Wave 4 (security) before Wave 3 (installer).
**≈10–12 days honest.**

**What the audits found, in one line each — the plan fixes every one:**
- "hi" in the intake → 8 pre-ticked junk skills in a 1379 px card, no scroll (Critical)
- The intake fires on Sable and would rename her (High)
- "chasing invoices" — the card's own example — lands on IGNITION (High)
- "Add a skill" opens on Teams with Load buttons, no mention of the bot (High)
- The phone 404s the entire intake — zero library/skills routes on either door surface (High)
- `write-book-chapter` on five book profiles, not one (High)
- The pairing flow still promises a phone via a `murage://` QR nothing opens; `:1158` still says "MurageMobile" (Critical, pre-existing)
- The installer fronts 8799 (403s) and never runs the sidecar (High)
- "Desktop-only" is a door gate, not a principal gate — any local `curl` passes (Medium, see §SECURITY)

**Do NOT build:** skill assignment both directions (`388ae731`), the intake
(`388ae731`), the browser door (`415e67e8`), the `hosted` re-rank (`995c37c3`),
nine profiles' skills (`491a5abc`), the installer (`ccc5f07d`). They shipped. Fix
them per the plan.

**Seven decisions for Sean are at the end of the plan.** Wave 0 items 0.2, 0.5 and
0.6 are code and two hang on decision 7 (whether Mediums/Lows may be fixed in-lane).

## SEAN'S DECISIONS — settled, act on these

- **Publish smart-trader: ALREADY DONE — do NOT re-run the publish.** Checked
  against the live repo this session: `murage-teams` has **122 catalog entries**,
  `smart-trader` among them, `teams/smart-trader/` present with **all 11 skills**
  at correct paths. The previous handoff said it "was never published"; that was
  **false**, and it sat in this section as an approved irreversible action. It was
  nearly executed on trust. Verify the live catalog before acting on any claim
  about it.
- **"Trading returns nothing" is FIXED, and the cause was neither publishing nor
  search.** The dev harness had been running since 06:40; the search route landed
  at 08:40 (`cbad35d2`). `--experimental-strip-types` does not hot-reload, so the
  process simply had no `/api/library/search` and 404'd it. After a restart:
  `trading` → `smart-trader` at rank 1 plus 8 skills. **If a feature "does not
  exist" in the running app, check the harness start time against the commit
  before debugging the code.**
- **Fuigo artifact growth (~59 MB compressed per mac arch): APPROVED.** Closed.
- **Win32 ARM64: for the NEXT edition.** Needs BOTH a target in
  `scripts/prepare-fuigo.mjs` (see the comment at `:66-68`) AND an arm64 entry
  under `win:` in `electron-builder.yml:154`. Either alone stages a binary
  nothing packages, or packages one nothing staged.
- **Cloudflare tunnel + accounts: KEEP, dark. Do not delete, do not switch on.**
  Reversed after Sean asked whether it is an asset. It is two separable things:
  the **account system is the billing substrate** he will need for Composio and a
  paid tier, and is worth keeping; the **tunnel is public ingress** and is gated
  on the app being safe to expose. `accounts.murage.ai` has no DNS record — it is
  a rebrand of upstream's `accounts.openmausbot.com` that nobody provisioned, and
  it only activates in a packaged build, of which there are zero. So it is inert.
  Sequence: Tailscale web UI first, Cloud Deploy second, tunnel considered for the
  paid tier third, delete nothing until its replacement ships.
- **Electron → Tauri: NOT NOW.** Sean asked whether Tauri is a strategic
  advantage. Measured: the shell is 23k lines, the backend 69k with zero Electron
  imports. The one real lock-in is the agent's browser tools on
  `webContents.debugger.sendCommand` — a product feature needing CDP, which
  WKWebView on macOS does not speak (Tauri 2 macOS testing is an embedded
  WebDriver server, not CDP). Size win is partly eaten by a Node sidecar. **Order:**
  keep decoupling (the door already made the renderer shell-agnostic), move the
  browser tools to an external Chromium, and only then is Tauri a branch
  experiment rather than a rewrite. Revisit at the first release (plan 5.2) if size
  or memory becomes a user complaint. For the orchestrator's own testing, CDP is
  already moot: Playwright against the door in real Chrome tests what a phone hits.
- **`hosted` endpoint: re-rank, do NOT delete.** The plan's rationale for deleting
  ("the only remaining path by which Murage becomes internet-reachable") is wrong —
  the managed origin is a **0600 Unix socket**, and the 8812 gateway is loopback.
  Deleting the kind alone would break the shipped default pairing flow
  (`companion-pairing.ts:133` returns null without a hosted endpoint) and close no
  hole. Re-rank tailnet to priority 0. **Blocked while the browser-door lane owns
  `companion/src/`.**

## SECURITY — closed this session, all negative-controlled

- **`07bf5c7c`** — `POST /api/cli-test` and `PATCH /api/instances/:id` were
  desktop-reachable from any surface. The first spawns a caller-supplied binary;
  the second installs one as the engine for every later turn. Both now 404 off the
  desktop. Control: with either gate removed the suite reports **200 for a live
  probe of `/bin/echo`**.
- **`f3ba4f59`** — `remoteComputerBootstrapCommand` scrubbed a bot's display name
  with `replace(/["'\\]/g, "")` and interpolated it into the tmux banner **inside
  double quotes**, where `$(…)` and backticks still expand. Naming a bot
  `Bruce $(id -un)` ran `id` on the provisioned box. **Demonstrated live**, not
  deduced. The banner now travels as base64 — encoding removes the interpolation
  rather than escaping it, because escaping stays one metacharacter from wrong.
  Same sink as upstream #682, hand-ported (`/opt/muragebox` vs their `/opt/ogb`).
- **`f3ba4f59`** — `POST /api/bots/:id/computer/exec` runs arbitrary shell on the
  box from the request body and had **no surface check**, while `join` two
  branches above already refused the companion surface for something milder.
  Now desktop-only.

Four execution routes are now gated: `server/index.ts:7710`, `:8506`, `:8535`,
`:9112`. **That is the precondition on any public ingress.**

## UPSTREAM — reviewed, ranked, queued

OpenMausBot `v0.1.46` (2026-09-01). 103 commits since our fork point; four already
taken by subject. **Worth taking:**

1. **`daadaff` #669 backend half — TAKE, applies with zero fuzz.** Fixes a real bug
   in our tree: the MagicDNS name is read **once at boot**
   (`companion/src/index.ts:239` → `listener.ts:86`), so installing or signing into
   Tailscale while Murage runs leaves the route permanently "unavailable" until a
   restart. Adds `POST /tailscale/refresh` and a coalescing re-probe. For a product
   whose only door is the tailnet, that is the worst possible failure mode.
   **Blocked while the browser-door lane owns `companion/src/`.**
2. **`daadaff` #669 `preparePhonePairingRoute()`** — separate, self-contained, no
   branding. Fixes a stale polled snapshot reporting `enabled: true` after the
   sidecar died, which made Pair take the `read` branch and fail confusingly.
3. **`cb0d376`** — adds `claude-fable-5-1` to the model catalog. One line.

**REJECT:** `6dd974c` #677 (Dockerfile + Caddy + `OMB_WEBHOOK_PUBLIC_URL` — a
purpose-built public-ingress feature, exactly what the threat model forbids),
`a3822f8` #681 (adds a NEW CLI-spawning route with no surface gate — if ever taken
it must be gated like `:8506`), plus all iOS and Android work.

**Copy trap in #669:** it labels Tailscale *"Optional — Secure HTTPS above remains
the recommended setup"*, where their "secure HTTPS" is the cloudflared/accounts
path we keep dark. Take the logic, rewrite the copy so Tailscale is primary.
**Coupling trap:** `PhoneSetupFlow.tsx:1066` gains a `variant === "onboarding"`
guard that hides the Tailscale button in Settings because a new `CompanionSection`
card replaces it — take that hunk without the card and Tailscale pairing vanishes
from Settings entirely.

## OPEN — needs Sean, not code

- **Is the paid tier this quarter or someday?** It decides whether the remaining
  public-ingress hardening moves ahead of the three essentials. Nothing else in
  the queue depends on the answer.
- **The 27 skill-less profiles need a human approval pass** on the derived
  skill mapping. A wrong skill silently changes what an assistant does, so the
  mapping is proposed, not applied, for anything below high confidence.
- **`docs/plans/skins/THEME-COLLAPSE.md` is stale** — documents the old
  panel/app assignment, fixed in `28dabbce`.

## KNOWN MEDIUMS — recorded, deliberately not fixed (protocol: Critical/High only)

**From the 2026-09-02 audits, unscheduled unless the plan names them:**
- Seeded quiz title "What do you mostly want help with?" leaks into the sidebar row
  preview as the bot's last message (experience §1, Low).
- "Find it" wraps to two lines beside the intake input below ~840 px (`BotIntakeCard.tsx`, Low).
- `book-production` ranks `write-book-chapter` at 0.609 — a publisher role; the
  derivation scorer's confidence is not a confidence **as a class**
  (`tiktok-creator` 0.40 for `word-form-creator`) — plan 5.4 puts all 48 mappings in
  front of Sean once (Medium).
- Duplicate `x-murage-companion` headers: Node joins to `"1, 1"`, a string, so
  `=== "1"` reads desktop (`sse-visibility.ts:74`, `index.ts:9293`) — not remotely
  reachable, both doors build from `{}`; plan 0.5 (Low).
- `MURAGE_TRUSTED_PROXY=1`: written by the installer, read by
  `classifyClientTrust()` which nothing calls; the semantics it claims (loopback ≠
  operator) is not in `server/` — plan 3.5 (Low).
- `installer/lib/systemd.mjs:33-58` interpolates paths into unit text without the
  newline guard `env-file.mjs` has — operator-only input; plan 3.6 (Low).
- `docs/plans/skins/THEME-COLLAPSE.md` superseded by `28dabbce`; needs a header or deletion (Low).
- Sidebar `⋯` is `opacity-0` at ≥768 px including iPad landscape — hover-only, not
  right-click-only; three sites `Sidebar.tsx:929,945,832` — plan Wave 1 M3 (Medium).
- Removing every skill does not bring the intake back until reload —
  `BotSkillsPanel.tsx:271` never calls `invalidateSkillCount` — plan Wave 1 M1 (Medium).
- `BotSkillsPanel.tsx:483` still says "Use /learn in chat to add another" two lines
  above an "Add a skill" button, 3,300 px down the profile — plan Wave 1 M2 (Medium).
- Rename is forced on accept; the API supports `rename:false`, the card never
  offers it — plan Wave 1 H5 (Medium).
- One-word typo ("tradng") is a dead end — plan Wave 1 M4 (Medium).
- Ten Office playbooks say "follow the `officecli-*` skill exactly"; no such skill
  exists anywhere in `skills-library/` — plan 5.5, Sean's decision 4 (Medium).
- Under D1 plain HTTP, all five `navigator.clipboard` sites are dead on a phone
  (`ChatMarkdown.tsx:108`, `ChatView.tsx:162`, `ConnectionDetail.tsx:27`,
  `EngineSetup.tsx:48`, `SettingsPrimitives.tsx:64`) until D2/HTTPS (Medium).

**Pre-existing, carried forward:**

- **Contract split #13, precisely stated.** `MURAGEBOX_*` is a *deliberate*
  namespace for the child MCP process `server/computer-proxy.ts`, injected by
  `server/container-computer.ts:1137-1138` and the drivers. But **nothing anywhere
  sets `MURAGEBOX_BOX_API`**, so when the parent's `MURAGE_BOX_API`
  (`server/box.ts:17`) points at a stub or a self-hosted provider, the child still
  talks to `https://ascii.dev/api/box/v1`. Parent and child disagree about which
  box API they are using. Only bites on an override, hence Medium.
- `server/remote-computer.ts` — `if (elements.length >= 250) break;` with no
  truncation signal, on the remote-box path.
- Delete residue: removing a bot leaves `~/.murage/workspaces/` folders and
  `messages.db` rows. Deliberate (keeps cleanup reversible), but nothing owns
  reconciling the three stores.
- `scripts/check-skin-contrast.mjs` still has dead `BASELINE_FLOORS` rows keyed
  `midnight|…`, and `check:contrast` is not wired into `pnpm test`.
- Fuigo CI gates: `release.yml` and `package-win.yml` have per-resource gates for
  cloudflared and none for fuigo.
- `resolveFuigoCli()` is exported, tested, and called by nobody.

## GOTCHAS THAT COST TIME

- Use `rtk proxy npx vitest …`. A bare `npx vitest` is swallowed by a shell hook
  and prints nothing. `rtk`'s cached `sed`/`grep`/`git` output has also gone
  stale mid-session — prefer `Read` and `rtk proxy git` when it matters.
- Dev mode does **not** start the harness. Electron loads Vite on 5199 and you
  run `node --experimental-strip-types server/index.ts` yourself. Chasing this
  as a bug cost ten minutes.
- `pkill -f murage-app` also kills Vite — it runs from the same directory.
- Renderer fetches must carry `x-murage-surface: desktop` or they silently see
  nothing (`src/lib/desktop-surface.test.ts`).
- The route `/skills/([a-z0-9-]+)` matches `/skills/library`. Ordering matters.
- `findDelegationReceipt` returns `null`, not `undefined`.

## AUTONOMY BOUNDARIES

Approved: merging to `main` and pushing `FerroxLabs/murage`; killing and
restarting the local app; scratch instances under the scratchpad.
**Not approved:** pushing `FerroxLabs/murage-teams`, publishing a release,
deleting anything under `~/.murage` without a backup first, force-push, or
touching `~/dev/smarttrader` — read-only reference, and nothing from the Rebel
Scanner or REGIME-GATE ever enters this repo or a build artifact.



## OVERNIGHT 2026-09-02 — nine commits, pushed to `main` at `94ef6689`

Suite: **src 539/539 · electron 375 · companion 223 · server 1919/1**. The one failure is
`control-murage`, environment-dependent — it hardcodes `["claude"]` and this machine has a real
`qwen` on PATH. All four typechecks exit 0. Contrast script exits 0 on both palettes.

### Landed
| Commit | What |
|---|---|
| `5756fdd0` | `GET /api/search` and `POST /api/connectors/:slug/authorize` out of the companion allowlist |
| `c08ad64d` | Routines were the way around the computer-provision denial (`runOn: "cloud"` → `provisionBox`) |
| `4b57fd3b` | A room's delegation queue is multi-sender; one Stop must not empty it |
| `a3ef2b36` | iOS retired, salvage hash-verified against HEAD |
| `3fc050c9` | The endpoint list dropped the bare tailnet address — the one a browser can reach |
| `62232f2c` | Fuigo bundled |
| `359f0a15` | Phase C responsive: C1, C3, C4, C5, measured |
| `c82c009f` + `637f9de7` | `/api/events` scoped, and every route that could rebuild the firehose |
| `427936d6` + `94ef6689` | Four skins collapse to Light / Dark / Automatic |

### The D1 decision, and how it was made
Three models were asked independently whether to scope `broadcast()` or drop `/api/events` from the
device surface. **2–1 for scope.** The deciding fact: `/api/events` is not a UX nicety on that
surface — it is the device-presence signal *and* the in-flight revocation lever
(`companion/src/proxy.ts:418-431`), so dropping it trades a confidentiality hole for the loss of the
one control that matters when a phone goes missing. The dissent (GPT-5.6) is worth keeping: the
control plane should not ride on the application event bus at all, and a dedicated device-session
stream carrying no thread ids would be the cleaner long-run shape.

All three agreed on the condition that actually mattered, which no plan contained: scoping the push
side while the pull side authorises on thread id alone is **theatre**. So the pull side was closed
too — including `/api/bots`, which nobody's list named and which was the widest transcript read on
the port.

**Polarity is inverted from `plan-security.md`: scoped is the default, the desktop opts out.** The
cost is that the renderer must say so in three places (`src/lib/live-events.ts` via query string —
EventSource cannot set headers — plus `api()` and `InspectorPanel`'s raw fetch). Pinned by
`src/lib/desktop-surface.test.ts`, negative-controlled 4/4. Miss one in future and it goes red
rather than quiet.

### Tailscale — unblocked
HTTPS certificates enabled. A real Let's Encrypt cert mints for
`seans-macbook-pro.tail0a48a4.ts.net`, **expires 30 Nov 2026**. `isSecureContext` is now true, so
the PWA half can run at all. **Renewal is a live design constraint**: Tailscale renews only when
something asks. `tailscale serve` does; a hand-rolled listener reading cert files does not, and will
serve an expired cert in late November with no obvious cause.

### Needs Sean
1. **Publish `fuigo-win32-arm64@1.0.1`** — declared an optionalDependency of `fuigo@1.0.1`, registry
   answers 404. Windows ships x64 so nothing breaks here, but `npx fuigo` is broken on Windows ARM.
2. **Artifact size** — the bundled Fuigo binary is 165–174 MB per mac arch on a ~177 MB app, roughly
   doubling each artifact. A release decision, not a technical one.
3. **CT logs** — enabling certs published the machine hostname publicly. Rename before a PWA is
   pinned to that origin if that matters.

### Queued, deliberately not done
- **Phase C rows C2 (tap-44), C6 (hover-only), C7 (touch-unreachable), C8, C9, C10.** C6 is the
  sharpest: six per-message controls measure opacity 0 at 390px with `any-hover: hover` false.
- **Sidebar near-alignment** — rows at x=8 vs x=12, icons at x=21 vs x=24. Pre-existing, cross-cuts
  desktop, belongs in C10. One value, three sites.
- **`GroupView.tsx:1030`** likely has ChatView's header collapse, unverified — this dataset has zero
  rooms, so it was not blind-fixed. Add to C3's site list and measure with a room.
- **Settings nav** hides 6 of 8 sections behind a scroll with no affordance (`scrollWidth 917` vs
  `clientWidth 388`), and Search eats the first 37%.
- **CoS**: two Mediums and two Lows from the audit, unfixed per the Critical/High rule. E5 (UI) not
  built, so electing a workspace Chief still needs a hand-rolled PATCH. **E6 stays unbuilt.**
- **`scripts/check-skin-contrast.mjs`** still has dead `BASELINE_FLOORS` rows keyed `midnight|…`,
  and `check:contrast` is not wired into `pnpm test`.
- **Fuigo CI gates**: `release.yml` and `package-win.yml` have per-resource gates for cloudflared and
  none for fuigo. Rated the most important follow-up by the agent that built it.
- **`resolveFuigoCli()` is exported, tested, and called by nobody** — wiring Fuigo in as a selectable
  engine needs `server/drivers/**` and `src/**`.

### Process notes, honestly
- A workflow whose `.output` file is 0 bytes is **running, not dead**. I misread that, dispatched an
  overlapping agent, and two agents edited `server/store.ts` and the delegation tests at once.
  Repaired, nothing lost. Check with `TaskStop`/`TaskOutput`, never file size.
- Commit `4b57fd3b` swept in 288 lines of `server/index.ts` that were another agent's in-flight
  work, not its own six-line fix. Stage by explicit path when lanes are live.
- I committed `c82c009f` red — re-ran the server suite after adding a renderer test and never re-ran
  `src/` or `tsc -b`. Fixed in `42b425d8`. Run the suite for the lane you actually touched.
- Three agents died together on Anthropic 522s. Restart with a "what is already on disk" brief so
  they verify rather than redo.

---

**Updated:** 2026-09-02, ~00:30 · **Branch:** `upstream-apply-test` · **main:** `a3154a62`
**Repo:** `github.com/FerroxLabs/murage` · **Local:** `/Volumes/Mando/WaylandBots/murage-app`

Murage is Ferrox Labs' multi-engine AI agent desktop app. Hard fork of
[OpenMausBot](https://github.com/milind-soni/OpenMausBot) (Apache-2.0) at `6140532`, rebranded,
carrying the Wayland teams/skills library.

**Sean is asleep.** This handoff is written so the work continues without him.

---

## THE PROTOCOL — Sean set this explicitly, follow it exactly

> plan → cross-audit the plan → build → test → cross-audit **once** → fix **Critical and High only**

"Once" is the point: one audit pass after execution, then stop. Do not loop on Mediums and Lows —
log them as follow-ups and move to the next item. This is what stops an audit spiral eating the night.

## BACKGROUND WORK STILL RUNNING AT HANDOFF

| What | Where |
|---|---|
| Master-plan agent (11th of the planning swarm) | writes `MURAGE-UNIVERSAL-CLIENT-PLAN.md` to the scratchpad below |

**Scratchpad** (ephemeral — copy anything valuable into the repo):
`/private/tmp/claude-501/-Volumes-Mando-WaylandBots/4536dffe-6a1e-4570-b329-01008562e207/scratchpad/`

Workflow run ids, for `Workflow({scriptPath, resumeFromRunId})`:
- planning swarm `wf_80de03f5-c76` — 5 plans + 5 audits done, master plan running
- upstream port `wf_c1c78727-d07` — complete, merged
- PWA precedent research `wf_1f0e0bf0-2e9` · CoS research `wf_3a5c06f1-a22` · Android brief `wf_ef508d1e-052`

**When the master plan lands:** `cp` it into `docs/plans/universal-client/` and commit. It is told to
resolve every audit finding above, so if it contradicts one, trust the audit — the audits ran the code.

## AUTONOMY BOUNDARIES while he sleeps

**Do freely:** write code on branches, run tests, run workflows, commit to feature branches, write
plans, read anything.

**Do NOT without him awake:**
- Push to `FerroxLabs/murage-teams` (the live catalog every user's library panel reads)
- Publish a GitHub release, or run the Release workflow
- Delete bots, rooms or anything under `~/.murage` (there are backups from the cleanup:
  `~/.murage/bots.json.bak-20260901-224927`)
- `git push --force` anything, or push to `upstream` (its push URL is already set to `no_push`)
- Change anything in `~/dev/smarttrader` (unpublished IP — read-only reference, never into this repo)

**Merging `upstream-apply-test` → `main` is fine once its audit reports SOUND.** That was the
approved step 1.

---

## START HERE — the overnight queue, in order

### 0. Land the upstream port  — **DONE, merged to `main`, pushed** (`294f833a`)

Five commits from upstream plus one fixing the three High findings its audit raised. Audit verdict
**SOUND_WITH_CHANGES, no Critical, 8/8 mutations caught** — including reverting the vendored updater
bundle to upstream's behaviour, which was the stated risk. The auditor also re-ran the bundler and got
a byte-identical artifact, so the committed vendor file is genuinely generated, not hand-edited.

Not yet proven, and it needs a real Linux box: that `sudo apt-get install '<quoted .deb>'` installs on
clean Ubuntu 24.04 and resolves the `libgtk-3-0t64` virtual-Provides chain, and that a real
differential AppImage download leaves exactly one file at the launched path. Everything else was
proven by mutation on this filesystem.

### 1. Chief of Staff hierarchy  — plan done, audit pending

Plan: `docs/plans/universal-client/plan-chief-of-staff.md`

**The load-bearing claim is PROVEN, live, not read:** a room turn gets the agents integration at
hop 0 — `MURAGE_TURN_DEPTH=0` in the injected MCP env. So Sean's model runs as **two hops of
depth-1**, and `MAX_COMMS_DEPTH` never has to move.

```
you → Ember (her DM, hop 0)
Ember posts in the exec room → a lead answers (hop 0, fresh room turn)
  → lead delegates to a team member (hop 1)
```

Both blocking bugs reproduce:
- `ask_bot` from a room returns the literal `source thread does not belong to sender`
  (`server/index.ts:5292`, `:5448` — siblings at `:4266-4273` use `connectorThread`, which handles groups)
- `store.botByThread(roomThread)` is undefined, so a delegation launched from a room completes and
  its result is **silently dropped** (`server/index.ts:2126`)

Also: `chiefOfStaff` is one-per-**section** (`store.ts:1318-1324`), so it is a per-team role today.
Ember has `section: null`, and her live prompt literally reads *"No other visible bots are available
yet."* Seven gates enforce the section filter — all enumerated in the plan.

**Constraint:** `pkg.chiefOfStaff` is in the published bot-package format and **122 live catalog
entries carry it**. Change the concept, not the wire field.

Do this first after the merge. Smallest, highest daily value, blocks nothing and is blocked by nothing.

### 2. Security architecture — the browser door

Plan: `docs/plans/universal-client/plan-security.md` (65KB, the keystone; everything else depends on it)

Fixes `/api/search` whether or not a PWA ever ships — see **Live security issues** below.

### 3. PWA + responsive UI

Plan: `docs/plans/universal-client/plan-pwa-ui.md`

### 4. Onboarding rework — the WebUI toggle

Plan: `docs/plans/universal-client/plan-addendum-onboarding-webui.md`

Sean's ask: the onboarding step that offers to install the iOS app becomes the **security** step —
*"connect a phone or another device?"* and separately *"enable the web UI at all?"*, off by default,
Wayland-style. The slot already exists (`Onboarding.tsx:349` renders `PhoneSetupFlow`).

Keep the two questions separate. Enabling the door ≠ pairing a key.

### 5. iOS retirement

Plan: `docs/plans/universal-client/plan-ios-retirement.md`

**iOS is a leaf.** 130 files, 4.2 MB, and exactly **two** references from the rest of the repo: a
comment in `companion/test/routes.test.ts:36` and an OUT path in `scripts/capture-companion-fixtures`.
The companion sidecar and its pairing must survive — they are the foundation of the PWA plan.

### 6. Cloud / headless — conditional, and the condition passed

Plan: `docs/plans/universal-client/plan-cloud.md`

**I was wrong to bet against this.** Headless is real: harness and sidecar are plain Node with zero
Electron imports, and the shipped esbuild bundle runs standalone under `env -i` with empty `HOME`,
no `node_modules`, no Electron — proven. Electron owns only the desktop shell, and every piece of it
degrades to "unavailable" rather than crashing (`server/index.ts:270` already treats
`process.parentPort` as optional).

Engine auth is **not** fatal: `claude` accepts `CLAUDE_CODE_OAUTH_TOKEN`, `codex login --device-auth`
exists, and **Flux Router redirects all three engines with env vars alone — proven end-to-end.**

Recommendation in the plan: systemd on a box you own, not Docker.

**One real question for Sean, flagged not buried:** whether running a *subscription* CLI unattended
on a cloud box is within Anthropic's Consumer Terms. Flux/BYOK has no such ambiguity. He should read
the terms before making the cloud box a subscription workhorse.

---

## MASTER PLAN — landed. `docs/plans/universal-client/MASTER-PLAN.md`

It re-ran the three load-bearing claims itself. **Two hold, one is false as I stated it.**

**(a) Room turn at hop 0 — TRUE.** Booted the harness; injected agents env carried
`MURAGE_TURN_DEPTH="0"` with `MURAGE_THREAD_ID` equal to the ROOM thread. `server/index.ts:4190`
passes literal `0`; `:3474` mounts on `hop < MAX_COMMS_DEPTH`. Chief of Staff design is solid.

**(b) Companion proxy serving static — FALSE on the existing port.** `dist/index.html` loads its
bundle with `<script type="module" crossorigin>`, a CORS-mode fetch that sends `Origin` **even
same-origin**, and `companion/src/proxy.ts:236-242` 403s any `Origin` *before* the token check and
before `denyReason` runs. The app's own entry bundle would be refused. Needs a **new listener**, and
**port 8813 — not 8812**, which `electron/companion-origin-gateway.mjs:12` already owns.

**(c) Headless BYOK auth — TRUE.** An unlogged-in `claude` in an empty `HOME` completed a real turn
via env vars alone: `{"is_error":false,"result":"HEADLESS_OK"}`. Zero new code. But
`claude auth status --json` returns `{"loggedIn": true}` for a **fake** token, so the cloud plan's
health monitor never fires for the failure it exists to catch. Coverage is 3 of 13 engines.

### The finding that outranks the security plan

**`GET /api/events` is an unfiltered firehose.** `server/index.ts:1087-1090` broadcasts every
persisted message to every SSE client; the only filter is `screen` (`:1202`). It is allowlisted today
(`routes.ts:57`). **Scoping `/api/search` does not close transcript exposure** — it removes a grep and
changes nothing about what is reachable. I told Sean the search fix was the answer; it is half of one.

### Verdicts

| Track | Verdict |
|---|---|
| iOS retirement | **BUILD** |
| Chief of Staff | **BUILD** steps 0–5 · **DO NOT BUILD** step 6 (its cycle controls are reset by any connector/secret resume and by a restart) |
| Security | BUILD WITH CHANGES — 4 defects incl. the 8812 collision and a tailnet selector that can silently bind a LAN interface (`listener.ts:26-29`) |
| PWA | BUILD WITH CHANGES — the service worker as specified is **measured broken**: offline, `#root` empty, both cached assets `ERR_FAILED`, recovery script then unregisters and lands on `chrome-error://` |
| Cloud | BUILD WITH CHANGES, but **defer** |

### Effort, honestly

**252–305 h total — 8–10 weeks for one engineer.** The five plans summed to 165 h, so they were
collectively **~40% under**. A phone in Sean's hand that is safe and works (Phases A+B+C) is
**144–172 h, five to six weeks**. If only three weeks exist: A + C — a responsive Murage over an SSH
forward with the live holes closed and no new attack surface.

### DO FIRST — 3–5 h, safe, unblocked, closes live holes

1. Delete `GET /api/search` from `companion/src/routes.ts:102` **and `companion/test/routes.test.ts:71`**
   — the plan's edit without the test line turns CI red; the auditor proved it.
2. Delete `POST /api/connectors/:slug/authorize` from `routes.ts:132` — a paired phone can currently
   bind a Google account to this machine.
3. Decide `/api/events` (§0b, decision D1). **Do not ship the browser door before this is answered.**
   8–14 h if `broadcast()` is scoped per client.

Retirement is the one moment removing the search route costs nothing: no client will exist to call it.

### Confirmed live, worth knowing

- `POST /api/cli-test {"cli":"/bin/echo"}` → `200 {"ok":true}`. The RCE primitive is real.
- The SPA fallback returns `200 text/html` for `/assets/index-NOPE.js`, `/sw.js`,
  `/manifest.webmanifest` and `/icons/*.png` — an allowlist that denies a path still serves the shell.
- No `nosniff` on any static response.
- **`CertDomains: null` — Tailscale HTTPS is OFF.** A blocking PWA prerequisite (`isSecureContext`).
- `delegations.ts:311-316` silently deletes room-sourced delegations.

**Every `server/index.ts` line citation in three of the five plans is STALE.** Real anchors are in
MASTER-PLAN §8. Trust the master plan's line numbers over the individual plans'.

---

## PLAN AUDITS — all five landed. **Read this before building anything.**

Verdicts: **4 SOUND_WITH_CHANGES, 1 BROKEN.** The audits ran the code rather than reading it, and
several critical findings contradict their own plan. The master-plan agent (11th in the swarm) was
still running at handoff; when it lands, **copy it out of the scratchpad into
`docs/plans/universal-client/` — `/private/tmp` does not survive.**

Workflow run id for resume: `wf_80de03f5-c76`.

### PWA + responsive — **BROKEN**. Do not build from it as written.

- **The service worker bricks the app offline — measured, not argued.** The plan merges AionUi's
  `networkOnlyWithTypeGuard`, which opens with a bare `fetch` and has no catch and no `cache.match`
  fallback (`aionui/public/sw.js:120-137`). Offline, it throws instead of serving the cached shell.
- **The cache version never changes between builds.** §1.6 stamps `package.json`'s version into
  `__MURAGE_SW_VERSION__` and claims "a stale bundle cannot outlive a release" — but the version is
  `0.1.44` and `"build": "tsc -b && tsc -p tsconfig.server.json && vite build"` never touches it.
- **`PATCH /api/bots/:id` is an execution-policy escalation.** The plan wants it for an unread flag;
  `companion/src/routes.ts` matches method+path regex only, with no body filtering, so allowlisting it
  grants every field on the bot record.
- `tailscale serve --https=443` publishes to **every node on the tailnet**, and the plan budgets a
  listener with no authentication while deferring the credential to the security track.
- **Better primitive the plan missed:** Tailscale Serve injects `Tailscale-User-Login` /
  `Tailscale-User-Name` identity headers on proxied requests. Under a tailnet-only threat model that is
  stronger and cheaper than the cookie it proposes.

### Chief of Staff — SOUND_WITH_CHANGES. Hop-0 claim independently reproduced.

- **A room-sourced `delegate_bot` is SILENTLY DELETED, not merely undelivered.**
  `server/delegations.ts:311-316`: `const from = bus.store.botByThread(threadId); if (!from) {
  pendingDelegations.delete(threadId); savePending(); return; }`. Worse than the plan assumed.
- **There is an EIGHTH section gate** the plan missed: `server/index.ts:5206`, the routine
  proposal-time check on `for_bot_id`. The plan's gate 6 is only the other half.
- Post-approval re-checks at `server/index.ts:5386` re-validate section equality, and the plan's own
  blast-radius mitigation routes every workspace-chief action straight into them.
- `canReach` is **not** a strict superset, so "gates 1-7 are behaviourally inert until a workspace
  chief exists" is false — four of the seven have no `hidden` check today.
- A peer-approval card in a room thread can never be settled after a crash:
  `server/peer-approval.ts:186-204` never visits a group thread.

### Security — SOUND_WITH_CHANGES. Two findings invalidate parts of the design.

- **Port 8812 is ALREADY the cloudflared tunnel origin** (`electron/companion-origin-gateway.mjs:12`).
  The plan puts the browser door there. That is the Wayland bug shape — pick another port.
- **Fixing `/api/search` does not close the hole, because `/api/events` is an unfiltered firehose.**
  `server/index.ts:1087-1090` broadcasts every persisted message as an SSE frame, by construction.
- **"Tailnet-only" can silently become a LAN bind.** `companion/src/listener.ts:62-68` matches
  `100.64-127.x` over the machine's own interface table — right range, wrong trust assumption.
- Routines are a hole in the computer-provision denial: `POST /api/routines` is granted while
  `computer/provision` is denied, and a routine can drive one.
- `POST /session` hands an unauthenticated tailnet peer a **permanent pairing DoS** — it reuses
  `devices.redeem`, which decrements `MAX_PAIRING_ATTEMPTS = 5` on every call.
- No `X-Content-Type-Options: nosniff` on the static branch; measured live.

### Cloud / headless — SOUND_WITH_CHANGES. One finding matters a lot.

- **THREE engines lie about auth, not one.** With `HOME` and `MURAGE_DATA_DIR` pointed at empty scratch
  dirs, `/api/instances` reported `authenticated: true` for **opencodeGo, qwen and hermes**.
  `claudeSignedIn` (`server/drivers/claude.ts:55-70`) trusts `claude auth status --json`'s `loggedIn`
  field, which reports **presence, not validity**. Any health check built on it is worthless.
- Local VM sizing is a hard constant, not an unknown: `server/container-computer.ts:60-61` pins 4 GiB
  and 2 CPUs, and `dockerSecurityIsHardened` REQUIRES it — this kills the plan's "better headless" claim.
- The plan rejects Docker because the `docker` group is root-equivalent, then puts the `murage` user in
  the docker group. Self-contradictory.
- The credential migration story is missing and blocks day one.

### iOS retirement — SOUND_WITH_CHANGES.

- **Removing `GET /api/search` from the allowlist lands CI red**: `companion/test/routes.test.ts:71`
  asserts it. The plan edits only line 36 of that file.
- `companion/` is **not** iOS-free as the plan claims — `companion/src/control.ts:151-153` encodes an
  iOS-only policy.
- The salvage list commits the irreversible mistake the plan's own risk #2 names: it copies out only
  `Sources/CompanionCore` and skips ~15 files under `ios/App/` and `ios/ShareExtension/` it had itself
  identified as reference material.
- Disproven risk (good news): `main` is **not** a protected branch, so removing the iOS CI job cannot
  strand PRs on a required status check.

---

## Decisions Sean has made — do not relitigate

1. **Threat model: single-user, TAILNET ONLY.** No public ingress, ever. Not multi-tenant.
2. **iOS is retired NOW**, before the PWA lands. Zero published releases, so nobody is stranded.
3. **Android is not adopted.** Deferred with a named trigger (see below).
4. **Plan first, cross-audited, then build.** He reviews before code where the plan is new.
5. Order: Chief of Staff → security → PWA → onboarding → iOS retirement → cloud.

---

## LIVE SECURITY ISSUES — found tonight, not yet fixed

**1. `/api/search` is unscoped and allowlisted for paired devices.** Proven live with an
unauthenticated curl: it returned Ember's private DM *and* Bruce's trading thread in one response.
`server/index.ts:6069` sits outside the `/api/internal/` token gate; `server/message-db.ts:196` shows
no `threadId` means an unrestricted scan across every thread, every bot, every branch. It is also
allowlisted in `companion/src/routes.ts:102`, so **the shipped iOS pairing token is already a
full-transcript grep tool.** Loopback-only today, so it is not an emergency — but it becomes the
front door the moment anything is tunnel-reachable. Fix in step 2.

**2. RCE in two requests if the full UI is ever served remotely.**
`PATCH /api/instances/:id` (`server/index.ts:8073`) sets the CLI binary used for every later turn;
`POST /api/cli-test` (`:8051`) spawns a caller-supplied path. Both gated only by a
`content-type: application/json` check whose own comments say it is anti-CSRF for a loopback server —
a same-origin fetch passes it trivially. Both are currently 404'd by the companion allowlist, and
that allowlist is **the entire boundary**: `companion/src/proxy.ts:7-13` says the sidecar speaks to
the harness as itself, satisfying the loopback gate by construction.

**3. Filed against Wayland (not Murage):**
`~/dev/wayland/docs/bugs/2026-09-01-webui-exposed-by-webhook-tunnel.md`. Its webhook tunnel runs
`tailscale funnel` (public internet) against the port that also serves its WebUI, and the tunnel
**bypasses its own loopback binding** — an operator who correctly left remote access off is still
fully exposed. Marked unconfirmed; someone on that team should enable the opt-in and fetch `/`.

---

## What shipped tonight, verified

| | |
|---|---|
| Skill descriptions | fixed in the **parser**, not the converter — 2,237/2,237 parse with real text |
| Packaged skills | `skills-library` now ships in builds; `MURAGE_SKILL_LIBRARY` was referenced exactly once in the whole repo (its own declaration) and set by nobody |
| 57 profiles | live on `murage-teams` beside the 65 teams; Smart Trader carries its 11 tvcontrol skills |
| The 32 missing skills | 8 profiles were shipping half-empty (`coin` declared 11, installed 3) |
| Skills panel | on the Agent profile; 40 tests, up from 14 |
| Catalog cap | 122 entries exceeded a hard limit of 100 — `parseTeamCatalog` **throws**, so it would have emptied the whole library panel |
| Team import | "Replace team" removed entirely — it was the default *and* the primary button |
| Markdown leak | package blurbs rendered `**bold**` literally; 38 of 57 profiles carry markdown there |
| Docs rebrand | every download button, clone URL and "Edit on GitHub" link pointed at an account we don't own |

**Test suite: 2,899 pass / 4 fail this morning → 2,982 pass / 1 fail now.**

---

## THE CONTRACT SPLITS — now at twelve. Assume a thirteenth.

The rebrand keeps renaming one side of an identifier and not the other. Every one was found by
something breaking, except the twelfth.

Schema id · catalog format string · `HERMES_OPENMAUS_*` · team-library URL · update-feed owner ·
SBOM property · DEB maintainer · a sha256 fixture · `runOn: maus` · the credential list (twice) ·
**#11** the docs site's download/clone/edit links · **#12** `window.__ombBrowser`

**#12 is the instructive one.** `rebrand.sh` *excludes* `third_party/`, so `entry.ts` wrote
`window.__ombBrowser` while `browser-surface.cjs` probed `window.__murageBrowser` in eight places.
It stayed hidden because the committed bundle had been **sed-rebranded after generation** — shipped
bytes said one name, the source they came from said the other. Anyone re-running
`build-browser-snapshot.mjs` would silently regress `ensureInjected()` to permanent false: no rich
snapshot, `validateRef`/`hitTestRef`/`boxForRef`/`focusRef` all dead, no error. There is now a guard
test that reads both files and asserts the globals match.

**Why the existing tests could not catch it:** the surface tests stub the CDP call by matching the
reader's own string, so both halves drift together and stay green. Watch for that shape elsewhere.

**Sweep for identifiers another process reads, separately from cosmetic renaming.**

---

## Known follow-ups (Medium — do not let these block the queue)

1. `server/remote-computer.ts:66` — `if (elements.length >= 250) break;` with no truncation signal.
   The same lie `4b71b204` exists to remove, on the remote-box path. Upstream never touched it.
2. Release digest verification was **deliberately weakened** — GitHub computes asset digests
   asynchronously, so upstream's strict check would fail a good release. A missing digest is now a
   notice, not a failure. Reasonable; Sean may want it tightened.
3. Delete residue: deleting a bot leaves `~/.murage/workspaces/` folders and `messages.db` rows.
   Deliberate (it keeps cleanup reversible), but **nothing owns reconciling the three stores**, which
   is why the app cannot clean itself and an external script had to.
4. `book-publishing-house` — 1 of 60 teams still skipped.
5. Two Quiet Money rituals dropped — `RoutineSchedule` is only `once|daily`.
6. Cloudflare account is not a Ferrox account.
7. Composio ceiling built, not deployed (`wrangler deploy` needs Sean's token).

---

## Android — DEFERRED, with a named trigger

44 of upstream's 59 commits. **Do not adopt.** `android/core` is a hand-written second copy of the
Swift CompanionCore — no generator, no IDL; parity is maintained by prose comments citing Swift line
numbers, and it fell behind **four times in three weeks** inside one repo.

It is also pre-loaded with contract split #13: `Connection.kt:409` checks
`token.toByteArray().size != 52`, where `52 = 9 + 43` for `"omb_pair_"`. `"murage_pair_"` is 12 chars,
so the constant must become **55**. Rename the string, leave the number, and every valid QR pairing
code is rejected. Nothing fails to compile.

Deferring is free: exactly **one** Android commit touches anything outside `android/` (a `.gitignore`
line). No security defect was found — the three flagged dissolved into faithful ports of Murage's own
iOS design.

**Flips to adopt:** a commercial Android commitment, someone who owns Kotlin/Compose/Gradle, or the
channel layer slipping a quarter. **Flips to hard skip:** upstream abandoning it — watch `07b7e50c`
(maintainer, empty commit body, −930 lines, deletes a 354-line test file).

---

## Running it

```bash
nvm use 24
node --experimental-strip-types server/index.ts &   # :8799  (webhooks :8800)
npx vite &                                          # :5199
npx electron .
```
Order matters. Electron's `DEV_URL` defaults to **5199** and gives up fast; a stale vite squatting on
5199 gets loaded instead of yours. Check `lsof -nP -iTCP:5199 -sTCP:LISTEN` and confirm its cwd before
starting a second one — agents have left strays.

---

## Gotchas that cost real time

- **`npx tsc` reports SUCCESS when `node_modules` is missing** — it resolves nothing and exits clean.
  A worktree without deps gives a false green. Confirm deps exist before trusting any typecheck.
- **Workflows using `isolation: 'worktree'` can silently skip agents.** One reported "completed" with
  an audit that never ran (`Cannot create agent worktree: not in a git repository`, because the shell
  cwd had reset to a non-repo parent). **Check `agents_done` against what you expected before trusting
  a verdict.**
- **The shell cwd resets to `/Volumes/Mando/WaylandBots`**, which is not a git repo. `cd` into
  `murage-app` at the start of every command.
- **zsh does not word-split unquoted parameters.** `for f in $FILES` over a multi-line string iterates
  once, over the whole blob. Cost a silent no-op tonight.
- A **v2 team manifest deliberately creates no room**. Bot packages do. Use packages.
- **Chromium honours EITHER `scrollbar-width` OR `::-webkit-scrollbar`, never both.**
- **`win.publisherName` does not exist in electron-builder 26** — it lives inside `azureSignOptions`,
  and a stray one fails the config for every platform. Validate against
  `node_modules/app-builder-lib/scheme.json` locally; a CI round trip to learn a field name costs 8 min.
- Signature gates must allowlist vendor signers — we bundle `cloudflared.exe`, signed by Cloudflare.
- Dev Electron is `com.github.Electron`, unsigned; macOS cannot attribute permissions to "Murage"
  until it is the packaged signed app.

---

## Live infrastructure

| | |
|---|---|
| Releases | `FerroxLabs/murage-releases` (public, **zero releases so far**) |
| Teams | `FerroxLabs/murage-teams` (public, 122 catalog entries) |
| Composio broker | `murage-composio.patient-meadow-1a11.workers.dev` |
| Cloudflare acct | `b83123326a4b9ad76831b9cb9365b33b` (admin@imsuccesscenter.com — **not Ferrox**) |
| Azure signing | `ferrox-labs-signing` / profile `ferroxlabs` / eastus, validation Active |
| Apple | Team `PX6SP9GPWJ`, Developer ID cert on this machine, API key verified |

**Release:** macOS green (signed, notarized, stapled), Windows green (Azure Trusted Signing), Linux
was failing at the in-place DEB upgrade — `f7c0d815` is the fix, not yet exercised on Linux CI.
