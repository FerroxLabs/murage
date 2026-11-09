// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Today's Calm view (Today slice 1.0.18, designs/TODAY-SLICE-1104.md section 6, test 4). Same shape as every
// component test here (NeedsRow.test.ts, ComposerSendNotice.test.ts): a node environment with no jsdom, markup
// through `renderToStaticMarkup`, the pure parts called directly, and the source read where the wiring is the
// whole contract (the Tell box is the Chief's own Composer; which reads Today makes on open).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { needsLines, type NeedsLinesInput } from "@/lib/today-needs";
import { dayTimeline } from "@/lib/today-day";
import { leadLine, type DoneRow } from "@/lib/today-model";
import type { NeedsSummaryRow } from "@/components/shell/shell-contract";
import { NeedsBlock } from "./NeedsBlock";
import { YourDay, emptyDayLine } from "./YourDay";
import { tellChief, todayChiefId } from "@/lib/today-tell";
import { TellSentLine, tellReceiptShows } from "./TellSentLine";
import { DoneTodayCard, TeamChips } from "./TodayCards";
import { leadSentence } from "./say";
import { todayViewController, type TodayView, type TodayViewState } from "./use-today-view";
import { TodayViewSwitch } from "./TodayViewSwitch";
import { RoutinesLine, SpendCard } from "./SpendCard";
import { DoneDetailed, TeamToday } from "./TeamToday";
import type { RoutineRun } from "@/lib/routines";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const NOW = new Date(2026, 10, 4, 10, 0, 0).getTime();

const row = (id: string, line: string, segment: NeedsSummaryRow["segment"] = "approval"): NeedsSummaryRow => ({ id, line, meta: "Max · waiting since 07:12", open: () => undefined, segment });
const lines = (input: Partial<NeedsLinesInput>) => needsLines({ now: NOW, count: 0, rows: [], restore: [], reconnectApps: [], handoffs: [], routines: [], runs: [], bots: [], botNames: {}, ...input });
const block = (needs: ReturnType<typeof needsLines>, opts: { expanded?: boolean; mode?: "calm" | "all"; count?: number | undefined; stale?: boolean } = {}) =>
  renderToStaticMarkup(createElement(NeedsBlock, { needs, count: "count" in opts ? opts.count : needs.unnamed + needs.decide, expanded: opts.expanded ?? false, mode: opts.mode, stale: opts.stale, onExpand: vi.fn(), onCollapse: vi.fn(), onOpenLine: vi.fn(), onOpenDoor: vi.fn() }));

describe("Needs you on Today", () => {
  it("quiet: one line with a green dot, no box", () => {
    const html = block(lines({ count: 0 }), { count: 0 });
    expect(html).toContain("Nothing needs you");
    expect(html).toContain("When a bot needs a yes, a sign-in or an answer, it shows here.");
    expect(html).toContain('data-needs="quiet"');
    expect(html).toContain("bg-success");
    expect(html).not.toContain("rounded-xl border");
    expect(html).not.toContain("<ul");
  });

  it("never says Nothing needs you while the count is above 0", () => {
    // owed, no row read yet
    const none = block(lines({ count: 3 }), { count: 3 });
    expect(none).toContain("3 things need you");
    expect(none).not.toContain("Nothing needs you");
    // owed items Today cannot name: "and {n} more" to the door
    const some = block(lines({ count: 5, rows: [row("a", "Send the Dana email?"), row("b", "Post the update?")] }), { count: 5 });
    expect(some).toContain("Send the Dana email?");
    expect(some).toContain("and 3 more");
    expect(some).not.toContain("Nothing needs you");
    // count not known yet
    const checking = block(lines({ count: undefined }), { count: undefined });
    expect(checking).toContain("Checking what needs you.");
    expect(checking).not.toContain("Nothing needs you");
  });

  it("a stale count says Checking over the rows as last read, and a stale zero never reads as Nothing needs you", () => {
    const zero = block(lines({ count: 0 }), { count: 0, stale: true });
    expect(zero).toContain("Checking what needs you.");
    expect(zero).not.toContain("Nothing needs you");
    const held = block(lines({ count: 2, rows: [row("a", "Send the Dana email?"), row("b", "Post the update?")] }), { count: 2, stale: true });
    expect(held).toContain("Checking what needs you.");
    expect(held).toContain("Send the Dana email?");
    expect(held).toContain("Post the update?");
    expect(read("./TodayView.tsx")).toContain("stale={needs.stale}");
  });

  it("caps at three lines, expands in place, folds with Show less, and sends the rest to the door", () => {
    const five = Array.from({ length: 5 }, (_, i) => row(`r${i}`, `Decision ${i}`));
    const capped = block(lines({ count: 5, rows: five }), { count: 5 });
    expect(capped.match(/data-line="approval"/g)).toHaveLength(3);
    expect(capped).toContain("and 2 more");
    expect(capped).toContain('aria-expanded="false"');
    expect(capped).not.toContain("Decision 3");
    const open = block(lines({ count: 5, rows: five }), { count: 5, expanded: true });
    expect(open.match(/data-line="approval"/g)).toHaveLength(5);
    expect(open).toContain("Show less");
    expect(open).not.toContain("Open Needs you for the rest");
    const owedMore = block(lines({ count: 7, rows: five }), { count: 7, expanded: true });
    expect(owedMore).toContain("Open Needs you for the rest");
    // Detailed's seam: every line, no Show less
    const all = block(lines({ count: 5, rows: five, cap: Infinity }), { count: 5, mode: "all" });
    expect(all.match(/data-line="approval"/g)).toHaveLength(5);
    expect(all).not.toContain("Show less");
    expect(all).not.toContain("and 2 more");
  });

  it("Decide first; its label is not shown when only Worth a look has lines", () => {
    const both = block(lines({ count: 1, rows: [row("a", "Send it?")], reconnectApps: [{ slug: "gmail", label: "Gmail" }] }), { count: 1 });
    expect(both.indexOf("Decide")).toBeGreaterThan(-1);
    expect(both.indexOf("Send it?")).toBeLessThan(both.indexOf("Sign in to Gmail again"));
    const lookOnly = block(lines({ count: 0, reconnectApps: [{ slug: "gmail", label: "Gmail" }] }), { count: 0 });
    expect(lookOnly).toContain("Worth a look");
    expect(lookOnly).toContain("Sign in to Gmail again");
    expect(lookOnly).not.toContain(">Decide<");
    expect(lookOnly).not.toContain("Nothing needs you");
  });

  it("rows refresh when one decision is replaced by another at the same count", () => {
    const before = block(lines({ count: 1, rows: [row("a", "Send the Dana email?")] }), { count: 1 });
    const after = block(lines({ count: 1, rows: [row("b", "Book the venue?")] }), { count: 1 });
    expect(before).toContain("Send the Dana email?");
    expect(after).toContain("Book the venue?");
    expect(after).not.toContain("Send the Dana email?");
    // useNeedsSummary reads the rows again on inbox.changed and on focus, not only when the count moves.
    const summary = read("../needs/NeedsYouPage.tsx");
    expect(summary).toContain("onInboxChanged(() => { void refresh(); })");
    expect(summary).toContain('window.addEventListener("focus", onFocus)');
    // and Today draws from those rows (less any it answered in one click, until the next read drops them)
    expect(read("./TodayView.tsx")).toContain("withoutAnswered(needs.rows ?? [], needs.count, answered, needs.rowsCount)");
    expect(read("./TodayView.tsx")).toContain("rows: kept.rows");
  });

  it("is not drawn on the browser door, and makes no Worth a look read there", () => {
    const view = read("./TodayView.tsx");
    expect(view).toContain("const needsShown = !firstRun && !remote;");
    expect(view).toContain("const worth = useWorthALook(needsShown);");
    expect(view).toMatch(/needsShown && \(\s*<NeedsBlock/);
  });
});

describe("the Tell box", () => {
  const bots = [{ id: "c", name: "Ember", hidden: false }, { id: "h", name: "Ghost", hidden: true }];
  it("is hidden with no Chief and during first run", () => {
    expect(tellChief(bots, null, false)).toBeNull();
    expect(tellChief(bots, "c", true)).toBeNull();
    expect(tellChief(bots, "h", false)).toBeNull();
    expect(tellChief(bots, "gone", false)).toBeNull();
    expect(tellChief(bots, "c", false)?.name).toBe("Ember");
    // the Chief: the setup view's, else the visible workspace Chief (a section lead is not the Chief)
    const team = [{ id: "lead", chiefOfStaff: true }, { id: "old", chiefOfStaff: true, chiefScope: "workspace" as const, hidden: true }, { id: "chief", chiefOfStaff: true, chiefScope: "workspace" as const }];
    expect(todayChiefId(team, null)).toBe("chief");
    expect(todayChiefId(team, "lead")).toBe("lead");
    expect(todayChiefId([{ id: "lead", chiefOfStaff: true }], null)).toBeNull();
    const view = read("./TodayView.tsx");
    const firstRunBranch = view.indexOf("{model.firstRun ? (");
    expect(firstRunBranch).toBeGreaterThan(0);
    expect(view.indexOf("<TellChiefBox")).toBeGreaterThan(view.indexOf(") : (", firstRunBranch));
    expect(view).toContain("const tellBot = tellChief(state.bots, chief, model.firstRun);");
  });

  it("is the Chief's own Composer: it sends to the Chief's current chat and clears through the composer", () => {
    const box = read("./TellChiefBox.tsx");
    expect(box).toMatch(/<Composer\s+key=\{`\$\{chiefId\}:\$\{threadId\}`\}\s+bot=\{chief\}\s+compact=\{\{ placeholder: t\("ux\.l2a\.today\.tell\.placeholder", \{ chief: chief\.name \}\), sendLabel: t\("ux\.l2a\.today\.tell\.send"\) \}\}\s+onSent=\{\(\) => setSentTo\(\{ chiefId, threadId \}\)\}/);
    expect(box).toContain("const threadId = chief.threadId;");
    // nothing in the box sends on its own
    expect(box).not.toMatch(/dispatch\(|api\(|fetch\(/);
    const composer = read("../Composer.tsx");
    // the composer's one send: to the bot's current conversation
    expect(composer).toContain('const threadId = group?.threadId ?? bot?.threadId ?? "";');
    // VENUE-POST adds the Post in… pick between replyToId and threadId (empty when nothing is picked)
    expect(composer).toMatch(/type: "send",\s+botId: bot\.id,\s+text: requestText,\s+sendId,\s+outboxDraft,\s+replyToId,\s+(?:\.\.\.pickFields,\s+)?threadId,/);
  });

  it("says Sent only after the server acknowledged the send", () => {
    const composer = read("../Composer.tsx");
    expect(composer.match(/onSent\?\.\(\)/g)).toHaveLength(1);
    const watch = composer.indexOf("watchDraftSend(draftId, sendId, attemptId, (outcome) => {");
    expect(watch).toBeGreaterThan(0);
    expect(composer.slice(watch, watch + 600)).toContain('if (outcome === "acked") onSent?.();');
    const quiet = renderToStaticMarkup(createElement(TellSentLine, { sent: false, chiefName: "Ember", onOpen: vi.fn() }));
    expect(quiet).not.toContain("Sent to");
    const sent = renderToStaticMarkup(createElement(TellSentLine, { sent: true, chiefName: "Ember", onOpen: vi.fn() }));
    expect(sent).toContain("Sent to Ember.");
    expect(sent).toContain("Open the chat");
    expect(sent).toContain('role="status"');
  });

  it("compact: placeholder, no toolbar, no attaching, and no slash menu or its reads", () => {
    const composer = read("../Composer.tsx");
    expect(composer).toContain("const slash = compact ? null : composerSlashTrigger(text, caret);");
    expect(composer).toContain("const slashActive = Boolean(slash && slash.start !== dismissedSlashAt);");
    expect(composer).toContain("if (!slashActive || !engineBotId) return;");
    expect(composer).toContain("useSlashSkills(group ? undefined : bot?.id, slashActive)");
    expect(composer).toMatch(/\{!compact && <>\s*\{!locked && !phoneComposer && \(/);
    expect(composer).toContain("{!compact && phoneComposer && !locked && !approval && (");
    expect(composer).toMatch(/\{!compact && <div\s+aria-hidden\s+className="absolute -left-5 -right-5 top-1\/2 h-\[50vh\] bg-app"/);
    expect(composer).toContain("{(!compact || attachments.length > 0) && <ComposerAttachments");
    expect(composer).toContain("if (compact) return;");
    expect(composer).toContain("? { lead: compact.placeholder }");
  });

  it("compact never warms an engine, never takes the caret on open and is never taken over by an approval", () => {
    const composer = read("../Composer.tsx");
    expect(composer).toContain("useWarmIntent(compact ? undefined : bot?.id, threadId, text);");
    expect(composer.match(/useWarmIntent\(/g)).toHaveLength(1);
    expect(composer).toContain("const approval = compact ? undefined : approvals[0];");
    const open = composer.indexOf("if (globalThis.matchMedia?.(COARSE_POINTER_QUERY).matches) return;");
    expect(open).toBeGreaterThan(0);
    expect(composer.slice(open - 200, open)).toContain("if (compact) return;");
    // the Today event that asks for the box still focuses it
    expect(composer).toContain("window.addEventListener(FOCUS_COMPOSER_EVENT, focus);");
    const warm = read("../../hooks/use-warm-intent.ts");
    expect(warm).toContain("if (!botId || !threadId) return;");
    expect(warm).toContain("if (!botId || !threadId || !typed || !changed) return;");
  });

  it("compact: a Send button always drawn with its word, disabled while empty, 44 px controls on a phone", () => {
    const composer = read("../Composer.tsx");
    const at = composer.indexOf("{compact && !locked && (");
    expect(at).toBeGreaterThan(0);
    const button = composer.slice(at, composer.indexOf("</button>", at));
    expect(button).toContain("onClick={send}");
    expect(button).toContain("disabled={sendPending || !hasContent}");
    expect(button).toContain("min-h-11");
    expect(button).toContain("{compact.sendLabel}");
    expect(composer).toContain("{!compact && hasContent && !locked && (");
    expect(composer).toContain('compact && "max-[760px]:[&_button:not([data-tell-send])]:size-11"');
  });

  it("compact: draft chips show with intake off, so no window drop handler is installed", () => {
    const composer = read("../Composer.tsx");
    expect(composer).toContain("intake={!compact}");
    const attachments = read("../ComposerAttachments.tsx");
    const effect = attachments.indexOf("if (!intake) return;");
    expect(effect).toBeGreaterThan(0);
    expect(effect).toBeLessThan(attachments.indexOf('window.addEventListener("drop", onDrop);'));
  });

  it("Sent shows only for the Chief and conversation it went to; a new Chief or task clears it", () => {
    expect(tellReceiptShows(null, "c", "t1")).toBe(false);
    expect(tellReceiptShows({ chiefId: "c", threadId: "t1" }, "c", "t1")).toBe(true);
    expect(tellReceiptShows({ chiefId: "c", threadId: "t1" }, "c", "t2")).toBe(false);
    expect(tellReceiptShows({ chiefId: "c", threadId: "t1" }, "d", "t1")).toBe(false);
    expect(tellReceiptShows({ chiefId: "c", threadId: "" }, "c", "")).toBe(false);
    const box = read("./TellChiefBox.tsx");
    expect(box).toContain("useEffect(() => setSentTo(null), [chiefId, threadId]);");
    expect(box).toContain("onOpen={() => onOpenChat(chiefId, threadId)}");
  });
});

describe("what Today reads on open", () => {
  // Inbox (and its snooze refresh), needs-reconnect, team-map, connectors/connected, engine-health. No model, turn or send route.
  const ALLOWED = [/^\/api\/owner-prefs\/today-view$/, /^\/api\/inbox\?view=decisions&pageSize=(1|25)$/, /^\/api\/connectors\/needs-reconnect$/, /^\/api\/team-map\?phase=busy$/, /^\/api\/connectors\/connected(\?force=1)?$/, /^\/api\/engine-health$/];
  const FILES = [
    "./TodayView.tsx", "./TodayCards.tsx", "./NeedsBlock.tsx", "./YourDay.tsx", "./TellChiefBox.tsx", "./say.ts", "./StatusLine.tsx", "./WorkingNowCard.tsx",
    "./use-worth-a-look.ts", "./use-engine-health.ts", "../needs/NeedsYouPage.tsx", "../usePendingApprovals.ts",
    "../../lib/connected-apps-preload.ts", "../../lib/today-model.ts", "../../lib/today-needs.ts", "../../lib/today-day.ts",
    "./use-today-view.ts", "./TodayViewSwitch.tsx", "./SpendCard.tsx", "./TeamToday.tsx", "../../lib/today-detail.ts",
    // the one-click slot is a lazy reference only; its card read (TodayQuickAnswer) loads on first use, for a
    // Decide row that is a waiting request (today-inline-approve.test.ts)
    "./today-quick.tsx",
  ];
  it("every read is on the allowlist", () => {
    const paths = FILES.flatMap((file) => [...read(file).matchAll(/["'`](\/api\/[^"'`$]*)/g)].map((match) => ({ file, path: match[1]! })));
    expect(paths.filter(({ path }) => !ALLOWED.some((ok) => ok.test(path)))).toEqual([]);
    for (const ok of ALLOWED) expect(paths.some(({ path }) => ok.test(path)), String(ok)).toBe(true);
    for (const file of FILES) expect(read(file), file).not.toMatch(/\/messages\b|\/respond\b|\/turns?\b|\/completions|\/api\/models/);
  });
  // The Tell box is the Chief's own Composer: each read the composer and its hooks can make is listed here with the
  // gate that keeps it off in compact. A new read there fails this until it is gated and listed.
  const COMPOSER_FILES = ["../Composer.tsx", "../ComposerAttachments.tsx", "../../hooks/use-warm-intent.ts", "../../lib/use-slash-skills.ts", "../../lib/routine-grant-saved.ts", "../useTrayIntents.ts"];
  const GATED: Record<string, string> = {
    "/api/bots/${engineBotId}/engine-commands": "const slash = compact ? null : composerSlashTrigger(text, caret);",
    "/api/bots/${botId}/skills": "useSlashSkills(group ? undefined : bot?.id, slashActive)",
    "/api/bots/${botId}/warm": "useWarmIntent(compact ? undefined : bot?.id, threadId, text);",
    "/api/bots/${botId}/typing": "useWarmIntent(compact ? undefined : bot?.id, threadId, text);",
    "/api/routines/${encodeURIComponent(conversationRoutine.id)}": "{autoBot && <PermissionModeSelector bot={autoBot} onSetMode={setMode} routine={routineLevel} />}",
  };
  it("the Tell box's composer makes no read in compact beyond the allowlist", () => {
    const composer = read("../Composer.tsx");
    const found = COMPOSER_FILES.flatMap((file) => [...read(file).matchAll(/["'`](\/api\/[^"'`]*)["'`]/g)].map((match) => match[1]!));
    expect(found.filter((path) => !ALLOWED.some((ok) => ok.test(path)) && !(path in GATED))).toEqual([]);
    for (const gate of Object.values(GATED)) expect(composer, gate).toContain(gate);
    // the mode selector (the only caller of that PATCH) is inside the toolbar compact does not draw
    const toolbar = composer.indexOf("{!compact && <>");
    expect(composer.indexOf("<PermissionModeSelector bot={autoBot}")).toBeGreaterThan(toolbar);
    expect(composer.indexOf("<PermissionModeSelector bot={autoBot}")).toBeLessThan(composer.indexOf("</>}", toolbar));
  });
});

describe("Your day", () => {
  const routine = (id: string, name: string, at: number | null, extra: Record<string, unknown> = {}) => ({ id, botId: "b", name, enabled: true, schedule: { type: "daily" }, nextRunAt: at, ...extra }) as never;
  const day = (routines: never[]) => renderToStaticMarkup(createElement(YourDay, { timeline: dayTimeline(routines, NOW), now: NOW, botNames: { b: "Max" }, chiefName: "Ember", onOpenRoutines: vi.fn() }));
  it("rows from now to midnight, then the meetings placeholder", () => {
    const html = day([routine("r1", "Inbox brief", NOW + 3_600_000)]);
    expect(html).toContain("Your day");
    expect(html).toContain("Now");
    expect(html).toContain("11:00");
    expect(html).toContain("Inbox brief");
    expect(html).toContain("Max");
    expect(html).toContain("Midnight");
    expect(html).toContain("Your own meetings will show here in a coming update.");
  });
  it("empty: the next run, or no routines at all", () => {
    const tomorrow = new Date(2026, 10, 5, 8, 0).getTime();
    expect(emptyDayLine(dayTimeline([routine("r1", "Brief", tomorrow)], NOW), NOW, "Ember")).toMatch(/^Nothing else is scheduled today\. Next: Brief, .+\.$/);
    expect(emptyDayLine(dayTimeline([], NOW), NOW, "Ember")).toBe("No routines yet. Tell Ember what you want done every day.");
    const html = day([]);
    expect(html).toContain("No routines yet. Tell Ember what you want done every day.");
    expect(html).toContain("Your own meetings will show here in a coming update.");
  });
});

describe("Done today, the lead line and the team", () => {
  const done = (status: DoneRow["status"], extra: Partial<DoneRow> = {}): DoneRow => ({ id: `done:${status}`, runId: status, routineId: "r", botId: "b", title: "Inbox brief", line: null, status, tone: status === "completed" ? "ok" : "bad", botName: "Max", at: NOW, time: "10:00", ...extra });
  it("Done today: rows titled by routine, the empty line otherwise", () => {
    const empty = renderToStaticMarkup(createElement(DoneTodayCard, { rows: [], onOpen: vi.fn(), onOpenResults: vi.fn() }));
    expect(empty).toContain("Done today");
    expect(empty).toContain("Nothing finished yet today. Results show here.");
    const html = renderToStaticMarkup(createElement(DoneTodayCard, { rows: [done("failed", { line: { key: "ux.l2a.today.look.failedGeneric" } }), done("completed")], onOpen: vi.fn(), onOpenResults: vi.fn() }));
    expect(html).toContain("Open it to see what happened");
    expect(html).toContain("Max · 10:00");
    expect(html.indexOf('data-done="failed"')).toBeLessThan(html.indexOf('data-done="completed"'));
    expect(html).not.toContain("data-done-more");
    const seven = Array.from({ length: 7 }, (_, i) => done("completed", { id: `d${i}` }));
    const over = renderToStaticMarkup(createElement(DoneTodayCard, { rows: seven, onOpen: vi.fn(), onOpenResults: vi.fn() }));
    expect(over.match(/data-done="completed"/g)).toHaveLength(5);
    expect(over).toContain("data-done-more");
    expect(over).toContain("and 2 more");
  });
  it("lead line: counts joined, zero parts dropped, the quiet line when nothing happened", () => {
    const at = new Date(2026, 10, 4, 14, 0).getTime();
    expect(leadSentence(leadLine({ ran: 1, look: 2, decide: 0, next: { name: "Brief", at } }))).toBe("Today: 1 routine ran, 2 worth a look. Next: Brief at 14:00.");
    expect(leadSentence(leadLine({ ran: 3, look: 0, decide: 1, next: null }))).toBe("Today: 3 routines ran. 1 to decide.");
    expect(leadSentence(leadLine({ ran: 4, look: 2, decide: 1, next: { name: "Brief", at } }))).toBe("Today: 4 routines ran, 2 worth a look. 1 to decide. Next: Brief at 14:00.");
    expect(leadSentence(leadLine({ ran: 0, look: 0, decide: 2, next: null }))).toBe("Today: 2 to decide.");
    expect(leadSentence(leadLine({ ran: 0, look: 0, decide: 0, next: null }))).toBe("Your team is ready. Nothing ran yet today.");
  });
  it("team chips with the working dot replace the joined names; Try next and Today's routines are gone", () => {
    const html = renderToStaticMarkup(createElement(TeamChips, { bots: [{ id: "a", name: "Max", working: true }, { id: "b", name: "Ember", working: false }], onOpen: vi.fn(), onHire: vi.fn() }));
    expect(html.match(/data-working=""/g)).toHaveLength(1);
    expect(html).toContain(">Max<");
    expect(html).toContain(">Ember<");
    expect(html).toContain("Hire a bot");
    const view = read("./TodayView.tsx");
    for (const gone of ["TryNextCard", "ux.l2a.today.teamMore", "Intl.ListFormat", "ux.l2a.today.routinesTitle", "localStorage"]) expect(view, gone).not.toContain(gone);
    expect(view).toContain("<MonthCard onOpenUsage={nav.openUsage} />");
    expect(view).toContain("todayEngine(reading.engine, engineReadings, usedEngines, engineAnswer?.engines ?? null)");
  });
});

describe("Calm | Detailed (design 2b)", () => {
  /** A request the test answers by hand. */
  const deferred = () => {
    let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
    const promise = new Promise<unknown>((ok, no) => { resolve = ok; reject = no; });
    return { promise, resolve, reject };
  };
  const rig = () => {
    const gets: ReturnType<typeof deferred>[] = [];
    const posts: Array<{ view: TodayView; answer: ReturnType<typeof deferred> }> = [];
    const states: TodayViewState[] = [];
    const io = {
      get: () => { const d = deferred(); gets.push(d); return d.promise; },
      post: (view: TodayView) => { const d = deferred(); posts.push({ view, answer: d }); return d.promise; },
    };
    const ctl = todayViewController(io, (state) => states.push(state));
    const last = () => states.at(-1) ?? { view: "calm", failed: false };
    return { ctl, gets, posts, states, last };
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("is Calm until the pref answers, then shows the saved view; reads coalesce to one in flight", async () => {
    const { ctl, gets, last } = rig();
    void ctl.read(); void ctl.read(); void ctl.read();
    expect(gets).toHaveLength(1);
    expect(last().view).toBe("calm");
    gets[0]!.resolve({ view: "detailed", canSave: true });
    await tick(); await tick();
    expect(last().view).toBe("detailed");
    // the reads asked mid-flight get exactly one more
    expect(gets).toHaveLength(2);
    gets[1]!.resolve({ view: "detailed", canSave: true });
    await tick();
    expect(gets).toHaveLength(2);
  });

  it("the hook reads once on mount and again on window focus, and never touches localStorage", () => {
    const hook = read("./use-today-view.ts");
    expect(hook.match(/void reader\.read\(\);/g)).toHaveLength(2);
    expect(hook).toContain('window.addEventListener("focus", onFocus);');
    expect(hook).not.toMatch(/localStorage|sessionStorage/);
    const view = read("./TodayView.tsx");
    expect(view).toContain("const todayView = useTodayView(!firstRun);");
    expect(view).toContain("const viewSwitch = model.firstRun ? null : <TodayViewSwitch");
  });

  it("a GET that overlapped a POST never overwrites the choice the POST saved", async () => {
    const { ctl, gets, posts, last } = rig();
    void ctl.read();
    gets[0]!.resolve({ view: "calm", canSave: true });
    await tick();
    ctl.press("detailed");
    expect(posts).toHaveLength(1);
    // a focus read starts while the POST is out, and reads the value from before it
    const during = ctl.read();
    expect(gets).toHaveLength(2);
    posts[0]!.answer.resolve({ view: "detailed", canSave: true });
    await tick(); await tick();
    expect(last()).toEqual({ view: "detailed", failed: false });
    gets[1]!.resolve({ view: "calm", canSave: true });
    await during; await tick();
    expect(last()).toEqual({ view: "detailed", failed: false });
    // a later read that overlapped nothing still moves the view
    const after = ctl.read();
    gets[2]!.resolve({ view: "calm", canSave: true });
    await after; await tick();
    expect(last().view).toBe("calm");
  });

  it("an early press whose deferred save fails flips back to the server's saved view, not to Calm", async () => {
    const { ctl, gets, posts, last } = rig();
    ctl.press("calm");
    void ctl.read();
    gets[0]!.resolve({ view: "detailed", canSave: true });
    await tick(); await tick();
    expect(posts.map((post) => post.view)).toEqual(["calm"]);
    expect(last().view).toBe("calm");
    posts[0]!.answer.reject(new Error("500"));
    await tick(); await tick();
    expect(last()).toEqual({ view: "detailed", failed: true });
  });

  it("the head's Needs you tag gets NeedsBlock's conditions: stale, unknown and Worth a look lines (H6)", () => {
    const view = read("./TodayView.tsx");
    expect(view).toContain("needsState: { stale: needsShown && needs.stale === true, lines: needsShown ? lines.all.length : 0, reads: needsShown },");
    // the lines are read before the head's model, from the same needsLines the block draws
    expect(view.indexOf("const lines = needsLines(")).toBeLessThan(view.indexOf("const model = todayModel("));
  });

  it("Detailed desktop: DOM order is the order seen, with no CSS order, and focus is kept across a layout change", () => {
    const view = read("./TodayView.tsx");
    expect(view).not.toMatch(/md:order-\d/);
    expect(view).toContain("{detailedOrder(narrow).map((key) => {");
    expect(view).toContain("const narrow = useNarrowViewport();");
    expect(view).toContain("useFocusKept(detailedGrid, narrow);");
    expect(view).toContain("<div key={key} data-today-block={key}");
  });

  it("rapid presses flip at once, write one at a time, and the latest press wins over a delayed GET", async () => {
    const { ctl, gets, posts, last } = rig();
    void ctl.read();
    gets[0]!.resolve({ view: "calm", canSave: true });
    await tick();
    const late = ctl.read(); // starts before the presses below; answered last
    expect(gets).toHaveLength(2);
    ctl.press("detailed");
    expect(last().view).toBe("detailed");
    ctl.press("calm");
    ctl.press("detailed");
    expect(last().view).toBe("detailed");
    expect(posts.map((post) => post.view)).toEqual(["detailed"]);
    posts[0]!.answer.resolve({ view: "detailed", canSave: true });
    await tick(); await tick();
    // the newest press still to send went next; the middle one was folded
    expect(posts.map((post) => post.view)).toEqual(["detailed", "detailed"]);
    gets[1]!.resolve({ view: "calm", canSave: true });
    await late; await tick();
    expect(last().view).toBe("detailed");
    posts[1]!.answer.resolve({ view: "detailed", canSave: true });
    await tick();
    expect(last()).toEqual({ view: "detailed", failed: false });
  });

  it("a refused or failed save flips back to the saved view and says so", async () => {
    const { ctl, gets, posts, last } = rig();
    void ctl.read();
    gets[0]!.resolve({ view: "calm", canSave: true });
    await tick();
    ctl.press("detailed");
    expect(last().view).toBe("detailed");
    posts[0]!.answer.reject(new Error("403"));
    await tick(); await tick();
    expect(last()).toEqual({ view: "calm", failed: true });
    const html = renderToStaticMarkup(createElement(TodayViewSwitch, { view: "calm", failed: true, onPick: vi.fn() }));
    expect(html).toContain("That did not save. Try again.");
    // the next press clears the line
    ctl.press("detailed");
    expect(last().failed).toBe(false);
  });

  it("canSave false: the press is this visit only, never POSTs, never errors, and focus never undoes it", async () => {
    const { ctl, gets, posts, last } = rig();
    void ctl.read();
    gets[0]!.resolve({ view: "calm", canSave: false });
    await tick();
    ctl.press("detailed");
    expect(last()).toEqual({ view: "detailed", failed: false });
    void ctl.read();
    gets[1]!.resolve({ view: "calm", canSave: false });
    await tick(); await tick();
    expect(last()).toEqual({ view: "detailed", failed: false });
    expect(posts).toEqual([]);
  });

  it("a press before the first answer is kept, and saved once the answer says this surface may save", async () => {
    const saves = rig();
    saves.ctl.press("detailed");
    void saves.ctl.read();
    saves.gets[0]!.resolve({ view: "calm", canSave: true });
    await tick(); await tick();
    expect(saves.posts.map((post) => post.view)).toEqual(["detailed"]);
    expect(saves.last().view).toBe("detailed");
    const visits = rig();
    void visits.ctl.read();
    visits.ctl.press("detailed");
    visits.gets[0]!.resolve({ view: "calm", canSave: false });
    await tick();
    expect(visits.posts).toEqual([]);
    expect(visits.last().view).toBe("detailed");
  });

  it("the switch is a radiogroup of two radios, the chosen one in the tab order, 44 px under 760 px, arrow keys move", () => {
    const html = renderToStaticMarkup(createElement(TodayViewSwitch, { view: "detailed", failed: false, onPick: vi.fn() }));
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="How much Today shows"');
    expect(html.match(/role="radio"/g)).toHaveLength(2);
    expect(html).toMatch(/aria-checked="true"[^>]*tabindex="0"[^>]*data-view-option="detailed"/);
    expect(html).toMatch(/aria-checked="false"[^>]*tabindex="-1"[^>]*data-view-option="calm"/);
    expect(html).toContain(">Calm<");
    expect(html).toContain(">Detailed<");
    expect(html).toContain("max-[760px]:h-11");
    expect(html).not.toContain("That did not save");
    const source = read("./TodayViewSwitch.tsx");
    for (const key of ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"]) expect(source).toContain(key);
    const view = read("./TodayView.tsx");
    expect(view).toContain('{viewSwitch && <div className="ml-auto md:hidden">{viewSwitch}</div>}');
    expect(view).toContain('{viewSwitch && <div className="hidden md:block">{viewSwitch}</div>}');
  });

  it("Detailed shows every Needs you line with no Show less; Calm caps at three", () => {
    const five = Array.from({ length: 5 }, (_, i) => row(`r${i}`, `Decision ${i}`));
    const calm = block(lines({ count: 5, rows: five }), { count: 5 });
    expect(calm.match(/data-line="approval"/g)).toHaveLength(3);
    const all = block(lines({ count: 5, rows: five, cap: Number.POSITIVE_INFINITY }), { count: 5, mode: "all" });
    expect(all.match(/data-line="approval"/g)).toHaveLength(5);
    expect(all).not.toContain("Show less");
    expect(all).not.toContain("and 2 more");
    const view = read("./TodayView.tsx");
    expect(view).toContain("const needsCap = detailed ? Number.POSITIVE_INFINITY : NEEDS_LINE_CAP;");
    expect(view).toContain('mode={detailed ? "all" : "calm"}');
  });

  it("the Detailed blocks load lazily, out of the first paint", () => {
    const view = read("./TodayView.tsx");
    for (const name of ["SpendCard", "TeamToday", "today-detail"]) expect(view, name).not.toMatch(new RegExp(`^import .*${name}`, "m"));
    expect(view).toContain('retryableLazy(() => import("./SpendCard")');
    expect(view).toContain('retryableLazy(() => import("./TeamToday")');
  });

  const cost = (id: string, day: number, value: number | null): RoutineRun => ({ id, routineId: "r1", routineName: "Brief", target: "bot", botId: "a", runOn: "ember", scheduledFor: new Date(2026, 10, day, 8).getTime(), finishedAt: new Date(2026, 10, day, 9).getTime(), startedAt: new Date(2026, 10, day, 8, 58).getTime(), status: "completed", manual: false, createdAt: 0, cost: value } as RoutineRun);
  it("the cost card: 7 div bars, today in the accent, a hollow bar for a day with no reported cost, values in its label", () => {
    const html = renderToStaticMarkup(createElement(SpendCard, { runs: [cost("a", 1, 0.2), cost("b", 2, null), cost("c", 3, 0.4), cost("d", 4, 0.3)], now: NOW, onOpenUsage: vi.fn() }));
    expect(html).toContain("Reported routine cost");
    expect(html).toContain("$0.30 today");
    expect(html).toContain("Not enough days yet to compare.");
    expect(html).toContain("Routine runs only. Chats are on the Usage page.");
    expect(html).toContain("See usage");
    expect(html.match(/data-bar=/g)).toHaveLength(7);
    expect(html).toContain('data-bar="unreported"');
    expect(html).toMatch(/aria-label="Last 7 days: [^"]*\$0\.20[^"]*no cost reported[^"]*\$0\.30"/);
    expect(html).not.toMatch(/<svg|<canvas/);
    expect(html.match(/bg-accent/g)).toHaveLength(1);
    expect(renderToStaticMarkup(createElement(SpendCard, { runs: [], now: NOW, onOpenUsage: vi.fn() }))).toContain("No routine reported a cost this week.");
    const line = renderToStaticMarkup(createElement(RoutinesLine, { routines: [{ id: "r1", name: "Brief", enabled: true, nextRunAt: null } as never], runs: [cost("d", 4, 0.3)], now: NOW }));
    expect(line).toContain("Routines today: 1 ran, 0 failed. Nothing else scheduled.");
    expect(renderToStaticMarkup(createElement(RoutinesLine, { routines: [], runs: [], now: NOW }))).toBe("");
  });

  it("Your team today lists every visible bot with its state, last and next; Done today detailed has the detail line", () => {
    const bots = [
      { id: "a", name: "Max", threadId: "a-main", activity: "no-signal", modelSelection: { instanceId: "fuigo", model: "m" }, tasks: [] },
      { id: "b", name: "Ember", threadId: "b-main", activity: "waiting-on-you", modelSelection: { instanceId: "fuigo", model: "m" } },
      { id: "h", name: "Ghost", threadId: "h-main", hidden: true, modelSelection: { instanceId: "fuigo", model: "m" } },
    ] as never[];
    const team = renderToStaticMarkup(createElement(TeamToday, { bots, routines: [], runs: [cost("d", 4, 0.3)], now: NOW, onOpen: vi.fn(), onHire: vi.fn() }));
    expect(team).toContain("Your team today");
    expect(team).toContain("Not responding");
    expect(team).toContain("Waiting for you");
    expect(team).not.toContain("Ghost");
    expect(team).toContain("Last run 09:00");
    expect(team).toContain("No runs yet");
    expect(team).toContain("Nothing scheduled");
    expect(team.indexOf("Ember")).toBeLessThan(team.indexOf("Max"));
    const doneRows = [{ id: "done:d", runId: "d", routineId: "r1", botId: "a", title: "Brief", line: null, status: "completed" as const, tone: "ok" as const, botName: "Max", at: NOW, time: "09:00" }];
    const done = renderToStaticMarkup(createElement(DoneDetailed, { rows: doneRows, runs: [cost("d", 4, null)], bots, instances: [{ instanceId: "fuigo", displayName: "Fuigo" }], onOpen: vi.fn(), onOpenResults: vi.fn() }));
    expect(done).toContain("Max · 09:00 · took 2m 00s · no cost reported · runs on Fuigo");
  });
});
