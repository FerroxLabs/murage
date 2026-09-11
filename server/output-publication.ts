// Automatic publication of trusted outputs (U-02 shell outputs, image
// producers). K0 skeleton: both hooks are wired into server/index.ts and do
// nothing until R3-T3 (terminal sweep) and R3-T4 (image receipts) fill them.
// Contract: shared/output-publication.ts and docs/plans/0152-CONTRACTS.md.
import type { DatabaseSync } from "node:sqlite";
import type { ArtifactScope } from "./artifacts.ts";
import type { RuntimeEvent } from "./contracts.ts";
import type { Store } from "./store.ts";

export type TerminalTurnEvent = Extract<RuntimeEvent, { type: "turn.completed" }>;

/** Facts known at dispatch, after the workspace claim and before the
 * provider sees the prompt. */
export interface DispatchOutputContext {
  botId: string;
  threadId: string;
  /** Dispatch claim id for this turn (the run id receipts record). */
  runId: string;
  /** Canonical working folder of this turn, when it has one. */
  workspaceRoot: string | undefined;
  /** True only for the Murage-managed dedicated task workspace (U-02). */
  managed: boolean;
}

export interface OutputPublicationDeps {
  dataDir: string;
  database: () => DatabaseSync;
  store: Store;
  artifactScopes: () => ArtifactScope[];
}

export interface OutputPublisher {
  /** Called synchronously at dispatch. Must not throw or block. R3-T3 takes
   * the U-02 `outputs/` snapshot here. */
  beforeDispatch(context: DispatchOutputContext): void;
  /** Called once per turn.completed from the main event fold, outside the
   * direct-run lease release. Failures are recorded as receipts; the
   * returned promise should not reject. */
  publishTerminalOutputs(event: TerminalTurnEvent): Promise<void>;
}

export function createOutputPublisher(_deps: OutputPublicationDeps): OutputPublisher {
  return {
    beforeDispatch() {},
    async publishTerminalOutputs() {},
  };
}
