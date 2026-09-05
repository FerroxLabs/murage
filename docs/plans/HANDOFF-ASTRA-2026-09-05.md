# Handoff to Astra — Murage

You are taking over engineering on Murage. This is written for you, not for a
human skim. Everything below was verified on this machine; where I could not
verify something I say so, because I got that wrong twice in the last session
and it cost real time.

---

## 0. HARD CONSTRAINTS. These are not preferences.

- **NOTHING IS PUSHED, AND NOTHING MAY BE PUSHED** without Sean saying so in
  that turn. Verified at handoff: `origin/main` == local `main` == `1234d669`,
  zero of our branches exist on the remote, 43 commits are local-only.
- **No release may be published.** Never `git push --force`.
- **Threat model is fixed**: single user, one machine, reachable only over the
  user's own Tailscale tailnet. **`tailscale funnel` is forbidden, always.**
  `tailscale serve` (tailnet-scoped TLS) is the supported front. Findings or
  designs premised on a public internet user, tenants, or sign-up are out of
  scope.
- **DigitalOcean**: the four `flux-pool-r2-*` droplets are PRODUCTION. Never
  touch them. Any test droplet must be named `murage-test-<id>` and destroyed
  before you report.
- `~/dev/smarttrader` is read-only reference. Nothing from it enters this repo
  or any build artifact.

---

## 1. Where the code is

| branch | commits vs main | what |
|---|---|---|
| `main` | — | `1234d669`. **Untouched.** Identical to `origin/main`. |
| `upstream-sweep-2026-09` | **43** | Everything. The only branch that matters. |

`upstream-sweep-2026-09` contains all seven sweep lanes (server, engines,
desktop, sidebar, acp-images, routines, mcp) plus every fix made since. The
individual `sweep/*` and `fix/*` branches are ancestors of it and can be
ignored; they are kept only so the reasoning stays in history.

The fast-forward of `main` to that branch is **Sean's call and has not been
made.** Do not make it for him.

Verify the merge is intact before trusting anything:

    grep -c use-credentials index.html            # 2  PWA manifest fix
    grep -c isPermanentlyRefused src/state/store.tsx   # 2  retry-loop fix
    grep -c routineProposalDigest server/routine-requests.ts  # 7  approval digest
    grep -c enforceRunLimits server/routines.ts   # 3  run-limit decoupling
    grep -c MAX_DEPTH server/redact.ts            # 2  redact depth fix

---

## 2. What Murage is

Electron + React + a Node harness. A hard fork of OpenMausBot (Apache-2.0) by
Ferrox Labs. Agents are called **Embers**. The default engine is **Fuigo**, an
ACP CLI (itself a fork of Grok Build). 32 drivers, 93 server modules, 94 React
components. Since the fork: ~66,000 added lines across ~660 code files.

Two surfaces, and the distinction is load-bearing:

- **desktop** — the Electron renderer talking to its own harness over loopback.
- **remote** — a paired phone or browser reaching the companion's browser door
  (port 8813, cookie-gated, HTTPS via `tailscale serve`).

`requestSurface(headers, query)` returns `"remote"` for anything that does not
both mark itself desktop AND prove it with this launch's secret. **Saying
"desktop" is not being desktop.**

---

## 3. The invariants. Violations of these are bugs; everything else is taste.

- **I1** Any HTTP path that spawns a process, or writes configuration deciding
  what gets spawned, is desktop-only: `requestSurface(...) !== "desktop"` →
  **404** (404, not 403 — do not leak route existence).
  We were bitten TWICE by gating the obvious route and missing a second
  writer. Assume a third exists. The rule is not "gate the route", it is
  **"gate every path that writes a spawn-deciding record."**
- **I2** A card-confirmation path may write from any surface only if it is
  content-bound, single-use, and owner-bound to the conversation rather than
  to the payload. Missing any of the three makes it a bypass.
- **I3** Role is read through `botRole(bot)` — never the raw `chiefOfStaff` /
  `chiefScope` / `individual` fields in a component. `src/lib/role-leaks.test.ts`
  enforces this. A demotion bug once shipped from exactly that shape.
- **I4** Anything written to `~/.murage/events/*.ndjson` or
  `~/.murage/native/*.ndjson` is a file people paste into bug reports.
  Credentials, provider text and large payloads must be scrubbed first.
- **I5** Secrets never cross the SSE wire and never reach a renderer. Provider
  image payloads are staged to disk and referenced by path.
- **I6** **A test that still passes when its production change is reverted is
  not a test.** See §6 — this is the working discipline, not a slogan.
- **I7** Bots are soft-deleted (`hidden`), never removed. Every group's
  leader/member/responder pointer must resolve against the visible set.
- **I8** No upstream identity (OpenMausBot, openmaus, milind-soni, `OMB_`,
  MausState) survives in shipped files. One known leak remains: see §5.

---

## 4. What is DONE and verified

The sweep landed 46 triaged upstream cherry-picks across seven lanes, each in
an isolated worktree, each adversarially refuted by a second agent. **2,617
tests, 34 negative controls with real RED assertion text.**

Two security bypasses were caught and closed:
- `PUT /api/config` could write `mcpServers`, bypassing all six gated MCP
  routes — a phone could decide what process gets spawned.
- A routine-confirmation card could create an **enabled** interval schedule
  from any surface while `POST /api/routines` was gated.

Fixed since, each with controls:
- **PWA install** — `<link rel="manifest">` had no `crossorigin="use-credentials"`,
  so the door 401'd the manifest and Chrome silently refused to offer an
  install. Measured: omit 401, same-origin 200.
- **Forever-retry** — `api()` discarded the HTTP status, so the peripheral
  snapshot loop retried a permanent 403/404 surface gate every 30s for as long
  as a tab stayed open.
- **`redactSecrets` failed open twice** (found by you, previous pass):
  an array entry with string `name`+`value` was shallow-copied so every OTHER
  property rode through unscrubbed; and `depth > 12` returned the subtree
  intact. Both proven leaking, both now closed.
- **Approval did not bind to what was displayed** — see §5.1, it matters.
- **Run-limit kill switch** — the timeout scan sat inside `if (this.ticking)
  return`, so one wedged dispatch disabled it for every routine, permanently.
  Now `enforceRunLimits()` with its own flag, called before the guard.
- **acp-images** — image base64 scrubbed from `native/*.ndjson` went verbatim
  into `events/*.ndjson`. Now length-only.
- **engines** — the model-picker refresh guard shipped with zero coverage;
  extracted to `src/lib/single-flight.ts` with four real tests.

---

## 5. What is OPEN. Verified open at handoff by grep, not by memory.

### 5.1 Approval binding — READ THIS BEFORE TOUCHING ROUTINES
`routineRequestFingerprint` is a **commit-recovery** check. It is computed at
confirmation over whatever is stored then, and on a FIRST approval there is no
receipt to compare against, so by itself it attests to nothing about what the
person read. It also excludes the card's `title` and `subtitle`, the only
parts they actually see.

I told Sean the card path was "fingerprint-bound" and used that to justify a
design decision. **That was wrong.** `routineProposalDigest()` now closes it —
taken once when the card is written, over the operation AND the rendered copy,
checked on confirmation. Cards written before it existed have none and skip
the check rather than becoming unconfirmable.

Confirming a routine card is deliberately available **from a phone**. Sean
decided that and he is right: it approves one specific rendered proposal, not
an arbitrary payload. Do not re-gate it by surface.

### 5.2 Still unfixed, with exact locations
| where | what | sev |
|---|---|---|
| `src/components/PluginsPanel.tsx:516` | MCP tab renders with no desktop check on a surface where every backing route 404s | MED |
| `server/index.ts:1682` | `GROUP_GOAL_WAIT_MAX_MS` floors at 1s with no ceiling; node clamps a `setTimeout` delay above 2^31-1 to **1ms** (measured), inverting a long wait into an instant timeout | LOW |
| `server/mcp-probe.ts:111` | `if (value.id !== 2) return` never checks `initialized`, so a process that emits a tools list without ever answering `initialize` is reported as a successful connection. Found independently by two models. | LOW |
| `.github/workflows/release.yml:83` | `should_release` skips only when `previous == current`, so a **downgrade** starts signed builds | MED |
| `.github/workflows/release.yml` | a previous `package.json` with no `version` field yields the string `"undefined"`, which `!= current`, so it releases. Fails OPEN. (A node CRASH fails closed — `bash -e` catches that.) | LOW |
| `.github/workflows/prepare-release.yml:92` | `gh release view` failing for ANY reason (revoked PAT, outage, rate limit) reads as "no such release" and proceeds | LOW |
| `.github/workflows/release.yml` (assembly) | you found this: the published-release guard runs before the builds while publication happens after, so assembly can overwrite live assets | HIGH |
| `docs/releasing.md:64` | still tells the reader to export a certificate named **"Developer ID Application: Milind Soni"**. Upstream identity, violates I8. | LOW |
| `server/harness/bus.ts` | provider text is persisted with no size bound; only credential shapes are scrubbed | MED |

### 5.3 Fuigo inherits the host's Claude Code environment — the biggest one
`fuigo inspect` on this repo reports it loading, on its own:
- `~/.claude/Agents.md` and `~/.claude/Claude.md` (global), plus project ones
- **`~/.claude/settings.json` permissions — 9 rules Murage never granted**
- **382 skills**
- the Claude Code plugin MCP fleet (discord, stripe, slack, vercel,
  huggingface, chrome-devtools, mcp-search, tvcontrol), most failing auth and
  crashing workers, with at least one tool dropped for a name collision

`fuigo mcp list` and `fuigo plugin list` both report **nothing configured** —
this is implicit discovery, invisible to Fuigo's own management commands.

Sean's position, which is the brief: **the inheritance is a feature** (it makes
integration easy and gives a bot real context). The problem is only that
Murage's own tools get crowded out. So do **not** isolate Fuigo wholesale.
Make Murage's 12 agent tools survive and be visible. Verified: all ACP drivers
declare `agentsMcp: true` (`server/drivers/acp/core.ts:768`), Fuigo does mount
`session/new` MCP servers (proven with a marker file), and `agents.stderr.log`
is 0 bytes. What is NOT verified is a live turn actually calling one.

### 5.4 Release machinery has never run
`package.json` is **0.1.44** — the fork-point version. **Zero** Murage tags,
**zero** releases ever published. `git tag --list 'v*'` returns four tags that
are all UPSTREAM's (`v0.1.46 v0.1.48 v0.1.49 v0.1.50`) pulled in by
`git fetch --tags`; none is an ancestor of `main`. **Clean those out before
tagging anything.** No packaged build has ever been smoke-tested; everything
verified so far ran from source.

`accounts.murage.ai` does not resolve. Ferrox owns `murage.ai` (confirmed by
Sean); the apex is parked on Namecheap. The control-plane implementation
exists at `cloudflare/control-plane` (`@murage/control-plane`) and was never
deployed, so "secure access" fails in every packaged build.

---

## 6. How to work here

**Negative controls are the standard, not a nicety.** For every behavioural
change: make the test pass → revert the production change → confirm it goes
RED with the real failure text → restore → confirm GREEN. Record the RED text.

**A control that stays GREEN means your TEST is wrong.** This fired four times
in the last session and was right every time:
- a wiring test counted matches file-wide and passed while a real call site
  regressed (there was an unrelated third match)
- a predicate test built its own error objects and never exercised the code
  that attaches the status
- an existing depth test nested a secret 20 deep and asserted only
  `not.toThrow()`, so it passed for the entire life of the bug
- an EPIPE test could not see the crash because vitest swallows uncaught
  errors — and when I moved it to a subprocess exit-code check it STILL passed,
  which is how I learned the bug was not reachable through that path at all

**Controls that share a rule are not independent.** Run one at a time.

**Registering a thing is not creating a thing.** Verify by booting, not by
tests passing. The sweep's own merge agent nearly shipped a false pass: its
worktree had no `node_modules`, so `pnpm typecheck` "passed" because tsc was
absent and the failure was swallowed. Check the tool actually ran.

---

## 7. Environment. These cost hours; they are not optional reading.

- **Start the harness from a LOGIN shell**: `zsh -lic '... pnpm dev:server'`.
  A `nohup` from a non-login context gives it a PATH without `~/.local/bin`,
  and every CLI probe then reports "not installed" — including Claude. The
  harness caches PATH at boot, so this is silent and total.
- **Order matters**: vite (5199) → harness (8799) → `pnpm dev:desktop`.
  Electron loads `DEV_URL` **once** at `electron/main.mjs:88` and never
  retries; start it early and you get a black window.
- **At handoff the app is DOWN** — vite, harness, companion door and Electron
  are all stopped. Nothing is at risk; everything is committed.
- Renderer crashes now reach the terminal (`68c06a4f` forwards console errors,
  `render-process-gone`, `did-fail-load`). Before that a blank window produced
  no evidence anywhere.
- **Remote access**: `companion-settings.json` holds `remoteAccess: true`, so
  the door binds loopback and `tailscale serve` fronts it at
  `https://seans-macbook-pro.tail0a48a4.ts.net`. If that ever 502s, the door
  and serve have drifted apart — `browserBindHost()` in `auto` mode binds the
  tailnet IP whenever Tailscale is up, while `companion-remote-access.mjs`
  hardcodes its serve target to loopback. Reconciling those at startup is an
  open task.
- The plain-HTTP bare-IP door is a **non-secure context**: `crypto.randomUUID`,
  `crypto.subtle`, `getUserMedia` and service workers are all absent there.
  Three separate features died from this at once. Use the HTTPS name.
- `node --check` reports "Illegal return statement" on workflow scripts. False
  alarm — the runtime wraps them in an async function.

---

## 8. About your own output, from measurement

Across two passes on this codebase you produced 11 findings. **I verified every
one I checked and found zero fabrications** — including three redaction
defects that my sweep and two other frontier models all missed, and the
approval-binding gap that corrected a claim I had made confidently.

But on a deliberately seeded calibration set of six known bugs placed in a
bundle you were given, **you found one.** You walked past a `crossorigin`
attribute that was literally in the file.

So: **your precision is excellent and your recall is poor and idiosyncratic.**
Practical consequence — do not treat your own silence on an area as evidence
that it is clean. Prefer many narrow passes over one broad sweep, and when you
have examined something say explicitly what you looked at, the way you already
do. Your habit of listing "bodies needed to settle this" instead of guessing is
the single most useful thing you do here. Keep it.

For comparison on the same code: gpt-5.6-terra scored 6 real of 8;
gemini-3.8-flash scored 2 of 9, including three confident HIGHs it produced
without opening the files.

---

## 9. Suggested order

1. Run the full suite on `upstream-sweep-2026-09` and record the number. I
   started that run at handoff and it had not finished; **do not trust any
   figure you did not see yourself.**
2. Boot it (§7 order) and exercise a real turn on Fuigo. Confirm the 12 agent
   tools are actually callable — that is unverified and it is what Sean asked
   about most recently.
3. Fix §5.2 top-down. The release-workflow HIGH first: it can overwrite
   published assets, and it is in the machinery you need in order to ship.
4. Make Murage's agent tools survive Fuigo's inherited environment (§5.3).
   Design work, not a patch.
5. Only then: clean the upstream tags, cut a real version, run the release
   workflow once end to end, and install the artifact on a clean machine.

Ask Sean before pushing anything, before publishing anything, and before
touching his networking or his droplets.
