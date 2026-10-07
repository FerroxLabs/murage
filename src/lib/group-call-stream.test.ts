// A channel member's reply, spoken sentence by sentence as it streams in
// (src/lib/group-call-stream.ts), and the owner's split sentence joined into
// one message to the room (HeldLine with the group's hold rule).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HeldLine, soundsIncomplete, CONTINUATION_WAIT_MS } from "./call-turns";
import { routeSpokenGroupMessage } from "./group-call";
import { blockStamp, groupTurnTiming, ReplyStreamer } from "./group-call-stream";
import type { Bot } from "@/state/store";

const members = [{ id: "b1", name: "Sable" }, { id: "b2", name: "Moss" }] as Bot[];

describe("ReplyStreamer", () => {
  it("speaks the first sentence before the block is complete", () => {
    const said: string[] = [];
    const streamer = new ReplyStreamer((s) => said.push(s));
    streamer.update("Hi there, friend. I'm checking");
    expect(said).toEqual(["Hi there, friend."]);
    streamer.update("Hi there, friend. I'm checking the deploy now.");
    // the second sentence has no whitespace after it yet: it waits
    expect(said).toEqual(["Hi there, friend."]);
    streamer.settle("Hi there, friend. I'm checking the deploy now.");
    expect(said).toEqual(["Hi there, friend.", "I'm checking the deploy now."]);
  });

  it("voices the first clause of a block, then whole sentences", () => {
    const said: string[] = [];
    const streamer = new ReplyStreamer((s) => said.push(s));
    let full = "";
    for (const token of ["Sure, ", "I can pull that ", "together for you, ", "and send it ", "after lunch. ", "Anything else? "]) {
      full += token;
      streamer.update(full);
    }
    expect(said).toEqual(["Sure, I can pull that together for you,", "and send it after lunch.", "Anything else?"]);
  });

  it("waits while nothing follows the clause boundary yet", () => {
    const said: string[] = [];
    const streamer = new ReplyStreamer((s) => said.push(s));
    streamer.update("Sure, I can pull that together for you, ");
    expect(said).toEqual([]);
    streamer.update("Sure, I can pull that together for you, and");
    expect(said).toEqual(["Sure, I can pull that together for you,"]);
  });

  it("does not cut a later sentence at a clause", () => {
    const said: string[] = [];
    const streamer = new ReplyStreamer((s) => said.push(s));
    streamer.update("Okay, that one is done. I can pull that together for you, and send it after lunch ");
    expect(said).toEqual(["Okay, that one is done."]);
  });

  it("a code fence before the clause end still stops streaming", () => {
    const said: string[] = [];
    const streamer = new ReplyStreamer((s) => said.push(s));
    streamer.update("Sure, here is the fix for you ```ts\nconst a = 1;\n``` and then, after that we are done ");
    expect(said).toEqual([]);
  });

  it("settle after a clause cut says only the unsaid rest", () => {
    const said: string[] = [];
    const streamer = new ReplyStreamer((s) => said.push(s));
    streamer.update("Sure, I can pull that together for you, and send it");
    streamer.settle("Sure, I can pull that together for you, and send it after lunch.");
    expect(said).toEqual(["Sure, I can pull that together for you,", "and send it after lunch."]);
  });

  it("never repeats a sentence, however often the same text arrives", () => {
    const said: string[] = [];
    const streamer = new ReplyStreamer((s) => said.push(s));
    streamer.update("One is first. Two is second. Thr");
    streamer.update("One is first. Two is second. Thr");
    streamer.update("One is first. Two is second. Three is third. Fo");
    streamer.settle("One is first. Two is second. Three is third. Four is last.");
    expect(said).toEqual(["One is first.", "Two is second.", "Three is third.", "Four is last."]);
  });

  it("ignores the empty text that follows a settled message", () => {
    const said: string[] = [];
    const streamer = new ReplyStreamer((s) => said.push(s));
    streamer.update("One is first. Two is sec");
    streamer.update("");
    streamer.settle("One is first. Two is second.");
    expect(said).toEqual(["One is first.", "Two is second."]);
  });

  it("speaks the whole text at settle when nothing streamed", () => {
    const said: string[] = [];
    const streamer = new ReplyStreamer((s) => said.push(s));
    expect(streamer.started).toBe(false);
    streamer.settle("Done. The deploy is green.");
    expect(said.join(" ")).toBe("Done. The deploy is green.");
  });

  it("stops streaming at a code block and says it as the spoken form at settle", () => {
    const said: string[] = [];
    const streamer = new ReplyStreamer((s) => said.push(s));
    streamer.update("Here is the fix. ```ts\nconst a = 1;\n```\nThat is all. ");
    expect(said).toEqual(["Here is the fix."]);
    streamer.settle("Here is the fix. ```ts\nconst a = 1;\n```\nThat is all.");
    expect(said.join(" ")).not.toContain("const a");
    expect(said.join(" ")).toContain("code block");
    expect(said[said.length - 1]).toContain("That is all.");
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
