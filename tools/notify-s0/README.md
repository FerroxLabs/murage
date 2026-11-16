# Qualification package only

Follow [the runbook](../../docs/verification/notify-s0-measure.md).

`entry.mjs` is a separate packaged Electron entry. `windows.ps1`, `macos.sh`
and `linux.sh` launch it in the operator's isolated GUI session. `kit.mjs`
creates calibration/candidate plans, finalizes measured evidence and imports
it into the canonical revision. `package.mjs` generates a separate builder
configuration from the production one; no probe is included by the production
configuration.

No measurements ship here. All numbers in calibration are stimulus lengths;
all numbers in the Node test are explicitly synthetic fixtures. The production
OS and menu envelopes stay zero. The existing menu template currently fails
whole-detail fidelity; preserve that negative evidence for MAIN.
