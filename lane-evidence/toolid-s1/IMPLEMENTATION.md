# bld2-toolid-s1 — r1.2 section 4 (a)–(e)

The previous draft's collection failure is resolved: the first container rerun executed 18 tests, all passing. The subsequent RED run executed 18 tests: 17 failed assertions and one passed, before the r1.2 implementation. See `collection.log` and `r12-red.log`. The historical `red.log`/`STOP.md` describe the superseded attempt only; there is no review stop condition on this build.

(a) `shared/tool-identity.ts` ports `classify_ask` as `classifyAsk`, `start_identity` as `startIdentity`, and the pinned kind and seven-name C1 tables. Canonical JSON sorts recursively by Unicode code point without normalization. The prior Fuigo/ACP/Claude profiles and brand/wire parser are retained. Codex includes the captured Bash/MCP mapping and same-id Bash/apply_patch fileChange pairing.

(b) There is no wire `binding` field or server-held execution-start proof. `DriverAskRecord` keeps a frozen original ask frame, identity, canonical frame and private binding slot. ACP `asks` holds this beside `finish`; persisted card answers return their frame to that live record. Changed/missing frames or identities cause runtime.error and reject; an absent live request sends nothing. The server persists and forwards evidence, not a start-frame binding. The reference correlation API fills the private binding with an edit obligation or terminal execution/token.

(c) `codemap/tool-identity-sites-r12.out` and `.sh` are copied from the reference. The reference has 244 total lines, including headings, containing 226 hit rows and 83 P10 rows. `APPROVAL-IDENTITY-SITES.md`, `TOOLNAME-READS.md`, and the exported `APPROVAL_IDENTITY_SITES` registry include a disposition per original and current hit. The structural inventory test fails on an unlisted source hit. It follows rg's binary-file exclusion and 220-byte truncation; the baseline source `fuigo.ts` contains NUL and is excluded by the normative script.

(d) C1 is exactly seven names. C2 write_file/patch remain separately excluded from the hook. Default D5 drops administrator pre_tool_call hooks on bot turns; `refuse` throws before overlay installation/engine prompt.

(e) Vitest loads the immutable JSONL directly, including all I*, U-* and BIND-* identity cases. Full 104-trace outcome parity is also exercised to cover their correlation dependencies. Every Hermes trace compares result, trip_at, sent, overlay and performed against the unchanged Python reference, with empty unperformed required for all must-accept traces. Hashes guard JSONL, TSV and reference Python.

Integration boundaries: S3 still owns replacing the legacy core `ToolTripwire.record/accepts` path with the exported `HermesCorrelation` API and production native-edit/command binding. S5 owns the remaining policy/native-emitter migrations listed in the registry; the versioned ACP ask wire is now available for that migration. MAIN must supply verified installation evidence through `toolIdentityContext`; version-only evidence does not satisfy G5/R1. S4a owns judge TSV verdict parity; S6 owns the 40 TS mutants. These are not claimed complete by this S1 lane.

Memory prelude: no `ijfw_memory_prelude` tool is exposed, no `ijfw` executable was found, and `.ijfw/memory` is absent in this worktree. The supplied AGENTS.md and verification README were followed.
