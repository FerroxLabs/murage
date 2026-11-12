# bld-hlpw3 evidence

The requested full management release remains OPEN. `users.create` is not enabled in the production runtime. This evidence must not be read as acceptance of R1 through R12.

Baseline is afb0404f1e5d830d83441764ae52905675414e56. The prior brief, DONE and acceptance table were read before edits. Project memory prelude was unavailable and `.ijfw/memory` was absent. The independent Sol copy review is in [COPY-REVIEW.md](COPY-REVIEW.md). It reviews wording and is not human approval or implementation acceptance.

## Implemented boundaries

The server now mounts dedicated password session and create user routes. They use an explicit desktop route policy and require local transport, allowed origin, the local desktop launch proof, a protected native session and the original host owned direct desktop turn. Cloud, companion and internal tool forwarding cannot supply these facts. The host retains the original claim, reviewed arguments, connection and grant binding for authority rechecks. The route rechecks after reading the body and passes a bound one use capability to `HighLevelActions.completeDesktopPassword`. The existing journaled host owns dispatch. No route sends an independent provider request.

The dedicated body reader bypasses generic body recording and cached bodies. It bounds transport bytes, wipes consumed chunks on success or failure, removes listeners and uses fixed errors. Native session close messages must name the current session. A stale close cannot revoke its replacement. The runtime now creates the durable company and email claim database used by host dispatch.

The application mounts a persistent password host outside the approval card lifetime. The review action requires the exact values to have rendered. The main IPC bridge owns the nonce and native lease, authenticates the current renderer session, burns submission before transport and wipes its mutable wire buffer. A settled approval card cannot erase the successful dialog. Expiry asks the renderer to clear its field and holds native access until close acknowledgement. Renderer death still waits for the coordinator's clipboard receipts and native disposal. Generic native context menus and the ordinary clipboard bridge are refused while this session exists.

The main coordinator still has no native capture, input or independent clipboard adapters. Its default refusal is preserved. The private parent port can consume native attestations, but main never declares readiness without those adapters. The dialog cannot generate a password on this production path. The existing production runtime also retains legacy read only grants, its mount check cannot consume the full family grant shape and the Private Integration token source supplies no verified operation scopes. These are required implementation gaps, not an approved scope reduction or a decision to move work to another release.

## Process memory qualification

The existing native addon now exposes OS core protection. Linux sets and verifies both hard and soft core limits at zero and sets and verifies `PR_SET_DUMPABLE=0`. macOS code sets the core limit but was neither built nor run. Windows returns false, so password admission fails closed there. No universal OS memory erasure is claimed. The threat boundary excludes OS swap and hibernation, external clipboard managers, external capture and deliberate owner sharing. JavaScript strings cannot be reliably overwritten; the code drops references and wipes mutable buffers.

Main installs this before launching renderers or its server. The server installs its own protection before admitting a password. Node inspector, automatic heap snapshot, heap profile and automatic report launches refuse password admission. Explicit memory bearing heap and process report sinks are disabled. Crashpad startup remains removed. Analytics startup now explicitly disables session recording, exception capture and console recording, in addition to existing click capture denial.

The Linux native qualifier compiles the real addon in the required container, sends a generated secret only through a pipe, verifies that the same user parent cannot open the child's memory, forces SIGABRT and checks the hard core limit and absence of dump files. Leak guard v2 inspects captured process output and every generated native fixture artifact. This qualifies that isolated Node child, not forced Electron renderer, main and server crashes across the password workflow. It does not qualify clipboard expiry after death.

## Verification record

Raw command output and machine evidence live in `/work/fuigo-builds/swarm-b/bld-hlpw3/evidence/`. Fixture evidence is also generated under `.test-tmp/bld-hlpw3/fixture/` and `.test-tmp/bld-hlpw3/f6-fixture/` before collection. The fixture uses `launchVerificationServer`, an explicit URL Doctor call, fake engines, fake provider clients and isolated data. Its real HTTP check proves refusal of forged native sessions. It does not prove successful authenticated native submission.

The HTTP leak check enumerates every persisted regular file, refuses symlinks and unknown special entries, and records empty directories and runtime sockets separately. It scans all file bytes before shutdown, after shutdown and after restart. The original scanner's refusal of missing, unreadable and empty evidence is unchanged. Tests also cover positive controls and encoded or binary leaks through the existing v2 scanner suite.

RED assertion runs preceded the completion service, body reader, native session parser, renderer mounting, IPC service, expiry handshake, process memory protection and analytics settings. Later integration assertions strengthen that coverage. Initial renderer test discovery attempts found no tests because the new file was absent from the existing include list; those attempts are not RED evidence. The later renderer RED run executed assertions. Two new test harness mistakes were corrected without relaxing behavior assertions: an unread body cannot have an allocated parser buffer, and jsdom source reads must use filesystem paths. Native context channel snapshots were extended with the four exact new inbound channels; their equality and trust assertions remain intact. Outbound events do not require an inbound channel class.

All tests and compilation use `/work/fuigo-builds/tools/it-remote.sh`, `IT_JOB=bld-hlpw3`, this worktree, the requested original wrapper and network none. The job wrapper waits while host load is above 60. Container event receipts are collected to audit owned concurrency and cleanup. No Mac, live HighLevel account, live user application, real password or billable operation was used.

## Acceptance boundaries

This native-password matrix is historical. MAIN ruling 2 retires its operation-specific native requirements and replaces every row with the [redesigned acceptance matrix](../../../../lanes/hl-userscreate/ACCEPTANCE.md). That matrix is the active users.create lane contract; deleting native tests does not close its replacement checks.

| Row | Status | Executed M variants killed | Remaining requirement |
| --- | --- | --- | --- |
| R1 | Partial | M1: 1 | Production native admission, full grants, scopes and a complete owner workflow remain unavailable. |
| R2 | Partial | M2: 6 | Nonce, route and host dispatch boundaries are tested. The complete authenticated native session workflow is not qualified. |
| R3 | Partial | M3: 11 | Transport, nonce, policy, renderer and stale session refusals are tested. Native bot read and input denial across every bot is not implemented. |
| R4 | Implemented | M4: 3 | Generator and exact custom validation retain their tests. IPC accepts supported custom values within the bounded body rather than imposing a separate 512 character limit. |
| R5 | Partial | M5: 3 | Application mounting and settlement retention are tested. Native access loss and the full packaged interaction matrix remain unqualified. |
| R6 | Partial | M6: 3 | Copy remains closed without independent ownership aware retention. No real helper covers process death, quit, suspend, failed clearing, history and sync. |
| R7 | Partial | M7: 3 | Fixed errors, transport projection and existing echo guards are tested. Complete native application sinks remain unqualified. |
| R8 | Partial | M8: 3 | Durable identity claims are now constructed in production. The full process crash and UI replay matrix remains unqualified. |
| R9 | Partial | M9: 2 | Existing conservative bounded recovery tests remain. Production scopes and complete process crash qualification remain missing. |
| R10 | Partial | M10: 3 | Existing positive controls, host artifacts, HTTP refusal artifacts and the native child are scanned. Full successful desktop flow interception is missing. |
| R11 | Partial | M11: 9 | Real Linux core and parent memory denial is qualified. Native capture and input adapters, Windows dump prevention and the full Electron crash matrix are missing. |
| R12 | OPEN | M12: 2 | No packaged desktop workflow or five second usability evidence on macOS, Windows or Linux. This box lacks Electron and a virtual display. |

M1 through M12 remain acceptance requirements. Executed primitive, host, protocol and Linux native variants are listed by the mutation runner and its source restoration hashes. Those kills do not close the unimplemented native clipboard, capture, input or packaged variants. Final counts, packaged attempts and cleanup receipts are appended after execution.

## Final execution results

Full UI, server and Flux conformance typecheck passed in `final-gates-2.log`. That same command passed 62 focused tests across eight files, the UI build, the bundled server build and isolated packaged server smoke. The copied server started outside the repository with no node_modules in reach, all 27 spawned proxy paths resolved inside its directory and packaged MCP traffic flushed successfully. This is packaged server qualification only.

The broad run executed 15,894 tests across 65 files. It passed 15,893 tests and failed one existing exact source layout assertion because the new desktop marker interrupted the established proof block. The implementation was rearranged to preserve that block. The assertion was not changed and passes in the final 62 test followup. There is no claim of one final broad run with exit zero. Independent final neighbour checks passed 41 tests across five files. Final Electron and shared source boundary checks passed 56 Node tests. The native Linux qualifier also passed independently.

All 49 executed mutation variants failed their named assertions against green baselines. Every source restoration hash matches. Counts are shown in the table above. `mutants/results.json` records each variant, exit status and kill. A native variant that omits Linux dumpable protection is killed by actual OS qualification, rather than a source string check. Unimplemented platform and clipboard variants remain open.

The authoritative shared public leak guard v2 passed in the required container against an isolated Git fixture containing exactly the staged added lines. Its unmodified script and pattern file were copied with hashes, no exclusions were added and the result is zero added line matches. The real staged diff was also scanned directly with the same pattern bytes. This public source check is distinct from the generated secret scanner used on host, HTTP and native fixture artifacts.

A Linux desktop directory package was attempted with `electron-builder --linux dir --x64 --publish never` under network none. It reached Electron 43.8.1 packaging and failed fetching the absent runtime with `EAI_AGAIN github.com`. The earlier preflight also found no Electron executable and no virtual display. No packaged interactive desktop, theme, focus, custom entry, five second usability or successful native HighLevel workflow is claimed. Windows and macOS desktop qualification was not run. The Mac prohibition was respected.

One final gate attempt fell back to the local container while its selected remote was full and failed because local node_modules were absent. It is recorded as infrastructure failure, not a behavior RED or a passing gate. The subsequent remote command passed full typecheck, focused tests, both builds and packaged server smoke. Raw failing attempts remain available alongside corrected runs.

Cleanup retains logs, hashes, scanner results, fixture receipts and the copy review in the external job evidence directory. Generated dependencies, UI and server output, native binaries, temporary Git fixtures and owned containers are removed after collection. The preexisting first round evidence directory is preserved.
