// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { wipeTargets, wipeWhatsAppData } from "./wipe.ts";

let data: string;
beforeEach(() => { data = mkdtempSync(join(tmpdir(), "murage-wa-wipe-")); });
afterEach(() => { rmSync(data, { recursive: true, force: true }); });

function seed(connectionId: string) {
  for (const dir of ["whatsapp/auth", `whatsapp/media/${connectionId}`, `channels/whatsapp/${connectionId}`, "whatsapp/ingress", "whatsapp/outbound"]) mkdirSync(join(data, dir), { recursive: true });
  for (const file of ["whatsapp/auth/creds.bin", `whatsapp/media/${connectionId}/a.jpg`, `channels/whatsapp/${connectionId}/chat.json`,
    `whatsapp/ingress/${connectionId}.ndjson`, `whatsapp/ingress/${connectionId}.ndjson.bak`, `whatsapp/outbound/${connectionId}.json`]) writeFileSync(join(data, file), "x");
}

it("auth scope removes the bridge directories of one connection and keeps ledgers, other connections and the key", async () => {
  seed("conn-1"); seed("conn-2");
  writeFileSync(join(data, "whatsapp", "auth-key"), "k");
  await wipeWhatsAppData(data, "conn-1", "auth");
  expect(existsSync(join(data, "whatsapp/auth"))).toBe(false);
  expect(existsSync(join(data, "whatsapp/media/conn-1"))).toBe(false);
  expect(existsSync(join(data, "whatsapp/ingress/conn-1.ndjson"))).toBe(false);
  expect(existsSync(join(data, "whatsapp/ingress/conn-1.ndjson.bak"))).toBe(false);
  expect(existsSync(join(data, "whatsapp/outbound/conn-1.json"))).toBe(false);
  expect(existsSync(join(data, "channels/whatsapp/conn-1/chat.json"))).toBe(true);
  expect(existsSync(join(data, "whatsapp/media/conn-2/a.jpg"))).toBe(true);
  expect(existsSync(join(data, "whatsapp/ingress/conn-2.ndjson"))).toBe(true);
  expect(existsSync(join(data, "whatsapp/auth-key"))).toBe(true);
});

it("all scope also removes the connection's receipt ledgers", async () => {
  seed("conn-1");
  await wipeWhatsAppData(data, "conn-1", "all");
  expect(existsSync(join(data, "channels/whatsapp/conn-1"))).toBe(false);
  expect(wipeTargets(data, "conn-1", "all")).toContain(join(data, "channels", "whatsapp", "conn-1"));
});

it("a missing tree is not an error", async () => {
  await expect(wipeWhatsAppData(data, "conn-1", "all")).resolves.toBeUndefined();
});

it("refuses a connection id that could name another path", async () => {
  for (const bad of ["..", "../x", "a/b", "", "conn.1", "a".repeat(101)]) await expect(wipeWhatsAppData(data, bad, "all")).rejects.toThrow("Invalid WhatsApp connection id");
});

it("refuses to cross a symbolic link and never deletes through it", async () => {
  const outside = mkdtempSync(join(tmpdir(), "murage-wa-outside-"));
  try {
    writeFileSync(join(outside, "keep.txt"), "keep");
    mkdirSync(join(data, "channels"), { recursive: true });
    symlinkSync(outside, join(data, "channels", "whatsapp"));
    await expect(wipeWhatsAppData(data, "conn-1", "all")).rejects.toThrow("symbolic link");
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  } finally { rmSync(outside, { recursive: true, force: true }); }
});

it("a symbolic link at the leaf is removed as a link, not followed", async () => {
  const outside = mkdtempSync(join(tmpdir(), "murage-wa-outside-"));
  try {
    writeFileSync(join(outside, "keep.txt"), "keep");
    mkdirSync(join(data, "whatsapp"), { recursive: true });
    symlinkSync(outside, join(data, "whatsapp", "auth"));
    await wipeWhatsAppData(data, "conn-1", "auth");
    expect(existsSync(join(data, "whatsapp", "auth"))).toBe(false);
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  } finally { rmSync(outside, { recursive: true, force: true }); }
});
