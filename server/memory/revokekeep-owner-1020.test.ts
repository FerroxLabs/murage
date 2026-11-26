// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.20 revokekeep. Owners: revokekeep-1020 builder owns the keep decision (send-fence.ts keepOwnerTurn), the dropped-ref and redaction
// state on the open turn (lineage-write.ts dropRetainedParents/redactTurnText) and the stored-reply redaction (message-db.ts redactRevoked);
// ownerfb-1020 owns the held-recall fallback and the notice copy (one quiet line per reply, the same notice key as the pending case).
//
// SEAN RULING (binding): a memory context revoked or changed mid-turn never stops an owner turn or discards its answer. The full reply is
// kept and stored; only the revoked recalled lines leave what is kept and cited; a genuine privacy revoke (the owner forgot that line)
// redacts that line's own words from the stored reply, never the whole answer. The live shape (Kessler, 1.0.20): a delegated owner turn ran
// 10 minutes with held context, a remembered line was revoked at its end, and the reply shown was only the stop line.
// Real store, real lineage writer, real revoke commit and marker, real send fence; no mock of the decision under test.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { closeMessageDb } from "../message-db.ts";
import { Store } from "../store.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { refsLookup } from "./deny-read.ts";
import { addTurnParents, closeTurnLineage, openTurnLineage } from "./lineage-write.ts";
import type { LineageReader, LineageRef } from "./lineage-types.ts";
import { drainRevokeMarker } from "./memory-revocation.ts";
import { commitRevoke } from "./revoke-commit.ts";
import { assertRetainedFence, prepareRetainedFence } from "./send-fence.ts";

const OWNER: LineageReader = { audience: { owner: true, scopeIds: [] } };
const SECRET = "Vault code 4417-ALPHA-RIVER for the north office";
const RESEARCH = "Ten minutes of research: three vendors compared, pricing table built, the second vendor is cheapest over 3 years.";
const CONCLUSION = "Recommendation: sign with the second vendor before Friday.";

beforeEach(() => {
  closeMessageDb(); closeDatabase();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { closeMessageDb(); closeDatabase(); vi.restoreAllMocks(); });

/** An owner turn that already released its prompt holding two remembered lines; the owner then forgets one of them. */
function runningOwnerTurn(keep?: (verdict?: unknown) => boolean) {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const bot = store.createBot({ name: "Ops Manager", section: "Ops" }, { seedMessages: false });
  // the remembered lines are earlier generated replies (an owner's own words always read shown to the owner, deny-read.ts lookupPage)
  // (the safe line is the older one: a revoke also withholds the lines written after the revoked line, deny-range)
  const safe = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "Budget ceiling stays at the agreed figure." });
  const secret = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: SECRET });
  const turnId = "turn-ops-long";
  const turn = openTurnLineage(database(), { threadId: bot.threadId, turnId });
  const refused = vi.fn();
  prepareRetainedFence(turn, OWNER, refused, database(), keep);
  const secretRef: LineageRef = { kind: "line", threadId: bot.threadId, messageId: secret.id };
  const safeRef: LineageRef = { kind: "line", threadId: bot.threadId, messageId: safe.id };
  addTurnParents(turn, [secretRef, safeRef]);
  // the turn's first releases: everything it holds reads shown
  expect(() => assertRetainedFence(turn, database())).not.toThrow();
  // ... 48 steps later the owner forgets the remembered line (a genuine privacy revoke), settled by the marker
  commitRevoke(database(), { kind: "line", threadId: bot.threadId, messageIds: [secret.id], cause: "forget" });
  drainRevokeMarker(database());
  expect(refsLookup(database(), [secretRef], OWNER).state).toBe("withheld");
  return { store, bot, turn, turnId, refused, secretRef, safeRef };
}
const stored = (threadId: string, id: string) =>
  database().prepare("SELECT text, json FROM messages WHERE thread_id=? AND id=?").get(threadId, id) as { text: string | null; json: string };

it("REVOKEKEEP-1 a remembered line revoked at the end of a long owner turn: the turn continues and its whole answer is stored", () => {
  const keep = vi.fn((_verdict?: unknown) => true);
  const w = runningOwnerTurn(keep);
  try {
    // the release after the revoke: before the fix this sealed the turn and the reply became the stop line
    expect(() => assertRetainedFence(w.turn, database())).not.toThrow();
    expect(w.refused).not.toHaveBeenCalled();
    expect(keep).toHaveBeenCalledTimes(1);
    expect(keep.mock.calls[0]![0]).toMatchObject({ state: "withheld" });
    // only the revoked line leaves what the turn keeps and cites; the still-shown line stays
    expect(w.turn.parents).toEqual([w.safeRef]);
    // later releases are clean (nothing refused is still held), so the hook is not asked again
    expect(() => assertRetainedFence(w.turn, database())).not.toThrow();
    expect(keep).toHaveBeenCalledTimes(1);
    const reply = w.store.appendMessage(w.bot.threadId, { role: "bot", kind: "text", text: `${RESEARCH}\n\n${CONCLUSION}`, turnId: w.turnId });
    const row = stored(w.bot.threadId, reply.id);
    expect(row.text).toBe(`${RESEARCH}\n\n${CONCLUSION}`);
    // its lineage row was written (the line is not "checking": no row would read checking, not withheld)
    expect(refsLookup(database(), [{ kind: "line", threadId: w.bot.threadId, messageId: reply.id }], OWNER)).not.toMatchObject({ state: "checking" });
  } finally { closeTurnLineage(w.turn); }
});

// OPEN (FABLE-DESIGN NEEDED, revokekeep-1020-n1/QUESTIONS-FOR-MAIN.md): the read side still withholds every line of a turn whose prompt was
// built before a revoke it held (the revoke's range reaches the open turn's later lines, revoke-commit.ts / deny-read.ts pendingWindows), so
// the stored, redacted reply reads withheld to the owner. it.fails documents the gap and flips RED the day the read rule keeps the owner's
// redacted reply; then turn it into a plain `it`.
it.fails("REVOKEKEEP-1b OPEN: the owner reads the kept, redacted reply as shown after the mid-turn revoke", () => {
  const w = runningOwnerTurn(() => true);
  try {
    expect(() => assertRetainedFence(w.turn, database())).not.toThrow();
    const reply = w.store.appendMessage(w.bot.threadId, { role: "bot", kind: "text", text: `${RESEARCH}\n\n${CONCLUSION}`, turnId: w.turnId });
    expect(refsLookup(database(), [{ kind: "line", threadId: w.bot.threadId, messageId: reply.id }], OWNER)).toEqual({ state: "shown" });
  } finally { closeTurnLineage(w.turn); }
});

it("REVOKEKEEP-2 privacy witness: the revoked line's words never reach the stored reply, and only those words are removed", () => {
  const w = runningOwnerTurn(() => true);
  try {
    expect(() => assertRetainedFence(w.turn, database())).not.toThrow();
    const reply = w.store.appendMessage(w.bot.threadId, { role: "bot", kind: "text", text: `${RESEARCH} (Earlier you noted: ${SECRET}.)`, turnId: w.turnId });
    // a streamed reply growing inside its turn is patched through updateMessage: the patch is redacted too
    w.store.patchMessage(w.bot.threadId, reply.id, { text: `${RESEARCH} (Earlier you noted: ${SECRET}.)\n\n${CONCLUSION} ${SECRET}` });
    const row = stored(w.bot.threadId, reply.id);
    expect(row.text).not.toContain(SECRET);
    expect(row.json).not.toContain("4417-ALPHA-RIVER");
    expect(row.text).toContain(RESEARCH);
    expect(row.text).toContain(CONCLUSION);
    expect(row.text).toContain("[removed]");
  } finally { closeTurnLineage(w.turn); }
});

it("REVOKEKEEP guard: a turn with no owner keep hook (any non-owner audience) still refuses on the same revoke", () => {
  const w = runningOwnerTurn();
  try {
    expect(() => assertRetainedFence(w.turn, database())).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(w.refused).toHaveBeenCalledTimes(1);
  } finally { closeTurnLineage(w.turn); }
});
