// No DOM or app data: the guarded apply and what "Apply to my open conversations" sends.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { applyPermissionPreviewOnce } from "./BotPermissionDefault";

const source = () => readFileSync(new URL("./BotPermissionDefault.tsx", import.meta.url), "utf8");

describe("bringing open conversations up to the saved level", () => {
  it("runs the apply operation only once while a request is pending", async () => {
    const applying = { current: false };
    let finish!: () => void;
    const operation = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const first = applyPermissionPreviewOnce(applying, operation);
    await applyPermissionPreviewOnce(applying, operation);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(applying.current).toBe(true);
    finish();
    await first;
    expect(applying.current).toBe(false);
  });

  it("releases the apply guard after a failure so a later review can retry", async () => {
    const applying = { current: false };
    await expect(applyPermissionPreviewOnce(applying, async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    expect(applying.current).toBe(false);
    const retry = vi.fn(async () => {});
    await applyPermissionPreviewOnce(applying, retry);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("compares saved levels and applies the new form: roster, the saved level, the preview's own revision", () => {
    const text = source();
    expect(text).toContain("flushBotPatches(botId).then(() => api(path");
    expect(text).toContain('body: JSON.stringify({ scope: "open", rosterId: preview.rosterId, targetLevel: preview.targetLevel, afterRev: preview.botRev })');
    expect(text).not.toContain("previewId: preview.previewId");
    expect(text).toContain("result.changed.length");
  });

  it("keeps Apply to my open conversations, asks for a legacy acknowledgement first, and answers [Review conversations]", () => {
    const text = source();
    expect(text).toContain("Apply to my open conversations");
    expect(text).toContain("if (!acknowledged) { onConfirmLevel(); return; }");
    expect(text).toContain("await applyPermissionPreviewOnce(applying, async () => {");
    expect(text).toContain("if (reviewAsk > 0) void reviewRef.current();");
    expect(text).toContain("Conversations already at a higher level keep it.");
    expect(text).toContain("Busy conversations can be reviewed again later.");
    expect(text).toContain("Rooms: Follows the bot default.");
  });

  it("the raise-then-offer line is gone: the confirm card asks before the raise", () => {
    const text = source();
    expect(text).not.toMatch(/PermissionOffer|permissionOffer/);
    expect(text).toContain("<LevelConfirmCard");
    const settings = readFileSync(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
    expect(settings).not.toContain("permissionRequest");
  });
});
