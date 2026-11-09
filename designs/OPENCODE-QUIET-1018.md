# OPENCODE-QUIET: redesign in 1.0.18

Status: preferred stderr observer implemented and verified against the public OpenCode 1.19.5 binary. Driver-owned Grok/Astra review and W3 remain outstanding. The shared-file reader and fallback supervisor are not used.

## Implemented architecture: observe the running engine's own stderr

OpenCode ACP starts with `acp --print-logs`. A fresh process belongs to one turn; it is not pooled. The existing stderr pipe supplies a per-turn parser attached before spawn. No filesystem log reader, second launch or helper process is introduced.

The real offline capture and reproduction script are in `server/testing/fixtures/opencode-quiet/`. The fixture uses only a loopback fake provider and isolated HOME/config/data/cache directories. It covers a new session, loading that session, title generation and overlapping sessions. Main `stream error` records carry exact `session.id`, `small=false`, `agent=build`, and `mode=primary`; title failures carry `small=true agent=title`. stdout remains ACP JSON-RPC. Unknown grammar fails closed; no compatibility claim is made for every CLI version.

Cloud accepts the existing exact `acp` form and the new exact `acp --print-logs` form. Probe argv remains unchanged: `models --verbose --print-logs` is rejected. Other appended/reordered/duplicated flags are rejected.

Implementation: `server/drivers/acp/opencode-quiet.ts`, ACP core stderr/prompt/progress/termination hooks, `turn.diagnostic` in the runtime contract, and the production server event fold. Diagnostics bypass the watchdog/capability subscriber and local VM lease touches. They persist as completed Murage activity notices in direct and room threads.

## Turn ownership and privacy

A new per-turn parser attaches before spawning. It rejects records before the prompt fence, records with a different exact ACP session id, title/small requests, malformed or duplicate fields, oversized records and unsupported record shapes. It is never attached to a reused process. On cancellation or settlement it stops accepting records and drops partial buffers. Increment a reply generation on actual engine progress; pending notices retain that generation and are discarded if it changes before emission. Never use a delayed stderr delivery timestamp to prove freshness.

Only allowlisted error categories should leave the parser (authentication, rate limit, unavailable provider, tool-count rejection). Do not quote arbitrary provider text, request bodies, URLs or log fields in the UI. That eliminates an additional raw-error disclosure channel. Bound records to 8 KiB, aggregate parsing work per tick, keep at most three distinct categories per turn, and stop parsing when the turn ends. The existing bounded crash-stderr capture remains independent.

After 60 seconds of silence, emit a dedicated `turn.diagnostic` event for the pending category. It is neither `item.*`, `content.delta`, `runtime.error`, nor `turn.retrying`. It must not reset the core idle timer, watchdog, room activity, browser leases or outstanding-tool bookkeeping. A later reply suppresses only pending diagnostics; it cannot recall one already displayed.

The server renders the event as an activity notice with no tool spinner or error/retry action. Copy reports the category and elapsed quiet time without promising a retry. The actual watchdog limit remains unchanged. The real runtime subscriber, not a duplicate test implementation, must prove that diagnostic delivery does not touch the watchdog. Direct and room paths both need coverage.

## Fallback if stderr cannot establish ownership

Use an in-namespace ACP transport supervisor started with the engine, not a helper launched later. The supervisor is the *only* writer of ACP stdin. For every `session/prompt`, it takes `(dev, ino, size)` on the log immediately before forwarding those prompt bytes. That synchronous boundary is the cursor; session id plus cursor identify this prompt. It emits sanitized diagnostics on a separate framed channel and never mixes them into ACP stdout. Rotation or shrink discards existing contents; partial records remain buffered until newline with a strict size cap.

The supervisor must be a named, allowlisted part of the same launcher invocation and namespace on Cloud, with the same engine uid and teardown ownership. Desktop must use the identical cursor/parser contract. One supervisor belongs to one engine process; because OpenCode is not pooled, no cross-turn shared registry/refcount is required. Reading shared desktop logs still requires exact session filtering. An optimization that shares readers would require a new lifecycle design and is excluded here.

This fallback requires a launch-protocol design and a real log fixture before implementation. `engineJob()` alone does not place a helper inside a Cloud namespace; a second `cloudTurnLaunch` invocation cannot observe the original tmpfs home. No time window or one-MiB tail substitute is acceptable.

## Test-first acceptance

- Captured real record grammar, exact session filtering, title filtering, duplicate keys, escaped quotes, oversized and incomplete records; only allowed categories escape.
- Pre-prompt and previous-session records never emit; post-prompt failure emits while quiet; engine progress suppresses a pending diagnostic; already-shown diagnostics remain.
- At most three distinct notices; bounded buffers and work; no parsing after cancellation, settlement, failed spawn or child exit.
- Actual server subscribers: diagnostic causes zero watchdog touches, no room tool-start, no browser release and no open-tool mutation; notice persists and renders in direct and room threads.
- Fake ACP process: mid-turn diagnostic precedes completion, original silence timeout still fires, exact process is gone at turn end.
- Cloud allowlist admits only the verified turn argv; arbitrary probes/flags stay rejected. No second helper launcher invocation.
- If fallback is chosen: prompt forwarding cannot precede cursor capture, a refused submission forwards no bytes, rotation/shrink never replay, and loaded sessions do not replay earlier-turn errors.

The real 1.19.5 fixture resolves the prior grammar prerequisite. Review and real-engine W3 evidence remain required. The full release suites and release/base regression comparison belong to the driver.
