// The Engines settings page renders ClaudeAccountsSettings under every engine
// row. When GET /api/claude-accounts answered without an `accounts` array the
// section threw during render (`accounts.find` on undefined), React unmounted
// the whole tree, and an Enable click in the same settings page landed on a
// button that had just been detached (RED2F, desktop-capabilities human spec).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeAccountsAfterChange, claudeAccountsFrom, claudeAccountsListOrder, type ClaudeAccount } from "./ClaudeAccountsSettings";

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

  // CLAC1 adds a second writer: a successful change's own receipt. It still
  // passes through a validator, so this pins both writers instead of one.
  it("stores what the server sent only through a validator", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ClaudeAccountsSettings.tsx"), "utf8");
    const setters = source.match(/setAccounts\([^;]*;/g) ?? [];
    // CLAC2 reads the list body into `payload` so a stale answer is dropped first.
    expect(source).toContain(`const payload = await api("/api/claude-accounts");`);
    expect(setters).toEqual([
      `setAccounts(claudeAccountsFrom(payload));`,
      `setAccounts(current => claudeAccountsAfterChange(current, method, id, receipt));`,
    ]);
  });
});

// POST and PATCH answer with the account after a full engine probe. The list
// refresh that follows re-probes every engine, so drawing only after it left a
// created account missing for seconds under "Account added" (CLAC1, RED2F
// verifier). The receipt is applied first; the refresh still reconciles.
describe("claudeAccountsAfterChange", () => {
  const fixture: ClaudeAccount = { ...account, instanceId: "verification", displayName: "Verification fixture", managed: false, configDir: "" };
  const personal: ClaudeAccount = { ...account, instanceId: "claude-personal", displayName: "Personal", configDir: "/fixture/claude-personal" };

  it("adds a created account from its receipt", () => {
    expect(claudeAccountsAfterChange([fixture], "POST", undefined, { account })).toEqual([fixture, account]);
  });

  it("replaces rather than duplicates an account the list already holds", () => {
    const refreshed = { ...account, snapshot: { state: "available" as const, authenticated: false } };
    expect(claudeAccountsAfterChange([fixture, account], "POST", undefined, { account: refreshed })).toEqual([fixture, refreshed]);
  });

  it("renames in place from a saved receipt", () => {
    const renamed = { ...account, displayName: "Work renamed" };
    expect(claudeAccountsAfterChange([fixture, account, personal], "PATCH", "claude-work", { account: renamed })).toEqual([fixture, renamed, personal]);
  });

  it("drops a removed account once the server confirms the removal", () => {
    expect(claudeAccountsAfterChange([fixture, account, personal], "DELETE", "claude-work", { removed: true, credentialsRetained: true })).toEqual([fixture, personal]);
  });

  it.each([
    ["a create receipt without an account", "POST", undefined, {}],
    ["a create receipt whose account has no id", "POST", undefined, { account: { displayName: "Work" } }],
    ["a save receipt for a different account", "PATCH", "claude-personal", { account }],
    ["a save receipt that is a proxy page", "PATCH", "claude-work", "<!doctype html>"],
    ["a removal without confirmation", "DELETE", "claude-work", { removed: false }],
    ["a null receipt", "DELETE", "claude-work", null],
  ])("keeps the drawn list for %s and leaves it to the refresh", (_name, method, id, receipt) => {
    const accounts = [fixture, account];
    expect(claudeAccountsAfterChange(accounts, method, id, receipt)).toBe(accounts);
  });
});

// A list answer and a change receipt both draw the section. A slow first list
// (or a Refresh) that answered after a create used to redraw the older list over
// the receipt's row (CLAC1 verifier, CLAC2). The human spec holds real GETs;
// these pin the ordering rule itself.
describe("claudeAccountsListOrder", () => {
  it("draws a list requested after the latest change", () => {
    const order = claudeAccountsListOrder();
    order.receipt();
    const fresh = order.request();
    expect(fresh()).toBe(true);
  });

  it("drops a list requested before a change receipt was drawn", () => {
    const order = claudeAccountsListOrder();
    const first = order.request();
    order.receipt();
    const refresh = order.request();
    expect(first()).toBe(false);
    expect(refresh()).toBe(true);
  });

  it("drops a list overtaken by a newer list request", () => {
    const order = claudeAccountsListOrder();
    const older = order.request(), newer = order.request();
    expect(older()).toBe(false);
    expect(newer()).toBe(true);
  });

  it("keeps a stale list stale after later receipts and lists", () => {
    const order = claudeAccountsListOrder();
    const stale = order.request();
    order.receipt(); order.request(); order.receipt();
    expect(stale()).toBe(false);
  });

  it("wires every list request and every drawn receipt through the order", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ClaudeAccountsSettings.tsx"), "utf8");
    expect(source.match(/order\.request\(\)/g)).toHaveLength(1);
    expect(source).toMatch(/const fresh = order\.request\(\);\s+try \{\s+const payload = await api\("\/api\/claude-accounts"\);\s+if \(!fresh\(\)\) return;/);
    expect(source).toMatch(/order\.receipt\(\);\s+setAccounts\(current => claudeAccountsAfterChange/);
  });
});
