// @vitest-environment jsdom
// A7 (settings v10): the six removal outcomes, each with its own sentence; Check again reads the record and never repeats the removal.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/lib/i18n";
import { outcomeKey, phoneRemovalOutcome, type PhoneRemovalOutcome } from "@/lib/phone-removal-outcome";
import { RemovalPendingNote } from "./CompanionSection";
import type { CompanionRemovalStatus } from "./PhoneSetupFlow";

const rows: Array<[PhoneRemovalOutcome, CompanionRemovalStatus]> = [
  ["removed", { state: "removed", notifications: "confirmed", uncertain: false }],
  ["removed-no-notifications", { state: "removed", notifications: "nothing", uncertain: false }],
  ["waiting", { state: "pending", notifications: "harness-queued", uncertain: false }],
  ["gave-up", { state: "abandoned", notifications: "abandoned", uncertain: false }],
  ["uncertain", { state: "pending", notifications: "unknown", uncertain: true }],
  ["not-recorded", { state: "unknown", notifications: "unknown", uncertain: false }],
];
let root: Root, host: HTMLDivElement;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const draw = (status: CompanionRemovalStatus | null, onRetry = vi.fn(), onCheckAgain = vi.fn()) => {
  act(() => root.render(createElement(RemovalPendingNote, { name: "Phone", busy: false, onRetry, status, onCheckAgain })));
  return { onRetry, onCheckAgain };
};

describe("A7 six removal outcomes", () => {
  it.each(rows)("%s has its own sentence", (outcome, status) => {
    expect(phoneRemovalOutcome(status)).toBe(outcome);
    draw(status);
    // on a row that is still listed, a "removed" notifications step is not the whole removal
    const shown: PhoneRemovalOutcome = outcome === "removed" || outcome === "removed-no-notifications" ? "finishing" : outcome;
    expect(host.textContent).toContain(t(outcomeKey(shown)));
    if (shown === "finishing") expect(host.textContent).not.toContain(t(outcomeKey(outcome)));
    expect(new Set(rows.map(([o]) => t(outcomeKey(o)))).size).toBe(6);
  });
  it("a lost reply never reads as Removed, even if the recorded state says removed", () => {
    expect(phoneRemovalOutcome({ state: "removed", notifications: "confirmed", uncertain: true })).toBe("uncertain");
  });
  it("Check again is offered while the answer can change and reads the record without retrying; Try again stays on every row that is still listed", () => {
    for (const [outcome, status] of rows) {
      const { onRetry, onCheckAgain } = draw(status);
      const check = host.querySelector<HTMLButtonElement>(`button[aria-label^="${t("phone.removal.checkAgain")}"]`);
      const retry = host.querySelector<HTMLButtonElement>(`button[aria-label^="${t("phone.removal.retry")}"]`);
      expect(Boolean(retry), `${outcome}: Try again`).toBe(true);
      expect(Boolean(check), `${outcome}: Check again`).toBe(!["gave-up"].includes(outcome));
      if (check) { act(() => check.click()); expect(onCheckAgain).toHaveBeenCalledTimes(1); expect(onRetry).not.toHaveBeenCalled(); }
      act(() => retry!.click()); expect(onRetry).toHaveBeenCalledTimes(1);
    }
  });
});
