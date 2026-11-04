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
    expect(reasonLine("origin")).toBe("Started outside the app");
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
  it("Inbox shows it on Approvals only, and the component reads the server's owner-app answer", () => {
    const inbox = readFileSync(new URL("../components/Inbox.tsx", import.meta.url), "utf8");
    expect(inbox).toMatch(/view === "approvals" && <ApproveAllButton/);
    const component = readFileSync(new URL("../components/ApproveAll.tsx", import.meta.url), "utf8");
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

  it("H1: the phone sheet shows every card it will sign with its tool, subtitle, summary and held line", () => {
    const html = sheet({});
    for (const text of ["Bash", "npm run build", "Build the site", "Murage checked this command", "Edit", "src/app.ts", "Fix the header", "mcp__notes__add", "Add a note"]) expect(html).toContain(text);
    // summary equal to the subtitle is shown once, as InboxRequest does
    expect(html.split("Add a note").length - 1).toBe(1);
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
    expect(component).toMatch(/if \(gate\.accepts\(token\)\) setStep\(\{ at: "sheet"/);
    expect(component).toMatch(/if \(!gate\.sign\(\)\) return;/);
  });
});
