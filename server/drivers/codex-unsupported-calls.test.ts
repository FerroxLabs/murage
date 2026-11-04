// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// D20, adapted from OpenMausBot cc411b61b: the tools Codex refused as "unsupported call" are read from what the turn
// appended to its rollout file.
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDirSync } from "../testing/cleanup.ts";
import { rolloutMark, unsupportedCallsIn, unsupportedCallsNotice, unsupportedCallsSince } from "./codex-unsupported-calls.ts";

const item = (payload: unknown) => `${JSON.stringify({ timestamp: "2026-10-26T02:17:00.000Z", type: "response_item", payload })}\n`;
// What a provider that drops `namespace` makes Codex write: the bare-named call, then Codex's own refusal.
const refused = (tool: string, callId = `call_${tool}`) =>
  item({ type: "function_call", name: tool, arguments: "{}", call_id: callId }) +
  item({ type: "function_call_output", call_id: callId, output: `unsupported call: ${tool}` });

const dirs: string[] = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "murage-rollout-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });

describe("unsupportedCallsIn", () => {
  it("finds a namespace-less MCP call Codex refused, once per tool", () => {
    const text = refused("retry_thread") + refused("retry_thread", "call_2") + refused("coordinate_bots");
    expect(unsupportedCallsIn(text)).toEqual(["retry_thread", "coordinate_bots"]);
  });

  it("reads Codex's content-item output form too", () => {
    expect(unsupportedCallsIn(item({ type: "function_call_output", call_id: "c", output: [{ type: "input_text", text: "unsupported call: session_search" }] })))
      .toEqual(["session_search"]);
  });

  it("ignores a tool's own output, a message quoting the words, and a torn line", () => {
    const text = item({ type: "function_call_output", call_id: "c", output: "the API said: unsupported call: nope" }) +
      item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "unsupported call: retry_thread" }] }) +
      "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"output\":\"unsupported call: half";
    expect(unsupportedCallsIn(text)).toEqual([]);
  });
});

describe("unsupportedCallsSince", () => {
  it("reads only what the turn appended", () => {
    const dir = scratch();
    const path = join(dir, "rollout.jsonl");
    writeFileSync(path, refused("coordinate_bots"));
    const mark = rolloutMark(path, [dir]);
    appendFileSync(path, refused("retry_thread"));
    expect(unsupportedCallsSince(mark)).toEqual(["retry_thread"]);
  });

  it("reads a rollout rewritten shorter from its top, and gives up quietly on a missing one", () => {
    const dir = scratch();
    const path = join(dir, "rollout.jsonl");
    writeFileSync(path, refused("coordinate_bots") + refused("browser_open"));
    const mark = rolloutMark(path, [dir]);
    writeFileSync(path, refused("retry_thread"));
    expect(unsupportedCallsSince(mark)).toEqual(["retry_thread"]);
    expect(rolloutMark(join(dir, "missing.jsonl"), [dir])).toBeNull();
    expect(rolloutMark(null, [dir])).toBeNull();
    expect(unsupportedCallsSince({ path: join(scratch(), "missing.jsonl"), offset: 0 })).toEqual([]);
  });

  it("reads only an absolute .jsonl file Codex named", () => {
    const dir = scratch();
    writeFileSync(join(dir, "notes.txt"), refused("retry_thread"));
    mkdirSync(join(dir, "folder.jsonl"));
    expect(rolloutMark(join(dir, "notes.txt"), [dir])).toBeNull();
    expect(rolloutMark(join(dir, "folder.jsonl"), [dir])).toBeNull();
    expect(rolloutMark("relative/rollout.jsonl", [dir])).toBeNull();
    const outside = join(scratch(), "rollout.jsonl");
    writeFileSync(outside, "");
    expect(rolloutMark(outside, [dir])).toBeNull();
    expect(rolloutMark(outside, [undefined])).toBeNull();
    mkdirSync(join(dir, "sessions"));
    writeFileSync(join(dir, "sessions", "in.jsonl"), "");
    expect(rolloutMark(join(dir, "sessions", "in.jsonl"), [undefined, dir])).not.toBeNull();
  });

  it("never reads through a link, nor a different file swapped in at the path", () => {
    const dir = scratch();
    const real = join(dir, "real.jsonl");
    writeFileSync(real, refused("retry_thread"));
    if (process.platform !== "win32") {
      const link = join(dir, "link.jsonl");
      symlinkSync(real, link);
      expect(rolloutMark(link, [dir])).toBeNull();
      const path = join(dir, "rollout.jsonl");
      writeFileSync(path, "");
      const mark = rolloutMark(path, [dir]);
      renameSync(path, join(dir, "old.jsonl"));
      symlinkSync(real, path);
      expect(unsupportedCallsSince(mark)).toEqual([]);
    }
    const path = join(dir, "swapped.jsonl");
    writeFileSync(path, refused("coordinate_bots"));
    const mark = rolloutMark(path, [dir]);
    const next = join(dir, "next.jsonl");
    writeFileSync(next, refused("coordinate_bots") + refused("browser_open"));
    renameSync(next, path);
    expect(unsupportedCallsSince(mark)).toEqual([]);
  });

  it("stops at its byte cap", () => {
    const dir = scratch();
    const path = join(dir, "rollout.jsonl");
    writeFileSync(path, "");
    const mark = rolloutMark(path, [dir]);
    appendFileSync(path, refused("retry_thread") + refused("coordinate_bots"));
    expect(unsupportedCallsSince(mark, refused("retry_thread").length)).toEqual(["retry_thread"]);
  });
});

it("names the refused tools and what to do", () => {
  expect(unsupportedCallsNotice("Codex", ["retry_thread"])).toMatch(/^Codex could not run the tool retry_thread: the AI provider sent the call back/);
  expect(unsupportedCallsNotice("Codex", ["a", "b", "c", "d", "e", "f", "g", "h"])).toContain("the tools a, b, c, d, e, f and 2 more");
});
