# RINGS: staged desktop rollout and memory kill switches (DESIGN + BUILD PLAN, no product code)

Owners (first lines, OWNERSHIP rule):
- Desktop client side (ring choice, signed ring manifest reader, kill-switch reader and enforcement): the rings BUILD lane MAIN seats from this plan (until seated: OPEN, owner MAIN).
- Ring manifest publisher (rings workflow, signing, advance/halt/pin): the same BUILD lane writes it; MAIN alone runs it.
- Release workflow publish step (prerelease on day 0, latest on day 2): the same BUILD lane; MAIN runs it.
- Cloud homes (cloudflare/control-plane/src/rollout.ts waves and kill flags on hosted homes): MurageCloud (CP JSON FREEZE: CP changes only through MurageCloud lanes). Contract in section 9.
- Ring advance decisions and halts: MAIN. Gate evidence (bannergate on Sean's copy, Mac and Beast installs): MAIN.

Ruling this implements: MAIN-RULING 2026-11-26T19:51:51Z (2) STAGED ROLLOUT, SEAN YES. Base read: rel/1023-next ea1834ee03.

## 1. PURPOSE and USER PROMISES

PURPOSE: a bad desktop release reaches Sean's own machines first and a few volunteers second, never everyone at once, and a bad memory or recall feature can be turned off on every install without shipping a new build.

USER PROMISES
- P1 Day 0: a new version installs only on Sean's Mac and the owner's Windows PC (ring `internal`).
- P2 Day 1 at the earliest: it reaches people who turned on Settings > Updates > "Get updates early" (ring `beta`, about 10% by self-selection).
- P3 Day 2 at the earliest: it reaches everyone (ring `all`), including installs too old to know about rings.
- P4 MAIN can halt any ring at any time. A halted ring offers nothing newer; nobody gets an update MAIN has halted, including a download that is waiting to install, once the halt is visible on GitHub raw (the K6 CDN bound, <= 5 min after the halt is pushed; MAIN waits that long before announcing a halt done). An install that has already seen the halt manifest never installs the halted version, whatever a later refetch returns (R8 max-seq rule).
- P5 MAIN can turn a memory/recall feature off on every install (or a version range) from the feed, without a release. Turning it off never deletes data; turning it back on restores it as it was.
- P6 No tracking. Nothing in the update or flag path sends an id, a ring, a toggle state or usage. Every install fetches the same public files.
- P7 Everything a client acts on is signed. A forged, stale or replayed file can never push a version a ring was not given, and can never turn a killed feature back on for an install that has seen the kill. An install that has not yet seen a kill (offline, or a brand-new profile that fetched a cached copy) learns it within the K6 latency, exactly like every other install.
- P8 Rollback never breaks a store: no automatic downgrade; "rollback" means pin rings to the previous version, kill the bad feature, fix forward.
- P9 macOS (arm64, x64), Windows (NSIS), Linux (AppImage, deb hand-off) all follow the same rings.

## 2. What exists today (read on ea1834ee03)

- `.github/workflows/release.yml`: one commit -> signed mac (notarized, stapled), Windows (Azure Trusted Signing), Ubuntu (deb, AppImage, `SHA256SUMS-ubuntu-x64.txt` + `.asc` signed in CI with `GPG_PRIVATE_KEY`, :1410-1435) -> `stage` verifies every feed hash (:1600-1644) -> `assemble` creates a DRAFT on `FerroxLabs/murage-releases` -> optional publish: `scripts/release-guard.mjs:211` sets `draft=false, make_latest=true`. Only `assemble` may use `RELEASES_PAT` (docs/releasing.md:65).
- Feed: `app-update.yml` baked in every build, `owner: FerroxLabs, repo: murage-releases` (release-guard `update-feed` asserts it on all three OSes). `electron-builder.yml:13` `publish: null`.
- Client: `electron/updater.mjs` (vendored electron-updater, `autoDownload=false`, `autoInstallOnAppQuit=false`, checks 15 s after launch and hourly, :154-157). GitHub provider with `allowPrerelease=false` asks `/releases/latest` (`electron/vendor/electron-updater.cjs:12608,12669-12676`), so **a GitHub prerelease is invisible to every shipped client.** `updater-fallback.mjs` switches to a generic provider at `releases/download/<tag>` when GitHub says "No published versions"; it already refuses drafts and prereleases.
- Verification: Linux checks a signed SHA256SUMS (`update-signature.mjs:290-330`, one pinned Ed25519 key `electron/release-key.asc`, test key refused by `scripts/check-release-key.mjs`); mac/Windows check the version the signed build carries is the version offered and newer (`update-build-version.mjs`), Windows WinVerifyTrust (`windows-update-signature.mjs`). `latest*.yml` are unsigned.
- Downgrade: electron-updater `allowDowngrade=false`; `update-build-version` refuses not-newer; memory store refuses an older app (`server/memory/schema.ts:2175-2178`, MEMORY_SCHEMA_NEWER).
- Docs changelog already hides prereleases (`apps/docs/components/release-changelog.tsx:96`). README download buttons use `/releases/latest/download/...`, so they stay on the previous version until day 2.
- Cloud: `cloudflare/control-plane/src/rollout.ts` waves 0 internal homes, 1 = 3 homes, 2 = 25%, 3 = rest; 2 h soak (`ROLLOUT_SOAK_MS`), auto-halt on rollback/stuck/silent homes, `resume`, `cancel`. Hosted homes report health; desktop installs do not and must not (P6).
- Real-data upgrade gate: `_small/bannergate.sh` on a copy of Sean's store (MAIN-RULING 12:54Z: resume-active run is THE gate; REVIEW-POLICY-1126 makes it required every release).

## 3. Design in one paragraph

Ship the same tag and the same bytes to every ring; only *who is told about it* changes. Day 0 the release is published on GitHub as a **prerelease** (not latest): no shipped client and no README button can see it. A small **signed ring manifest** (`rings.json` + `rings.json.asc`, signed with the existing release key) names, per ring, the version that ring may install, plus kill flags. Ring-aware clients read it, pick the highest version their rings allow, and point electron-updater's generic provider at that tag's folder (the same move `updater-fallback.mjs` makes today). Day 2, MAIN flips the release to latest, which also carries every pre-ring client. Halts and pins are new manifests; kill flags ride in the same manifest.

## 4. The ring manifest

Location: branch `rings` of the public `FerroxLabs/murage-releases` repo, files `rings/rings.json` and `rings/rings.json.asc`, read anonymously from `https://raw.githubusercontent.com/FerroxLabs/murage-releases/rings/rings/rings.json` (and `.asc`). Not a GitHub release: a fake release would surface in `/releases`, the changelog and the fallback lookup.

```json
{ "schema": 1, "seq": 42, "issuedAt": "2026-11-28T10:00:00Z", "expiresAt": "2026-12-01T10:00:00Z",
  "rings": {
    "internal": { "version": "1.0.25", "since": "2026-11-28T10:00:00Z" },
    "beta":     { "version": "1.0.24", "since": "2026-11-27T10:00:00Z", "halted": false },
    "all":      { "version": "1.0.24", "since": "2026-11-26T10:00:00Z", "halted": false } },
  "kill": [ { "id": "memory.recall.inject", "versions": ">=1.0.25 <1.0.26", "code": "kill-safety" } ] }
```

Rules (client):
- R1 Verify `rings.json.asc` over the exact bytes with `verifyDetachedSignature` and the pinned key (`update-signature.mjs:171`). Max 64 KiB, `credentials: "omit"`, `redirect: "manual"`, 15 s timeout (same fetch rules as `fetchBytes`). Strict schema; unknown top-level keys refuse the file.
- R2 Monotonic: accept only `seq` > cached seq (equal = no-op) AND `seq` >= the build floor: every packaged build carries `rings-floor.json` = the `seq` live when it was built (release.yml writes it; release-guard asserts it is present on all OSes). The last accepted manifest is cached in `<userData>/rings-cache.json` (bytes + signature, re-verified on every read, atomic write). A fresh profile therefore never accepts a manifest older than its own build.
- R3 Expiry: `expiresAt` = issue + 72 h and the publisher re-signs daily (`seq+1`, content unchanged, cron in release.yml), so the replay window for any older signed manifest is at most 72 h even for a fresh profile. Past `expiresAt` the **ring targets** are ignored (client behaves as ring `all` with today's `/releases/latest` path); the **kill list stays in force** (fail closed). A kill is never removed from the manifest while a version it covers is still the target of any ring; it ends by its `versions` range excluding the fixed version, so an older manifest replayed inside the window still carries it once the kill is older than 72 h.
- R4 Membership is nested: internal ⊇ beta ⊇ all. Target = max(version of each ring the client belongs to and that is not halted). A halted ring contributes only its pinned `version` (halt pins it to the previous version, section 6), so a halted ring never offers anything newer than what it had before the bad release.
- R5 Target <= running version: no update offered (never a downgrade; `allowDowngrade` stays false).
- R6 Target > running: `setFeedURL({provider:"generic", url: releases/download/v<target>})`, then the unchanged path: latest*.yml, sha512, Linux signed SUMS, mac/Win build-version check, WinVerifyTrust. BINDING: the coordinator offers the update only if the feed's `updateInfo.version` EQUALS the signed manifest target (checked on `update-available`, before any download), and install admission (R8) checks the staged candidate's version equals it again. The unsigned feed under an allowed tag can never offer a different version, even a genuinely signed newer one. Every check starts by resetting the provider to github (as `updater-fallback.mjs` `reset()` does), so a stale ring URL never outlives its check; the ring step runs before, and replaces, the No-published-versions fallback.
- R7 No manifest ever accepted (fresh install, offline, GitHub raw down, bad signature): behave exactly as today (github provider, `/releases/latest` = ring `all`). A ring-aware client is never worse than a pre-ring client.
- R8 Install-time recheck, FAIL CLOSED, one admission point for every install path: `install()` (restart), `resumeInstall()` (backup continuation, `electron/preupgrade-continuation.mjs:24`, `updater-coordinator.mjs:496-549`), the deb hand-off and the mac installer-fallback offer (`updater.mjs:149-152`) all pass `admitRingInstall(candidate)` before anything runs. It refetches the manifest (10 s) and decides on the HIGHEST-seq verified manifest among the refetch and the cache (R2): a refetch served stale by the CDN (lower seq than a halt this client already accepted) can never outrank the halt. It admits only when that manifest was verified in the last 10 minutes (the refetch itself, or the refetch returned an equal seq) and names this exact version as a target this client may install. Stale-success remainder: a client that never saw the halt and whose refetch lands inside the <= 5 min CDN window still installs; P4 states this bound. Halted or not named: the staged download is discarded and the banner says "This update was paused. You'll get the next one automatically." Refetch failure: nothing installs, the download stays staged, the banner says "Couldn't confirm this update. Murage will try again." and the hourly check retries (offline people install once they are back online). Legacy-path candidates (no manifest ever accepted, OR the accepted manifest has expired (R3/F9), offered through GitHub `/releases/latest` per R7 or through the api.github.com no-published-versions fallback, `updater-fallback.mjs:12`) are admitted only when a fresh latest-tag lookup through the SAME host the update came from (the provider's own `github.com/FerroxLabs/murage-releases/releases/latest` request, `getLatestTagName`, electron-updater.cjs:12669-12676, not `api.github.com`) still names exactly the staged version; if MAIN has run `pin-latest` the staged download is discarded with the paused banner, and if the lookup fails nothing installs and the hourly check retries. A client that reaches github.com but never raw.githubusercontent.com is therefore never stuck, and never installs a pinned-back release. Host rule: the admission asks github.com first and, only if that request fails, the same api.github.com lookup the no-published-versions fallback uses (a client whose github.com latest request fails is exactly the one the fallback served, so github.com-only would strand it); both answer "which release is latest now", so a pin-latest is seen through either; both failing = nothing installs. A ring-aware client with an UNEXPIRED accepted manifest whose refetch fails stays fail-closed ("Couldn't confirm"), because its ring target may be a D0/D1 version GitHub latest does not vouch for. The SITES list for B3 is the grep `resumeInstall\|quitAndInstall\|handOffInstall\|showInstallerOffer` over electron/.
- R9 One fetch per check: the manifest is fetched in the same hourly/launch/manual check as the update (`updater.mjs:154-157`, `update:check` IPC :118). No extra timers, no extra hosts beyond raw.githubusercontent.com.

Ring membership (all local, never sent):
- `internal`: a file `<userData>/update-ring.json` `{"ring":"internal"}` that MAIN places by hand on Sean's Mac and the owner's Windows PC (runbook in docs/releasing.md). No UI, no key; reading a local file grants nothing but earlier updates of signed builds.
- `beta`: Settings > Updates toggle "Get updates early", default off, stored in the desktop settings file. Copy: "Get new versions a day before everyone else. Murage doesn't track who turns this on." Turning it off keeps the current version (no downgrade); the next `all` version that is newer arrives as normal.
- `all`: everyone else, and every pre-ring install.

## 5. Calendar and gates (Sean's Mac gate, canaries)

Day boundaries are enforced by the publisher (workflow), never by client clocks.

| Step | Who | Action | Gate the workflow checks |
|---|---|---|---|
| D0 publish | MAIN | `release.yml` publish (always `draft=false, prerelease=true, make_latest=false`, B6); the same `assemble` job then signs and writes the manifest with `internal.version = v` | the draft digest gate runs before publish exactly as today (`verify-digests` on the draft); after publish a new read-only `verify-published` (no `assertDraft`) re-checks the 3 feeds + digests on the published prerelease before the manifest is signed |
| D0 canary | Sean's Mac + the owner's Windows PC | install through the normal Update button (real signed install on macOS arm64 and Windows); bannergate on Sean's store copy (`bannergate.sh <sha>`, resume-active) | MAIN posts `BANNERGATE <sha> PASS`, `RING0-MAC <v> PASS`, `RING0-WIN <v> PASS` on the board |
| D1 advance | MAIN | `release.yml` dispatch `ring-op=advance-beta version=v` | `internal.version == v` (the cached manifest's internal ring names exactly v) AND a later UTC calendar date than `internal.since` AND >= 20 h after it; the three PASS receipt lines named as inputs must each contain v (a MAIN attestation: the workflow checks the strings name v, it cannot verify the board); ring not halted |
| D1 canary | beta volunteers | normal updates; problems arrive through the existing in-app feedback / GitHub issues only | none automatic (no telemetry, P6) |
| D2 advance | MAIN | `release.yml` dispatch `ring-op=promote-all version=v`: flips the GitHub release to `prerelease=false, make_latest=true`, verifies `releases/latest` = v, then sets `all.version` | `beta.version == v` (so `beta.since` is v's beta day, never an older version's) AND a later UTC calendar date than `beta.since` AND >= 20 h; no open halt. The bootstrap (below) is the one exemption, by its SEAN YES line. Partial failure: flip done but manifest write failed -> the run fails red, MAIN re-runs it (idempotent: each half checks its own state first); legacy clients already get v, ring-aware `all` clients get it on the re-run |

Both a later calendar date and 20 h are required, so "day 1" can never be the same date as day 0 and a release cut at the same hour each day is not pushed a day later by a few minutes; days are earliest dates, never automatic. Linux and Intel Mac have no ring-0 machine: their day-0 evidence is the existing CI gates (Linux `smoke:linux-update --candidate-feed` release.yml:1392, native Intel smoke job :425). That is parked for Sean (GAP-CHECK P-1).

PUBLISHER HOME: every ring operation (publish-internal, advance-beta, promote-all, halt, resume, pin-latest, kill, resign) is a `ring-op` input of `release.yml` and runs inside its `assemble` job, the only job allowed `RELEASES_PAT` (docs/releasing.md:63-66). The manifest is written to the `rings` branch of murage-releases by that job. No second workflow and no second token.

BOOTSTRAP: the first ring-aware version cannot have a beta ring: no install can hold the "Get updates early" setting before a build that has the toggle exists. To keep that one exemption as small as possible, the bootstrap release is RINGS-ONLY: the previous release's tag plus the B1-B8 code and nothing else (no feature, fix or migration rides it). D0: published as prerelease (invisible to every shipped client); MAIN installs it on Sean's Mac and the owner's Windows PC by hand from the prerelease's installer, places `update-ring.json`, runs the bannergate. D1: nothing (no beta installs exist). D2: `promote-all` refuses the bootstrap version unless its input names a board line `MAIN-RULING ... SEAN YES rings bootstrap <v>` (the one-time exemption is Sean's call, not the workflow's). Rings act fully from the next release.

Hotfixes follow the same calendar (Sean: "every release"). Shortening it for a hotfix is a Sean decision per release, recorded on the board; the workflow takes `--sean-waiver <board line>` and prints it in the summary.

## 6. Halt, pin previous, rollback

- `ring-op=halt ring=<r>`: sets `halted: true` on that ring AND every wider ring (halting beta also halts all), and pins each halted ring's `version` to the newest version that ring already had before this release (the "previous"). New `seq`, signed, pushed. Clients that have not installed get nothing new; R8 discards staged downloads.
- If `all` had already been advanced (GitHub latest flipped), halt-all also flips GitHub back: the bad release -> `prerelease=true`, the previous release -> `make_latest=true` (`release-guard` gains a `pin-latest <tag>` entrypoint). Pre-ring clients then stop being offered it too.
- `ring-op=resume ring=<r>`: clears `halted`; does not advance.
- Installs already on the bad version: no automatic downgrade (P8; memory schema refuses older apps, schema.ts:2175). Remedy = kill flags (section 7) now, fix-forward release through D0 next. A manual reinstall of the previous installer is documented only for releases whose manifest entry says `memorySchema` unchanged (the advance step records `memorySchema` = `MEMORY_SCHEMA_VERSION` of that tag).

## 7. Kill switches for memory and recall

- K1 Same signed manifest, `kill[]`. Entry = `{id, versions (semver range), code}`. `id` from a fixed registry in `shared/kill-switch-ids.mjs`; unknown ids are ignored (an old client never misreads a new id). `code` is a fixed code (`kill-safety`, `kill-data`, `kill-perf`), never free text (AUDIT FREE TEXT rule).
- K2 Flags can only turn OFF. Absence = the feature's normal setting. A manifest cannot turn on anything the owner turned off.
- K3 Electron main writes the verified, version-filtered kill set to `<dataDir>/kill-switches.json` (atomic, with the manifest `seq`). The server reads it at start and re-stats it at each **turn boundary** (never mid-turn: a cross-turn memory state change mid-turn is the class the memory lanes keep hitting). Lost or corrupt file: server keeps the last set it read in this process; at start with no file = no kills (and electron rewrites it from the cache before spawning the server).
- K4 Kill = the feature behaves as its owner-off path already does (memory-off and recall-skip paths exist and are tested); never deletes data, never rewrites stores, never adds an approval prompt (No-limits rule). Settings > Memory shows one quiet line on a killed feature: "Paused by Murage while we fix a problem. Your memories are safe." No banner, no modal.
- K5 Initial id set (final list = SITES.md of B4): `memory.recall.inject` (recall context into turns), `memory.prewarm` (warm pool prewarm; must keep MAIN-RULING warm-active-only), `memory.capture` (new memory writes; reads stay), `memory.embed.local` (local embedding model; falls back to the existing non-model path), `memory.rebuild` (background view/rebuild builds; respects MAIN-RULING local-memory-budget pace, kill = no new builds).
- K6 Latency: next check (<= 1 h, or at launch, or "Check for updates") + GitHub raw cache (<= 5 min). Documented, not promised faster. A kill once seen is never undone by an older or stale manifest (R2 seq, R3 kills survive expiry); a profile that has not seen it yet (new or offline) is covered by the same latency, because its next check reads the current manifest.
- K7 Kill applies to every ring and to Cloud only through the section 9 contract.

## 8. Platforms

- macOS arm64/x64: generic provider at the ring tag reads `latest-mac.yml`; Squirrel.Mac still refuses a bundle failing the running app's signature requirement; `update-build-version` unchanged. installer-fallback offers (`updater.mjs:149-152`) pass through R8.
- Windows NSIS: generic provider reads `latest.yml`; WinVerifyTrust (`windows-update-signature.mjs`) unchanged.
- Linux AppImage: `latest-linux.yml`, signed SUMS checked at `releases/download/v<target>/` (already tag-relative, update-signature.mjs:304). deb: hand-off path downloads the same way, so the ring decides before download; R8 runs before the package-manager hand-off.
- Signed feeds: only the manifest is newly signed; `latest*.yml` stay unsigned exactly as today because every platform checks the downloaded bytes against something signed (comment at updater.mjs:205-206). The manifest key is the existing release key; `check-release-key.mjs` already refuses the test key.

## 9. Cloud (contract; Cloud side owner MurageCloud, desktop side owner rings BUILD lane)

Cloud homes update through rollout.ts waves, not electron-updater, and the controller ADVANCES WAVES BY ITSELF after each soak (`rollout.ts:37-38,238-254`; an empty or all-skipped wave crosses at once), so no soak setting can hold Cloud to a desktop milestone. Contract: (a) MAIN starts a Cloud release (`POST /v1/admin/rollout/releases/<id>/start`) only after the desktop `promote-all` for the same version has completed (D2 or later), never earlier; Cloud waves 0-3 then run after desktop `all`, so no hosted customer gets a version before every desktop ring has had it. MAIN halts the Cloud release (existing halt/cancel) together with any desktop halt. A Cloud hold-at-wave control that would let Cloud wave 0 start on D0 is MurageCloud's choice (Parked P-7). (b) Cloud homes honour the same kill ids: MurageCloud reads the signed manifest server-side or mirrors `kill[]` into its own config; until MurageCloud seats it, kill switches do not reach hosted homes (written as OPEN in last.txt). Desktop never calls CP for rings (P6).

## 10. Failure paths (each has a defined outcome)

| # | Failure | Outcome |
|---|---|---|
| F1 | Offline / raw.githubusercontent down / timeout | checks: cached manifest if not expired, else today's path (ring all), silent, one log line. Install: nothing installs until a fresh manifest admits it (R8). |
| F2 | Bad signature, oversize, bad schema | ignored, cache kept, one log line `rings: refused <reason>`; no banner. |
| F3 | Replayed older manifest (seq lower) | ignored (R2). |
| F4 | Expired manifest, nothing newer | ring targets dropped (ring all), kill list kept (R3). |
| F5 | Manifest names a tag that is still a draft or lacks a feed | advance refuses to sign it (gate checks published assets); if it still happens, updater error stays quiet as today. |
| F6 | Release published as prerelease but `advance internal` fails | nobody gets it (prerelease invisible to old clients, rings never named it). Safe. |
| F7 | Halt while a download is staged | R8 discards it before install. |
| F8 | Halt after install | no downgrade; kill flags + fix-forward (section 6). |
| F9 | Signing key secret missing / ring-op fails | no new manifest; rings stay where they were (fail closed, no advance). If the daily resign keeps failing, manifests expire after 72 h: ring-aware clients fall back to ring all (GitHub latest), kills kept; MAIN sees the red scheduled run. |
| F10 | Client clock wrong | calendar is publisher-side; a clock far ahead only expires the manifest early -> ring all; kills kept. |
| F11 | Kill file unreadable mid-session | server keeps last set it read (K3). |
| F12 | Owner toggles beta off on a beta build | stays on it; next newer `all` arrives normally. |
| F13 | Pre-ring client (<= first ring-aware version - 1) | sees only GitHub latest = ring all; it gets the version on D2, never earlier. |
| F14 | GitHub UI publish by hand (skips the guard) | docs/releasing.md says: never publish from the UI; the release workflow's `publish` always makes a prerelease (B6), and only `ring-op=promote-all` with its gates makes a release latest. A hand UI publish as latest is the old behaviour and is the one path this design cannot block; it is called out in the runbook. |

## 11. BUILD PLAN (no product code in this lane)

Each step: files, witness through the production entry point (P2), RED on base ea1834ee03 by behaviour.

- B1 `shared/rings-manifest.mjs`: parse + verify (R1-R4), pure. Unit rows (signed fixtures made with the TEST key in test code only; packaged builds pin `release-key.asc`) cover parsing edges. The behavioural witnesses for R1-R4 are B2 rows (bad signature, replay below cache, replay below build floor, expired with kill kept, halted ring) driven through `update:check`; base is RED on every one of them only where base behaviour differs (bad-sig row: base offers GitHub latest = an older stable, the row asserts the prerelease target is not offered AND kills from cache hold; the floor and halted rows use a fixture where GitHub latest is the halted version).
- B2 `electron/updater.mjs` + `updater-coordinator.mjs` ring step before check, R5-R7, R9 and the R6 binding. Witness drives the registered `update:check` IPC with the REAL vendored provider (not the stubbed `startUpdater` extraction in `updater-staging.node-test.mjs:10-30`) against a local fixture HTTP origin serving releases Atom, `/releases/latest`, the stable feed, the prerelease feed and the manifest. Rows: (a) internal-marked client is offered the version only `internal` names (base: never offered, RED at the offer assertion); (b) no marker, beta off: NOT offered; (c) beta on: offered `beta.version` where beta != latest (base RED: base offers latest); (d) feed under the allowed tag names a different version than the manifest: NOT offered (base RED: base offers it). Mutants: ignore membership, ignore halted, drop the R6 equality.
- B3 R8 admission in every install path. Table-driven over the SITES grep (R8): rows `update:install` restart, backup `resumeInstall` continuation, deb hand-off, mac installer-fallback offer; each with (i) manifest halts after staging, (ii) refetch fails, (v) stale-success: the client accepted the halt manifest (seq n+1) at a check, then the install refetch returns the older pre-halt manifest (seq n) -> no install; (vi) expired accepted manifest + github.com latest still names the staged version -> installs. Plus legacy rows: (iii) no manifest ever accepted, staged = latest, then `pin-latest` moves latest back -> no install; (iv) same, latest unchanged and api.github.com unreachable -> installs (the admission uses only github.com). Base RED: base reaches `quitAndInstall` / hand-off / offer in each row (no-install assertion).
- B4 Kill switches: `shared/kill-switch-ids.mjs`, electron writer, server reader at turn boundary, one enforcement site per id. SITES.md (P1) from `grep -n` of each feature's entry point. Witness per id through a booted server turn (HTTP route): each row first proves on the same fixture without a kill file that the turn DOES trigger the feature (precondition assertion, so suppression can't pass vacuously), then with `kill-switches.json` the feature does not run, data untouched, next turn after the file clears runs it. Plus one end-to-end row: signed manifest served to electron main -> file written -> next server turn suppressed. Base RED: base ignores the file. Memory-state lane: mutants with receipts and a second reviewer required (REVIEW-POLICY-1126).
- B5 Settings > Updates "Get updates early" toggle + Settings > Memory paused line; UX copy reviewed (shipped-string review record, release.yml:152). Witness: toggling persists across restart and changes the next `update:check` ring (row (c) of B2 driven from the Settings IPC); the paused line renders when the kill file names a feature. Base RED: no toggle setting exists, so the B2(c) row via Settings stays on latest.
- B6 `release-guard.mjs`: `publish` ALWAYS publishes as `draft=false, prerelease=true, make_latest=false` (there is no `--ring all` publish and no workflow input that makes a new release latest; latest is reachable only through `ring promote` with the D2 gates, B7), `pin-latest <tag>`; `verifyReleaseTag` (release-guard.mjs:236-249) today throws unless a published release IS `releases/latest`, so it learns the ring: a prerelease must NOT be latest, a promoted release must be. The capability-db diff baseline (release.yml:1580-1584, `releases/latest`) switches to the newest published release including prereleases, or an overlapping N+1 cut during N's D0-D2 diffs against N-1. Witness: guard unit with recorded `gh api` calls; base RED: base sends `make_latest=true` and `verifyReleaseTag` throws on a published prerelease. `pin-latest` row: the bad release goes prerelease and the previous becomes latest (new-code row; base has no command, Medium).
- B7 `ring-op` input in `.github/workflows/release.yml` `assemble` job + `scripts/release-guard.mjs` entrypoints `ring advance|promote|halt|resume|kill|resign` (transition rules of sections 5-6, calendar-date + 20 h floor, receipts input, `verify-published`), signing with `GPG_PRIVATE_KEY` + `verifyDetachedSignature`, writing the `rings` branch. Witness through the guard entrypoint with recorded `gh`/`git` calls (pattern `scripts/release-digests.node-test.mjs`): advance-beta same date refused, advance-beta with internal != v refused, promote-all with beta != v refused (beta.since belongs to an older version), halt beta pins all, promote-all partial failure re-run idempotent, resign keeps content. Base RED: base guard has no `ring` command and rejects the unknown entrypoint at its usage check, which is setup-level, so the behavioural base row is B6's publish payload; B7 rows are new-code rows with mutants (no state; Medium if any is missing per REVIEW-POLICY-1126).
- B8 docs/releasing.md runbook: placing `update-ring.json` on Sean's Mac and the owner's Windows PC, the D0/D1/D2 commands, halt, kill, recovery, bootstrap (section 5). Docs only; no executable witness.
- CI lists: every new test file in ci/gate-tests.txt. Gate per REVIEW-POLICY-1126: touched tests + signed install + bannergate + secret scan; full suite at RC.

## 12. GAP-CHECK (one adversarial pass, GAP-CHECK-BAR)

Fixed
- (a) purpose gap (round 2, OPUS + FABLE 0f6cc62488): promote-all on D0 passes at once because `beta.since` belongs to the older version beta still holds -> D1 requires `internal.version == v`, D2 requires `beta.version == v` (section 5 table) + two B7 rows.
- (d) safety (round 2, ASTRA 0f6cc62488): an install-time refetch served stale by the CDN after a halt admits the halted version -> R8 decides on the highest-seq manifest of refetch and cache, P4 states the <= 5 min bound for a client that never saw the halt, B3 row (v).
- (b) failure path (round 2, OPUS/FABLE M1): an accepted manifest that expires while resign is red would strand every ring-aware client (offered latest, never admitted) -> expired manifests take the legacy github.com admission, B3 row (vi).
- (a) purpose gap: pre-ring installs would ignore a rings file and install day 0 from GitHub latest -> day 0 publishes as prerelease, invisible to them (section 3, F13).
- (b) failure path: MAIN halts beta after a volunteer downloaded but before restart; the restart would install the halted build -> R8 install-time recheck.
- (d) safety: an attacker or stale CDN replays an old signed manifest to re-enable a killed recall feature -> monotonic seq (R2) and kills survive expiry (R3).
- (d) safety: "rollback" by downgrade on a store whose memory schema moved -> app refuses its own store (schema.ts:2175) -> no auto-downgrade, pin + kill + fix-forward (section 6).
- (b) failure path: MAIN publishes day 0 as a prerelease and the release workflow's own `verifyReleaseTag` (release-guard.mjs:245-247) fails the run because the release is not latest; or N+1 is cut during N's D0-D2 and its capability diff uses N-1 -> B6 makes both ring-aware.
- (b) failure path: halt after day 2 still leaves pre-ring clients on GitHub latest -> halt-all flips latest back (`pin-latest`).
- (c) rule conflict: a separate rings workflow/token mutating releases breaks the assemble-only rule (docs/releasing.md:63-66) -> every ring-op runs inside release.yml `assemble` (section 5 PUBLISHER HOME). (Astra 69faaab38c)
- (a) purpose gap: the first ring-aware release going straight to latest skips day 0 -> bootstrap via prerelease + hand install (section 5). (Astra)
- (c) rule conflict: 20 h after a late-night D0 could still be the same date -> calendar date AND 20 h. (Astra)
- (b) failure path: halt, then the install-time fetch times out and a cached pre-halt manifest admits the install; or the backup continuation `resumeInstall` bypasses `install()` -> R8 fail-closed single admission point over every install path. (Astra)
- (d) safety: the unsigned feed under an allowed tag names a different signed build than the manifest target -> R6 equality at offer and at admission. (Astra)
- (d) safety: a fresh profile accepts an older unexpired manifest without a kill -> build floor seq + 72 h expiry with daily resign + kills kept while their versions are live (R2, R3). (Astra)
- (a) purpose gap: D0 `verify-digests` asserts a draft and fails on the published prerelease -> draft gate before publish, new read-only `verify-published` after. (Astra)
- (a) purpose gap: Cloud waves self-advance after a soak (or at once for an empty wave) and would reach customers before desktop rings -> Cloud starts only after desktop promote-all (section 9). (Astra 69faaab38c + c655c2fb31)
- (c) rule conflict: `publish --ring all` could take a new draft straight to latest -> publish always prerelease; latest only via promote with gates (B6). (Astra c655c2fb31)
- (b) failure path: a legacy-path client stages latest, MAIN runs pin-latest, the restart installs it -> R8 legacy admission rechecks `/releases/latest`. (Astra c655c2fb31)
- (c) rule conflict: the bootstrap release has no beta day -> rings-only bootstrap and a Sean YES line required before its promote-all (section 5). (Astra c655c2fb31)
- (b) failure path: legacy admission through api.github.com strands a client that reaches only github.com -> admission uses the provider's own github.com latest-tag lookup. (Astra 8f8896e66b)
- (d) safety: a fresh profile fetching a stale pre-kill manifest -> stated as kill latency (K6, P7): never an un-kill for an install that saw the kill; a new profile learns it on its next check. (Astra c655c2fb31)
- (c) rule conflict: free-text kill reasons would show customers operator text -> fixed codes (K1).
- (c) rule conflict: kill switch adding a prompt or banner -> quiet Settings line only, no prompt (K4).
- (b) failure path: kill file flips mid-turn and splits a turn's memory state -> applied at turn boundaries only (K3).
- (c) privacy: per-ring manifests or a ring query parameter would let GitHub/us see who is beta -> one shared manifest, ring chosen locally (P6).
- (e) cheap: a rings GitHub release would show in /releases and the fallback lookup -> manifest on a branch, not a release (section 4).

Parked (for Sean)
- P-1 Linux and Intel Mac have no day-0 machine; day-0 evidence there is CI only. Add a Linux desktop to ring internal? (needs hardware or a seat).
- P-2 Hotfix calendar compression: per-release Sean waiver (supported by the workflow input), no standing rule written.
- P-3 Kill switches on hosted Cloud homes depend on MurageCloud (section 9 b).
- P-4 "About 10%" is self-selected and unmeasured by design; aggregate GitHub asset download counts are the only signal. Recruiting more volunteers is a product question.
- P-7 Cloud wave 0 on D0 needs a CP hold-at-wave control (rollout.ts has none); owner MurageCloud. Until then Cloud starts after desktop promote-all (section 9).
- P-6 A network attacker who can break GitHub's TLS could still replay a signed manifest inside the 72 h window to a fresh profile; out of the threat model (bar: no hardening against threats the design does not face).
- P-8 macOS Squirrel can install a natively staged update on an ordinary quit after R8 admitted and quitAndInstall stalled (updater.mjs:179-182, coordinator :98-115); rechecking a native stage is outside this design (FABLE M2).
- P-9 Signing in `assemble` puts the release signing key next to `RELEASES_PAT`, and the daily resign schedule must skip every build job (FABLE M5): the B7 builder states the job split in the workflow; no new secret.
- P-5 Signing the latest*.yml files themselves: not needed (bytes are checked against signed data on every OS); parked as hardening.

Rejected
- Client-side health reporting to drive automatic halts (Cloud-style): breaks P6.
- Percentage rollout by install-id hash: needs a stable id and is not what Sean approved (opt-in only).
