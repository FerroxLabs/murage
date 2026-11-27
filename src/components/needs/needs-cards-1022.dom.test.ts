// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: q1022-cards (the Needs you door's list in src/components/Inbox.tsx and the row's Approve hand-off in
// src/components/InboxRequest.tsx InboxQuickAnswer). The respond route and the answer body are q1022-approvefix's;
// this file only checks that every answer goes out through the row's own Approve press, once.
// 1.0.22 MUST-FIX (GitHub #46, #48, #19): approval cards jump under the pointer while you click, so Approve lands on
// the wrong card; there is no "Approve all from <bot>"; an answered card must never be answered again.
//
// The real Inbox (door mode, Needs you) is rendered with its real rows, quick answers and respond hook; only the
// transport is a small in-memory server: the list, the live cards and the respond route, which records every answer
// and takes an answered card off the list. "Under the pointer" is the row's slot: the rows are one fixed-height
// column, so the Nth row is what sits under a pointer parked on the Nth slot.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; bot: string; at: number; bulk: string };
const server = vi.hoisted(() => ({
  rows: [] as Row[],
  answers: [] as Array<{ threadId: string; body: Record<string, unknown> }>,
  /** answered request ids the list still shows, as a stale read does */
  stale: new Set<string>(),
  /** the server's owner-app answer for the page's own Approve all */
  surface: false,
  /** while set, a respond is recorded at once but its reply waits for this (a slow answer) */
  gate: null as Promise<void> | null,
  /** rows whose live card read yields nothing yet (the read lands later) */
  noCard: new Set<string>(),
}));
vi.mock("@/lib/use-surface", async (original) => ({ ...(await original<Record<string, unknown>>()), useDesktopSurface: () => true }));
vi.mock("@/state/store", async (original) => {
  const real = await original<typeof import("@/state/store")>();
  const item = (row: Row) => ({
    id: `item-${row.id}`, version: "1", kind: "request", segment: "approval", status: "pending", decision: true, toRead: false,
    title: "Approval needed", summary: "", sourceLabel: `${row.bot} · Chat`, at: row.at, read: true, snoozedUntil: null, duplicates: 1,
    bulk: row.bulk, toolKind: "command", link: { threadId: `thread-${row.bot}`, messageId: `msg-${row.id}` },
  });
  const card = (row: Row) => ({ title: "Approval needed", subtitle: `ls ${row.id}`, options: ["Allow", "Deny"], requestId: `req-${row.id}`, tool: "Bash", lowRisk: true });
  const api = async (path: string, init?: RequestInit) => {
    await Promise.resolve();
    if (path.startsWith("/api/inbox?")) {
      const items = server.rows.map(item);
      return { items, total: items.length, unread: 0, decisions: items.length, questions: 0, page: 0, pageSize: 25 };
    }
    const messages = path.match(/^\/api\/threads\/([^/]+)\/messages\?around=msg-([^&]+)/);
    if (messages) {
      const row = server.rows.find(entry => entry.id === messages[2]);
      return { messages: row && !server.noCard.has(row.id) ? [{ id: `msg-${row.id}`, card: card(row) }] : [] };
    }
    const respond = path.match(/^\/api\/threads\/([^/]+)\/respond$/);
    if (respond) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      server.answers.push({ threadId: respond[1]!, body });
      if (server.gate) await server.gate;
      const id = String(body.requestId ?? body.requestHandle ?? "").replace(/^req-/, "");
      if (!server.stale.has(id)) server.rows = server.rows.filter(entry => entry.id !== id);
      return { ok: true };
    }
    if (path === "/api/inbox/approve-all/surface") return { show: server.surface };
    return {};
  };
  return { ...real, api, useStoreIfAny: () => undefined };
});
const { Inbox } = await import("../Inbox");

let root: Root;
let refresh = 0;
const settle = async () => { for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const render = async () => { await act(async () => root.render(createElement(Inbox, { door: true, initialView: "decisions", refreshKey: refresh, onOpen: () => {} } as never))); await settle(); };
/** A read lands (the 5 s beat, an inbox.changed notice): the list as the server has it now. */
const read = async () => { refresh += 1; await render(); };
const door = () => document.querySelector<HTMLElement>("[data-needs-door]") ?? document.body;
/** The pointer comes over the list (and leaves it). */
const pointerIn = async () => { await act(async () => { door().dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })); }); };
/** What sits in slot N of the list: the Nth row, live or answered. */
const slots = () => [...door().querySelectorAll<HTMLElement>("li[data-needs-row], li[data-needs-resolved]")];
const approveIn = (slot: HTMLElement | undefined) => [...(slot?.querySelectorAll<HTMLButtonElement>("button[data-needs-quick]") ?? [])].find(button => button.textContent?.includes("Approve"));
const answered = () => server.answers.map(answer => String(answer.body.requestId ?? answer.body.requestHandle));
/** Press the Approve that is under a pointer parked on slot N, and let the answer settle. */
const clickSlot = async (n: number) => {
  const button = approveIn(slots()[n]);
  expect(button, `an Approve button sits in slot ${n}`).toBeTruthy();
  await act(async () => { button!.click(); });
  await settle();
};
const rows = (bot: string, ids: string[], from: number, bulk = "ok") => ids.map((id, at) => ({ id, bot, at: from + at * 1000, bulk }));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  server.rows = []; server.answers = []; server.stale = new Set(); server.surface = false; server.gate = null; server.noCard = new Set(); refresh = 0;
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); });

describe("q1022-cards #46: a card never moves under the pointer while you click", () => {
  it("W1 resolve in place: after Approve on slot 0, the card aimed at in slot 1 is still in slot 1", async () => {
    server.rows = rows("Petra", ["a", "b", "c", "d"], 1_000);
    await render();
    await pointerIn();
    expect(slots().length, "four cards").toBe(4);
    await clickSlot(0);
    expect(answered(), "the first card answered").toEqual(["req-a"]);
    // The owner aimed at the second card before the first one went: the pointer is still on slot 1.
    await clickSlot(1);
    expect(answered(), "the click on slot 1 answers the card that was under it (b), not the one that slid up (c)").toEqual(["req-a", "req-b"]);
    expect(slots()[0]?.hasAttribute("data-needs-resolved"), "the answered card keeps its slot, greyed").toBe(true);
  });

  it("W2 new cards are appended: a card arriving mid-click (older, so sorted first) does not push the target down", async () => {
    server.rows = rows("Petra", ["a", "b", "c"], 5_000);
    await render();
    await pointerIn();
    // The owner moves onto slot 1 (b); a read lands with a card the list sorts first (raised earlier, delivered late).
    server.rows = [...rows("Petra", ["late"], 1_000), ...server.rows];
    await read();
    await clickSlot(1);
    expect(answered(), "the click on slot 1 still answers b").toEqual(["req-b"]);
    expect(slots().at(-1)?.getAttribute("data-needs-row"), "the new card is added at the end while the pointer is over the list").toBe("item-late");
  });

  it("W8 arrivals keep the order they came in: a second, older-stamped arrival never goes ahead of the first (Astra H1a)", async () => {
    server.rows = rows("Petra", ["a", "b", "c"], 5_000);
    await render();
    await pointerIn();
    // C arrives and is added at the end (slot 3), then D, stamped older than C, arrives: the live sort puts D ahead of C.
    server.rows = [...server.rows, ...rows("Petra", ["late-c"], 3_000)];
    await read();
    server.rows = [...rows("Petra", ["late-d"], 2_000), ...server.rows];
    await read();
    expect(slots().map(slot => slot.getAttribute("data-needs-row")).slice(3), "the arrivals in the order they came").toEqual(["item-late-c", "item-late-d"]);
    // The owner had moved onto C's slot when it came: the click there answers C.
    await clickSlot(3);
    expect(answered(), "the click on slot 3 answers C, the card that was under it").toEqual(["req-late-c"]);
    // C answered keeps its slot too, so D does not slide up into it.
    expect(slots()[4]?.getAttribute("data-needs-row"), "D is still in slot 4 once C is answered").toBe("item-late-d");
    await clickSlot(4);
    expect(answered(), "the click on slot 4 answers D").toEqual(["req-late-c", "req-late-d"]);
  });

  it("W9 an answered card keeps its measured height: a wrapped or open card does not shrink to one line (Astra H1b)", async () => {
    server.rows = rows("Petra", ["a", "b", "c"], 1_000);
    await render();
    // jsdom lays nothing out: card b reports the height a long, wrapped line gives it in a real window.
    let height = 120;
    const b = document.querySelector<HTMLElement>('li[data-needs-row="item-b"]')!;
    vi.spyOn(b, "getBoundingClientRect").mockImplementation(() => ({ height }) as DOMRect);
    await pointerIn();
    // Then it grows (opened, or the window narrowed) before it is answered: the slot keeps the height it had last.
    height = 260;
    await read();
    await clickSlot(1);
    expect(answered()).toEqual(["req-b"]);
    const placeholder = document.querySelector<HTMLElement>('li[data-needs-resolved="item-b"]');
    expect(placeholder, "b keeps its slot").toBeTruthy();
    expect(placeholder!.style.minHeight, "the slot keeps b's height, so c does not move up under the pointer").toBe("260px");
  });

  it("W11 answering an open card while held does not open the next one under the pointer (Fable H1b, open-card path)", async () => {
    server.rows = rows("Petra", ["a", "b", "c"], 1_000);
    await render();
    await pointerIn();
    await act(async () => { door().querySelector<HTMLButtonElement>('button[data-needs-open="item-a"]')!.click(); });
    await settle();
    const allow = [...(document.getElementById("needs-row-body-item-a")?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(button => /Allow once/.test(button.textContent ?? ""));
    expect(allow, "the open card's Allow once").toBeTruthy();
    await act(async () => { allow!.click(); });
    await settle();
    expect(answered()).toEqual(["req-a"]);
    expect(door().querySelector('li[data-needs-row="item-b"]')?.getAttribute("data-open"), "held: b stays closed (opening it would push c down under the pointer)").toBe("false");
    expect(slots()[0]?.textContent, "a keeps its slot, answered").toMatch(/Answered/);
    await act(async () => { door().dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })); });
    await settle();
    expect(slots().map(slot => slot.getAttribute("data-needs-row")), "released: the list closes up").toEqual(["item-b", "item-c"]);
  });

  it("W12 snoozing an open card while held does not open the next one under the pointer (the same sweep, Not now)", async () => {
    server.rows = rows("Petra", ["a", "b", "c"], 1_000);
    await render();
    await pointerIn();
    await act(async () => { door().querySelector<HTMLButtonElement>('button[data-needs-open="item-a"]')!.click(); });
    await settle();
    const later = document.getElementById("needs-row-body-item-a")?.querySelector<HTMLButtonElement>('button[aria-keyshortcuts="S"]');
    expect(later, "the open card's Not now").toBeTruthy();
    await act(async () => { later!.click(); });
    await settle();
    expect(door().querySelector('li[data-needs-row="item-b"]')?.getAttribute("data-open"), "held: b stays closed after a is snoozed").toBe("false");
    expect(slots()[0]?.getAttribute("data-needs-resolved"), "a keeps its slot").toBe("item-a");
  });

  it("W13 after a chip is picked inside the list, the next move onto a row holds the new list (self-review High)", async () => {
    server.rows = [...rows("Petra", ["p1", "p2", "p3"], 1_000), ...rows("Max", ["m1"], 9_000)];
    await render();
    await pointerIn();
    const chip = [...door().querySelectorAll<HTMLButtonElement>("[data-needs-chips] button")].find(button => button.textContent?.includes("Petra"))!;
    await act(async () => { chip.click(); });
    await settle();
    // The pointer never left the list: it moves from the chip down onto Petra's first card.
    const first = slots()[0]!;
    await act(async () => { first.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: chip })); });
    await clickSlot(0);
    expect(answered()).toEqual(["req-p1"]);
    await clickSlot(1);
    expect(answered(), "the click on slot 1 answers p2, the card that was under it").toEqual(["req-p1", "req-p2"]);
  });

  it("W14 a long (grouped) list: arrivals from Petra, Max, then Petra again stay in the order they came (Astra r3 High)", async () => {
    // Past 20 cards the list is grouped by bot.
    server.rows = [...rows("Petra", Array.from({ length: 11 }, (_, n) => `p${n}`), 1_000), ...rows("Max", Array.from({ length: 10 }, (_, n) => `m${n}`), 50_000)];
    await render();
    await pointerIn();
    expect(slots().length).toBe(21);
    for (const [bot, id, at] of [["Petra", "new-p1", 90_000], ["Max", "new-m1", 91_000], ["Petra", "new-p2", 92_000]] as const) {
      server.rows = [...server.rows, ...rows(bot, [id], at)];
      await read();
    }
    expect(slots().map(slot => slot.getAttribute("data-needs-row")).slice(21), "the arrivals in the order they came, Max's not pushed down").toEqual(["item-new-p1", "item-new-m1", "item-new-p2"]);
    await clickSlot(22);
    expect(answered(), "the click on slot 22 answers Max's new card").toEqual(["req-new-m1"]);
  });

  it("W15 an open card's slow answer, sent before the pointer came over the list, does not open the next one once it is held", async () => {
    server.rows = rows("Petra", ["a", "b", "c"], 1_000);
    await render();
    await act(async () => { door().querySelector<HTMLButtonElement>('button[data-needs-open="item-a"]')!.click(); });
    await settle();
    let reply!: () => void;
    server.gate = new Promise<void>(done => { reply = done; });
    const allow = [...(document.getElementById("needs-row-body-item-a")?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(button => /Allow once/.test(button.textContent ?? ""));
    await act(async () => { allow!.click(); });
    await settle();
    expect(answered(), "the answer is out, its reply still on the way").toEqual(["req-a"]);
    // The pointer comes over the list, onto the cards below, before the reply lands.
    await pointerIn();
    server.gate = null;
    await act(async () => { reply(); });
    await settle();
    expect(door().querySelector('li[data-needs-row="item-b"]')?.getAttribute("data-open"), "held when the reply lands: b stays closed").toBe("false");
  });

  it("W1b the list closes up once the pointer leaves", async () => {
    server.rows = rows("Petra", ["a", "b"], 1_000);
    await render();
    await pointerIn();
    await clickSlot(0);
    expect(slots().length, "held: the answered row keeps its slot").toBe(2);
    await act(async () => { door().dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })); });
    await settle();
    expect(slots().map(slot => slot.getAttribute("data-needs-row")), "released: only the live row").toEqual(["item-b"]);
  });
  it("W5 layout reserved: the page's Approve all and the bot chips above the list keep their place while the pointer is over it", async () => {
    server.surface = true;
    server.rows = [...rows("Petra", ["p1"], 1_000), ...rows("Max", ["m1"], 2_000)];
    await render();
    expect(document.body.textContent, "two approvals wait: the page's Approve all is on screen").toMatch(/Approve all/);
    // jsdom lays nothing out: the area above the list reports the height a real window gives it.
    const slot = document.querySelector<HTMLElement>("[data-approve-all-slot]");
    if (slot) vi.spyOn(slot, "getBoundingClientRect").mockReturnValue({ height: 44 } as DOMRect);
    await pointerIn();
    // Max's only card is answered: one approval is left, so the page's Approve all goes, and so does the chip row.
    await clickSlot(1);
    expect(answered()).toEqual(["req-m1"]);
    expect(door().querySelector("[data-needs-chips]"), "the chip row stays while the pointer is over the list").toBeTruthy();
    expect(document.querySelector<HTMLElement>("[data-approve-all-slot]")?.style.minHeight, "the page's Approve all leaves, but its 44 px stay, so nothing below moves up").toBe("44px");
    expect(slot!.textContent, "fewer than two: the button itself goes").not.toMatch(/Approve all/);
    expect(approveIn(slots()[0])?.closest("li")?.getAttribute("data-needs-row"), "Petra's card is still in slot 0").toBe("item-p1");
  });

  it("W6 nothing opens up above the rows while held: a card that would bring an Approve all header waits for the pointer to leave", async () => {
    server.rows = rows("Petra", ["p1"], 1_000);
    await render();
    await pointerIn();
    // A second card of Petra's arrives: two now make an "Approve all from Petra", which would sit above slot 0.
    server.rows = [...server.rows, ...rows("Petra", ["p2"], 2_000)];
    await read();
    expect(door().querySelector("[data-needs-bot-approve-all]"), "held: no header is added above the rows").toBeNull();
    expect(door().querySelector("[data-needs-chips]"), "held: no chip row is added either").toBeNull();
    await act(async () => { door().dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })); });
    await settle();
    expect(door().querySelector("[data-needs-bot-approve-all]")?.textContent, "released: the button comes").toBe("Approve all 2 from Petra");
  });

  it("W16 the page's Approve all that was not on screen when the hold began does not appear above the held rows (Fable r3 LATE H1)", async () => {
    server.surface = true;
    server.rows = rows("Petra", ["p1"], 1_000);
    await render();
    expect(document.querySelector("[data-approve-all-slot]")?.textContent, "one approval: no page Approve all").not.toMatch(/Approve all/);
    await pointerIn();
    const before = slots()[0]!.textContent;
    // A second approval arrives: two now put the page's Approve all (and its grey line on each approval row) on screen.
    server.rows = [...server.rows, ...rows("Max", ["m1"], 2_000)];
    await read();
    expect(slots()[0]!.textContent, "held: Petra's row gets no new line, so it does not grow under the pointer").toBe(before);
    const slot = document.querySelector<HTMLElement>("[data-approve-all-slot]")!;
    expect([slot.style.height, slot.style.overflow], "held: the area above the list stays closed, so the rows do not move down").toEqual(["0px", "hidden"]);
    await act(async () => { door().dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })); });
    await settle();
    expect(slot.style.height, "released: the slot opens").toBe("");
    expect(slot.textContent, "released: the page's Approve all comes").toMatch(/Approve all/);
  });

  it("W18 a card read that lands while held adds no buttons to a row above others (Astra r3 High: the row would grow)", async () => {
    server.rows = rows("Petra", ["a", "b", "c"], 1_000);
    server.noCard = new Set(["b"]);
    await render();
    expect(approveIn(slots()[1]), "b's card has not been read yet: no buttons").toBeUndefined();
    await pointerIn();
    const before = slots()[1]!.textContent;
    // b's card read lands (with a read that brings a new card, so the cards are read again).
    server.noCard = new Set();
    server.rows = [...server.rows, ...rows("Petra", ["late"], 9_000)];
    await read();
    expect(approveIn(slots().at(-1)), "the read happened: the new card has its buttons").toBeTruthy();
    expect(approveIn(slots()[1]), "held: b gets no buttons, so it does not grow and push c down").toBeUndefined();
    expect(slots()[1]!.textContent, "held: b's row is as it was").toBe(before);
    await act(async () => { door().dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })); });
    await settle();
    expect(approveIn(door().querySelector<HTMLElement>('li[data-needs-row="item-b"]') ?? undefined), "released: b's buttons come").toBeTruthy();
  });

  it("W22 a card read that lands while held adds no answer panel to an open row above others (Astra r4 precheck High)", async () => {
    server.rows = rows("Petra", ["a", "b", "c"], 1_000);
    server.noCard = new Set(["b"]);
    await render();
    await act(async () => { door().querySelector<HTMLButtonElement>('button[data-needs-open="item-b"]')!.click(); });
    await settle();
    const body = () => document.getElementById("needs-row-body-item-b");
    expect(body(), "b is open").toBeTruthy();
    await pointerIn();
    const before = body()!.textContent;
    server.noCard = new Set();
    server.rows = [...server.rows, ...rows("Petra", ["late"], 9_000)];
    await read();
    expect(approveIn(slots().at(-1)), "the read happened: the new card has its buttons").toBeTruthy();
    expect(body()!.textContent, "held: b's open card gets no answer panel, so it does not grow and push c down").toBe(before);
    await act(async () => { door().dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })); });
    await settle();
    expect([...(body()?.querySelectorAll("button") ?? [])].some(button => /Allow once/.test(button.textContent ?? "")), "released: b's answer panel comes").toBe(true);
  });

  it("W23 a first arrival's card read landing after a second arrival is on screen adds no buttons to it (Astra/Fable/Opus r4 High)", async () => {
    server.rows = rows("Petra", ["a", "b"], 1_000);
    await render();
    await pointerIn();
    // x arrives while held; its card cannot be read yet.
    server.noCard = new Set(["x"]);
    server.rows = [...server.rows, ...rows("Petra", ["x"], 9_000)];
    await read();
    // y arrives below x (its card reads at once): the pointer may now be parked on y.
    server.rows = [...server.rows, ...rows("Petra", ["y"], 10_000)];
    await read();
    const at = slots().map(slot => slot.getAttribute("data-needs-row"));
    expect(at, "x then y, after the held rows").toEqual(["item-a", "item-b", "item-x", "item-y"]);
    expect(approveIn(slots()[2]), "x's card has not been read yet: no buttons").toBeUndefined();
    expect(approveIn(slots()[3]), "y has its buttons").toBeTruthy();
    const before = slots()[2]!.textContent;
    // x's card read lands (with a read that brings z, so the cards are read again).
    server.noCard = new Set();
    server.rows = [...server.rows, ...rows("Petra", ["z"], 11_000)];
    await read();
    expect(approveIn(slots().at(-1)), "the read happened: z, the last row, has its buttons").toBeTruthy();
    expect(approveIn(slots()[2]), "held: x gets no buttons, so it does not grow and push y down").toBeUndefined();
    expect(slots()[2]!.textContent, "held: x's row is as it was").toBe(before);
    expect(slots()[3]?.getAttribute("data-needs-row"), "y is still in its slot").toBe("item-y");
    // A later arrival (w) does not take x's card state again: x stays as it was.
    server.rows = [...server.rows, ...rows("Petra", ["w"], 12_000)];
    await read();
    expect(slots().at(-1)?.getAttribute("data-needs-row"), "w is added at the end").toBe("item-w");
    expect(approveIn(slots()[2]), "held: x still gets no buttons after another arrival").toBeUndefined();
    await act(async () => { door().dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })); });
    await settle();
    expect(approveIn(door().querySelector<HTMLElement>('li[data-needs-row="item-x"]') ?? undefined), "released: x's buttons come").toBeTruthy();
  });

  it("W24 a card read that loses a held row's or an earlier arrival's card takes no buttons away, and its return adds none (Astra q1023 precheck High)", async () => {
    server.rows = rows("Petra", ["a", "b"], 1_000);
    await render();
    await pointerIn();
    server.rows = [...server.rows, ...rows("Petra", ["x"], 9_000)];
    await read();
    server.rows = [...server.rows, ...rows("Petra", ["y"], 10_000)];
    await read();
    expect(slots().map(slot => slot.getAttribute("data-needs-row")), "x then y, after the held rows").toEqual(["item-a", "item-b", "item-x", "item-y"]);
    expect(approveIn(slots()[1]) && approveIn(slots()[2]), "b and x have their buttons").toBeTruthy();
    const before = slots().map(slot => slot.textContent);
    // A read loses b's and x's cards (in the field: older requests take their places among the cards read).
    server.noCard = new Set(["b", "x"]);
    server.rows = [...server.rows, ...rows("Petra", ["z"], 11_000)];
    await read();
    expect(approveIn(slots().at(-1)), "the read happened: z has its buttons").toBeTruthy();
    expect(approveIn(slots()[1]), "held: b keeps its buttons, so it does not shrink and pull x and y up").toBeTruthy();
    expect(approveIn(slots()[2]), "held: x keeps its buttons, so it does not shrink and pull y up").toBeTruthy();
    expect(slots().slice(0, 4).map(slot => slot.textContent), "held: the rows are as they were").toEqual(before);
    // Their cards come back with the next read: nothing changes either.
    server.noCard = new Set();
    server.rows = [...server.rows, ...rows("Petra", ["w"], 12_000)];
    await read();
    expect(slots().slice(0, 4).map(slot => slot.textContent), "held: the cards coming back change no row").toEqual(before);
  });

  it("W7 the hold ends with the list: after its last card is answered, a card that arrives later is shown alone", async () => {
    server.rows = rows("Petra", ["p1", "p2"], 1_000);
    await render();
    await pointerIn();
    await clickSlot(0);
    await clickSlot(1);
    expect(answered()).toEqual(["req-p1", "req-p2"]);
    // Every card answered: the list goes (no mouseleave fires on a list that is gone). Later a new one arrives.
    server.rows = rows("Max", ["m1"], 9_000);
    await read();
    expect(slots().map(slot => slot.getAttribute("data-needs-row") ?? `held:${slot.getAttribute("data-needs-resolved")}`), "no answered rows linger from the old hold").toEqual(["item-m1"]);
  });
});

describe("q1022-cards #48/#19: Approve all from one bot answers each of its visible cards once, through the row's own Approve", () => {
  it("W3 delivers N answers once each, the same body a single Approve posts, and skips cards that need a look and other bots", async () => {
    server.rows = [...rows("Petra", ["p1", "p2", "p3", "p4"], 1_000), ...rows("Petra", ["look"], 9_000, "unreadable"), ...rows("Max", ["m1", "m2"], 2_500)];
    await render();
    // One card of Petra's answered by hand: the reference body of the one answer path.
    await act(async () => { approveIn(slots().find(slot => slot.getAttribute("data-needs-row") === "item-p1"))!.click(); });
    await settle();
    expect(answered()).toEqual(["req-p1"]);
    const single = server.answers[0]!;
    // Her chip: the list is one bot's, and its Approve all names her.
    const chip = [...door().querySelectorAll<HTMLButtonElement>("[data-needs-chips] button")].find(button => button.textContent?.includes("Petra"));
    await act(async () => { chip!.click(); });
    await settle();
    await pointerIn();
    const all = door().querySelector<HTMLButtonElement>('[data-needs-bot-approve-all="Petra"]');
    expect(all, "an Approve all from Petra on her list").toBeTruthy();
    expect(all!.textContent).toBe("Approve all 3 from Petra");
    // Pressed twice, fast: one run.
    await act(async () => { all!.click(); all!.click(); });
    await settle();
    expect(answered(), "each of Petra's ok cards answered exactly once, in list order").toEqual(["req-p1", "req-p2", "req-p3", "req-p4"]);
    for (const answer of server.answers.slice(1)) {
      expect(answer.threadId, "on the card's own thread").toBe("thread-Petra");
      expect(Object.keys(answer.body).sort(), "the same body a single Approve posts").toEqual(Object.keys(single.body).sort());
      expect({ ...answer.body, requestId: undefined, requestHandle: undefined }).toEqual({ ...single.body, requestId: undefined, requestHandle: undefined });
    }
    expect(answered(), "the card that needs a look and Max's cards are left for their own answer").not.toContain("req-look");
    expect(answered().some(id => id.startsWith("req-m")), "no other bot's card").toBe(false);
  });

  it("W10 Approve all answers every card it was pressed over, even when a chip takes them off the screen mid-run (Astra H2)", async () => {
    server.rows = [...rows("Petra", ["p1", "p2", "p3"], 1_000), ...rows("Max", ["m1"], 9_000)];
    await render();
    const chip = (bot: string) => [...door().querySelectorAll<HTMLButtonElement>("[data-needs-chips] button")].find(button => button.textContent?.includes(bot))!;
    await act(async () => { chip("Petra").click(); });
    await settle();
    const all = door().querySelector<HTMLButtonElement>('[data-needs-bot-approve-all="Petra"]');
    expect(all?.textContent).toBe("Approve all 3 from Petra");
    // The first answer is slow; while it is out, the owner picks Max's chip, so Petra's cards leave the screen.
    let reply!: () => void;
    server.gate = new Promise<void>(done => { reply = done; });
    await act(async () => { all!.click(); });
    await settle();
    expect(answered(), "the first card is out").toEqual(["req-p1"]);
    await act(async () => { chip("Max").click(); });
    await settle();
    expect(door().querySelector('li[data-needs-row="item-p2"]'), "Petra's cards are off the screen").toBeNull();
    server.gate = null;
    await act(async () => { reply(); });
    await settle();
    expect(answered(), "every card Approve all was pressed over is answered, once each").toEqual(["req-p1", "req-p2", "req-p3"]);
    expect(answered(), "and none of Max's").not.toContain("req-m1");
  });

  it("W17 Approve all never answers a card again that was answered by hand on a row that came back after a chip (#19, Astra r3 High)", async () => {
    server.rows = [...rows("Petra", ["p1", "p2", "p3"], 1_000), ...rows("Max", ["m1"], 9_000)];
    await render();
    const chip = (bot: string) => [...door().querySelectorAll<HTMLButtonElement>("[data-needs-chips] button")].find(button => button.textContent?.includes(bot))!;
    await act(async () => { chip("Petra").click(); });
    await settle();
    let reply!: () => void;
    server.gate = new Promise<void>(done => { reply = done; });
    await act(async () => { door().querySelector<HTMLButtonElement>('[data-needs-bot-approve-all="Petra"]')!.click(); });
    await settle();
    expect(answered(), "the first card is out, its reply slow").toEqual(["req-p1"]);
    // The owner switches to Max and back: Petra's rows leave the screen and come back as new rows.
    await act(async () => { chip("Max").click(); });
    await settle();
    await act(async () => { chip("Petra").click(); });
    await settle();
    // Then approves p3 by hand on the row that came back; that answer is accepted.
    server.gate = null;
    await act(async () => { approveIn(door().querySelector<HTMLElement>('li[data-needs-row="item-p3"]') ?? undefined)!.click(); });
    await settle();
    expect(answered()).toEqual(["req-p1", "req-p3"]);
    await act(async () => { reply(); });
    await settle();
    expect(answered(), "Approve all goes on to p2 and never sends p3 again").toEqual(["req-p1", "req-p3", "req-p2"]);
  });

  it("W20 Approve all never answers a card again that was answered from its open card (#19, self-review High)", async () => {
    server.rows = rows("Petra", ["p1", "p2", "p3"], 1_000);
    await render();
    let reply = () => {};
    try {
      server.gate = new Promise<void>(done => { reply = done; });
      await act(async () => { door().querySelector<HTMLButtonElement>('[data-needs-bot-approve-all="Petra"]')!.click(); });
      await settle();
      expect(answered(), "the first card is out, its reply slow").toEqual(["req-p1"]);
      // The owner opens p3 and answers it from the open card; that answer is accepted and p3 leaves.
      await act(async () => { door().querySelector<HTMLButtonElement>('button[data-needs-open="item-p3"]')!.click(); });
      await settle();
      server.gate = null;
      const allow = [...(document.getElementById("needs-row-body-item-p3")?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(button => /Allow once/.test(button.textContent ?? ""));
      await act(async () => { allow!.click(); });
      await settle();
      expect(answered()).toEqual(["req-p1", "req-p3"]);
      await act(async () => { reply(); });
      await settle();
      expect(answered(), "Approve all goes on to p2 and never sends p3 again").toEqual(["req-p1", "req-p3", "req-p2"]);
    } finally {
      server.gate = null;
      await act(async () => { reply(); });
      await settle();
    }
  });

  it("W4 no approval loop: an answered card the server still lists is never answered again, by hand or by Approve all", async () => {
    server.rows = rows("Petra", ["p1", "p2", "p3"], 1_000);
    server.stale = new Set(["p1", "p2", "p3"]);
    await render();
    await pointerIn();
    const all = door().querySelector<HTMLButtonElement>('[data-needs-bot-approve-all="Petra"]');
    expect(all, "an Approve all from Petra (one bot on the list)").toBeTruthy();
    await act(async () => { all!.click(); });
    await settle();
    expect(answered(), "three answers").toEqual(["req-p1", "req-p2", "req-p3"]);
    // Reads keep listing all three as waiting (a stale page): nothing is offered or sent again.
    await read(); await read();
    const again = door().querySelector<HTMLButtonElement>('[data-needs-bot-approve-all="Petra"]');
    if (again && !again.disabled) { await act(async () => { again.click(); }); await settle(); }
    for (const slot of slots()) expect(approveIn(slot), `no Approve offered again on ${slot.getAttribute("data-needs-row") ?? slot.getAttribute("data-needs-resolved")}`).toBeUndefined();
    expect(answered(), "still three answers, once each").toEqual(["req-p1", "req-p2", "req-p3"]);
  });
});
