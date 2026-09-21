import { describe, expect, it, vi } from "vitest";
import { AGENT_RESULT_CAP_CHARS, boundedAgentResult } from "./agents-result.ts";
import { TOOL_RESULT_MAX_CHARS, TOOL_RESULT_PREVIEW_CHARS } from "../tool-results.ts";

const SAVED_ID = "r-00000000-0000-4000-8000-000000000000";
type Save = (text: string, truncated: boolean) => Promise<unknown>;
const ok = () => vi.fn<Save>(async () => ({ id: SAVED_ID, length: 10, truncated: false }));

describe("boundedAgentResult", () => {
  it("returns a result at the cap completely unchanged and saves nothing", async () => {
    // This is an OVERFLOW limiter, not a redaction boundary: a result inside
    // the cap reaches the engine byte-for-byte, credentials and all.
    const save = ok();
    const text = `${"a".repeat(AGENT_RESULT_CAP_CHARS - 40)}sk-ant-abcdefghijklmnopqrstuvwxyz`;
    expect(text.length).toBeLessThanOrEqual(AGENT_RESULT_CAP_CHARS);
    expect(await boundedAgentResult(text, save)).toBe(text);
    expect(save).not.toHaveBeenCalled();
  });

  it("caps one character past the limit and hands back a resume id", async () => {
    const save = ok();
    const text = "b".repeat(AGENT_RESULT_CAP_CHARS + 1);
    const out = await boundedAgentResult(text, save);
    expect(save).toHaveBeenCalledOnce();
    expect(out.length).toBeLessThan(text.length);
    expect(out.startsWith("b".repeat(TOOL_RESULT_PREVIEW_CHARS))).toBe(true);
    expect(out).toContain(`tool_result_read with id "${SAVED_ID}"`);
    expect(out).toContain(`offset ${TOOL_RESULT_PREVIEW_CHARS}`);
  });

  it("parks at most the retention limit and says the tail was dropped", async () => {
    const save = ok();
    const out = await boundedAgentResult("c".repeat(TOOL_RESULT_MAX_CHARS + 5_000), save);
    expect(save.mock.calls[0]![0].length).toBe(TOOL_RESULT_MAX_CHARS);
    expect(save.mock.calls[0]![1]).toBe(true);
    expect(out).toContain("the remaining tail was omitted");
  });

  it("masks a credential in the copy it parks for later reading", async () => {
    const save = ok();
    const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz";
    await boundedAgentResult(`${secret}${"d".repeat(AGENT_RESULT_CAP_CHARS)}`, save);
    expect(save.mock.calls[0]![0]).not.toContain(secret);
  });

  it("still delivers the work when the save fails, and never retries the action", async () => {
    const save = vi.fn<Save>(async () => { throw new Error("harness refused"); });
    const out = await boundedAgentResult("e".repeat(AGENT_RESULT_CAP_CHARS + 1), save);
    expect(save).toHaveBeenCalledOnce();
    expect(out).toContain("could not be saved");
    expect(out).toContain("The original operation was not retried");
    expect(out).not.toContain("tool_result_read");
  });

  it("refuses a save response whose id is not a saved-result id", async () => {
    const out = await boundedAgentResult("f".repeat(AGENT_RESULT_CAP_CHARS + 1), async () => ({ id: "../../etc/passwd" }));
    expect(out).toContain("could not be saved");
    expect(out).not.toContain("etc/passwd");
  });
});
