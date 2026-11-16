// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({ current: {} as { decider?: { enabled?: boolean; jobs?: { roomRouting?: boolean }; byoKey?: string } } }));
vi.mock("../config.ts", async (importOriginal) => ({ ...await importOriginal<typeof import("../config.ts")>(), loadConfig: () => config.current }));

import { roomResponders } from "../store.ts";
import { createDecider } from "./index.ts";
import { resetDeciderAvailability } from "./availability.ts";
import { resetPrivacyLatch } from "./flux.ts";
import { decideRoomResponder } from "./room-routing.ts";

const members = [{ id: "maya", name: "Maya" }, { id: "theo", name: "Theo" }];
const input = { room: "Synthetic Room", humans: ["Synthetic Owner"], members,
  recent: [{ from: "Synthetic Owner", text: "Synthetic recent message" }],
  message: { from: "Synthetic Owner", text: "Please review this" } };
const response = () => new Response(JSON.stringify({ answers: { answer: {
  type: "choice", choice: "maya", probabilities: { maya: 0.9, theo: 0.08, __everyone__: 0.02 },
} } }), { status: 200, headers: { "x-flux-no-retain": "applied" } });

afterEach(() => { config.current = {}; resetDeciderAvailability(); resetPrivacyLatch(); });

it("ROOM-ROUTING-CONSENT fresh choices keep Auto local with or without a key", async () => {
  for (const stored of [undefined, {}, { byoKey: "synthetic-own-key" }, { enabled: true }, { jobs: { roomRouting: true } }, { enabled: false, jobs: { roomRouting: true } }, { enabled: true, jobs: { roomRouting: false } }]) {
    for (const key of ["synthetic-account-key", null]) {
      config.current = stored ? { decider: stored } : {};
      const transport = vi.fn<typeof fetch>().mockImplementation(async () => response());
      const decider = createDecider({ credential: () => key, fetch: transport });
      const local = roomResponders(input.message.text, members, { kind: "auto", fallbackBotId: "theo" });
      const route = await decideRoomResponder(decider, input);
      expect(transport).toHaveBeenCalledTimes(0);
      expect(route.kind).toBe("fallback");
      expect(local.map((member) => member.id)).toEqual(["theo"]);
      expect(roomResponders(input.message.text, members, { kind: "auto" }).map((member) => member.id)).toEqual(["maya"]);
    }
  }
});

it("ROOM-ROUTING-CONSENT saving explicit ON sends exactly one request across the consent transition", async () => {
  const transport = vi.fn<typeof fetch>().mockImplementation(async () => response());
  const decider = createDecider({ credential: () => "synthetic-account-key", fetch: transport });
  await decideRoomResponder(decider, input);
  config.current = { decider: { enabled: true, jobs: { roomRouting: true } } };
  expect(await decideRoomResponder(decider, input)).toEqual({ kind: "member", botId: "maya", probability: 0.9 });
  expect(transport).toHaveBeenCalledTimes(1);
  expect(String(transport.mock.calls[0]![0])).toBe("https://api.fluxrouter.ai/v1/decide");
  const body = JSON.parse(String(transport.mock.calls[0]![1]?.body));
  expect(body.state.new_message).toEqual(input.message);
  expect(body.state.recent_messages).toEqual(input.recent);
});
