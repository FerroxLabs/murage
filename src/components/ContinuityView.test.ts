// Continuity settings block (PIP P1): rendered in node through the pure view,
// the request shapes and sentences through src/lib/continuity.ts, and the wiring
// as source contracts (SettingsPanel reads `window` at import).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ContinuityView, type ContinuityViewProps } from "./ContinuityView";
import {
  CONTINUITY_CHANGED_SENTENCE, CONTINUITY_ERRORS, CONTINUITY_HEADLINE, CONTINUITY_SENTENCE, SLUG_PATTERN, continuityDeleteBody, continuityErrorSentence,
  continuityPatchBody, continuityWriteBody, continuityOptionsPatchBody, proposalsReadBody, proposalConfirmBody, proposalDismissBody, keepBody, reflectStatusBody, reflectRetryBody, refusalLine, proposalsChip, PIP_NEW_SENTENCES, WRONG_TEMPLATE_TEXT, type ProposalView, type DisputeView, type ReflectionStatus, coverageLine, draftIsStale, freshKey, loadContinuity, rebaseDraft, managedInContinuity, slugFromText, wroteLine, type ContinuityView as Data,
} from "@/lib/continuity";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
const read2 = read;
const NOW = Date.UTC(2026, 9, 5, 12);
const data: Data = {
  limits: { perKind: 24, bytes: 4096, briefBytes: 768 },
  coverage: { brought: 5, total: 9 },
  records: [
    { id: "r1", version: 2, kind: "relation", key: "owner", text: "Short answers, no preamble.", editedAt: NOW - 3 * 3_600_000 },
    { id: "r2", version: 1, kind: "commitment", key: "check-in-fridays", text: "Check in every Friday.", editedAt: NOW - 86_400_000 },
    { id: "r3", version: 1, kind: "self-trait", key: "careful-with-money", text: "Careful with money.", editedAt: NOW },
  ],
};
const view = (over: Partial<ContinuityViewProps>) => renderToStaticMarkup(createElement(ContinuityView, {
  on: false, memoryActive: true, data, now: NOW, onToggle: vi.fn(), onOpenMemory: vi.fn(), onSave: vi.fn(), onAdd: vi.fn(), onDelete: vi.fn(), ...over,
}));

describe("the Continuity block", () => {
  it("off: shows the toggle and sentence, hides the editor", () => {
    const html = view({ on: false });
    expect(html).toContain(CONTINUITY_HEADLINE);
    expect(html).toContain(CONTINUITY_SENTENCE);
    expect(html).toContain('aria-checked="false"');
    for (const hidden of ["How we work together", "Commitments", "About this bot", "Brought 5 of 9"]) expect(html).not.toContain(hidden);
  });
  it("on: shows the editor, rows with who wrote them, and the coverage line", () => {
    const html = view({ on: true });
    for (const shown of ["How we work together", "Commitments", "About this bot", "Check in every Friday.", "Careful with money.", "Brought 5 of 9 into the last conversation"]) expect(html).toContain(shown);
    expect(html).toContain("You wrote this, edited 3 hr ago");
    expect(html).toContain("of 768 bytes");
    expect(html).toContain('aria-checked="true"');
  });
  it("hides the coverage line when there is none", () => {
    expect(view({ on: true, data: { ...data, coverage: null } })).not.toContain("Brought");
  });
  it("says memory is needed when it is not active, and the toggle stays usable", () => {
    const html = view({ on: false, memoryActive: false });
    expect(html).toContain("Continuity needs memory turned on");
    expect(html).toContain("Open memory settings");
    const tag = html.match(/<button[^>]*role="switch"[^>]*>/)?.[0] ?? "";
    expect(tag).not.toBe("");
    expect(tag).not.toMatch(/\sdisabled(=|\s|>)/);
  });
  it("delete is confirmed in the page, never with a browser dialog", () => {
    const source = read("./ContinuityView.tsx") + read("./ContinuityBlock.tsx");
    expect(source).toContain("Yes, remove");
    expect(source).not.toMatch(/window\.(confirm|alert)|\bconfirm\(|\balert\(/);
  });
  it("is mounted in the Memory section on the desktop and toggles through the bot PATCH", () => {
    expect(read("./SettingsPanel.tsx")).toMatch(/desktop === true && <ContinuityBlock/);
    expect(read("./ContinuityBlock.tsx")).toContain('patch: { continuity: next }');
    expect(read("../state/bot-patch-queue.ts")).toContain('"continuity"');
    expect(read("../state/store.tsx")).toContain("continuity?: boolean");
  });
});

describe("PIP P1 re-verify fixes", () => {
  it("D: loading finishes after a StrictMode mount, cleanup and re-mount", async () => {
    const view = { records: [data.records[0]], limits: data.limits, coverage: null };
    let release: Array<() => void> = [];
    const read = () => new Promise<typeof view>((resolve) => { release.push(() => resolve(view)); });
    const state = { loading: false, data: null as unknown, error: "" };
    const apply = { start: () => { state.loading = true; }, data: (next: unknown) => { state.data = next; }, error: (sentence: string) => { state.error = sentence; }, end: () => { state.loading = false; } };
    let cancelled1 = false;
    const first = loadContinuity(read, () => !cancelled1, apply);
    cancelled1 = true; // cleanup of the first effect run
    let cancelled2 = false;
    const second = loadContinuity(read, () => !cancelled2, apply);
    release.forEach((fn) => fn());
    await Promise.all([first, second]);
    expect(state.data).toEqual(view);
    expect(state.loading).toBe(false);
    expect(state.error).toBe("");
    const source = read2("./ContinuityBlock.tsx");
    expect(source).toContain("mounted.current = true");
    expect(source).toContain("let cancelled = false");
  });
  it("D: a cancelled run applies nothing", async () => {
    const seen: string[] = [];
    await loadContinuity(async () => ({ records: [] }), () => false, { start: () => seen.push("start"), data: () => seen.push("data"), error: () => seen.push("error"), end: () => seen.push("end") });
    expect(seen).toEqual(["start"]);
  });
  it("E: How we work together has a versioned in-page delete, the brief does not", () => {
    const html = view({ on: true });
    expect(html.match(/>Delete</g)?.length).toBe(3); // relation + one commitment + one trait
    const source = read2("./ContinuityView.tsx");
    expect(source).toContain("canDelete onSave");
    expect(source).toContain("Yes, remove");
    expect(source).toContain("Keep it");
    expect(read2("./ContinuityBlock.tsx")).toContain("expectedVersion: record.version");
  });
  it("F: a draft keeps its base version and a moved record is flagged, never overwritten", () => {
    const draft = { text: "mine", base: 2 };
    expect(draftIsStale(draft, { version: 2 })).toBe(false);
    expect(draftIsStale(draft, { version: 3 })).toBe(true);
    expect(draftIsStale(draft, null)).toBe(true);
    expect(draftIsStale({ text: "new", base: 0 }, null)).toBe(false);
    expect(rebaseDraft(draft, { version: 3 })).toEqual({ text: "mine", base: 3 });
    // a re-created relation restarts at version 1 under a new id: same version, still stale
    const based = { text: "mine", base: 1, baseId: "gen0" };
    expect(draftIsStale(based, { version: 1, id: "gen0" })).toBe(false);
    expect(draftIsStale(based, { version: 1, id: "gen1" })).toBe(true);
    expect(rebaseDraft(based, { version: 1, id: "gen1" })).toEqual({ text: "mine", base: 1, baseId: "gen1" });
    expect(continuityWriteBody({ botId: "b", kind: "relation", key: "owner", expectedVersion: 1, expectedId: "gen0", text: "t" })).toMatchObject({ expectedId: "gen0", expectedVersion: 1 });
    expect(continuityDeleteBody({ botId: "b", kind: "relation", key: "owner", expectedVersion: 1, expectedId: "gen0" })).toMatchObject({ expectedId: "gen0" });
    const source = read2("./ContinuityView.tsx");
    expect(source).toContain("onSave(kind, keyName, draft.base,");
    expect(source).toContain("onSave(kind, row.key, editing.base,");
    expect(source).toContain("CONTINUITY_CHANGED_SENTENCE");
    expect(source).toContain("Keep editing");
    expect(source).toContain("Discard my draft");
    expect(source).toMatch(/disabled=\{busy \|\| stale/);
    expect(CONTINUITY_CHANGED_SENTENCE).toBe("This changed in another window.");
  });
  it("G: drafts clear only after the mutation succeeds", async () => {
    const source = read2("./ContinuityView.tsx");
    expect(source).toMatch(/\.then\(\(ok\) => \{ if \(ok\) setDraft\(null\)/);
    expect(source).toMatch(/\.then\(\(ok\) => \{ if \(ok\) setEditing\(null\)/);
    expect(source).toMatch(/\.then\(\(ok\) => \{ if \(ok\) setAdding\(""\)/);
    expect(source).not.toMatch(/onSave\([^)]*\); setDraft\(null\)/);
    const block = read2("./ContinuityBlock.tsx");
    expect(block).toContain("ok = true");
    expect(block).toContain("return ok");
    expect(block).not.toContain("void save(");
    expect(continuityErrorSentence(new Error("MEMORY_VERSION_CONFLICT"))).toBe(CONTINUITY_ERRORS.MEMORY_VERSION_CONFLICT);
  });
  it("H: managed rows hide pin, review as skill, correction and share", () => {
    const review = read2("./MemoryReview.tsx");
    expect(review).toContain('!managedInContinuity(record.kind) && active && <button className={memoryButtonClass} onClick={() => void onAction({ action: "pin"');
    expect(review).toMatch(/!managedInContinuity\(record\.kind\) && active && <>\s*<form[\s\S]*?Bot to review this skill/);
    expect(review.indexOf("Managed in Continuity")).toBeGreaterThan(review.indexOf("Share memory"));
  });
});

describe("continuity helpers", () => {
  it("makes valid slugs from the first words, and never an empty one", () => {
    expect(slugFromText("Check in every Friday, please! And then more words after")).toBe("check-in-every-friday-please-and");
    expect(slugFromText("???")).toBe("note");
    expect(slugFromText("x".repeat(200))).toMatch(SLUG_PATTERN);
    expect(slugFromText("Ünïcode café")).toMatch(SLUG_PATTERN);
  });
  it("de-duplicates against active and retired keys", () => {
    expect(freshKey("Check in", [])).toBe("check-in");
    expect(freshKey("Check in", ["check-in"])).toBe("check-in-2");
    expect(freshKey("Check in", ["check-in", "check-in-2"])).toBe("check-in-3");
    const long = "a".repeat(60);
    expect(freshKey(long, [slugFromText(long)])).toMatch(SLUG_PATTERN);
  });
  it("shapes the requests the server expects", () => {
    expect(continuityWriteBody({ botId: "b", kind: "commitment", key: "k", expectedVersion: 0, text: "t" })).toEqual({ action: "identity-write", botId: "b", kind: "commitment", key: "k", expectedVersion: 0, text: "t", basis: "owner-fact", audience: "owner-private" });
    expect(continuityDeleteBody({ botId: "b", kind: "self-trait", key: "k", expectedVersion: 3 })).toEqual({ action: "identity-delete", botId: "b", kind: "self-trait", key: "k", expectedVersion: 3 });
    expect(continuityPatchBody(true)).toEqual({ continuity: true });
    expect(continuityPatchBody(false)).toEqual({ continuity: false });
  });
  it("delete sends the row version and the generic memory screen defers to Continuity", () => {
    expect(read("./ContinuityBlock.tsx")).toContain("expectedVersion: record.version");
    expect(continuityErrorSentence(new Error("MEMORY_VERSION_CONFLICT"))).toBe("This changed in another window. Here is the latest.");
    const review = read("./MemoryReview.tsx");
    expect(review).toContain("Managed in Continuity");
    expect(review).toContain("!managedInContinuity(record.kind) && active");
    expect(review).toContain('!managedInContinuity(record.kind) && record.state === "archived"');
    expect(review).toContain('!managedInContinuity(record.kind) && record.state !== "deleted"');
    for (const kind of ["commitment", "self-trait", "relation"]) expect(managedInContinuity(kind)).toBe(true);
    expect(managedInContinuity("fact")).toBe(false);
  });
  it("maps each server code to a plain sentence", () => {
    for (const code of ["MEMORY_IDENTITY_PIP_CAP", "MEMORY_IDENTITY_PIP_KEY_INVALID", "MEMORY_IDENTITY_PIP_BASIS_INVALID", "MEMORY_VERSION_CONFLICT", "MEMORY_NOT_FOUND", "MEMORY_IDENTITY_PIP_USE_CONTINUITY"]) {
      const sentence = continuityErrorSentence(Object.assign(new Error(code), { body: { error: code } }));
      expect(sentence).toBe(CONTINUITY_ERRORS[code]);
      expect(sentence).not.toContain("MEMORY_");
    }
    expect(continuityErrorSentence(new Error("MEMORY_RECORD_UNAVAILABLE"))).toBe("That name was used before; pick another.");
    expect(continuityErrorSentence(new Error("boom"), "fallback")).toBe("fallback");
  });
  it("formats the coverage line and the edited time", () => {
    expect(coverageLine({ brought: 5, total: 9 })).toBe("Brought 5 of 9 into the last conversation");
    expect(coverageLine(null)).toBeNull();
    expect(wroteLine(NOW - 30_000, NOW)).toBe("You wrote this, edited just now");
    expect(wroteLine(NOW - 2 * 86_400_000, NOW)).toBe("You wrote this, edited 2 days ago");
    expect(wroteLine(undefined, NOW)).toBe("You wrote this");
  });
  it("keeps the copy inside the house rules", () => {
    const words = [read("../lib/continuity.ts"), read("./ContinuityView.tsx"), read("./ContinuityBlock.tsx")].join("\n");
    for (const banned of [/—/, /\bsaf(?:e|ely|ety)\b/i, /\bunsafe\b/i, /composio/i, /always-on/i, /self-evolving/i, /\balive\b|\bfeel(?:s|ing)?\b|\baware/i]) {
      expect(words.replace(/^\s*(\/\/|\*).*$/gm, "")).not.toMatch(banned);
    }
  });
});

describe("PIP P2: reflection between conversations", () => {
  const proposal: ProposalView = { id: "p1", version: 3, targetKind: "commitment", statement: "Check in before sending invoices.", state: "proposed", createdAt: NOW, act: "commit", quotes: [{ sourceId: "m1", text: "please ask me before invoices go out" }] };
  const status: ReflectionStatus = {
    support: { status: "ok", reason: "", copy: null }, lastRunAt: NOW - 2 * 3_600_000, lastAppliedAt: NOW - 2 * 3_600_000, dailyRuns: 3, dailyCap: 24,
    refusals: [
      { at: NOW, runId: "a", state: "refused", reason: "cap" }, { at: NOW, runId: "b", state: "refused", reason: "transient" },
      { at: NOW, runId: "c", state: "refused", reason: "bad-output" }, { at: NOW, runId: "d", state: "refused", reason: "isolation" },
    ],
    running: false, cooldownUntil: 0, unreflected: 0,
  };
  const BANNED = /[\u2013\u2014]|\b(safe|safety|unsafe|always-on|self-evolving|secure)\b/i;

  it("renders the proposal with statement, quote, Confirm and Dismiss, and the chip", () => {
    const html = view({ on: true, proposals: [proposal, { ...proposal, id: "p2" }] });
    expect(html).toContain("Check in before sending invoices.");
    expect(html).toContain("You said: &quot;please ask me before invoices go out&quot;");
    expect(html).toContain(">Confirm<");
    expect(html).toContain(">Dismiss<");
    expect(html).toContain("2 to review");
    expect(html).toContain('href="#continuity-proposed"');
    expect(view({ on: true, proposals: [] })).not.toContain("to review");
    expect(proposalsChip(0)).toBeNull();
  });
  it("labels observed rows and offers Keep it on disputed ones", () => {
    const rows = [...data.records, { id: "r4", version: 1, kind: "commitment", key: "obs", text: "Ask before invoices.", editedAt: NOW, tier: "observed", generation: 2, disputed: true }];
    const dispute: DisputeView = { targetId: "r4", text: "Ask before invoices.", kind: "commitment", generation: 2, counterVersion: 5, unkept: 1, support: 2 };
    const html = view({ on: true, data: { ...data, records: rows }, disputes: [dispute], onKeep: vi.fn() });
    expect(html).toContain("Confirmed from your own words");
    expect(html).toContain("Some of your later words point the other way");
    expect(html).toContain(">Keep it<");
    expect(view({ on: true })).not.toContain("point the other way");
  });
  it("shows support copy verbatim, else last run, the daily count and the last three refusals", () => {
    const copy = "This engine cannot answer text-only requests yet.";
    expect(view({ on: true, status: { ...status, support: { status: "unsupported", reason: "x", copy } } })).toContain(copy);
    const html = view({ on: true, status, onRetryReflection: vi.fn() });
    expect(html).toContain("Last reflected 2 hr ago");
    expect(html).toContain("3 of 24 reflections today");
    for (const line of ["Stopped: daily limit reached", "Paused: the engine did not answer in time", "Stopped: the answer was not usable"]) expect(html).toContain(line);
    expect(html).not.toContain("did not stay text-only");
    expect(html).toContain("Try again");
    expect(view({ on: true, status: { ...status, lastRunAt: null, lastAppliedAt: null, refusals: [] } })).toContain("Not reflected yet");
    expect(view({ on: true, status: { ...status, refusals: [] }, onRetryReflection: vi.fn() })).not.toContain("Try again");
  });
  it("maps refusals to plain lines", () => {
    const table: Record<string, string> = {
      cap: "Stopped: daily limit reached", off: "Stopped: reflection was switched off", unsupported: "Held: this engine cannot answer using only text",
      transient: "Paused: the engine did not answer in time", unstable: "Stopped: three attempts did not finish", "bad-output": "Stopped: the answer was not usable",
      isolation: "Stopped: the engine did more than return text",
    };
    for (const [reason, line] of Object.entries(table)) { expect(refusalLine("refused", reason)).toBe(line); expect(refusalLine(`refused:${reason}`, "")).toBe(line); }
    expect(refusalLine("refused", "mystery")).toBe("Stopped");
  });
  it("offers the template once, and hides it when it exists", () => {
    expect(view({ on: true })).toContain(WRONG_TEMPLATE_TEXT);
    const rows = [...data.records, { id: "r9", version: 1, kind: "commitment", key: "wrong", text: WRONG_TEMPLATE_TEXT, editedAt: NOW }];
    expect(view({ on: true, data: { ...data, records: rows } }).split(WRONG_TEMPLATE_TEXT).length - 1).toBe(1);
  });
  it("the reflection switch follows reflectOn and only shows when Continuity is on", () => {
    const tag = (html: string) => html.match(/<button[^>]*aria-label="Reflect between conversations"[^>]*>/)?.[0] ?? "";
    expect(tag(view({ on: true, reflectOn: true }))).toContain('aria-checked="true"');
    expect(tag(view({ on: true, reflectOn: false }))).toContain('aria-checked="false"');
    expect(view({ on: false, reflectOn: true })).not.toContain("Reflect between conversations");
    expect(view({ on: true })).toContain("Proposed commitments and traits are added when you confirm them.");
  });
  it("copy rules: no dashes or banned words in new sentences or markup", () => {
    const html = view({ on: true, reflectOn: true, proposals: [proposal], status, data: { ...data, records: [...data.records, { id: "r4", version: 1, kind: "commitment", key: "o", text: "x", tier: "observed", disputed: true }] }, disputes: [{ targetId: "r4", text: "x", kind: "commitment", generation: 1, counterVersion: 1, unkept: 0, support: 0 }], onKeep: vi.fn() });
    for (const text of [...PIP_NEW_SENTENCES, WRONG_TEMPLATE_TEXT, html]) expect(text).not.toMatch(BANNED);
    for (const reason of ["cap", "off", "unsupported", "transient", "unstable", "bad-output", "isolation", "zzz"]) expect(refusalLine("refused", reason)).not.toMatch(BANNED);
    expect(html).not.toMatch(/\b(feels?|knows?|aware|thinks?)\b/i);
  });
  it("builds the exact request bodies", () => {
    expect(proposalsReadBody("b")).toEqual({ action: "pip-proposals", botId: "b" });
    expect(proposalConfirmBody("b", "p", 3)).toEqual({ action: "pip-proposal-confirm", botId: "b", id: "p", expectedVersion: 3 });
    expect(proposalDismissBody("b", "p", 3)).toEqual({ action: "pip-proposal-dismiss", botId: "b", id: "p", expectedVersion: 3 });
    expect(keepBody("b", "t", 2, 5)).toEqual({ action: "pip-keep", botId: "b", targetId: "t", generation: 2, counterVersion: 5 });
    expect(reflectStatusBody("b")).toEqual({ action: "pip-reflect-status", botId: "b" });
    expect(reflectRetryBody("b")).toEqual({ action: "pip-reflect-retry", botId: "b" });
    expect(continuityOptionsPatchBody(true)).toEqual({ continuityOptions: { reflect: true } });
    expect(continuityOptionsPatchBody(false)).toEqual({ continuityOptions: null });
  });
  it("never uses a browser dialog and routes refused results to sentences", () => {
    const source = read("./ContinuityView.tsx") + read("./ContinuityBlock.tsx");
    expect(source).not.toMatch(/window\.(confirm|alert)|\bconfirm\(|\balert\(/);
    expect(source).toContain("pipRefusalSentence");
    expect(source).toContain("Yes, dismiss");
  });
});


it("27: shows applied time, unreflected turns, overruns and a retained directory", () => {
  const status: ReflectionStatus = { support: { status: "ok", reason: "", copy: null }, lastRunAt: NOW, lastAppliedAt: null, dailyRuns: 1, dailyCap: 24, running: false, cooldownUntil: 0, unreflected: 2, reportedOverLimit: true, refusals: [{ at: NOW, runId: "leftover", state: "refused:unstable", reason: "Could not stop a leftover process using /fixture/pip-tmp/run; the folder was kept." }] };
  const html = view({ on: true, status });
  expect(html).toContain("Not reflected yet"); expect(html).not.toContain("Last reflected");
  expect(html).toContain("2 turns not reflected yet"); expect(html).toContain("more output tokens than requested"); expect(html).toContain("/fixture/pip-tmp/run");
});
it("28: scopes confirmation to proposed commitments and traits", () => {
  const html = view({ on: true });
  expect(html).toContain("Proposed commitments and traits are added when you confirm them.");
  expect(html).not.toContain("Nothing is added");
});
it("24: offers an owner exclusion control for each conversation", () => {
  const html = view({ on: true, reflectThreads: [{ id: "thread", title: "Main conversation" }], onReflectExclude: vi.fn() });
  expect(html).toContain("Choose which conversations this bot can reflect on."); expect(html).toContain('type="checkbox"');
});
