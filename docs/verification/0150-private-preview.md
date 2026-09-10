# Murage 0.1.50 private preview

This guide describes private integration source at `11549fff` on
`work/0150-integration`, inspected on 2026-09-10. A macOS arm64 app from this
source has passed its basic isolated native smoke. This is not a download
announcement, full candidate qualification, or a released 0.1.50 installer.
The coordinator's current `.planning/STATE.md` and `.planning/MURAGE-PLAN.md` in
the parent Murage checkout control the remaining release gates; older records
inside this integration checkout may describe earlier stages.

## Recorded private artifact

The local [app bundle](../../../0150-current-private-build/release/mac-arm64/Murage.app)
is version **0.1.50**, built from
`11549fff0d7f0f15775b8d274e8aed7dffad1bff`. Its accepted
[native receipt](../../../0150-current-private-build/.planning/current-private-evidence/native-smoke-r2/result.json)
records the actual packaged main, static server, sandboxed preload and rendered
window; four owner routes returned 200 and unauthenticated owner access was
hidden. The temporary profile and owned processes were cleaned up while the
normal app and foreground application were preserved.

That smoke deliberately disabled engines and sent no engine turns. It does not
prove live accounts, model generation, TCC, OS credential custody, every feature,
Windows/Linux behavior or macOS Intel behavior. The app has an ad-hoc signature
and is not notarized. The [candidate manifest](../../.planning/0150-candidate-manifest.json)
records the source and artifact hashes; publication and release readiness remain
false. Earlier artifacts and failed attempts remain historical evidence.

## Getting started

Use a maintainer-provided preview with a separate test profile. Do not replace
your normal installation or point development commands at your everyday data.
The local app above is available only for its recorded private verification
scope; this guide does not authorize an installed-app replacement or another run
against existing data.

The desktop packaging includes the native Fuigo engine; customers do not need
to install Node.js or npm to use it. This candidate pins Fuigo **1.0.10**. A source
pin alone does not prove every packaged platform or a real provider session.

On first run, choose an engine and then a model. The bundled Fuigo setup path
identifies an available bundled engine as **Included**; the disabled-engine
smoke above did not qualify that readiness path. Other installed engines can
also appear. Account access and pricing depend on
that selection. Setup does not copy credentials or enable a paid fallback.
Review your chosen starter crew before importing it, including any selected
routine suggestions and warnings. A crew import is not permission for
unattended external actions. Follow the selected engine's sign-in and readiness
instructions when access is required.

## Using the candidate

- **Inbox:** Open it from Tools. **Needs you**, **Results** and **All** separate
  requests from completed work. Open a report, file or request to return to its
  source. Marking an item read or snoozing it for an hour never approves or
  answers the request.
- **Files:** Open it from Tools or the bot's folder control. Search saved files
  and filter by bot, task, type or date. Preview supported formats or download
  the saved copy. A file path mentioned in chat is not automatically a saved
  deliverable. Unsupported formats use download; protected HTML previews block
  scripts, external resources and app access. Native **Open in app** and
  **Show in folder** remain subject to the native verification gate below.
- **Threads and defaults:** Each direct thread has its own model/account and
  approval settings. New tasks copy the bot's defaults; check the selected
  thread before changing its model or pressing Stop. Up to three direct runs
  per bot are supported by the integrated thread implementation. Shared
  browser/computer resources and overlapping working folders can still require
  one run to wait or be refused; group conversations remain serialized.
- **Accounts:** The engine settings include named Claude accounts. Give each
  account a recognizable name and follow its own sign-in instructions. A new
  account can use a separate configuration directory; existing credentials
  are not moved or copied. Removing account metadata retains its login/files.
  Changes can be refused while work is active or the account is still assigned.
  This is not a claim that real OAuth or native credential isolation has passed
  on every platform.
- **Fuigo:** The bundled version and a separately managed engine update are
  different from a Murage app update. The independent updater has accepted
  macOS arm64 and native Intel production install/update/rollback/bundled proof.
  Windows and Linux native updater qualification remain open; the bundle pin
  does not close those gates. Intel updater proof does not qualify an Intel GUI package.
- **File watches:** Explicitly choose an existing relative file in an approved
  bot working folder, then confirm the proposed watch. The bounded file adapter
  uses the existing routine scheduler and durable Inbox results; baseline and
  unchanged reads stay quiet. Confirmation, change delivery, quiet behavior and
  restart deduplication have scoped fixture proof. Watches do not run a model
  turn, and this slice does not provide arbitrary web or connector monitoring.

## Known limits

The customer **-32603** root cause remains unresolved. Integrated diagnostics
identify the failing ACP request, and cancellation/exit handling has focused
regression evidence; neither establishes that the reported customer incident
is fixed. The browser takeover hold correction is integrated, but the actual
customer Box/native UI path is not yet qualified.

The ownership-recovery broker, VSS capture, archive, separate restore and selector
flow are integrated. The accepted Windows Server2022 joined fixture used
**emulated elevation**, preserved original/anchor bytes, excluded credentials
and required review before activation. Actual interactive same-user UAC
cancel/approve and the signed installed app/helper boundary remain unqualified.
Do not use this guide to clear locks, copy a live profile, elevate privileges or
run recovery against existing data.

The isolated remote-window journey is accepted: pairing, connected renderer,
fake-engine chat, renewal, revocation, disconnect and local-session preservation.
Hosted provisioning, DNS/TLS, hosted login/persistence and deployed-service
readiness remain open. No cloud service is supplied by this preview.

The joined Inbox → Files → exact source-message/report-card journey passed
byte-identical download and same-profile restart, with one result and unchanged
sibling-thread state. Earlier rendering and fixture failures are historical,
not current blockers. macOS text Open/Reveal dispatch also has scoped native
preload/handler proof; editor rendering and packaged Windows/Linux behavior
remain unverified.

Windows/Linux native updater confirmation is blocked: Windows contained launch
returns error 5, and real Linux Fuigo fails during ACP initialization. The two
rounds and pending continuation decision are preserved in the coordinator's
record. Windows/Linux final packages and broader packaged UI/auth/Files/background
qualification remain open. Release-CI credential403 and notarization remain
unresolved; no publication is authorized. Prior 0.1.49 results do not qualify
this expanded candidate.

## Developer-only isolated fixture

These are development commands, not customer setup. Use the integration checkout
with its development dependencies already installed and the repository's Node
requirement (24 or newer). The existing foreground launcher creates temporary
data/home directories, a fake engine and its own server; it does not establish
live provider authentication, renderer behavior or packaged native readiness.

```sh
rtk proxy /Users/seandonahoe/.nvm/versions/node/v24.20.0/bin/node --experimental-strip-types scripts/control-murage.ts launch
```

Keep that terminal open. In another terminal, use the exact URL printed by the
launcher, replacing `PORT` below:

```sh
rtk proxy /Users/seandonahoe/.nvm/versions/node/v24.20.0/bin/node --experimental-strip-types scripts/control-murage.ts doctor --url http://127.0.0.1:PORT
```

Interrupt the foreground launcher with Ctrl-C when finished. It owns its child
and temporary directory cleanup; preserve its printed log and any needed
receipts. See [Verifying Murage](README.md) for the existing control-surface
contract. These commands were checked against that guide, `package.json` and
`scripts/control-murage.ts`; they were not rerun for this documentation change.

<!-- Documentation closeout: update this guide and the candidate manifest only.
Acceptance is source/receipt agreement, truthful scoped passes and open gates,
valid JSON/paths and a focused diff. No runtime changes, tests/builds/native runs,
public README changes, commit, push or publication are performed by this edit.
Historical evidence and verification counters are preserved. -->
