// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createAdvanceTracker, createEtaGate, createMonotonePercent, etaBelievable, etaMinutes, formatDone, formatElapsed, formatTotal, memorySpan, tweenStep } from "../shared/upgrade-wait.mjs";
import { UPGRADE_TEXT, createUpgradeScreen, leadSentence } from "./upgrade-screen.mjs";
import { describeBytes, memoryUpgradeBlockedSentence, statusFromHealth } from "./memory-upgrade-status.mjs";
import { sampleState } from "../shared/upgrade-contract.mjs";
import { SPLASH_SCRIPT, STARTUP_STAGES, STARTUP_TEXT, createStartupSplash, pageLanguage, splashPage, startupLine } from "./startup-splash.mjs";

const YEAR = 365.25 * 24 * 3600 * 1000;
const BANNED = /\b(database|validate[ds]?|validation|verify|verif\w*|integrity|repair\w*|fix\w*|corrupt\w*|broken|safe\w*|unsafe|safety)\b|—|\bdo not turn off\b/i;

test("totals are two significant figures in long notation, live counts three", () => {
  assert.equal(formatTotal(1_234_567, "en-US"), "1.2 million");
  assert.equal(formatTotal(48_000, "en-US"), "48,000");
  assert.equal(formatTotal(840, "en-US"), "840");
  assert.equal(formatTotal(4300, "en-US"), "4,300");
  assert.equal(formatDone(612_345, "en-US"), "612,000");
  assert.equal(formatDone(612_999, "en-US"), "613,000");
  assert.equal(formatElapsed(14_900, "en-US"), "14s");
  assert.match(formatElapsed(65_000, "en-US"), /1m.*5s/);
});

test("years of memory come from the oldest message; short histories drop the clause", () => {
  const now = Date.UTC(2026, 9, 12);
  assert.deepEqual(memorySpan(now - 8 * YEAR, now), { kind: "years", n: 8 });
  assert.deepEqual(memorySpan(now - 1.4 * YEAR, now), { kind: "year", n: 1 });
  assert.deepEqual(memorySpan(now - 0.4 * YEAR, now), { kind: "months", n: 4 });
  assert.equal(memorySpan(now - 20 * 24 * 3600 * 1000, now), null);
  assert.equal(memorySpan(null, now), null);
  assert.equal(memorySpan(now + 1000, now), null);
});

test("the time left is never seconds: under a minute, about a minute, minutes, then fives", () => {
  assert.deepEqual([0, 30_000, 59_000].map(etaMinutes), [0, 0, 0]);
  assert.deepEqual([60_000, 89_000].map(etaMinutes), [1, 1]);
  assert.deepEqual([90_000, 149_000].map(etaMinutes), [2, 2]);
  assert.deepEqual([200_000, 360_000, 600_000].map(etaMinutes), [3, 6, 10]);
  assert.deepEqual([14 * 60_000, 17 * 60_000, 40 * 60_000].map(etaMinutes), [15, 15, 40]);
  assert.equal(etaMinutes(null), null);
  assert.equal(etaMinutes(-1), null);
});

test("the estimate is believed only when steady, a tenth done and five seconds in", () => {
  assert.equal(etaBelievable({ stable: true, fraction: 0.2, elapsedMs: 6000 }), true);
  assert.equal(etaBelievable({ stable: false, fraction: 0.2, elapsedMs: 6000 }), false);
  assert.equal(etaBelievable({ stable: true, fraction: 0.05, elapsedMs: 6000 }), false);
  assert.equal(etaBelievable({ stable: true, fraction: 0.2, elapsedMs: 4000 }), false);
});

test("ETA hysteresis: a new figure must hold for two polls, may fall, and may rise only once per phase", () => {
  const gate = createEtaGate();
  const poll = (phase, minutes) => gate.update({ phase, etaMs: minutes === null ? null : minutes * 60_000 });
  assert.equal(poll("migrating", null).minutes, null, "nothing is said before an estimate exists");
  assert.equal(poll("migrating", 6).minutes, null, "one reading is not enough");
  assert.equal(poll("migrating", 6).minutes, 6);
  assert.equal(poll("migrating", 5).minutes, 6, "a blip down for one poll does not show");
  assert.equal(poll("migrating", 6).minutes, 6);
  assert.equal(poll("migrating", 5).minutes, 6);
  assert.equal(poll("migrating", 5).minutes, 5, "a figure that holds is shown, and a fall is free");
  assert.equal(poll("migrating", 9).minutes, 5);
  const rose = poll("migrating", 9);
  assert.equal(rose.minutes, 9, "one rise per phase");
  assert.equal(rose.slow, true, "the rise flips the wording to the slow one");
  poll("migrating", 14); const second = poll("migrating", 14);
  assert.equal(second.minutes, 9, "a second rise in the same phase is not shown");
  assert.equal(poll("migrating", null).minutes, null, "UX-05: a missing estimate withdraws the one on show");
  poll("copying", 14); const next = poll("copying", 14);
  assert.equal(next.minutes, 15, "a new phase may rise once more");
});

test("UX-05: the two readings that must agree are consecutive; a gap in between starts the count again", () => {
  const gate = createEtaGate();
  const poll = (minutes) => gate.update({ phase: "migrating", etaMs: minutes === null ? null : minutes * 60_000 });
  assert.equal(poll(6).minutes, null);
  assert.equal(poll(null).minutes, null);
  assert.equal(poll(6).minutes, null, "valid, none, valid is not two in a row");
  assert.equal(poll(6).minutes, 6);
  gate.reset();
  assert.equal(gate.shown(), null, "a wake or a new launch forgets what was shown");
  assert.equal(gate.slow(), false);
  assert.equal(poll(6).minutes, null);
});

test("UX-06: work counts as moving only while its figures change; a heartbeat alone does not", () => {
  const tracker = createAdvanceTracker(60_000);
  assert.equal(tracker.advancing(0), false);
  tracker.observe(["migrating", 1, 5, 0.2], 0);
  assert.equal(tracker.advancing(30_000), true);
  tracker.observe(["migrating", 1, 5, 0.2], 50_000);
  assert.equal(tracker.advancing(61_000), false, "the same figures again are a heartbeat, not progress");
  tracker.observe(["migrating", 2, 5, 0.4], 62_000);
  assert.equal(tracker.advancing(70_000), true);
});

test("the percent never goes backwards and is 100 only when the work is over", () => {
  const percent = createMonotonePercent();
  assert.deepEqual([0.1, 0.4, 0.3, 0.9, 0.2, 1].map(f => percent(f)), [10, 40, 40, 90, 90, 99]);
  assert.equal(percent(0.2, true), 100);
  assert.equal(percent(Number.NaN), 100);
});

test("a counter glides to the real value and never past it", () => {
  assert.equal(tweenStep(0, 1000, 0, 600), 0);
  assert.equal(tweenStep(0, 1000, 300, 600), 500);
  assert.equal(tweenStep(0, 1000, 600, 600), 1000);
  assert.equal(tweenStep(0, 1000, 5000, 600), 1000);
  assert.equal(tweenStep(900, 800, 100, 600), 800, "a lower real value is shown as it is");
});

const L1 = "a".repeat(64);
let seq = 0;
/** One reading of the note: the contract's state, parsed (what readMemoryUpgradeStatus gives the screen). */
const reading = (over = {}, extra = {}) => ({
  state: "upgrading", phase: "migrating", ...extra,
  upgrade: { ok: true, state: sampleState({ launch: L1, seq: ++seq, stage: "starting", phase: "migrating", overall: 0.2, complete: false, held: "unknown", capture: "unknown", recall: "unknown",
    counts: { exact: true, messages: 1_234_567, conversations: 48_123, memoryRecords: 5, firstMessageAt: Date.now() - 8.2 * YEAR }, step: { awakeElapsedMs: 9000, unit: "none" }, eta: { stable: false }, keepOpen: true, ...over }) },
});

test("the lead says what the owner has and how long it takes, with the real counts", () => {
  const clock = Date.now();
  const screen = createUpgradeScreen({ language: "en-US", now: () => clock });
  const view = screen.update(reading(), 20);
  assert.equal(view.mode, "blocking");
  assert.equal(view.title, "Updating your memory");
  assert.equal(view.lead, "You have 1.2 million messages in 48,000 conversations and 8 years of memory. This will take a while. Do not disconnect.");
  assert.equal(view.footer, "Nothing is removed. Your conversations and memory stay as they are.");
  assert.equal(view.line, "Setting up the new memory format");
  assert.equal(view.indeterminate, true, "a step with no count shows activity and the awake time beside its percent");
  assert.equal(view.elapsedMs, 9000, "the awake time the producer measured, not a clock of the window's");
  assert.equal(view.percent, 20);
  assert.equal(view.keepOpen, true);
  assert.equal(view.controls.quitNote, "Quitting now pauses this. Murage continues next time you open it.", "UX-07: the consequence of quitting is said before it");
  assert.equal(view.controls.minimize, "Minimize");
});

test("UX-02: counts that are not exact are not shown, and the 503 body is held to the same rule", () => {
  const screen = createUpgradeScreen({ language: "en-US" });
  const view = screen.update(reading({ counts: { exact: false } }), null);
  assert.equal(view.lead, "Murage is getting your memory ready. This will take a while. Do not disconnect.");
  assert.doesNotMatch(view.lead, /million|1\.2|48/);
  const fed = statusFromHealth({ upgrading: true, upgrade: { ...reading().upgrade.state, counts: { messages: 7, conversations: 1 } } });
  assert.equal(fed.upgrade.ok, false, "counts without exact:true are malformed, never carried");
});

test("without counts it is the counting state; with fewer counts the sentence shrinks", () => {
  const screen = createUpgradeScreen({ language: "en-US" });
  const counting = screen.update(reading({ counts: { exact: false }, phase: "unknown", overall: "unknown" }), null);
  assert.equal(counting.mode, "counting");
  assert.equal(counting.title, "Getting Murage ready");
  assert.equal(counting.line, "Looking at what you have");
  const text = UPGRADE_TEXT.en;
  assert.equal(leadSentence(text, { messages: 5000, conversations: 12, firstMessageAt: null }, "en-US"), "You have 5,000 messages in 12 conversations.");
  assert.equal(leadSentence(text, { messages: 700, conversations: null }, "en-US"), "You have 700 messages.");
  assert.equal(leadSentence(text, { messages: null }, "en-US"), "Murage is getting your memory ready.");
  assert.equal(leadSentence(text, { messages: 9000, conversations: 3, firstMessageAt: Date.now() - 1.3 * YEAR }, "en-US"), "You have 9,000 messages in 3 conversations and a year of memory.");
});

test("the percent in the view never goes back, even if a later reading is lower", () => {
  const screen = createUpgradeScreen({ language: "en-US" });
  const seen = [0.3, 0.5, 0.2, 0.9, 0.1].map(f => screen.update(reading({ overall: f }), null).percent);
  assert.deepEqual(seen, [30, 50, 50, 90, 90]);
});

test("a server that predates the contract, or sends junk, shows activity only and keeps the window open", () => {
  const screen = createUpgradeScreen({ language: "de-DE" });
  const view = screen.update({ state: "upgrading", phase: "migrating", upgrade: { ok: false, reason: "legacy" } }, 40);
  assert.equal(view.percent, null, "UX-03: no upgrade progress yet, so no percent");
  assert.equal(view.indeterminate, true);
  assert.equal(view.keepOpen, true);
  assert.equal(view.title, "Murage wird vorbereitet");
  const missing = createUpgradeScreen({ language: "en-US" });
  missing.update(reading({ overall: 0.5 }), null);
  const later = missing.update({ state: "upgrading", upgrade: { ok: false, reason: "missing:keepOpen" } }, null);
  assert.equal(later.percent, 50, "a reading that does not parse changes no figure");
  assert.equal(later.keepOpen, true);
});

test("r2-5: a missing keepOpen does not withdraw the minimize and taskbar state while blocking", () => {
  const screen = createUpgradeScreen({ language: "en-US" });
  assert.equal(screen.update(reading({ keepOpen: "unknown" }), null).keepOpen, true);
  assert.equal(createUpgradeScreen({ language: "en-US" }).update(reading({ keepOpen: false }), null).keepOpen, false, "false only on an explicit false");
});

test("the measured estimate replaces the stated one only when believable, and does not jump", () => {
  let clock = 0;
  const screen = createUpgradeScreen({ language: "en-US", now: () => clock });
  const at = (ms, etaMin, awake, over = {}) => { clock = ms; return screen.update(reading({ overall: 0.3, eta: etaMin === null ? { stable: false } : { stable: true, ms: etaMin * 60_000 }, step: { awakeElapsedMs: awake, unit: "none" }, ...over }), null); };
  assert.match(at(1000, 4, 1000).lead, /This will take a while\. Do not disconnect\./, "too early to believe");
  assert.match(at(7000, 4, 7000).lead, /This will take a while\. Do not disconnect\./, "one reading");
  assert.match(at(8000, 4, 8000).lead, /About 4 minutes left\. Keep Murage open\.$/);
  assert.match(at(9000, 3, 9000).lead, /About 4 minutes left\./, "a single lower reading is not shown");
  assert.match(at(9500, null, 9500).lead, /This will take a while\. Do not disconnect/, "no estimate now: the one on show is withdrawn");
});

test("slow wording needs an expectation the work fell behind (r8, Fable r7 #6): minutes of moving work with no estimate shown are not 'longer than expected'; 'still working' when nothing moves", () => {
  let clock = 0;
  const screen = createUpgradeScreen({ language: "en-US", now: () => clock });
  const step = (t, over) => { clock = t; return screen.update(reading({ overall: 0.5, ...over }), null); };
  step(0, {});
  // eleven minutes of readings every ten seconds with a changing figure: the work is moving and nothing was promised, so nothing is late
  let view;
  for (let t = 10_000; t <= 11 * 60_000; t += 10_000) view = step(t, { overall: 0.5 + t / 1e9 });
  assert.equal(view.mode, "blocking");
  assert.doesNotMatch(view.lead, /longer than expected|stuck|slow computer|most/i, "UX-06: no comparison, and no expectation that was never stated");
  assert.doesNotMatch(view.lead, /will finish|it will/i, "UX-06: no promise to finish");
  // the same figures for over a minute: not the slow wording
  const still = createUpgradeScreen({ language: "en-US", now: () => clock });
  clock = 0; still.update(reading({ overall: 0.3 }), null);
  let held;
  for (let t = 10_000; t <= 5 * 60_000; t += 10_000) { clock = t; held = still.update(reading({ overall: 0.3, step: { awakeElapsedMs: t, unit: "none" } }), null); }
  assert.equal(held.mode, "blocking", "same figures for minutes: not the slow wording");
  assert.equal(held.lead, "Murage is still working. Keep Murage open.");
});

test("UX-06: sleeping does not count as waiting", () => {
  let clock = 0;
  const screen = createUpgradeScreen({ language: "en-US", now: () => clock });
  screen.update(reading({ overall: 0.2 }), null);
  clock = 60_000; screen.suspend();
  clock = 60_000 + 3 * 3600_000; screen.wake();
  clock += 1000;
  const view = screen.update(reading({ overall: 0.25 }), null);
  assert.equal(view.mode, "blocking", "three hours asleep is not three hours of slowness");
});

test("r2-4: the elapsed clock is the producer's awake time, and a failed read after a long gap withdraws the time left", () => {
  let clock = 0;
  const screen = createUpgradeScreen({ language: "en-US", now: () => clock });
  const eta = { stable: true, ms: 240_000 };
  for (let t = 0; t <= 12_000; t += 2000) { clock = t; screen.update(reading({ overall: 0.3, eta, step: { awakeElapsedMs: t + 6000, unit: "none" } }), null); }
  assert.match(screen.update(reading({ overall: 0.3, eta, step: { awakeElapsedMs: 18_000, unit: "none" } }), null).lead, /About 4 minutes left/);
  clock += 10 * 60_000;
  const failed = screen.failed();
  assert.doesNotMatch(failed.lead, /left/);
  assert.equal(failed.percent, null, "after ten minutes without a reading the line is neutral");
});

test("UX-06: the timeout and failure sentences are true after earlier stages finished, in every language", () => {
  for (const language of ["en", "de", "es", "fr", "hi", "ja", "pt", "zh"]) {
    const timeout = memoryUpgradeBlockedSentence({ code: "MEMORY_MIGRATION_TIMEOUT" }, language, { logPath: "/x/server.log" });
    const failed = memoryUpgradeBlockedSentence({ code: "MEMORY_MIGRATION_FAILED" }, language);
    assert.match(timeout, /server\.log/);
    assert.doesNotMatch(timeout + failed, /as it was|starts over|von vorn|Nothing has been changed|nichts verändert|recommence|desde cero|从头|最初から|do zero|पहले जैसा|Alles ist so|Everything is as/i, language);
  }
  assert.match(memoryUpgradeBlockedSentence({ code: "MEMORY_MIGRATION_TIMEOUT" }, "en", { logPath: "/l" }), /carries on from the last step it finished/);
});

test("UX-11: a counter is shown only for a counted unit with exact figures", () => {
  const screen = createUpgradeScreen({ language: "en-US" });
  const none = screen.update(reading({ phase: "checking" }, { phase: "checking" }), null);
  assert.equal(none.counter, null);
  assert.equal(none.indeterminate, true);
  const messages = screen.update(reading({ phase: "message-index", step: { awakeElapsedMs: 1, unit: "messages", done: 612_345, total: 1_234_567 } }), null);
  assert.equal(messages.counter.kind, "count");
  assert.equal(messages.counter.template, "{done} of {total} messages");
  assert.match(messages.aria, /612,000 of 1\.2 million messages\./);
  const conversations = screen.update(reading({ phase: "lineage", step: { awakeElapsedMs: 1, unit: "conversations", done: 5, total: 50 } }), null);
  assert.equal(conversations.counter, null, "the wait window has no words for conversations: it shows activity instead");
});

test("the copy shows bytes written of bytes to write, from the shell's own measure of the growing file", () => {
  const screen = createUpgradeScreen({ language: "en-US", describeBytes });
  const view = screen.update(reading({ phase: "copying" }, { phase: "copying", copyBytes: 9.1 * 1024 ** 3 }), null, { copiedBytes: 3.2 * 1024 ** 3 });
  assert.equal(view.counter.kind, "text");
  assert.equal(view.counter.text, "3.2 GB of 9.1 GB");
  assert.equal(view.line, "Making a copy first");
  assert.equal(view.indeterminate, false);
  assert.equal(view.elapsedMs, null);
});

test("the last step of the migration says the change is being written", () => {
  const screen = createUpgradeScreen({ language: "en-US" });
  assert.equal(screen.update(reading({}, { step: "committing" }), null).line, "Writing the change");
  assert.equal(screen.update(reading({}, { step: "tables" }), null).line, "Setting up the new memory format");
});

test("finishing: the same window says Murage is opening, the bar reaches the end only when ready", () => {
  const screen = createUpgradeScreen({ language: "en-US" });
  screen.update(reading({ overall: 0.97 }), null);
  const listening = screen.finishing();
  assert.equal(listening.mode, "finishing");
  assert.equal(listening.title, "Opening Murage");
  assert.equal(listening.line, "Murage opens in a moment.");
  assert.equal(listening.percent, 97);
  assert.equal(listening.keepOpen, false);
  assert.equal(screen.finishing({ ready: true }).percent, 100);
});

test("no screen string, in any language, uses a banned word, an em dash, a price or an internal code", () => {
  const tables = Object.entries(UPGRADE_TEXT);
  assert.deepEqual(tables.map(([code]) => code), ["en", "de", "es", "fr", "hi", "ja", "pt", "zh"]);
  const english = Object.keys(UPGRADE_TEXT.en).sort();
  for (const [code, table] of tables) {
    assert.deepEqual(Object.keys(table).sort(), english, `${code} has every key`);
    for (const [key, value] of Object.entries(table)) {
      assert.doesNotMatch(value, BANNED, `${code}.${key}`);
      assert.doesNotMatch(value, /composio|\$|price|MEMORY_|upgrade\.phase|\.db\b|output-index|schema/i, `${code}.${key}`);
      const names = (text) => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
      assert.deepEqual(names(value), names(UPGRADE_TEXT.en[key]), `${code}.${key} placeholders`);
    }
  }
  for (const language of ["en", "de", "es", "fr", "hi", "ja", "pt", "zh"]) {
    for (const code of ["MEMORY_MIGRATION_DISK_SPACE", "MEMORY_SCHEMA_NEWER", "MEMORY_MIGRATION_FAILED", "MEMORY_MIGRATION_TIMEOUT"]) {
      assert.doesNotMatch(memoryUpgradeBlockedSentence({ code, shortBytes: 1048576 }, language, { logPath: "/x/server.log" }), /—|\bsafe|safely|safety|unsafe|composio|\$|price/i, `${language} ${code}`);
    }
  }
});

test("every view that can be produced passes the word ban, in every language", () => {
  for (const language of ["en-US", "de", "es", "fr", "hi", "ja", "pt-BR", "zh"]) {
    let clock = 0;
    const screen = createUpgradeScreen({ language, now: () => clock, describeBytes });
    const views = [];
    for (const [phase, extra] of [["checking", {}], ["copying", {}], ["migrating", {}], ["message-index", { step: { awakeElapsedMs: 1, unit: "messages", done: 5, total: 10 } }]]) {
      for (const t of [0, 9 * 60_000, 11 * 60_000]) { clock = t; views.push(screen.update(reading({ phase, eta: { stable: true, ms: 360_000 }, ...extra }, { phase }), null, { copiedBytes: 1e9 })); }
    }
    views.push(screen.failed(), screen.finishing(), screen.finishing({ ready: true }));
    for (const view of views) {
      if (!view) continue;
      assert.doesNotMatch([view.title, view.lead, view.line, view.footer, view.aria, ...Object.values(view.controls), view.counter?.text ?? "", view.counter?.template ?? ""].join("\n"), BANNED, language);
    }
  }
});

// ---- the page the splash window runs
function fakePage({ reduced = false } = {}) {
  const els = new Map();
  const get = (id) => els.get(id) ?? (els.set(id, { id, textContent: "", style: {}, attrs: {}, cls: new Set(), handlers: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }, addEventListener(name, fn) { this.handlers[name] = fn; }, click() { this.handlers.click?.(); }, classList: { toggle: (name, on) => { on ? els.get(id).cls.add(name) : els.get(id).cls.delete(name); } } }), els.get(id));
  let time = 0; const frames = []; const timers = [];
  const context = {
    document: { getElementById: get, body: { dataset: {} }, documentElement: { lang: "" }, title: "Murage" },
    window: { matchMedia: () => ({ matches: reduced }) }, matchMedia: () => ({ matches: reduced }),
    performance: { now: () => time }, requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    setInterval: (fn) => { timers.push(fn); return timers.length; }, clearInterval() {}, Intl,
  };
  context.window.__set = undefined;
  vm.runInNewContext(SPLASH_SCRIPT, context);
  return { get, set: (state) => context.window.__set(state), advance(ms) { time += ms; const todo = frames.splice(0); for (const fn of todo) fn(time); for (const fn of timers) fn(); }, frames, timers, context };
}
const view = (extra = {}) => ({ kind: "upgrade", mode: "blocking", locale: "en-US", title: "Updating your memory", lead: "L", line: "Checking", footer: "F", percent: 30, indeterminate: false, elapsedMs: null, aria: "30 percent done.", counter: null, ...extra });

test("the page: counters glide to each real value, never past it, and the bar only takes real values", () => {
  const page = fakePage();
  page.set(view({ counter: { kind: "count", done: 1000, total: 2_000_000, template: "{done} of {total} messages" } }));
  assert.equal(page.get("bar").style.width, "30%");
  const seen = [];
  for (let i = 0; i < 8; i++) { page.advance(100); seen.push(page.get("c").textContent); }
  assert.equal(seen.at(-1), "1,000 of 2 million messages");
  for (const text of seen) assert.ok(Number(text.split(" ")[0].replace(/,/g, "")) <= 1000);
  page.set(view({ counter: { kind: "count", done: 5000, total: 2_000_000, template: "{done} of {total} messages" } }));
  for (let i = 0; i < 10; i++) page.advance(100);
  assert.equal(page.get("c").textContent, "5,000 of 2 million messages");
});

test("the page: reduced motion steps values on real updates only and does not tick", () => {
  const page = fakePage({ reduced: true });
  page.set(view({ indeterminate: true, elapsedMs: 14_000, counter: { kind: "count", done: 700, total: 900, template: "{done} of {total} messages" } }));
  assert.equal(page.get("c").textContent, "700 of 900 messages");
  assert.equal(page.frames.length, 0);
  assert.equal(page.timers.length, 0);
  assert.equal(page.get("e").textContent, "14s");
});

test("the page: elapsed time ticks while a step cannot count, and the activity shows", () => {
  const page = fakePage();
  page.set(view({ indeterminate: true, elapsedMs: 14_000 }));
  assert.equal(page.get("e").textContent, "14s");
  assert.ok(page.get("pb").cls.has("act"));
  page.advance(3000);
  assert.equal(page.get("e").textContent, "17s");
  page.set(view({ indeterminate: false }));
  assert.equal(page.get("e").textContent, "");
  assert.ok(!page.get("pb").cls.has("act"));
});

test("the page: the spoken sentence changes at most every ten seconds, the bar text carries it", () => {
  const page = fakePage();
  page.set(view({ aria: "first" }));
  assert.equal(page.get("s").textContent, "first");
  page.advance(2000); page.set(view({ aria: "second" }));
  assert.equal(page.get("s").textContent, "first");
  page.advance(9000); page.set(view({ aria: "third" }));
  assert.equal(page.get("s").textContent, "third");
  assert.equal(page.get("pb").attrs["aria-valuetext"], "third");
  assert.equal(page.get("pb").attrs["aria-valuenow"], "30");
  page.set(view({ aria: "opening", mode: "finishing" }));
  assert.equal(page.get("s").textContent, "opening", "a change of state is spoken at once");
});

test("UX-03: start-up milestones are activity only; the bar then follows one high-water mark and never steps back", () => {
  const page = fakePage();
  page.set({ kind: "stage", pct: null, line: "Opening your conversations" });
  assert.equal(page.get("bar").style.width, "0%", "a milestone fills nothing");
  assert.ok(page.get("pb").cls.has("act"));
  assert.equal(page.get("pb").attrs["aria-valuenow"], undefined);
  assert.equal(page.get("p").textContent, "Opening your conversations");
  page.set(view({ percent: null, indeterminate: true }));
  assert.equal(page.get("bar").style.width, "0%", "upgrade has no progress yet: still no percent");
  page.set(view({ percent: 5 })); assert.equal(page.get("bar").style.width, "5%");
  page.set(view({ percent: 40 })); page.set(view({ percent: 12 }));
  assert.equal(page.get("bar").style.width, "40%");
  page.set({ kind: "bar", pct: 100 });
  assert.equal(page.get("bar").style.width, "100%");
  assert.ok(!page.get("pb").cls.has("act"));
});

test("UX-09: the window document takes the language of the words on it", () => {
  const page = fakePage();
  page.set(view({ locale: "ja-JP" }));
  assert.equal(page.context.document.documentElement.lang, "ja-JP");
});

test("UX-07: the page has visible Minimize and Quit controls and says what quitting does before it can be pressed", () => {
  const page = fakePage();
  page.set(view({ controls: { minimize: "Minimize", quit: "Quit Murage", quitNote: "Quitting now pauses this. Murage continues next time you open it." } }));
  assert.equal(page.get("min").textContent, "Minimize");
  assert.equal(page.get("quit").textContent, "Quit Murage");
  assert.equal(page.get("q").textContent, "Quitting now pauses this. Murage continues next time you open it.");
  page.get("min").click();
  assert.match(page.context.document.title, /^murage-splash:minimize:\d+$/);
  page.get("quit").click();
  assert.match(page.context.document.title, /^murage-splash:quit:\d+$/);
});

test("the page: stage and bar messages move the bar without touching the upgrade text", () => {
  const page = fakePage();
  page.set(view());
  page.set({ kind: "bar", pct: 100 });
  assert.equal(page.get("bar").style.width, "100%");
  assert.equal(page.get("t").textContent, "Updating your memory");
});

test("the window: one window for the start and the upgrade; it grows, becomes minimizable, quits when closed and ignores stage text while upgrading", () => {
  const log = { js: [], urls: [], calls: [] };
  let onClose;
  const BW = class {
    constructor() { this.webContents = { setWindowOpenHandler() {}, on() {}, executeJavaScript: (code) => { log.js.push(code); return Promise.resolve(); } }; }
    on(name, fn) { if (name === "close") onClose = fn; }
    loadURL(url) { log.urls.push(url); return Promise.resolve(); }
    setSize(w, h) { log.calls.push(["size", w, h]); } center() { log.calls.push(["center"]); }
    setMinimizable(v) { log.calls.push(["minimizable", v]); } setSkipTaskbar(v) { log.calls.push(["skipTaskbar", v]); }
    isDestroyed() { return false; } destroy() {}
  };
  let quit = 0;
  const splash = createStartupSplash({ BrowserWindow: BW, onUserClose: () => { quit++; } });
  onClose(); assert.equal(quit, 0, "closing the plain splash is not a quit");
  splash.set({ mode: "blocking", keepOpen: true, title: "x" });
  assert.deepEqual(log.calls.filter(c => c[0] === "size"), [["size", 480, 470]]);
  assert.deepEqual(log.calls.filter(c => c[0] === "minimizable").at(-1), ["minimizable", true]);
  assert.deepEqual(log.calls.filter(c => c[0] === "skipTaskbar").at(-1), ["skipTaskbar", false]);
  assert.equal(splash.stage("module.loaded"), true);
  assert.doesNotMatch(log.js.at(-1), /"kind":"stage"/, "the stage message does not overwrite the upgrade text");
  splash.stage("ready");
  assert.match(log.js.at(-1), /"kind":"bar","pct":100/);
  onClose(); assert.equal(quit, 1, "closing the window while the upgrade is up quits");
  assert.equal(log.urls.length, 1, "the page is loaded once");
  splash.close();
});

test("UX-07: the page's controls reach the shell through the title: minimize minimizes, quit quits, anything else is ignored", () => {
  const titles = {};
  let minimized = 0, quit = 0;
  const BW = class {
    constructor() { this.webContents = { setWindowOpenHandler() {}, on: (name, fn) => { titles[name] = fn; }, executeJavaScript: () => Promise.resolve() }; }
    on() {} loadURL() { return Promise.resolve(); } setSize() {} center() {} setMinimizable() {} setSkipTaskbar() {}
    minimize() { minimized++; } isDestroyed() { return false; } destroy() {}
  };
  const splash = createStartupSplash({ BrowserWindow: BW, onUserClose: () => { quit++; } });
  let prevented = 0; const event = { preventDefault() { prevented++; } };
  titles["page-title-updated"](event, "murage-splash:quit:1");
  assert.equal(quit, 0, "before the upgrade view is up there is nothing to quit from");
  splash.set({ mode: "blocking", keepOpen: true });
  titles["page-title-updated"](event, "murage-splash:minimize:2");
  assert.equal(minimized, 1);
  titles["page-title-updated"](event, "murage-splash:quit:3");
  assert.equal(quit, 1);
  titles["page-title-updated"](event, "Something else");
  titles["page-title-updated"](event, "murage-splash:format:4");
  assert.deepEqual([minimized, quit], [1, 1]);
  assert.equal(prevented, 3, "the window title never really changes");
});

// ---- r2 #8 / UX-08: the first paint speaks the owner's language
const html = (options) => decodeURIComponent(splashPage(options).split(",").slice(1).join(","));
test("r2-8: the first paint of every language has the note and the first line in that language, and the page lang is set", () => {
  const english = new Set([STARTUP_TEXT.en.first, STARTUP_TEXT.en.note, ...STARTUP_TEXT.en.lines]);
  for (const [language, code] of [["en-US", "en"], ["de-DE", "de"], ["es", "es"], ["fr-FR", "fr"], ["hi-IN", "hi"], ["ja", "ja"], ["pt-BR", "pt"], ["zh-CN", "zh"]]) {
    const page = html({ language, note: true });
    assert.match(page, new RegExp(`<html lang="${language}"`), language);
    assert.ok(page.includes(STARTUP_TEXT[code].note), `${language} note`);
    assert.ok(page.includes(STARTUP_TEXT[code].first), `${language} first line`);
    if (code !== "en") for (const text of english) assert.ok(!page.includes(`>${text}<`), `${language} has no English "${text}"`);
    for (const stage of Object.values(STARTUP_STAGES)) assert.ok(STARTUP_TEXT[code].lines.includes(startupLine(language, stage.line)), `${language} ${stage.line}`);
  }
  assert.equal(pageLanguage("sv-SE"), "sv-SE");
  assert.equal(pageLanguage("<script>"), "en", "a malformed tag never reaches the page");
});

test("r2-8: the startup text tables are complete, plain, and say nothing the copy rules ban", () => {
  assert.deepEqual(Object.keys(STARTUP_TEXT), ["en", "de", "es", "fr", "hi", "ja", "pt", "zh"]);
  for (const [code, table] of Object.entries(STARTUP_TEXT)) {
    assert.equal(table.lines.length, 4, code);
    for (const text of [table.first, table.note, ...table.lines]) assert.doesNotMatch(text, BANNED, `${code}: ${text}`);
  }
});

test("r2-8: with no note requested the page has none, and an upgrade view replaces a note that was there", () => {
  assert.doesNotMatch(html({ language: "de", note: false }), /Der erste Start/);
  const page = fakePage();
  page.get("n").textContent = "First start after an update takes a little longer";
  page.set(view({ locale: "de-DE" }));
  assert.equal(page.get("n").textContent, "", "the note is replaced by the upgrade's own words");
  assert.equal(page.context.document.documentElement.lang, "de-DE");
});
