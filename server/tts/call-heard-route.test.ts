import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CallSpeechCoordinator } from "./call-coordinator.ts";
import { handleCallHeard } from "./call-heard-route.ts";

const valid = { callSessionId: "call", threadId: "thread", replyId: "reply", ended: 1, cut: false, cutIn: true };
async function request(body: unknown, principal: string | null = "owner") {
  const reportHeard = vi.fn(), writeHead = vi.fn(), end = vi.fn();
  await handleCallHeard({} as IncomingMessage, { writeHead, end } as unknown as ServerResponse, {
    readBody: async () => body, principal: () => principal,
    speech: { reportHeard } as unknown as CallSpeechCoordinator,
  });
  return { reportHeard, writeHead, end };
}
describe("call heard reports", () => {
  it("passes only counts and identity to the coordinator", async () => {
    const result = await request(valid);
    expect(result.reportHeard).toHaveBeenCalledWith("call", "owner", "thread", "reply", { ended: 1, cut: false, cutIn: true });
    expect(result.writeHead.mock.calls[0][0]).toBe(204);
    expect(result.end).toHaveBeenCalledWith();
  });
  it.each([null, [], {}, { ...valid, text: "forged" },
    ...["callSessionId", "threadId", "replyId"].flatMap(key => [undefined, 1, "", "bad id", "x".repeat(129)].map(value => ({ ...valid, [key]: value }))),
    ...[-1, 1001, 1.5, "1", null].map(ended => ({ ...valid, ended })),
    { ...valid, cut: 1 }, { ...valid, cutIn: "false" },
  ])("rejects malformed bodies: %j", async body => {
    const result = await request(body);
    expect(result.writeHead.mock.calls[0][0]).toBe(400);
    expect(result.reportHeard).not.toHaveBeenCalled();
  });
  it("hides unknown principals", async () => {
    const result = await request(valid, null);
    expect(result.writeHead.mock.calls[0][0]).toBe(404);
    expect(result.reportHeard).not.toHaveBeenCalled();
  });
});
