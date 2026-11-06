// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// APPROVALS-SIMPLE-1018 (designs/APPROVALS-SIMPLE-1018.md sections 1, 3 and 3b, client half). Sean 11-06: "Not exactly
// approval if I still have to approve every little thing", "Don't make me think". Every approval row says what the bot wants in
// words, with Murage's own kind on the grey line, and no command on the first screen. Approve all names the count it
// will answer (the rows on screen the server stamped ok), never "Approve 0", and anything it has open closes when the
// list changes (Sean's repro: open, Refresh, the list goes to 0, the old sheet stayed). Fixture strings are inert data.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { OptionCardData } from "@/state/store";
import type { InboxItem } from "../../shared/inbox";

Object.assign(globalThis, { window: (globalThis as { window?: unknown }).window ?? {} });
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: () => {}, initAnalytics: () => {}, track: () => {} }));
const row = await import("./approval-row");
const lib = await import("./approve-all");
const { requestSummary, InboxQuickAnswer } = await import("../components/InboxRequest");
const view = await import("../components/ApproveAll");
const { withoutAnswered } = await import("./today-needs");
const en = JSON.parse(readFileSync(fileURLToPath(new URL("../locales/en.json", import.meta.url)), "utf8")) as Record<string, string>;
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// Sean's two real rows (11-06 screenshot). Petra's Bash call carried a description; Moss's did not.
const PETRA_COMMAND = [
  "cat >> ~/.helper/ops/trustpilot-log.md <<'EOF'",
  "| 2026-11-06 06:35 ICT | 4.2 | 36 | no new reviews. Run executed by Petra (Kessler delegation, 6 Nov). ... NOTHING POSTED, NOTHING HELD. |",
  "EOF",
  "python3 -I ~/.helper/ops/trustpilot-state-stamp.py --ts 2026-11-06T06:35+07:00 --note \"No new reviews. ...\" --method \"WebFetch public profile recency page 1. Business app not opened.\" --score 4.2 --count 36; tail -1 ~/.helper/ops/trustpilot-log.md | cut -c1-60",
].join("\n");
const petra: OptionCardData = { title: "Approval needed", subtitle: PETRA_COMMAND, options: ["Allow", "Deny"], requestId: "req-petra", tool: "Bash", wants: "Append today's Trustpilot check to the ops log" };
const moss: OptionCardData = { title: "Approval needed", subtitle: "python3 -I /tmp/moss-count-20261106.py", options: ["Allow", "Deny"], requestId: "req-moss", tool: "Bash" };
const item = (id: string, bulk: string, extra: Partial<InboxItem> = {}) => ({ id, kind: "request" as const, bulk, toolKind: "command" as const, link: { threadId: `t-${id}`, messageId: `m-${id}` }, ...extra });

describe("section 1: the row says what the bot wants, in words", () => {
  it("Petra: the bot's own words, first letter lowered, and none of the command", () => {
    const line = row.rowLine(petra, "Petra", requestSummary);
    expect(line).toBe("Petra wants to append today's Trustpilot check to the ops log");
    for (const bit of ["cat >>", "EOF", "python3", "trustpilot-state-stamp", "~/.helper"]) expect(line).not.toContain(bit);
  });
  it("Moss: no description, so the plain kind, never the command", () => {
    expect(row.rowLine(moss, "Moss", requestSummary)).toBe("Moss wants to run a command");
    expect(row.rowLine({ ...moss, tool: "Edit" }, "Moss", requestSummary)).toBe("Moss wants to edit files");
    expect(row.rowLine({ ...moss, tool: "mcp__gmail__send" }, "Moss", requestSummary)).toBe("Moss wants to use a connected app");
    expect(row.rowLine({ ...moss, tool: "WebFetch" }, undefined, requestSummary)).toBe("A bot wants to take a step");
  });
  it("an acronym keeps its capitals; a several-line or long `wants` stays one line", () => {
    expect(row.lowerFirst("URL check for the site")).toBe("URL check for the site");
    expect(row.lowerFirst("Build the site")).toBe("build the site");
    expect(row.wantsOf({ ...petra, wants: "Build the site.\nThen deploy it" })).toBe("Build the site");
    expect(row.wantsOf({ ...petra, wants: "a".repeat(300) }).length).toBe(140);
  });
  it("a question's row is still the bot's own question", () => {
    const q: OptionCardData = { title: "Q", subtitle: "Send it?", options: ["Yes", "No"], requestId: "q", questions: [{ id: "q1", question: "Send the Dana email now?", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false, allowOther: true }] };
    expect(row.rowLine(q, "Sable", requestSummary)).toBe("Send the Dana email now?");
  });
  it("Astra r2 High: a question answered beside Yes / No shows ALL of it, every line, never cut", () => {
    const long = `Apply this change?\nThis deletes all archived records. ${"x".repeat(200)}`;
    const q: OptionCardData = { title: "Q", subtitle: "", options: ["Yes", "No"], requestId: "q", questions: [{ id: "q1", question: long, options: [{ label: "Yes" }, { label: "No" }], multiSelect: false, allowOther: false }] };
    const line = row.rowLine(q, "Sable", requestSummary);
    expect(line).toContain("Apply this change? This deletes all archived records.");
    expect(line.endsWith("x".repeat(200))).toBe(true);
    expect(line).not.toContain("…");
  });
  it("the grey line is Murage's kind, the bot and the time; a row Approve all leaves out says why in a few words", () => {
    expect(row.rowMeta({ kind: "command", bot: "Petra", time: "06:39", bulk: "ok", note: true })).toBe("Runs a command · Petra · waiting since 06:39");
    expect(row.rowMeta({ kind: "command", bot: "Moss", time: "06:41", bulk: "sensitive", note: true })).toBe("Runs a command · Moss · waiting since 06:41 · one at a time: reads keys or passwords");
    expect(row.rowMeta({ kind: "edit", time: "06:41", bulk: "delete", note: false })).toBe("Edits files · waiting since 06:41");
    expect(row.rowMeta({ kind: "command", bot: "Moss", time: "06:41", bulk: "not-open", note: true })).toBe("Runs a command · Moss · waiting since 06:41");
    expect(row.rowKind({ toolKind: "app" }, moss)).toBe("app");
    expect(row.rowKind(undefined, moss)).toBe("command");
  });
  it("the same line on Needs you, Approvals and Today, and Today's line wraps beside its answer", () => {
    expect(read("../components/Inbox.tsx")).toContain("rowLine(card, botNameFromSource(item.sourceLabel), requestSummary)");
    expect(read("../components/today/TodayQuickAnswer.tsx")).toContain("rowLine(found, request.botName, requestSummary)");
    const block = read("../components/today/NeedsBlock.tsx");
    expect(block).toContain('answer ? "break-words" : "truncate"');
    expect(read("../components/needs/NeedsYouPage.tsx")).toContain("rowMeta({ kind: item.toolKind");
  });
  it("Petra and Moss each keep their own one-click Approve and Deny on the row", () => {
    for (const card of [petra, moss]) {
      const html = renderToStaticMarkup(createElement(InboxQuickAnswer, { threadId: "t1", card: { ...card, lowRisk: true }, labelledBy: "l", onSettled: () => {} }));
      expect(html).toContain("Approve");
      expect(html).toContain(">Deny<");
      expect(html).not.toContain("python3");
    }
  });
});

describe("section 3: Approve all names the count it will answer", () => {
  it("n is the rows on screen stamped ok, never the page's approval count", () => {
    const shown = [item("petra", "ok"), item("moss", "ok"), item("keys", "sensitive"), { ...item("q", "not-approval"), kind: "request" as const }];
    expect(lib.approveAllHint("decisions", shown)).toBe(2);
    expect(lib.approveAllHint("approvals", [item("petra", "ok"), item("keys", "sensitive")])).toBe(1);
    expect(lib.approveAllHint("approvals", [])).toBe(0);
    for (const other of ["questions", "connections", "routines", "results", "all"]) expect(lib.approveAllHint(other, shown)).toBeNull();
    expect(row.bulkReadyRows(shown).map((entry) => entry.id)).toEqual(["petra", "moss"]);
  });
  it("the label is the count; under 2 there is no button at all, so never 'Approve 0'", () => {
    expect(en["approveAll.button"]).toBe("Approve all {n}");
    const component = read("../components/ApproveAll.tsx");
    expect(component).toContain('if (n < 2 && (step.at === "idle" || step.at === "caution")) return null;');
    expect(component).toContain('t("approveAll.button", { n })');
    expect(component).not.toContain("approveAll.sheet.stays");
    expect(read("../components/Inbox.tsx")).toContain("<ApproveAllButton ready={approveAllReady} listed={approveAllListed} refreshes={refreshes}");
  });
  it("a press binds to the rows on screen: the ones the preview lists, else 'changed', else 'none'", () => {
    const card = (id: string) => ({ threadId: `t-${id}`, requestId: `r-${id}`, messageId: `m-${id}`, kindLine: "command" as const, digest: "", card: {} });
    const key = (id: string) => row.rowKey({ threadId: `t-${id}`, messageId: `m-${id}` });
    const preview = { batchId: "aab-1", eligible: [card("petra"), card("moss"), card("offscreen")], excluded: [], more: 0 };
    const bound = lib.boundToScreen(preview, [key("petra"), key("moss")]);
    expect(bound.at === "cards" && bound.cards.map((c) => c.requestId)).toEqual(["r-petra", "r-moss"]);
    expect(lib.boundToScreen(preview, [key("petra"), key("gone")])).toEqual({ at: "changed" });
    expect(lib.boundToScreen({ ...preview, eligible: [], batchId: null }, [key("petra")])).toEqual({ at: "none" });
    expect(en["approveAll.none"]).toBe("Nothing left to approve.");
    expect(en["approveAll.changed"]).toBe("The list changed. Press Approve all again.");
  });
  it("the phone sheet lists the bot's words and the kind, never a command, and signs the same card objects", () => {
    const eligible = [
      { threadId: "t-petra", requestId: "r-petra", messageId: "m-petra", botId: "petra", wants: "Append today's Trustpilot check to the ops log", kindLine: "command" as const, digest: "d1", card: { tool: "Bash", subtitle: PETRA_COMMAND } },
      { threadId: "t-moss", requestId: "r-moss", messageId: "m-moss", botId: "moss", kindLine: "command" as const, digest: "d2", card: { tool: "Bash", subtitle: "python3 -I /tmp/moss-count-20261106.py" } },
    ];
    const names: Record<string, string> = { petra: "Petra", moss: "Moss" };
    const html = renderToStaticMarkup(createElement(view.ApproveAllSheet, { preview: { batchId: "aab-1", eligible, excluded: [], more: 0 }, botName: (id?: string) => names[id ?? ""] ?? "A bot", botOf: () => undefined, busy: false, onCancel: () => {}, onApprove: () => {} }));
    expect(html).toContain("Petra wants to append today&#x27;s Trustpilot check to the ops log");
    expect(html).toContain("Moss wants to run a command");
    expect(html).toContain("Runs a command");
    for (const bit of ["python3", "EOF", "trustpilot-state-stamp", "Bash"]) expect(html).not.toContain(bit);
    expect([...html.matchAll(/data-request-id="([^"]+)" data-digest="([^"]+)"/g)].map((m) => [m[1], m[2]])).toEqual([["r-petra", "d1"], ["r-moss", "d2"]]);
  });
});

describe("section 3b: a list change closes what Approve all had open (Sean's Refresh repro)", () => {
  it("the token is the set of displayed rows: a quiet poll keeps it, a change moves it", () => {
    expect(lib.listToken(["b", "a"])).toBe(lib.listToken(["a", "b", "a"]));
    expect(lib.listToken(["a", "b"])).not.toBe(lib.listToken(["a"]));
    expect(lib.listToken([])).not.toBe(lib.listToken(["a"]));
  });
  it("open, Refresh, the list goes to 0: the caution, sheet and notes close; an apply in flight keeps its lock", () => {
    for (const at of ["caution", "sheet", "note"]) {
      expect(view.stepAfterListChange({ at }, [], true)).toBe("close");
      expect(view.stepAfterListChange({ at }, [], false)).toBe("close");
    }
    expect(view.stepAfterListChange({ at: "applying" }, [], true)).toBe("keep");
    // Astra r2 High: a preview still loading is not an apply; a Refresh or a list change drops it
    expect(view.stepAfterListChange({ at: "previewing" }, [], true)).toBe("close");
    expect(view.stepAfterListChange({ at: "previewing" }, ["a"], false)).toBe("close");
    expect(view.stepAfterListChange({ at: "idle" }, [], true)).toBe("keep");
  });
  it("a result line stays while the list only loses the rows it was pressed over; a new row or a Refresh clears it", () => {
    expect(view.stepAfterListChange({ at: "result", pressed: ["a", "b", "c"] }, ["c"], false)).toBe("keep");
    expect(view.stepAfterListChange({ at: "result", pressed: ["a", "b"] }, ["a", "new"], false)).toBe("close");
    expect(view.stepAfterListChange({ at: "result", pressed: ["a", "b"] }, [], true)).toBe("close");
  });
  it("a preview that lands after the list moved is dropped; a sign in flight is not unlocked by it", () => {
    const gate = lib.previewGate();
    const ticket = gate.begin()!;
    gate.retire();
    expect(gate.accepts(ticket)).toBe(false);
    const next = gate.begin()!;
    expect(gate.accepts(next)).toBe(true);
    expect(gate.sign()).toBe(true);
    gate.retire();
    expect(gate.signing).toBe(true);
    gate.done();
  });
  it("the button re-reads its surface on Refresh and on a new list, and checks the list before every post and the signed retry", () => {
    const component = read("../components/ApproveAll.tsx");
    expect(component).toContain("useApproveAllSurface(`${refreshes}|${token}`)");
    // relay 3 (Opus r2 High): the check is against the press's own snapshot (mounted, generation and ok rows)
    expect(component).toContain("if (!stillPressed(press, live.current)) return Promise.reject(");
    expect(component).toContain("if (!gate.accepts(ticket) || !live.current.mounted) return;");
    expect(component).toContain("if (!gate.signing) gate.retire();");
    // Astra r2 High: leaving the tab retires a loading preview, and the result line checks the list it lands on
    expect(component).toMatch(/return \(\) => \{\s*live\.current\.mounted = false;\s*if \(!gate\.signing\) gate\.retire\(\);/);
    expect(component).toContain("resultSurvives(pressed, live.current.listed)");
    expect(component).toContain('setStep({ at: "previewing", n: press.ready.length });');
    // Refresh also re-reads the signed-out engine rows (FUNCTION-SWEEP-1018)
    expect(read("../components/Inbox.tsx")).toContain("setRevision(current => current + 1); setRefreshes(current => current + 1); refreshSetup();");
  });
});

describe("Today's count comes from one snapshot (needs-inline Astra r2 Medium)", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  it("an answered row the read still lists comes off that read's own count, once", () => {
    expect(withoutAnswered(rows, 3, new Set(["a"]), 3)).toEqual({ rows: [rows[1], rows[2]], count: 2 });
    // the badge already counted the answer but the rows are from before: the read's own count, never twice
    expect(withoutAnswered(rows, 2, new Set(["a"]), 3)).toEqual({ rows: [rows[1], rows[2]], count: 2 });
  });
  it("the server swaps A for B at the same count: the badge count is not taken off again", () => {
    // the read no longer lists A (answered) and lists B instead: nothing is subtracted
    expect(withoutAnswered([{ id: "b" }, { id: "c" }, { id: "d" }], 3, new Set(["a"]), 3)).toEqual({ rows: [{ id: "b" }, { id: "c" }, { id: "d" }], count: 3 });
  });
  it("nothing answered, or no count yet: the badge is the truth", () => {
    expect(withoutAnswered(rows, 3, new Set(), 3)).toEqual({ rows, count: 3 });
    expect(withoutAnswered(rows, undefined, new Set(["a"]), 3).count).toBeUndefined();
    expect(withoutAnswered(rows, 3, new Set(["a"])).count).toBe(3);
  });
});

describe("copy (section 6)", () => {
  it("every new string is in all 8 packs, plain, no em dash, never safe or free", () => {
    const keys = ["ux.l2b.door.wants", "ux.l2b.door.metaKind", "ux.l2b.door.metaKindNoBot", "ux.l2b.door.oneAtATime", "ux.l2b.door.details", "ux.l2b.door.hideDetails", "projects.inbox.deny",
      "approveAll.busy", "approveAll.none", "approveAll.changed", "approveAll.caution.body", "approveAll.caution.gotIt", "approveAll.reason.sensitive", "approveAll.button",
      ...["command", "edit", "app", "other"].flatMap((kind) => [`ux.l2b.door.kind.${kind}`, `ux.l2b.door.wantsKind.${kind}`])];
    for (const code of ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"]) {
      const pack = JSON.parse(readFileSync(fileURLToPath(new URL(`../locales/${code}.json`, import.meta.url)), "utf8")) as Record<string, string>;
      for (const key of keys) {
        expect(pack[key], `${code}:${key}`).toBeTypeOf("string");
        expect(pack[key]).not.toMatch(/—|\bsafe\b|\bfree\b/i);
        for (const slot of en[key]!.match(/\{\w+\}/g) ?? []) expect(pack[key], `${code}:${key} ${slot}`).toContain(slot);
      }
    }
    expect(en["ux.l2b.door.kind.command"]).toBe("Runs a command");
    expect(en["projects.inbox.deny"]).toBe("Deny");
  });
});
