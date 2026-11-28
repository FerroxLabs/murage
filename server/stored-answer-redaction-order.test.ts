// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { afterAll, expect, it } from "vitest";
import { Store } from "./store.ts";
import { closeDatabase } from "./database.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";
import { recordDelegationReceipt, findDelegationReceipt } from "./delegations.ts";
import { released } from "./testing/released.ts";
import { handDownStatus, ANSWER_MAX_CHARS } from "./voice/hand-downs.ts";

afterAll(() => { stopWalMaintenance(); closeDatabase(); });

it.each([4000, ANSWER_MAX_CHARS])("masks a 13,000-character stored answer before the %i character hand-off cut", (cut) => {
  const store = new Store(() => ({ instanceId: "claude", model: "fixture" }));
  const bot = store.createBot({}, { seedMessages: false });
  const owner = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "fixture request" });
  const secret = "gh" + "p_" + "q".repeat(36);
  const prefix = ".".repeat(cut - 10);
  const raw = (prefix + secret).padEnd(13_000, ".");
  expect(raw).toHaveLength(13_000);
  const row = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: raw });
  expect(row.text).not.toContain(secret.slice(0, 10));
  expect(row.text).not.toContain(secret.slice(-10));
  expect(row.text).toContain("redacted");
  const status = handDownStatus({ id: "fixture", request: owner.text!, at: owner.at, state: "accepted" }, store.messagesFor(bot.threadId), false);
  expect(status.kind).toBe("done");
  if (status.kind !== "done") throw new Error("missing finished answer");
  expect(status.answer.length).toBeLessThanOrEqual(ANSWER_MAX_CHARS);
  expect(status.answer).not.toContain(secret.slice(0, 10));
  expect(status.answer).not.toContain(secret.slice(-10));
  expect(recordDelegationReceipt({ id: `fixture-${cut}`, sourceThreadId: bot.threadId, toBotId: bot.id, toBotName: "Fixture", status: "done", result: released(row.text!) })).toBe(true);
  const receipt = findDelegationReceipt(`fixture-${cut}`)!;
  expect(receipt.result!.length).toBeLessThanOrEqual(4000);
  expect(receipt.result).not.toContain(secret.slice(0, 10));
  expect(receipt.result).not.toContain(secret.slice(-10));
});
