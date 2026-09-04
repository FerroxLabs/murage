# Upstream sweep: OpenMausBot fork point → v0.1.50+ (2026-09-04)

Fork point `6140532e` (2026-09-01, six commits before upstream's `v0.1.46` tag).
Upstream `main` is 193 commits ahead: 37 merges, ~60 Android/iOS (deferred with a
named trigger in HANDOFF), **46 real candidates**. Every one was dry-run
cherry-picked into a throwaway worktree, then read against OUR tree by five
audit lanes that had to cite our `file:line` before calling anything a bug.

Verdicts: **12 take as-is or squashed · 15 take adapted · 6 defer · 13 reject**.

---

## Corrections to what we believed going in

1. **The prior sweep (to v0.1.46) missed one of its own picks.** Fable 5.1
   (`cb0d376b`) was queued as "one line, worth taking" and never landed.
   Landed now: `6b668c1f`.
2. **Version drift does not exist.** `package.json` 0.1.44 is the fork-point
   version. Every `v0.1.4x` tag is upstream's, pulled by `git fetch --tags`;
   none is an ancestor of `main`. Murage has **zero tags and zero releases**.
   HANDOFF corrected. Clean the upstream tags out before cutting the first one.
3. **`NOTICE` credited "the Murage project … Milind Soni".** The rebrand sed
   ate the Apache-2.0 attribution. Fixed.
4. **`antigravity.test.ts` is a flake, not a baseline failure.** 31/31 one
   run, one 20s timeout the next — 144KB stdin against a 20s cap on the
   `/Volumes` mount. Upstream deletes that test in its rewrite; it fixes
   nothing. Raise the one test's timeout locally.
5. **Two "candidates" were already in.** `6420ab36` (Ubuntu updates) landed as
   `f7c0d815`; `6de9eba2`'s release gates are in `release.yml:361,442,473,531`.
   Cherry-pick exit codes flagged both as CONFLICT because the rebranded copy
   was already there. Future sweeps: pre-filter by content-diffing touched
   files, not by cherry-pick status.

---

## TAKE — clean or near-clean, low risk, in this order

| # | sha | what | why it applies here | eff |
|---|---|---|---|---|
| 1 | `006c977f` + `7fa78666` | MEMORY.md written atomically (squash) | `workspace.ts:39,:103` still `writeFileSync`; `server/atomic.ts` already vendored | S |
| 2 | `48ed8acb` | settle a screenshot only when the screen changed | `index.ts:1873` broad poke, `:2592` unconditional `touched`, `:2609` no hash gate → idle desktop appended on every `curl`-and-answer turn. New pure module. Our tool names checked against its allow-list: no gap | S |
| 3 | `2689be08` + `bfe6df25` + `bb0a36d9` | "bot couldn't start" notification (squash as ONE) | `notify.ts:13` lacks `turn-failed`; catch anchor `index.ts:3228` identical. Never land the first alone — it ships an unredacted error body. Rebrand `OMB_COMMS_TOKEN` in test | S |
| 4 | `509a34b2` | retry Windows `rmSync` on cloudflared staging | `prepare-cloudflared.mjs:265,:269` unmodified; on `package:prepare` | S |
| 5 | `9f27177a` → `4eedf162` | desktop viewer permission policy + take keyboard | `main.mjs:1279-1280` deny-all, `:1282` shows unfocused → keystrokes land in the composer, ⌘1-9 switch bots. **Grants clipboard-read to the cloud Box origin — conscious yes** | S |
| 6 | `3ab2426d` → `4a72db5a` | model catalog refresh button + offline hardening | `ModelPicker.tsx:133` unguarded; backend `registry.ts:159` already refreshes | S |
| 7 | `ed7a1515` (adapted) | ACP handshake timeouts + `session/load` null guard | **Live bug**: `acp/core.ts:612` sets `sessionId = cursor` on a null result → skips `session/new` at `:617` → prompts a dead session. Hermes and fuigo both exposed. Rename `OPENMAUS_ACP_*`→`MURAGE_ACP_*`; defaults 60-90s, NOT upstream's 300s | S |
| 8 | `e1f4207e` (status half only) | `check_delegation` returns elapsed + recent activity | `index.ts:6205-6226` matches pre-image. Wake half is a separate decision (below) | S |

## TAKE-ADAPTED — hand-ports, in this order

**Image chain (foundation for the Flux image tool):**
9. `8be0d3fb` — `assistant_image` RuntimeEvent, `Message.attachments`,
   `generated-image.ts` decoder, base64 never on SSE. Ghost-tail deletion in
   `ChatView.tsx:1602` / `GroupView.tsx:1349` is the only real conflict. **M**
10. `e8869da2` — ACP image content blocks. Dry-run said CLEAN; it is a false
    clean (references `generatedImagesByTurn`, fails typecheck without #9). **S**
    → **Contract for our image tool:** emit
    `{type:"item.completed", itemType:"assistant_image", data:<base64>, alt?}`
    and let the harness stage it into `Message.attachments`. Do NOT synthesize
    an `<attached-image/>` marker into bot text — that is the user-side path
    and leaks a harness path through the model's text channel.
    `avatar-image.ts:137,337` already has the `b64_json` shape.

**Composer + sidebar:**
11. `3ba0ba0d` + `eac313db` — slash menu `/goal` `/learn` (squash). More
    valuable here than upstream: `server/skill-learn.ts` exists and `/learn`
    is undiscoverable today. One hunk (Goal chip) hand-placed at
    `Composer.tsx:771` under the two-row layout; pickers are `absolute
    bottom-full` and unaffected. **M**
12. `de7f0232` — fold four sidebar utility rows behind one chevron.
    `Sidebar.tsx:1923-2016` is the byte-identical pre-image. Keep our
    `desktop === true` gate on both phone-button sites. **M**
13. `7fc09de4` — calmer first-launch window (1100×780). Taste. **S**

**Routines Chain A — durable room goals + busy-wait:**
14. `ac41eb81` + `2c4e5b70` + `bd59135e` (squash; never land the
    "green run for a question" bug). 526-line `index.ts` hunk applied CLEAN;
    every other conflict is `runOn: "maus"`→`"ember"`. **L**
15. `cd67a557` — 30-min wait cap + reassign. #14 without it is an unbounded park. **M**
16. `803ba1cc` + `f4a6b89a` + `d9099fbe` (squash) — rooms WAIT for a busy
    member instead of skipping. **Product decision** (below). **M**
17. `ecf211aa` — name the awaited member. Without it a waiting room looks hung. **S**

**Routines Chain B — interval schedules (closes HANDOFF "only once|daily"):**
18. `3e23961d` part (a) ONLY — min duration 15→5, `CALENDAR_SLOT_MINUTES`,
    `visualEnd()`. Part (b), the Automations/Sidebar/SettingsPanel
    restructure, lands on our two most-diverged UI files: DEFER. **M**
19. `50ddda4d` + `75b7c154` (web hunks) — `{type:"interval", everyMinutes
    5-1440}`, overlap suppression, **`timeoutMinutes` — the first real
    wall-clock kill switch on a runaway routine**. Hand-port: interleaved with
    #14 in `routines.ts`. Renames agent tool field `duration_minutes`→
    `timeout_minutes` (model-facing break). **L**
20. `e74e85c1` — interval editor. Don't ship #19's first-cut editor. **S-M**
    → If budget for one thing in routines: 18 → 19 → 20. Does not need Chain A.

**Release:**
21. `2ba2dff0` — `prepare-release.yml` + `should_release` guard. Hand-port
    against our single-repo prepare job; rewrite for `FerroxLabs/murage-releases`
    + `RELEASES_PAT`. Preventive. Note: `push: paths: [package.json]` means a
    version merge auto-starts a signed build (draft unless `publish`). **M**

---

## DECISIONS — need Sean, not code

| decision | commit | the trade |
|---|---|---|
| Rooms wait for busy members? | `f4a6b89a` | Rooms become slower, never lossy. Interacts with `channel-queue.ts` drain at `index.ts:1102` — queued user sends wait up to the cap. Recommend YES with `MURAGE_GOAL_WAIT_MAX_MS` default well under 30 min for a single-user box |
| Peer wake: bot output auto-dispatches another bot's turn? | `e1f4207e` wake half | New autonomy primitive, budget 3/thread/5min, gate does not widen (`unattended` crosses the hop correctly). It is a bot-output → second-bot-prompt path. Recommend DEFER until there is a use case |
| Does `antigravityAgent` keep its `DEFAULT_FLEET` slot (`config.ts:793`)? | `6dbe5ae8` trio | Fuigo is the default now. Upstream's rewrite adds 5 tailnet-reachable POST routes, remote binary download+chmod, OAuth loopback, and an agent-driven fs read/write handler in the SHARED `acp/core.ts` fuigo runs through. Recommend drop the slot → trio becomes REJECT and the shared-core churn vanishes |
| MCP server management UI? | `074d2f7e` | GUI over a capability we already have via `~/.murage/config.json` (`config.ts:905`). Its six routes arrive UNGATED here; `POST servers` + `POST test` = arbitrary exec in two requests. Take ONLY with all six behind `requestSurface(...) !== "desktop"` → 404 (`index.ts:9472` precedent). Recommend DEFER |
| Clipboard-read for the cloud Box viewer? | `9f27177a` | Needed for the viewer to type. Remote provider page can read host clipboard while focused. Recommend YES |

## DEFER

- `d2635669` — Tools row + profile menu. Half is upstream's identity
  (`APP_NAME "OpenMausBot"`, their GitHub/docs/Discord). Needs Ferrox's five
  canonical URLs first — design work, not a pick. Use as reference after #12.
- `ed2ddb69` — secure attachment previews (+2524). Modifies
  `server/message-file.ts`, which **does not exist here**; its creator is
  `aa5ebd07`, labelled `feat(ios)` but holding the server route. Multi-day
  port of a feature we don't have. Scope as a feature if wanted.
- `3e23961d` part (b), `e1f4207e` wake half, antigravity trio — see decisions.

## REJECT

| sha | why |
|---|---|
| `8a6aeee4` | fixes ordering in the remote-clients subsystem we never took; our `ensureDirs()` order is already right |
| `d8716d96` | 4-line regex change to `server/surface.ts` which doesn't exist; parent is a self-declared WIP checkpoint; Step 2 never landed |
| `6420ab36`, `6de9eba2` | already in (`f7c0d815`; `release.yml` gates) |
| `24fcea6c` | enterprise layer: `enterprise/LICENSE` is "All rights reserved, no redistribution, no circumventing the check", signed by upstream's key only. A licensing landmine for a redistributing fork. Zero value single-user. Adds env-driven dynamic `import()` |
| `3b63c4bc` | routes Murage's own branding through that entitlement — would gate our identity behind Milind Soni's signing key |
| `79b0ff55` | deletes the categorical non-loopback 403 at `index.ts:5863` — the one line that makes "no public ingress" a code property. Public `POST /api/auth/pair`, public `/.well-known/…/environment`. Under `tailscale serve` every request would newly read as "remote" and BREAK the companion. #677 in better clothes |
| `d3250783` | loads a remote origin inside the Electron shell; hard dep on the above |

---

## Standing port rule (new, from lane E)

Upstream now gates execution routes through `79b0ff55`'s scope table. Every
future upstream commit that adds an execution route will therefore look gated
THERE and arrive UNGATED HERE. **Any new route that spawns a process, or
writes config that decides what gets spawned, gets
`requestSurface(...) !== "desktop"` → 404**, matching `index.ts:9472-9480`.
`074d2f7e` is the first instance; there will be more.

## Global application order (cross-lane, avoids `index.ts` collisions)

1 → 2 → 3 (notify series) → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 →
14 → 15 → 16 → 17 → 18 → 19 → 20 → 21.

The notify series (#3) and `e1f4207e` (#8) patch the same catch block; #3
first, then #8 re-anchors cleanly. Chain A (#14-17) and the image chain
(#9-10) both touch `index.ts` in different regions. Interval schedules (#19)
must follow #14 or become a full hand-port.

Also worth flagging upstream: `e1f4207e` ships a `console.error` that logs
the first 70 chars of every user prompt to stderr, unconditionally.
