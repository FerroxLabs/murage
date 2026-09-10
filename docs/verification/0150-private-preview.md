# Murage 0.1.50 private preview

This guide describes private integration source at `5c40a66b` on
`work/0150-integration`, inspected on 2026-09-10. It is not a download announcement
or evidence that a 0.1.50 installer has been packaged, qualified or released.
The coordinator's current `.planning/STATE.md` and `.planning/MURAGE-PLAN.md` in
the parent Murage checkout control the remaining release gates; older records
inside this integration checkout may describe earlier stages.

## Getting started

Use a maintainer-provided preview with a separate test profile. Do not replace
your normal installation or point development commands at your everyday data.
This source guide does not supply a qualified preview installer.

The desktop packaging includes the native Fuigo engine; customers do not need
to install Node.js or npm to use it. This candidate pins Fuigo **1.0.10**. A source
pin alone does not prove every packaged platform or a real provider session.

On first run, choose an engine and then a model. Fuigo is labelled **Included**;
other installed engines can also appear. Account access and pricing depend on
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
  different from a Murage app update. Do not treat the 1.0.10 bundle pin as
  completion of the independent update/activation/rollback workflow.

## Known limits

The customer **-32603** root cause remains unresolved. Integrated diagnostics
identify the failing ACP request, and cancellation/exit handling has focused
regression evidence; neither establishes that the reported customer incident
is fixed. The browser takeover hold correction is integrated, but the actual
customer Box/native UI path is not yet qualified.

The separate ownership-recovery candidate is **not integrated**. Do not use this
preview guide as an instruction to clear locks, copy a live profile, elevate
Windows privileges or run recovery against existing data. The proposed
no-backup Windows snapshot recovery still needs its explicit disposition.

Cloud work remains **blocked for feature acceptance**; no deployed service or
qualified cloud setup is supplied here. Proactive watches contain an accepted
pure state foundation only: no source adapter, scheduler activation or Inbox
delivery is connected. Chief is not running a new watch heartbeat in this
candidate.

Files has preserved browser/core lifecycle evidence, including download and
restart behavior. Native OS open/reveal is still a separate **pending gate**.
Platform, native engine updater, profile reconciliation and final package
qualification remain governed by the coordinator's existing record. Prior
0.1.49 release results do not qualify this expanded candidate.

## Developer-only isolated fixture

These are development commands, not customer setup. Use the integration checkout
with its development dependencies already installed and the repository's Node
requirement (24 or newer). The existing foreground launcher creates temporary
data/home directories, a fake engine and its own server; it does not establish
live provider authentication, renderer behavior or packaged native readiness.

```sh
rtk proxy node --experimental-strip-types scripts/control-murage.ts launch
```

Keep that terminal open. In another terminal, use the exact URL printed by the
launcher, replacing `PORT` below:

```sh
rtk pnpm control:murage doctor --url http://127.0.0.1:PORT
```

Interrupt the foreground launcher with Ctrl-C when finished. It owns its child
and temporary directory cleanup; preserve its printed log and any needed
receipts. See [Verifying Murage](README.md) for the existing control-surface
contract. These commands were checked against that guide, `package.json` and
`scripts/control-murage.ts`; they were not rerun for this documentation change.

<!-- Documentation package: own this new guide only. Acceptance is accurate
source identity, implemented user flows and explicit pending gates grounded in
current source and coordinator records. No runtime changes, new tests/audits,
public README changes, packaging, push or publication. Documentation inspection
complete; no verification cycles reopened. -->
