// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { Store } from "../store.ts";
import { teamIdFor } from "../team-identities.ts";
import { bindHumanThread, linkHumanBinding, observeVerifiedHuman, resolveHumanBinding } from "../human-principals.ts";
import { ownerMemoryTicket } from "../memory/authority.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { isDirectOwnerThread } from "./direct-thread.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

function fixture() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const iris = store.createBot(), carl = store.createBot();
  return { store, iris, carl, db: database() };
}

describe("isDirectOwnerThread", () => {
  it("the bot's main thread and a plain extra task are the owner's direct threads", () => {
    const { store, iris, db } = fixture();
    expect(isDirectOwnerThread(store, db, iris.id, iris.threadId)).toBe(true);
    const task = store.createTask(iris.id, "Plain", false)!;
    expect(isDirectOwnerThread(store, db, iris.id, task.threadId)).toBe(true);
  });
  it("an unknown bot or thread is false", () => {
    const { store, iris, db } = fixture();
    expect(isDirectOwnerThread(store, db, "nope", iris.threadId)).toBe(false);
    expect(isDirectOwnerThread(store, db, iris.id, "nope")).toBe(false);
  });
  it("another bot's thread is false", () => {
    const { store, iris, carl, db } = fixture();
    expect(isDirectOwnerThread(store, db, iris.id, carl.threadId)).toBe(false);
  });
  it("a room's thread and a room's task are false", () => {
    const { store, iris, carl, db } = fixture();
    const room = store.createGroup("room", [iris.id, carl.id], false, "");
    expect(isDirectOwnerThread(store, db, iris.id, room.threadId)).toBe(false);
  });
  it("a shared work task is false", () => {
    const { store, iris, db } = fixture();
    const work = store.createSharedWorkTask(iris.id, teamIdFor("Sales"))!;
    expect(isDirectOwnerThread(store, db, iris.id, work.threadId)).toBe(false);
  });
  it("a channel project desk task is false", () => {
    const { store, iris, db } = fixture();
    const desk = store.createTask(iris.id, "Desk", false, { groupId: "some-room" })!;
    expect(isDirectOwnerThread(store, db, iris.id, desk.threadId)).toBe(false);
  });
  it("a thread bound to another human is false", () => {
    const { store, iris, db } = fixture();
    const bindingId = observeVerifiedHuman({ platform: "slack", connectionId: "fixture-connection", authorityId: "TEAM", userId: "U-CONTACT" });
    linkHumanBinding(ownerMemoryTicket(), { bindingId, expectedRevision: 1, as: "person" });
    const task = store.createTask(iris.id, "Channel conversation", false)!;
    bindHumanThread(task.threadId, resolveHumanBinding(bindingId));
    expect(isDirectOwnerThread(store, db, iris.id, task.threadId)).toBe(false);
  });
});
