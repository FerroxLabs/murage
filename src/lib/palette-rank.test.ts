import { describe, expect, it } from "vitest";

import { findStem, findTokens, queryTokens, rankByName, tokenMatch, withinOneEdit } from "./palette-rank";

const names = (items: Array<{ name: string }>) => items.map((i) => i.name);

describe("rankByName", () => {
  it("puts prefix matches above substring matches", () => {
    const items = [{ name: "Big Momo" }, { name: "Momo" }, { name: "Lemon Momo" }];
    expect(names(rankByName(items, "mo"))).toEqual(["Momo", "Big Momo", "Lemon Momo"]);
  });

  it("matches case-insensitively on both sides", () => {
    const items = [{ name: "MOSS" }, { name: "quiet moss" }];
    expect(names(rankByName(items, "Moss"))).toEqual(["MOSS", "quiet moss"]);
  });

  it("keeps input order within a tier", () => {
    const items = [{ name: "Miso One" }, { name: "Miso Two" }, { name: "A Miso" }, { name: "B Miso" }];
    expect(names(rankByName(items, "miso"))).toEqual(["Miso One", "Miso Two", "A Miso", "B Miso"]);
  });

  it("filters out non-matches", () => {
    const items = [{ name: "Momo" }, { name: "Moss" }];
    expect(rankByName(items, "zebra")).toEqual([]);
    expect(names(rankByName(items, "oss"))).toEqual(["Moss"]);
  });

  it("returns everything in input order for an empty or whitespace query", () => {
    const items = [{ name: "Momo" }, { name: "Moss" }];
    expect(names(rankByName(items, ""))).toEqual(["Momo", "Moss"]);
    expect(names(rankByName(items, "   "))).toEqual(["Momo", "Moss"]);
  });

  it("finds a name by the start of any of its words, every typed word, above a plain substring", () => {
    const items = [{ name: "Lemon" }, { name: "Lead of Ops" }, { name: "Ops Desk" }];
    expect(names(rankByName(items, "ops lead"))).toEqual(["Lead of Ops"]);
    expect(names(rankByName(items, "ops"))).toEqual(["Ops Desk", "Lead of Ops"]);
  });

  it("forgives one typo on a long name, ranked last", () => {
    const items = [{ name: "Marketing" }, { name: "Marketing Desk" }];
    expect(names(rankByName(items, "markting"))).toEqual(["Marketing", "Marketing Desk"]);
    expect(rankByName([{ name: "Nova" }], "nvoa")).toEqual([]);
  });

  it("keeps every typed word for names and matches punctuation as written", () => {
    expect(names(rankByName([{ name: "An" }, { name: "Email desk" }], "an email"))).toEqual([]);
    expect(names(rankByName([{ name: "Q&A" }, { name: "Ops" }], "&"))).toEqual(["Q&A"]);
  });
});

describe("the find matcher", () => {
  it("meets notify, notifies and notification at one stem", () => {
    expect(new Set(["notify", "notifies", "notification", "notifications"].map(findStem))).toEqual(new Set(["notifi"]));
    expect(findStem("series")).toBe("seri");
    expect(tokenMatch("series", "server")).toBe(-1);
    expect(tokenMatch("settings", "seth")).toBe(-1);
    expect(findStem("images")).toBe(findStem("image"));
    expect(findStem("access")).toBe("access");
    expect(findStem("addresses")).toBe("address");
    expect(findStem("settings")).toBe(findStem("setting"));
  });

  it("tokenises on spaces and punctuation, drops filler words while a real one is left", () => {
    expect(findTokens("What's new? Built-in browser")).toEqual(["whats", "new", "built", "in", "browser"]);
    expect(queryTokens("pair my phone")).toEqual(["pair", "phone"]);
    expect(queryTokens("the")).toEqual(["the"]);
  });

  it("counts exact, prefix and one typo on 5+ letters only", () => {
    expect(tokenMatch("email", "email")).toBe(0);
    expect(tokenMatch("notif", "notifications")).toBe(1);
    expect(tokenMatch("tele", "telegram")).toBe(1);
    expect(tokenMatch("telegarm", "telegram")).toBe(2);
    expect(tokenMatch("notifcations", "notifications")).toBe(2);
    expect(tokenMatch("emial", "email")).toBe(2);
    expect(tokenMatch("mpc", "mcp")).toBe(-1);
    expect(withinOneEdit("abc", "acb")).toBe(true);
    expect(withinOneEdit("abc", "cab")).toBe(false);
  });
});
