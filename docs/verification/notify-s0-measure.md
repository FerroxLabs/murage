# S0 native measurement kit (1.0.19)

This kit collects **measurements**, not permission to enable banner buttons. The
production OS/menu envelopes remain zero. No approval policy, finalDecision,
server, live profile or production main entry is involved. MAIN owns subsequent
policy/runtime integration and release review. Never use the owner's working
session or data. No paid runner is required or authorized by this procedure.

The probe uses `createWindowsBanners` (Electron Notification/ToastGeneric),
`createMacBanners` (the packaged UNUserNotificationCenter addon),
`createLinuxBanners` (the packaged D-Bus vendor module and the real session
notification daemon), and `trayMenu` + Electron Menu. Its synthetic records and
inert token callback exist **only in a separate qualification package**. Clicking
any probe button cannot approve or execute anything. No product eligibility bit
is modified. The probe does not load `electron/main.mjs`.

Native notification APIs do not return a trustworthy text-layout rectangle.
Consequently this is an **operator-assisted measurement kit**: it posts the real
template, captures the real desktop, records immutable post receipts, and
requires measured geometry and explicit visual observations. It never replaces
native text measurement with canvas, a character-count guess or the success of
`show()`. The `.png` files, not a mock renderer, are the measurement evidence.
PNG hashes prove integrity, not truthful measurement; MAIN must review them.

## Mandatory matrix

The executable list is `MANDATORY` in `electron/notify-s0.mjs`. It transcribes
`notifyos/DESIGN-r2.md` R2.1 / P2 / S0-N2 in the swarm handoff and
`docs/verification/notify-windows-actions.md`. These are required separate
versions, **not a claim that every later version is qualified**:

| ID | Required OS / minimum named version | Architecture | Machine |
| --- | --- | --- | --- |
| w10 | Windows 10 22H2, build 19045 | x64 | Desktop, `C:\murage-ci` |
| w11 | Windows 11 24H2, build 26100 | x64 | Beast, `D:\murage-ci` |
| m14 | macOS 14 | arm64 AND x64 | Mac gate user, native compatible hardware |
| m15 | macOS 15 | arm64 AND x64 | Mac gate user, native compatible hardware |
| m26 | macOS 26 | arm64 AND x64 | Mac gate user, native compatible hardware |
| gx | Ubuntu 24.04, GNOME 46, X11 | x64 | Isolated GNOME VM/desktop container |
| gw | Ubuntu 24.04, GNOME 46, Wayland | x64 | Isolated GNOME VM/desktop container |
| kw | Fedora, KDE Plasma 6, Wayland | x64 | Isolated KDE VM/desktop container |

The inherited requirement does **not** name a minimum Fedora release number.
MAIN/Linux operator must pin the supported Fedora release and full build at
admission; never substitute “latest.” Both Mac architectures count separately;
Rosetta cannot substitute for native x64. Windows Server and headless/Xvfb Linux
cannot substitute for these desktops. A container must actually run the named
compositor, daemon and session bus with a visible display.

For **each** row/architecture measure banner and menu, each offered layout
(collapsed banner, expanded/alert, notification centre, submenu), normal AND
maximum system text size, the minimum supported work area, light AND dark, all
`en de es fr hi ja pt-br zh` action-label sets, and each supported display scale.
Freeze this Cartesian inventory with MAIN before measuring; this kit does not
invent a minimum display size, maximum text-size value or supported scale list.
Each exact tuple is a separate bundle. An unavailable cell stays OPEN. No
screenshot cross-credits another layout. The importer reports missing platform/
architecture/surface cells but that summary alone is not full matrix completion.

## 1. Prepare separate packages on build workers

Use the same source revision, Electron, dependencies, signing identity, native
addons and production build preparation as the candidate RC. On its existing
OS build worker, after the normal package preparation/native build steps:

```sh
node tools/notify-s0/package.mjs notify-s0-builder.json
pnpm exec electron-builder --config notify-s0-builder.json --win --x64 --publish never
# On the existing Mac CI builder, NOT the gate Mac:
pnpm exec electron-builder --config notify-s0-builder.json --mac --arm64 --x64 --publish never
# On the Linux builder:
pnpm exec electron-builder --config notify-s0-builder.json --linux --x64 --publish never
```

Run only the applicable build command on each worker. Expected config output:
`S0_CONFIG: build with electron-builder ...`. Artifacts go to
`release-notify-s0`, named `Murage-S0-QUALIFICATION-*`. The generated configuration
retains production resources/hooks/app identity but changes the main entry to
`tools/notify-s0/entry.mjs`. Never publish or install it over a production app.
MAIN records the production/qualification artifact hashes and entry-point delta.
Default production configuration does not include the probe or fixture test.
Do not hand-edit/extract/repack the signed Mac app on the gate Mac.

Stage the unpacked/installed qualification package in the paths below and copy
`tools/notify-s0/{windows.ps1,macos.sh,linux.sh}` with it. The paths below are an
explicit staging convention, not an assertion that those packages already exist.
Close other Murage instances in the isolated gate session before starting. Use
an ordinary GUI user with notification permission, previews and screen capture
permission. DND/Focus must permit observation. On Mac this requires the gate
user logged into Aqua; **MAIN/operator performs all Mac access**. This builder
has not accessed the Mac. No Node, pnpm, compilation or unit tests run there.

## 2. Admit the machine

All output directories must be new. The package refuses an existing directory,
unpackaged Electron, or Linux without a display/session bus. It creates a random
temporary userData/sessionData directory and removes it on normal exit. No
server is launched. If terminated externally, `murage-s0-*` in that user's temp
folder is the isolated scratch directory; inspect ownership before removing it.

Desktop, in GUI PowerShell:

```powershell
cd C:\murage-ci
powershell -NoProfile -File .\tools\notify-s0\windows.ps1 -Package C:\murage-ci\s0-package\Murage.exe -Out C:\murage-ci\s0-admit-w10 -Admit
```

Beast, in GUI PowerShell:

```powershell
cd D:\murage-ci
powershell -NoProfile -File .\tools\notify-s0\windows.ps1 -Package D:\murage-ci\s0-package\Murage.exe -Out D:\murage-ci\s0-admit-w11 -Admit
```

Mac gate user, Terminal **inside the GUI session**, for each version/architecture:

```sh
cd "$HOME/murage-ci"
bash tools/notify-s0/macos.sh "$HOME/murage-ci/s0-package/Murage.app" "$HOME/murage-ci/s0-admit-m14-arm64" --admit
```

Repeat with output names `m14-x64`, `m15-arm64`, `m15-x64`, `m26-arm64`,
`m26-x64` on their corresponding native installations. Do not upgrade/replace
the owner's OS to meet this matrix.

GNOME/KDE desktop user's terminal, for each real session:

```sh
cd "$HOME/murage-ci"
bash tools/notify-s0/linux.sh "$HOME/murage-ci/s0-package/murage" "$HOME/murage-ci/s0-admit-gx" --admit
```

Repeat as `gw` and `kw` in their actual Wayland sessions. Expected: an “S0
admission recorded” dialog and `admission.json` containing actual OS build,
Electron/native/package hashes, daemon identity and display metrics. An error
writes `OPEN.json` and exits nonzero. Missing daemon/addon/permission is OPEN,
never a passing measurement. Keep admission receipts with returned evidence.

## 3. Calibrate; propose a candidate from observed numbers

Plan/finalize/import commands run on a build/admission host with Node 24. In
this job run them using the container wrapper shown in section 7; transfer the
JSONs to/from the GUI machines. No Node CLI is needed on the Mac.

```sh
node tools/notify-s0/kit.mjs seed w10 banner-win input-w10.json
```

Expected: `S0_SEED ... nulls cannot qualify`. For other rows use the matrix ID
and `banner-mac`, `banner-linux` or `menu`. Fill `input-w10.json`:

- `operator`, `machine`: actual operator and machine identity.
- `layout`: copy all observed fields from admission. Supply actual OS version,
  desktop, native font, text scale, display scale, work area `[width,height]`,
  theme, locale, and observed layout name. Use the **exact** daemon identity
  string from admission. `font` must include family, size and style; if unknown,
  stop. Text scale is a factor; convert a recorded OS percentage to that factor.
  Work-area dimensions are Electron DIP; glyph/line/usable dimensions below are
  pixels in the captured image. Record screenshot-to-display scaling in method.
- Initially leave `envelope`, `widest` and measurement values null. The calibration
  plan uses fixed glyph stimuli (8 repeated glyphs between `|` anchors); these
  are stimulus lengths, **not measured limits**.

```sh
node tools/notify-s0/kit.mjs calibrate input-w10.json calibration-w10.json
```

Expected: `S0_PLAN ... 285 cases; candidate only`. Run that plan using section 4
(with `calibration-w10.json` and a fresh calibration output directory). Every
printable ASCII glyph U+0020–U+007E is rendered separately in botName, title and
detail. Use a pixel ruler/native accessibility inspector to measure the eight
advances between anchors, subtract anchor advances, divide by eight; record all
95 advances in codepoint order for **each field**. Measure a line height, usable
width and height for each field. Inspect ligatures/kerning/spacing; if repeat
advances cannot conservatively bound mixed text, this repertoire/layout remains
OPEN. Do not measure the probe dialog or a browser/canvas text approximation.
Calibration files can never be imported as envelopes.

Populate `measurements.{botName,title,willRun}` with those positive pixel values.
Record the method/tool/version, normal or maximum text-size mode, and whether
the frozen minimum work area was used. Record actual whole-template occupied
height and usable height. Derive conservative candidate character/line limits
using the **widest** observed advance (including space), usable dimensions and
simultaneous fields; round limits down. A combined Mac/Linux title must fit the
bot name, colon and title together. Do not sum separately optimistic limits.
`templateLines` must accommodate `maxLines + 2`, and actual simultaneous-height
proof is also required. Set `widest` to the widest non-space glyph in each field
(first in ASCII order on a tie). `plan`/`finalize` refuse null/unmeasured data;
finalize also refuses width/height bounds inconsistent with the measured maxima.

```sh
node tools/notify-s0/kit.mjs plan input-w10.json plan-w10.json
```

Expected: `S0_PLAN ... 296 cases; candidate only`. Full cases repeat every glyph
and add simultaneous maxima, long-token/word/space/newline/punctuation wrapping,
name/title/detail +1 and non-ASCII/invisible refusal cases. Re-measure and lower
any unsafe candidate; generate a new plan/output instead of editing receipts.
`-Case full-template` (PowerShell) or a fourth positional `full-template`
(shell wrappers) permits exploration. Partial exploration output cannot finalize.

**Current menu limitation:** the production `trayMenu` clips/folds its summary
and does not have a separate complete-detail/title row. The probe feeds the
complete title/detail into that real summary and records `transformed:true`
when it changes. This necessarily blocks this menu from positive qualification
on this source revision. Keep the negative evidence for MAIN's template owner;
do not clear that flag, replace the menu with a mock or call it an OS limitation.
After a real template repair, the source binding changes and all affected
measurements must be rerun.

## 4. Render and capture each complete plan

Desktop:

```powershell
powershell -NoProfile -File C:\murage-ci\tools\notify-s0\windows.ps1 -Package C:\murage-ci\s0-package\Murage.exe -Plan C:\murage-ci\plan-w10.json -Out C:\murage-ci\s0-w10-banner-run01
```

Beast:

```powershell
powershell -NoProfile -File D:\murage-ci\tools\notify-s0\windows.ps1 -Package D:\murage-ci\s0-package\Murage.exe -Plan D:\murage-ci\plan-w11.json -Out D:\murage-ci\s0-w11-banner-run01
```

Mac gate GUI terminal (substitute each matrix version/architecture in plan and
output names):

```sh
bash "$HOME/murage-ci/tools/notify-s0/macos.sh" "$HOME/murage-ci/s0-package/Murage.app" "$HOME/murage-ci/s0-m14-arm64-banner-run01" "$HOME/murage-ci/plan-m14-arm64.json"
```

Linux GUI terminal (repeat for gx/gw/kw):

```sh
bash "$HOME/murage-ci/tools/notify-s0/linux.sh" "$HOME/murage-ci/s0-package/murage" "$HOME/murage-ci/s0-gx-banner-run01" "$HOME/murage-ci/plan-gx.json"
```

Use menu plans/output names for menu runs; the same OS command renders the
real native menu. For each case click Render, arrange the required layout in
the five-second capture window (hover/open the submenu for menu), and wait for
the next case dialog. Each case withdraws its notification/menu. Notification
centre/expanded layouts require the operator to expose that exact layout; if
five seconds is insufficient, preserve OPEN evidence and rerun that case in a
new exploratory run before scheduling a complete run. Do not click action
buttons while collecting geometry; they are inert and may dismiss the banner.

Expected successful capture output: `admission.json`, byte-identical
`plan.json`, `posts/*.json`, `captures/*.png`, `observations.json`, `run.json` and
“S0 captures recorded.” `run.json` says **OPEN** until measurement/review.
It records start/end UTC and elapsed milliseconds. A refusal writes `OPEN.json`.

Time: real-machine elapsed times are **not yet measured**. There is exactly
5 seconds of programmed capture wait per case: 1,425 seconds (23m45s) for 285
calibration cases and 1,480 seconds (24m40s) for 296 full cases, **plus** native
posting, dialogs, operator measurement and transfer time. These are lower
bounds from the code, not observed machine timings. Read actual `run.json`
`elapsedMs`; record operator review time separately. Admission has no scripted
five-second case delay. Repeat per tuple; never claim one run covers the matrix.

## 5. Record observations and return bundles

For every PNG, verify the whole intended native surface is visible, correct
scale/layout and no ellipsis/clipping/hidden fields/text transformations. Compare
with the exact case text in plan.json. In `observations.json` set `complete`
and `transformed` from inspection, and select `capture` for the actual monitor
if it is not `*-0.png`. Preserve all PNGs/receipts. The capture hash is bound into
the collector's post receipt. Do not crop/resize/edit originals. `runtimeRefused`
is computed for the negative cases by the existing `fitsEnvelope`; a +1 probe
may remain visually readable because the bound is conservative, but it must
still be refused by that runtime bound. Glyph and positive-fit cases require
`complete:true, transformed:false`. Keep failures as failures.

Return raw directories first, then finalize on the admission host. From Desktop:

```powershell
scp -r C:\murage-ci\s0-w10-banner-run01 root@build-host:/work/fuigo-builds/swarm-b/notify-s0-bundles/windows/
scp -r C:\murage-ci\s0-admit-w10 root@build-host:/work/fuigo-builds/swarm-b/notify-s0-bundles/windows/
```

From Beast use `D:\murage-ci\s0-w11-banner-run01` and `s0-admit-w11` to the same
`windows/` destination. From the Mac gate GUI session:

```sh
scp -r "$HOME/murage-ci/s0-m14-arm64-banner-run01" "$HOME/murage-ci/s0-admit-m14-arm64" root@build-host:/work/fuigo-builds/swarm-b/notify-s0-bundles/macos/
```

From Linux:

```sh
scp -r "$HOME/murage-ci/s0-gx-banner-run01" "$HOME/murage-ci/s0-admit-gx" root@build-host:/work/fuigo-builds/swarm-b/notify-s0-bundles/linux/
```

MAIN creates those destination directories and supplies existing SSH access;
this procedure never provisions a runner/account or changes SSH trust. Include
calibration runs, all other tuple runs and the frozen inventory. On the admission
host, against the **same source/rig revision**:

```sh
node tools/notify-s0/kit.mjs finalize /path/to/returned/s0-w10-banner-run01
node tools/notify-s0/kit.mjs import /path/to/new/notify-s0-index.json /path/to/returned/s0-w10-banner-run01 /path/to/other/complete-run
```

Expected: `S0_BUNDLE ... review required`, then `S0_INDEX ... production remains
disabled` and `S0_COVERAGE ...`. Errors start `S0_REFUSED:`; no index is written
if any bundle fails. All output files use exclusive creation. Finalize fills
only hashes/end time; it never fills missing geometry or positive observations.
The canonical index stores the exact validated bundles keyed by layout digest;
its revision hashes the entire index content. Preserve raw evidence alongside it.

## 6. Runtime consumer contract for MAIN

`loadS0Index(file, root)` validates a MAIN-owned canonical index against current
source hashes. `createS0Qualification({readBinding,readIndex,readLayout,invalidate})`
returns `qualify(surface)` and `valid(lease,surface)`. Call on mint **and** action.
`readLayout` must be a fresh main/native observation of **every** LAYOUT_KEYS
field, never a saved plan, renderer report, preference or OS-family guess. If
a field cannot be read, return null: actions stay unqualified. `invalidate`
must retire outstanding tokens. Explicitly call the returned `invalidate()`
before refreshing on display/text/font/theme/locale/layout/session changes,
resume, native errors, permission changes and daemon owner/reconnect events.
Re-read failure, changed binding/index or any unknown tuple invalidates leases;
returning to a formerly known layout does not resurrect old leases.

The library has no common-envelope exception. Adding a measured tuple requires
an explicit offline import/review. No environment variable or fixture switch
can grant production qualification. Source changes automatically invalidate
via `BINDING_FILES`; native binary, Electron, daemon and OS changes invalidate via
the exact layout key. Preserve the binding when moving the file, never rewrite
it to a new RC. Fixture inspection exists solely for structural tests and returns
`eligible:false`; the loader rejects every fixture unconditionally.

This job supplies the loader/API, **not native runtime readers or the MAIN
activation integration**. No production code consumes a measurement yet. MAIN
must provide those observations and wire lease retirement alongside finalDecision
when the prerequisite lands, then prove real packaged layout changes/unknown
layouts cannot approve. This is an explicit remaining integration gate, not a
claim that callback-injection unit tests establish real runtime layout reading.

## 7. Container verification and evidence scope

From this worktree (one container at a time, network none, host load below 85):

```sh
IT_JOB=notify-s0-kit \
IT_W=/work/fuigo-builds/swarm-b/notify-s0-kit/wt \
IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh \
/work/fuigo-builds/tools/it-remote.sh 'node --test electron/notify-s0.node-test.mjs electron/windows-banners.node-test.mjs electron/mac-banners.node-test.mjs electron/linux-notify.node-test.mjs shared/outside-limits.node-test.mjs'
```

The test's in-memory bundles/PNG signatures are explicitly **FIXTURES**, never
native evidence. The production package excludes that test. No fixture bundle
is checked into a canonical envelope directory. Unit tests cover schema,
measurements, missing/cropped/transformed cases, tampered artifacts, unknown
layouts, stale revisions and lease invalidation. They do not establish native
GUI/package behavior. No server/conversation change is made or claimed; for any
future such claim follow `docs/verification/README.md` with an isolated fixture.
After returning evidence, remove only this job's temporary build outputs and
owned test containers/dependencies. Retain bundles and logs. Do not delete
shared packages, mutate live app data, enable buttons or alter approval policy.
