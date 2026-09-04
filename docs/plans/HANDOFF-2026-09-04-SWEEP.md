# Handoff — 2026-09-04, end of session

Read this first, then `UPSTREAM-SWEEP-EXECUTION-2026-09-04.md` (how to build) and
`UPSTREAM-SWEEP-2026-09-04.md` (what and why). `HANDOFF.md` remains the standing
product handoff; this file covers only what changed today and what happens next.

---

## What shipped today (all on `main`, all pushed)

| commit | what |
|---|---|
| `a67f1972` | Voice: Flux's 10-second billing floor applied to both fallback paths |
| `096ac113` | Composer restructured into two rows — dead column above Auto is gone |
| `489de0e2` | Service worker + PWA install (Android could never be offered an install) |
| `771d55df` | Composio key promoted out of the collapsed disclosure |
| `6b668c1f` | Claude catalog: Fable 5.1 (the previous sweep queued it and never landed it) |
| `286ff5d0` | Gemini catalog: 2.5-era list → current 3.x set, read from Google's API |
| `d5e63256` | Box catalog: Fable 5.1 |
| `76c27ce8` | Codex catalog: `gpt-6-astra` |
| `1529e1b9` | NOTICE: restored the OpenMausBot attribution the rebrand sed destroyed |
| `68c06a4f` | Electron: renderer console/crash/load-failure now reach the terminal |
| `ed3ad755` `8c0d679b` `b6f2f65b` | The sweep: triage, execution plan, audit fixes |

## Flux — resolved, and the corrected record matters

The whole "402 premium_locked" story was **a wrong key**, not a plan limit.
Murage was running an internal/dogfood key. On the paid key
(`~/.zshrc:38`, old key preserved commented, backup `~/.zshrc.bak-flux-2026-09-04`):

- images `200` (1024×1024 PNG), all three voice arms `200`
- **`POST /api/voice/transcribe` returned its first real transcript** —
  `{"text":"Thank you.","model":"flux-voice-fast","billedSeconds":10}`.
  Phone dictation is no longer "built but unproven".
- flux-router found three stacked bugs on their side; their `entitlement` field
  still reports `"open"` for arms a key cannot call, so **do not gate a picker
  on it** until they ship the per-key fix.
- Their pricing (`max(seconds,10)` at 1667 µ¢/audio-second) exposed a real bug
  in our metering, now fixed in `a67f1972`.

## Three bugs Sean hit, and the honest attribution

1. **"Claude not installed"** — my fault. I restarted the harness with `nohup`
   from a non-login shell; it inherited a PATH without `~/.local/bin`, where
   `claude` lives, and the harness caches PATH at boot. Fixed by restarting from
   a login shell. **Always start the harness with `zsh -lic`**, or the probe
   lies. 10 engines now report available.
2. **Blank windows** — three of them, each following a service restart I did
   under his running app. Not reproducible in a fresh renderer: the exact role
   change was driven in a browser AND in a fresh Electron window with zero
   errors. Underlying gap that IS real and now fixed: a renderer crash produced
   no evidence anywhere, because the error boundary logs to the renderer console
   and nothing forwarded it. `68c06a4f` forwards console errors,
   `render-process-gone`, and `did-fail-load`. **If it blanks again, the stack is
   now in the dev terminal.** Electron also loads `DEV_URL` once and never
   retries (`main.mjs:88`) — a vite that dies during sleep leaves a black window.
3. **"Can't click Smith after deleting a duplicate"** — data is intact. Delete is
   a soft-delete: 19 bots on disk, 13 visible, 6 `hidden`. Checked every group's
   members, leader and responder pointers against the visible set: **zero
   unresolvable references**. Same stale-renderer class as (2); a relaunch clears
   it. Finch verified `leader` / `Dev Shop`, unchanged.

**Still open:** no root cause for the stale-renderer symptom itself. The next
occurrence will produce a stack for the first time — that is the next lead.

---

## The sweep — READY TO EXECUTE, nothing applied yet

Fork point `6140532e`, 193 upstream commits, **46 real candidates**, triaged by
five audit lanes that had to cite our `file:line` before calling anything a bug.
**12 take · 15 take-adapted · 6 defer · 13 reject.**

Then cross-audited by **GPT-5.6 and Gemini 3.8 Flash**. Both independently found
the same top defect. All three HIGH findings were verified against real diffs
before being accepted, and all are fixed in `b6f2f65b`:

- **#10 edits `acp/core.ts`** — Lane E's file, and the path the default engine
  (fuigo) runs through — but was scheduled inside Lane S running in parallel.
  Now its own serial lane (I) on top of both.
- **#8 edits `agents-proxy.ts`**, listed under Lane R's ownership. Assigned to S;
  R merges S first, so the order is safe and now stated.
- **#22 opens a second write path**: it teaches `saveConfig` about `mcpServers`
  while `PUT/PATCH /api/config` (`server/index.ts:9556`) stays open — bypassing
  all six gated MCP routes while still deciding what process gets spawned. Now
  requires `parseConfigPatch` to refuse the field, with a bypass test.

Seven more hardening fixes went in with them (writable test files are now part
of lane ownership; the rebrand grep scans added lines and the shipping tree;
#9 names the exact composer sibling order; #14+#15 squash so no commit carries
an unbounded wait; #19 gains the exec-route gate and a fake-timer test; #3 gains
a negative control per suppression predicate; #21 gains static CI assertions).

### Decisions Sean has made
- Enterprise/entitlement layer — **rejected**, permanently. Non-Apache,
  no-redistribution, signed by upstream's key only.
- Antigravity — **stays as an option**; fuigo is primary. The upstream rewrite
  trio is DEFER, not reject.
- MCP server management — **take**, with the desktop gate as a hard condition.
- Peer wake (bot output auto-dispatching another bot's turn) — **defer**.

### Still open for Sean
| decision | default if he does not answer |
|---|---|
| Rooms wait for a busy member (#16-17) | **skip**, and the workflow reports it |
| First-launch window size (#13) | take (taste, trivially revertable) |
| Clipboard-read for the Box viewer (#5) | take (the viewer cannot type without it) |

### Order of execution
Phase 1 parallel: **S** (server), **E** (engines), **D** (desktop), **U** (sidebar).
Phase 2: **I** (acp-images, needs S+E). Phase 3: **R** (routines, needs S).
Phase 4: **M** (mcp, needs S+R). Merge order:
`S → E → I → D → U → R → M` into `upstream-sweep-2026-09`.
**Fast-forward to `main` is Sean's call, never the workflow's.**

---

## How to run it

```
Workflow({ scriptPath: "docs/plans/UPSTREAM-SWEEP-2026-09-04.workflow.js" })
# add args: {"roomsWait": true} only if Sean has said yes to #16-17
```
Requires Opus. Each lane runs in its own worktree, never touches `main`, never
pushes. Every lane gets a read-only adversarial refuter; only `SOUND` lanes are
merged, by an agent in its own worktree.

**Do not trust a lane that reports success without checking `agents_done`** —
a worktree agent can silently fail to run (recorded in `HANDOFF.md`), and the
script logs a WARNING when the count is short.

---

## Environment notes that cost time today

- **Start the harness from a login shell**: `zsh -lic '... pnpm dev:server'`.
  A `nohup` from a non-login context gives it a PATH without `~/.local/bin` and
  every CLI probe reports "not installed".
- **Order matters**: vite (5199) → harness (8799) → `pnpm dev:desktop`. Electron
  gives up on `DEV_URL` immediately and never retries.
- `node --check` reports "Illegal return statement" on the workflow script.
  **That is a false alarm** — the runtime wraps scripts in an async function
  where top-level `return` is legal. Verify by wrapping before checking.
- Flux's paid key cannot call `flux-pinned-*` models directly (403) even though
  `/v1/models` lists them as `entitlement: "open"`. Use the provider APIs
  directly for cross-audits — `GEMINI_API_KEY` and `OPENAI_API_KEY` are in env.
- The web-search budget for a session is 200 calls and it ran out today. Direct
  `WebFetch` against `developers.openai.com` still worked.
