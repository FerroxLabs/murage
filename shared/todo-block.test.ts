// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import type { AgentPlanEntry } from "./agent-plan";
import { createTodoBlockFilter, extractTodoBlocks, TODO_BLOCK_MAX_CHARS } from "./todo-block";

// The reply from FerroxLabs/murage#7 (a local Gemma model over vLLM).
const ISSUE_REPLY = [
  "I understand. We'll prioritize resolving the API issue and ensuring we can target by ID.",
  "",
  "To get started, I'll explore the `TVControl` directory to understand its structure.",
  "",
  "<todo>",
  "- [ ] Explore `C:\\Users\\Alice\\tvcontrol` to understand the current setup and API interface.",
  "- [ ] Identify the API issue and target-by-ID implementation needs.",
  "</todo>",
  "",
  "I'll start by listing the contents of the `TVControl` directory.",
].join("\n");

const ISSUE_VISIBLE = [
  "I understand. We'll prioritize resolving the API issue and ensuring we can target by ID.",
  "",
  "To get started, I'll explore the `TVControl` directory to understand its structure.",
  "",
  "I'll start by listing the contents of the `TVControl` directory.",
].join("\n");

const ISSUE_PLAN: AgentPlanEntry[] = [
  { content: "Explore `C:\\Users\\Alice\\tvcontrol` to understand the current setup and API interface.", status: "pending" },
  { content: "Identify the API issue and target-by-ID implementation needs.", status: "pending" },
];

/** Feeds `text` in the given pieces and collects everything the filter let through. */
function streamed(pieces: string[]) {
  const filter = createTodoBlockFilter();
  let text = "";
  const plans: AgentPlanEntry[][] = [];
  for (const piece of pieces) {
    const out = filter.push(piece);
    text += out.text;
    plans.push(...out.plans);
  }
  const end = filter.flush();
  return { text: text + end.text, plans: [...plans, ...end.plans] };
}

describe("extractTodoBlocks", () => {
  it("turns the reply from issue #7 into a plan and removes the block from the answer", () => {
    expect(extractTodoBlocks(ISSUE_REPLY)).toEqual({ text: ISSUE_VISIBLE, plans: [ISSUE_PLAN] });
  });

  it("reads checked, in-progress, numbered and plain items", () => {
    const { text, plans } = extractTodoBlocks("<TODO>\n* [x] Read the folder\n2. [~] Fix the bug\n+ Report back\n- [X] Tidy up\n</TODO>\nDone.");
    expect(text).toBe("Done.");
    expect(plans).toEqual([[
      { content: "Read the folder", status: "completed" },
      { content: "Fix the bug", status: "in_progress" },
      { content: "Report back", status: "pending" },
      { content: "Tidy up", status: "completed" },
    ]]);
  });

  it("handles a block written on one line, and text after the closing tag", () => {
    expect(extractTodoBlocks("Plan:\n<todo>- [ ] one</todo> Starting now.")).toEqual({
      text: "Plan:\nStarting now.",
      plans: [[{ content: "one", status: "pending" }]],
    });
  });

  it("reports each block as the whole list, in order, so a later one replaces the first", () => {
    const { text, plans } = extractTodoBlocks("<todo>\n- [ ] a\n- [ ] b\n</todo>\nWorking.\n<todo>\n- [x] a\n- [ ] b\n</todo>\nHalfway.");
    expect(text).toBe("Working.\nHalfway.");
    expect(plans).toEqual([
      [{ content: "a", status: "pending" }, { content: "b", status: "pending" }],
      [{ content: "a", status: "completed" }, { content: "b", status: "pending" }],
    ]);
  });

  describe("never loses text that is not really a to-do block", () => {
    const verbatim = [
      ["a tag in the middle of a sentence", "Wrap the list in a <todo> tag like <todo>- [ ] a</todo> and send it."],
      ["a block inside a code fence", "Example:\n```xml\n<todo>\n- [ ] a\n</todo>\n```\nThat is the format."],
      ["a block inside a tilde fence", "~~~\n<todo>\n- [ ] a\n</todo>\n~~~"],
      ["a block with prose in it", "<todo>\nThis is not a list at all.\n- [ ] a\n</todo>\nAfter."],
      ["a block that is never closed", "Here:\n<todo>\n- [ ] a\n- [ ] b\nand the model stopped"],
      ["an unclosed block that is only list items", "<todo>\n- [ ] a\n- [ ] b\n"],
      ["an empty block", "<todo>\n</todo>\nText."],
      ["a different tag", "<todos>\n- [ ] a\n</todos>"],
      ["a partial tag at the very end", "All done.\n<tod"],
    ] as const;
    for (const [name, input] of verbatim) {
      it(name, () => expect(extractTodoBlocks(input)).toEqual({ text: input, plans: [] }));
    }

    it("a block that grows past the size bound", () => {
      const input = `<todo>\n${"- [ ] step\n".repeat(Math.ceil(TODO_BLOCK_MAX_CHARS / 11) + 1)}</todo>\nAfter.`;
      expect(extractTodoBlocks(input)).toEqual({ text: input, plans: [] });
    });

    it("keeps a real block that follows a false start", () => {
      const { text, plans } = extractTodoBlocks("<todo>\nnot a list\n</todo>\n<todo>\n- [ ] real\n</todo>\nEnd.");
      expect(text).toBe("<todo>\nnot a list\n</todo>\nEnd.");
      expect(plans).toEqual([[{ content: "real", status: "pending" }]]);
    });
  });
});

describe("createTodoBlockFilter across streaming chunks", () => {
  const inputs = [
    ISSUE_REPLY,
    "Intro\n\n<todo>\n- [x] one\n- [ ] two\n</todo>\n\nOutro",
    "<todo>- [ ] one</todo> Starting now.",
    "```\n<todo>\n- [ ] a\n</todo>\n```\n<todo>\n- [ ] b\n</todo>\nok",
    "<todo>\nprose here\n</todo>\ntext",
    "Here:\n<todo>\n- [ ] a\nunfinished",
  ];

  it("gives the same answer and plans however the text is split", () => {
    for (const input of inputs) {
      const whole = extractTodoBlocks(input);
      expect(streamed([...input])).toEqual(whole);
      for (let cut = 0; cut <= input.length; cut++) {
        expect(streamed([input.slice(0, cut), input.slice(cut)])).toEqual(whole);
      }
      for (let size = 2; size <= 9; size++) {
        const pieces: string[] = [];
        for (let at = 0; at < input.length; at += size) pieces.push(input.slice(at, at + size));
        expect(streamed(pieces)).toEqual(whole);
      }
    }
  });

  it("lets ordinary text through as it arrives instead of holding it back", () => {
    const filter = createTodoBlockFilter();
    expect(filter.push("Hello wor").text).toBe("Hello wor");
    expect(filter.push("ld.\n").text).toBe("ld.\n");
    // Only the start of a line that could still become <todo> is held.
    expect(filter.push("<to").text).toBe("");
    expect(filter.push("day is fine").text).toBe("<today is fine");
  });

  it("sends the plan the moment the block closes, before the rest of the answer", () => {
    const filter = createTodoBlockFilter();
    expect(filter.push("On it.\n<todo>\n- [ ] a\n")).toEqual({ text: "On it.\n", plans: [] });
    expect(filter.push("</todo>")).toEqual({ text: "", plans: [[{ content: "a", status: "pending" }]] });
    expect(filter.push("\nNext.")).toEqual({ text: "Next.", plans: [] });
    expect(filter.flush()).toEqual({ text: "", plans: [] });
  });

  it("releases a held block at the end when it was never a to-do list", () => {
    const filter = createTodoBlockFilter();
    expect(filter.push("<todo>\n- [ ] a\n").text).toBe("");
    expect(filter.flush()).toEqual({ text: "<todo>\n- [ ] a\n", plans: [] });
  });
});
