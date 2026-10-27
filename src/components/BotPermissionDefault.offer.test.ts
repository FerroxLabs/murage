// No DOM or app data: pure state/copy, server markup, and callback contracts.
import { readFileSync } from "node:fs";
import { Children, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  applyPermissionPreviewOnce,
  PermissionOffer,
  permissionOfferCopy as copyFromSummary,
  summarizePermissionPreview,
  permissionOfferReducer,
  type PermissionOfferState,
} from "./BotPermissionDefault";

type Preview = NonNullable<Parameters<typeof summarizePermissionPreview>[0]>;
const permissionOfferCopy = (state: PermissionOfferState, preview: Preview | null, acknowledged: boolean) =>
  copyFromSummary(state, summarizePermissionPreview(preview), acknowledged);
const preview = (count: number, targetLevel: Preview["targetLevel"] = "full", from: Preview["targetLevel"] = "ask"): Preview => ({
  previewId: `preview-${targetLevel}-${count}`,
  targetLevel,
  eligible: Array.from({ length: count }, (_, i) => ({ threadId: `chat-${i}`, from })),
  skipped: [{ threadId: "busy-chat", reason: "busy" }],
});
const initial: PermissionOfferState = { mode: "ask", pending: false };
const raised = permissionOfferReducer(initial, { type: "saved", mode: "full", requested: "full" });
const render = (copy: ReturnType<typeof permissionOfferCopy>, busy = false) =>
  renderToStaticMarkup(createElement(PermissionOffer, { copy, busy, onReview: () => {}, onDismiss: () => {} }));

type ButtonProps = { children?: ReactNode; onClick?: () => void; disabled?: boolean };
function buttons(node: ReactNode): ButtonProps[] {
  return Children.toArray(node).flatMap(child => {
    if (!isValidElement<ButtonProps>(child)) return [];
    return child.type === "button" ? [child.props] : buttons(child.props.children);
  });
}

describe("the inline offer after raising the default", () => {
  it.each([
    ["full", "full", "Full access"],
    ["unlimited", "no-limits", "No limits"],
  ] as const)("offers the eligible count for %s with singular and plural copy", (mode, target, label) => {
    const state = permissionOfferReducer(initial, { type: "saved", mode, requested: mode });
    for (const count of [1, 2, 12]) {
      const copy = permissionOfferCopy(state, preview(count, target), true);
      expect(copy).toEqual({
        message: `${count} open ${count === 1 ? "chat is" : "chats are"} still at Ask. Apply ${label} to ${count === 1 ? "it" : "them"} too?`,
        applyLabel: `Apply to ${count} ${count === 1 ? "chat" : "chats"}`,
      });
      const markup = render(copy);
      expect(markup).toContain(copy!.message);
      expect(markup).toContain(`>${copy!.applyLabel}</button>`);
      expect(markup).toContain(">Not now</button>");
      expect(markup).not.toMatch(/\u2014|\b(?:safe|unsafe|safety)\b/i);
    }
  });

  it("snapshots the visible markup with a polite announcement and native buttons", () => {
    expect(render(permissionOfferCopy(raised, preview(1), true))).toMatchInlineSnapshot(`"<div role=\"status\" aria-live=\"polite\" aria-atomic=\"true\"><div class=\"rounded-lg bg-inset p-3\"><p>1 open chat is still at Ask. Apply Full access to it too?</p><div class=\"mt-2 flex flex-wrap gap-2\"><button type=\"button\" class=\"rounded-lg bg-accent px-3 py-2 font-medium text-white hover:brightness-110\">Apply to 1 chat</button><button type=\"button\" class=\"rounded-lg px-3 py-2 text-ink-secondary hover:text-ink\">Not now</button></div></div></div>"`);
  });

  it("hides the offer for zero eligible chats", () => {
    const copy = permissionOfferCopy(raised, preview(0), true);
    expect(copy).toBeNull();
    expect(render(copy)).toBe('<div role="status" aria-live="polite" aria-atomic="true"></div>');
  });

  it("describes mixed current levels without claiming all chats are at Ask", () => {
    const state = permissionOfferReducer(raised, { type: "saved", mode: "unlimited", requested: "unlimited" });
    const mixed = preview(2, "no-limits");
    mixed.eligible[1].from = "full";
    expect(permissionOfferCopy(state, mixed, true)?.message).toBe("2 open chats are still at a lower approval level. Apply No limits to them too?");
  });

  it("waits for acknowledgment and a preview of the saved level", () => {
    expect(permissionOfferCopy(raised, null, true)).toBeNull();
    expect(permissionOfferCopy(raised, preview(3), false)).toBeNull();
    expect(permissionOfferCopy(raised, preview(3, "ask"), true)).toBeNull();
    expect(permissionOfferCopy(raised, preview(3), true)?.applyLabel).toBe("Apply to 3 chats");
  });

  it("does not offer on opening settings, lowering the level, or raising to Auto", () => {
    expect(permissionOfferCopy({ mode: "full", pending: false }, preview(2), true)).toBeNull();
    const unlimited = permissionOfferReducer(raised, { type: "saved", mode: "unlimited", requested: "unlimited" });
    const lowered = permissionOfferReducer(unlimited, { type: "saved", mode: "full", requested: "full" });
    expect(permissionOfferCopy(lowered, preview(2), true)).toBeNull();
    expect(permissionOfferReducer(initial, { type: "saved", mode: "auto", requested: "auto" }).pending).toBe(false);
  });

  it("does not arm on a failed downgrade's rollback, only a saved requested increase", () => {
    const full: PermissionOfferState = { mode: "full", pending: false };
    // Optimistic Ask clears the offer but does not replace the saved baseline.
    const optimisticAsk = permissionOfferReducer(full, { type: "dismiss" });
    const rolledBack = permissionOfferReducer(optimisticAsk, { type: "saved", mode: "full", requested: "ask" });
    expect(rolledBack).toEqual(full);
    expect(permissionOfferCopy(rolledBack, preview(2), true)).toBeNull();
    const savedAsk = permissionOfferReducer(full, { type: "saved", mode: "ask", requested: "ask" });
    expect(permissionOfferReducer(savedAsk, { type: "saved", mode: "full", requested: "full" }).pending).toBe(true);
    expect(permissionOfferReducer(savedAsk, { type: "saved", mode: "full" }).pending).toBe(false);
    const source = readFileSync(new URL("./BotPermissionDefault.tsx", import.meta.url), "utf8");
    expect(source).toContain('flushBotPatches(botId).then(() => api(path');
    expect(source).toContain('mode: saved.targetLevel === "no-limits" ? "unlimited" : saved.targetLevel');
    const settings = readFileSync(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
    expect(settings).toContain('permissionRequest.current = { botId: bot.id, mode: permissionModeOf({ ...bot, ...p }) }');
    expect(settings).toContain('requested={permissionRequest}');
  });

  it("keeps the preview and offer controls mounted across unrelated bot revisions", () => {
    // Node-only source contract: message-driven object replacements must not
    // invalidate the effect or key that owns the buttons and keyboard focus.
    const source = readFileSync(new URL("./BotPermissionDefault.tsx", import.meta.url), "utf8");
    expect(source).toContain('key={botId} botId={botId} requested={requested} mode={current}');
    expect(source).toContain('}, [path, botId, mode, flushBotPatches, requested]);');
    expect(source).not.toMatch(/revision[=:]|\[path, revision\]/);
    const settings = readFileSync(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
    expect(settings).toContain('const permissionRequest = useRef<');
    expect(source).toContain('copy={confirm ? null : offerCopy}');
  });

  it("summarizes source levels once per preview, including while confirmation hides the offer", () => {
    const data = preview(12);
    const scan = vi.spyOn(data.eligible, "every");
    const summary = summarizePermissionPreview(data);
    for (let render = 0; render < 5; render++) {
      expect(copyFromSummary(raised, summary, true)?.applyLabel).toBe("Apply to 12 chats");
    }
    expect(scan).toHaveBeenCalledTimes(1);
    const source = readFileSync(new URL("./BotPermissionDefault.tsx", import.meta.url), "utf8");
    expect(source).toContain('useMemo(() => summarizePermissionPreview(preview), [preview])');
    expect(source).toContain('permissionOfferCopy({ ...offer, mode }, summary, acknowledged)');
    const next = preview(1, "full", "auto");
    expect(copyFromSummary(raised, summarizePermissionPreview(next), true)?.message).toContain("at a lower approval level");
  });

  it("Apply invokes review once; Not now dismisses across same-level refreshes", () => {
    let state = raised;
    const onReview = vi.fn();
    const onDismiss = vi.fn(() => { state = permissionOfferReducer(state, { type: "dismiss" }); });
    const controls = buttons(PermissionOffer({ copy: permissionOfferCopy(state, preview(12), true), busy: false, onReview, onDismiss }));
    expect(controls).toHaveLength(2);
    expect(controls.map(control => control.children)).toEqual(["Apply to 12 chats", "Not now"]);
    expect(controls.every(control => control.disabled === false)).toBe(true);
    controls[0].onClick!();
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    controls[1].onClick!();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onReview).toHaveBeenCalledTimes(1);
    state = permissionOfferReducer(state, { type: "saved", mode: "full", requested: "full" });
    expect(permissionOfferCopy(state, preview(12), true)).toBeNull();
  });

  it("disables both offer controls while busy", () => {
    const markup = render(permissionOfferCopy(raised, preview(2), true), true);
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });

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

  it("wires the offer into the existing fresh-review and guarded apply path", () => {
    // Source contracts complement the pure callback checks; effects need a DOM.
    const source = readFileSync(new URL("./BotPermissionDefault.tsx", import.meta.url), "utf8");
    expect(source).toContain('key={botId}');
    expect(source).toContain('useReducer(permissionOfferReducer, { mode, pending: false })');
    expect(source).toContain('onReview={() => void review()} onDismiss={() => dispatchOffer({ type: "dismiss" })}');
    expect(source).toContain('copy={confirm ? null : offerCopy}');
    expect(source).toContain('if (!acknowledged) { onConfirmLevel(); return; }');
    expect(source).toContain('setPreview(await api(path, { method: "POST", body: JSON.stringify({ scope: "open" }) }) as BulkPreview); setConfirm(true);');
    expect(source).toContain('await applyPermissionPreviewOnce(applying, async () => {');
    expect(source).toContain('body: JSON.stringify({ scope: "open", previewId: preview.previewId })');
    expect(source).toContain('onClick={() => void apply()}');
    expect(source).toContain('setPreview(null); setConfirm(false); dispatchOffer({ type: "dismiss" })');
    expect(source).toContain("Conversations already at a higher level keep it.");
    expect(source).toContain("Busy conversations can be reviewed again later.");
    expect(source).toContain("Rooms: Follows the bot default.");
  });
});
