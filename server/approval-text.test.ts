// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { approvalSummary } from "../shared/approval-summary.ts";
import {
  boundedToolInput,
  cardAuditSummary,
  cardDetail,
  codexApprovalText,
  commandText,
  shellJoin,
  MODEL_REASON_LABEL,
  TOOL_INPUT_MAX_BYTES,
  toolInputIsTruncated,
  approvalIsCut,
} from "./approval-text.ts";

describe("boundedToolInput", () => {
  it("keeps every argument, as JSON text", () => {
    const text = boundedToolInput({ url: "https://x.test/a", method: "DELETE", headers: { "x-id": "7" } })!;
    expect(JSON.parse(text)).toEqual({ url: "https://x.test/a", method: "DELETE", headers: { "x-id": "7" } });
  });

  it("is undefined for an empty or non-object input", () => {
    expect(boundedToolInput({})).toBeUndefined();
    expect(boundedToolInput(undefined)).toBeUndefined();
    expect(boundedToolInput("rm -rf /")).toBeUndefined();
  });

  it("never cuts silently: an input over the cap ends with a byte-count marker", () => {
    const input: Record<string, string> = {};
    for (let i = 0; i < 400; i++) input[`k${i}`] = "é".repeat(100);
    const text = boundedToolInput(input)!;
    const marker = text.match(/\n\[truncated, (\d+) bytes more\]$/);
    expect(marker).not.toBeNull();
    expect(toolInputIsTruncated(text)).toBe(true);
    const kept = Buffer.byteLength(text.slice(0, text.length - marker![0].length), "utf8");
    expect(kept).toBeLessThanOrEqual(TOOL_INPUT_MAX_BYTES);
    expect(kept + Number(marker![1])).toBe(Buffer.byteLength(JSON.stringify(input), "utf8"));
  });

  it("caps each string value, so padding before url and method cannot hide them", () => {
    const text = boundedToolInput({ body: "x".repeat(17_000), url: "https://evil.example/wipe", method: "DELETE" })!;
    const parsed = JSON.parse(text);
    expect(parsed.url).toBe("https://evil.example/wipe");
    expect(parsed.method).toBe("DELETE");
    expect(parsed.body).toMatch(/\[\d+ bytes more\]$/);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(TOOL_INPUT_MAX_BYTES);
    // a per-value cut is a cut: the owner cannot see the whole body
    expect(toolInputIsTruncated(text)).toBe(true);
  });

  it("a short input is not truncated", () => {
    expect(toolInputIsTruncated(boundedToolInput({ url: "https://a.test", method: "GET" }))).toBe(false);
  });

  it("a single value over the per-value cap marks the input truncated", () => {
    const text = boundedToolInput({ file_path: "a.txt", content: "y".repeat(3000) })!;
    expect(toolInputIsTruncated(text)).toBe(true);
  });

  it("shows a shell command in full, up to the overall cap", () => {
    const command = `echo ${"a".repeat(5000)} && echo tail-end-marker`;
    const text = boundedToolInput({ command, description: "d" })!;
    expect(JSON.parse(text).command).toBe(command);
    expect(toolInputIsTruncated(text)).toBe(false);
  });

  it("a shell command over the overall cap is truncated", () => {
    const text = boundedToolInput({ command: "z".repeat(20_000) })!;
    expect(toolInputIsTruncated(text)).toBe(true);
  });

  it("keeps the JSON valid when a PEM block is masked", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nAAAA\nBBBB\n-----END PRIVATE KEY-----";
    const text = boundedToolInput({ note: `see ${pem} ok`, method: "GET" })!;
    expect(() => JSON.parse(text)).not.toThrow();
    expect(text).not.toContain("AAAA");
  });

  it("masks a short password by its key name", () => {
    const text = boundedToolInput({ user: "bob", password: "hunter2" })!;
    expect(text).not.toContain("hunter2");
  });

  it("masks Authorization and Cookie header values by key name", () => {
    const text = boundedToolInput({ headers: { Authorization: "Basic dTpw", Cookie: "sid=abc" }, method: "GET" })!;
    expect(text).not.toContain("dTpw");
    expect(text).not.toContain("sid=abc");
  });

  it("masks credential values but keeps the JSON valid and the other arguments", () => {
    const text = boundedToolInput({ url: "https://x.test", method: "POST", headers: { Authorization: "Bearer abcdefghijklmnop1234" } })!;
    expect(text).not.toContain("abcdefghijklmnop1234");
    expect(JSON.parse(text)).toMatchObject({ method: "POST", url: "https://x.test" });
  });
});

describe("shell text", () => {
  it("quotes an argv array like a shell would", () => {
    expect(shellJoin(["git", "commit", "-m", "it's done"])).toBe(`git commit -m 'it'\\''s done'`);
    expect(commandText(["bash", "-lc", "rm -rf scratch"])).toBe("bash -lc 'rm -rf scratch'");
    expect(commandText("ls -la")).toBe("ls -la");
    expect(commandText([])).toBeUndefined();
  });
  it("makes newlines and hidden Unicode in an argument visible", () => {
    expect(shellJoin(["echo", "a\nb"])).toBe("echo $'a\\nb'");
    expect(shellJoin(["mv", "x\u202Egpj.exe"])).toBe("mv $'x\\u202egpj.exe'");
    expect(shellJoin(["git", "status; rm -rf ~"])).toBe("git 'status; rm -rf ~'");
  });
});

describe("codexApprovalText", () => {
  it("headlines the command, not the model's reason", () => {
    expect(codexApprovalText("execCommandApproval", { command: ["rm", "-rf", "build dir"], reason: "cleaning up" }, "shell")).toEqual({
      summary: "rm -rf 'build dir'",
      reason: "cleaning up",
    });
    expect(codexApprovalText("item/commandExecution/requestApproval", { command: "cat /etc/hosts", reason: "need hosts" }, "shell"))
      .toEqual({ summary: "cat /etc/hosts", reason: "need hosts" });
  });

  it("headlines the files of a patch, not the reason", () => {
    const params = { fileChanges: { "src/a.ts": {}, "src/b.ts": {} }, reason: "tidy up" };
    expect(codexApprovalText("applyPatchApproval", params, "edit")).toEqual({ summary: "src/a.ts, src/b.ts", reason: "tidy up" });
    expect(codexApprovalText("item/fileChange/requestApproval", { reason: "x" }, "edit", ["lib/c.ts"])).toEqual({ summary: "lib/c.ts", reason: "x" });
    expect(codexApprovalText("item/fileChange/requestApproval", { grantRoot: "/w", reason: "x" }, "edit").summary).toBe("all files under /w");
  });

  it("labels the reason when an edit names no files", () => {
    expect(codexApprovalText("item/fileChange/requestApproval", { reason: "Fix" }, "edit")).toEqual({ summary: "edit (files not named)", reason: "Fix" });
  });

  it("falls back to the reason only when nothing else is structured", () => {
    expect(codexApprovalText("item/other", { reason: "write files" }, "other")).toEqual({ summary: "write files" });
  });
});

describe("cardDetail", () => {
  it("labels the model's reason under the real target", () => {
    expect(cardDetail({ summary: "rm -rf x", reason: "cleanup" })).toBe(`rm -rf x\n\n${MODEL_REASON_LABEL}cleanup`);
  });
  it("prefers the full tool input when the engine sent one", () => {
    expect(cardDetail({ summary: "https://x.test", toolInput: '{"url":"https://x.test","method":"DELETE"}' })).toBe('{"url":"https://x.test","method":"DELETE"}');
  });
  it("leaves free-text cards (peer bots, browser extension) exactly as written", () => {
    expect(cardDetail({ summary: "Reply to Dana: see you at 3" })).toBe("Reply to Dana: see you at 3");
  });
});

describe("cardAuditSummary", () => {
  it("is the one-line summary, never the JSON subtitle", () => {
    expect(cardAuditSummary({ subtitle: '{"command":"ls"}', summary: "ls" })).toBe("ls");
    expect(cardAuditSummary({ subtitle: "Read notes" })).toBe("Read notes");
    expect(cardAuditSummary(undefined)).toBeUndefined();
  });
});

describe("approvalIsCut", () => {
  const long = `echo ${"a".repeat(4100)}; rm -rf ~`;
  it("counts a cut summary as cut when there is no tool input (ACP shell, pi bash)", () => {
    expect(approvalIsCut(undefined, approvalSummary(long))).toBe(true);
  });
  it("is false for a short summary or a summary that merely mentions the marker mid-text", () => {
    expect(approvalIsCut(undefined, "ls -la")).toBe(false);
    expect(approvalIsCut(undefined, "echo …[truncated, 5 characters more] and more")).toBe(false);
  });
  it("still follows a cut tool input", () => {
    expect(approvalIsCut(`{"a":"x…[9 bytes more]"}`, "ls")).toBe(true);
    expect(approvalIsCut('{"a":"x"}', approvalSummary(long))).toBe(false);
  });
});
