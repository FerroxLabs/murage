// Settings v10 A3/A5 model witnesses (owner: sv10-tools).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { TOOL_ROWS, botsOffCount, rowAppOn } from "./tools-page";
import { PER_BOT_TOOLS } from "../../server/settings/tools-off";

it("has 21 rows with unique ids, and every per-bot tool of the server has its row", () => {
  expect(TOOL_ROWS).toHaveLength(21);
  expect(new Set(TOOL_ROWS.map(r => r.id)).size).toBe(21);
  expect(TOOL_ROWS.map(r => r.perBot).filter(Boolean).sort()).toEqual([...PER_BOT_TOOLS].sort());
});
it("reads the app-wide switches the way the server does (default on; off only when stated)", () => {
  const search = TOOL_ROWS.find(r => r.id === "web-search")!, read = TOOL_ROWS.find(r => r.id === "web-read")!;
  expect(rowAppOn(search, undefined)).toBe(true);
  expect(rowAppOn(search, { webSearch: { provider: "off" } })).toBe(false);
  expect(rowAppOn(read, {})).toBe(true);
  expect(rowAppOn(read, { webRead: { enabled: false } })).toBe(false);
  // Web search Off turns page reading off on the server (one predicate), so the row cannot say On
  expect(rowAppOn(read, { webSearch: { provider: "off" } })).toBe(false);
  expect(rowAppOn(read, { webSearch: { provider: "off" }, webRead: { enabled: true } })).toBe(false);
  expect(rowAppOn(TOOL_ROWS.find(r => r.id === "memory")!, {})).toBeUndefined();
});
it("counts bots with the tool off, not archived ones", () => {
  const images = TOOL_ROWS.find(r => r.id === "images")!;
  expect(botsOffCount(images, [{ toolsOff: ["images"] }, { toolsOff: ["images"], hidden: true }, {}])).toBe(1);
});
it("G4: the count on the page is the server's own truth, in every state of the two switches", () => {
  const bots = [{ id: "a" }, { id: "b", toolsOff: ["web_search", "images"] }];
  const search = TOOL_ROWS.find(r => r.id === "web-search")!, images = TOOL_ROWS.find(r => r.id === "images")!;
  expect(botsOffCount(search, bots, {})).toBe(1);
  expect(botsOffCount(search, bots, { webSearch: { provider: "off" } })).toBe(2);
  expect(botsOffCount(images, bots, { webSearch: { provider: "off" } })).toBe(1);
  expect(botsOffCount(TOOL_ROWS.find(r => r.id === "web-read")!, bots, { webRead: { enabled: false } })).toBe(2);
});
it("A5: the default computer control has one home (one page file mounts it), and the hosted row is mounted beside it", () => {
  const dir = join(__dirname, "../components/settings/pages");
  const mounting = readdirSync(dir).filter(f => f.endsWith(".tsx") && /<DefaultComputerRow\b/.test(readFileSync(join(dir, f), "utf8")));
  expect(mounting).toEqual(["ComputerPage.tsx"]);
  expect(readFileSync(join(dir, "ComputerPage.tsx"), "utf8")).toMatch(/<DefaultComputerRow \/><HostedComputersRow \/>/);
});
