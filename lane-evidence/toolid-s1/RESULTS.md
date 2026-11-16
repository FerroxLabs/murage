# S1 r1.2 verification result

- Collection recovery: 18/18 tests executed and passed.
- RED before r1.2 implementation: 18 executed; 17 failed assertions, one passed.
- Canonical JSON: 6/6 passed.
- Identity profiles and wire: 14/14 passed.
- Direct reference trace parity: 104/104 passed, zero mismatches (99 Hermes, five Codex; includes 14 I*/U-*/BIND-* cases).
- Fixture integrity and classifier/C1 rules: 4/4 passed; immutable JSONL/TSV/Python SHA-256 checks passed.
- Driver-held reload/teardown: 6/6 passed against an isolated fake ACP child.
- Inventory and class structure: 3/3 passed; all 16 patterns covered, all 83 reference P10 reads have dispositions.
- Hermes configuration and D5: 79/79 passed.
- ACP approval delivery: 32/32 passed.
- Runtime event redaction: 76/76 passed.
- Server TypeScript: passed, zero errors (`final-status.txt`; empty `typecheck-final.log`).
- Isolated server workflow: 5/5 control commands succeeded (doctor/new-bot/send/wait/messages); wait settled, bot response observed, fixture data removed. Exact results and copied server log retained.

No immutable corpus expectation was edited. No live app or user data was used. S3/S4a/S5/S6 integration and the MAIN G5 install attestation remain outside this lane, as recorded in IMPLEMENTATION.md.

Cleanup: no job containers remained on murage-vt1, vt2, vt3 or vt6; this job's worktree node_modules was removed on each. No local node_modules, dist, build output or Python bytecode was created. Shared dependency caches were left in place.
