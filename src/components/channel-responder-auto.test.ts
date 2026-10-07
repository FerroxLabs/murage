// The "Who answers" select can pick Auto, but only while the decision model
// routes rooms. The panel reads `window` at import, so this is a source
// contract plus tests of the pure helpers it uses.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { autoFallbackBot, deciderRoutesRooms, effectiveDefaultResponder, roomRespondersForComposer } from "@/lib/group-routing";

const DETAILS = readFileSync(fileURLToPath(new URL("./ChannelDetailsPanel.tsx", import.meta.url)), "utf8");
const members = [{ id: "a", name: "Atlas" }, { id: "b", name: "Milind" }];

describe("Auto in the Who answers select", () => {
  it("is offered only when the decision model routes rooms, or the room is already on Auto", () => {
    expect(deciderRoutesRooms(null)).toBe(false);
    expect(deciderRoutesRooms({})).toBe(false);
    expect(deciderRoutesRooms({ decider: { enabled: true } })).toBe(false);
    expect(deciderRoutesRooms({ decider: { enabled: false, jobs: { roomRouting: true } } })).toBe(false);
    expect(deciderRoutesRooms({ decider: { enabled: true, jobs: { roomRouting: true } } })).toBe(true);
    expect(DETAILS).toContain('const showAuto = deciderRoutesRooms(state.config) || responder.kind === "auto";');
    expect(DETAILS).toContain('{showAuto && <option value="auto">Murage picks who answers</option>}');
  });

  it("selecting it dispatches { kind: auto } and keeps a saved fallback", () => {
    expect(DETAILS).toContain('else if (value === "auto")');
    expect(DETAILS).toContain('next = kept ? { kind: "auto", fallbackBotId: kept } : { kind: "auto" };');
    expect(DETAILS).toContain('dispatch({ type: "patchGroup", groupId: group.id, patch: { defaultResponder: next } })');
  });

  it("an Auto room stays Auto and falls back to the saved bot, else the first", () => {
    expect(effectiveDefaultResponder({ defaultResponder: { kind: "auto" } }, members)).toEqual({ kind: "auto" });
    expect(autoFallbackBot({}, members)?.name).toBe("Atlas");
    expect(autoFallbackBot({ fallbackBotId: "b" }, members)?.name).toBe("Milind");
    expect(autoFallbackBot({ fallbackBotId: "gone" }, members)?.name).toBe("Atlas");
    expect(roomRespondersForComposer("hi", members, { defaultResponder: { kind: "auto", fallbackBotId: "b" } })).toEqual([members[1]]);
  });

  it("explains itself in plain words", () => {
    expect(DETAILS).toContain("It picks the best bot for each message. If it can't decide,");
  });
});
