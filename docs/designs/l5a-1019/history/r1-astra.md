1. **High — New regression: U can expose a PEM body that BASE18 masks.** [Design:22](</mnt/Scratch/work/104-lastresort-evidence/handoffs/designs/D-REDACT-MD-1018-r1.md:22>), [Design:64](</mnt/Scratch/work/104-lastresort-evidence/handoffs/designs/D-REDACT-MD-1018-r1.md:64>); [redact.ts:117](/mnt/Scratch/work/W1-BASE18/server/redact.ts:117), [redact.ts:202](/mnt/Scratch/work/W1-BASE18/server/redact.ts:202). **Confirmed by tracing the specified algorithm.**

   Failure sequence:
   - Input is `**password**: [RSA private-key header]\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,abcdef\n\nSENSITIVEBASE64BODY\n[RSA private-key footer]`.
   - U stops at the blank line and replaces the opening PEM header and metadata.
   - The subsequent PEM rule cannot find its opening header. The remaining body survives unless it independently matches another credential rule.
   - BASE18’s PEM scanner searches through blank lines to the footer and masks that body.

   This contradicts §2.5’s claim that U and A agree on PEM credentials. Preserve complete existing secret spans before replacing overlapping text, and add this regression to the user-text and channel tests.

2. **High — Chained empty labels still defeat multiline quote protection.** [Design:33](</mnt/Scratch/work/104-lastresort-evidence/handoffs/designs/D-REDACT-MD-1018-r1.md:33>), [Design:36](</mnt/Scratch/work/104-lastresort-evidence/handoffs/designs/D-REDACT-MD-1018-r1.md:36>); [shared detector:47](/mnt/Scratch/work/W1-BASE18/shared/md-secret-label.mjs:47). **Confirmed design counterexample.**

   Input: `**token**:\n\n**password**: "alpha\n\nTAILSECRET9"`.

   The label-only loop consumes the password block, then stops because it contains `alpha`. But quote detection still starts after the **first** separator. Its first non-mark character is `p` in `password`, not `"`. No quote extension occurs; `TAILSECRET9"` survives. Ordinary text rules do not mask that bare suffix.

   U4 and U6 test these features separately, missing their composition. Track the actual value opener through skipped labels and test chained labels followed by quoted and fenced values.

3. **High — “First entry is a delta” does not close STREAM-RESTART.** [Design:76](</mnt/Scratch/work/104-lastresort-evidence/handoffs/designs/D-REDACT-MD-1018-r1.md:76>); [native.ts:225](/mnt/Scratch/work/W1-BASE18/server/drivers/native.ts:225), [native.ts:301](/mnt/Scratch/work/W1-BASE18/server/drivers/native.ts:301). **Confirmed design counterexample.**

   Failure sequence:
   - Process A logs `**pass`, then restarts.
   - Process B first logs a `system/status`, ping, or `control_request interrupt` for that thread.
   - The proposed `seenThreads` rule marks it warm.
   - Its next delta, `word**: hunter2`, creates fresh pending state. Neither the incremental detector nor the per-frame sink sees the complete label; `hunter2` is written.

   These are precisely the non-reset frames enumerated in [native-md-stream.test.ts:110](/mnt/Scratch/work/W1-BASE18/server/drivers/native-md-stream.test.ts:110). They cannot establish a trusted boundary merely because they occur after restart.

   There is also an unspecified cross-field case: the first cold delta contains only `text`, followed by a continuation in `thinking`. The proposed branch inside `maskStreamField` runs only for present fields, while `seenThreads` becomes warm for the entire thread. Explicitly protect **all three fields**, including absent ones, until a proven boundary. Test every non-reset frame before the first continuation and every field ordering. Design lines 77–78 also contradict each other about whether lifecycle rows warm a thread.

4. **High — The stated algorithm is quadratic on chained empty blocks.** [Design:33](</mnt/Scratch/work/104-lastresort-evidence/handoffs/designs/D-REDACT-MD-1018-r1.md:33>), [Design:48](</mnt/Scratch/work/104-lastresort-evidence/handoffs/designs/D-REDACT-MD-1018-r1.md:48>), [Design:89](</mnt/Scratch/work/104-lastresort-evidence/handoffs/designs/D-REDACT-MD-1018-r1.md:89>). **Confirmed complexity defect; timing unmeasured.**

   Feed `**token**:\n\n` repeated *n* times, followed by `hunter2`. Each iteration calls `valueless(text[sepEnd:Rend])` over the entire accumulated prefix. Normalization revisits approximately 1, 2, …, *n* blocks: Θ(*n²*) work.

   The proposed clock uses `**token**:\n`, which forms one block and misses this path. This synchronous function reaches engine error handling, where inputs can be large; BASE18 explicitly documents the event-loop hazard at [redact.ts:66](/mnt/Scratch/work/W1-BASE18/server/redact.ts:66). Use incremental block classification and add blank-separated chains to the clock tests.

5. **High — Same-thread process overlap has no isolation rule or test.** [Design:82](</mnt/Scratch/work/104-lastresort-evidence/handoffs/designs/D-REDACT-MD-1018-r1.md:82>), [Design:116](</mnt/Scratch/work/104-lastresort-evidence/handoffs/designs/D-REDACT-MD-1018-r1.md:116>); [native.ts:178](/mnt/Scratch/work/W1-BASE18/server/drivers/native.ts:178), [claude.ts:4821](/mnt/Scratch/work/W1-BASE18/server/drivers/claude.ts:4821). **Confirmed logger counterexample; production timing remains plausible, not reproduced.**

   Failure sequence: old process P has latched thread T’s text field → replacement process Q logs its `type:"user"` prompt → the shared T/text latch resets → P emits a late `hunter2` continuation → it is written as fresh text.

   This deserves a concrete driver test: Claude replacement calls `closeSession` at [claude.ts:4329](/mnt/Scratch/work/W1-BASE18/server/drivers/claude.ts:4329), closure allows a five-second grace at [claude.ts:3087](/mnt/Scratch/work/W1-BASE18/server/drivers/claude.ts:3087), and incoming frames reach `appendNative` **before** retired-session filtering. T-C tests different threads and different fields, not different process generations sharing a thread. Specify generation isolation or prove and test that old output cannot reach this logger after the reset.

6. **High — The deferred user-visible bypass check already fails: raw replies reach SSE and replay.** [Design:142](</mnt/Scratch/work/104-lastresort-evidence/handoffs/designs/D-REDACT-MD-1018-r1.md:142>); [acp/core.ts:4158](/mnt/Scratch/work/W1-BASE18/server/drivers/acp/core.ts:4158), [runtime-event-out.ts:80](/mnt/Scratch/work/W1-BASE18/server/runtime-event-out.ts:80), [index.ts:8781](/mnt/Scratch/work/W1-BASE18/server/index.ts:8781). **Confirmed pre-existing gap, not a new regression.**

   ACP emits a delta containing `**password**: hunter2`. `windowRuntimeEvent` returns that event unchanged; `broadcast` serializes it, retains it in the replay buffer, and sends it to eligible clients at [index.ts:6017](/mnt/Scratch/work/W1-BASE18/server/index.ts:6017). Later store redaction cannot retract those bytes. Assistant-text completion events also pass through this projection unchanged.

   The design explicitly defers this surface, so it must remain an open finding rather than support an overall user-visible-redaction closure. A builder grep is not an acceptance test for streaming or replay.

7. **Medium — Quote extension breaks the universal idempotence guarantee.** [Design:41](</mnt/Scratch/work/104-lastresort-evidence/handoffs/designs/D-REDACT-MD-1018-r1.md:41>), [Design:44](</mnt/Scratch/work/104-lastresort-evidence/handoffs/designs/D-REDACT-MD-1018-r1.md:44>). **Confirmed design counterexample.**

   Input: `**password**: "alpha\n\nTAILSECRET9" Keep this.\n\nNext`.

   First pass extends through the closing quote, then preserves ` Keep this.` on the newly collapsed label line. Second pass sees a marker **plus prose** in that block, fails `isExactMarker`, and masks both. Thus `f(f(x)) != f(x)`, and repeated application deletes additional prose. Define stable output boundaries and test text following a cross-block closer.

8. **Medium — Crash recovery relies on behavior `capExisting` does not provide.** [Design:80](</mnt/Scratch/work/104-lastresort-evidence/handoffs/designs/D-REDACT-MD-1018-r1.md:80>); [native.ts:71](/mnt/Scratch/work/W1-BASE18/server/drivers/native.ts:71), [native.ts:314](/mnt/Scratch/work/W1-BASE18/server/drivers/native.ts:314). **Confirmed source mismatch.**

   Crash during an append to a file smaller than 4 MiB → leave a partial final JSON record → restart → `capExisting` returns immediately because the file is below the segment limit → the next record is appended directly to the partial record. The resulting line is invalid and can lose the new record too.

   T-X’s module reset does not simulate a partial write. Add an explicit recovery rule and fixture cases below and above the segment threshold. The cited `child-teardown.ts` also describes bounded, potentially unconfirmed shutdown; it does not establish the blanket crash guarantee that children always die with the server.

9. **Medium — Several acceptance tests contradict the algorithm or inherited behavior.** [Design:105](</mnt/Scratch/work/104-lastresort-evidence/handoffs/designs/D-REDACT-MD-1018-r1.md:105>), [Design:108](</mnt/Scratch/work/104-lastresort-evidence/handoffs/designs/D-REDACT-MD-1018-r1.md:108>), [Design:115](</mnt/Scratch/work/104-lastresort-evidence/handoffs/designs/D-REDACT-MD-1018-r1.md:115>), [Design:137](</mnt/Scratch/work/104-lastresort-evidence/handoffs/designs/D-REDACT-MD-1018-r1.md:137>). **Confirmed specification conflicts.**

   - **T-S:** `**password**: ` already creates a latch. The first subsequent `sendIn` clears that latch at [native.ts:205](/mnt/Scratch/work/W1-BASE18/server/drivers/native.ts:205); `still hunter2` is then written. The expected second-prompt reset applies to an unfinished **pending** label, such as `**pass`, not an already-latched stream.
   - **T4:** U replaces the entire remainder of `Fuigo: **api key**: hunter2secret moved to ~/x`. It necessarily removes `~/x`; the test requires that path to remain.
   - **T1 versus U8:** T1 requires removal of every secret piece listed in the original corpus. That corpus explicitly lists `hunter2secret` for row 9 at [md-secret-label.test.ts:53](/mnt/Scratch/work/W1-BASE18/server/md-secret-label.test.ts:53), while U8 requires keeping it.
   - **G3:** Existing native tests begin with bare deltas, without a warming prompt. The new cold rule masks their prefixes, so byte-identical output is impossible. Keeping those fixtures unchanged also makes eviction and line-cap tests exercise an immediate cold latch instead of their intended paths.

   Separate warm-stream fixtures from cold-restart fixtures and reconcile the expected outputs before implementation.

The closure accounting is:

| Claimed closure or inherited protection | Review result |
|---|---|
| Brackets, punctuation, fake/glued markers, 1,024-character quote cap, double-backtick tail | U covers the listed isolated examples by replacing whole spans. |
| Pass-3 leading-space quote and escaped quote examples | Covered as written; chained-label composition remains open under finding 2. |
| Blank-value lines, chained labels, eight-line overflow | Basic examples covered; composition and complexity remain open. |
| Outward-delivery concern | Unresolved: finding 1 disproves the claimed equivalence for existing credential shapes. |
| Pi USER-TEXT sink | Correct integration point: [pi.ts:227](/mnt/Scratch/work/W1-BASE18/server/drivers/pi.ts:227). Redaction precedes path folding and truncation; T3 is consistent. |
| ACP Fuigo USER-TEXT sink | Correct integration point: [acp/core.ts:2240](/mnt/Scratch/work/W1-BASE18/server/drivers/acp/core.ts:2240). Redaction precedes truncation; T4’s preservation expectation is wrong. |
| STREAM-RESTART | Not closed; finding 3. |
| Existing eviction, 64 KiB truncation, latch-capacity Mediums | Fail-closed code and tests exist; new fixture behavior must preserve meaningful coverage. |
| Existing reset Medium / mid-reply-reset High | BASE18 resets only on `type:"user"` as the final ledger ruling requires. T-S misstates that behavior; same-thread generation overlap is unaddressed. |
| Existing Electron marker High/Medium, quadratic port, oracle coverage | Present in [diagnostics.mjs:79](/mnt/Scratch/work/W1-BASE18/electron/diagnostics.mjs:79) and [diagnostics.test.mjs:520](/mnt/Scratch/work/W1-BASE18/electron/diagnostics.test.mjs:520); no execution claim made. |

Every requested transition has a named test, but coverage is insufficient: **crash** lacks torn-write recovery; **restart** lacks preceding non-delta frames and absent-field continuations; **Stop** has an incorrect oracle; **concurrent turns** omit same-thread generations; **eviction** needs warm fixtures that actually reach eviction.

Verified checkout HEAD: `a5450e2b532fdb4e66dc8aaf1a1c83f20422dc41`. Findings are based on source and design tracing only. No builds, tests, scripts, live-app access, or writes were performed.

VERDICT: BLOCK
