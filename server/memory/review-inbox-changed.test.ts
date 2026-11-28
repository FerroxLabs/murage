// A memory a bot would like to keep is counted in the Inbox's Needs you number (server/inbox-memory-waiting.ts), and the
// sidebar badge re-reads only on `inbox.changed`. Keeping or putting one off moves that number without a message write,
// so the owner route says so itself; a read of the waiting counts does not.
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { ensureScope, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { memoryOwnerRoute } from "./settings.ts";
import { onMessagesChanged } from "../inbox-version.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

function world() {
  const roster = { bots: [{ id: "bot", name: "Dax", threadId: "thread" }], groups: [] } as unknown as MemoryRoster;
  reconcileMemoryRoster(roster); setMemoryMode("capture");
  appendMessage("thread", { id: "m0", at: 1, role: "user", kind: "text", text: "The deploy window is Tuesday and reports go out Monday" });
  const work = claimMemoryJob("fixture")!; publishMemoryWork(work, "fixture", captureWork(work));
  setMemoryMode("active");
  const db = database(), scope = ensureScope("bot", "bot"), id = randomUUID();
  db.prepare("INSERT INTO memory_records VALUES(?,1,?,?,?,?,'candidate',0,?,NULL,?,?)").run(id, scope, "fact", "Reports go out on Mondays", "assistant-inference", Date.now(), null, Date.now());
  db.prepare("INSERT INTO memory_evidence VALUES(?,1,?,1,0,5)").run(id, work.sourceId);
  const inboxChanged = vi.fn();
  onMessagesChanged(inboxChanged); // what index.ts subscribes announceInboxChanged to: the sidebar's `inbox.changed` frame
  const act = (body: Record<string, unknown>) => memoryOwnerRoute("/api/memory/action", body, ownerMemoryTicket(), roster) as Promise<any>;
  return { id, act, inboxChanged };
}

it("keeping the only waiting memory tells the Inbox it changed; reading the counts does not", async () => {
  const w = world();
  const summary = await w.act({ action: "waiting-summary" });
  expect(summary.total).toBe(1);
  expect(w.inboxChanged).not.toHaveBeenCalled();
  const answer = await w.act({ action: "review-keep-all", actionId: randomUUID(), items: [{ id: w.id, version: 1 }] });
  expect(answer.kept).toBe(1);
  expect(w.inboxChanged).toHaveBeenCalledTimes(1);
});
