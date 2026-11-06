// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { APPROVE_ALL_THREAD, approvalBatchDigest, approvalDigest } from "../../shared/approval-digest";
import en from "../locales/en.json";

const native = vi.hoisted(() => ({ available: true, calls: [] as unknown[], reply: { signature: "sig" } as unknown }));
vi.mock("./native-shell", () => ({
  nativeAvailable: async () => native.available,
  callNative: async (_method: string, args: unknown) => { native.calls.push(args); return native.reply; },
}));

import { BULK_REASON_KEYS, applyApproveAll, batchReason, groupByBot, kindLine, reasonLine, resultLine, tickedIds, type ApproveAllPreview, type EligibleCard } from "./approve-all";
import * as lib from "./approve-all";
import * as view from "../components/ApproveAll";

const card = (requestId: string, botId: string, kind: EligibleCard["kindLine"], threadId = `t-${botId}`): EligibleCard =>
  ({ threadId, requestId, botId, kindLine: kind, digest: "", card: { tool: "Bash", title: "Approval needed", subtitle: "npm test", summary: `run ${requestId}` } });

describe("Approve all copy (APPROVE-ALL-1016 batch B)", () => {
  it("every reason the server can send has its own English line, and an unknown one never reads as blank", () => {
    const server = readFileSync(new URL("../../server/approve-all.ts", import.meta.url), "utf8");
    const declared = server.match(/export type BulkReasonKey =([^;]+);/)?.[1].match(/"([a-z-]+)"/g)?.map((key) => key.slice(1, -1)).sort();
    expect(declared).toEqual([...BULK_REASON_KEYS].sort());
    const lines = BULK_REASON_KEYS.map(reasonLine);
    for (const [i, key] of BULK_REASON_KEYS.entries()) expect(lines[i]).toBe((en as Record<string, string>)[`approveAll.reason.${key}`]);
    expect(new Set(lines).size).toBe(BULK_REASON_KEYS.length);
    expect(reasonLine("brand-new")).toBe(reasonLine("needs-look"));
    expect(reasonLine("origin")).toBe("started outside the app");
    expect(reasonLine("sensitive")).toBe("reads keys or passwords");
  });
  it("no new string uses an em dash or the words safe or free", () => {
    const strings = Object.entries(en as Record<string, string>).filter(([key]) => key.startsWith("approveAll."));
    expect(strings.length).toBeGreaterThan(40);
    for (const [key, value] of strings) expect(`${key}: ${value}`).not.toMatch(/—|\bsafe\b|\bfree\b/i);
  });
  it("groups by bot in the server's order, then by kind, and ticks track the bots left on", () => {
    const eligible = [card("a", "finch", "edit"), card("b", "kessler", "command"), card("c", "finch", "command"), card("d", "finch", "edit")];
    expect(groupByBot(eligible)).toEqual([
      { botId: "finch", requestIds: ["a", "c", "d"], kinds: [{ kind: "command", n: 1 }, { kind: "edit", n: 2 }] },
      { botId: "kessler", requestIds: ["b"], kinds: [{ kind: "command", n: 1 }] },
    ]);
    expect(tickedIds(eligible, new Set())).toEqual(["a", "b", "c", "d"]);
    expect(tickedIds(eligible, new Set(["kessler"]))).toEqual(["a", "c", "d"]);
    expect(kindLine("edit", 2)).toBe("Edit files: 2");
    expect(kindLine("weird", 1)).toBe("Other steps: 1");
  });
  it("the result line says it cannot be undone, and names the bot that stopped waiting", () => {
    const name = (threadId: string) => (threadId === "t-kessler" ? "Kessler" : "Finch");
    expect(resultLine([{ threadId: "t-finch", requestId: "a", result: "approved" }, { threadId: "t-finch", requestId: "b", result: "approved" }], name))
      .toBe("Approved 2. They are running now and can't be undone. To stop a bot, open its chat and press Stop.");
    expect(resultLine([{ threadId: "t-finch", requestId: "a", result: "approved" }, { threadId: "t-kessler", requestId: "b", result: "skipped", reason: "not-open" }], name))
      .toBe("Approved 1. 1 was not approved because Kessler had stopped waiting. It is still in your Inbox.");
    expect(resultLine([{ threadId: "t-finch", requestId: "a", result: "approved" }, { threadId: "t-finch", requestId: "b", result: "not-applied", reason: "batch-changed" }], name))
      .toContain("1 other request changed before you answered. It's still in your Inbox.");
  });
});

describe("the phone signs the exact ticked set once", () => {
  beforeEach(() => { native.calls = []; native.available = true; native.reply = { signature: "sig" }; });
  const eligible = [card("r1", "finch", "command"), card("r2", "kessler", "edit")];
  const preview: ApproveAllPreview = { batchId: "aab-" + "0".repeat(32), eligible, excluded: [], more: 0, deviceId: "dev-1" };
  beforeAll(async () => { for (const c of eligible) c.digest = await approvalDigest(c.threadId, c.requestId, c.card); });
  const pick = (...ids: string[]) => ids.map((id) => eligible.find((e) => e.requestId === id)!);
  const challengeFor = async (ids: string[]) => {
    const lines = await Promise.all(ids.map(async (id) => { const c = eligible.find((e) => e.requestId === id)!; return [c.threadId, c.requestId, await approvalDigest(c.threadId, c.requestId, c.card)] as const; }));
    return { v: 1, nonce: "n".repeat(43), digest: await approvalBatchDigest(preview.batchId!, "dev-1", lines), decision: "allow", expiresAt: Date.now() + 60_000 };
  };
  it("the desktop posts once with no proof", async () => {
    const post = vi.fn(async () => ({ approved: 2, results: [] }));
    await applyApproveAll(post, preview, pick("r1", "r2"), "x");
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]).toEqual([{ batchId: preview.batchId, requestIds: ["r1", "r2"] }]);
    expect(native.calls).toEqual([]);
  });
  it("signs once when its own digest over the ticked cards matches the challenge, as the reserved batch thread", async () => {
    const challenge = await challengeFor(["r2"]);
    const post = vi.fn(async (body: Record<string, unknown>) => {
      if (!body.freshAuth) throw Object.assign(new Error("x"), { status: 403, body: { code: "fresh_auth", challenge } });
      return { approved: 1, results: [] };
    });
    await applyApproveAll(post, preview, pick("r2"), batchReason(1, ["Kessler"]));
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][0]).toEqual({ batchId: preview.batchId, requestIds: ["r2"], freshAuth: { nonce: challenge.nonce, signature: "sig" } });
    expect(native.calls).toEqual([expect.objectContaining({ threadId: APPROVE_ALL_THREAD, requestId: preview.batchId, digest: challenge.digest, reason: "Approve 1 request from Kessler" })]);
  });
  it("refuses to sign a challenge over a different set than the one ticked", async () => {
    const challenge = await challengeFor(["r1", "r2"]);
    const post = vi.fn(async () => { throw Object.assign(new Error("x"), { status: 403, body: { code: "fresh_auth", challenge } }); });
    await expect(applyApproveAll(post, preview, pick("r2"), "x")).rejects.toMatchObject({ code: "changed" });
    expect(native.calls).toEqual([]);
  });
  it("H1: never signs a card whose body is not the one the server froze, or a card that is not the preview's own", async () => {
    const forged = { ...eligible[1], card: { ...eligible[1].card, subtitle: "rm -rf ~" } };
    const lines = [[forged.threadId, forged.requestId, await approvalDigest(forged.threadId, forged.requestId, forged.card)] as const];
    const challenge = { v: 1, nonce: "n".repeat(43), digest: await approvalBatchDigest(preview.batchId!, "dev-1", lines), decision: "allow", expiresAt: Date.now() + 60_000 };
    const post = vi.fn(async () => { throw Object.assign(new Error("x"), { status: 403, body: { code: "fresh_auth", challenge } }); });
    await expect(applyApproveAll(post, { ...preview, eligible: [eligible[0], forged] }, [forged], "x")).rejects.toMatchObject({ code: "changed" });
    await expect(applyApproveAll(post, preview, [forged], "x")).rejects.toMatchObject({ code: "changed" });
    expect(native.calls).toEqual([]);
  });
  it("a browser refusal is shown as answer on the computer, never retried", async () => {
    const post = vi.fn(async () => { throw Object.assign(new Error("x"), { status: 403, body: { code: "approve_on_computer" } }); });
    await expect(applyApproveAll(post, preview, pick("r1"), "x")).rejects.toMatchObject({ code: "computerOnly" });
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe("the button follows the server, never a client guess", () => {
  it("Inbox shows it on Approvals and on Needs you (Sean 11-06), and the component reads the server's owner-app answer", () => {
    const inbox = readFileSync(new URL("../components/Inbox.tsx", import.meta.url), "utf8");
    expect(inbox).toContain("const approveAllEligible = approveAllHint(view, shownRows);");
    expect(inbox).toMatch(/approveAllEligible !== null && <ApproveAllButton ready=\{approveAllReady\}/);
    // APPROVALS-SIMPLE-1018: the count is the rows on screen the server stamped ok (Astra r1 H4)
    const ok = { kind: "request", bulk: "ok" }, held = { kind: "request", bulk: "delete" };
    expect(lib.approveAllHint("decisions", [ok, ok, held])).toBe(2);
    expect(lib.approveAllHint("approvals", [ok, held])).toBe(1);
    expect(lib.approveAllHint("decisions", [])).toBe(0);
    for (const other of ["questions", "connections", "routines", "to-read", "results", "all"]) expect(lib.approveAllHint(other, [ok, ok])).toBeNull();
    const component = readFileSync(new URL("../components/ApproveAll.tsx", import.meta.url), "utf8");
    expect(component).toContain("if (!surface.show) return null;");
    expect(component).toContain('"/api/inbox/approve-all/surface"');
    expect(component).toMatch(/if \(!surface\.show/);
    expect(component).not.toMatch(/localStorage|isDesktopApp|nativeAvailable|userAgent/);
  });
});

describe("review fixes on 159ca90ca (H1, H2)", () => {
  const eligible: EligibleCard[] = [
    { threadId: "t-finch", requestId: "r1", botId: "finch", kindLine: "command", digest: "", card: { tool: "Bash", title: "Approval needed", subtitle: "npm run build", summary: "Build the site", held: "Murage checked this command" } },
    { threadId: "t-finch", requestId: "r2", botId: "finch", kindLine: "edit", digest: "", card: { tool: "Edit", title: "Approval needed", subtitle: "src/app.ts", summary: "Fix the header" } },
    { threadId: "t-kessler", requestId: "r3", botId: "kessler", kindLine: "app", digest: "", card: { tool: "mcp__notes__add", title: "Approval needed", subtitle: "Add a note", summary: "Add a note" } },
  ];
  const preview: ApproveAllPreview = { batchId: "aab-" + "1".repeat(32), eligible, excluded: [], more: 0, deviceId: "dev-1" };
  beforeAll(async () => { for (const c of eligible) c.digest = await approvalDigest(c.threadId, c.requestId, c.card); });
  const names: Record<string, string> = { finch: "Finch", kessler: "Kessler" };
  const sheet = (props: Record<string, unknown>) => {
    expect(view.ApproveAllSheet).toBeTypeOf("function");
    return renderToStaticMarkup(createElement(view.ApproveAllSheet as never, { preview, detailed: true, botName: (id?: string) => names[id ?? ""] ?? "A bot", botOf: () => undefined, busy: false, onCancel: () => {}, onApprove: () => {}, ...props }));
  };

  it("APPROVALS-SIMPLE-1018: the phone sheet lists every card it will sign by bot, in words and kind, never a command", () => {
    const html = sheet({});
    for (const text of ["Finch wants to run a command", "Finch wants to edit files", "Kessler wants to use a connected app", "Runs a command", "Edits files", "Uses a connected app"]) expect(html).toContain(text);
    for (const text of ["npm run build", "src/app.ts", "mcp__notes__add", "Bash"]) expect(html).not.toContain(text);
  });

  it("H1: the phone signs exactly the ids and hashes the sheet shows", async () => {
    const html = sheet({});
    const shown = [...html.matchAll(/data-request-id="([^"]+)" data-digest="([0-9a-f]{64})"/g)].map((m) => [m[1], m[2]]);
    expect(shown).toEqual(eligible.map((c) => [c.requestId, c.digest]));
    native.calls = []; native.available = true; native.reply = { signature: "sig" };
    const lines = eligible.map((c) => [c.threadId, c.requestId, c.digest] as const);
    const challenge = { v: 1, nonce: "n".repeat(43), digest: await approvalBatchDigest(preview.batchId!, "dev-1", lines), decision: "allow", expiresAt: Date.now() + 60_000 };
    const post = vi.fn(async (body: Record<string, unknown>) => {
      if (!body.freshAuth) throw Object.assign(new Error("x"), { status: 403, body: { code: "fresh_auth", challenge } });
      return { approved: 3, results: [] };
    });
    await applyApproveAll(post, preview, lib.tickedCards ? lib.tickedCards(eligible, new Set()) : (eligible as never), "x");
    expect(post.mock.calls[0][0]).toEqual({ batchId: preview.batchId, requestIds: shown.map(([id]) => id) });
    expect(native.calls).toEqual([expect.objectContaining({ digest: challenge.digest })]);
  });

  it("H2: the ticks are locked while a sign is in flight", () => {
    const open = sheet({ busy: false });
    const locked = sheet({ busy: true });
    const boxes = (html: string) => html.match(/<input type="checkbox"[^>]*>/g) ?? [];
    expect(boxes(open)).toHaveLength(2);
    expect(boxes(open).every((tag) => !/disabled/.test(tag))).toBe(true);
    expect(boxes(locked)).toHaveLength(2);
    expect(boxes(locked).every((tag) => /disabled=""/.test(tag))).toBe(true);
  });

  it("H2: a preview that lands after a sign started, or after a newer one, is ignored and never replaces the list", () => {
    expect(lib.previewGate).toBeTypeOf("function");
    const gate = lib.previewGate();
    const first = gate.begin();
    expect(first).not.toBeNull();
    expect(gate.begin()).toBeNull(); // a second Continue while loading is a no-op
    expect(gate.accepts(first!)).toBe(true);
    expect(gate.sign()).toBe(true);
    expect(gate.begin()).toBeNull(); // no new preview while signing
    expect(gate.sign()).toBe(false); // and no second sign
    gate.done();
    const late = gate.begin()!;
    gate.done(); // a sign started and ended before this preview landed
    expect(gate.accepts(late)).toBe(false);
    const again = gate.begin()!;
    expect(gate.sign()).toBe(false); // nothing to sign while a preview is still loading
    expect(gate.accepts(again)).toBe(true);
    const component = readFileSync(new URL("../components/ApproveAll.tsx", import.meta.url), "utf8");
    expect(component).toMatch(/if \(!gate\.accepts\(ticket\) \|\| !live\.current\.mounted\) return;/);
    expect(component).toMatch(/if \(!gate\.sign\(\)\) return;/);
  });
});

describe("Opus r2 High: Got it approves exactly the rows seen at the click (designs/APPROVALS-SIMPLE-1018-gotit-design.md)", () => {
  // gen = Refresh presses | list moves (monotonic) | id-set token
  const seen = { gen: "0|0|a\nb", ready: ["a", "b"] };
  const deferred = () => { let done = () => {}; let fail = (_e: Error) => {}; const wait = new Promise<void>((ok, no) => { done = ok; fail = no; }); return { wait, done, fail }; };
  const liveOf = () => ({ ...seen, ready: [...seen.ready], mounted: true, interaction: 1 });

  it("a list that moves during the Don't show again save applies nothing and says the list changed", async () => {
    expect(view.continueFromCaution).toBeTypeOf("function");
    const live = liveOf();
    const press = view.pressSnapshot(live, 1);
    const save = deferred();
    const verdict = view.continueFromCaution(press, () => save.wait, () => live);
    // a third ready row arrives while the save is out (the 5 s beat): the live list moves
    live.gen = "0|1|a\nb\nc"; live.ready.push("c");
    save.done();
    expect(await verdict).toBe("changed");
    // the snapshot is a copy taken at the click: it never follows the live rows
    expect(press.ready).toEqual(["a", "b"]);
  });

  it("the same list after the save runs, with the snapshot it took at the click", async () => {
    const live = liveOf();
    expect(await view.continueFromCaution(view.pressSnapshot(live, 1), async () => undefined, () => live)).toBe("run");
    expect(await view.continueFromCaution(view.pressSnapshot(live, 1), null, () => live)).toBe("run");
  });

  it("a failed save is swallowed, and a moved list still applies nothing", async () => {
    const live = liveOf();
    const press = view.pressSnapshot(live, 1);
    const save = deferred();
    const verdict = view.continueFromCaution(press, () => save.wait, () => live);
    live.gen = "1|0|a\nb"; // a Refresh during the save
    save.fail(new Error("offline"));
    expect(await verdict).toBe("changed");
    const still = liveOf();
    expect(await view.continueFromCaution(view.pressSnapshot(still, 1), () => Promise.reject(new Error("offline")), () => still)).toBe("run");
  });

  it("a list that moves away and back (A->B->A) during the save is still a change (Astra)", async () => {
    const live = liveOf();
    const press = view.pressSnapshot(live, 1);
    const save = deferred();
    const verdict = view.continueFromCaution(press, () => save.wait, () => live);
    live.gen = "0|2|a\nb"; // the same rows again, after two moves
    save.done();
    expect(await verdict).toBe("changed");
  });

  it("a stamp that flips on the same rows counts as a change; a left tab or a newer action does nothing", async () => {
    const live = liveOf();
    const press = view.pressSnapshot(live, 1);
    live.ready = ["a"]; // b is no longer ok, the id set (gen) is unchanged
    expect(view.stillPressed(press, live)).toBe(false);
    expect(await view.continueFromCaution(press, null, () => live)).toBe("changed");
    expect(await view.continueFromCaution(press, null, () => ({ ...liveOf(), mounted: false }))).toBe("gone");
    // Review them first, Cancel or a newer press moved the interaction on: the old save never runs (Astra)
    expect(await view.continueFromCaution(press, null, () => ({ ...liveOf(), interaction: 2 }))).toBe("gone");
  });

  it("a caution save that never settles counts as failed after the bound, and the checks still run (Opus r3 Low)", async () => {
    vi.useFakeTimers();
    try {
      expect(view.CAUTION_SAVE_TIMEOUT_MS).toBe(10_000);
      const live = liveOf();
      const never = () => new Promise<void>(() => {});
      let settled: string | null = null;
      const verdict = view.continueFromCaution(view.pressSnapshot(live, 1), never, () => live).then((v) => { settled = v; return v; });
      await vi.advanceTimersByTimeAsync(view.CAUTION_SAVE_TIMEOUT_MS - 1);
      expect(settled).toBeNull(); // still "Approving..." inside the bound
      await vi.advanceTimersByTimeAsync(1);
      expect(await verdict).toBe("run");
      // a list that moved while the save hung still applies nothing
      const moved = liveOf();
      const pending = view.continueFromCaution(view.pressSnapshot(moved, 1), never, () => moved);
      moved.gen = "0|1|a\nb\nc";
      await vi.advanceTimersByTimeAsync(view.CAUTION_SAVE_TIMEOUT_MS);
      expect(await pending).toBe("changed");
      // a save that settles first leaves no timer behind
      await view.continueFromCaution(view.pressSnapshot(liveOf(), 1), async () => undefined, liveOf);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("a failed preview goes back to idle only for the press that is still current (Opus r3 Low, symmetry)", () => {
    const component = readFileSync(new URL("../components/ApproveAll.tsx", import.meta.url), "utf8");
    const caught = component.slice(component.indexOf("} catch (e) {", component.indexOf("const run = ")), component.indexOf("// Dropped when the list moved"));
    expect(caught).toMatch(/if \(!gate\.accepts\(ticket\) \|\| !live\.current\.mounted \|\| interaction\.current !== press\.id\) return;\s*setError/);
  });

  it("the component snapshots at the click before any await, binds to the snapshot, re-checks before every post, and the note keeps the button", () => {
    const component = readFileSync(new URL("../components/ApproveAll.tsx", import.meta.url), "utf8");
    const gotIt = component.slice(component.indexOf("const gotIt = "), component.indexOf("const press = "));
    expect(gotIt.indexOf("pressSnapshot(live.current")).toBeGreaterThan(-1);
    expect(gotIt.indexOf("pressSnapshot(live.current")).toBeLessThan(gotIt.indexOf("await "));
    expect(gotIt).toMatch(/if \(stepNow\.current\.at !== "caution"\) return;/);
    expect(component).toMatch(/boundToScreen\(preview, press\.ready\)/);
    expect(component).not.toMatch(/boundToScreen\(preview, live\.current\.ready\)/);
    // every apply post and the phone's signed retry
    expect(component).toMatch(/\(body\) => \{\s*\/\/[^\n]*\n\s*if \(!stillPressed\(press, live\.current\)\)/);
    // "The list changed" is never a dead end: the note step keeps an enabled Approve all
    expect(component).toMatch(/\(step\.at === "idle" \|\| step\.at === "note"\) && n >= 2 && <button/);
  });
});

describe("the preview reads the page on screen (APPROVALS-SIMPLE Medium, RESIDUALS-1018-B row 6)", () => {
  // Needs you page 2+, or Show snoozed with a snoozed ok row: a preview of Approvals page 0 never listed them, so every
  // press said "The list changed". The press now carries the screen's own query and the preview reads that page.
  const screen = { view: "decisions", query: "", page: 2, pageSize: 25, includeSnoozed: true, after: "cur-2" };

  it("the press snapshot keeps a copy of the screen it was made over, and the preview body sends it", () => {
    expect(lib.previewBody).toBeTypeOf("function");
    const live = { gen: "0|0|a\nb", ready: ["a", "b"], screen: { ...screen } };
    const press = view.pressSnapshot(live, 1);
    expect(press.screen).toEqual(screen);
    live.screen.page = 3; // a later page turn never rewrites the press
    expect(press.screen?.page).toBe(2);
    expect(JSON.parse(lib.previewBody(press.screen))).toEqual({ screen });
    // a press with no screen (an older caller) still posts the empty body the server reads as Approvals page 0
    expect(lib.previewBody(undefined)).toBe("{}");
  });

  it("Inbox hands the button its own list query, and the preview posts the press's screen", () => {
    const component = readFileSync(new URL("../components/ApproveAll.tsx", import.meta.url), "utf8");
    const inbox = readFileSync(new URL("../components/Inbox.tsx", import.meta.url), "utf8");
    expect(component).toMatch(/api\("\/api\/inbox\/approve-all\/preview", \{ method: "POST", body: previewBody\(press\.screen\) \}\)/);
    expect(inbox).toMatch(/<ApproveAllButton [^>]*screen=\{approveAllScreen\}/);
    expect(inbox.indexOf("const approveAllAfter")).toBeGreaterThan(-1);
    const built = inbox.slice(inbox.indexOf("const approveAllAfter"), inbox.indexOf("const approveAllScreen") + 200);
    for (const field of ["view", "query", "page", "pageSize: 25", "includeSnoozed", "cursors[page]"]) expect(built, field).toContain(field);
  });
});
