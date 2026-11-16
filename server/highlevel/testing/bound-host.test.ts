// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { HighLevelHost as ProductHost } from "../host.ts";
import { highLevelHarness } from "../../testing/fake-highlevel.ts";
import { highlevelFixtureBinding } from "./release-fixture.ts";
import { closeTurnLineage } from "../../memory/lineage-write.ts";

const ping = { jsonrpc: "2.0", id: "fixture-ping", method: "ping" };

it("admits the isolated fixture without adding an implicit product binding", async () => {
  const h = highLevelHarness();
  const product = new ProductHost({ ...h, bot: () => h.bot });
  await expect(product.handle(h.claim, ping)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
  await expect(h.host.handle(h.claim, ping)).resolves.toEqual({ jsonrpc: "2.0", id: ping.id, result: {} });
});

it("preserves an explicitly revoked fixture binding", async () => {
  const h = highLevelHarness();
  const binding = highlevelFixtureBinding(h.claim);
  closeTurnLineage(binding.turn);
  await expect(h.host.handle(h.claim, ping, binding)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
});

it("does not replace an explicitly invalid binding", async () => {
  const h = highLevelHarness();
  await expect(h.host.handle(h.claim, ping, null as never)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
});
