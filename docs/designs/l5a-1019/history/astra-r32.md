1. **High — engine-controlled property names still leak from open turns.**  
   Locations: [design:173](/root/swarm1018/D-REDACT-MD-r32/designs/D-REDACT-MD-r32.md:173), [design:229](/root/swarm1018/D-REDACT-MD-r32/designs/D-REDACT-MD-r32.md:229). Actual carrier: [pi.ts:1263](/root/swarm1018/_base18-ro/server/drivers/pi.ts:1263); existing key-preserving walk: [redact.ts:325](/root/swarm1018/_base18-ro/server/redact.ts:325).

   **Failure sequence:** allocate T → open T with `**password**:` → Pi emits a tool result `{ "hunter2": "ok" }` → withholding masks the string **value**, but preserves the property name → native and bus serialization still contain `hunter2`. No discriminator restoration is needed to exploit this. T-PAYLOAD tests secrets *under* unfamiliar keys, not secrets *in* those keys.

   **Required fix:** define withholding for property names as well as values. In the proposed `withholdEvent` and `withholdFrame`, collapse arbitrary payload dictionaries to a fixed marker, or replace their dynamic keys with generated opaque keys. Reconstruct only explicitly defined schema fields. Drop unknown top-level extension fields rather than copying their names. Add key-position sentinels in objects, arrays and extension fields, asserting complete native/bus/replay serialization.

   The original A32-H2 familiar-key **value** bypass is addressed, but R3 still has this independent payload escape.

2. **Medium — the structural allowlist turns permissions into questions.**  
   Locations: [design:173](/root/swarm1018/D-REDACT-MD-r32/designs/D-REDACT-MD-r32.md:173), [design:185](/root/swarm1018/D-REDACT-MD-r32/designs/D-REDACT-MD-r32.md:185). Required discriminator: [contracts.ts:210](/root/swarm1018/_base18-ro/server/contracts.ts:210); consumer: [index.ts:8993](/root/swarm1018/_base18-ro/server/index.ts:8993).

   **Failure sequence:** T opens → Pi emits `request.opened` with `requestType:"permission"` and possibly `approvalScope:"local-computer"` → neither field is in the explicit restoration list → both become markers → `event.requestType === "permission"` becomes false → the fold takes its question path at [index.ts:9346](/root/swarm1018/_base18-ro/server/index.ts:9346). Permission classification and approval controls no longer receive a valid event. Similarly, `request.resolved.behavior` and `.source` are required enums absent from the list.

   **Exact code fix:** add event-specific projectors in `turn-secrets.ts` for validated, host-originated `requestType`, `approvalScope`, and resolution `behavior`/`source`, using the enums in `contracts.ts`. Keep summaries, choices and nested payload strings withheld. Add tests through the actual request fold proving that an open-turn permission remains a permission and its resolution retains valid control fields.

3. **Medium — opaque request IDs have no specified response or cleanup mapping.**  
   Location: [design:185](/root/swarm1018/D-REDACT-MD-r32/designs/D-REDACT-MD-r32.md:185). Actual Pi ownership: [pi.ts:1276](/root/swarm1018/_base18-ro/server/drivers/pi.ts:1276), [pi.ts:1328](/root/swarm1018/_base18-ro/server/drivers/pi.ts:1328), [pi.ts:1697](/root/swarm1018/_base18-ro/server/drivers/pi.ts:1697).

   **Failure sequence:** Pi supplies request ID R → its pending callback is registered under R → the prescribed publication mapping exposes opaque ID H → the owner answers H → `respondToRequest` looks up H in the map keyed by R → returns `"unavailable"`. The design specifies publication identity and serialization tests, but no response-routing rule or round-trip test.

   **Exact code fix:** in Pi’s request handler, separate `engineRequestId` from a host-generated `requestId`. Register `pending`, timers and `scopedRequests` under the host ID **before publication**; capture the engine ID only inside the callback that sends `extension_ui_response`. Apply equivalent handling wherever another driver exposes engine request IDs. Define cleanup on resolution, timeout, Stop and teardown. Test answer round trips and stale answers after a concurrent replacement turn; merely checking serialized IDs is insufficient.

4. **Medium — T-DRV’s universal streaming oracle contradicts Antigravity’s whole-frame rule.**  
   Locations: [design:247](/root/swarm1018/D-REDACT-MD-r32/designs/D-REDACT-MD-r32.md:247), [design:347](/root/swarm1018/D-REDACT-MD-r32/designs/D-REDACT-MD-r32.md:347). Actual intake: [antigravity.ts:842](/root/swarm1018/_base18-ro/server/drivers/antigravity.ts:842); nonstreamed result handling: [antigravity.ts:896](/root/swarm1018/_base18-ro/server/drivers/antigravity.ts:896).

   **Failure sequence:** Antigravity receives `{event:"result", result:{response:"Hello\n**password**: hunter2"}}` → whole-frame admission opens T and withholds the frame → the subsequently derived live delta receives a closed decision → no opening head is delivered. T-DRV(b), however, requires both native and live opening-head outputs for every driver. Antigravity’s actual frame discriminator is `result`, not the table’s “response frame.”

   **Exact test-code fix:** parameterize T-DRV by actual carrier semantics. For Antigravity, feed a real `result.response` frame and assert whole native withholding, suppressed fallback delta and whole completion masking. Retain a clean-result control. Reserve split-delta/head assertions for actual delta paths; give boxagent’s cumulative snapshots their own fixtures. Correct the intake table’s frame name. Do not change production admission to satisfy the contradictory oracle.

5. **Low — T6 still treats absence of `turn.started` as absence of allocation.**  
   Location: [design:341](/root/swarm1018/D-REDACT-MD-r32/designs/D-REDACT-MD-r32.md:341), conflicting with [design:92](/root/swarm1018/D-REDACT-MD-r32/designs/D-REDACT-MD-r32.md:92).

   **Failure sequence:** allocate T → omit `turn.started(T)` → admit a clean delta → the live gate correctly delivers it because T is allocated and clean → T6 incorrectly expects nothing.

   **Exact test-code fix:** make T6’s rejection case use an ID that was **never allocated**. Add a separate allocated-but-not-started control expecting normal delivery. No production change is required.

The r31 closure audit is:

| Finding | Design-level assessment |
|---|---|
| A32-H1 | Closed: allocation is independent of observed starts; every listed tombstone-loss route includes repeated start and late carriers. |
| A32-H2 | Original value exemptions addressed; finding 1 prevents accepting complete payload withholding. Findings 2–3 affect the replacement structural scheme. |
| A32-M1 | Closed: adjacent resets retain pending history; a second nonempty history opens before loss; real Pi/ACP and cap tests are specified. |
| A32-M2 | ACP active intake and openai-chat callback ordering corrected; seven-driver acceptance remains inconsistent under finding 4. |
| A32-M3 | Closed: Pi uses `todo.push(raw)` before admission; flushes use the same path. |
| A32-M4 | Mask-once construction is specified correctly; the separate T6 allocation oracle still needs finding 5’s correction. |
| A32-L1 | Closed: rotation fixture stays within the segment cap; oversized compaction is a separate case. |

For the inherited closing-table rows:

- **Text, counts and precedence:** no additional defect found in A1/A2/A4/A7/A9-r1, G4/G5-r1, A1-r2, G1/G3-r2, A4-r3, G-M2 or G-L5. The E1–E10 formulas, fixture indices, PEM precedence and original-input span handoff are consistent with the inspected sources.
- **Lifecycle and isolation:** A3/A5/A8-r1, G1/G2-r1, A3/A4-r2, G2-r2, A2-r3, G-M1 and G-L2/L3/L4 have concrete rules and corresponding tests.
- **Whole completions and gate placement:** A2-r2, A1-r3, G-H1/H2 and the gate architecture for A6-r1/G3-r1 are specified. Their broader end-to-end withholding claims remain subject to finding 1.
- **Shared admission and driver coverage:** A3-r3/G-M4 are architecturally addressed; G-M5’s acceptance evidence remains subject to finding 4. G-M3’s value withholding is addressed, but arbitrary payload keys remain exposed. G-L1’s native discriminator restoration is explicitly constrained.

Crash, restart, Stop, concurrent threads, overlapping process generations, late completions, stale resets, repeated resets, eviction and forgotten IDs each have a named rule and test. Callback/flush races also have T-DRV-STOP/T-DRV-FLUSH. The newly introduced request-ID lifecycle lacks equivalent response/cleanup coverage.

This was read-only design review; no builds, tests, scripts or writes were performed. The memory tool was unavailable and `.ijfw/memory` was absent. These are proposed closures, not runtime verification.

**OUT OF SCOPE**

No additional findings. Detector vocabulary, L7 machine-collector implementation, Electron/feedback implementation, table-cell policy, renderer behavior, phone withholding and owner prompts outside open turns do not affect this verdict.

VERDICT: BLOCK