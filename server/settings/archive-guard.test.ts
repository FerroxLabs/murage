// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 C6: archiving a bot that has saved app choices needs the revision the owner reviewed.
import { describe, expect, it } from "vitest";

import { botAccessPolicy, type AccessRole } from "../bot-access-role.ts";
import { checkArchiveRevision } from "./archive-guard.ts";

type Bot = AccessRole & { connectedAppAccess?: ReturnType<typeof botAccessPolicy> };
const plain: Bot = { id: "b1", section: "Ops" };
const withChoices = (revision: number): Bot => {
  const bot: Bot = { ...plain };
  return { ...bot, connectedAppAccess: { ...botAccessPolicy(bot), mode: "restricted", allowWrites: false, revision } };
};

describe("checkArchiveRevision", () => {
  it("passes a bot with no saved choices, with or without a revision", () => {
    expect(checkArchiveRevision(plain, { hidden: true })).toEqual({ ok: true });
    expect(checkArchiveRevision(plain, { hidden: true, accessRevision: 0 })).toEqual({ ok: true });
  });
  it("passes a bot with saved choices when the current revision is named", () => {
    expect(checkArchiveRevision(withChoices(3), { hidden: true, accessRevision: 3 })).toEqual({ ok: true });
  });
  it("answers 409 for a missing or stale revision, naming the bot", () => {
    for (const body of [{ hidden: true }, { hidden: true, accessRevision: 2 }, { hidden: true, accessRevision: "3" }]) {
      expect(checkArchiveRevision(withChoices(3), body)).toMatchObject({ ok: false, status: 409, body: { code: "ACCESS_CHANGED", botId: "b1" } });
    }
  });
  it("never blocks restoring, or archiving a bot that is already archived", () => {
    expect(checkArchiveRevision(withChoices(3), { hidden: false })).toEqual({ ok: true });
    expect(checkArchiveRevision({ ...withChoices(3), hidden: true }, { hidden: true })).toEqual({ ok: true });
  });
});
