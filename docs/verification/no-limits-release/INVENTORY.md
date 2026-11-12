# G-NL lane C operation and release inventory

Base: `4dc262d780e5405a6873d0fbc2e514a79d62e972`. Design: AGREED r3.1, sections 6–8. This is the implemented C6/C7a/C7 inventory. Source snapshots detect changes to the listed emitters; actual provider and service fixtures establish the delivery checks described below. C6/C7a/C7 own operation extraction and delivery. C5 owns action/approval posture branching; C2 owns resolver/types; none is duplicated here.

## Exact operation inputs

| Input family | Exact source | Effects to bind and refresh |
|---|---|---|
| Shell/executable | resolved engine/MCP call input: command/cmd/script/argv, final updatedInput; request execEnv/cwd/cwdInvalid and dialect | Complete final executable, real cwd and dialect. C2/C4 inspection refreshes disk links, inode registry, dependencies, effective children and physical/logical cwd. |
| Code API | execute_code/python/python3/node/javascript exact code/script and lang | Retain exact code identity and recognized write effects; C5 shared inspectOwnerOperation inspects Python/JavaScript without a second tokenizer. |
| Native write/edit | path/file_path/filePath/filename/notebook_path, paths/files, native locations, per-edit entries | Every destination, content/metadata effect, original call identity; no display or count cap. |
| Native unlink/delete | exact named path and removed paths | Parent traversal; final unlink semantics distinct from write-through. |
| apply_patch | original string or input/patch/command in toolCall | All Add/Update/Delete and Move-to paths; rename old source and new destination; shared strict parseApplyPatch, no regex replacement parser. |
| Codex native file change | params.fileChanges or bound prior fileChange item; grantRoot | Every entry in array/map; kind and move path; readFileChanges/codexNativeEditCall provide complete paths/removals. |
| Multi-edit/multi-file | entries/edits/changes/files and nested supported operation shapes | Preserve operation index/role and every destination beyond 64/128/256; reject false checked release if integrity capture cannot retain the actual operation. |
| ACP | merged toolCall facts (rawInput, kind, locations, tool stamp), command and cwd | resolveCall identities; native patch source and locations; no summary extraction. |
| Native link/relocate | recognized source,target/link value,destination roles when exposed by a request | Same request envelope for typed effects; C3 roles and C4 taint, no invented shell. |
| Service immediate/queued | authoritative frozen ServiceCall plus original delivery content, attachment queue identity/epoch | Complete input and hash; both async and sync executions; durable approved evidence coverage. |

## Provider last observable allow seams

Each row records the real sender, caller, authorization source and required check. A Full access bypass is immediate and retains its legacy bytes.

| ID | File / emitter | Caller / authoritative input and authorization | Implemented guard placement |
|---|---|---|---|
| CX-HOOK | drivers/codex.ts openHookAsk.finish -> deliverNative -> resolveAnswer | onPreTool -> real routeDelivery(noLimits) -> request.opened -> S1 registration/automatic answer; original delivery.tool_input/toolCall, final updatedInput | In finish, after rewrite, before resolving an allow HookAnswer. Bind request key/generation/exact operation. |
| CX-NATIVE | drivers/codex.ts handleServerRequest.finish -> deliverNative -> send | item/commandExecution/requestApproval, execCommandApproval, item/fileChange/requestApproval, applyPatchApproval and MCP permission; real registered ask | After native input extraction and before accepted/approved/accept frame. |
| CX-CACHE | drivers/codex.ts issuedHere.final -> send | final successful hook answer by tool-use ID; cache must retain exact operation and registration binding, not destinations/allow bit | Fresh guard before final cache replay; a missing bound native operation cannot authorize an edit. |
| CX-SHORTCUT | drivers/codex.ts onPreTool route.allow | routeDelivery own-workspace/own-unasked/local-ordinary/custom/external | Full access parity. NL true always routes ask before these; do not force owner tests here. |
| CX-AUTO | drivers/codex.ts autoAccept -> send | fullAuto && !approvalNow; production posture dispatch | Full access parity. No fabricated owner branch. |
| CL-BROKER | drivers/claude.ts broker.finish -> deliverNative -> conn.write(t:answer) | settle/answer -> pending.ask; updatedInput; real broker turn binding supplied by create | Before socket write; permission allow only. settle and answer share the same check. |
| CL-AUTO | drivers/claude.ts judgeAskWithPosture -> broker.settle(auto) | claudeInProjectAllow; NL explicitly excluded | Full access own-workspace twin; retain exclusion and broker check. |
| PI-GATE | drivers/pi.ts pending callback -> deliverNative -> send(extension_ui_response) | piGateAsk exposes gateInput/toolCall, final narrowed input; real registered ask | Before allow:true input/keep or confirmed:true; permission versus question retained. |
| AG-RELAY | drivers/antigravity.ts relay finish -> deliverNative -> answer | exact relay ask input/name/cwd, turn authority; answer via respondToRequest | Before decision:allow response. |
| AG-READ | drivers/antigravity.ts known read allow -> answer | static ANTIGRAVITY_ASK_READS | Pure read bypass, no filesystem write effects; classify explicitly and pin list. |
| ACP-PERM | drivers/acp/core.ts permission.finish -> deliverApproval -> sendPermission | merged CallFacts, registerOnAllow; real options and exact call; caller respondToRequest | Before selected allow_once/allow_always outcome, every retry immediately before sendPermission. |
| ACP-AUTO | drivers/acp/core.ts fullAuto sendPermission selected | permissionNow gate and existing fullAuto; tool call bound at dispatch | Full access twin; ensure NL cannot enter without registration. |
| ACP-MEMORY | drivers/acp/core.ts ownedMemoryAlias -> sendPermission selected | authenticated own mount, NL explicitly excluded | Full access parity; guard generic native seam covers any reachable NL permission. |
| ACP-HOST | drivers/acp/core.ts askHostAction.finish -> resolveAsk | exact call.name/call.arguments and live turn; computer mount waits for this answer | Guard before resolving allow to the host mount. ACP advertises fs.readTextFile/writeTextFile false, so there is no enabled ACP file-write RPC sink in this runtime. |
| ACP-TRUST | drivers/acp/core.ts folder/process trust finish -> send(outcome:trust) | folderTrust request; scope configAndCommands; native process/session continuation | Classify separately from a named write operation. Every subsequent executable/native permission still uses ACP-PERM; preserve Full access/trust question policy. |
| MUSE-APPROVAL | drivers/muse-code.ts respondToRequest -> decide -> ownedCommand(approval/decide) | pending native MuseApproval, subject/rawArgs, same host/active turn and once choice | Immediately before approved choice command, after any awaited admission. |
| CHAT-TOOL | drivers/openai-chat.ts runToolCall -> MCP invoke | exact routed MCP name/input, driver-supplied executionCwd matching the child process, final decision.updatedInput, live pending registered ask | Immediately before actual MCP execute, after answer consumed; preserve denial and cancellation. Relative native paths use the actual child cwd, including on fresh disk inspection. |
| GENERIC-NATIVE | drivers/native-ask.ts deliverNative -> write | provider-specific bound operation from preceding rows; slot protects only frame dedup, not authorization | All write callbacks have exact-operation guard; an optional unbound allow cannot stand in for it. |
| GENERIC-ANSWER | drivers/answer-delivery.ts AnswerDelivery.deliver -> send | generation/requestId/answerId/answer hash, plus the private authoritative Entry binding | Keep operation binding through retries; answer hash alone is not executable identity. |
| GENERIC-REQUEST | drivers/request-delivery.ts respond -> original adapter | actual request.opened, generation; explicit/legacy answers | Do not infer authorization from answerId or event display; guard at provider final dispatch too. |

`fuigoagent.ts` re-exports ACP Fuigo; `grokagent.ts` uses ACP; `grok.ts`, `minimax.ts`, and OpenAI compatible drivers use shared `openai-chat.ts`. They inherit the inventoried emitters. `drivers/native.ts` is a redacted protocol **log** writer, not an approval emitter. `drivers/murage-exec.ts` installs the shell prefix and per-turn environment; the engine must obtain its Claude broker decision before invoking the executable wrapper; the wrapper itself is an environment/cwd executor, with no authorization channel. Pin wrapper/env identity and pass the final command through CL-BROKER. Question/form acceptance is a data answer and must never be mistaken for tool permission.

## Service and central dispatch seams

| ID | File / sender | Caller / authorization source | Implemented check |
|---|---|---|---|
| S1-ENGINE | decision/implementation.ts send.respond -> DecisionTransport.respond | authoritative Entry/Registration and captured snapshot; durable row/ref for owner answers | Fresh exact operation per attempt, before any engine allow; changed evidence creates a deny card. |
| S1-QUEUE | decision/implementation.ts send.respond -> QueueRecoverySource.respond | matching durable queue item, input hash and epoch | Same check, preserving exact queued call and durable approved evidence. |
| S1-RECOVER-QUEUE | decision/implementation.ts recoverQueueRun -> q.respond | durable run receipt, reopened verifier claim and exact item.call | Fresh bound-operation guard before recovered queue allow; refresh live authority and approved evidence. |
| S1-EXEC | decision/implementation.ts executeService -> execute(call) | claim-authenticated Entry, captured executionCall | Fresh check inside final promise callback before execution, not only refresh before scheduling. |
| S1-EXEC-SYNC | decision/implementation.ts executeServiceSync -> execute(call) | same Entry; one-execution/dedup contract | Fresh check immediately before callback. |
| S1-PRESENT-QUEUE | decision/implementation.ts presentApproval/presentApprovalSync stale-deny RUN paths -> send/respondNow | same authoritative row/queue/call | Bind/guard automatic queue release, including changed-policy refresh. |
| S1-MODE | decision/implementation.ts onLevelChange and entryRelease | live authenticated posture plus retained neutral complete input; immutable content is retained by reference | Entering No limits binds the original operation and refreshes protected facts; BASE auto conversion grants no protected evidence. Current Full access releases through its legacy bypass. Legacy protected cards without a No limits evidence sidecar renew before a fresh approval. |
| S1-ANSWER-SYNC | decision/implementation.ts answerApprovalSync -> respondNow | issued durable ref, exact pending item checked by input hash | Fresh operation and approved evidence coverage before accepting. |
| NARROW-QUEUE | narrow-denials.ts respond/respondNow and waiting acceptance | ProducerQueuePort bound through index.ts; exact registered ServiceCall | Keep C6 guard on acceptance and on eventual executeService/Sync, including durable recovery. |
| MEMORY-QUEUE | memory/service-approval.ts respond/respondNow | registered service call; issuer claim and exact queue item | Same async/sync guard; later memory authority executes through S1. |
| MEMORY-APPLY | memory/authority.ts applyRegisteredMemory | executeServiceSync registered call | Covered by S1-EXEC-SYNC; verify no raw callback bypass. |

Every key in shared/permission-card.ts QUEUE_REF_PATHS must flow through these central queue/execute seams. The structural test must flag a new unclassified provider emitter or service callback. A source search alone cannot count as runtime coverage.

## Runtime coverage and evidence

C6: `server/decision/no-limits-release-1019.test.ts` covers every exact-operation family, disk changes, service execution, effective children, physical cwd, inode-registry refresh, complete patch/multi-file inputs, unchanged protected approvals, and evidence coverage. C6 RED/GREEN and four executed mutation diffs are under `evidence/nlsym-build-C2/`.

C7a: `server/drivers/no-limits-codex-release-1019.test.ts` drives the real hook route, native command/patch/MCP approvals, successful hook-cache replay, fresh-card continuation and unchanged Full access shortcut/autoAccept frames. Three executed mutants cover native omission, cached allow replay and Full access divergence. Original Full access snapshots remain unchanged.

C7: `no-limits-provider-release-1019.test.ts` drives real Claude broker, Pi gate, Antigravity relay, ACP stdio permission/host action and Muse SDK command transports using inert fake engines. Each executable/native writer has an ordinary RUN twin and a disk change between the central decision and the final native writer. Tests inspect actual native bytes and absence of allow frames; fresh protected-card approvals resume held native requests. `no-limits-chat-release-1019.test.ts` drives the actual MCP child after both pre-consumption and post-item.started barriers, including fresh approval continuation. `no-limits-queue-release-1019.test.ts` covers sync queue acceptance, cleared-deny automatic RUN and authenticated durable queue recovery. `no-limits-release-integrity-1019.test.ts` covers complete raw input identity, reference epochs, approval retries and native protocols which cannot rewrite the original operation. `no-limits-release-rulings-1019.test.ts` exercises R-CARD, R-OPERAND, cumulative tar roots and shared code inspection through the release reader.

A guard refusal preserves the pending native slot and re-arms its delivery receipt only after the failed attempt completes. Cached Codex replay reopens with a fresh receipt epoch, preserving successful original hook delivery. A protected evidence change terminalizes the old immutable permission card and creates a new presentation for the durable operation; an issuer epoch prevents old references and automatic transport retries from approving the new evidence. The approval ref is captured once per explicit answer. Native protocols which cannot apply narrowed input recheck their actual original operation before emitting allow. Refreshed engine cards expose a new public requestId bound to their immutable message/evidence epoch; requestRef and the durable row retain the native pending request ID. `server/index.ts` refuses old HTTP answer keys instead of redirecting them to a fresh card. Clients continue posting the requestId of the card actually shown.

## User-facing string handoff

| English string | Where shown and meaning |
|---|---|
| Permission changed before release | Terminal answer on the old permission card when fresh release inspection finds changed protected evidence. A new card requires its own explicit answer. |

The AST snapshot also covers `request-transport.ts`, final guard calls, receipt reopening, queue acceptance/execution callbacks and the index approval routing seam. A new provider emitter or service callback requires classification and a real runtime test. Pure read bypasses, questions, trust continuations, logs and inherited Full access shortcuts are classified above and are not treated as write authorization.

`evidence/nlsym-build-C2/fixture.mjs` uses launchVerificationServer with separate fixture data/home and inert Claude broker inputs. Its twelve scenarios cover native writes, shell writes, effective copy children, physical cwd, inode registry changes and late protected-card retargeting. Transcript, exact fixture URL/dataDir, doctor/wait/messages, native answer bytes, event stream and cleanup confirmation are retained in fixture.json and fixture-server.log.gz. No live application or user data is used.

Limits follow the agreed reader contract: inspection occurs immediately before the observable allow/execute boundary; it does not provide kernel enforcement against changes after that boundary or inspect opaque archive payloads. A Muse SDK admission failure after a newly queued command can terminate that turn; no protected allow command is written. Normal held requests can receive a fresh explicit approval. Broad contract tests retain three inherited NotBuilt expectation failures, reproduced against the C6 baseline; no contract assertion was weakened.
