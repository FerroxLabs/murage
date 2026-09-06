# Private MVP handoff — 2026-09-07

Source candidate: `7ba8095c`, branch `codex/murage-reliability`.
Not a public release. Do not replace `/Applications/Murage.app` or use Sean's
live data for verification. Existing privacy and no-push constraints remain.

## Evidence

| Work item | Status | Progress / pending work |
|---|---|---|
| Fresh bundled startup | ✅ Done | Empty-HOME server/MCP smoke passed, including eleven proxy paths and shutdown. |
| Cumulative event budgets | ✅ Done | Accepted continuation/delegation/cancellation fixtures; minimum scope integrated. |
| Free search | ✅ Done | Scoped fixtures, UI and one live keyless query passed. Parallel with one DuckDuckGo fallback; existing paid options retained. |
| Telegram implementation | ✅ Done | Pairing, owner binding, durable intake, same-chat replies, unpair, channel-origin enforcement and UI fixtures passed. |
| Telegram real-service pilot | ⬜ Pending | Requires dedicated test-bot token via secure file and owner pairing; no real Telegram success claimed. |
| Combined regression | ✅ Done | Round 1: 5,479 passed, seven failed. Targeted corrections: round 2 all 198 tests across eight files passed; unaffected evidence reused. |
| Production builds | ✅ Done | Frontend/types and bundled server passed after corrections. Existing generated-CSS/chunk-size warnings remain deferred. |
| Private Mac artifact | ✅ Done | 0.1.47-mvp.2 ZIP built; actual packaged server/resources smoke passed. Ad-hoc signed, not notarized. Native GUI acceptance remains separate. |
| Native Mac launch | ⬜ Pending | Blocked pending bounded continuation decision: earlier 2cfdca52 artifact displayed isolated fixture profile, but harness close hung. Owned processes cleaned. Neither clean shutdown nor final-artifact GUI is proven. |
| Windows/Linux native installers | ⬜ Pending | Current native installer checks unavailable/not completed; no all-platform readiness claim. |
| Overall execution goal | ⏳ In progress | Private candidate nearly assembled; live Telegram and native/platform dispositions remain open. |

## Installation boundary

Artifact: `release-mvp-7ba8095c/Murage-0.1.47-mvp.2-arm64.zip`.
SHA256: `4750940044211033caddab746fe66c22ea3e7a091035cb94baeeddfef0519366`.
Package job42595 exit0; actual Resources/server smoke19909 exit0, health,
eleven spawned paths and MCP request/final-frame drain without node_modules.

The ZIP is an Apple Silicon private preview, not a notarized public installer.
Extract to a separate preview directory. Do not overwrite an existing application
or launch against an existing customer profile without coordination. Do not remove
quarantine or disable Gatekeeper globally. No verified npm installation is promised.

## Deferred scope

Slack, Discord, WhatsApp, marketplace, hosted sharing, expanded cloud onboarding,
advanced handoff/product-power features and additional polish remain deferred.
See `MURAGE-PLAN.md` for the frozen scope. Do not reopen audits or rerun the full
suite merely to seek more issues. A further blocked confirmation needs a decision.

## Next required decisions

1. Authorize a bounded native-only continuation to distinguish the test harness's
   close behavior from an application shutdown defect, then check the final Mac
   candidate. Do not restart the completed regression suite.
2. Supply a secure file path for a dedicated Telegram test-bot token and complete
   owner pairing. Do not paste the token into chat. Keep this pilot isolated.
3. Native Windows/Linux installer gates remain unverified, not waived. The private
   Mac preview is not evidence that those platforms are ready.
