// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ChannelSendError } from "../durable-delivery.ts";
import { CLOUD_API_CAPABILITIES, CLOUD_API_MESSAGE, CLOUD_API_NOT_AVAILABLE, CloudApiNotAvailable, CloudApiTransport } from "./cloud-transport.ts";
import { WhatsAppService } from "./service.ts";

it("describes what the official route could do without pretending it can do it today", () => {
  expect(CLOUD_API_CAPABILITIES).toEqual({ linking: "token", groups: false, presence: false, readReceipts: false, lidResolution: false, ownSendEcho: false });
});
it("refuses to start or link with a clear not-available-yet error, and every send fails as unavailable", async () => {
  const t = new CloudApiTransport();
  await expect(t.start({ onEnvelope: () => {}, onHealth: () => {} })).rejects.toBeInstanceOf(CloudApiNotAvailable);
  await expect(t.link()).rejects.toThrow(CLOUD_API_MESSAGE);
  expect(new CloudApiNotAvailable().code).toBe(CLOUD_API_NOT_AVAILABLE);
  await expect(t.reserve()).rejects.toBeInstanceOf(ChannelSendError);
  await expect(t.sendText()).rejects.toMatchObject({ code: "unavailable", uncertain: false });
  expect(t.self()).toBeNull();
  await expect(t.resolve.pnForLid("1@lid")).resolves.toBeUndefined();
  await t.stop(); await t.unlink();
  const loose = t as unknown as Record<string, unknown>;
  expect(loose.groups).toBeUndefined(); expect(loose.sendAudio).toBeUndefined();
});
it("has no network code and copy that is honest about being a later option", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./cloud-transport.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/\bfetch\s*\(|node:https?|node:net|node:tls|graph\.facebook/);
  expect(CLOUD_API_MESSAGE).toMatch(/not available yet/);
  expect(CLOUD_API_MESSAGE).not.toMatch(/—|\bsafe|\bsafety|\bunsafe/i);
});
it("the service on the cloud backend says so and changes nothing on disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murage-wa-cloud-"));
  try {
    const transport = vi.fn(() => new CloudApiTransport()), wipeData = vi.fn(async () => {});
    const service = new WhatsAppService({
      dataDir: dir, chosen: { chiefBotId: "chief" }, backend: () => "cloud-api", transport, authKey: { get: async () => "ef".repeat(32) },
      settings: () => ({ mode: "self-chat", allowFrom: [], groups: { policy: "disabled", allow: [], senders: "members" }, readReceipts: false, quoteReplies: "off" }),
      isCurrentChief: () => true, people: { linkContact: async () => ({ personId: "p" }) }, runs: () => ({ enqueue: () => ({ id: "r" }), result: () => null }),
      revokeRuns: async () => {}, wipeData, addAllowFrom: () => {},
    });
    await expect(service.link({ method: "qr" })).rejects.toThrow(CLOUD_API_MESSAGE);
    expect(service.status()).toMatchObject({ state: "blocked", error: CLOUD_API_NOT_AVAILABLE, linked: false });
    await service.resume();
    expect(service.status()).toMatchObject({ state: "blocked", error: CLOUD_API_NOT_AVAILABLE });
    expect(transport).not.toHaveBeenCalled(); expect(wipeData).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
