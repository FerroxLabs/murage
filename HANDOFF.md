# Murage — session handoff

**Updated:** 2026-09-01, ~90 min before a live webinar · **Repo:** `github.com/FerroxLabs/murage`
**Local:** `/Volumes/Mando/WaylandBots/murage-app`

Murage is Ferrox Labs' multi-engine AI agent desktop app: a hard fork of
[OpenMausBot](https://github.com/milind-soni/OpenMausBot) (Apache-2.0) at `6140532`,
rebranded, now carrying the Wayland teams/skills library.

## Naming (settled, registry-locked)

| Thing | Name |
|---|---|
| App | **Murage** (村下, the furnace master) |
| Engine | **Fuigo** (鞴, the bellows) — fork of `xai-org/grok-build`, separate session |
| An agent | **Ember** · default is Ember, orange |
| Palette | **Hearth** — `--forge-orange #ff6b35`, bg `#0d0d0d` |

Owned: murage.ai/.io/.dev · crates/PyPI `murage`+`fuigo` · npm `@murageai/core`+`fuigo`.
npm `murage` unscoped is permanently blocked; `@murageai` is our scope.

## Live infrastructure

| | |
|---|---|
| Releases repo | `FerroxLabs/murage-releases` (public) |
| Teams library | `FerroxLabs/murage-teams` (public) — **65 teams live** |
| Composio broker | `murage-composio.patient-meadow-1a11.workers.dev` |
| Cloudflare acct | `b83123326a4b9ad76831b9cb9365b33b` (admin@imsuccesscenter.com — **not Ferrox**, unmoved) |
| Sendlane | list 32, creds in `~/.murage/config.json` (0600) |
| Azure signing | `ferrox-labs-signing` / profile `ferroxlabs` / eastus, identity validation Active |

**All 9 GitHub secrets set.** Apple API key verified live against the notary service;
Azure client secret verified against both management and codesigning.azure.net scopes.

## Release status

macOS **green** (signed, notarized, stapled). Windows **green** (Trusted Signing).
Linux **failing** — currently at `apt-get install` of the .deb in the in-place upgrade
step; earlier Linux failures were the SBOM namespace and the DEB maintainer, both fixed.
Four runs so far; each found a real defect.

## What landed this session

- **65 teams** published, each importing as a crew **plus its room**: 59 from Wayland +
  upstream's 6 merged back (MIT, attribution preserved, README says which are whose).
  240 playbooks, 6 routines, 1538 skill links, zero dangling.
- **2,194 skills** in `skills-library/` — 2,106 from Wayland's pack plus 88 role skills.
- **Skills actually install.** `installSkillFromLibrary` is wired into team import; skills
  land in the bot's workspace and symlink into `.claude/skills`, `.agents/skills`,
  `.grok/skills`. Verified: Smith imported with 9 skills, all links resolve.
- Names read **`Smith (Code)`** — Wayland keeps the character in the id and the role in
  `.name`. Ids that ARE the role word stay plain.
- **Nine avatar call sites** fixed to honour a bot's own avatar.
- Composio **daily call ceiling** (fuse, not meter) — migration + worker, not yet deployed.
- Six upstream leaks closed, including the **auto-update feed pointing at their account**.

## THE GAP — Flux Router

**Zero Flux code shipped.** `grep -i flux server src electron` returns nothing.
A swarm (`wu1735bdz`) was running env-strip / credential / three surfaces / picker gate;
**check whether it completed and what it produced before writing any Flux code.**

### The cross-audit findings — read before building the UI

`docs/plans/flux-onboarding-ux.md` was audited by codex. Three CRITICALs:

1. **"79 models unlocked" is a false success signal.** `/v1/models` returns 200 while every
   inference call 402s — the account re-blocks after ~13-15 calls, reproduced twice. The
   design congratulates the user immediately before their first turn fails.
2. **"every bot / every engine" is false.** Only claude, qwen, goose, codex have a surface;
   seven named engines have none.
3. **"79 models" counts `flux-image` and `flux-voice`** — images are down, voice never
   probed, both out of scope. Listed ≠ unlocked.

Plus: the plan said keys live in `config.json`, but **packaged Murage uses Electron's
OS-encrypted credential store**; and the settings section is **Connections**, not "API keys".
Both plan claims are wrong. The full audit is `/tmp/flux-audit-codex.txt` (820KB) — move it
somewhere durable before it is cleaned up.

## Immediate next steps (was mid-flight)

1. **Publish 57 single-agent profiles.** `library/assistants/` (28) and
   `bot-library/builtins/` (29, includes `smart-trader.json`) were generated and NEVER
   published. A single-agent package IS the "assign a profile to a bot" mechanism — same
   import path, one agent, brings persona + playbook + skills. This is what Smart Trader
   needs and it is the cheapest high-value item left.
2. **Smart Trader has 0 skills.** Its 11,492-char playbook is intact. Import the 11
   published `@ferroxlabs/tvcontrol` skills and attach them.
3. **A skills panel on the bot profile.** All four API routes already exist
   (`index.ts:7284-7312`): list, install, read text, enable/disable. Pure UI work.
   Read-only (list + view) is 90% of the demo value if time is short.

**Smart Trader IP boundary:** ships the generic prompt + the 11 published tvcontrol skills
only. `~/dev/smarttrader` holds the unpublished 162-line Rebel Scanner and is READ-ONLY
reference — never into this repo or any build artifact.

## Running it

```bash
nvm use 24
node --experimental-strip-types server/index.ts &   # :8799
npx vite &                                          # :5199
npx electron .
```
Order matters: Electron's `DEV_URL` defaults to **5199** and gives up fast. A stale vite on
5199 will be loaded instead of yours — that cost an hour once already.

## Gotchas that cost real time

- **The rebrand split nine contracts**, renaming one side and not the other: the AOS schema
  id, the catalog format string, `HERMES_OPENMAUS_*`, the team-library URL, the update feed
  owner, the SBOM property, the DEB maintainer, a sha256 fixture, `runOn: maus`. **Assume a
  tenth.** Sweep for identifiers another process reads, separately from cosmetic renaming.
- **Chromium honours EITHER `scrollbar-width` OR `::-webkit-scrollbar`, never both.**
- **`win.publisherName` does not exist in electron-builder 26** — it lives inside
  `azureSignOptions`, and a stray one fails the config for every platform.
- **Validate `electron-builder.yml` against `app-builder-lib/scheme.json` locally.** A CI
  round trip to learn one field name is 8 minutes.
- Dev Electron is `com.github.Electron`, unsigned — macOS cannot attribute permissions to
  "Murage" until it is the packaged signed app.
- A v2 team manifest **deliberately** creates no room. Bot packages do. Use packages.
