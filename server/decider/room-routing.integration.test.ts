// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Auto rooms end to end below the server: roomResponders (the synchronous
// fallback and mention precedence) plus decideRoomResponder (the awaited
// override), with a decider backed by an injected fetch.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { normalizeGroupDefaultResponder, roomResponders, type GroupDefaultResponder } from "../store.ts";
import { createDecider } from "./index.ts";
import { decideRoomResponder, estimateStateTokens, EVERYONE_OPTION, ROOM_ROUTING_STATE_TOKEN_BUDGET, type RoomRoutingInput } from "./room-routing.ts";
import { readDecisionModelSettings } from "./settings.ts";

const members = [
  { id: "maya", name: "Maya", title: "Product Designer", description: "UI and brand." },
  { id: "theo", name: "Theo", title: "Frontend Engineer", description: "React and CSS." },
  { id: "ravi", name: "Ravi", title: "Backend Engineer", description: "APIs and billing." },
];
const AUTO: GroupDefaultResponder = { kind: "auto", fallbackBotId: "theo" };
const LEAD: GroupDefaultResponder = { kind: "member", botId: "theo" };
const ids = (list: Array<{ id: string }>) => list.map((m) => m.id);

const input = (text: string): RoomRoutingInput => ({
  room: "#launch", humans: ["Milind (owner)"], members, recent: [{ from: "Maya", text: "mockups are done" }], message: { from: "Milind", text },
});

function deciderWith(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>) {
  return createDecider({
    settings: () => readDecisionModelSettings({ enabled: true, jobs: { roomRouting: true } }),
    credential: () => "sk-flux-test",
    fetch: fetchImpl as unknown as typeof fetch,
    dataDir: join(process.env.TMPDIR ?? "/tmp", "murage-decider-int-test"),
  });
}
const answering = (probabilities: Record<string, number>) => {
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
  return vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ answers: { answer: { type: "choice", choice, probabilities } } }), { status: 200 }));
};

describe("auto room: the synchronous result", () => {
  it("a mention, a name or a reply still wins over auto", () => {
    expect(ids(roomResponders("@Ravi check the webhook", members, AUTO))).toEqual(["ravi"]);
    expect(ids(roomResponders("Maya, can you look?", members, AUTO, undefined, { byName: true }))).toEqual(["maya"]);
    expect(ids(roomResponders("thanks", members, AUTO, "ravi"))).toEqual(["ravi"]);
  });

  it("with nothing addressed it equals lead mode exactly (fail-open parity)", () => {
    for (const text of ["the navbar overlaps", "anyone around?", ""]) {
      expect(roomResponders(text, members, AUTO, undefined, { byName: true })).toEqual(roomResponders(text, members, LEAD, undefined, { byName: true }));
    }
  });

  it("falls back to the first member when no fallback is set or it left the room", () => {
    expect(ids(roomResponders("hello", members, { kind: "auto" }))).toEqual(["maya"]);
    expect(normalizeGroupDefaultResponder({ kind: "auto", fallbackBotId: "gone" }, ["maya"])).toEqual({ kind: "auto" });
    expect(normalizeGroupDefaultResponder({ kind: "auto", fallbackBotId: "maya" }, ["maya"])).toEqual({ kind: "auto", fallbackBotId: "maya" });
  });
});

describe("auto room: the awaited override", () => {
  it("a confident member answer routes there", async () => {
    const route = await decideRoomResponder(deciderWith(answering({ maya: 0.93, theo: 0.04, ravi: 0.02, [EVERYONE_OPTION]: 0.01 })), input("new icon set please"));
    expect(route).toEqual({ kind: "member", botId: "maya", probability: 0.93 });
  });

  it("__everyone__ at p >= 0.6 routes to all", async () => {
    const route = await decideRoomResponder(deciderWith(answering({ maya: 0.05, theo: 0.05, ravi: 0.05, [EVERYONE_OPTION]: 0.85 })), input("each of you give me a status"));
    expect(route).toMatchObject({ kind: "everyone" });
  });

  it("p < 0.6 -> fallback (lead-mode result stands)", async () => {
    const route = await decideRoomResponder(deciderWith(answering({ maya: 0.4, theo: 0.35, ravi: 0.2, [EVERYONE_OPTION]: 0.05 })), input("hmm"));
    expect(route).toEqual({ kind: "fallback", reason: "low_confidence" });
  });

  it("backend down, rejected, slow or not enabled -> fallback, never a throw", async () => {
    const down = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    expect(await decideRoomResponder(deciderWith(down), input("hi"))).toMatchObject({ kind: "fallback", reason: "unreachable" });
    const refused = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 403 }));
    expect(await decideRoomResponder(deciderWith(refused), input("hi"))).toMatchObject({ kind: "fallback", reason: "disabled" });
    const hang = vi.fn<typeof fetch>((_u, init) => new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    expect(await decideRoomResponder(deciderWith(hang), input("hi"), { timeoutMs: 50 })).toMatchObject({ kind: "fallback", reason: "timeout" });
    const off = vi.fn<typeof fetch>();
    const disabled = createDecider({ settings: () => readDecisionModelSettings(undefined), fetch: off as unknown as typeof fetch });
    expect(await decideRoomResponder(disabled, input("hi"))).toMatchObject({ kind: "fallback", reason: "disabled" });
    expect(off).not.toHaveBeenCalled();
  });

  it("a one-member room never asks", async () => {
    const f = answering({ maya: 1 });
    expect(await decideRoomResponder(deciderWith(f), { ...input("hi"), members: members.slice(0, 1) })).toEqual({ kind: "fallback", reason: "no_choice" });
    expect(f).not.toHaveBeenCalled();
  });

  it("sends a bounded state that fits Flux's 2,048 token limit", async () => {
    const f = answering({ maya: 0.9, theo: 0.05, ravi: 0.03, [EVERYONE_OPTION]: 0.02 });
    const recent = Array.from({ length: 60 }, (_v, i) => ({ from: "Maya", text: `${i} ${"x".repeat(480)}` }));
    await decideRoomResponder(deciderWith(f), { ...input("y".repeat(20_000)), recent });
    const body = JSON.parse(String(f.mock.calls[0]![1]?.body));
    expect(estimateStateTokens(body.state)).toBeLessThanOrEqual(ROOM_ROUTING_STATE_TOKEN_BUDGET);
    expect(ROOM_ROUTING_STATE_TOKEN_BUDGET).toBeLessThan(2_048);
    expect(body.state.new_message.text.length).toBeLessThanOrEqual(1_500);
    expect(body.state.recent_messages.at(-1).text).toContain("x");
  });
});

// Live eval, spends real money: MURAGE_DECIDE_LIVE_EVAL=1 FLUX_API_KEY=sk-flux-... pnpm exec vitest run server/decider/room-routing.integration.test.ts
// Skipped by default, on purpose.
const LIVE = process.env.MURAGE_DECIDE_LIVE_EVAL === "1";
describe.skipIf(!LIVE)("live eval against Flux /v1/decide", () => {
  it("routes the bench's labelled messages", async () => {
    const fixture = JSON.parse(readFileSync(join(process.env.MURAGE_DECIDE_FIXTURE ?? "/Volumes/Scratch/work/clef-conformance/room-routing.json"), "utf8")) as {
      rooms: Record<string, { name: string; humans: string[]; members: RoomRoutingInput["members"] }>;
      items?: Array<{ room: string; text: string; from?: string; expected?: string }>;
    };
    const decider = createDecider({ settings: () => readDecisionModelSettings({ enabled: true, jobs: { roomRouting: true } }) });
    const items = fixture.items ?? [];
    let scored = 0, right = 0;
    for (const item of items) {
      const room = fixture.rooms[item.room];
      if (!room || !item.expected || item.expected === "nobody") continue;
      const route = await decideRoomResponder(decider, { room: room.name, humans: room.humans, members: room.members, recent: [], message: { from: item.from ?? "owner", text: item.text } });
      if (route.kind === "fallback") continue;
      scored++;
      if ((route.kind === "member" ? route.botId : "everyone") === item.expected) right++;
    }
    console.log(`live eval: ${right}/${scored} confident answers correct`);
    expect(scored === 0 || right / scored >= 0.9).toBe(true);
  }, 300_000);
});
