// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The record an image made without asking leaves in the conversation: what
// was made and the whole prompt, folded the way an approval card folds a long
// prompt (CollapsibleText).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { ImageRecordRow, isImageRecordLine } from "./ImageRecordRow";
import { groupActivityRuns } from "@/lib/activity-runs";

const LONG = "A very long image prompt. ".repeat(40).trim();
const line = (prompt: string): Message => ({ id: "m", role: "bot", kind: "activity", at: 1,
  tool: { name: "Making an image without asking (Full access)", ok: true, imageRecord: { summary: "One image · Flux · gpt-image-2.", prompt } } });
const render = (message: Message) => renderToStaticMarkup(createElement(ImageRecordRow, { message }));

describe("an image made without asking", () => {
  it("is recognised by its record, and a plain tool chip is not", () => {
    expect(isImageRecordLine(line("a cube"))).toBe(true);
    expect(isImageRecordLine({ id: "c", role: "bot", kind: "activity", at: 1, tool: { name: "Bash", ok: true } })).toBe(false);
  });
  it("shows what was made and a short prompt in full", () => {
    const markup = render(line("a red cube on a white table"));
    expect(markup).toContain("Making an image without asking (Full access)");
    expect(markup).toContain("One image · Flux · gpt-image-2.");
    expect(markup).toContain("a red cube on a white table");
    expect(markup).not.toContain("Show all");
  });
  it("folds a long prompt behind the same toggle the approval card uses, the whole prompt still there", () => {
    const markup = render(line(LONG));
    expect(markup).toContain('data-approval-held="collapsed"');
    expect(markup).toContain("Show all");
    expect(markup).toContain(LONG);
  });

  it("is never folded into a run of tool chips, so it stays visible with Tool calls off", () => {
    const chip = (id: string): Message => ({ id, role: "bot", kind: "activity", at: 1, tool: { name: "Read", ok: true } });
    const items = groupActivityRuns([chip("a"), chip("b"), { ...line("a cube"), id: "r" }, chip("c"), chip("d")]);
    expect(items.map(item => item.kind)).toEqual(["run", "message", "run"]);
    expect(items[1]).toMatchObject({ kind: "message", message: { id: "r" } });
  });
});
