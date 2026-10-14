import { describe, expect, it } from "vitest";
import { rememberedViews } from "./remembered-view";

const later = <T,>(value: T, ms = 20) => new Promise<T>(resolve => setTimeout(() => resolve(value), ms));

describe("rememberedViews (the access card's cache)", () => {
  it("paints a remembered answer synchronously, then the refresh updates it", async () => {
    const views = rememberedViews<{ accounts: string[] }>();
    views.set("bot", { accounts: ["old"] });
    const seen: string[][] = [];
    const done = views.open("bot", () => later({ accounts: ["old", "new"] }), v => seen.push(v.accounts), () => seen.push(["ERROR"]));
    expect(seen).toEqual([["old"]]); // before the slow service answered
    await done;
    expect(seen).toEqual([["old"], ["old", "new"]]);
    expect(views.get("bot")?.accounts).toEqual(["old", "new"]);
  });
  it("first ever open has nothing to paint and shows the answer when it arrives", async () => {
    const views = rememberedViews<number>();
    const seen: number[] = [];
    const done = views.open("a", () => later(7), v => seen.push(v), () => seen.push(-1));
    expect(seen).toEqual([]);
    await done;
    expect(seen).toEqual([7]);
  });
  it("a failed refresh keeps the remembered card and raises no error; with nothing remembered it does", async () => {
    const views = rememberedViews<number>();
    views.set("a", 1);
    const seen: (number | string)[] = [];
    await views.open("a", () => Promise.reject(new Error("down")), v => seen.push(v), () => seen.push("error"));
    expect(seen).toEqual([1]);
    await views.open("b", () => Promise.reject(new Error("down")), v => seen.push(v), () => seen.push("error"));
    expect(seen).toEqual([1, "error"]);
  });
  it("a closed card is not updated by a late answer", async () => {
    const views = rememberedViews<number>();
    const seen: number[] = [];
    let active = true;
    const done = views.open("a", () => later(2), v => seen.push(v), () => {}, () => active);
    active = false;
    await done;
    expect(seen).toEqual([]);
    expect(views.get("a")).toBe(2);
  });
});
