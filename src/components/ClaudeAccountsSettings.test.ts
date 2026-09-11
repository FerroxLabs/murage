// The Engines settings page renders ClaudeAccountsSettings under every engine
// row. When GET /api/claude-accounts answered without an `accounts` array the
// section threw during render (`accounts.find` on undefined), React unmounted
// the whole tree, and an Enable click in the same settings page landed on a
// button that had just been detached (RED2F, desktop-capabilities human spec).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeAccountsFrom, type ClaudeAccount } from "./ClaudeAccountsSettings";

const account: ClaudeAccount = {
  instanceId: "claude-work", displayName: "Work", managed: true, isDefault: false,
  configDir: "/fixture/claude-work", signInCommand: "claude login", signInShell: "sh",
};
const unreadable = "Could not read the Claude account list. Use Refresh accounts to try again.";

describe("claudeAccountsFrom", () => {
  it("returns the desktop server's account list unchanged", () => {
    expect(claudeAccountsFrom({ accounts: [account] })).toEqual([account]);
    expect(claudeAccountsFrom({ accounts: [] })).toEqual([]);
  });

  it.each([
    ["an unrelated success body", { calls: [] }],
    ["an error body sent with 200", { error: "Unexpected body" }],
    ["a non-array list", { accounts: "claude-work" }],
    ["an entry without an id", { accounts: [{ displayName: "Work" }] }],
    ["a null entry", { accounts: [null] }],
    ["null", null],
    ["a proxy page", "<!doctype html>"],
  ])("rejects %s with a readable error instead of an undefined list", (_name, payload) => {
    expect(() => claudeAccountsFrom(payload)).toThrow(unreadable);
  });

  it("is the only way the section stores what the server sent", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ClaudeAccountsSettings.tsx"), "utf8");
    const setters = source.match(/setAccounts\([^;]*;/g) ?? [];
    expect(setters).toEqual([`setAccounts(claudeAccountsFrom(await api("/api/claude-accounts")));`]);
  });
});
