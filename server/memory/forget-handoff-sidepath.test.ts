// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// FORGET-SIDEPATH (1.0.17, handoffs/FORGET-CROSSREAD-CHECK.md section 5): recall for a reader that is not the owner judges a record's
// evidence line with readerWithheldMessage (disclosures.ts). The read-time copy walk there follows `copyOf` only. This guards the chain
// it does not walk: the owner's line X, the bot's reply Y that used it, a delegation prompt Z (`handoffOf` Y, a role-user row in another
// bot's task thread), a memory record captured from Z, and the owner forgetting X. Neither the record nor Z may come back to a channel
// person, in the person's other conversation (the cross-thread rule) or in Z's own conversation (the transcript rule).
import { afterEach, describe, expect, it } from "vitest";
import { database } from "../database.ts";
import type { Message } from "../store.ts";
import type { MemoryBundle } from "../../shared/memory.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { searchMemory } from "./search.ts";
import { memoryAgentRoute } from "./routes.ts";
import { filterMemoryReplay, lineageReaderOf, readerWithheldMessage } from "./disclosures.ts";
import { denyLookup } from "./deny-read.ts";
import { forgetMemory } from "./forget.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { drainRevokeMarker, runRevocationJobsNow } from "./memory-revocation.ts";
import { setIntegrityFlags } from "./integrity-flags.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import type { MemoryAccess } from "./policy.ts";
import { access, append, bot, hits, person, QUERY, recordFrom, runJobs, world } from "./testing/xthread-world.ts";

const SECRET = "GATE-5150";
const big = () => LineageAllowance.tool(1_000_000_000);
const ids = (list: ReadonlyArray<{ id: string }>) => list.map(hit => hit.id);
const owner = () => access("finch", "finch-direct");

afterEach(() => { try { setIntegrityFlags(database(), { hold: null, pending: false }); } catch { /* closed */ } });

/** The chain: X (owner, dax-direct), Y (dax's reply using X), Z (the delegation prompt to finch, in finch's task thread t1, handoffOf Y). */
function chain(): void {
  append("dax-direct", person("x", `The side gate code is ${SECRET}. Keep it to yourself.`));
  append("dax-direct", bot("y", { text: `Noted, ${SECRET}. I will ask Finch to set the side gate code up.`, from: { botId: "dax" } } as Partial<Message>));
  append("t1", {
    id: "z", role: "user", kind: "text", at: Date.now(),
    text: `[Delegated by @Dax, another bot in this Murage workspace. Do the work and reply directly.]\n\nSet the side gate code to ${SECRET} in the gate notes.`,
    handoffOf: { threadId: "dax-direct", messageId: "y" }, automation: { kind: "delegation" },
  } as Message);
}

/** What the reader is handed back for the record and for Z, through every recall path. */
async function handedBack(reader: MemoryAccess, record: { id: string; version: number }): Promise<string[]> {
  const leaks: string[] = [];
  const rule = readerWithheldMessage(reader);
  expect(rule, "a non-owner reader has its own rule").toBeDefined();
  if (!rule!("t1", "z", big())) leaks.push("rule shows Z");
  if (reader.threadId === "t1" && filterMemoryReplay(big(), "t1", [{ id: "z" }], reader, { persist: false, failClosed: true }).length) leaks.push("transcript shows Z");
  const bundle: MemoryBundle = await buildMemoryBundle(QUERY, reader, hits([record]), { allowance: LineageAllowance.tool(), withheldMessage: readerWithheldMessage(reader) });
  if (bundle.text.includes(SECRET)) leaks.push("bundle carries the record");
  if (ids((await searchMemory(QUERY, reader, hits([record]), { allowance: LineageAllowance.tool(), withheldMessage: readerWithheldMessage(reader) })).hits).includes(record.id)) leaks.push("searchMemory hit");
  if (ids((await memoryAgentRoute("/api/internal/memory/search", { query: QUERY }, reader, hits([record])) as { hits: Array<{ id: string }> }).hits).includes(record.id)) leaks.push("memory_search hit");
  try {
    const got = await memoryAgentRoute("/api/internal/memory/get", { handles: [{ id: record.id, version: record.version }] }, reader, hits([])) as { records?: Array<{ text: string }> };
    if ((got.records ?? []).some(row => row.text.includes(SECRET))) leaks.push("memory_get returns the record");
  } catch { /* refused: not handed back */ }
  return leaks;
}

describe("FORGET-SIDEPATH: a record captured from a delegation prompt that rests on forgotten owner text", () => {
  it("is not handed back to a channel person, in another conversation or in the prompt's own, once the owner forgets X", async () => {
    const { person: who } = world({ flipFirst: false });
    chain();
    runJobs();
    const record = recordFrom("t1", "z");
    // each turn mints its access after the forget (a forget moves the deletion epoch, so an older access is refused as revoked)
    const readers: Array<[string, () => MemoryAccess]> = [
      ["channel sender, other conversation (t2)", () => access("finch", "t2", { human: who, notOwnerAudience: true })],
      ["channel sender, Z's own conversation (t1)", () => access("finch", "t1", { human: who, notOwnerAudience: true })],
    ];
    // positive controls before the forget: Z rests on Y by write-time lineage, and each reader is handed the record (so the leak, if any,
    // is real and the withholding below is the forget's doing)
    expect(database().prepare("SELECT count(*) AS n FROM memory_line_lineage").get()!.n).toBeGreaterThan(0);
    for (const [name, reader] of readers) expect(await handedBack(reader(), record), name).toEqual(expect.arrayContaining(["rule shows Z", "bundle carries the record", "memory_get returns the record"]));

    forgetMemory(ownerMemoryTicket(), { kind: "source", id: "message:dax-direct:x", revision: 1 });
    // the forget's pending window (before the marker walks) and the settled marks (after it and the revocation jobs)
    for (const phase of ["pending", "settled"]) {
      if (phase === "settled") { drainRevokeMarker(database()); runRevocationJobsNow(database()); drainRevokeMarker(database()); }
      // control: Y is withheld from a non-owner reader in its own conversation (deny range from X)
      expect(denyLookup(database(), { threadId: "dax-direct", lines: [{ messageId: "y", author: "generated" }] }, lineageReaderOf(readers[0]![1]())).get("y")!.state, phase).not.toBe("shown");
      for (const [name, reader] of readers) expect(await handedBack(reader(), record), `${phase}: ${name}`).toEqual([]);
    }
    // the owner's own surfaces are not what this guards; they are read only to show the record still exists
    expect(readerWithheldMessage(owner())).toBeUndefined();
  });
});
