# Seat 1d verification

RED evidence correction: the original missing-module/uncommitted-constructor
logs below do not establish behavioral failures. The reproducible original-base
witnesses and candidate GREEN evidence in [afix-verification.md](afix-verification.md)
supersede those RED claims. Historical logs are retained unchanged.

Base: `5daadeac8ebbdc4100d9b9f2805c5e4135262c5a`.

RED: Node missing bridge; server 4 failures at the explicit unimplemented boundary and 1 passing strict-schema control. GREEN: 10 Node tests and 10 server tests, all passed. Both named mutants were injected into product code and failed assertions; the runner restores product bytes in `finally`.

All runs used `it-remote.sh`, `IT_JOB=hl-c1-secret-policy`, the assigned worktree and generic local fallback, network none. At most two containers were active; subsequent test/typecheck runs are serial to preserve remote evidence. The first full `pnpm typecheck` returned exit 0. A final full typecheck with a retained log will follow policy integration. No Node test was executed on the host.

The isolated fixture used `launchVerificationServer`, a fake engine, temporary home/data and an explicit URL for Doctor. Doctor returned `ok:true`; `fixture.stop()` removed its temporary data and owned child. No OAuth workflow or live HighLevel call was exercised. Source owns the future server route integration; this seat supplies its coordinator and main bridge.

Leak guard v2 at the adapter publication: 0 added-line matches; 582 inherited whole-tree finding lines, all in files unchanged from base. No exclusions or shared tool edits.

# Seat 1e contract and vectors

S0 dependency is 0a `b4e1462a2d`, merged without modifying its files. Expected scopes/readers/counts for all 36 actually implemented ready F1/F2 rows are handwritten in `scope-policy.vectors.ts`; the equality check fails if an additional implementation appears without a vector. Other families retain explicit owner-adoption requirements. Extra G2 cases cover ID/name/empty custom fields, unique user references, body-ID upsert and pipeline membership, six/500 targets, exact course-import scope/empty-reader exception, PIT refusal, immutable deterministic digests, all 17 family projections and unplanned-reader schema refusal.

The initial upsert vector included `contactId`, which the frozen upsert argument schema rejects. Its corrected independent vector uses the qualified pipeline-only schema. Explicit-contact coverage remains in opportunity create/search, where the row accepts it. No product schema or expected behavior was weakened.

The policy-level `M-SCOPE-AFTER-FIRST-READ` injects a forbidden first read before missing-scope refusal under fake fetch; zero-I/O assertions must kill it. This module intentionally has no ownership/read hook to reorder. C2-host still owns the separate integrated mutant that moves its real ownership call before full scope validation. No host/client behavior is claimed here.

Final full-typecheck iteration caught one new TS2345 in `scope-policy.ts`: the inferred manifest map key was the template-literal `OperationId`, while the planner intentionally accepts arbitrary strings to refuse unknown rows safely. The map is explicitly keyed by `string`; this is an erased type annotation, with no runtime behavior change. The red log is retained in the job evidence directory. The final full typecheck is rerun after this fix.

# Final GREEN

Final focused run: **115/115** assertions across scope policy (85), secret coordinator (10), S0 planning (6), existing contract freeze (10) and frozen snapshot (4). Electron bridge: **10/10**. Total: **125/125**. Final full `pnpm typecheck` exited **0**; its command/log and exit marker are retained. `node --check` passed main/preload and the permission-inventory publisher imported the policy under Node's native type stripping. The isolated fixture's Doctor returned `ok:true` and its owned process/data were stopped/removed.

All six named mutants were rerun against the final product bytes and assertion-killed: `M-SECRET-ACTIVATE-BEFORE-COMMIT`, `M-OAUTH-REFRESH-TO-HOME`, `M-SCOPE-CUSTOMFIELD-ID-SKIP`, `M-SCOPE-SKIP-READ-PERMISSION`, `M-SCOPE-AFTER-FIRST-READ`, `M-SCOPE-PIT-ALL-WRITES`. Product files were restored in `finally`; no mutant is retained as implementation.

Product ownership remains within seats 1d/1e. Dependency merge: only S0 0a; no client, host, server index, manifest, schema or descriptor edits by this builder. No Cloud adapter was assigned. No live provider calls, deployment, billable resource or Mac access occurred. Owner-facing strings/permission labels are in `locale-inventory.json`; S-INT/Settings own locale wiring. Source routes, host/client admission and the integrated owner OAuth/write workflow remain named consumer handoffs, not deferrals of this seat's implementation.

Design interpretation recorded: the policy late-check mutant injects a first read at the pure evaluator boundary because the actual ownership-hook reorder belongs to C2-host. There is no such hook in this module and no host/client edit is permitted in this seat. It does not substitute for C2's integrated late-check mutant. No product contract deviation was introduced.
