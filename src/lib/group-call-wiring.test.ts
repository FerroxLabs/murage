// The room call's behaviour as wired: the owner's held line with the
// component's real timing, and a member's streamed reply across an
// interrupt, a settle that differs from the stream, and tiny sentences.
// Fakes stand in for the speech helper and the speaker; no source is read.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONTINUATION_WAIT_MS } from "./call-turns";
import { OwnerLine, routeSpokenGroupMessage } from "./group-call";
import { RoomReplyVoice } from "./group-call-stream";
import type { Bot } from "@/state/store";

const members = [{ id: "b1", name: "Sable" }, { id: "b2", name: "Moss" }] as Bot[];

describe("OwnerLine: the held line waits the window from the final, not the 6 s cap", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = () => {
    const sent: Array<{ at: number; text: string }> = [];
    const t0 = Date.now();
    const line = new OwnerLine((text) => sent.push({ at: Date.now() - t0, text: routeSpokenGroupMessage(text, members).text }));
    return { line, sent };
  };

  it("'Sable, can you' with nothing after it is sent at about 1.2 s", () => {
    const { line, sent } = make();
    line.partial("Sable, can you"); // the owner's own words, before the final
    expect(line.final("Sable, can you")).toBeNull();
    vi.advanceTimersByTime(CONTINUATION_WAIT_MS - 1);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(150);
    expect(sent).toHaveLength(1);
    expect(sent[0].at).toBeLessThan(1_500);
    expect(sent[0].text).toBe("@Sable can you");
  });

  it("a continuation that begins inside the window is merged into ONE message", () => {
    const { line, sent } = make();
    line.partial("Sable, can you");
    expect(line.final("Sable, can you")).toBeNull();
    vi.advanceTimersByTime(900);
    line.partial("check the"); // the next phrase begins
    vi.advanceTimersByTime(600); // past the 1.2 s mark: still waiting for it
    expect(sent).toEqual([]);
    expect(line.final("check the deploy")).toBe("Sable, can you check the deploy");
    vi.advanceTimersByTime(10_000);
    expect(sent).toEqual([]);
    expect(routeSpokenGroupMessage("Sable, can you check the deploy", members).text).toBe("@Sable can you check the deploy");
  });

  it("speech that never finishes arriving does not hold the line past the cap", () => {
    const { line, sent } = make();
    line.partial("Sable, can you");
    line.final("Sable, can you");
    vi.advanceTimersByTime(500);
    for (let i = 0; i < 80; i += 1) {
      line.partial("um");
      vi.advanceTimersByTime(100);
    }
    expect(sent).toHaveLength(1);
  });

  it("a whole line goes straight out", () => {
    const { line } = make();
    expect(line.final("Sable, check the deploy.")).toBe("Sable, check the deploy.");
  });
});

describe("RoomReplyVoice server audio identities", () => {
  const reply = (id: string, botId = "b1") => ({ callSessionId: "call", replyId: id, botId, threadId: "thread", messageId: id, bootId: "boot" });
  const setup = () => { const play = vi.fn(); return { play, voice: new RoomReplyVoice<Bot>(play) }; };
  it("an interrupt prevents late reply admission", () => {
    const { voice, play } = setup(); voice.ready(members[0], reply("first")); voice.interrupt(true); voice.ready(members[0], reply("late"));
    expect(play).toHaveBeenCalledExactlyOnceWith(members[0], reply("first"));
  });
  it("the next turn speaks after the interrupted one ends", () => {
    const { voice, play } = setup(); voice.interrupt(true); voice.ready(members[0], reply("late")); voice.turnOver(); voice.ready(members[0], reply("next"));
    expect(play).toHaveBeenCalledExactlyOnceWith(members[0], reply("next"));
  });
  it("an idle interrupt does not silence the next reply", () => {
    const { voice, play } = setup(); voice.interrupt(false); voice.ready(members[0], reply("next")); expect(play).toHaveBeenCalledOnce();
  });
  it("a duplicate ready never repeats a reply", () => {
    const { voice, play } = setup(); voice.ready(members[0], reply("first")); voice.ready(members[0], reply("first")); expect(play).toHaveBeenCalledOnce();
  });
  it("admission uses identity regardless of display text", () => {
    const { voice, play } = setup(); voice.ready(members[0], reply("first")); expect(play.mock.calls[0][1]).toEqual(reply("first"));
    expect("update" in voice).toBe(false); expect("settle" in voice).toBe(false);
  });
  it("another member cannot claim a reply", () => {
    const { voice, play } = setup(); voice.ready(members[1], reply("first")); voice.ready(undefined, reply("first")); expect(play).not.toHaveBeenCalled();
  });
  it("raw goal envelopes and code never enter the audio callback", () => {
    const { voice, play } = setup(); voice.ready(members[0], reply("first")); expect(play.mock.calls[0][1]).not.toHaveProperty("text");
    expect(play.mock.calls[0][1]).not.toHaveProperty("source");
  });
  it("different members retain server ready order", () => {
    const { voice, play } = setup(); voice.ready(members[0], reply("first")); voice.ready(members[1], reply("second", "b2"));
    expect(play.mock.calls.map(args => args[1].replyId)).toEqual(["first", "second"]);
  });
  it("a muted identity cannot replay after turnOver", () => {
    const { voice, play } = setup(); voice.interrupt(true); voice.ready(members[0], reply("old")); voice.turnOver(); voice.ready(members[0], reply("old"));
    expect(play).not.toHaveBeenCalled();
  });
});
