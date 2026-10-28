// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Section 7: restore lands every binding in restored_unverified (F23) and keeps receipts; the package export carries emailIntent "was-on"
// and never the bot's own bound address (descriptions, routine prompts, skill bytes). The backup sanitize test lives with the snapshot suite.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EmailStore } from "./email-store.ts";
import { prepareRestoredEmail } from "./restore.ts";
import { BOT_EMAIL_PLACEHOLDER, registerBotEmailAddressLookup, scrubEmailBytes } from "./export-scrub.ts";
import { createBotPackageExport } from "../package-export.ts";
import { parseBotPackage } from "../bot-package.ts";
import type { BotRecord } from "../store.ts";
import type { Routine } from "../routines.ts";

afterEach(() => registerBotEmailAddressLookup(() => null));

describe("restore (F23)", () => {
  it("live bindings wait for Reconnect, a removal stays a removal, receipts stay, the old cursor goes", () => {
    const db = new DatabaseSync(":memory:");
    const store = new EmailStore(db);
    const base = { inboxId: "ibx_1", address: "a@murage.email", username: "a", displayName: "A", emailKeyRef: "k", fluxAccountId: null, step: null, opId: null, opStartedAt: null, policy: "auto" as const, failure: null, updatedAt: 1 };
    store.insertBinding({ ...base, botId: "b1", state: "active" });
    store.insertBinding({ ...base, botId: "b2", inboxId: "ibx_2", state: "remove_requested" });
    store.setCursor("events", "c-old", 1); store.setCursor("install-id", "inst", 1);
    expect(prepareRestoredEmail(db)).toBe(1);
    expect(store.getBinding("b1")!.state).toBe("restored_unverified");
    expect(store.getBinding("b2")!.state).toBe("remove_requested");
    expect(store.getCursor("events")).toBeNull();
    expect(store.getCursor("install-id")).toBe("inst");
    expect(prepareRestoredEmail(new DatabaseSync(":memory:"))).toBe(0);
  });
  it("the restore preparation runs it inside its transaction", () => {
    const source = readFileSync(join(import.meta.dirname, "..", "installation-restore-preparation.ts"), "utf8");
    expect(source.indexOf("prepareRestoredEmail(db)")).toBeGreaterThan(source.indexOf("pauseRestoredMemory(db)"));
    expect(source.indexOf("prepareRestoredEmail(db)")).toBeLessThan(source.indexOf('db.exec("COMMIT")', source.indexOf("prepareRestoredEmail(db)") - 2000));
  });
});

describe("package export scrub (Astra 15)", () => {
  const bot = { id: "b1", name: "Juniper", threadId: "t-b1", description: "Writes from Juniper@Murage.email to clients.", color: "blue", section: "General" } as unknown as BotRecord;
  const routine = { id: "r1", name: "Digest", botId: "b1", prompt: "Mail the digest from juniper@murage.email every Monday.", runOn: "cloud", schedule: { type: "once", at: 1900000000000 }, durationMinutes: 30 } as unknown as Routine;
  it("description and routine prompt carry the placeholder; the agent says emailIntent was-on; no address anywhere", () => {
    registerBotEmailAddressLookup(id => (id === "b1" ? "juniper@murage.email" : null));
    const document = createBotPackageExport({ name: "Team", bots: [bot], groups: [], routines: [routine], selection: { botIds: ["b1"], playbookKeys: [], routineIds: ["r1"] } });
    const text = JSON.stringify(document);
    expect(text.toLowerCase()).not.toContain("juniper@murage.email");
    expect(document.package.agents[0]).toMatchObject({ emailIntent: "was-on", description: `Writes from ${BOT_EMAIL_PLACEHOLDER} to clients.` });
    expect(text).toContain(BOT_EMAIL_PLACEHOLDER);
    expect(parseBotPackage(JSON.parse(text)).package.agents[0]!.emailIntent).toBe("was-on");
  });
  it("email off or unbound: the export is exactly as before", () => {
    const document = createBotPackageExport({ name: "Team", bots: [bot], groups: [], routines: [routine], selection: { botIds: ["b1"], playbookKeys: [], routineIds: ["r1"] } });
    expect(document.package.agents[0]!.emailIntent).toBeUndefined();
    expect(document.package.agents[0]!.description).toBe(bot.description);
  });
  it("skill bytes: UTF-8 text is rewritten, binary bytes are left as they are", () => {
    expect(scrubEmailBytes(Buffer.from("reply as JUNIPER@murage.email"), "juniper@murage.email").toString()).toBe(`reply as ${BOT_EMAIL_PLACEHOLDER}`);
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x6a]);
    expect(scrubEmailBytes(binary, "juniper@murage.email")).toBe(binary);
    const source = readFileSync(join(import.meta.dirname, "..", "skills.ts"), "utf8");
    expect(source).toContain("scrubEmailBytes(bytes, address)");
  });
});
