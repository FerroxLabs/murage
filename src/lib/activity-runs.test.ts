import { describe, expect, it } from "vitest";

import { describeRun, describeRunRaw, groupActivityRuns, groupTranscript } from "./activity-runs";
import type { Message } from "@/state/store";
import { STOPPED_MID_DESKTOP_ACTION } from "../../shared/host-stop";
import { browserUnavailableActivityName } from "../../shared/browser-unavailable";
import { imagesLeftOutActivityName } from "../../shared/images-left-out";
import { imagesNotSentActivityName } from "../../shared/turn-image-note";
import { folderTrustWithheldName } from "../../shared/folder-trust";
import { TURN_STOPPED_NOTE } from "../../server/turn-outcome";

let seq = 0;
const tool = (name: string, ok = true): Message =>
  ({ id: `t${++seq}`, at: seq, role: "bot", kind: "activity", tool: { name, ok } });
/** a step with no verdict yet — `ok` absent, not `ok: undefined`, which a
 * default parameter would quietly turn back into a finished step */
const running = (name: string): Message =>
  ({ id: `t${++seq}`, at: seq, role: "bot", kind: "activity", tool: { name } });
const text = (body: string): Message => ({ id: `m${++seq}`, at: seq, role: "bot", kind: "text", text: body });

describe("groupActivityRuns", () => {
  it("folds consecutive tool steps into one run", () => {
    const items = groupActivityRuns([tool("Edit"), tool("Bash"), tool("Edit")]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("run");
    expect(items[0].kind === "run" && items[0].messages).toHaveLength(3);
  });

  it("keeps text between runs, so a run never swallows what the bot said", () => {
    const items = groupActivityRuns([tool("Edit"), tool("Edit"), text("Now the sitemap:"), tool("Write"), tool("Write")]);
    expect(items.map((i) => i.kind)).toEqual(["run", "message", "run"]);
  });

  it("leaves a lone tool step as an ordinary message", () => {
    const items = groupActivityRuns([text("hi"), tool("Edit"), text("done")]);
    expect(items.map((i) => i.kind)).toEqual(["message", "message", "message"]);
  });

  it("keeps a step that is still running out of the run, so live progress stays visible", () => {
    const items = groupActivityRuns([tool("Edit"), tool("Edit"), running("Bash")]);
    expect(items.map((i) => i.kind)).toEqual(["run", "message"]);
    expect(items[1].kind === "message" && items[1].message.tool?.name).toBe("Bash");
  });

  it("never folds a failed turn, which renders as an error not a tool run", () => {
    const items = groupActivityRuns([tool("Edit"), tool("error: the CLI exited")]);
    expect(items.map((i) => i.kind)).toEqual(["message", "message"]);
  });

  it("keeps ordinary failed tools visible between successful runs", () => {
    const items = groupActivityRuns([
      tool("Read"),
      tool("Edit"),
      tool("Bash", false),
      tool("Write"),
      tool("Write"),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["run", "message", "run"]);
  });

  it("gives a run a stable id taken from its first step", () => {
    const steps = [tool("Edit"), tool("Edit")];
    const items = groupActivityRuns(steps);
    expect(items[0].kind === "run" && items[0].id).toBe(`run:${steps[0].id}`);
  });

  it("does not attribute consecutive room steps from different bots to one sender", () => {
    const roomTool = (name: string, botId: string): Message => ({
      ...tool(name),
      from: { botId, name: botId, color: "blue" },
    });

    expect(
      groupActivityRuns([
        roomTool("Read", "alice"),
        roomTool("Edit", "alice"),
        roomTool("Write", "bob"),
        roomTool("Bash", "bob"),
      ]).map((item) => item.kind),
    ).toEqual(["run", "run"]);
  });

  it("keeps local calendar-day boundaries between activity runs", () => {
    const beforeMidnight = new Date(2026, 0, 1, 23, 59).getTime();
    const afterMidnight = new Date(2026, 0, 2, 0, 1).getTime();
    const stepAt = (name: string, at: number): Message => ({ ...tool(name), at });

    expect(
      groupActivityRuns([
        stepAt("Read", beforeMidnight),
        stepAt("Edit", beforeMidnight),
        stepAt("Write", afterMidnight),
        stepAt("Bash", afterMidnight),
      ]).map((item) => item.kind),
    ).toEqual(["run", "run"]);
  });
});

describe("describeRun", () => {
  it("names the work in plain words, once each, in order of first use", () => {
    expect(describeRun([tool("Edit"), tool("Bash"), tool("Edit"), tool("Edit")])).toBe("4 steps · edited files, ran commands");
  });

  it("reads a long run the way a person would say it", () => {
    expect(describeRun([tool("Read"), tool("Edit"), tool("Bash")])).toBe("3 steps · read files, edited files, ran commands");
  });

  it("keeps the exact tool names for the hover text", () => {
    expect(describeRunRaw([tool("Edit"), tool("Bash"), tool("Edit"), tool("Edit")])).toBe("Edit ×3, Bash");
  });

  it("trims a long tail of names rather than running off the row", () => {
    expect(describeRun([tool("Edit"), tool("Bash"), tool("WebSearch"), tool("Grep"), tool("Read")])).toBe(
      "5 steps · edited files, ran commands, searched the web +2 more",
    );
  });
});

describe("groupTranscript", () => {
  const assistant = (
    body: string,
    turnId: string,
    turnTerminal = false,
    at = ++seq * 1_000,
  ): Message => ({
    id: `m${++seq}`,
    at,
    role: "bot",
    kind: "text",
    text: body,
    turnId,
    turnTerminal,
  });

  const step = (name: string, turnId: string, at = ++seq * 1_000, ok = true): Message =>
    ({ id: `t${++seq}`, at, role: "bot", kind: "activity", tool: { name, ok }, turnId });

  // E34 (upstream f807c761a): the bot's progress lines stay; only finished tool steps fold.
  it("keeps the bot's progress lines above the answer and folds only the settled turn's tool steps", () => {
    const user: Message = { id: "u1", at: 1_000, role: "user", kind: "text", text: "compare note-takers" };
    const ack = assistant("I'll check current pricing since this changes often.", "turn-1", false, 2_000);
    const search = step("WebSearch", "turn-1", 2_500);
    const read = step("WebFetch", "turn-1", 3_000);
    const helper = assistant("I'll ask a research helper for the details.", "turn-1", false, 3_500);
    const fetch = step("WebFetch", "turn-1", 4_000);
    const final = assistant("Here are the three best.", "turn-1", true, 30_000);

    const items = groupTranscript([user, ack, search, read, helper, fetch, final]);
    expect(items.map((item) => item.kind === "message" ? item.message.id : item.kind)).toEqual([user.id, ack.id, "turn", helper.id, final.id]);
    expect(items[2]).toMatchObject({ kind: "turn", id: "turn:turn-1", label: "Worked for 29s", messages: [search, read, fetch] });
  });

  it("never folds a line the bot said, so a turn with only lines makes no fold", () => {
    const user: Message = { id: "u0", at: 1_000, role: "user", kind: "text", text: "check todoist" };
    const first = assistant("I'm checking connected apps.", "turn-0", false, 2_000);
    const second = assistant("I'm reading your tasks.", "turn-0", false, 3_000);
    const final = assistant("You have three tasks.", "turn-0", true, 5_000);
    expect(groupTranscript([user, first, second, final])).toEqual([user, first, second, final].map((message) => ({ kind: "message", message })));
  });

  it("shows just the answer for a turn with nothing to say: its steps fold", () => {
    const user: Message = { id: "u2", at: 1_000, role: "user", kind: "text", text: "what time is it in Tokyo?" };
    const lookup = step("Bash", "turn-2", 1_500);
    const final = assistant("It's 9:30 PM in Tokyo.", "turn-2", true, 5_000);
    const items = groupTranscript([user, lookup, final]);
    expect(items.map((item) => item.kind)).toEqual(["message", "turn", "message"]);
    expect(items[1]).toMatchObject({ label: "Worked for 4s", messages: [lookup] });
  });

  it("leaves a failed step where it was", () => {
    const ok = step("Read", "turn-3");
    const failed = step("Bash", "turn-3", ++seq * 1_000, false);
    const final = assistant("Done.", "turn-3", true);
    const items = groupTranscript([ok, failed, final]);
    expect(items.map((item) => item.kind === "message" ? item.message.id : item.kind)).toEqual(["turn", failed.id, final.id]);
  });

  it("keeps every message visible until the turn settles", () => {
    const first = assistant("Checking.", "turn-live");
    const second = assistant("Still checking.", "turn-live");
    expect(groupTranscript([first, second]).map((item) => item.kind)).toEqual(["message", "message"]);
  });

  it("keeps a lone terminal message as the answer", () => {
    const only = assistant("I could not finish, but here is what I found.", "turn-short", true);
    expect(groupTranscript([only])).toEqual([{ kind: "message", message: only }]);
  });

  // GROK-812MIN-STOPPED: a turn the owner did not start here (a delegation, a queued prompt) read "Worked for 812m"
  // because the walk back reached an owner message from the evening before, past other turns' rows.
  it("counts a turn from its own first row, never back past another turn to an older owner message", () => {
    const evening: Message = { id: "u-evening", at: 1_000, role: "user", kind: "text", text: "make three pictures" };
    const earlier = assistant("Here they are.", "turn-evening", true, 2_000);
    const chip: Message = { id: "t-edit", at: 50_000_000, role: "bot", kind: "activity", tool: { name: "image_edit", ok: true }, turnId: "turn-image" };
    const progress = assistant("Editing the second picture.", "turn-image", false, 50_005_000);
    const final = assistant("Done.", "turn-image", true, 50_065_000);
    const fold = groupTranscript([evening, earlier, chip, progress, final]).find((item) => item.kind === "turn");
    expect(fold).toMatchObject({ kind: "turn", turnId: "turn-image", label: "Worked for 1m 05s" });
  });

  it("still counts from the owner message that started the turn, across rows that belong to no turn", () => {
    const ask: Message = { id: "u-ask", at: 10_000, role: "user", kind: "text", text: "check todoist" };
    const notice: Message = { id: "n1", at: 11_000, role: "bot", kind: "options", card: { title: "Allow?", options: ["Allow", "Deny"], requestId: "r1" } } as Message;
    const progress = step("Read", "turn-2", 12_000);
    const final = assistant("Three tasks.", "turn-2", true, 20_000);
    expect(groupTranscript([ask, notice, progress, final]).find((item) => item.kind === "turn")).toMatchObject({ label: "Worked for 10s" });
  });

  // GROK-STOPPED F5: a host-stop notice closed the owner's turn; a later background turn never counts the idle gap.
  it("never counts back past a host-stop notice to the owner message before it", () => {
    const ask: Message = { id: "u-ask", at: 10_000, role: "user", kind: "text", text: "make a picture" };
    const stop: Message = { id: "n-stop", at: 20_000, role: "bot", kind: "activity", tool: { name: "stopped: a request went unanswered", ok: false } };
    const progress = step("Read", "turn-bg", 40_000_000);
    const final = assistant("Done.", "turn-bg", true, 40_010_000);
    expect(groupTranscript([ask, stop, progress, final]).find((item) => item.kind === "turn")).toMatchObject({ label: "Worked for 10s" });
  });

  it("does not fold steps from a different turn", () => {
    const older = step("Read", "turn-old");
    const progress = step("Edit", "turn-new");
    const final = assistant("Done.", "turn-new", true);
    expect(groupTranscript([older, progress, final]).map((item) => item.kind === "turn" ? item.messages.map((m) => m.id) : item.kind)).toEqual([
      "message",
      [progress.id],
      "message",
    ]);
  });
});

// A run is hidden entirely with Settings → Tool calls off (ChatView and
// GroupView both return null for it). The quiet notes have their own rows
// precisely so they survive that setting, and a stop lands right after a
// stretch of tool calls — exactly where a run forms — so folding one puts
// it straight back behind the setting its row exists to escape.
describe("the quiet notes are never folded into a run", () => {
  const note = (name: string): Message =>
    ({ id: `n${++seq}`, at: seq, role: "bot", kind: "activity", tool: { name, ok: true } });

  it.each([
    ["a turn you stopped", TURN_STOPPED_NOTE],
    ["a stop that caught a desktop action", STOPPED_MID_DESKTOP_ACTION],
    ["a folder whose sources were withheld", folderTrustWithheldName(["CLAUDE.md"])],
    ["a turn that ran without its browser", browserUnavailableActivityName("the browser engine did not start")],
    ["a picture left out for a model that cannot see", imagesLeftOutActivityName(1)],
    ["a turn that left images out", imagesNotSentActivityName({ sent: 10, overCount: 2, tooLarge: 0 })],
  ])("keeps %s on its own after a stretch of tool calls", (_what, name) => {
    const items = groupActivityRuns([tool("Edit"), tool("Bash"), note(name)]);
    expect(items.map((i) => i.kind)).toEqual(["run", "message"]);
    expect(items[1].kind === "message" && items[1].message.tool?.name).toBe(name);
  });

  it("still folds the tool calls on either side of one", () => {
    const items = groupActivityRuns([tool("Edit"), tool("Bash"), note(TURN_STOPPED_NOTE), tool("Edit"), tool("Edit")]);
    expect(items.map((i) => i.kind)).toEqual(["run", "message", "run"]);
  });
});

// 1.0.14 (Sable, 11-02): a voice note the bot sent mid-turn sat inside the
// collapsed "Worked for" row, so the owner never saw or heard it. A row that
// carries a file is something the bot handed over: it stays in the reply, on
// the desktop and in the phone's web view alike (one shared ChatView).
describe("groupTranscript keeps what the bot handed over out of the fold", () => {
  const row = (id: string, at: number, text: string, extra: Partial<Message> = {}): Message =>
    ({ id, at, role: "bot", kind: "text", text, turnId: "turn-v", turnTerminal: false, ...extra });
  const user: Message = { id: "u-v", at: 1_000, role: "user", kind: "text", text: "send me a voice note" };
  const ARTIFACT = "0f1e2d3c-4b5a-4968-8776-655443322110";
  const cases: Array<[string, Partial<Message>]> = [
    ["a voice note", { text: "Morning, boss.", artifactIds: [ARTIFACT] }],
    ["a register_file saved-file card", { text: "Saved file: report.pdf", artifactIds: [ARTIFACT] }],
    ["an output card for files and images", { text: "Saved 2 files", artifactIds: [ARTIFACT, "1f1e2d3c-4b5a-4968-8776-655443322110"] }],
  ];
  for (const [name, extra] of cases) {
    it(`${name} stays visible with the lines around it, and only the step folds`, () => {
      const before = row("n1", 2_000, "Writing it now.");
      const work: Message = { id: "s1", at: 2_500, role: "bot", kind: "activity", tool: { name: "tts", ok: true }, turnId: "turn-v" };
      const delivered = row("d1", 3_000, String(extra.text), extra);
      const after = row("n2", 4_000, "Sent.");
      const reply = row("r1", 5_000, "Done, it is in the chat.", { turnTerminal: true });
      const items = groupTranscript([user, before, work, delivered, after, reply]);
      const fold = items.find((item) => item.kind === "turn");
      expect(fold && fold.kind === "turn" && fold.messages.map((message) => message.id)).toEqual(["s1"]);
      const shown = items.filter((item) => item.kind === "message").map((item) => item.kind === "message" ? item.message.id : "");
      expect(shown).toEqual(["u-v", "n1", "d1", "n2", "r1"]);
    });
  }

  it("a turn whose only earlier rows are deliverables makes no fold at all", () => {
    const delivered = row("d2", 2_000, "Morning, boss.", { artifactIds: [ARTIFACT] });
    const reply = row("r2", 3_000, "Sent you a voice note.", { turnTerminal: true });
    const items = groupTranscript([user, delivered, reply]);
    expect(items.map((item) => item.kind)).toEqual(["message", "message", "message"]);
  });
});
