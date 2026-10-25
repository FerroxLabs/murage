// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { landingId, lastConversationKey, readLastConversation, shouldRemember, workspaceKey, writeLastConversation } from "./last-conversation";

function memory() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k), data };
}

describe("last conversation", () => {
  it("keys per workspace so a Cloud home never gets a local id", () => {
    const store = memory();
    writeLastConversation(store, workspaceKey(null), "local-bot");
    expect(readLastConversation(store, workspaceKey(null))).toBe("local-bot");
    expect(readLastConversation(store, workspaceKey("home-1"))).toBeUndefined();
    expect(lastConversationKey(workspaceKey("home-1"))).not.toBe(lastConversationKey(workspaceKey(null)));
  });
  it("remembers only once setup is finished", () => {
    expect(shouldRemember(false)).toBe(true);
    expect(shouldRemember(true)).toBe(false);
    expect(shouldRemember(null)).toBe(false);
    expect(shouldRemember(undefined)).toBe(false);
  });
  it("survives storage that throws", () => {
    const broken = { getItem() { throw new Error("no"); }, setItem() { throw new Error("no"); }, removeItem() { throw new Error("no"); } };
    expect(readLastConversation(broken, "local")).toBeUndefined();
    expect(() => writeLastConversation(broken, "local", "x")).not.toThrow();
  });
  it("an empty id clears the entry", () => {
    const store = memory();
    writeLastConversation(store, "local", "a");
    writeLastConversation(store, "local", "");
    expect(readLastConversation(store, "local")).toBeUndefined();
  });
  it("landing order: held selection, then resume, then fallback", () => {
    const known = (id: string) => ["a", "b", "chief"].includes(id);
    const base = { known, resumable: known, fallback: "chief" };
    expect(landingId({ ...base, selectedId: "a", resumeId: "b" })).toBe("a");
    expect(landingId({ ...base, selectedId: "", resumeId: "b" })).toBe("b");
    expect(landingId({ ...base, selectedId: "", resumeId: "zzz" })).toBe("chief");
    expect(landingId({ ...base, selectedId: "" })).toBe("chief");
  });
});

import { idToSaveOnSetupView } from "./last-conversation";

describe("saving when setup finishes", () => {
  it("saves the open conversation once firstRun turns false, and not before", () => {
    expect(idToSaveOnSetupView({ firstRun: false }, true, "bot-1")).toBe("bot-1");
    expect(idToSaveOnSetupView({ firstRun: true }, true, "bot-1")).toBeNull();
    expect(idToSaveOnSetupView({}, true, "bot-1")).toBeNull();
    expect(idToSaveOnSetupView({ firstRun: false }, false, "bot-1")).toBeNull();
    expect(idToSaveOnSetupView({ firstRun: false }, true, "")).toBeNull();
  });
});
