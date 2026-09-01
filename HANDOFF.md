# Murage — session handoff

**Written:** 2026-09-01 · **Repo:** `github.com/FerroxLabs/murage` (private) · **Local:** `/Volumes/Mando/WaylandBots/murage-app`

## What this is

Murage is Ferrox Labs' multi-engine AI agent desktop app. It is a hard fork of
[OpenMausBot](https://github.com/milind-soni/OpenMausBot) (Apache-2.0) at commit
`6140532`, rebranded and being migrated onto the Wayland stack.

**Naming, all settled and registry-locked:**

| Thing | Name | Notes |
|---|---|---|
| The app | **Murage** | 村下, the furnace master who directs a tatara smelt |
| The engine | **Fuigo** | 鞴, the bellows. Fork of `xai-org/grok-build` (Apache-2.0), done in a separate session |
| An agent | **Ember** | Matches the Forge Suite spec's existing "lightweight agent" definition |
| The default agent | **Ember**, orange | First bot on a fresh start; removed from the random name pool |
| The palette | **Hearth** | From `/Volumes/Mando/Brand/forge-suite-brand-spec.html` |

**Hearth Palette:** `--forge-orange #ff6b35` · hover `#ff8255` · muted `#cc5529` ·
light `#ffb399` · bg `#0d0d0d` · surface `#141414` · elevated `#1a1a1a` · border `#333`.
Ember's gradient is `#FFB399 → #FF6B35 → #CC5529`.

**Owned:** murage.ai / .io / .dev · crates.io `murage` + `fuigo` · PyPI `murage` +
`fuigo` · npm `@murageai/core` + `fuigo`. Note npm `murage` unscoped is
permanently blocked (typosquat guard vs `merge`) and `@murage` belongs to someone
else — **`@murageai` is our scope**.

## Namespace

```
murage    MURAGE_      ~/.murage          the app
muragebox MURAGEBOX_   -                  the cloud-box surface (was OGB_)
fuigo     FUIGO_       ~/.fuigo           the engine
wcore     WAYLAND_     ~/.wayland-core    Wayland Core (do not collide)
```

## Done

- **Full rebrand.** `OpenMausBot`→Murage, `omb`/`OMB_`→`murage`/`MURAGE_`, `OGB_`→`MURAGEBOX_`, `Maus`/`SupaMaus`→Ember. Zero residue outside `third_party/`. Scripts `rebrand.sh` and `ember-rename.sh` are re-runnable with tokens as variables.
- **NOTICE** written for Apache-2.0 §4(d), crediting Milind Soni with a statement of changes.
- **Icons** generated from `brand/`: macOS `.icns` (10-size iconset), Windows `.ico` (7 res), `icon-1024`, electron app-icon, and an iOS icon that is RGB with no alpha (iOS rejects transparency).
- **Mascot** swapped from `CursorAvatar` (a cursor silhouette, visually derivative, no licence header) to `EmberAvatar` — same Blob Studio architecture on a fire silhouette, 38 states at full parity.
- **Composio broker cut over** to our own Cloudflare account. Live and verified end to end.
- **Sendlane signup** replaces the analytics-side-effect email list. Verified live against list 32.
- **README** rewritten from scratch in Sean's voice, leading with the OpenMausBot credit and the Wayland heritage.

## Live infrastructure

| | |
|---|---|
| Composio broker | `https://murage-composio.patient-meadow-1a11.workers.dev` — `/health` returns `ready:true` |
| Cloudflare account | `b83123326a4b9ad76831b9cb9365b33b` (admin@imsuccesscenter.com) — **not a Ferrox account**, flagged, unmoved |
| D1 | `murage-composio`, `7386c046-7c54-4301-b5e0-584dd9306a8e`, region APAC |
| Sendlane | list **32**, tags `murage,app-onboarding`. Credentials in `~/.murage/config.json` (0600) |
| Cost | **$0/mo** — Cloudflare and Composio both on free tiers |

**Composio cost trap:** `REGISTRATION_MODE: "open"` lets any install spend our
quota at **$4 per 1,000 tool calls** (post-2026-08-15 pricing, we are not
grandfathered). Free tier covers ~200 users. Kill switch, no redeploy:
`wrangler deploy --var REGISTRATION_MODE:closed`. **Gate registration and add a
per-install call ceiling before any public launch** — the `installations` table
has the row to hang a counter on.

## Upstream leaks found and closed

Three, all the same shape — infrastructure that looked like ours and was not.
**Assume there is a fourth and keep sweeping.**

1. **Composio broker** defaulted to `openmausbot-composio.milindsoni201.workers.dev`. Their worker, their key, their bill.
2. **Polar payment links** live in the README — a working checkout paying upstream.
3. **PostHog token** `phc_m2hP39…` hardcoded in `src/lib/analytics.ts`. `identifyEmail()` sent every signup address to upstream's project; their own comment called the Persons tab their email list. Now `VITE_POSTHOG_KEY` with **no default**, so an unconfigured build opens no connection.

## Open

1. **Flux Router integration** — plan at `docs/plans/flux-router-integration.md`, cross-audited by Kimi. The big one.
2. **Real screenshots** — README has three marked placeholders. App runs; needs a session past onboarding.
3. **Swift file renames** — `ios/App/MausAvatar.swift`, `ios/AppShared/OpenMausShared*.swift` still carry old names. Deferred because Xcode references sources by path in `project.pbxproj`; rename and update the project file in one commit.
4. **Mascot provenance** — Blob Studio has no published licence terms; one email would settle commercial use. The silhouette is SVGRepo's fire, not our logo's flame. Regenerating from our own vector would be strictly better branding, and needs the vector source (only PNGs exist).
5. **Credential rotation** — the Cloudflare API token, the PyPI token and the Sendlane key were all pasted into a chat transcript. Rotate.
6. **Contrast check** — icon tile sampled `#100F15`, Hearth bg is `#0d0d0d`. Close but not equal; reconcile.

## Running it

```bash
nvm use 24                        # repo requires >=24; pnpm 10.33 already correct
pnpm install
MURAGE_PORT=8911 pnpm dev:server  # API
MURAGE_PORT=8911 pnpm dev         # UI on :5199, proxies /api
```

**Port note:** the installed OpenMausBot.app holds 8799/8800, and a stray Python
server has been seen on 8899. Use `MURAGE_PORT` to dodge both.

## Gotchas that cost real time

- **BSD `sed` has no `\b`.** All 108 identifier rules silently no-oped on the first rebrand run. Use `perl`.
- **`file -b package.json` returns "JSON data"**, no "text" — a `file | grep -q text` filter skips every JSON file, including the one holding app identity. Use `grep -Iq .`.
- **Renaming rewrites import paths but not filenames.** The server died on `ERR_MODULE_NOT_FOUND` until five files were `git mv`'d to match.
- **`OGB_` and `OMB_` are distinct namespaces** that both wanted `MURAGE_`. `OGB_PORT` and `OMB_PORT` coexist; merging them would have been silent and wrong.
- **React drops unknown props silently.** `CursorAvatar` took `silhouette`; the Ember pack takes `shape`. Passing the old name meant every bot rendered black, with no error.
- **`paused` in the Ember pack meant "no face", not "still face"** — its step function returned before `draw()`. Nine call sites were silently faceless. Fixed in the pack.
- **Static checks did not catch any of the four mascot bugs.** Only running the app did.
- **Shallow clones cannot be pushed to a new remote.** `git fetch --unshallow` first.

## Working agreement

Verify before recommending — check the code or live state, then lead with a pick.
Every naming decision in this session was collision-checked against npm,
crates.io, PyPI and live companies before being proposed. Tatara was killed that
way after it turned out to be a YC-backed AI company.
