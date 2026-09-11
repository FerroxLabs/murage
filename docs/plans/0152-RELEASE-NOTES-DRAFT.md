# Murage 0.1.52 release notes draft (Q1-T4)

Status: **draft, written from the merged commits only.** Not a public
announcement and not a qualified installer. Regenerate the "What ships" section
after every further lane merge (see "How to refresh this draft" at the end).

- Shipped baseline: 0.1.51 at `acaee1dbfb5551ae41d5f0d24c6bf3a314e5a282`.
- Integration head this draft was written from: `88f274ff` on
  `release/v0.1.52` (K0 contracts and L18 media backend merged), plus this
  lane's version bump and locale acceptance.
- Version: `package.json` moves to `0.1.52` (the only surface
  `scripts/release-guard.mjs version` reads).
- Merged commits since 0.1.51 (`git log --no-merges acaee1db..release/v0.1.52`):
  `4f7e28c2`, `58750971`, `228d22c7`, `24824218`, `a87969b2`, plus Q1-T4's
  `7f8d8f29` and `0359d529`.
- Already shipped in 0.1.51, not a 0.1.52 change: `15c3cbd6` "fix(packaging):
  sign Windows recovery helper" is the parent of the `acaee1db` baseline
  (`git merge-base --is-ancestor 15c3cbd6 acaee1db` is true). It must not
  appear in the 0.1.52 notes.

Framing rule for the published notes: every entry says what the user gets
(added, enhanced, hardened, tightened). No entry is called a bug fix. Every
entry below is backed by a commit named in the ledger; nothing is inferred
from the plan.

---

## 1. Draft release body (for the murage-releases draft)

Paste-ready once the candidate is frozen. The headers below (Added /
Enhanced / Contracts defined / Quality) are the announcement framing Sean
uses; they are not the `.github/release.yml` categories (New features / Fixes
/ Documentation / Other changes), which GitHub applies to the auto-generated
PR list separately.

### Murage 0.1.52

This release lays the groundwork for the Files, media and editor work that
follows, tightens the concurrency proof so the release checks trust every
platform they run on, and brings all seven language packs up to a verified
state.

**Added**

- **Media assets, resolved and served safely.** Murage can now resolve an
  image, audio or video source from a conversation attachment, a saved Files
  version or a workspace file and hand it to the desktop as a short-lived,
  same-origin byte URL. The server identifies the media by its bytes, not its
  file name (PNG, JPEG, GIF and WebP with pixel limits; WAV, MP3, Ogg, M4A, MP4
  and WebM), pins the exact revision it saw, and streams byte ranges with
  seeking support. SVG, executables and damaged files are refused outright.
  Every URL expires after ten minutes, is bound to one asset and one revision,
  and dies with the process, so a restart revokes all of them. This is the
  service layer; the inline lightbox and players that use it are in flight
  and are not in this candidate.
- **A frozen shared contract for workspace files, output receipts and media.**
  `shared/workspace-files.ts`, `shared/output-publication.ts` and
  `shared/media-assets.ts` define the identity, revision and receipt shapes
  every upcoming Files, editor and image-reference feature will use, so those
  features ship against one contract instead of three private ones.
- **Files schema ready for produced outputs.** The artifacts store gains an
  idempotent `output_publications` table and nullable producer/publication
  columns. Existing installations upgrade in place with no data change.
- **Editor dependencies pinned.** Tiptap 3.31.3 (core, ProseMirror, React,
  starter kit, Markdown, tables, task lists, lists) is pinned exactly, so the
  Markdown editor work builds against one verified set.

**Enhanced**

- **Media streaming stays available under load.** Stream slots are reserved
  before a file is opened and released on every exit path, including a client
  that disconnects while the file is still opening. Eight abandoned seeks no
  longer leave the byte route answering "busy" for the rest of the session.
- **Range requests follow the spec.** Range units are case-insensitive with
  whitespace tolerated around `=`; multipart, malformed and unsatisfiable
  ranges answer 416; a changed file answers 409 and a removed one 410; an
  oversized body answers 413 rather than a generic 400.
- **Main-process trust helper.** `electron/main-trust.mjs` gives every
  privileged IPC handler one way to confirm the sender is the app's own top
  frame at the exact expected origin, failing closed. The handler sweep that
  uses it is in flight.
- **New routes carry an explicit authority each.** `/api/workspace-files/*`
  and `/api/media/resolve` (with every other `/api/media/*` path except
  `bytes`) require desktop proof and are listed in
  `DESKTOP_AUTHORITY_ROUTES`. `/api/media/bytes/<id>?cap=` is deliberately
  exempt from the desktop header, because `<img>`, `<audio>` and `<video>`
  cannot send it; it is authorized only by the short-lived capability the
  resolve step issued. `POST /api/internal/resolve-image-reference` is not a
  desktop route at all: it is reachable only by a bot's active internal
  `agents` capability, and the bot, thread and generation it acts for are
  taken from that claim, never from the request body. The companion and
  remote allowlists stay default-deny for all of them, and companion-marked
  requests are refused on every media route, capability or not.

**Contracts defined, not yet adopted**

Type-level only. Nothing in this candidate changes runtime behaviour for
these; they are listed so the runtime lanes ship against a frozen shape.

- **Close-confirmed stop contract.** `server/contracts.ts` defines
  `ProviderStopResult` (`closeConfirmed: true`, or `false` with a `timeout` /
  `stop-failed` reason) and an optional `awaitTurnTeardown` on engine drivers,
  so a driver can report that a stop actually closed the process instead of
  assuming a requested kill is a finished one. No driver reports it in this
  candidate and no caller acts on it yet; adoption lands with the runtime
  lanes (A2 / R1-T2).

**Quality**

- **All seven language packs verified.** German, Spanish, French, Hindi,
  Japanese, Brazilian Portuguese and Chinese are complete (145/145 strings) and
  every translation is now recorded against the exact English source it
  translates, so `pnpm i18n:check` is green and a future English change flags
  the stale translation instead of silently shipping it.
- **Concurrency proof runs the real scenario on every platform.** The
  two-bot host-control fixture now proves the supported behavior per platform
  (macOS mounts host control for Auto and explicit Local; Linux mounts a
  supervised Linux driver descriptor; Windows refuses explicit Local before the engine
  starts) instead of asserting the macOS case everywhere.

**Still open in this release**

- The customer engine incidents (`-32603` and exit `1073807364`) are not
  closed by anything in this candidate. Better diagnostics are planned in the
  runtime lanes; a matching trace is still required to call them resolved.
- Inline lightbox, audio/video players, workspace previews, the Markdown
  editor, seed-image references, additional image providers, cloud
  onboarding, hosted-service hardening and the upstream adaptations are in
  flight on their lanes and are **not** in this candidate. Add them here only
  when their merges land (section 3).

---

## 2. Announcement voice sketch (for the update post, once frozen)

Not final copy. It exists so the post is written from the same ledger as the
draft body. Rewrite from the merged list at freeze time; do not publish this
while section 3 has unmerged lanes with user-facing scope.

> 0.1.52 is the plumbing release.
>
> Not glamorous. But every media feature coming next (the lightbox, the
> players, seed images for generation) needs one thing underneath it: a way
> for Murage to hand the desktop a file it has actually checked, for ten
> minutes, and then take it back. That's in now. The server looks at the
> bytes, not the file name, pins the exact revision, and streams ranges so a
> long recording seeks instead of reloading. Restart the app and every URL it
> ever handed out is dead.
>
> Seven language packs are now verified against the English source line by
> line. If we change a sentence in English, the check catches the stale
> translation before it ships.
>
> The rest of the list is foundations: frozen contracts for Files and output
> receipts, editor dependencies pinned, the concurrency proof running the real
> scenario on Mac, Windows and Linux rather than the Mac case three times.
>
> It auto-updates. Open it and it's already there.

---

## 3. Merge ledger (drives sections 1 and 2)

Merged into `release/v0.1.52` when this draft was written (every row is a
commit returned by `git log --no-merges acaee1db..release/v0.1.52`, plus this
lane's own commits; nothing older than the `acaee1db` baseline belongs here):

| Lane / task | Commit | User-visible? | Draft entry |
|---|---|---|---|
| K0 contracts (U-02, U-03, U-04, A2, B6) | `4f7e28c2` | foundation | shared contracts, schema, trust helper, per-route authority (desktop proof / byte capability / internal agents capability), close-confirmed stop contract (type only) |
| F4-T0 Tiptap pins (U-05) | `58750971` | dependency | editor dependencies pinned |
| Q1-T1 (D5) | `228d22c7` | test only | concurrency proof per platform |
| L18 F5-T1 (M1, U-03, U-04, U-28) | `24824218` | service layer | media resolver and capability byte route |
| L18 fix round 1 | `a87969b2` | service layer | stream slots, RFC 9110 ranges, 413 |
| Q1-T4 | `7f8d8f29`, `0359d529` | version, i18n | 0.1.52, seven packs verified |

Not merged when this draft was written (report their absence; do not describe
their scope as shipped): L01, L02, L03, L04, L05, L06, L07, L08, L09, L10,
L11, L12, L13, L14, L15A, L15, L17, LFU, LQ3, L16, W_R1T4, W_S1T3, W_F4T6,
W_R3T2, W_F4T1, W_U0T1, W_F5T3, W_F5T4, W_F1T4, W_F4T5, W_F4T3, W_F4T7,
W_F5T5, W_U1.

Expected entries once they merge, by lane (write them from the merged
commit bodies, not from this list): R1 runtime correctness and diagnostics
(L01, L02, L03, W_R1T4); R0 scheduler and screen-name normalization (L04);
R2 native save/recorder/speech/credential/shutdown (L05, L06); S1 privacy
and authorization (L07, L08, L09, W_S1T3); F2 installer and cloud onboarding
(L10, L11); R3 Files discovery and publication (L12, L13, W_R3T2); F1 image
providers (L14, W_F1T4); U0 header, sidebar, inline code (L15, L15A, W_U0T1);
F4 workspace previews and Markdown editor (L17, W_F4T1, W_F4T3, W_F4T5,
W_F4T6, W_F4T7); F5 inline media, players, IMG-SEED (L16, W_F5T3, W_F5T4,
W_F5T5); U1 NOTICE attribution (W_U1); Q1-T3 dependency advisories (LQ3);
LFU (fix-round lane, check its commits).

---

## 4. Proposed README changes (do not apply in this lane)

`docs/releasing.md` requires a README review in both `FerroxLabs/murage` and
`FerroxLabs/murage-releases` before publication, with "Latest release" linked
to `/releases/latest` instead of a hardcoded version in the download heading.
The repository README (`README.md`) is still written against 0.1.47 and 0.1.50
and 0.1.51 did not update it.

### 4a. `README.md` in `FerroxLabs/murage`

| Line | Current | Proposed |
|---|---|---|
| 23 | `**[Murage 0.1.47 — stable release](.../releases/tag/v0.1.47)** · [Release notes](.../releases/latest)` | `**[Latest release](https://github.com/FerroxLabs/murage-releases/releases/latest)** · [Release notes](https://github.com/FerroxLabs/murage-releases/releases/latest)` (per `docs/releasing.md`; no version in the heading) |
| 34 | `**Fuigo 1.0.7 is bundled. ...` | `**Fuigo 1.0.10 is bundled. ...` (`scripts/prepare-fuigo.mjs` pins `FUIGO_VERSION = "1.0.10"`) |
| 144 | `**Fuigo 1.0.7 is Murage’s bundled agent harness**, ...` | `**Fuigo 1.0.10 is Murage’s bundled agent harness**, ...` |
| 107 | `**In 0.1.47, managed memory starts off.**` | `**Managed memory starts off.**` (still true; drop the version so the sentence does not age) |
| 170 | `Keyword retrieval and owner controls; no local semantic runtime in 0.1.47.` | `Keyword retrieval and owner controls; no local semantic runtime in this release.` (the row is already the Intel Mac row; drop the version so it does not age) |
| 17 | `2,237 skills` | Already matches: `skills-library/` holds 2,237 skill directories (one `SKILL.md` each) plus the `.wayland-import.json` metadata file, which is not a skill. Keep `2,237` unless a merged lane adds or removes a skill directory; re-count with `find skills-library -name SKILL.md | wc -l` at freeze. |
| 3, 40, 50, 66, 103, 120 | `*-0.1.47.png` screenshot and hero assets | Keep unless a merged UI lane (U0-T1 header, F4-T3 workspace pane, F5 media) changes the pictured surfaces; then capture new screenshots on the frozen candidate and rename with `0.1.52`. Do not rename assets without new captures. |
| 168 | `Windows browser: The embedded browser is disabled because of an upstream Electron sandbox issue.` | Re-verify against the 0.1.52 Windows package before publication; no merged commit changes it. |

Add under "Before you choose a setup" only if the corresponding lanes merge:
a row for the Markdown editor's supported subset and Source fallback (F4), and
a row stating media players support WAV/MP3/Ogg/M4A/MP4/WebM with no
transcoding and no autoplay (F5, U-28).

### 4b. README in `FerroxLabs/murage-releases` (separate repository, not in this tree)

- Download heading: "Latest release" linked to `/releases/latest`; no
  version number in the heading.
- Installer table identical to 4a (Apple Silicon DMG, Intel DMG, Windows
  setup, Ubuntu .deb and AppImage) with the stable download names the
  Release workflow asserts.
- Bundled engine line: Fuigo 1.0.10; no Node.js, npm, pnpm or separate Fuigo
  install required for desktop installers.
- Known platform limits copied verbatim from the 4a table after the 0.1.52
  re-verification.
- Never describe the 0.1.52 draft as the latest public release until it is
  published (Q1-T6).

---

## 5. How to refresh this draft after further merges

1. `git log --format='%h %s' acaee1db..release/v0.1.52 --no-merges` and read
   each new commit body; add one entry per user-visible change to section 1
   and one row to the section 3 table.
2. If a merged lane added English strings to `src/locales/en.json`, draft the
   seven packs with the documented flow (one call per locale; uses the local
   authenticated Claude CLI):
   `for c in de es fr hi ja pt-br zh; do node scripts/generate-locale.mjs $c; done`
   then review every changed string and run `pnpm i18n:check`. The script
   refuses missing keys, invented keys, changed placeholders and prose. Use
   `--accept` only for a pack whose translations were already reviewed and
   committed without source hashes (hand-written or agent-drafted and
   reviewed like code, as the 0.1.50 `claudeAccounts.*` and `source/inbox/
   files` keys were); it records hashes for the current text and does not
   translate anything.
3. Re-run `node scripts/release-guard.mjs version` (must print `0.1.52`) and
   `pnpm exec vitest run scripts/release-guard.test.mjs scripts/release-workflows.test.mjs`.
4. Move the unmerged lanes from "not merged" to the table as they land; do
   not describe scope from the plan as shipped.
