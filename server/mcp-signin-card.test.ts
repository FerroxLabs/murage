// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The rules behind the mid-turn sign-in card that must hold across a restart
// (MCP-LINK 3.12): which cards are still waiting is read from the saved
// conversation, not from memory, and a card is settled only by a sign-in that
// happened AFTER it was posted. A token main pushes again at start-up is the
// same token that was refused, so it must never resume the task.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { MAX_SCOPE_CHARS, MAX_SCOPE_COUNT, mcpSignInFresh, mcpStepUpScope, unionScopeText, waitingMcpSignInCards } from "./mcp-signin-card.ts";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "murage-mcp-card-"));
  roots.push(root);
  const db = new DatabaseSync(join(root, "messages.db"));
  databases.push(db);
  db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
  return db;
}
const card = (over: Record<string, unknown> = {}) => ({
  name: "comfy", host: "cloud.comfy.org", bot: "Sable", botId: "bot-1", reason: "sign-in-ended", status: "required",
  resumeKey: "mcp-abc", title: "Sign in to cloud.comfy.org", body: "x", phone: "y", ...over,
});
function put(db: DatabaseSync, id: string, at: number, mcpSignIn: Record<string, unknown>, thread = "thread-1", extra: Record<string, unknown> = {}) {
  const value = { id, at, role: "bot", kind: "mcpSignIn", mcpSignIn, ...extra };
  db.prepare("INSERT OR REPLACE INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)")
    .run(thread, id, at, "bot", "mcpSignIn", null, JSON.stringify(value));
}

describe("waitingMcpSignInCards reads the waiting cards from the saved conversations", () => {
  it("lists only this server's cards that still wait: not signed in, not dismissed, not resumed", () => {
    const db = fixture();
    put(db, "waiting", 100, card());
    put(db, "other-server", 101, card({ name: "github" }));
    put(db, "signed", 102, card({ status: "signed-in" }));
    put(db, "dismissed", 103, card({ dismissed: true }));
    put(db, "resumed", 104, card({ resumed: true }));
    put(db, "room", 105, card({ reason: "needs-more-access", scope: "tools:write" }), "room-thread", { from: { botId: "bot-2", name: "B", color: "red" } });
    db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)").run("thread-1", "text", 106, "bot", "text", "comfy", JSON.stringify({ id: "text", kind: "text", text: "comfy" }));
    expect(waitingMcpSignInCards(db, "comfy")).toEqual([
      { threadId: "thread-1", messageId: "waiting", at: 100, botId: "bot-1", reason: "sign-in-ended" },
      { threadId: "room-thread", messageId: "room", at: 105, botId: "bot-1", reason: "needs-more-access", scope: "tools:write" },
    ]);
    expect(waitingMcpSignInCards(db, "nobody")).toEqual([]);
  });

  it("with an origin, only cards posted for that origin; a card with no origin matches none (review M2)", () => {
    const db = fixture();
    put(db, "a", 100, card({ origin: "https://a.example" }));
    put(db, "b", 101, card({ origin: "https://b.example" }));
    put(db, "none", 102, card());
    expect(waitingMcpSignInCards(db, "comfy", "https://a.example").map((c) => c.messageId)).toEqual(["a"]);
    expect(waitingMcpSignInCards(db, "comfy", "https://c.example")).toEqual([]);
    expect(waitingMcpSignInCards(db, "comfy").map((c) => c.messageId)).toEqual(["a", "b", "none"]);
  });

  it("a card saved before botId was recorded falls back to the room member that posted it", () => {
    const db = fixture();
    const { botId: _drop, ...old } = card();
    void _drop;
    put(db, "old", 100, old, "room-thread", { from: { botId: "bot-9", name: "B", color: "red" } });
    put(db, "orphan", 101, old);
    expect(waitingMcpSignInCards(db, "comfy")).toEqual([
      { threadId: "room-thread", messageId: "old", at: 100, botId: "bot-9", reason: "sign-in-ended" },
      { threadId: "thread-1", messageId: "orphan", at: 101, reason: "sign-in-ended" },
    ]);
  });
});

describe("mcpSignInFresh: only a sign-in after the card settles it", () => {
  const posted = { at: 1_000, reason: "sign-in-ended" as const };
  it("needs a token issued after the card", () => {
    expect(mcpSignInFresh(posted, { bearer: "at-new", signedInAt: 1_001 })).toBe(true);
    expect(mcpSignInFresh(posted, { bearer: "at-old", signedInAt: 999 }), "the token that was refused, pushed again at start-up").toBe(false);
    expect(mcpSignInFresh(posted, { bearer: "at-old", signedInAt: 1_000 })).toBe(false);
    expect(mcpSignInFresh(posted, { bearer: "at-x" }), "no issue time: not provably new").toBe(false);
    expect(mcpSignInFresh(posted, { signedInAt: 2_000 }), "no token at all").toBe(false);
  });
  it("a refresh (new issuedAt, old signedInAt) never settles a card (review M1)", () => {
    expect(mcpSignInFresh(posted, { bearer: "at-refreshed", issuedAt: 9_000, signedInAt: 500 })).toBe(false);
    expect(mcpSignInFresh(posted, { bearer: "at-refreshed", issuedAt: 9_000 }), "no sign-in time at all").toBe(false);
    expect(mcpSignInFresh(posted, { bearer: "at-new", issuedAt: 9_000, signedInAt: 1_001 })).toBe(true);
  });
  it("never accepts the exact token the card was posted for, whatever its time says", () => {
    expect(mcpSignInFresh(posted, { bearer: "at-old", signedInAt: 5_000 }, "at-old")).toBe(false);
    expect(mcpSignInFresh(posted, { bearer: "at-new", signedInAt: 5_000 }, "at-old")).toBe(true);
  });
  it("a card that asked for more access needs a token that carries that access", () => {
    const stepUp = { at: 1_000, reason: "needs-more-access" as const, scope: "tools:write" };
    expect(mcpSignInFresh(stepUp, { bearer: "at", signedInAt: 2_000, scope: "tools:call tools:write" })).toBe(true);
    expect(mcpSignInFresh(stepUp, { bearer: "at", signedInAt: 2_000, scope: "tools:call" }), "a refresh with the old scope").toBe(false);
    expect(mcpSignInFresh(stepUp, { bearer: "at", signedInAt: 2_000 }), "scope unknown").toBe(false);
    expect(mcpSignInFresh({ at: 1_000, reason: "needs-more-access" }, { bearer: "at", signedInAt: 2_000 }), "no scope was named").toBe(true);
  });
});

describe("the step-up scope a sign-in must ask for", () => {
  it("is the union of what every waiting card for the server asked for", () => {
    expect(mcpStepUpScope([
      { threadId: "a", messageId: "1", at: 1, reason: "needs-more-access", scope: "tools:write" },
      { threadId: "b", messageId: "2", at: 2, reason: "sign-in-ended" },
      { threadId: "c", messageId: "3", at: 3, reason: "needs-more-access", scope: "tools:admin tools:write" },
    ])).toBe("tools:write tools:admin");
    expect(mcpStepUpScope([])).toBeUndefined();
  });
  it("caps the merged scopes by count and by length, so a server that varies its 403 scopes cannot grow the authorize URL (review L1)", () => {
    const many = Array.from({ length: 200 }, (_, index) => `scope:${index}`);
    const merged = unionScopeText(many).split(" ");
    expect(merged).toHaveLength(MAX_SCOPE_COUNT);
    expect(merged[0]).toBe("scope:0");
    const long = Array.from({ length: 10 }, (_, index) => `${"x".repeat(190)}${index}`);
    expect(unionScopeText(long).length).toBeLessThanOrEqual(MAX_SCOPE_CHARS);
    const cards = Array.from({ length: 50 }, (_, index) => ({ threadId: "t", messageId: String(index), at: index, reason: "needs-more-access" as const, scope: `s${index}a s${index}b` }));
    expect(mcpStepUpScope(cards)!.split(" ").length).toBeLessThanOrEqual(MAX_SCOPE_COUNT);
  });
  it("unionScopeText keeps each well-formed scope once, in order, and drops junk", () => {
    expect(unionScopeText("a b", ["b", "c"], undefined, "d\u0000e f")).toBe("a b c f");
    expect(unionScopeText()).toBe("");
  });
});
