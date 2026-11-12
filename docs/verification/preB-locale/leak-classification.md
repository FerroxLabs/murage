# preB-locale leak classification

The shared v2 guard reports 63 tracked files at bbf96a5cb: 49 tailnet files owned by mobile and fixed by f00e64405, plus the same 14 other files reported by preB. The newer shared pattern set includes the tailnet label. All 63 are inherited and left untouched by this copy lane. No exclusions were added. Raw reports are retained in the job evidence directory, outside the public tree.

| File | Classification | Reason |
| --- | --- | --- |
| `apps/mobile/android/app/src/test/java/com/murage/mobile/PushEnrolmentTest.java` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/android/app/src/test/java/com/murage/mobile/PushStoreTest.java` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/android/app/src/test/java/com/murage/mobile/QrScannerTest.java` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/android/app/src/test/java/com/murage/mobile/shell/ApprovalProofTest.java` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/android/app/src/test/java/com/murage/mobile/shell/ChannelGateTest.java` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/android/app/src/test/java/com/murage/mobile/shell/ChannelScriptTest.java` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/android/app/src/test/java/com/murage/mobile/shell/LaunchPolicyTest.java` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/android/app/src/test/java/com/murage/mobile/shell/NavigationPolicyTest.java` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/android/app/src/test/java/com/murage/mobile/shell/PairingLinkTest.java` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/android/app/src/test/java/com/murage/mobile/shell/RouteMemoryTest.java` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/android/app/src/test/java/com/murage/mobile/shell/SameDocumentTest.java` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/android/app/src/test/java/com/murage/mobile/shell/SaveRequestTest.java` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/android/app/src/test/java/com/murage/mobile/shell/WorkspaceBookTest.java` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/android/app/src/test/java/com/murage/mobile/shell/WorkspaceOriginTest.java` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/contract/channel.json` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/contract/navigation.json` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/contract/origins.json` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/contract/push-ledger.json` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/contract/trim.json` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/ios/App/MurageShell/Tests/MurageShellCoreTests/CallPushTests.swift` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/ios/App/MurageShell/Tests/MurageShellCoreTests/ChannelGateTests.swift` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/ios/App/MurageShell/Tests/MurageShellCoreTests/ChannelScriptTests.swift` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/ios/App/MurageShell/Tests/MurageShellCoreTests/LaunchPolicyTests.swift` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/ios/App/MurageShell/Tests/MurageShellCoreTests/NavigationPolicyTests.swift` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/ios/App/MurageShell/Tests/MurageShellCoreTests/PairingLinkTests.swift` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/ios/App/MurageShell/Tests/MurageShellCoreTests/PushEnrolmentTests.swift` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/ios/App/MurageShell/Tests/MurageShellCoreTests/PushExtensionTests.swift` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/ios/App/MurageShell/Tests/MurageShellCoreTests/PushResponseTests.swift` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/ios/App/MurageShell/Tests/MurageShellCoreTests/PushStoresTests.swift` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/ios/App/MurageShell/Tests/MurageShellCoreTests/RouteMemoryTests.swift` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/ios/App/MurageShell/Tests/MurageShellCoreTests/SameDocumentTests.swift` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/ios/App/MurageShell/Tests/MurageShellCoreTests/SaveRequestTests.swift` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/ios/App/MurageShell/Tests/MurageShellCoreTests/WorkspaceBookTests.swift` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/ios/App/MurageShell/Tests/MurageShellCoreTests/WorkspaceOriginTests.swift` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/src/channel-script.test.ts` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/src/code-entry.test.ts` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/src/invitation.test.ts` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/src/launcher.test.ts` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `apps/mobile/src/screens.test.ts` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `cloudflare/control-plane/src/flux-grants.ts` | other | Comment names a private Flux rollout flag. |
| `companion/test/push-door.test.ts` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `docs/mobile/handoff/plan-drafts/A-sessions.md` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `docs/mobile/handoff/plan-drafts/B-door.md` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `docs/mobile/handoff/plan-drafts/D-webui.md` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `docs/mobile/phase0/FINDINGS.md` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `docs/superpowers/plans/2026-09-25-plan-1-host-fixes.md` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `docs/superpowers/plans/2026-09-25-plan-2-app-shell.md` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `docs/superpowers/plans/2026-09-27-plan-3a-push-host-and-relay.md` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `docs/superpowers/plans/2026-09-27-plan-3b-push-native.md` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `docs/superpowers/plans/2026-09-30-flux-streaming-transcription-flux-handoff.md` | other | Historical handoff embeds private Flux rollout flags and internal Python source paths. |
| `docs/superpowers/specs/2026-09-30-flux-streaming-transcription-design.md` | other | Historical design describes private Flux rollout flags and internal Python source paths. |
| `docs/verification/l9/contract-audit.md` | tailnet | Mobile-owned fixture or documentation; fixed by f00e64405. Left untouched. |
| `server/avatar-image.ts` | other | Comment names a private image rollout flag. |
| `server/cloud-home/engine-render-launcher.test.ts` | other | Provider-route fixture uses the port flagged by the shared guard. |
| `server/drivers/openai-chat.test.ts` | other | Fixture comment names a private Flux implementation file. |
| `server/email/flux-email-client.ts` | other | Comment names a private bot-key rollout flag. |
| `server/flux-contract-endpoints.ts` | other | Comment names a private spend-meter rollout flag. |
| `server/flux-hourly-burn.test.ts` | other | Fixture comments name a private Flux implementation file. |
| `server/flux-refusal.ts` | other | Protocol comments name a private Flux implementation file. |
| `server/gateway-busy.test.ts` | other | Fixture provenance comment names private Flux implementation files. |
| `server/limit-continuation.ts` | other | Comment names a private Flux implementation file. |
| `server/memory/pin-budget-104.test.ts` | other | Memory-budget fixture includes a prohibited former product name. |
| `src/lib/flux-invite.test.ts` | other | Fixture comment names a private image rollout flag. |
