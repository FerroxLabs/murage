import { releaseProbe } from "../testing/baseline-contract.ts";
import { writeClaudePrompt } from "../testing/claude-release-fixture.ts";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { fencedTurnInput } from "../drivers/engine-input.ts";
import { openTurnLineage, closeTurnLineage } from "./lineage-write.ts";
import { buildPrompt, promptPart, ownReplayRefs } from "./prompt-parts.ts";
import { CONTENT, WritetimeFixture } from "./testing/writetime-fixture.ts";
import type { TurnLineage } from "./lineage-types.ts";
let fixture: WritetimeFixture | undefined, turn: TurnLineage | undefined;
afterEach(() => { releaseProbe.atWrite = undefined; releaseProbe.writes = 0; if (turn) closeTurnLineage(turn); fixture?.close(); turn = undefined; fixture = undefined; });
it("R1 prompt: competing writer is busy at actual stdin enqueue, then commits and prevents next enqueue", async () => {
  const f = fixture = new WritetimeFixture().reply("T", "X", 1);
  f.db.exec("PRAGMA journal_mode=WAL");
  turn = openTurnLineage(f.db, { threadId: "T", turnId: "atomic" });
  const second = new DatabaseSync(String(f.db.prepare("PRAGMA database_list").all().find(row => row.name === "main")!.file));
  second.exec("PRAGMA busy_timeout=0");
  const hide = () => second.exec("INSERT INTO memory_deny(kind,id,epoch,created_at) VALUES('thread','T',1,0)");
  const prompt = buildPrompt(turn, [promptPart(releaseProbe.marker, ownReplayRefs("T", ["X"], "content"))]);
  const input = fencedTurnInput({ threadId: "T", prompt }, { reader: CONTENT, db: f.db, ...{ retained: turn } });
  const order: string[] = [];
  try {
    releaseProbe.atWrite = () => {
      try { hide(); order.push("hide-committed"); }
      catch (error) { expect(String(error)).toMatch(/locked|busy/i); order.push("hide-busy"); }
      order.push("bytes");
    };
    await writeClaudePrompt(input);
    expect(releaseProbe.writes, "non-vacuous actual enqueue").toBe(1);
    expect(order).toEqual(["hide-busy", "bytes"]);
    releaseProbe.atWrite = undefined;
    hide();
    await writeClaudePrompt(input).catch(() => undefined);
    expect(releaseProbe.writes).toBe(1);
  } finally { second.close(); }
}, 30_000);
