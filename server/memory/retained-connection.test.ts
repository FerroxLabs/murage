import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { openTurnLineage, closeTurnLineage, addTurnParents } from "./lineage-write.ts";
import { prepareRetainedFence, assertRetainedFence } from "./send-fence.ts";
import { WritetimeFixture, CONTENT } from "./testing/writetime-fixture.ts";

it("a retained generation cannot borrow a second connection even to the same installation", () => {
  const f = new WritetimeFixture().reply("T", "X", 1), refused = vi.fn();
  f.db.exec("PRAGMA journal_mode=WAL");
  const other = new DatabaseSync(String(f.db.prepare("PRAGMA database_list").get()!.file));
  const turn = openTurnLineage(f.db, { threadId: "T", turnId: "connection-bound" });
  try {
    prepareRetainedFence(turn, CONTENT, refused, f.db);
    addTurnParents(turn, [{ kind: "line", threadId: "T", messageId: "X" }]);
    expect(() => assertRetainedFence(turn, f.db)).not.toThrow();
    expect(() => assertRetainedFence(turn, other)).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(refused).toHaveBeenCalledTimes(1);
  } finally { closeTurnLineage(turn); other.close(); f.close(); }
});

it("reader preparation cannot replace the connection captured when the generation opened", () => {
  const f = new WritetimeFixture(), refused = vi.fn();
  const other = new DatabaseSync(String(f.db.prepare("PRAGMA database_list").get()!.file));
  const turn = openTurnLineage(f.db, { threadId: "T", turnId: "prepare-connection-bound" });
  try {
    expect(() => prepareRetainedFence(turn, CONTENT, refused, other)).toThrow("MEMORY_CONTEXT_REVOKED");
  } finally { closeTurnLineage(turn); other.close(); f.close(); }
});
