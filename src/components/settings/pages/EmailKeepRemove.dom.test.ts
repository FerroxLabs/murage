// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// secret-scan: fixture (fake addresses and fake tokens)
// 1.0.19 Settings email Keep/Remove screen over the real HTTP client, against a fake of the owner routes.
import { createElement as h, act, StrictMode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ACTION_UNAVAILABLE_LINE, LOOK_AGAIN_LINE, RECONFIRM_KEPT_LINE, RESTORE_FAILED_LINE, RESTORE_FINISHING_LINE, VIEW_LOAD_FAILED_LINE, VIEW_UNSUPPORTED_LINE } from "@/lib/email-keep-remove";
import { createHttpEmailKeepRemoveClient, parseView, type Call, type DecisionAnswer, type EmailKeepRemoveClient, type EmailKeepRemoveView } from "@/lib/email-keep-remove-client";
import { CONTRACT_HOME_VIEW, SERVER_LINE, createFakeServer, type FakeRow, type FakeSeed } from "@/lib/email-keep-remove.testkit";
import { cleanup, installDOMHarness, mount, settle } from "../../../testing/dom-harness";
import { EmailKeepRemoveSection } from "./EmailKeepRemove";

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(() => cleanup());

const bot = (over: Partial<FakeRow> = {}): FakeRow => ({ section: "bot", botId: "b1", botName: "Nova", address: "nova@example.test", ...over });
const orphan = (over: Partial<FakeRow> = {}): FakeRow => ({ section: "parked", botId: "p1", address: "old@example.test", ...over });

async function show(seed: FakeSeed, wrap?: (call: Call) => Call) {
  const server = createFakeServer(seed);
  const client = createHttpEmailKeepRemoveClient(wrap ? wrap(server.call) : server.call);
  const view = mount(h(EmailKeepRemoveSection, { client }));
  await settle(); await settle();
  return { server, view, root: view.container };
}
const button = (root: HTMLElement, label: string) => {
  const found = Array.from(root.querySelectorAll("button")).find((b) => b.getAttribute("aria-label") === label);
  if (!found) throw new Error(`no button ${label}`);
  return found as HTMLButtonElement;
};
async function click(el: HTMLElement) { await act(async () => { el.click(); }); await settle(); await settle(); }
const text = (root: HTMLElement) => root.textContent ?? "";
const note = (root: HTMLElement) => root.querySelector('[data-testid="email-row-note"]');
const notice = (root: HTMLElement) => root.querySelector('[data-testid="email-refusal-notice"]');

describe("nothing to show", () => {
  it("renders nothing for an empty view", async () => {
    const { root } = await show({});
    expect(root.innerHTML).toBe("");
  });
  // MAIN RULING 2026-11-13 R34: failed first read shows retry line (restore-park behaviour)
  it("a failed first read shows the retry line and a Reload email addresses button, not an empty screen", async () => {
    const view = mount(h(EmailKeepRemoveSection, { client: { view: () => Promise.reject(new TypeError("offline")), act: async (): Promise<DecisionAnswer> => ({ ok: false, status: null, code: "unknown", error: null, rowId: null }) } }));
    await settle(); await settle();
    expect(text(view.container)).toContain(VIEW_LOAD_FAILED_LINE);
    expect(button(view.container, "Reload email addresses").disabled).toBe(false);
  });
  it("renders nothing while the first read is pending, then shows a failed read with a working retry", async () => {
    const server = createFakeServer({ rows: [orphan()] });
    const fresh = createHttpEmailKeepRemoveClient(server.call);
    let reject!: (error: Error) => void;
    let reads = 0;
    const view = mount(h(EmailKeepRemoveSection, { client: { view: () => ++reads === 1 ? new Promise<EmailKeepRemoveView>((_, no) => { reject = no; }) : fresh.view(), act: fresh.act } }));
    await settle();
    expect(view.container.innerHTML).toBe("");
    await act(async () => { reject(new TypeError("offline")); });
    await settle(); await settle();
    expect(text(view.container)).toContain(VIEW_LOAD_FAILED_LINE);
    expect(view.container.querySelector("li")).toBeNull();
    await click(button(view.container, "Reload email addresses"));
    expect(reads).toBe(2);
    expect(text(view.container)).not.toContain(VIEW_LOAD_FAILED_LINE);
    expect(button(view.container, "Keep old@example.test").disabled).toBe(false);
    expect(server.posts()).toHaveLength(0);
  });
});

it("a failed refresh preserves disabled rows until Retry adopts a fresh view", async () => {
  const server = createFakeServer({ rows: [orphan()], refuse: { code: "keep_pending" } });
  const fresh = createHttpEmailKeepRemoveClient(server.call);
  let reads = 0;
  let release!: (view: EmailKeepRemoveView) => void;
  const client: EmailKeepRemoveClient = { act: fresh.act, view: () => {
    reads++;
    if (reads === 2) return Promise.reject(new TypeError("offline"));
    if (reads === 3) return new Promise(resolve => { release = resolve; });
    return fresh.view();
  } };
  const mounted = mount(h(EmailKeepRemoveSection, { client })); await settle(); await settle();
  await click(button(mounted.container, "Keep old@example.test"));
  expect(text(mounted.container)).toContain(VIEW_LOAD_FAILED_LINE);
  expect(button(mounted.container, "Keep old@example.test").disabled).toBe(true);
  await click(button(mounted.container, "Reload email addresses"));
  expect(button(mounted.container, "Reload email addresses").disabled).toBe(true);
  expect(button(mounted.container, "Keep old@example.test").disabled).toBe(true);
  await act(async () => { release(await fresh.view()); }); await settle();
  expect(text(mounted.container)).not.toContain(VIEW_LOAD_FAILED_LINE);
  expect(button(mounted.container, "Keep old@example.test").disabled).toBe(false);
  expect(server.posts()).toHaveLength(1);
});

describe("the server's lines are rendered verbatim, as text", () => {
  it("home rows and row lines carry the restore message; the client holds no restore logic", async () => {
    const { root } = await show({ rows: [{ section: "home", rowId: "h", line: RESTORE_FINISHING_LINE }, bot({ line: "Nova has email at nova@example.test." })] });
    expect(root.querySelector('[data-testid="email-home-line"]')?.textContent).toBe(RESTORE_FINISHING_LINE);
    expect(root.querySelector('[data-row-id="bot:b1"] [data-testid="email-row-line"]')?.textContent).toBe("Nova has email at nova@example.test.");
  });
  it("a row line with markup and spaces is one text node, byte for byte", async () => {
    const { root } = await show({ rows: [orphan({ line: SERVER_LINE })] });
    const line = root.querySelector('[data-testid="email-row-line"]');
    expect(line?.textContent).toBe(SERVER_LINE);
    expect(line?.childNodes.length).toBe(1);
    expect(root.querySelector("i")).toBeNull();
  });
  it("no home line, and no restore line, appears unless the server sent one", async () => {
    const { root } = await show({ rows: [bot()] });
    expect(text(root)).not.toContain(RESTORE_FINISHING_LINE);
    expect(text(root)).not.toContain(RESTORE_FAILED_LINE);
    expect(root.querySelector('[data-testid="email-home-line"]')).toBeNull();
  });
  it("MurageCloud's contract home view renders its rows, lines and the four sections", async () => {
    const client = createHttpEmailKeepRemoveClient(async () => CONTRACT_HOME_VIEW);
    const view = mount(h(EmailKeepRemoveSection, { client }));
    await settle(); await settle();
    const root = view.container;
    for (const line of ["Ava has email at ava@mail.example.", "This address came back with a restore. Keep it or remove it.", "old@mail.example is set up on another install.", "Check your email setup after the restore."]) expect(text(root)).toContain(line);
    expect(button(root, "Keep max@mail.example").disabled).toBe(false);
    expect(button(root, "Confirm inventory Restore check").disabled).toBe(false);
  });
});

describe("body.error is rendered exactly as the server gave it, for Keep and Remove", () => {
  for (const code of ["keep_pending", "bot_present", "inbox_gone", "removal_sending", "restore_failed", "some_new_code"]) {
    for (const action of ["Keep", "Remove"] as const) {
      it(`${code} / ${action}: the row note is the server line, byte for byte, as a text node`, async () => {
        const { root } = await show({ rows: [orphan()], refuse: { code, error: SERVER_LINE } });
        await click(button(root, `${action} old@example.test`));
        expect(note(root)?.textContent).toBe(SERVER_LINE);
        expect(note(root)?.childNodes.length).toBe(1);
        expect(note(root)?.firstChild?.nodeType).toBe(Node.TEXT_NODE);
        expect(root.querySelector("i")).toBeNull();
      });
    }
  }
  it("Astra 2: an open restore (the home row says so) plus a distinct server error shows the server error, for Keep and Remove", async () => {
    for (const action of ["Keep", "Remove"] as const) {
      const { root } = await show({ rows: [{ section: "home", rowId: "h", line: RESTORE_FINISHING_LINE }, orphan()], refuse: { code: "restore_failed", error: RESTORE_FAILED_LINE } });
      await click(button(root, `${action} old@example.test`));
      expect(note(root)?.textContent).toBe(RESTORE_FAILED_LINE);
      cleanup();
    }
  });
  it("a restore_finishing refusal shows the server's own words, whatever they are", async () => {
    for (const action of ["Keep", "Remove"] as const) {
      const { root } = await show({ rows: [orphan()], windowLine: "The server's own window line." });
      await click(button(root, `${action} old@example.test`));
      expect(note(root)?.textContent).toBe("The server's own window line.");
      cleanup();
    }
  });
  it("an empty error is shown as the empty string, not replaced by fallback copy; so is a whitespace-only one", async () => {
    for (const error of ["", "   "]) {
      const { root } = await show({ rows: [orphan()], refuse: { code: "keep_pending", error } });
      await click(button(root, "Remove old@example.test"));
      expect(note(root)).not.toBeNull();
      expect(note(root)?.textContent).toBe(error);
      cleanup();
    }
  });
  it("with no server string the code's own copy is used, and it says nothing changed", async () => {
    const { root } = await show({ rows: [orphan()], refuse: { code: "something_new" } });
    await click(button(root, "Remove old@example.test"));
    expect(note(root)?.textContent).toMatch(/Nothing changed/);
  });
});

describe("any refusal refreshes the view", () => {
  it("reads the status again and shows the row as the server now has it", async () => {
    const { root, server } = await show({ rows: [bot()], refuse: { code: "bot_present", error: SERVER_LINE, once: true, thenRows: [bot({ address: "nova-new@example.test" })] } });
    const views = server.viewCount();
    await click(button(root, "Keep nova@example.test"));
    expect(server.viewCount()).toBe(views + 1);
    expect(text(root)).toContain("nova-new@example.test");
  });
});

describe("Astra 3: a refusal survives a refresh that drops its row", () => {
  it("shows the exact server text in a section-level notice, then Dismiss clears it", async () => {
    const { root } = await show({ rows: [orphan(), orphan({ botId: "p2", address: "two@example.test" })], refuse: { code: "inbox_gone", error: SERVER_LINE, once: true, thenRows: [orphan({ botId: "p2", address: "two@example.test" })] } });
    await click(button(root, "Keep old@example.test"));
    expect(root.querySelector('[data-row-id="parked:p1"]')).toBeNull();
    expect(notice(root)?.textContent).toContain(SERVER_LINE);
    expect(notice(root)?.querySelector("span")?.textContent).toBe(SERVER_LINE);
    expect(note(root)).toBeNull();
    await click(Array.from(notice(root)!.querySelectorAll("button"))[0]!);
    expect(notice(root)).toBeNull();
  });
  it("is renderable when the refreshed view has no rows at all", async () => {
    const { root } = await show({ rows: [orphan()], refuse: { code: "inbox_gone", error: SERVER_LINE, once: true, thenRows: [] } });
    await click(button(root, "Keep old@example.test"));
    expect(notice(root)?.textContent).toContain(SERVER_LINE);
  });
  it("clears on the next decision", async () => {
    const { root } = await show({ rows: [orphan(), orphan({ botId: "p2", address: "two@example.test" })], refuse: { code: "inbox_gone", error: SERVER_LINE, once: true, thenRows: [orphan({ botId: "p2", address: "two@example.test" })] } });
    await click(button(root, "Keep old@example.test"));
    expect(notice(root)).not.toBeNull();
    await click(button(root, "Remove two@example.test"));
    expect(notice(root)).toBeNull();
  });
  it("a refusal that names a rowId attaches to that row; if the row is gone it is the section notice", async () => {
    const { root } = await show({ rows: [orphan(), orphan({ botId: "p2", address: "two@example.test" })], refuse: { code: "keep_pending", error: SERVER_LINE, rowId: "parked:p2" } });
    await click(button(root, "Remove old@example.test"));
    expect(root.querySelector('[data-row-id="parked:p2"] [data-testid="email-row-note"]')?.textContent).toBe(SERVER_LINE);
    expect(root.querySelector('[data-row-id="parked:p1"] [data-testid="email-row-note"]')).toBeNull();
    cleanup();
    const gone = await show({ rows: [orphan()], refuse: { code: "keep_pending", error: SERVER_LINE, rowId: "parked:elsewhere" } });
    await click(button(gone.root, "Remove old@example.test"));
    expect(note(gone.root)).toBeNull();
    expect(notice(gone.root)?.textContent).toContain(SERVER_LINE);
  });
});

describe("the look-again line is for the untokened bot-row Keep only", () => {
  it("a bot-row Keep (no token) refused confirm_expired with no server line shows it and refreshes", async () => {
    const { root, server } = await show({ rows: [bot()], bindingChanged: true });
    const views = server.viewCount();
    await click(button(root, "Keep nova@example.test"));
    expect(note(root)?.textContent).toBe(LOOK_AGAIN_LINE);
    expect(server.viewCount()).toBe(views + 1);
    expect(server.posts()).toHaveLength(1);
    expect(server.posts()[0]!.raw).toBe("{}");
  });
  it("clears when the owner chooses again", async () => {
    const { root } = await show({ rows: [bot()], bindingChanged: true });
    await click(button(root, "Keep nova@example.test"));
    await click(button(root, "Keep nova@example.test"));
    expect(text(root)).not.toContain(LOOK_AGAIN_LINE);
  });
  it("a Remove refused confirm_expired never shows it, nor does a tokened Keep (parked)", async () => {
    const a = await show({ rows: [bot()], refuse: { code: "confirm_expired", once: true } });
    await click(button(a.root, "Remove nova@example.test"));
    expect(text(a.root)).not.toContain(LOOK_AGAIN_LINE);
    expect(note(a.root)).not.toBeNull();
    cleanup();
    const b = await show({ rows: [orphan()], refuse: { code: "confirm_expired", once: true } });
    await click(button(b.root, "Keep old@example.test"));
    expect(text(b.root)).not.toContain(LOOK_AGAIN_LINE);
  });
});

describe("a Remove that ends skipped_in_use arrives as the row's server line", () => {
  it("the row stays and shows the server's reconfirm line verbatim; the client reads no key status", async () => {
    const { root } = await show({ rows: [bot({ inUse: true })] });
    expect(text(root)).not.toContain(RECONFIRM_KEPT_LINE);
    await click(button(root, "Remove nova@example.test"));
    expect(root.querySelector('[data-row-id="bot:b1"] [data-testid="email-row-line"]')?.textContent).toBe(RECONFIRM_KEPT_LINE);
    expect(note(root)).toBeNull();
  });
});

describe("tokens: only a view mints one, nothing is reused", () => {
  it("Remove is disabled when the row's tokenId is null, and nothing is sent", async () => {
    const { root, server } = await show({ rows: [bot({ actions: [{ kind: "remove", token: false }] }), orphan({ actions: [{ kind: "remove", token: false }] })] });
    expect(button(root, "Remove nova@example.test").disabled).toBe(true);
    expect(button(root, "Remove old@example.test").disabled).toBe(true);
    await click(button(root, "Remove nova@example.test"));
    expect(server.posts()).toHaveLength(0);
  });
  it("a disabled action stays disabled", async () => {
    const { root } = await show({ rows: [orphan({ actions: [{ kind: "keep", token: true, enabled: false }, { kind: "remove", token: true, enabled: false }] })] });
    expect(button(root, "Keep old@example.test").disabled).toBe(true);
    expect(button(root, "Remove old@example.test").disabled).toBe(true);
  });
  it("after a refusal the next choice carries the token of the new view, never the first one", async () => {
    const { root, server } = await show({ rows: [orphan()], refuse: { code: "keep_pending", error: SERVER_LINE, once: true } });
    await click(button(root, "Remove old@example.test"));
    await click(button(root, "Remove old@example.test"));
    const [first, second] = server.posts().map((c) => (c.body as { token: string }).token);
    expect(first).not.toBe(second);
    expect(server.issued.indexOf(second!)).toBeGreaterThan(server.issued.indexOf(first!));
    expect(server.posts()).toHaveLength(2);
    expect(root.querySelector('[data-row-id="parked:p1"]')).toBeNull();
  });
  it("after a success the screen holds the answer's view and its tokens", async () => {
    const { root, server } = await show({ rows: [orphan(), orphan({ botId: "p2", address: "two@example.test" })] });
    await click(button(root, "Remove old@example.test"));
    await click(button(root, "Remove two@example.test"));
    const posts = server.posts();
    expect(posts).toHaveLength(2);
    expect(posts[1]!.path).toBe("/api/email/parked/p2/remove");
    expect(root.querySelector('[data-row-id="parked:p2"]')).toBeNull();
  });
  it("an answer that is not a home view is followed by a status read", async () => {
    const { root, server } = await show({ rows: [orphan(), orphan({ botId: "p2", address: "two@example.test" })], answer: "bot" });
    const views = server.viewCount();
    await click(button(root, "Remove old@example.test"));
    expect(server.viewCount()).toBe(views + 1);
    await click(button(root, "Remove two@example.test"));
    expect(server.posts()).toHaveLength(2);
    expect(root.querySelector('[data-row-id="parked:p2"]')).toBeNull();
  });
});

describe("Astra 1: after every decision response nothing is actionable until a fresh view is adopted", () => {
  const failingReads = () => { const state = { failing: false }; return { state, wrap: (call: Call): Call => (path, init) => (state.failing && path === "/api/email/status" ? Promise.reject(new TypeError("offline")) : call(path, init)) }; };
  it("a refusal followed by a refresh failure: the old rows may stay, their actions are disabled, and a click sends no POST", async () => {
    const reads = failingReads();
    const { root, server } = await show({ rows: [orphan(), orphan({ botId: "p2", address: "two@example.test" })], refuse: { code: "keep_pending", error: SERVER_LINE, once: true } }, reads.wrap);
    reads.state.failing = true;
    await click(button(root, "Remove old@example.test"));
    expect(server.posts()).toHaveLength(1);
    expect(root.querySelector('[data-row-id="parked:p2"]')).not.toBeNull();
    for (const label of ["Keep old@example.test", "Remove old@example.test", "Keep two@example.test", "Remove two@example.test"]) expect(button(root, label).disabled).toBe(true);
    await click(button(root, "Remove two@example.test"));
    expect(server.posts()).toHaveLength(1);
    expect(note(root)?.textContent).toBe(SERVER_LINE);
  });
  it("a success with a bot-only view followed by a refresh failure: a further click sends no POST", async () => {
    const reads = failingReads();
    const { root, server } = await show({ rows: [orphan(), orphan({ botId: "p2", address: "two@example.test" })], answer: "bot" }, reads.wrap);
    reads.state.failing = true;
    await click(button(root, "Remove old@example.test"));
    expect(server.posts()).toHaveLength(1);
    expect(button(root, "Remove two@example.test").disabled).toBe(true);
    await click(button(root, "Remove two@example.test"));
    expect(server.posts()).toHaveLength(1);
  });
  it("a later successful read makes the fresh view actionable again, with fresh tokens", async () => {
    const reads = failingReads();
    const { root, server, view } = await show({ rows: [orphan(), orphan({ botId: "p2", address: "two@example.test" })], answer: "bot" }, reads.wrap);
    reads.state.failing = true;
    await click(button(root, "Remove old@example.test"));
    expect(button(root, "Remove two@example.test").disabled).toBe(true);
    reads.state.failing = false;
    const client = createHttpEmailKeepRemoveClient(reads.wrap(server.call));
    view.rerender(h(EmailKeepRemoveSection, { client }));
    await settle(); await settle();
    expect(button(root, "Remove two@example.test").disabled).toBe(false);
  });
});

describe("Astra 4: obsolete completions are ignored", () => {
  const body = (address: string, token: string) => ({ rows: [{ rowId: `parked:${address}`, section: "parked", botId: "p1", inboxId: null, keyIds: [], target: null, address, botName: null, line: "", actions: [
    { kind: "remove", tokenId: token, enabled: true, path: "/api/email/parked/p1/remove" }] }] });
  const idle: EmailKeepRemoveClient["act"] = async () => ({ ok: true, view: null, body: null });
  function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
  it("an older read that resolves last does not replace the newer view (effect replay under StrictMode)", async () => {
    const reads: Array<ReturnType<typeof deferred<EmailKeepRemoveView>>> = [];
    const client: EmailKeepRemoveClient = { view: () => { const d = deferred<EmailKeepRemoveView>(); reads.push(d); return d.promise; }, act: idle };
    const view = mount(h(StrictMode, null, h(EmailKeepRemoveSection, { client })));
    await settle();
    expect(reads.length).toBeGreaterThanOrEqual(2);
    const newest = reads.length - 1;
    reads[newest]!.resolve(parseView(body("new@example.test", "v1.2.new")));
    await settle();
    for (let i = 0; i < newest; i += 1) reads[i]!.resolve(parseView(body("old@example.test", "v1.1.old")));
    await settle(); await settle();
    expect(text(view.container)).toContain("new@example.test");
    expect(text(view.container)).not.toContain("old@example.test");
  });
  it("a read for a replaced client cannot overwrite the replacement client's view", async () => {
    const slow = deferred<EmailKeepRemoveView>();
    const first: EmailKeepRemoveClient = { view: () => slow.promise, act: idle };
    const second: EmailKeepRemoveClient = { view: async () => parseView(body("second@example.test", "v1.2.s")), act: idle };
    const view = mount(h(EmailKeepRemoveSection, { client: first }));
    await settle();
    view.rerender(h(EmailKeepRemoveSection, { client: second }));
    await settle(); await settle();
    slow.resolve(parseView(body("first@example.test", "v1.1.f")));
    await settle(); await settle();
    expect(text(view.container)).toContain("second@example.test");
    expect(text(view.container)).not.toContain("first@example.test");
  });
  it("a client change invalidates the current view: the old rows are gone before the new read lands", async () => {
    const first: EmailKeepRemoveClient = { view: async () => parseView(body("first@example.test", "v1.1.f")), act: idle };
    const pending = deferred<EmailKeepRemoveView>();
    const second: EmailKeepRemoveClient = { view: () => pending.promise, act: idle };
    const view = mount(h(EmailKeepRemoveSection, { client: first }));
    await settle(); await settle();
    expect(text(view.container)).toContain("first@example.test");
    view.rerender(h(EmailKeepRemoveSection, { client: second }));
    await settle();
    expect(text(view.container)).not.toContain("first@example.test");
  });
  it("a decision answered by a replaced client is ignored (its view and refusal never appear)", async () => {
    const answer = deferred<DecisionAnswer>();
    const first: EmailKeepRemoveClient = { view: async () => parseView(body("first@example.test", "v1.1.f")), act: () => answer.promise };
    const second: EmailKeepRemoveClient = { view: async () => parseView(body("second@example.test", "v1.2.s")), act: idle };
    const view = mount(h(EmailKeepRemoveSection, { client: first }));
    await settle(); await settle();
    await act(async () => { button(view.container, "Remove first@example.test").click(); });
    view.rerender(h(EmailKeepRemoveSection, { client: second }));
    await settle(); await settle();
    answer.resolve({ ok: true, view: parseView(body("stale@example.test", "v1.3.stale")), body: body("stale@example.test", "v1.3.stale") });
    await settle(); await settle();
    expect(text(view.container)).toContain("second@example.test");
    expect(text(view.container)).not.toContain("stale@example.test");
    expect(button(view.container, "Remove second@example.test").disabled).toBe(false);
  });
});

describe("unsupported shapes are an error state, never an empty success", () => {
  it("a home view that is not a rows view shows the error line, not nothing", async () => {
    const view = mount(h(EmailKeepRemoveSection, { client: createHttpEmailKeepRemoveClient(async () => ({ enabled: true, whatever: [] })) }));
    await settle(); await settle();
    expect(text(view.container)).toContain(VIEW_UNSUPPORTED_LINE);
  });
  it("a repeated rowId is an unsupported view", async () => {
    const dup = { rowId: "same", section: "parked", botId: "p1", actions: [] };
    const view = mount(h(EmailKeepRemoveSection, { client: createHttpEmailKeepRemoveClient(async () => ({ rows: [dup, dup] })) }));
    await settle(); await settle();
    expect(text(view.container)).toContain(VIEW_UNSUPPORTED_LINE);
    expect(view.container.querySelector("li")).toBeNull();
  });
});

describe("try_again_now, confirm_inventory and server paths", () => {
  it("both go to their routes through the action's path", async () => {
    const { root, server } = await show({ rows: [{ section: "removing", botId: "rm", address: "gone@example.test" }, { section: "restore_check", rowId: "rc", line: "Check it." }] });
    await click(button(root, "Try again now gone@example.test"));
    expect(server.posts()[0]).toMatchObject({ path: "/api/email/bots/rm/try-again" });
    await click(button(root, "Confirm inventory Restore check"));
    expect(server.posts()[1]).toMatchObject({ path: "/api/email/restore/confirm-inventory" });
  });
  it("with no path and no valid fallback they are disabled", async () => {
    const { root, server } = await show({ rows: [{ section: "key_only", keyId: "k1", address: "k@example.test", actions: [{ kind: "try_again_now", token: true, path: null }] }] });
    expect(button(root, "Try again now k@example.test").disabled).toBe(true);
    await click(button(root, "Try again now k@example.test"));
    expect(server.posts()).toHaveLength(0);
  });
  it("an action whose server path fails validation is disabled, says so on its row, and sends nothing", async () => {
    const { root, server } = await show({ rows: [orphan({ actions: [{ kind: "keep", token: true, path: "https://evil.example/api/email/parked/p1/keep" }, { kind: "remove", token: true }] })] });
    expect(button(root, "Keep old@example.test").disabled).toBe(true);
    expect(button(root, "Remove old@example.test").disabled).toBe(false);
    expect(root.querySelector('[data-row-id="parked:p1"] [data-testid="email-row-action-error"]')?.textContent).toBe(ACTION_UNAVAILABLE_LINE);
    await click(button(root, "Keep old@example.test"));
    expect(server.posts()).toHaveLength(0);
  });
});

describe("the restore result's kept addresses (kept rows)", () => {
  const kept = (n: number): FakeRow[] => Array.from({ length: n }, (_, i) => ({ section: "kept", botId: `kb${i + 1}`, address: `kept${i + 1}@example.test` }));
  for (const [n, more] of [[0, null], [1, null], [5, null], [6, "and 1 more"], [20, "and 15 more"]] as const) {
    it(`${n} addresses: ${more ?? "no more line"}`, async () => {
      const { root } = await show({ rows: [...kept(n), bot()] });
      const items = Array.from(root.querySelectorAll('[data-testid="email-kept"] li'));
      const shown = Math.min(n, 5);
      expect(items.length).toBe(shown + (more ? 1 : 0));
      expect(items.slice(0, shown).map((li) => li.textContent)).toEqual(kept(n).slice(0, 5).map((row) => row.address));
      if (more) expect(items[shown]!.textContent).toBe(more);
      else expect(text(root)).not.toMatch(/and \d+ more/);
      if (n === 0) expect(root.querySelector('[data-testid="email-kept"]')).toBeNull();
    });
  }
});

describe("addresses are text, never markup", () => {
  it("renders special characters literally in rows and the kept list", async () => {
    const nasty = `"><img src=x onerror=alert(1)>&amp;'<b>@example.test`;
    const { root } = await show({ rows: [orphan({ address: nasty }), bot({ botId: "b2", address: "<script>x</script>@example.test" }), { section: "kept", botId: "kk", address: nasty }] });
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("b")).toBeNull();
    expect(text(root)).toContain(nasty);
    expect(text(root)).toContain("<script>x</script>@example.test");
    const item = root.querySelector('[data-testid="email-kept"] li');
    expect(item?.childNodes.length).toBe(1);
    expect(item?.firstChild?.nodeType).toBe(Node.TEXT_NODE);
  });
});

describe("an address from another setup", () => {
  it("lists as an other_setup row with Remove only, and removes through its own route", async () => {
    const { root, server } = await show({ rows: [{ section: "other_setup", inboxId: "ib-9", botId: "also-a-bot", address: "elsewhere@example.test" }] });
    expect(Array.from(root.querySelectorAll("button")).map((b) => b.getAttribute("aria-label"))).toEqual(["Remove elsewhere@example.test"]);
    await click(button(root, "Remove elsewhere@example.test"));
    expect(server.posts()[0]!.path).toBe("/api/email/other-setups/ib-9/remove");
    expect(root.querySelector('[data-row-id="other_setup:ib-9"]')).toBeNull();
  });
});

describe("a kept row's own server line is shown (Astra finding 5)", () => {
  it("renders the line verbatim beside the address, as text, when it differs from the address", async () => {
    const { root } = await show({ rows: [{ section: "kept", botId: "kk", address: "k@example.test", line: SERVER_LINE }, bot()] });
    const item = root.querySelector('[data-testid="email-kept"] li');
    expect(item?.textContent).toContain("k@example.test");
    const line = item?.querySelector('[data-testid="email-kept-line"]');
    expect(line?.textContent).toBe(SERVER_LINE);
    expect(line?.childNodes.length).toBe(1);
    expect(root.querySelector("i")).toBeNull();
  });
  it("a kept row with a line and no address still shows its line; a kept row with neither shows nothing", async () => {
    const { root } = await show({ rows: [{ section: "kept", botId: "k1", address: null, line: "Kept after the restore." }, { section: "kept", botId: "k2", address: null }, bot()] });
    const items = Array.from(root.querySelectorAll('[data-testid="email-kept"] li'));
    expect(items.map((li) => li.textContent)).toEqual(["Kept after the restore."]);
  });
});
