// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A room reply always says who wrote it. With tool calls hidden, each bot's
// folded activity run is not drawn; it used to still count as the previous
// row, so the reply after it matched "same sender" and lost its name label
// (two bots answering in a row showed two unlabelled bubbles).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./GroupView.tsx", import.meta.url), "utf8");
const transcript = source.slice(source.indexOf("const Transcript = memo("), source.indexOf("function DefaultResponderSelect("));

describe("room sender labels", () => {
  it("judges a new sender against the last row actually drawn, not the last item", () => {
    expect(transcript).toContain("const prev = shownPrev;");
    expect(transcript).not.toMatch(/items\[i - 1\]/);
  });

  it("only a drawn row becomes the previous sender", () => {
    // Set exactly twice: a drawn run, and a drawn message row. Never before a
    // `return null` (hidden run, streaming bubble, quiet step).
    expect(transcript.match(/shownPrev = /g)).toHaveLength(2);
    expect(transcript).toMatch(/shownPrev = item\.messages\.at\(-1\);\s*return \(/);
    expect(transcript).toMatch(/if \(!row\) return null;\s*shownPrev = m;/);
    expect(transcript).toMatch(/if \(!showToolCalls\) return null;\s*const turnOpens/);
  });

  it("an error row uses Murage presentation, never bot speech", () => {
    expect(source).toContain('import { isErrorActivity } from "../../shared/message-visibility";');
    expect(transcript).toContain("const errorRow = isErrorActivity(m);");
    expect(transcript).toContain('actor === "murage" || errorRow');
    expect(transcript).toContain('actor === "bot" && !errorRow && m.from && newTurn');
  });
});

// B5: every bot turn names its speaker (a second reply from the same bot,
// a tool-only turn, the live Thinking row), and says what it answers when
// that is not the row right above.
describe("room speaker per turn", () => {
  it("a message row and a tool run both open with the speaker on each new turn", () => {
    expect(transcript).toContain("const newTurn = startsBotTurn(prev, m) || newDay;");
    expect(transcript).toContain("const turnOpens = startsBotTurn(prev, first) || newDay;");
    expect(transcript).not.toContain("newCluster");
  });

  it("reply targets come from the full transcript, and the chip hides when the target is the row above", () => {
    expect(transcript).toContain("sameThreadReply(message, transcript)");
    expect(transcript).toMatch(/const shownReplyTo = \(id: string, above: Message \| undefined\)/);
    expect(transcript).toContain("target.id === above?.id");
  });

  it("the pair-room chip stays visible with tool calls off and opens the pair room", () => {
    expect(transcript).toContain("m.comm ? (");
    expect(transcript).toMatch(/<RoomCommChip[\s\S]*?onOpen=\{\(\) => dispatch\(\{ type: "select", id: m\.comm!\.groupId \}\)\}/);
  });

  it("the live row names who is working", () => {
    expect(source).toMatch(/<TurnPresence[\s\S]*?name=\{presenceName\}/);
  });

  it("an unnamed live row does not borrow the first member's mascot (audit)", () => {
    expect(source).not.toContain("members.find((member) => member.id === popping?.botId) ?? members[0]");
  });

  it("a popped answer keeps its own author's name while the next member works (audit)", () => {
    expect(source).toMatch(/const presenceName = popping\s*\?\s*poppingMessage\?\.from\?\.name/);
    expect(source).toMatch(/:\s*speaker\?\.name;/);
  });
});
