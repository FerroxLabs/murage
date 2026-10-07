import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { checkReplyActions, toolAction } from "./reply-action-guard.ts";
import { detectActionClaims } from "../shared/reply-action-claims.ts";
import type { Message } from "./store.ts";

function verdict(action: ReturnType<typeof toolAction>, turnId = "turn") {
  const reply = { id: "reply", role: "bot", kind: "text", turnId: "turn", text: "I saved it. I changed it. I ran tests. I sent it. I paid it. I delegated it." } as Message;
  const row = { id: "tool", role: "bot", kind: "activity", turnId, tool: { name: action.name!, ok: true, action } } as Message;
  return checkReplyActions({ reply, path: [row, reply] }).claims.map(claim => claim.state);
}

it("N9 opaque wrappers cover only their known operation classes", () => {
  expect(verdict(toolAction("MULTI_EXECUTE_TOOL", true))).toEqual(Array(6).fill("flagged"));
  expect(verdict(toolAction("MULTI_EXECUTE_TOOL", true, { tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }] })))
    .toEqual(["flagged", "flagged", "flagged", "unverifiable", "flagged", "flagged"]);
});

it("N10 successful shells cover file classes only in their own turn", () => {
  const shell = toolAction("shell", true, undefined, { exitCode: 0 });
  expect(shell.outcome).toBe("opaque");
  expect(verdict(shell)).toEqual(["unverifiable", "unverifiable", "unverifiable", "flagged", "flagged", "flagged"]);
  expect(verdict(shell, "earlier")).toEqual(Array(6).fill("flagged"));
  expect(verdict(toolAction("shell", true, undefined, { exitCode: 1 }))).toEqual(Array(6).fill("flagged"));
  expect(verdict(toolAction("shell", false, undefined, { exitCode: 0 }))).toEqual(Array(6).fill("flagged"));
});

it.each([false, true])("N11 duplicate slugs preserve occurrence outcomes, reversed=%s", reversed => {
  const tools = [{ tool_slug: "GMAIL_SEND_EMAIL" }, { tool_slug: "GMAIL_SEND_EMAIL" }];
  const results = tools.map((call, i) => ({ ...call, response: { successful: reversed ? i === 1 : i === 0 } }));
  const action = toolAction("MULTI_EXECUTE_TOOL", true, { tools }, { results });
  expect(action.operations?.map(operation => operation.outcome)).toEqual(reversed ? ["failed", "completed"] : ["completed", "failed"]);
  expect(verdict(action)[3]).toBe("recorded");
});

it("N11 missing or mismatched receipts cannot borrow another call's result", () => {
  const tools = [{ tool_slug: "GMAIL_SEND_EMAIL", call_id: "a" }, { tool_slug: "GMAIL_SEND_EMAIL", call_id: "b" }];
  const action = toolAction("MULTI_EXECUTE_TOOL", true, { tools }, { results: [{ tool_slug: "GMAIL_SEND_EMAIL", call_id: "b", response: { successful: true } }] });
  expect(action.operations?.map(operation => operation.outcome)).toEqual(["opaque", "completed"]);
  const mismatch = toolAction("MULTI_EXECUTE_TOOL", true, { tools }, { results: tools.map(call => ({ ...call, call_id: "other", response: { successful: true } })) });
  expect(mismatch.operations?.map(operation => operation.outcome)).toEqual(["opaque", "opaque"]);
});

it.each(["Alex said hello; I sent it", "Alex said hello, but I sent it", "Alex said hello and I sent it", "Alex said hello, I sent it", "Alex said: I saved it; I sent it", "Alex: I saved it; I sent it"])("N12 independent assertion is checked: %s", text => {
  expect(detectActionClaims(text).claims.map(claim => [claim.class, text.slice(...claim.span)])).toEqual([["send", "I sent"]]);
});

it.each(["Alex said I sent it", "Alex said: I sent it", "Alex: I sent it", "Alex said I saved it and I sent it", "Alex said that I saved it, and that I sent it"])("N12 governed speech stays excluded: %s", text => {
  expect(detectActionClaims(text).claims).toEqual([]);
});

it.each([
  "Alex said hello and then I sent it",
  "Alex said hello but then I sent it",
  "Alex said hello and later I sent it",
  "Alex said hello and finally I sent it",
  "Alex said that I saved the draft, and then I sent it",
  "Alex said that I saved the draft, but then I sent it",
  "Alex said that I saved the draft, but I sent it",
  "Alex said that I saved the draft, but that I sent the wrong file; then I sent it",
])("N12/N13 independent assertion resets reporting: %s", text => {
  expect(detectActionClaims(text).claims.map(claim => [claim.class, text.slice(...claim.span)])).toEqual([["send", "I sent"]]);
});

it.each([
  "Alex said that I saved the draft, but that I sent the wrong file",
  "Alex said that I saved the draft and that I sent the wrong file",
  "Alex said that I saved the draft, but that I then sent the wrong file",
  "Alex said that I saved the draft, but that then I sent the wrong file",
])("N13 coordinated complements stay reported: %s", text => {
  expect(detectActionClaims(text).claims).toEqual([]);
});

it.each([
  [{ status: "completed", exitCode: 0 }, true],
  [{ status: "completed", exitCode: 1 }, false],
  [{ status: "completed", exitCode: -1 }, false],
  [{ status: "completed", exitCode: null }, true],
  [{ status: "completed" }, true],
  [{ status: "completed", exitCode: "1" }, true],
  [{ status: "failed", exitCode: null }, false],
  [{ status: "declined" }, false],
])("command completion preserves status and numeric exit semantics: %j", (completion, ok) => {
  const source = readFileSync(new URL("./drivers/codex.ts", import.meta.url), "utf8");
  const at = source.indexOf('ok: item.status !== "failed"');
  const emitted: any[] = [];
  runInNewContext(source.slice(source.lastIndexOf("emit({", at), source.indexOf("});", at) + 3), {
    base: () => ({}), emit: (event: unknown) => emitted.push(event), threadId: "thread", turnId: "turn",
    item: { id: "command", type: "commandExecution", ...completion },
  });
  expect(emitted).toEqual([{ type: "item.completed", itemType: "tool", itemId: "command", ok, result: { exitCode: "exitCode" in completion ? completion.exitCode : undefined } }]);
  const action = toolAction("shell", emitted[0].ok, undefined, emitted[0].result);
  expect(action.outcome).toBe(ok ? "opaque" : "failed");
  expect(verdict(action)).toEqual(ok
    ? ["unverifiable", "unverifiable", "unverifiable", "flagged", "flagged", "flagged"]
    : Array(6).fill("flagged"));
});
