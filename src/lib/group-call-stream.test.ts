// A channel member's reply, spoken sentence by sentence as it streams in
// (src/lib/group-call-stream.ts), and the owner's split sentence joined into
// one message to the room (HeldLine with the group's hold rule).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HeldLine, soundsIncomplete, CONTINUATION_WAIT_MS } from "./call-turns";
import { routeSpokenGroupMessage } from "./group-call";
import { blockStamp, groupTurnTiming, ReplyStreamer } from "./group-call-stream";
import type { Bot } from "@/state/store";

const members = [{ id: "b1", name: "Sable" }, { id: "b2", name: "Moss" }] as Bot[];

const identity = { callSessionId: "call", replyId: "reply", threadId: "thread", botId: "b1", messageId: "message", bootId: "boot" };
describe("ReplyStreamer server identity lifecycle", () => {
  it("is silent before the server supplies a sealed identity", () => {
    const play = vi.fn(); const stream = new ReplyStreamer(play);
    expect(play).not.toHaveBeenCalled(); expect(stream.started).toBe(false);
  });
  it("passes the complete identity to audio playback", () => {
    const play = vi.fn(); const stream = new ReplyStreamer(play); stream.ready(identity);
    expect(play).toHaveBeenCalledExactlyOnceWith(identity);
  });
  it("never repeats an identity", () => {
    const play = vi.fn(); const stream = new ReplyStreamer(play); stream.ready(identity); stream.ready(identity);
    expect(play).toHaveBeenCalledOnce();
  });
  it("an identity consumer cannot reset to another reply", () => {
    const play = vi.fn(); const stream = new ReplyStreamer(play); stream.ready(identity); stream.ready({ ...identity, replyId: "other" });
    expect(play).toHaveBeenCalledExactlyOnceWith(identity);
  });
  it("closing before seal never starts playback", () => {
    const play = vi.fn(); const stream = new ReplyStreamer(play); stream.close(); stream.ready(identity);
    expect(play).not.toHaveBeenCalled();
  });
  it("closing after admission prevents late duplicate playback", () => {
    const play = vi.fn(); const stream = new ReplyStreamer(play); stream.ready(identity); stream.close(); stream.ready(identity);
    expect(play).toHaveBeenCalledOnce();
  });
  it("closing twice cannot reopen admission", () => {
    const play = vi.fn(); const stream = new ReplyStreamer(play); stream.close(); stream.close(); stream.ready(identity);
    expect(play).not.toHaveBeenCalled();
  });
  it("separate replies have separate lifecycle consumers", () => {
    const play = vi.fn(); new ReplyStreamer(play).ready(identity); new ReplyStreamer(play).ready({ ...identity, replyId: "next" });
    expect(play).toHaveBeenCalledTimes(2);
  });
  it("started becomes true only on identity admission", () => {
    const stream = new ReplyStreamer(() => {}); expect(stream.started).toBe(false); stream.ready(identity); expect(stream.started).toBe(true);
  });
  it("has no raw text splitting or client completion entrance", () => {
    const stream = new ReplyStreamer(() => {});
    expect("update" in stream).toBe(false); expect("settle" in stream).toBe(false);
  });
});

describe("the owner's split sentence in a group call", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("holds a line that stops mid-clause, even when its last word is not a joining word", () => {
    expect(soundsIncomplete("Sable, can you")).toBe(true);
    expect(soundsIncomplete("send it to")).toBe(true);
    expect(soundsIncomplete("Sable, check the deploy.")).toBe(false);
    expect(soundsIncomplete("Moss, what is the weather like in Hanoi today?")).toBe(false);
    expect(soundsIncomplete("Sable check the deploy and report back to me")).toBe(false);
  });

  it("'Sable, can you' then 'check the deploy' two seconds later is ONE message to the room", () => {
    const sendGroup = vi.fn();
    let spokenSince = 0;
    const held = new HeldLine((said) => sendGroup(routeSpokenGroupMessage(said, members).text), (since) => spokenSince >= since, soundsIncomplete);
    expect(held.take("Sable, can you")).toBeNull();
    vi.advanceTimersByTime(800);
    spokenSince = Date.now(); // a partial of the next phrase arrives
    vi.advanceTimersByTime(CONTINUATION_WAIT_MS);
    expect(sendGroup).not.toHaveBeenCalled();
    const joined = held.take("check the deploy");
    expect(joined).toBe("Sable, can you check the deploy");
    sendGroup(routeSpokenGroupMessage(joined!, members).text);
    vi.advanceTimersByTime(10_000);
    expect(sendGroup).toHaveBeenCalledTimes(1);
    expect(sendGroup).toHaveBeenCalledWith("@Sable can you check the deploy");
  });

  it("sends the held half on its own once nothing more comes", () => {
    const sendGroup = vi.fn();
    const held = new HeldLine((said) => sendGroup(said), () => false, soundsIncomplete);
    held.take("Sable, can you");
    vi.advanceTimersByTime(CONTINUATION_WAIT_MS + 1);
    expect(sendGroup).toHaveBeenCalledWith("Sable, can you");
  });
});

describe("groupTurnTiming", () => {
  it("is one line of numbers for a member's block", () => {
    expect(groupTurnTiming({ sentAt: 1_000, firstTextAt: 2_200, firstClipAt: 2_900, playingAt: 3_500, piece: "sentence", pieceChars: 42, ackAt: 1_600 })).toBe(
      "[call-diag] group turn timing: sent->first text 1200 ms, first text->first clip 700 ms, first clip->playing 600 ms, total 2500 ms, piece=sentence:42, ack=600",
    );
  });

  it("prints a dash for a stamp that never came", () => {
    expect(groupTurnTiming({ sentAt: 1_000, firstTextAt: null, firstClipAt: null, playingAt: null })).toBe(
      "[call-diag] group turn timing: sent->first text - ms, first text->first clip - ms, first clip->playing - ms, total - ms, piece=-, ack=-",
    );
  });

  it("carries no words", () => {
    expect(groupTurnTiming({ sentAt: 1, firstTextAt: 2, firstClipAt: 3, playingAt: 4, piece: "clause", pieceChars: 9 })).toMatch(/^[\x20-\x7e]*$/);
  });
});

describe("blockStamp", () => {
  it("stamps a member's first text, keeps it while they write, and starts afresh after the stream clears", () => {
    const stamps = { sentAt: 1, block: null as { memberId: string; at: number } | null };
    blockStamp(stamps, "a", "Hel", 100);
    blockStamp(stamps, "a", "Hello there", 150);
    expect(stamps.block).toEqual({ memberId: "a", at: 100 });
    blockStamp(stamps, "a", "", 200);
    expect(stamps.block).toBeNull();
    blockStamp(stamps, "a", "Second block", 300);
    expect(stamps.block).toEqual({ memberId: "a", at: 300 });
    blockStamp(stamps, "b", "Other", 400);
    expect(stamps.block).toEqual({ memberId: "b", at: 400 });
  });
});
