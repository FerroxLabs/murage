// The room call's behaviour as wired: the owner's held line with the
// component's real timing, and a member's streamed reply across an
// interrupt, a settle that differs from the stream, and tiny sentences.
// Fakes stand in for the speech helper and the speaker; no source is read.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONTINUATION_WAIT_MS } from "./call-turns";
import { OwnerLine, routeSpokenGroupMessage } from "./group-call";
import { RoomReplyVoice } from "./group-call-stream";
import { GROUP_GOAL_CONTROL_OPEN } from "../../server/group-goal-run";
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

describe("RoomReplyVoice", () => {
  const sable = members[0];
  const setup = () => {
    const opened: string[][] = [];
    const ended: boolean[] = [];
    const voice = new RoomReplyVoice<Bot>(() => {
      const spoken: string[] = [];
      opened.push(spoken);
      const index = ended.push(false) - 1;
      return { push: (s) => spoken.push(s), end: () => { ended[index] = true; } };
    });
    const said = () => opened.flat();
    return { voice, opened, ended, said };
  };

  it("an interrupt mid-reply: no restart, no further sentences, however many deltas follow", () => {
    const { voice, opened, said } = setup();
    voice.update(sable, "First sentence is here. Second sentence follows it. Thi");
    expect(said()).toEqual(["First sentence is here.", "Second sentence follows it."]);
    voice.interrupt(true);
    voice.update(sable, "First sentence is here. Second sentence follows it. Third sentence arrives. Fourth ");
    voice.update(sable, "First sentence is here. Second sentence follows it. Third sentence arrives. Fourth one too. Fi");
    voice.settle(sable, "First sentence is here. Second sentence follows it. Third sentence arrives. Fourth one too.");
    expect(said()).toEqual(["First sentence is here.", "Second sentence follows it."]);
    expect(opened).toHaveLength(1); // no second speaker stream: nothing closed the mic again
  });

  it("the next turn speaks again once the interrupted one is over", () => {
    const { voice, said } = setup();
    voice.update(sable, "One sentence is enough. Two");
    voice.interrupt(true);
    voice.turnOver();
    voice.update(sable, "A brand new answer. More");
    expect(said()).toEqual(["One sentence is enough.", "A brand new answer."]);
  });

  it("an interrupt while nothing is being worked on does not silence the next reply", () => {
    const { voice, said } = setup();
    voice.interrupt(false);
    voice.update(sable, "Hello again, owner. More");
    expect(said()).toEqual(["Hello again, owner."]);
  });

  it("settle speaks only the unspoken remainder when the final continues the stream", () => {
    const { voice, said } = setup();
    voice.update(sable, "The deploy is green. I checked the log");
    voice.settle(sable, "The deploy is green. I checked the logs and the alerts.");
    expect(said()).toEqual(["The deploy is green.", "I checked the logs and the alerts."]);
  });

  it("settle with a stripped, trimmed final still matches the stream's prefix", () => {
    const { voice, said } = setup();
    voice.update(sable, "\nThe deploy is green. Next");
    voice.settle(sable, "The deploy is green. Next steps are ready.");
    expect(said()).toEqual(["The deploy is green.", "Next steps are ready."]);
  });

  it("a final that differs from what streamed adds nothing more", () => {
    const { voice, said } = setup();
    voice.update(sable, "The deploy is green. I checked the log");
    voice.settle(sable, "Sable: a different answer altogether, from another line.");
    expect(said()).toEqual(["The deploy is green."]);
  });

  it("never speaks a goal control envelope, streamed or at settle", () => {
    const { voice, said } = setup();
    voice.update(sable, `Plan is set for today. ${GROUP_GOAL_CONTROL_OPEN}{"goal":"secret words"}`);
    voice.update(sable, `Plan is set for today. ${GROUP_GOAL_CONTROL_OPEN}{"goal":"secret words"}</murage-goal> Next up.`);
    voice.settle(sable, "Plan is set for today. Next up is the review.");
    const all = said().join(" ");
    expect(all).not.toContain("secret");
    expect(all).not.toContain("murage-goal");
    expect(all).toContain("Plan is set for today.");
    expect(all).toContain("Next up is the review.");
  });

  it("merges a tiny sentence with the next, like the 1:1 path, and flushes a lone one at settle", () => {
    const { voice, said } = setup();
    voice.update(sable, "Sure. I will check the deploy now. Ok");
    expect(said()).toEqual(["Sure. I will check the deploy now."]);
    voice.settle(sable, "Sure. I will check the deploy now. Ok.");
    expect(said()).toEqual(["Sure. I will check the deploy now.", "Ok."]);
  });

  it("does not say a settled block again when its stream is still on screen", () => {
    const { voice, said } = setup();
    voice.update(sable, "All done with the work. Tail");
    voice.settle(sable, "All done with the work. Tail end.");
    voice.update(sable, "All done with the work. Tail end. ");
    expect(said()).toEqual(["All done with the work.", "Tail end."]);
  });
});
