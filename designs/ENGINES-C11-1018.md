# C11: OpenCode tool-count recovery, 1.0.18

Status: implementation blocked, not completed or deferred. This document is a handoff contract, not an implementation or review verdict.

The relaunch instruction explicitly authorizes this lane to implement C11 itself; Grok availability is no longer an implementation restriction. The driver owns the subsequent Grok and Astra reviews. Upstream `5e5f5dcb7` and its turn-mcp/mcp-gate modules remain absent. A fresh cross-mount catalog gate and engine catalog replacement/recovery path are still unimplemented; the existing ACP code does not provide either. This is missing implementation, not an approval blocker.

## Required behavior

A provider rejection explicitly naming a maximum tool count should teach the exact OpenCode route a smaller catalog budget and permit one bounded recovery before any model output or action. A generic invalid-parameter, authentication, rate-limit, or context-length error must never teach a tool limit. A rejection after any tool request or output must never replay the prompt automatically.

The cache identity must include the selected model, provider route, binary identity and credential scope (hashed, never raw credentials). A different account or endpoint must not inherit the limit. A learned value must be a finite positive integer within a fixed implementation cap, and learning may only reduce the budget. Bound the cache and expire entries so an upgraded model can recover. Native OpenCode tools count against the same provider limit; an MCP-only count cannot claim a total limit.

## Required integration

The catalog reducer must operate on the actual catalogs sent to this turn, after access filtering, across *all* mounts. It must preserve required control/permission tools. Stable deterministic selection is necessary: parallel MCP list arrivals, pages, refreshes and notifications must not spend the same budget twice. Omitted tools must not be callable through a new recovery alias. No scope, mount provenance, permission gate or capability token changes during recovery.

This tree constructs mounts in `server/drivers/acp/core.ts` (`acpMcpServers`). It does not own all tool lists there: arbitrary command mounts and the Cloud launcher's permitted relays are separate processes. Adding a limit only to `openai-chat-tools.ts`, or truncating one remote server's list, does not fix C11. Dropping every MCP mount after a rejection also does not satisfy the feature.

Recovery must replace the engine's catalog before retrying (not merely change a host-side array). It must preserve conversation history and images, respect Stop and submission revocation, and execute `beforeSubmit` again immediately before the second prompt write with no intervening await. Report unavailable tools in the recovery prompt. Do not reuse a poisoned failed turn or silently duplicate the owner's prompt in history. A second rejection ends recovery; it does not loop.

## Tests to write before implementation

1. Recognized tool-limit rejection versus unrelated errors; malformed, negative, fractional and huge limits; nested provider error envelopes.
2. Account/model/endpoint/binary isolation, expiration, bounded cache, and monotonic lowering.
3. Sum across native tools and all MCP mounts; pagination, duplicate list responses, concurrent mounts, late list changes and required tools larger than the budget.
4. Fake ACP engine rejects the first prompt, receives the reduced effective catalog and succeeds exactly once on retry; another route remains unchanged.
5. Output/tool request before rejection, Stop during catalog reload, revoked submission and second rejection never cause another prompt write.
6. Access filtering, mount provenance and tool-call authorization remain enforced for retained and omitted tools on desktop and Cloud.

The implementation must resolve catalog interception against the Cloud launcher; the upstream patch, if supplied, is reference material and not automatically portable. All remaining work stays in 1.0.18. No READY row is justified by this document.
