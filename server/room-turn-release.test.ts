// RED2K (RED2J verifier): every exit of a room member turn between the room
// claim and an accepted provider turn releases through releaseUnstartedRoomTurn,
// and that release touches the room and the bot only while this attempt still
// owns the room — a room another owner already took is never idled by a
// stale exit.
//
// RED2L (RED2K verifier): the one exit before the room claim (Stop while the
// browser capability is minted) releases through releaseUnclaimedRoomTurn:
// the bot idle by the activity it set, its browser capability, the queues —
// never the room claim or the skill-authoring claim, which it does not hold.
import { describe, expect, it } from "vitest";
import { releaseUnclaimedRoomTurn, releaseUnstartedRoomTurn, type UnstartedRoomTurnReleaseDeps } from "./room-turn-release.ts";

const harness = (state: { busyBotId: string | null; busy: Record<string, boolean> }) => {
  const calls: string[] = [];
  const deps: UnstartedRoomTurnReleaseDeps = {
    roomBusyBotId: (groupId) => { calls.push(`room:${groupId}`); return state.busyBotId; },
    botBusy: (botId) => state.busy[botId] === true,
    clearRoomClaim: (groupId, threadId) => { calls.push(`clear:${groupId}:${threadId}`); state.busyBotId = null; },
    idleBot: (botId) => { calls.push(`idle:${botId}`); state.busy[botId] = false; },
    releaseBrowser: async (threadId, ownerId) => { calls.push(`browser:${threadId}:${ownerId}`); },
    drainQueues: () => { calls.push("drain"); },
  };
  return { calls, deps };
};

const turn = (skillAuthoring: boolean, claim = { claimed: skillAuthoring }) => ({
  groupId: "room", threadId: "thread", botId: "scout", ownerId: "gen-1", skillAuthoring, skillAuthoringClaim: claim,
});

describe("releaseUnstartedRoomTurn", () => {
  it("releases the room, the bot, the skill-authoring claim, this owner's browser capability and the queues when the attempt still owns the room", async () => {
    const state = { busyBotId: "scout", busy: { scout: true } };
    const { calls, deps } = harness(state);
    const claim = { claimed: true };
    await expect(releaseUnstartedRoomTurn(deps, turn(true, claim))).resolves.toBe("released");
    expect(claim.claimed).toBe(false);
    expect(state).toEqual({ busyBotId: null, busy: { scout: false } });
    expect(calls).toEqual(["room:room", "clear:room:thread", "idle:scout", "browser:thread:gen-1", "drain"]);
  });

  it("leaves a claim it never took alone", async () => {
    const state = { busyBotId: "scout", busy: { scout: true } };
    const { deps } = harness(state);
    // Another member of the round holds /learn; this attempt must not hand
    // it back on their behalf.
    const claim = { claimed: true };
    await releaseUnstartedRoomTurn(deps, turn(false, claim));
    expect(claim.claimed).toBe(true);
  });

  it("never idles a bot or clears a room another owner already took (stale exit), but still hands back its claim and drains", async () => {
    // The stall watchdog released this attempt's claim; a later round claimed
    // the room for Pixel, and Scout has since picked up a 1:1 turn.
    const state = { busyBotId: "pixel", busy: { scout: true, pixel: true } };
    const { calls, deps } = harness(state);
    const claim = { claimed: true };
    await expect(releaseUnstartedRoomTurn(deps, turn(true, claim))).resolves.toBe("stale");
    expect(claim.claimed).toBe(false);
    expect(state).toEqual({ busyBotId: "pixel", busy: { scout: true, pixel: true } });
    expect(calls).toEqual(["room:room", "browser:thread:gen-1", "drain"]);
  });

  it("clears a room claim it still holds even when the bot was already idled by Stop", async () => {
    const state = { busyBotId: "scout", busy: { scout: false } };
    const { calls, deps } = harness(state);
    await expect(releaseUnstartedRoomTurn(deps, turn(false))).resolves.toBe("released");
    expect(state.busyBotId).toBeNull();
    expect(calls).toEqual(["room:room", "clear:room:thread", "browser:thread:gen-1", "drain"]);
  });
});

describe("releaseUnclaimedRoomTurn", () => {
  it("idles the bot by the activity it set, releases this owner's browser capability and drains the queues, without reading or clearing the room claim", async () => {
    // A stale claim of a previous attempt names this bot; it is not this
    // attempt's and is left alone. The room is never consulted.
    const state = { busyBotId: "scout", busy: { scout: true } };
    const { calls, deps } = harness(state);
    await releaseUnclaimedRoomTurn(deps, { threadId: "thread", botId: "scout", ownerId: "gen-1" });
    expect(state).toEqual({ busyBotId: "scout", busy: { scout: false } });
    expect(calls).toEqual(["idle:scout", "browser:thread:gen-1", "drain"]);
  });

  it("does not idle a bot Stop already idled, but still releases the browser capability and drains", async () => {
    const state = { busyBotId: null, busy: { scout: false } };
    const { calls, deps } = harness(state);
    await releaseUnclaimedRoomTurn(deps, { threadId: "thread", botId: "scout", ownerId: "gen-1" });
    expect(state).toEqual({ busyBotId: null, busy: { scout: false } });
    expect(calls).toEqual(["browser:thread:gen-1", "drain"]);
  });
});
