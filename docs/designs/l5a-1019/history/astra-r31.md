1. **High — R1 still allows a retired ID to become clean after tombstone eviction.**  
   **Location:** [design:81](/work/swarm1018/D-REDACT-MD-mac/designs/D-REDACT-MD-r31.md:81), [design:87](/work/swarm1018/D-REDACT-MD-mac/designs/D-REDACT-MD-r31.md:87), T-E at [design:272](/work/swarm1018/D-REDACT-MD-mac/designs/D-REDACT-MD-r31.md:272).

   **Failure sequence:** start T → open T with `**password**: x` → retire T → retire enough other IDs to forget T → receive `turn.started(T)` → the `else` branch creates `{open:false}` → admit `hunter2` → release it on both carriers. “Unknown reads masked” does not prevent `turnStarted` from making that unknown ID clean. T-E stops immediately before the failing repeated start.

   **Required fix:** separate fresh-turn allocation from observing `turn.started`. Have a registry-owned allocator generate and register fresh IDs; let `turnStarted` only refresh an existing live state and never create state for an unknown ID. Update driver ID allocation accordingly, preserving IDs during retries. Extend T-E through repeated start, delta and completion after forgetting; test an old ID’s repeated start after registry restart too. A2-r3 is not closed.

2. **High — the live allowlist preserves arbitrary engine payload under familiar keys.**  
   **Location:** [design:151](/work/swarm1018/D-REDACT-MD-mac/designs/D-REDACT-MD-r31.md:151); actual unconstrained payloads at [server/contracts.ts:166](/work/swarm1018/_base18-ro/server/contracts.ts:166), [pi.ts:1253](/work/swarm1018/_base18-ro/server/drivers/pi.ts:1253), [codex.ts:2008](/work/swarm1018/_base18-ro/server/drivers/codex.ts:2008).

   **Failure sequence:** open T → emit a tool event with `input: {type:"hunter2", status:"hunter2"}` or a tool completion with the same object in `result` → `withholdEvent` preserves those leaves because its exceptions apply to **keys at any depth** → the bus delivers and logs the secret. Likewise, Pi copies `evt.toolName` into `toolIdentity.name`; the design explicitly preserves that identity even though the code does not establish it as a trusted fixed value.

   **Required fix:** mask payload subtrees without key exceptions. Restore only explicit top-level structural paths, with enum-value validation. Preserve tool identities only after validation against a trusted tool catalog; mask unvalidated engine-supplied names and kinds. Add nested `type/status/itemId` payload tests and an unknown tool-name test. G-M3 remains incomplete; this is a new High in the proposed live gate.

3. **Medium — repeated resets still discard an unfinished label history.**  
   **Location:** [design:128](/work/swarm1018/D-REDACT-MD-mac/designs/D-REDACT-MD-r31.md:128); real reset paths at [pi.ts:1183](/work/swarm1018/_base18-ro/server/drivers/pi.ts:1183), [acp/core.ts:3912](/work/swarm1018/_base18-ro/server/drivers/acp/core.ts:3912); scanner state at [md-secret-label.mjs:85](/work/swarm1018/_base18-ro/shared/md-secret-label.mjs:85).

   **Failure sequence:** `**pass` → reset → `wo` → reset → `rd**: hunter2`. After the first continuation, pending represents `**passwo`, while the fresh scanner represents `wo`. The second reset replaces pending with `wo`; neither remaining scanner recognizes `password`, and the native sequence can retain the assembled secret. T-RS tests adjacent resets without intervening bytes, which misses this case.

   **Exact code fix:** in `resetStream`, retain pending when the fresh scanner is empty. If both pending and a nonempty fresh scanner exist, call `openTurn` before discarding either history. Add the sequence above through Pi and ACP, plus cap-boundary coverage for pending state. G-M1 is not closed.

4. **Medium — the claimed universal intake ordering does not match ACP or openai-chat.**  
   **Location:** [design:176](/work/swarm1018/D-REDACT-Mac/designs/D-REDACT-MD-r31.md:176), [design:190](/work/swarm1018/D-REDACT-MD-mac/designs/D-REDACT-MD-r31.md:190); [acp/core.ts:2280](/work/swarm1018/_base18-ro/server/drivers/acp/core.ts:2280), [acp/core.ts:4321](/work/swarm1018/_base18-ro/server/drivers/acp/core.ts:4321), [openai-chat.ts:1221](/work/swarm1018/_base18-ro/server/drivers/openai-chat.ts:1221), [openai-chat.ts:1314](/work/swarm1018/_base18-ro/server/drivers/openai-chat.ts:1314).

   **Failure sequence:** implementing ACP admission at the repeatedly specified line 2280 affects `idleLine`, whose comment explicitly says no turn owns the process. Active output reaches a different intake at 4321. For openai-chat, streamed callbacks emit deltas while `complete()` is pending; the native incoming completion is logged afterward. Admission inside the cited `native` helper cannot supply those earlier live tokens.

   Missing tokens fail closed, but break ordinary streaming; independently minting tokens at every emit abandons the promised single decision unless the design defines that flow.

   **Exact code fix:** admit ACP active frames in `handleStdoutLine` immediately before line 4321 and carry the decision into notification handling; keep idle output explicitly unowned. For openai-chat, admit transformed callback output before emitting, and separately admit its later whole completion before logging. Specify that driver’s distinct ordering. Extend T-DRV to all seven scoped drivers, including Stop during streaming and buffered-output flushes. Existing static field checks cannot establish these properties. G-M5 and the universal R2 closure remain incomplete.

5. **Medium — Pi’s build instructions reverse the transform/admission order required by its security rule.**  
   **Location:** [design:126](/work/swarm1018/D-REDACT-MD-mac/designs/D-REDACT-MD-r31.md:126) versus [design:386](/work/swarm1018/D-REDACT-MD-mac/designs/D-REDACT-MD-r31.md:386); actual filter use at [pi.ts:1234](/work/swarm1018/_base18-ro/server/drivers/pi.ts:1234).

   **Failure sequence:** engine emits `**pass<todo>x</todo>word**: hunter2`. Following the build brief—filtering `a.text`—admits bytes before deletion constructs `**password**:`. Admission therefore misses the label; the native/live projections no longer implement §3.2’s common filtered stream.

   **Exact code fix:** compute `out = todo.push(e.delta)` first—the actual API is `push`, not `feed`—then admit `out.text`, replace the native delta with that admission’s projection, and emit its live projection. Route filter-flush text through the same helper. Remove the contradictory “todo filter on `a.text`” instruction and assert T-DRV-pi(d/e) through actual intake and flush paths.

6. **Medium — both gates mask already-produced markers again, contradicting the closing oracles.**  
   **Location:** [design:142](/work/swarm1018/D-REDACT-MD-mac/designs/D-REDACT-MD-r31.md:142), [design:151](/work/swarm1018/D-REDACT-MD-mac/designs/D-REDACT-MD-r31.md:151), [design:167](/work/swarm1018/D-REDACT-MD-mac/designs/D-REDACT-MD-r31.md:167); existing idempotent mask at [redact.ts:36](/work/swarm1018/_base18-ro/server/redact.ts:36).

   **Failure sequence:** an open turn completes with `hunter2`. Step 5 produces `«redacted 7 chars»`; step 8 masks that 18-character marker into `«redacted 18 chars»`. Native closed deltas have the same problem: the driver substitutes `a.native`, then `withholdFrame` masks it again because only an **opened** token receives the `keep` exception.

   A fresh nonstreamed completion also conflicts with T6/T-OWN(d): `maskItem` produces the label-preserving output and opens the turn, then recomputed `masked` causes step 8 to replace the entire output.

   **Exact code fix:** mask each field once. Have the live gate preserve its own computed `maskItem` result while withholding the event’s other payload fields. For native records, withhold the original frame first, then install the validated admission’s native projection at the exact delta path. Add full serialized-event and native-record assertions, not just secret-absence checks. A4-r3’s oracle closure remains incomplete.

7. **Low — the oversized torn-file test expects behavior that `capExisting` removes first.**  
   **Location:** T-X(b) at [design:286](/work/swarm1018/D-REDACT-MD-mac/designs/D-REDACT-MD-r31.md:286); [native.ts:72](/work/swarm1018/_base18-ro/server/drivers/native.ts:72), [native.ts:306](/work/swarm1018/_base18-ro/server/drivers/native.ts:306).

   **Failure sequence:** create the specified file already over `SEGMENT_BYTES` with a torn suffix → append → `capExisting(current)` reconstructs valid records and drops the invalid suffix before rotation. Therefore `previous` cannot reliably retain the torn suffix as T-X(b) requires; rotation itself is not guaranteed after compaction.

   **Exact test-code fix:** construct a torn current segment at or below `SEGMENT_BYTES`, then choose the incoming record so their combined size forces rotation. Assert the torn suffix in `previous`. Add a separate oversized-file case expecting compaction to discard the suffix. No production change is needed for this finding.

The closing table is therefore only partially closed. Beyond the findings above, inspection found no independent defect in the proposed closures for:

- **Text rules:** A1-r1, A2-r1, A4-r1, A7-r1, A1-r2, G1-r2; the E1–E10 literals and corrected fixture citations are consistent with the inspected code. G4-r1, G5-r1, G3-r2 and G-M2 have concrete corrections.
- **Native/restart/Stop rules:** A3-r1, A5-r1, A8-r1, G1-r1, G2-r1, A4-r2 and G2-r2 have identifiable rules and tests, subject to the lifecycle and torn-file gaps above.
- **Whole completions and gate placement:** A1-r3/G-H2, A2-r2 and G-H1 have appropriate masking rules; A6-r1/G3-r1 and A3-r3/G-M4 have appropriate architectural changes, but the driver and serialization findings prevent accepting their end-to-end closure.
- **Other closures:** A3-r2’s per-ID reset isolation, G-L1’s native discriminator allowlist, G-L2’s post-rotation placement, G-L3’s recency refresh, and G-L4’s inspected retry behavior are supported. G-L5’s cited fixture corrections are accurate, although the ACP intake citation remains wrong.

Crash, restart, Stop, concurrent turns, overlapping process generations, late completion and stale reset each have a named rule and test. The missing transitions are **forgotten ID → repeated start**, **reset → continuation bytes → another reset**, and driver-specific asynchronous/buffered delivery. Those omissions matter within the stated scope.

This was a design review by read-only inspection. No builds, tests, scripts or mutations were performed. The requested memory tool was unavailable, and `.ijfw/memory` was absent.

**OUT OF SCOPE**

No additional findings. The verdict excludes detector vocabulary, table-cell handling, renderer behavior, phone-withhold policy and the other expressly excluded areas.

VERDICT: BLOCK