// SV0-core (owner: core): stale `expect` is a 409 and nothing changes; each accepted write leaves one journal receipt.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { checkExpect, receiptFor, receiptValues, takeExpectEnvelope } from "./expect-guard.ts";
import { openJournal } from "./journal.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });

describe("SV0-core expect guard", () => {
  it("takes expect and changeId out of the body and refuses a bad shape", () => {
    const body: Record<string, unknown> = { name: "Ada", expect: { name: "Old" }, changeId: "c1" };
    const taken = takeExpectEnvelope(body);
    expect(taken).toEqual({ envelope: { expect: { name: "Old" }, changeId: "c1" } });
    expect(body).toEqual({ name: "Ada" });
    expect(takeExpectEnvelope({ expect: [1] })).toEqual({ error: expect.stringContaining("expect") });
    expect(takeExpectEnvelope({ changeId: "" })).toEqual({ error: expect.stringContaining("changeId") });
  });

  it("a value that is no longer the live one is a 409 SETTING_CHANGED naming the field; a current value and no expect pass", () => {
    const live = { name: "Ada", model: { id: "m1" } };
    expect(checkExpect(live, { expect: { name: "Ada", model: { id: "m1" } } })).toEqual({ ok: true });
    expect(checkExpect(live, {})).toEqual({ ok: true });
    const stale = checkExpect(live, { expect: { name: "Old", model: { id: "m1" } } }, { bot: "b1" });
    expect(stale.ok).toBe(false);
    if (!stale.ok) { expect(stale.status).toBe(409); expect(stale.body).toMatchObject({ code: "SETTING_CHANGED", stale: ["name"] }); }
    expect(checkExpect(live, { expect: { gone: 1 } }).ok).toBe(false);
  });

  it("an accepted write leaves one receipt, a retry with the same changeId is still one row, and no changeId writes none", () => {
    const dir = mkdtempSync(join(tmpdir(), "expect-guard-"));
    dirs.push(dir);
    const journal = openJournal(dir);
    receiptFor(journal, { changeId: "c1" }, { writer: "bot.patch", settingId: "bot.name", bot: "b1", before: { name: "Old" }, after: { name: "Ada" } });
    receiptFor(journal, { changeId: "c1" }, { writer: "bot.patch", settingId: "bot.name", bot: "b1", before: { name: "Old" }, after: { name: "Ada" } });
    receiptFor(journal, {}, { writer: "bot.patch", settingId: "bot.name" });
    receiptFor(journal, { changeId: "c2" }, { writer: "not.in.table", settingId: "x" });
    const rows = journal.list(0).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ changeId: "c1", actor: { kind: "owner" }, bot: "b1", after: { name: "Ada" } });
  });

  it("a receipt carries only fields that were both shown and changed", () => {
    const record = { purpose: "new text", persona: "secret persona", name: "Ada" };
    expect(receiptValues(record, { purpose: "old", persona: "x" }, { purpose: "new text" })).toEqual({ purpose: "new text" });
    expect(receiptValues(record, { persona: "x" }, { purpose: "new text" })).toBeUndefined();
    expect(receiptValues(record, undefined, { purpose: "new text" })).toBeUndefined();
  });

  it("the bot PATCH and PUT /api/config check expect before their first write and journal after the commit", () => {
    const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const bot = index.indexOf("const patchEnvelope = takeExpectEnvelope(body);");
    const botCheck = index.indexOf("checkExpect(existingBot as unknown as Record<string, unknown>, patchEnvelope.envelope");
    const botWrite = index.indexOf("store.patchBot(patchBotId, level.patch ?? patch", botCheck);
    const botReceipt = index.indexOf("receiptFor(settingsJournal, patchEnvelope.envelope", botCheck);
    expect(bot).toBeGreaterThan(0);
    expect(botCheck).toBeGreaterThan(bot);
    expect(botWrite).toBeGreaterThan(botCheck);
    expect(botReceipt).toBeGreaterThan(botWrite);
    // re-read after the awaits, right before the level's final no-await check
    const lateBot = index.indexOf("const lateStale = checkExpect(liveBeforeWrite", botCheck);
    expect(lateBot).toBeGreaterThan(botCheck);
    expect(lateBot).toBeLessThan(botWrite);
    expect(index.indexOf("// The level's final check: no await from here to the write (UX-TRUST-L1B section 1).", lateBot)).toBeGreaterThan(lateBot);
    const lateCfg = index.indexOf("const lateStale = checkExpect(cfg as unknown");
    expect(lateCfg).toBeGreaterThan(0);
    expect(index.indexOf("change = commitEngineChange(engineChangeHost, [], mode, () => {", lateCfg)).toBeGreaterThan(lateCfg);
    expect(index.indexOf("change = commitEngineChange(engineChangeHost, [], mode, () => {", lateCfg) - lateCfg).toBeLessThan(400);
    // the Telegram token replacement answers 200 before the final receipt: it writes its own
    expect(index).toContain('settingId: "config.telegram"');
    const cfgTake = index.indexOf("const configEnvelope = ");
    const cfgCheck = index.indexOf("checkExpect(cfg as unknown as Record<string, unknown>, configEnvelope.envelope)");
    const cfgParse = index.indexOf("const patch = parseConfigPatch(body);", cfgTake);
    const cfgReceipt = index.indexOf("receiptFor(settingsJournal, configEnvelope.envelope", cfgCheck);
    expect(cfgTake).toBeGreaterThan(0);
    expect(cfgCheck).toBeGreaterThan(cfgTake);
    expect(cfgParse).toBeGreaterThan(cfgCheck);
    expect(cfgReceipt).toBeGreaterThan(cfgParse);
  });
});
