// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// JS time in a route (row parsing, wiring a bot, JSON.stringify of a big body) is named on the stall line as the route, not "unknown".
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { routeSource } from "./io-budget.ts";
import { heldStep, setObserveSink, startLoopStallWatch, stopLoopStallWatch, stallHolderText } from "./observe.ts";

const spin = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* hold the loop */ } };

it("a 300 ms route body filed under heldStep names the route on the stall line", async () => {
  const lines: string[] = [];
  setObserveSink(line => lines.push(line));
  try {
    startLoopStallWatch(150, 20);
    await new Promise(resolve => setTimeout(resolve, 60));
    heldStep(routeSource("GET", "/api/bots?messages=3"), () => spin(300));
    await new Promise(resolve => setTimeout(resolve, 80));
  } finally { stopLoopStallWatch(); setObserveSink(); }
  const stalls = lines.filter(line => line.startsWith("[loop] stall"));
  expect(stalls.length).toBe(1);
  expect(stalls[0]).toMatch(/holder=route:GET \/api\/bots:\d{3}ms/);
  expect(stalls[0]).not.toMatch(/unknown|unattributed/);
});

it("with nothing named the holder is unknown (what the route step removes)", () => {
  expect(stallHolderText(new Map())).toBe("holder=unknown");
});

it("the server runs every request body and every json() stringify inside a step named for its route", () => {
  const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
  expect(source).toMatch(/ioBudget\.withSource\(source, \(\) => heldStep\(source, \(\) => handleRequest\(req, res\)\)\)/);
  // json() numbers, projects and stringifies the answer inside the route's step; only writing the bytes happens after it.
  const jsonBody = source.match(/function json\(res: ServerResponse, status: number, body: unknown\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  expect(jsonBody).toMatch(/const data = heldStep\(routeNames\.get\(res\) \?\? "route:json", \(\) => \{[\s\S]*?return JSON\.stringify\([\s\S]*?\}\);[\s\S]*res\.end\(data\);/);
  expect(jsonBody.split("JSON.stringify(").length).toBe(2);
  const events = readFileSync(fileURLToPath(new URL("./harness/event-log.ts", import.meta.url)), "utf8");
  expect(events).toMatch(/heldStep\("events\.prune", \(\) => pruneFile\(/);
});
