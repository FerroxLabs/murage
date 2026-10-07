import { describe, expect, it } from "vitest";
import { currentApprovalNotification } from "./approval-notification-state.ts";

describe("currentApprovalNotification", () => {
  const payload = { botId: "b", threadId: "t", requestId: "r", messageId: "m", title: "", body: "" };
  const bot = { id: "b", name: "Lena", threadId: "t" };
  const message = (card: Record<string, unknown>) => [{ id: "m", kind: "options", role: "bot", card: { requestId: "r", title: "Approval needed", ...card } }];
  it("lock-screen text never contains the tool input: pushBody wins over subtitle", () => {
    const out = currentApprovalNotification(payload, bot, message({ subtitle: '{"command":"curl -u bob:pw x"}', pushBody: "curl x" }), undefined);
    expect(out?.body).toBe("curl x");
    expect(out?.body).not.toContain("pw");
  });
  it("falls back to the subtitle for cards without a pushBody", () => {
    expect(currentApprovalNotification(payload, bot, message({ subtitle: "Read notes" }), undefined)?.body).toBe("Read notes");
  });
});
