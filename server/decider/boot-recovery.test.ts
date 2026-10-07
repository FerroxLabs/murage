// Boot recovery never calls the decision model (no network at boot). An
// owner message left without a room turn is re-queued for the responder
// `roomResponders` returns, which for an `auto` room is the saved fallback
// bot, else the first available member: the same fail-open fallback a live
// turn uses when the decider cannot decide. Interrupted running turns are
// not re-run at all; they get an "interrupted" line.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { roomResponders } from "../store.ts";

const INDEX = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
const members = [{ id: "a", name: "Atlas" }, { id: "b", name: "Milind" }, { id: "c", name: "Ghost", hidden: true }];

describe("boot recovery in an auto room", () => {
  it("picks the saved fallback, else the first available member, deterministically", () => {
    expect(roomResponders("hello", members, { kind: "auto" }, undefined, { byName: true }).map((m) => m.id)).toEqual(["a"]);
    expect(roomResponders("hello", members, { kind: "auto", fallbackBotId: "b" }, undefined, { byName: true }).map((m) => m.id)).toEqual(["b"]);
    expect(roomResponders("hello", members, { kind: "auto", fallbackBotId: "c" }, undefined, { byName: true }).map((m) => m.id)).toEqual(["a"]);
  });

  it("the boot block never reaches the decider", () => {
    const start = INDEX.indexOf("// Boot (SPEC-P 7.2)");
    const end = INDEX.indexOf("setInterval(() => {", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const boot = INDEX.slice(start, end);
    expect(boot).toContain("roomResponders(message.text, members, group.defaultResponder");
    expect(boot).not.toMatch(/autoRoomRoute|decideRoomResponder|appDecider|autoRoute/);
  });
});
