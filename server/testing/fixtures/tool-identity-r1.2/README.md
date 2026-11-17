# Tool identity r1.2 executable fixtures

Copied byte-identically from `/work/build/nolimint-redesign/spec` on 2026-11-10.

- `hermes_traces.jsonl`: 104 hand-authored trace expectations; SHA-256 `b1c99df61d4943a0d1bad58bff648d908dfe95dc2e5882dff237eaa8337d0625`.
- `hermes_fsm.py`: normative reference; SHA-256 `fbcd5429849e40ba096585e354938dcbed8be10a418ed3c0207bf3c47f0b5f41`.
- `judge_expected.tsv`: S4a reader corpus, preserved for integration; SHA-256 `bca5ba97c9d70a49ea7c8d274969b8ec17d79f87b274383c0870c9e405097134`.

`shared/tool-identity-r12.test.ts` loads JSONL directly, verifies all three hashes, checks the hand-authored expectations, and uses `reference.py` to run the unchanged Python reference for complete outcome comparison. Python 3 is required; its absence fails a test assertion. The helper does not rewrite fixtures or expectations. The TSV's reader verdict parity belongs to S4a, not S1.
