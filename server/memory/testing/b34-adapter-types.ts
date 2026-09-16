// Structural, type-only mirror of the B34 adapter join types exported by
// scripts/b34-receipt-matrix.ts (Claude 5 runner v3, Q14-CONTRACT-R6 PASS, sha256
// 69fbb75fef1c9aee6c928347f30c94965b654c1b9cfd95498831185251029c78). That file is
// absent from this worktree, so importing it would break
// `tsc -p tsconfig.server.json` here. Member names and signatures are copied
// exactly so an adapter typed against this mirror is assignable to the
// runner's types; the runner itself loads adapters by runtime shape. At
// integration, root may switch adapters to
// `import type { ... } from "../../../scripts/b34-receipt-matrix.ts"` instead.
// Mirrored runner lines: 58-60 (AdapterRow, AdapterSpec), 147-165 (identifiers
// and Q14 readback), 209-227 (ADAPTER_ARTIFACTS, as plain TS types instead of zod
// schemas), 280-281 (Q14Artifacts, Q14Variant), 542 (Check), 617-620 (Bot, Dump,
// Api, SetupVerify) and 629-646 (B34AdapterContext, B34Adapter). The Q14 shapes
// follow the contract's v3 types block (B34-ADAPTER-CONTRACT.md "Contract v3
// types for Claude 4"). No runtime code.
import type { DatabaseSync } from "node:sqlite";

export type AdapterRow = "Q03" | "Q06" | "Q13" | "Q14";
/** A join row names the exact adapter module and export the runner loads when that file exists. */
export interface AdapterSpec { row: AdapterRow; module: string; export: string }

// Adapter artifacts: identifiers and synthetic canaries only, never bodies, test
// reports or secrets. The runner's strict zod schemas refuse any extra field;
// the length, integer, regex and min(1) constraints live only in those schemas
// (mirrored at runtime by b34-adapter-harness.ts).
/** { id: identifier(1..200), version: positive integer } */
export type AdapterRecordRef = { id: string; version: number };
/** { record, sourceIds: identifier[] (min 1) } */
export type AdapterDistilledRecord = { record: AdapterRecordRef; sourceIds: string[] };
/** { match: 8..200 chars, canary: 6..120 chars } */
export type AdapterMarked = { match: string; canary: string };
/** identifier / revisionId: 1..200 */
export type AdapterRevisionTask = { threadId: string; revision: string };

// Q14 readback (contract v2, kept by v3): each entry names one product fact, how
// to read it and the value the adapter observed. The runner re-reads every entry.
export type Q14ReadbackFact =
  | "current-revision" | "published-revision-in-history" | "earlier-task-pin" | "next-task-pin"
  | "post-rollback-task-pin" | "rollback-history-entry" | "budget-lease-charge";
export type Q14ApiReadback = {
  fact: Q14ReadbackFact; via: "api"; method: "GET";
  path: string;      // max 400; apiPathRefusal: starts with /api/, no whitespace, "..", "#" or secret-like words
  pointer: string;   // max 400; RFC 6901, at least one token
  observed: string;  // 1..400; must not appear inside path
};
export type Q14SqliteReadback = {
  fact: Q14ReadbackFact; via: "sqlite";
  sql: string;                      // max 1000; selectRefusal (single-table SELECT, "?" only in WHERE)
  params: Array<string | number>;   // max 8; strings max 400, numbers integer; count equals "?" count
  column: string;                   // /^[A-Za-z_][A-Za-z0-9_]{0,63}$/ and equal to the selected output name
  observed: string;                 // 1..400; must not equal any param
};
export type Q14Readback = Q14ApiReadback | Q14SqliteReadback;
export type Q14Variant = {
  reviewId: string;     // /^procedure-review:/, max 400; the product snapshot.requestId (review row id)
  receiptId: string;    // 1..200
  evaluator: string;    // 1..200
  heldout: { corpusDigest: string /* 64 lowercase hex */; untouched: true; cases: number /* positive int */; baseline: number; candidate: number /* > baseline */; regressions: 0 };
  budget: {
    authorityReference: string;   // 1..200; the procedure-evaluation-grant id (session and charges grantId)
    costKnown: true; actualCostUsd: 0;   // scripted loopback tier only
    leaseCharge: string;          // /^[1-9][0-9]{0,15}$/; equals the runner's own extract-budget $.output read
  };
  publication: { kind: "skill" | "routine"; artifactId: string; baseRevision: string; publishedRevision: string };  // routine: JSON.stringify([instructionRevision, updatedAt])
  earlierTask: { threadId: string; revisionAfterPublication: string; revisionAfterRollback: string };
  nextTask: AdapterRevisionTask;
  rollback: { fromRevision: string; toRevision: string; nextTask: AdapterRevisionTask };
  readback: Q14Readback[];  // exactly 7, one per Q14ReadbackFact
};
// harness: the contract's v3 block writes `variants: [Q14Variant, Q14Variant]`.
// The runner's zod schema is z.array(...).length(2), which infers Q14Variant[],
// so the mirror uses the array type to stay mutually assignable with the copied
// schemas (b34-adapter-harness.ts B34ArtifactMirrorMatchesRunnerSchemas). The
// runtime rule is unchanged: exactly 2 variants, one skill and one routine.
export type Q14Artifacts = { row: "Q14"; variants: Q14Variant[] };

export type AdapterArtifacts =
  | {
    row: "Q03"; extractorInstanceId: string; distilled: AdapterDistilledRecord[];
    correction: { superseded: AdapterRecordRef; current: AdapterRecordRef };
    refused: Array<{ sourceId: string; outcome: "failed" | "cancelled" | "interrupted" }>;
    reuse: AdapterMarked; staleWithheld: AdapterMarked;
  }
  | {
    row: "Q06"; readiness: { sourceId: string; sourceRevision: number; indexed: AdapterRecordRef };
    distractorSourceIds: string[]; supplied: AdapterMarked; isolation: Array<{ match: string }>;
  }
  | {
    row: "Q13"; extractorInstanceId: string;
    budget: { sourceId: string; deferredReason: "budget-exhausted"; withheldWhileExhausted: AdapterMarked; recovered: AdapterDistilledRecord };
  }
  /** exactly 2 variants: one skill, one routine */
  | Q14Artifacts;
/** The artifacts one row's adapter returns from run(). */
export type AdapterArtifactsFor<R extends AdapterRow> = Extract<AdapterArtifacts, { row: R }>;

export type Check = { name: string; status: "PASS" | "FAIL"; detail?: string };

export type Bot = { id: string; threadId: string; name: string; modelSelection: { instanceId: string; model: string } };
export type Dump = { pid: number; argv: string[]; prompt: { message: { content: string } }; systemPrompt: string | null };
export type Api = { status: number; body: any };
export type SetupVerify = (response: Api) => { ok: boolean; note?: string };

/** What a join adapter receives: the runner's isolated server, without direct memory seeding or receipt access. */
export interface B34AdapterContext {
  row: AdapterRow; url: string; dataDir: string; fixtureDumpPath: string; fixtureFinishGateDir: string;
  api(method: string, path: string, body?: unknown): Promise<Api>;
  action(body: Record<string, unknown>): Promise<Api>;
  setup(name: string | null, method: string, path: string, body: unknown, expected: number, verify?: SetupVerify): Promise<Api>;
  bot(name: string): Promise<Bot>;
  /** Direct message (optionally to another task thread); the request is recorded as runner-observed with its thread. */
  send(bot: Bot, text: string, hold?: boolean, threadId?: string): Promise<Dump>;
  /** Waits for a fake Claude request containing match (room or held turns) and records it as runner-observed without a thread. */
  dispatched(match: string, timeout?: number): Promise<Dump>;
  settled(kind: "bot" | "channel", id: string): Promise<void>;
  until<T>(label: string, read: () => T | undefined | Promise<T | undefined>, timeout?: number): Promise<T>;
  restart(): Promise<void>;
  check(name: string, ok: boolean, detail?: string): void;
  /** Read-only connection to the isolated profile database. */
  db(): DatabaseSync;
}
export interface B34Adapter { row: AdapterRow; launch?: { instrumentationSource?: string }; run(ctx: B34AdapterContext): Promise<unknown> }
