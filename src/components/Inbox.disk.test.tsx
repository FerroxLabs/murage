// @vitest-environment jsdom
// Boot tolerance D2 (docs/designs/boot-tolerance/ACCEPTANCE.md): the Inbox says a nearly full disk in the owner's language, in both modes, and the
// read-only line carries the existing relaunch action as "Restart Murage" (or the quit-and-reopen fallback when that action is missing or rejects).
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Inbox } from "./Inbox";
import { setLocale } from "@/lib/i18n";
import { en } from "@/locales";

const mocks = vi.hoisted(() => ({ page: {} as Record<string, unknown> }));
vi.mock("@/state/store", () => ({ api: vi.fn(async () => mocks.page), useStoreIfAny: () => undefined }));

const LOCALES = ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"] as const;
const KEYS = ["ux.l2b.disk.section", "ux.l2b.disk.readOnly", "ux.l2b.disk.refusing", "ux.l2b.disk.restart", "ux.l2b.disk.restartFallback"] as const;
const emptyPage = { items: [], total: 0, unread: 0, decisions: 0, questions: 0, page: 0, pageSize: 25 };
let root: Root, host: HTMLDivElement;
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const render = async (diskLow: { mode: string } | undefined) => {
  // a fresh mount each time: the Inbox keeps the page it first read
  await act(async () => root.unmount()); document.body.replaceChildren(); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  mocks.page = { ...emptyPage, ...(diskLow ? { diskLow } : {}) };
  await act(async () => root.render(createElement(Inbox, { onOpen: () => {}, onClose: () => {} } as never)));
  await settle();
};
const card = () => document.querySelector<HTMLElement>("[data-disk-low]");

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); delete (window as { muragebox?: unknown }).muragebox; await setLocale("en"); vi.restoreAllMocks(); });

describe("the Inbox disk line", () => {
  it("renders each mode in every locale, with the restart button", async () => {
    for (const code of LOCALES) {
      await act(async () => { await setLocale(code); });
      const words = code === "en" ? en : ((await import(`@/locales/${code}.json`)).default as Record<string, string>);
      for (const [mode, line] of [["read-only", "ux.l2b.disk.readOnly"], ["refusing", "ux.l2b.disk.refusing"]] as const) {
        await render({ mode });
        const text = card()?.textContent ?? "";
        expect(card()?.getAttribute("data-disk-low"), `${code} ${mode}: card present`).toBe(mode);
        expect(text, `${code} ${mode} line`).toContain(words[line]);
        expect(document.body.textContent, `${code} ${mode} title`).toContain(words["ux.l2b.disk.section"]);
        expect(document.body.textContent, `${code} ${mode}: no raw key`).not.toMatch(/ux\.l2b\.disk\./);
        const buttons = card()!.querySelectorAll("button");
        expect(buttons.length, `${code} ${mode} restart button`).toBe(mode === "read-only" ? 1 : 0);
        if (mode === "read-only") expect(buttons[0]!.textContent?.trim()).toBe(words["ux.l2b.disk.restart"]);
        if (code !== "en") for (const key of KEYS) expect(words[key], `${code} ${key} is translated`).not.toBe(en[key]);
      }
    }
  });

  it("shows nothing when the server says nothing", async () => {
    await render(undefined);
    expect(card()).toBeNull();
  });

  it("the button calls the relaunch action once", async () => {
    const relaunch = vi.fn(async () => {});
    (window as { muragebox?: unknown }).muragebox = { restartForFluxKey: relaunch };
    await render({ mode: "read-only" });
    await act(async () => { card()!.querySelector("button")!.click(); });
    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(card()!.textContent).not.toContain(en["ux.l2b.disk.restartFallback"]);
  });

  it("without the relaunch action, or when it rejects, the line says to quit and reopen", async () => {
    await render({ mode: "read-only" });
    await act(async () => { card()!.querySelector("button")!.click(); });
    expect(card()!.textContent).toContain(en["ux.l2b.disk.restartFallback"]);
    const relaunch = vi.fn(async () => { throw new Error("relaunch failed"); });
    (window as { muragebox?: unknown }).muragebox = { restartForFluxKey: relaunch };
    await render({ mode: "read-only" });
    await act(async () => { card()!.querySelector("button")!.click(); });
    await settle();
    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(card()!.textContent).toContain(en["ux.l2b.disk.restartFallback"]);
  });
});
