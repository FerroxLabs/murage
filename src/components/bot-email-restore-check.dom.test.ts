// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// secret-scan: fixture (fake addresses and fake tokens)
// Restore park B3b: the restore check row (Everything looks right), the Try again now action on a removing bot row, and the t() lines of
// the parked section. Real components, jsdom clicks, the wire contract's fixtures.
import { act, createElement as h } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, settle } from "../testing/dom-harness";
import { BotEmailAccountCard } from "./BotEmailSettings";
import { resetHeldEmailStatus } from "../lib/bot-email";
import { setLocale } from "../lib/i18n";
import { EMAIL_OWNER_COPY, type EmailStatusView } from "../../shared/email-copy.ts";
import fixtures from "../../server/email/owner-view-fixtures.json";

type Call = { path: string; method: string; body: Record<string, unknown> | undefined };
const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../state/store", async original => ({ ...await original<typeof import("../state/store")>(), useStore: () => ({ state: { config: null, bots: [] }, dispatch: vi.fn() }), api: fixture.api }));

type Row = Record<string, unknown> & { section: string; actions: Array<Record<string, unknown>> };
const homeView = (edit?: (rows: Row[]) => Row[]): EmailStatusView => {
  const view = { removing: [], ...structuredClone(fixtures.homeView) } as unknown as { rows: Row[] };
  for (const row of view.rows) row.threadId = row.botId ? `thread-${String(row.botId)}` : "email-owner";
  if (edit) (view as unknown as { rows: Row[] }).rows = edit(view.rows);
  return view as unknown as EmailStatusView;
};
const removingRow = (): Row => ({ rowId: "removing:b3", section: "removing", botId: "b3", inboxId: "in_3", keyIds: [], target: "bot:b3", address: "zed@mail.example", botName: "Zed", threadId: "thread-b3",
  line: EMAIL_OWNER_COPY.removingLine("zed@mail.example"), actions: [{ kind: "try_again_now", tokenId: null, enabled: true, path: "/api/email/bots/b3/try-again" }] });
const calls: Call[] = [];
let statusAnswer: () => EmailStatusView;
let postAnswer: (call: Call) => unknown;
function install() {
  fixture.api.mockReset().mockImplementation(async (path: string, init?: RequestInit) => {
    const call: Call = { path, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (path.startsWith("/api/email/status")) return statusAnswer();
    if (call.method === "POST") return postAnswer(call);
    return {};
  });
}
const posts = () => calls.filter(call => call.method === "POST");
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => { calls.length = 0; resetHeldEmailStatus(); statusAnswer = () => homeView(); postAnswer = () => ({ ...homeView(), rows: [] }); install(); vi.spyOn(window, "confirm").mockReturnValue(true); });
afterEach(async () => { cleanup(); await settle(); document.body.replaceChildren(); vi.restoreAllMocks(); await setLocale("en"); });

const buttonIn = (scope: Element, label: string) => [...scope.querySelectorAll("button")].find(item => item.textContent === label) as HTMLButtonElement;
async function click(el: Element) { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); await settle(); await settle(); }
async function openCard(view: EmailStatusView) { const app = mount(h(BotEmailAccountCard, { status: { kind: "on", view } })); await settle(); return app; }
const checkBlock = () => document.querySelector('[data-testid="bot-email-restore-check"]') as HTMLElement | null;
const removingBlock = () => document.querySelector('[data-testid="bot-email-removing"]') as HTMLElement | null;

describe("restore check row", () => {
  it("shows the shared line and Everything looks right", async () => {
    await openCard(homeView());
    expect(checkBlock()!.querySelector("p")!.textContent).toBe(EMAIL_OWNER_COPY.restoreCheckLine);
    expect(buttonIn(checkBlock()!, EMAIL_OWNER_COPY.confirmInventoryButton)).toBeTruthy();
  });

  it("confirm_inventory POSTs the action's own path with its token", async () => {
    await openCard(homeView());
    await click(buttonIn(checkBlock()!, EMAIL_OWNER_COPY.confirmInventoryButton));
    expect(posts()).toEqual([{ path: "/api/email/restore/confirm-inventory", method: "POST", body: { token: "tok_r_1" } }]);
  });

  it("a path the contract does not allow disables Everything looks right and sends nothing", async () => {
    await openCard(homeView(rows => { rows.find(row => row.section === "restore_check")!.actions[0]!.path = "/api/email/restore/elsewhere"; return rows; }));
    const button = buttonIn(checkBlock()!, EMAIL_OWNER_COPY.confirmInventoryButton);
    expect(button.disabled).toBe(true);
    await click(button);
    expect(posts()).toEqual([]);
  });

  it("a line the server worded differently is shown exactly", async () => {
    await openCard(homeView(rows => { rows.find(row => row.section === "restore_check")!.line = "Look over your email once more."; return rows; }));
    expect(checkBlock()!.querySelector("p")!.textContent).toBe("Look over your email once more.");
  });

  it("no restore_check row, no block", async () => {
    await openCard(homeView(rows => rows.filter(row => row.section !== "restore_check")));
    expect(checkBlock()).toBeNull();
  });
});

describe("Try again now on a removing bot row", () => {
  const withRemoving = () => homeView(rows => [...rows, removingRow()]);
  it("shows the row's line once with a Try again now button", async () => {
    const view = withRemoving() as unknown as { removing: unknown[] };
    view.removing = [{ botId: "b3", address: "zed@mail.example" }];
    await openCard(view as unknown as EmailStatusView);
    expect(removingBlock()!.querySelector("p")!.textContent).toBe(EMAIL_OWNER_COPY.removingLine("zed@mail.example"));
    expect(buttonIn(removingBlock()!, EMAIL_OWNER_COPY.tryAgainNowButton)).toBeTruthy();
    expect(document.body.textContent!.split(EMAIL_OWNER_COPY.removingLine("zed@mail.example")).length - 1).toBe(1);
  });

  it("POSTs the row's own try-again path with its target (no token)", async () => {
    await openCard(withRemoving());
    await click(buttonIn(removingBlock()!, EMAIL_OWNER_COPY.tryAgainNowButton));
    expect(posts()).toEqual([{ path: "/api/email/bots/b3/try-again", method: "POST", body: { target: "bot:b3" } }]);
  });
});

describe("the parked section lines go through t()", () => {
  const orphan = () => homeView(rows => { rows.find(row => row.section === "parked")!.line = EMAIL_OWNER_COPY.parkedOrphanLine("max@mail.example"); return rows; });
  it("English is identical to the shared copy", async () => {
    await openCard(orphan());
    const block = document.querySelector('[data-testid="bot-email-parked"]')!;
    expect(block.textContent).toContain(EMAIL_OWNER_COPY.parkedTitle);
    expect(block.textContent).toContain(EMAIL_OWNER_COPY.parkedOrphanLine("max@mail.example"));
  });

  it("in German the title, the orphan line and the new row buttons come from the pack", async () => {
    await setLocale("de");
    await openCard(orphan());
    const block = document.querySelector('[data-testid="bot-email-parked"]')!;
    expect(block.textContent).toContain("E-Mail-Adressen, die auf deine Entscheidung warten");
    expect(block.textContent).toContain("max@mail.example ist mit deiner Wiederherstellung zurückgekommen");
    expect(block.textContent).not.toContain(EMAIL_OWNER_COPY.parkedTitle);
    expect(checkBlock()!.textContent).toContain("Prüfe nach der Wiederherstellung deine E-Mail-Einrichtung.");
    expect(buttonIn(checkBlock()!, "Alles sieht richtig aus")).toBeTruthy();
  });

  it("in German the Try again now button comes from the pack", async () => {
    await setLocale("de");
    await openCard(homeView(rows => [...rows, removingRow()]));
    expect(buttonIn(removingBlock()!, "Jetzt erneut versuchen")).toBeTruthy();
  });

  it("the keeping and gone lines translate too, and an unknown server line stays verbatim", async () => {
    await setLocale("de");
    await openCard(homeView(rows => { rows.find(row => row.section === "parked")!.line = EMAIL_OWNER_COPY.goneLine("max@mail.example"); return rows; }));
    expect(document.querySelector('[data-testid="bot-email-parked"]')!.textContent).toContain("max@mail.example ist bereits weg.");
    cleanup(); await settle();
    await openCard(homeView());
    expect(document.querySelector('[data-testid="bot-email-parked"]')!.textContent).toContain("This address came back with a restore. Keep it or remove it.");
  });

  it("a refusal with the park codes shows in the app's language; the server's own different words stay", async () => {
    await setLocale("de");
    postAnswer = () => { throw { status: 409, body: { code: "inbox_gone", rowId: "parked:b2" } }; };
    await openCard(homeView());
    await click(buttonIn(document.querySelector('[data-testid="bot-email-row-parked:b2"]')!, EMAIL_OWNER_COPY.keepAddress));
    expect(document.querySelector('[data-testid="bot-email-refusal-parked:b2"]')!.textContent).toBe("Diese Adresse wurde bereits entfernt.");
  });
});
