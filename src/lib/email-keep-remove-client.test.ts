// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// secret-scan: fixture (fake addresses and fake tokens)
// 1.0.19 Settings email Keep/Remove: the wire. Exact URL, method and JSON body per action against the contracted owner routes, the
// server-sent path validation, and the strict view parser.
import { describe, expect, it } from "vitest";
import {
  UnsupportedViewError, canAct, createHttpEmailKeepRemoveClient, fallbackPath, hasRejectedPath, homeLines, keptAddresses, parseView, requestFor,
  validEmailPath, type EmailRow,
} from "./email-keep-remove-client";
import { CONTRACT_ACTION_SUCCESS, CONTRACT_HOME_VIEW, CONTRACT_REFUSAL, SERVER_LINE, createFakeServer, type FakeSeed } from "./email-keep-remove.testkit";

async function rowsOf(seed: FakeSeed) {
  const server = createFakeServer(seed);
  const client = createHttpEmailKeepRemoveClient(server.call);
  const view = await client.view();
  return { server, client, view, row: (id: string) => view.rows.find((r) => r.id === id)! };
}
/** A row as parseView reads it, for building wire cases by hand. */
const rowBody = (over: Record<string, unknown> = {}) => ({ rowId: "r1", section: "parked", botId: "p1", inboxId: null, keyIds: [], threadId: "email-owner", target: null, address: "x@example.test", botName: null, line: "", actions: [{ kind: "keep", tokenId: "v1.1.a", enabled: true, path: "/api/email/parked/p1/keep" }], ...over });
const oneRow = (over: Record<string, unknown> = {}): EmailRow => parseView({ rows: [rowBody(over)] }).rows[0]!;

describe("the wire of each action", () => {
  it("view: GET /api/email/status, nothing else", async () => {
    const { server } = await rowsOf({ rows: [{ section: "bot", botId: "b1" }] });
    expect(server.calls).toEqual([{ path: "/api/email/status", method: "GET", body: undefined, raw: undefined }]);
  });
  it("every action POSTs to its own action.path", async () => {
    const { server, client, row } = await rowsOf({ rows: [
      { section: "bot", botId: "b1" }, { section: "parked", botId: "p1" }, { section: "other_setup", inboxId: "ib-9" }, { section: "key_only", botId: "kb", keyId: "k1" },
      { section: "restore_check", rowId: "rc" }, { section: "removing", botId: "rm" },
    ] });
    await client.act(row("bot:b1"), "remove");
    await client.act(row("parked:p1"), "keep");
    await client.act(row("other_setup:ib-9"), "remove");
    await client.act(row("key_only:k1"), "keep");
    await client.act(row("rc"), "confirm_inventory");
    await client.act(row("removing:rm"), "try_again_now");
    expect(server.posts().map((p) => [p.method, p.path])).toEqual([
      ["POST", "/api/email/bots/b1/remove"], ["POST", "/api/email/parked/p1/keep"], ["POST", "/api/email/other-setups/ib-9/remove"],
      ["POST", "/api/email/bots/kb/keep"], ["POST", "/api/email/restore/confirm-inventory"], ["POST", "/api/email/bots/rm/try-again"],
    ]);
  });
  it("parked rows use the parked family for Keep and Remove", async () => {
    const { server, client, row } = await rowsOf({ rows: [{ section: "parked", botId: "p1" }] });
    await client.act(row("parked:p1"), "remove");
    expect(server.posts()[0]!.path).toBe("/api/email/parked/p1/remove");
  });
  it("the body is {token} (omitted when tokenId is null) plus {target} when the row has one: all four combinations", () => {
    const action = (tokenId: string | null) => [{ kind: "keep", tokenId, enabled: true, path: "/api/email/parked/p1/keep" }];
    const body = (tokenId: string | null, target: string | null) => requestFor(oneRow({ target, actions: action(tokenId) }), "keep")!.body;
    expect(body("v1.1.a", "park:p1")).toEqual({ token: "v1.1.a", target: "park:p1" });
    expect(body("v1.1.a", null)).toEqual({ token: "v1.1.a" });
    expect(body(null, "park:p1")).toEqual({ target: "park:p1" });
    expect(body(null, null)).toEqual({});
    expect(JSON.stringify(body(null, null))).toBe("{}");
    expect("token" in body(null, "park:p1")).toBe(false);
    expect("confirm" in body("v1.1.a", "park:p1")).toBe(false);
  });
  it("a bot-row Keep sends exactly what its tokenId and target say: no forced empty body", async () => {
    const { server, client, row } = await rowsOf({ rows: [{ section: "bot", botId: "b1", target: "bot:b1", actions: [{ kind: "keep", token: true }] }] });
    const token = row("bot:b1").actions[0]!.tokenId;
    expect(token).toMatch(/^v1\.\d+\./);
    await client.act(row("bot:b1"), "keep");
    expect(server.posts()[0]!.body).toEqual({ token, target: "bot:b1" });
  });
  it("Keep follows the server's enabled: a bot-row Keep with tokenId null and enabled true is clickable and sends no token", async () => {
    const { server, client, row } = await rowsOf({ rows: [{ section: "bot", botId: "b1", target: "bot:b1", actions: [{ kind: "keep", token: false, enabled: true }] }] });
    expect(row("bot:b1").actions[0]).toMatchObject({ kind: "keep", tokenId: null, enabled: true });
    expect(canAct(row("bot:b1"), "keep")).toBe(true);
    expect(await client.act(row("bot:b1"), "keep")).toMatchObject({ ok: true });
    expect(server.posts()[0]!.body).toEqual({ target: "bot:b1" });
    expect("token" in (server.posts()[0]!.body as object)).toBe(false);
  });
  it("a tokenless bot-row Keep with no target posts exactly {}; one the server disabled is not possible", async () => {
    const { server, client, row } = await rowsOf({ rows: [{ section: "bot", botId: "b1", actions: [{ kind: "keep", token: false }] }, { section: "bot", botId: "b2", actions: [{ kind: "keep", token: false, enabled: false }] }] });
    expect(canAct(row("bot:b2"), "keep")).toBe(false);
    await client.act(row("bot:b1"), "keep");
    expect(server.posts()[0]!.raw).toBe("{}");
  });
  it("orphan (parked) and key_only Keeps carry their token as sent", async () => {
    const { server, client, row } = await rowsOf({ rows: [{ section: "parked", botId: "p1", target: "park:p1" }, { section: "key_only", botId: "kb", keyId: "k1", target: "key:k1" }] });
    const tokens = [row("parked:p1"), row("key_only:k1")].map((r) => r.actions.find((a) => a.kind === "keep")!.tokenId);
    await client.act(row("parked:p1"), "keep");
    await client.act(row("key_only:k1"), "keep");
    expect(server.posts().map((p) => p.body)).toEqual([{ token: tokens[0], target: "park:p1" }, { token: tokens[1], target: "key:k1" }]);
  });
  it("a removing row offers only what the server sends: no keep or remove is possible, try_again_now with its path works", async () => {
    const { server, client, row } = await rowsOf({ rows: [{ section: "removing", botId: "rm", actions: [{ kind: "try_again_now", token: true, enabled: true }] }] });
    const removing = row("removing:rm");
    expect(removing.actions.map((a) => a.kind)).toEqual(["try_again_now"]);
    expect(canAct(removing, "keep")).toBe(false);
    expect(canAct(removing, "remove")).toBe(false);
    expect(canAct(removing, "try_again_now")).toBe(true);
    await client.act(removing, "try_again_now");
    expect(server.posts().map((p) => p.path)).toEqual(["/api/email/bots/rm/try-again"]);
  });
  it("a key_only Keep and Remove carry the row's target", async () => {
    const { server, client, row } = await rowsOf({ rows: [{ section: "key_only", botId: "kb", keyId: "k1", target: "key:k1" }] });
    const token = row("key_only:k1").actions.find((a) => a.kind === "remove")!.tokenId;
    await client.act(row("key_only:k1"), "remove");
    expect(server.posts()[0]).toMatchObject({ path: "/api/email/bots/kb/remove", body: { token, target: "key:k1" } });
  });
  it("target is opaque: it is sent back as given and never parsed", async () => {
    const target = "any:thing/with?odd&chars=1";
    expect(requestFor(oneRow({ target }), "keep")!.body).toEqual({ token: "v1.1.a", target });
  });
  it("a Remove with a null tokenId is never sent: no button, no call", async () => {
    const { server, client, row } = await rowsOf({ rows: [{ section: "bot", botId: "b1", actions: [{ kind: "remove", token: false }] }, { section: "parked", botId: "p1", actions: [{ kind: "remove", token: false }] }] });
    expect(canAct(row("bot:b1"), "remove")).toBe(false);
    expect(await client.act(row("bot:b1"), "remove")).toMatchObject({ ok: false, code: "unsupported_route" });
    expect(await client.act(row("parked:p1"), "remove")).toMatchObject({ ok: false });
    expect(server.posts()).toHaveLength(0);
  });
  it("a disabled action, or one the row does not offer, is not possible", async () => {
    const { row } = await rowsOf({ rows: [{ section: "parked", botId: "p1", actions: [{ kind: "keep", token: true, enabled: false }] }] });
    expect(canAct(row("parked:p1"), "keep")).toBe(false);
    expect(canAct(row("parked:p1"), "remove")).toBe(false);
  });
});

describe("a server-sent path is validated before it is used", () => {
  it("accepts every contracted template", () => {
    expect(validEmailPath("/api/email/bots/b1/keep", "keep")).toBe(true);
    expect(validEmailPath("/api/email/parked/p-1_x/keep", "keep")).toBe(true);
    expect(validEmailPath("/api/email/bots/b1/remove", "remove")).toBe(true);
    expect(validEmailPath("/api/email/parked/b1/remove", "remove")).toBe(true);
    expect(validEmailPath("/api/email/other-setups/in_9/remove", "remove")).toBe(true);
    expect(validEmailPath("/api/email/bots/b1/try-again", "try_again_now")).toBe(true);
    expect(validEmailPath("/api/email/restore/confirm-inventory", "confirm_inventory")).toBe(true);
    expect(validEmailPath(`/api/email/bots/${"a".repeat(160)}/keep`, "keep")).toBe(true);
  });
  it.each([
    ["an absolute URL with a scheme", "https://evil.example/api/email/bots/b1/keep"],
    ["a protocol-relative host", "//evil.example/api/email/bots/b1/keep"],
    ["a doubled slash", "/api/email//bots/b1/keep"],
    ["not under /api/email/", "/api/other/bots/b1/keep"],
    ["no leading slash", "api/email/bots/b1/keep"],
    ["dot-dot", "/api/email/bots/../bots/b1/keep"],
    ["a backslash", "/api/email/bots\\b1/keep"],
    ["a query", "/api/email/bots/b1/keep?x=1"],
    ["a fragment", "/api/email/bots/b1/keep#x"],
    ["an encoded dot", "/api/email/bots/%2e%2e/keep"],
    ["an upper-case encoded dot", "/api/email/bots/b%2E1/keep"],
    ["an encoded slash", "/api/email/bots/b1%2Fx/keep"],
    ["a lower-case encoded slash", "/api/email/bots/b1%2fx/keep"],
    ["an id of 161 characters", `/api/email/bots/${"a".repeat(161)}/keep`],
    ["an id with a dot", "/api/email/bots/b.1/keep"],
    ["an id with a percent", "/api/email/bots/b%31/keep"],
    ["an empty id", "/api/email/bots//keep"],
    ["a trailing newline", "/api/email/bots/b1/keep\n"],
    ["a space", "/api/email/bots/b 1/keep"],
    ["a template that is not contracted", "/api/email/bots/b1/delete"],
    ["the wrong route for the action's kind", "/api/email/bots/b1/remove"],
    ["a trailing slash", "/api/email/bots/b1/keep/"],
    ["an extra segment", "/api/email/bots/b1/x/keep"],
    ["a non-string", 42],
  ])("rejects %s", (_name, path) => {
    expect(validEmailPath(path, "keep")).toBe(false);
  });
  it("an other-setups route is only for Remove; parked and other-setups are not for try-again", () => {
    expect(validEmailPath("/api/email/other-setups/in_9/keep", "keep")).toBe(false);
    expect(validEmailPath("/api/email/parked/b1/try-again", "try_again_now")).toBe(false);
    expect(validEmailPath("/api/email/restore/confirm-inventory", "keep")).toBe(false);
  });
  it("a rejected path disables the action, makes no request, and does NOT fall back to the section route", async () => {
    for (const path of ["https://evil.example/x", "/api/email/bots/b.1/keep", "", "/api/email/bots/b1/keep?x=1"]) {
      const row = oneRow({ actions: [{ kind: "keep", tokenId: "v1.1.a", enabled: true, path }] });
      expect(row.actions[0]).toMatchObject({ pathState: "rejected", path: null });
      expect(hasRejectedPath(row)).toBe(true);
      expect(canAct(row, "keep")).toBe(false);
      const server = createFakeServer({});
      expect(await createHttpEmailKeepRemoveClient(server.call).act(row, "keep")).toMatchObject({ ok: false, code: "unsupported_route" });
      expect(server.calls).toHaveLength(0);
    }
  });
  it("a path of the wrong type (not a string) is rejected too", () => {
    expect(oneRow({ actions: [{ kind: "keep", tokenId: "t", enabled: true, path: 7 }] }).actions[0]!.pathState).toBe("rejected");
    expect(oneRow({ actions: [{ kind: "keep", tokenId: "t", enabled: true, path: { x: 1 } }] }).actions[0]!.pathState).toBe("rejected");
  });
  it("no path at all uses the section fallback, by section and never by which ids are present", () => {
    const noPath = (section: string, ids: Record<string, unknown>, kind: string) => oneRow({ section, ...ids, actions: [{ kind, tokenId: "v1.1.a", enabled: true }] });
    expect(requestFor(noPath("bot", { botId: "b1" }, "remove"), "remove")!.path).toBe("/api/email/bots/b1/remove");
    expect(requestFor(noPath("parked", { botId: "p1" }, "keep"), "keep")!.path).toBe("/api/email/parked/p1/keep");
    expect(requestFor(noPath("key_only", { botId: "kb" }, "keep"), "keep")!.path).toBe("/api/email/bots/kb/keep");
    expect(requestFor(noPath("removing", { botId: "rm" }, "try_again_now"), "try_again_now")!.path).toBe("/api/email/bots/rm/try-again");
    expect(requestFor(noPath("restore_check", { botId: null }, "confirm_inventory"), "confirm_inventory")!.path).toBe("/api/email/restore/confirm-inventory");
    // an other_setup row that carries BOTH ids still goes by its inbox
    expect(requestFor(noPath("other_setup", { botId: "b-also", inboxId: "ib-9" }, "remove"), "remove")!.path).toBe("/api/email/other-setups/ib-9/remove");
  });
  it("no path and no valid fallback: disabled", () => {
    const bare = (section: string, ids: Record<string, unknown>, kind: string) => oneRow({ section, ...ids, actions: [{ kind, tokenId: "v1.1.a", enabled: true }] });
    expect(canAct(bare("bot", { botId: null }, "remove"), "remove")).toBe(false);
    expect(canAct(bare("other_setup", { botId: "b1", inboxId: null }, "remove"), "remove")).toBe(false);
    expect(canAct(bare("home", { botId: "b1" }, "keep"), "keep")).toBe(false);
    expect(canAct(bare("kept", { botId: "b1" }, "confirm_inventory"), "confirm_inventory")).toBe(false);
    expect(canAct(bare("bot", { botId: "b.1" }, "remove"), "remove")).toBe(false);
    expect(fallbackPath(bare("other_setup", { inboxId: "i" }, "keep"), "keep")).toBeNull();
  });
});

describe("answers", () => {
  it("a success is the fresh home view, with fresh tokens", async () => {
    const { client, row } = await rowsOf({ rows: [{ section: "parked", botId: "p1" }, { section: "parked", botId: "p2", address: "two@example.test" }] });
    const old = row("parked:p2").actions[0]!.tokenId;
    const answer = await client.act(row("parked:p1"), "remove");
    if (!answer.ok || !answer.view) throw new Error("expected a view");
    expect(answer.view.rows.map((r) => r.id)).toEqual(["parked:p2"]);
    expect(answer.view.rows[0]!.actions[0]!.tokenId).not.toBe(old);
  });
  it("the contract's action success (rows: []) is a valid, complete, empty home view", async () => {
    const client = createHttpEmailKeepRemoveClient(async () => CONTRACT_ACTION_SUCCESS);
    expect(await client.act(oneRow(), "keep")).toEqual({ ok: true, view: { rows: [] }, body: CONTRACT_ACTION_SUCCESS });
  });
  it("an answer with no rows (the bot's own view) is ok with no view, so the screen reads the status again", async () => {
    const { client, row } = await rowsOf({ rows: [{ section: "bot", botId: "b1" }], answer: "bot" });
    expect(await client.act(row("bot:b1"), "remove")).toEqual({ ok: true, view: null, body: { botId: "b1", botName: "x", state: "active", address: null, chip: null, panelLine: null, failure: null, policy: "ask", policyPending: false, trusted: [], blocked: [], activity: [], waiting: 0, pauseReason: null } });
  });
  it("an answer whose rows are not readable is ok with no view, never an adopted empty view", async () => {
    const client = createHttpEmailKeepRemoveClient(async () => ({ rows: [{ section: "mystery", rowId: "x" }] }));
    expect(await client.act(oneRow(), "keep")).toEqual({ ok: true, view: null, body: { rows: [{ section: "mystery", rowId: "x" }] } });
  });
  it("a refusal carries status, code, rowId and the server's line untouched", async () => {
    const { client, row } = await rowsOf({ rows: [{ section: "parked", botId: "p1" }], refuse: { code: "keep_pending", error: SERVER_LINE, status: 409, rowId: "parked:p1" } });
    expect(await client.act(row("parked:p1"), "remove")).toEqual({ ok: false, status: 409, code: "keep_pending", error: SERVER_LINE, rowId: "parked:p1" });
  });
  it("an empty and a whitespace-only error are kept as strings; an absent one is null", async () => {
    for (const [error, want] of [["", ""], ["  \n ", "  \n "], [undefined, null]] as const) {
      const { client, row } = await rowsOf({ rows: [{ section: "parked", botId: "p1" }], refuse: { code: "weird", error } });
      expect(await client.act(row("parked:p1"), "keep")).toMatchObject({ ok: false, error: want });
    }
  });
  it("MurageCloud's refusal fixture is read by the contract: error is the line, rowId attaches it", async () => {
    const client = createHttpEmailKeepRemoveClient(async () => { throw Object.assign(new Error("x"), { status: 409, body: CONTRACT_REFUSAL }); });
    expect(await client.act(oneRow(), "keep")).toEqual({ ok: false, status: 409, code: "keep_pending", error: "A Keep is still finishing. Try again in a moment.", rowId: "parked:b2" });
  });
  it("`message` is never read: a body with only a message has no line and no code", async () => {
    const client = createHttpEmailKeepRemoveClient(async () => { throw Object.assign(new Error("x"), { status: 409, body: { message: "Not the line.", rowId: "parked:b2" } }); });
    expect(await client.act(oneRow(), "keep")).toEqual({ ok: false, status: 409, code: "unknown", error: null, rowId: "parked:b2" });
  });
  it("a failure with no body is an unknown refusal with no line", async () => {
    const client = createHttpEmailKeepRemoveClient(async () => { throw new TypeError("Failed to fetch"); });
    expect(await client.act(oneRow(), "keep")).toEqual({ ok: false, status: null, code: "unknown", error: null, rowId: null });
  });
});

describe("parseView", () => {
  it("reads MurageCloud's contract home view: rowId identity, lines verbatim, targets stored, validated paths", () => {
    const view = parseView(CONTRACT_HOME_VIEW);
    expect(view.rows.map((r) => r.id)).toEqual(["bot:b1", "parked:b2", "other_setup:in_9", "restore_check:home"]);
    expect(view.rows.map((r) => r.section)).toEqual(["bot", "parked", "other_setup", "restore_check"]);
    expect(view.rows[0]).toMatchObject({ botId: "b1", inboxId: "in_1", keyIds: ["k1"], target: "bot:b1", address: "ava@mail.example", botName: "Ava", line: "Ava has email at ava@mail.example." });
    expect(view.rows[1]!.actions.map((a) => [a.kind, a.tokenId, a.enabled, a.path, a.pathState])).toEqual([
      ["keep", "tok_p_2k", true, "/api/email/parked/b2/keep", "ok"], ["remove", "tok_p_2r", true, "/api/email/parked/b2/remove", "ok"],
    ]);
    expect(view.rows[3]!.actions[0]).toMatchObject({ kind: "confirm_inventory", path: "/api/email/restore/confirm-inventory" });
  });
  it("the contract fixture's actions send what the contract says", () => {
    const rows = parseView(CONTRACT_HOME_VIEW).rows;
    expect(requestFor(rows[0]!, "remove")).toEqual({ path: "/api/email/bots/b1/remove", body: { token: "tok_b_1", target: "bot:b1" } });
    expect(requestFor(rows[1]!, "keep")).toEqual({ path: "/api/email/parked/b2/keep", body: { token: "tok_p_2k", target: "park:p2" } });
    expect(requestFor(rows[2]!, "remove")).toEqual({ path: "/api/email/other-setups/in_9/remove", body: { token: "tok_f_9", target: "inbox:in_9" } });
    expect(requestFor(rows[3]!, "confirm_inventory")).toEqual({ path: "/api/email/restore/confirm-inventory", body: { token: "tok_r_1" } });
  });
  it("home rows give the home lines and kept rows give the kept addresses; try_again_now and confirm_inventory are action kinds", () => {
    const view = parseView({ rows: [
      rowBody({ rowId: "h", section: "home", botId: null, address: null, line: "A restore is finishing. Try again in a minute.", actions: [] }),
      rowBody({ rowId: "k1", section: "kept", botId: "b1", address: "a@example.test", actions: [] }),
      rowBody({ rowId: "k2", section: "kept", botId: "b2", address: null, actions: [] }),
      rowBody({ rowId: "k3", section: "kept", botId: "b3", address: "c@example.test", actions: [] }),
      rowBody({ rowId: "a", section: "removing", actions: [{ kind: "try_again_now", tokenId: null, enabled: true, path: "/api/email/bots/p1/try-again" }, { kind: "mystery", tokenId: null, enabled: true }] }),
    ] });
    expect(homeLines(view)).toEqual(["A restore is finishing. Try again in a minute."]);
    expect(keptAddresses(view)).toEqual(["a@example.test", "c@example.test"]);
    expect(view.rows[4]!.actions.map((a) => a.kind)).toEqual(["try_again_now"]);
  });
  it("a line is kept verbatim, whitespace and markup included", () => {
    expect(oneRow({ line: SERVER_LINE }).line).toBe(SERVER_LINE);
    expect(oneRow({ line: "" }).line).toBeNull();
  });
  it("there is no visible filter: every row the server sent is a row", () => {
    expect(parseView({ rows: [rowBody({ rowId: "a", visible: false })] }).rows).toHaveLength(1);
  });
  it("identity is the server's rowId: two rows with the same section and ids but different rowIds are both shown", () => {
    const view = parseView({ rows: [
      rowBody({ rowId: "ko1", section: "key_only", botId: "kb", keyIds: ["k1"] }), rowBody({ rowId: "ko2", section: "key_only", botId: "kb", keyIds: ["k2"] }),
      rowBody({ rowId: "x1", section: "parked", botId: "p1" }), rowBody({ rowId: "x2", section: "parked", botId: "p1" }),
    ] });
    expect(view.rows.map((r) => r.id)).toEqual(["ko1", "ko2", "x1", "x2"]);
  });
  it("a repeated rowId, or a row with no rowId, is an unsupported view (never silently collapsed)", () => {
    expect(() => parseView({ rows: [rowBody({ rowId: "dup" }), rowBody({ rowId: "dup" })] })).toThrow(UnsupportedViewError);
    expect(() => parseView({ rows: [rowBody({ rowId: undefined })] })).toThrow(UnsupportedViewError);
    expect(() => parseView({ rows: [rowBody({ rowId: "" })] })).toThrow(UnsupportedViewError);
  });
  it("unsupported shapes are errors, never an empty success", () => {
    for (const body of [null, undefined, "x", 3, [], {}, { rows: "no" }, { rows: {} }, { otherSetups: "no" }, { rows: [3] }, { rows: [{ rowId: "r", section: "mystery" }] }, { rows: [{ rowId: "r" }] }]) {
      expect(() => parseView(body)).toThrow(UnsupportedViewError);
    }
  });
  it("a valid empty rows array is a valid empty view", () => {
    expect(parseView({ rows: [] })).toEqual({ rows: [] });
  });
  it("the legacy otherSetups array is a fallback, read only when rows is absent", () => {
    const legacy = { otherSetups: [{ inboxId: "ib-1", address: "o@example.test", actions: [{ kind: "remove", tokenId: "v1.1.x", enabled: true }] }] };
    const view = parseView(legacy);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ section: "other_setup", inboxId: "ib-1", address: "o@example.test" });
    expect(requestFor(view.rows[0]!, "remove")).toEqual({ path: "/api/email/other-setups/ib-1/remove", body: { token: "v1.1.x" } });
    expect(parseView({ ...legacy, rows: [] }).rows).toEqual([]);
  });
});

describe("client.view", () => {
  it("throws UnsupportedViewError for an unreadable home view", async () => {
    await expect(createHttpEmailKeepRemoveClient(async () => ({ enabled: true })).view()).rejects.toBeInstanceOf(UnsupportedViewError);
  });
});

describe("an opaque target is echoed unchanged, empty string included (Astra P2)", () => {
  it("target \"\" is kept by the parser and sent in the body", () => {
    const row = oneRow({ target: "" });
    expect(row.target).toBe("");
    expect(requestFor(row, "keep")!.body).toEqual({ token: "v1.1.a", target: "" });
    expect(JSON.stringify(requestFor(row, "keep")!.body)).toBe('{"token":"v1.1.a","target":""}');
  });
  it("a missing or non-string target is still no target", () => {
    for (const target of [null, undefined, 3, {}, []]) expect(oneRow({ target }).target).toBeNull();
  });
});
