// SPDX-License-Identifier: AGPL-3.0-or-later
// MONEY #1 (MAIN, 1.0.24), the host decision behind MURAGE_BROWSER_NO_LIMITS and the per-step floor-lift answer (browser-floor-lift.ts builtinFloorLift, the
// function index.ts calls at the built-in browser mount and on the murage/floor-lift route). Real decision fixture and real outside-mark store: only the owner's
// own typed turn at No limits, with no mark from outside content (page, web, email, person, bot), lifts the floor. Owners: lane q1024-paynl (rule + witness), MAIN (policy).
import { describe, expect, it } from "vitest";
import { fixture } from "./decision/fixture.ts";
import * as d from "./decision/index.ts";
import { builtinFloorLift } from "./browser-floor-lift.ts";
import { markTurnOutside } from "./email/external-marks.ts";
import { useOutsideStoreFixture } from "./testing/outside-store-fixture.ts";

useOutsideStoreFixture();
const turn = { threadId: "t", generation: "g", botId: "b" };
type Initiator = Parameters<typeof fixture>[1];
const ROWS: Array<{ row: string; level: Parameters<typeof fixture>[0]; initiator: Initiator; routine?: "schedule" | "manual"; mark?: Parameters<typeof markTurnOutside>[1]; then?: Parameters<typeof markTurnOutside>[1]; lifts: boolean }> = [
  { row: "owner typed turn at No limits", level: "unlimited", initiator: { k: "owner-typed" }, lifts: true },
  // MAIN-RULING (Codex tip audit High 1): a page the browser read, a web page or a search result never lifts the floor. This row expected the lift before.
  { row: "owner typed turn at No limits, page read marks (browser page)", level: "unlimited", initiator: { k: "owner-typed" }, mark: "browser page", lifts: false },
  { row: "owner typed turn at No limits carrying a web page mark", level: "unlimited", initiator: { k: "owner-typed" }, mark: "web page", lifts: false },
  { row: "owner typed turn at No limits carrying a web search mark", level: "unlimited", initiator: { k: "owner-typed" }, mark: "web search", lifts: false },
  { row: "owner typed turn: a structural mark first, then a page mark (the first mark must not hide the page)", level: "unlimited", initiator: { k: "owner-typed" }, mark: "outside tool", then: "browser page", lifts: false },
  { row: "owner typed turn carrying a downloaded file mark", level: "unlimited", initiator: { k: "owner-typed" }, mark: "downloaded file", lifts: false },
  { row: "owner typed turn carrying memory written on an earlier turn", level: "unlimited", initiator: { k: "owner-typed" }, mark: "memory", lifts: false },
  { row: "owner typed turn: a page mark first, then an email mark (the first mark must not hide the later one)", level: "unlimited", initiator: { k: "owner-typed" }, mark: "browser page", then: "email", lifts: false },
  { row: "owner typed turn: a page mark first, then another bot's mark", level: "unlimited", initiator: { k: "owner-typed" }, mark: "web page", then: "another bot", lifts: false },
  // No structural exception (Opus self-review r3): `outside tool` is also another party's MCP tool result, and an engine not seen in full may have read anything.
  { row: "owner typed turn with an outside tool mark (another party's tool result, or an engine not seen in full)", level: "unlimited", initiator: { k: "owner-typed" }, mark: "outside tool", lifts: false },
  { row: "owner typed turn in someone else's repository (cloned folder)", level: "unlimited", initiator: { k: "owner-typed" }, mark: "cloned folder", lifts: false },
  { row: "owner typed turn carrying a helper (sub-agent) mark", level: "unlimited", initiator: { k: "owner-typed" }, mark: "helper", lifts: false },
  { row: "owner typed turn in a folder that was not checked", level: "unlimited", initiator: { k: "owner-typed" }, mark: "folder not checked", lifts: false },
  { row: "owner typed turn at Full access (ask)", level: "ask", initiator: { k: "owner-typed" }, lifts: false },
  { row: "webhook-triggered turn at No limits", level: "unlimited", initiator: { k: "webhook" }, lifts: false },
  { row: "scheduled routine turn at No limits (a routine keeps the floor)", level: "unlimited", initiator: { k: "routine-run", form: "run", sourceRunId: "run", sourceBotId: "b", recipientGeneration: "g", trigger: "schedule" } as Initiator, routine: "schedule", lifts: false },
  { row: "manually started routine turn at No limits (a routine keeps the floor)", level: "unlimited", initiator: { k: "routine-run", form: "run", sourceRunId: "run", sourceBotId: "b", recipientGeneration: "g", trigger: "manual" } as Initiator, routine: "manual", lifts: false },
  { row: "guest turn at No limits", level: "unlimited", initiator: { k: "guest" } as Initiator, lifts: false },
  { row: "owner typed turn carrying an email mark", level: "unlimited", initiator: { k: "owner-typed" }, mark: "email", lifts: false },
  { row: "owner typed turn carrying another person's mark", level: "unlimited", initiator: { k: "owner-typed" }, mark: "another person", lifts: false },
  { row: "owner typed turn carrying another bot's mark", level: "unlimited", initiator: { k: "owner-typed" }, mark: "another bot", lifts: false },
];
describe("builtinFloorLift", () => {
  for (const { row, level, initiator, routine, mark, then, lifts } of ROWS) it(`${row}: ${lifts ? "lifts" : "keeps"} the floor`, () => {
    fixture(level, initiator);
    // A routine turn's live policy names the routine as its actor (as the routine runner installs it); without it the fixture reads the turn as owner-typed.
    if (routine) d.installProvenanceReader({ turnGenerationFor: () => "g", provenance: () => ({ generation: "g", threadId: "t", botId: "b", principal: "owner", roomOwnerOnly: true, at: 1, initiator }), live: () => ({ botId: "b", turnId: "turn", providerInstanceId: "p", principal: "owner", owner: true, level, routine: { owner: true, sourceRunId: "run", sourceBotId: "b", recipientGeneration: "g" } }) } as never);
    if (mark) markTurnOutside("t", mark);
    if (then) markTurnOutside("t", then);
    expect(builtinFloorLift(turn)).toBe(lifts);
  });
  it("a stale generation never lifts", () => {
    fixture("unlimited", { k: "owner-typed" });
    expect(builtinFloorLift({ ...turn, generation: "an-earlier-turn" })).toBe(false);
  });
});
