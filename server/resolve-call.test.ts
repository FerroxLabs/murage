// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Build step 2 (APP-GRANT-DESIGN-FINAL.AGREED-r10.md): resolveCall against F4
// records (Rules 4, 8..11, 30, 31), the Rule 55 contract reader, and the
// mount-identity grant key (Rules 32, 43, 59). Rows T1..T7, T38, T64 (generic
// and shared rows), T75.

import { describe, expect, it } from "vitest";
import { actionGrantKey, resolveCall, type GrantCall } from "../shared/app-action-grant.ts";
import { isStaleGrant } from "../shared/app-action-words.ts";
import { sameToolGrant } from "../shared/connected-app-names.ts";
import { acpToolKey, type McpMountRecord } from "../shared/mount-identity.ts";
import { autoVerdict } from "./auto-approve.ts";
import { requiredFields } from "./drivers/contracts.ts";
import { classifyAsk } from "./stop-line.ts";

const own = (engineName: string, builtin: string): McpMountRecord => ({ engineName, mountId: `own:${builtin}`, provenance: "own" });
const custom = (engineName: string, registry = engineName): McpMountRecord => ({ engineName, mountId: `custom:${registry}`, provenance: "custom" });
const external = (engineName: string, digest = "0123456789abcdef"): McpMountRecord => ({ engineName, mountId: `external:codex:${digest}:${engineName}`, provenance: "external" });
const MOUNTS = [own("murage_connectors", "connector"), own("agents", "agents"), custom("github"), external("linear")];

const stamped = (name: string, namespace = "mcp", mounts: readonly McpMountRecord[] | null = MOUNTS): GrantCall =>
  ({ toolIdentity: { namespace, name }, toolCall: { name: "title", input: {} }, toolKind: "other", engine: "acp", ...(mounts ? { mcpMounts: mounts } : {}) });
const claude = (name: string, input: unknown = {}, mounts: readonly McpMountRecord[] | null = MOUNTS): GrantCall =>
  ({ toolCall: { name, input }, engine: "claude", ...(mounts ? { mcpMounts: mounts } : {}) });
const place = { home: "/h", cwd: "/h/p", roots: ["/h/p"], knownRecipients: new Set<string>(), realpath: (p: string) => p };

describe("identity (6.1)", () => {
  it("T1: an unknown namespace is unproven, the legacy connector name and engine/other included", () => {
    for (const namespace of ["engine", "other", "composio", "murage_connectors", "fuigo_build2"]) {
      expect(resolveCall(stamped("github__x", namespace)).kind, namespace).toBe("unproven");
    }
  });

  it("T2: an empty stamp is unproven", () => {
    expect(resolveCall(stamped("", "mcp")).kind).toBe("unproven");
    expect(resolveCall(stamped("x", "")).kind).toBe("unproven");
  });

  it("T3, T5: an MCP name that fits no record, or no F4 at all, is unproven on every engine", () => {
    expect(resolveCall(stamped("notion__search")).kind).toBe("unproven");
    expect(resolveCall(stamped("github__x", "mcp", null)).kind).toBe("unproven");
    expect(resolveCall(claude("mcp__notion__search")).kind).toBe("unproven");
    expect(resolveCall(claude("mcp__github__x", {}, null)).kind).toBe("unproven");
    for (const engine of ["codex", "pi"] as const) expect(resolveCall({ ...claude("mcp__notion__search"), engine }).kind).toBe("unproven");
  });

  it("T4: a name that fits two records is unproven", () => {
    const twice = [custom("github"), custom("github", "other")];
    expect(resolveCall(stamped("github__x", "mcp", twice)).kind).toBe("unproven");
  });

  it("T6: identity is exact; `murage-connectors` is not the connector and neither spelling is own unless the record says so", () => {
    expect(resolveCall(stamped("murage-connectors__APPS_SEARCH_TOOLS")).kind).toBe("unproven");
    const lookalike = [custom("murage-connectors")];
    const resolved = resolveCall(stamped("murage-connectors__APPS_SEARCH_TOOLS", "mcp", lookalike));
    expect(resolved).toMatchObject({ kind: "mcp", own: false, mountId: "custom:murage-connectors" });
    expect(resolveCall(stamped("murage_connectors__APPS_SEARCH_TOOLS"))).toMatchObject({ kind: "mcp", own: true });
  });

  it("T7: a custom or external tool is never own, even named APPS_MULTI_EXECUTE_TOOL", () => {
    for (const record of [custom("x"), external("x")]) {
      const resolved = resolveCall(stamped("x__APPS_MULTI_EXECUTE_TOOL", "mcp", [record]));
      expect(resolved).toMatchObject({ kind: "mcp", own: false });
      expect(actionGrantKey("other", stamped("x__APPS_MULTI_EXECUTE_TOOL", "mcp", [record]))).toBe(acpToolKey(record.mountId, "APPS_MULTI_EXECUTE_TOOL"));
    }
  });

  it("T75: the split is at the first __ and an ambiguous one is refused; no longest-prefix path", () => {
    expect(resolveCall(claude("mcp__a__b__c", {}, [custom("a")]))).toMatchObject({ kind: "mcp", server: "a", tool: "b__c" });
    expect(resolveCall(stamped("a__b__c", "mcp", [custom("a")]))).toMatchObject({ kind: "mcp", server: "a", tool: "b__c" });
    // a record holding __ cannot exist; a list that carries one is not read
    expect(resolveCall(claude("mcp__a__b__c", {}, [custom("a"), { engineName: "a__b", mountId: "custom:a__b", provenance: "custom" }])).kind).toBe("unproven");
  });

  it("T59: a muragebox name arriving as a tool call is unproven; ask_user stays a question", () => {
    const box = [own("muragebox", "muragebox")];
    expect(resolveCall(claude("mcp__muragebox__approve", {}, box)).kind).toBe("unproven");
    expect(autoVerdict({ autoApprove: true, fullAccess: true }, "mcp__muragebox__ask_user", "q", { call: claude("mcp__muragebox__ask_user", {}, box), question: true })).toMatchObject({ source: "question-tool" });
  });

  it("T61, T62: an unstamped ACP ask is named by its kind, never its title; other or none is unproven", () => {
    for (const kind of ["execute", "edit", "read", "delete", "move", "search", "fetch"]) {
      expect(resolveCall({ toolKind: kind, toolCall: { name: "anything the model said", input: {} }, engine: "acp" })).toMatchObject({ kind: "engine", name: kind, byKind: true });
    }
    for (const kind of ["other", "think", "switch_mode", "", "weird"]) {
      expect(resolveCall({ toolKind: kind, toolCall: { name: "Read file", input: {} }, engine: "acp" }).kind, kind).toBe("unproven");
    }
  });
});

describe("grant keys (Rules 32, 43, 50, 59)", () => {
  it("a custom or external tool is keyed by its mount identity; old shapes are stale", () => {
    const key = actionGrantKey("other", stamped("github__create_issue"))!;
    expect(key).toBe(acpToolKey("custom:github", "create_issue"));
    expect(isStaleGrant(key)).toBe(false);
    expect(isStaleGrant("acp-tool:mcp:github__create_issue")).toBe(true);
    // a Claude call of the same custom mount shares the key
    expect(actionGrantKey("mcp__github__create_issue", claude("mcp__github__create_issue"))).toBe(key);
    // an own server other than the connector keeps the key it is judged by
    expect(actionGrantKey("mcp__agents__ask_bot", claude("mcp__agents__ask_bot"))).toBeUndefined();
  });

  it("T38: sameToolGrant matches by exact mountId; Codex alias and ACP verbatim share one key; external never matches custom", () => {
    const viaAlias = actionGrantKey("other", stamped("github_murage__create_issue", "mcp", [custom("github_murage", "github")]))!;
    const verbatim = actionGrantKey("other", stamped("github__create_issue"))!;
    expect(viaAlias).toBe(verbatim);
    expect(sameToolGrant(viaAlias, verbatim)).toBe(true);
    const ext = actionGrantKey("other", stamped("github__create_issue", "mcp", [external("github")]))!;
    expect(sameToolGrant(ext, verbatim)).toBe(false);
  });
});

describe("Rule 55 contracts (T64, shared and generic rows)", () => {
  it("only a driver-filed ask is read against a table", () => {
    expect(requiredFields(undefined, { kind: "unstamped" }, { toolCall: { name: "Read", input: {} } })).toEqual({ ok: true });
  });

  it("a delete tool reads every alias; a malformed present source is unread (no masking)", () => {
    for (const key of ["target", "file", "directory", "dir", "files"]) {
      const input = key === "files" ? { files: ["a.txt"] } : { [key]: "a.txt" };
      expect(requiredFields("claude", { kind: "unstamped" }, { toolCall: { name: "delete_file", input }, engine: "claude" }), key).toMatchObject({ ok: true, paths: ["a.txt"] });
    }
    expect(requiredFields("claude", { kind: "unstamped" }, { toolCall: { name: "delete_file", input: {} }, engine: "claude" })).toMatchObject({ ok: false });
    expect(requiredFields("claude", { kind: "unstamped" }, { toolCall: { name: "delete_file", input: { path: "a", file_path: ["b", 1] } }, engine: "claude" })).toMatchObject({ ok: false });
  });

  it("ACP locations valid AND rawInput.path an array is unread; a move needs two paths", () => {
    const edit = (input: unknown): GrantCall => ({ toolKind: "edit", toolCall: { name: "edit", input }, engine: "acp" });
    expect(requiredFields("acp", resolveCall(edit({ locations: [{ path: "/p/a" }], path: ["x"] })), edit({}))).toMatchObject({ ok: true });
    const mixed = edit({ locations: [{ path: "/p/a" }], path: [1] });
    expect(requiredFields("acp", resolveCall(mixed), mixed)).toMatchObject({ ok: false });
    const move = (input: unknown): GrantCall => ({ toolKind: "move", toolCall: { name: "move", input }, engine: "acp" });
    expect(requiredFields("acp", resolveCall(move({ path: "a" })), move({}))).toMatchObject({ ok: false });
    expect(requiredFields("acp", resolveCall(move({ path: "a", new_path: "b" })), move({}))).toMatchObject({ ok: true, paths: ["a", "b"] });
    // the 9.11 flow: locations and a matching file_path, both well formed
    const both = edit({ locations: [{ path: "/p/a.ts" }], file_path: "/p/a.ts" });
    expect(requiredFields("acp", resolveCall(both), both)).toMatchObject({ ok: true });
  });

  it("an unread contract holds at every level and stops in classifyAsk; a driver's missing field (F5) too", () => {
    const noCommand: GrantCall = { toolCall: { name: "Bash", input: {} }, engine: "claude" };
    expect(autoVerdict({ autoApprove: true, fullAccess: true, noLimits: true, alwaysAllow: ["Bash"] }, "Bash", "", { call: noCommand })).toMatchObject({ approve: null, source: "unread-call" });
    expect(classifyAsk({ ...noCommand, tool: "Bash", summary: "" }, place)).not.toBeNull();
    const missing: GrantCall = { toolCall: { name: "shell", input: { command: "ls" } }, engine: "codex", inputMissing: "command" };
    expect(autoVerdict({ autoApprove: true }, "shell", "ls", { call: missing })).toMatchObject({ approve: null, source: "unread-call" });
    // a connector execute row with no arguments object is unread (U5); a lookup with {} is ordinary
    const execute = claude("mcp__murage_connectors__APPS_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }] });
    expect(requiredFields("claude", resolveCall(execute), execute)).toMatchObject({ ok: false });
    const lookup = claude("mcp__murage_connectors__APPS_SEARCH_TOOLS", {});
    expect(requiredFields("claude", resolveCall(lookup), lookup)).toEqual({ ok: true });
  });
});
