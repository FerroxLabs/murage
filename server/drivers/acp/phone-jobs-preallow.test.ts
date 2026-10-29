// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.9 phone tools phase fix (Opus M1): the owner's phone tools raise no desktop card on an ACP engine, at Ask or at Auto.
// The live authority, the grant and the phone's own card are the gate. A same-named tool of another server still asks.
import { describe, expect, it } from "vitest";

import { autoVerdict } from "../../auto-approve.ts";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hermesAcpSupport, hermesAskMatcher } from "./hermes.ts";
import { PHONE_TOOL_NAMES } from "../../../shared/phone-jobs-contract.ts";
import type { GrantCall } from "../../../shared/app-action-grant.ts";

const MOUNTS = [{ engineName: "phoneJobs", mountId: "own:phoneJobs", provenance: "own" as const }, { engineName: "evil", mountId: "custom:evil", provenance: "custom" as const }];
const call = (server: string, tool: string): GrantCall => ({ engine: "codex", toolCall: { name: `mcp__${server}__${tool}`, input: { to: ["Sam"], body: "running late" } }, mcpMounts: MOUNTS });

describe("phone tools on an ACP engine", () => {
  it.each([false, true])("every phone tool is auto-approved with no card (autoApprove %s)", (autoApprove) => {
    for (const tool of PHONE_TOOL_NAMES) {
      const verdict = autoVerdict({ autoApprove, alwaysAllow: [] }, `mcp__phoneJobs__${tool}`, `${tool} for the owner`, { call: call("phoneJobs", tool) });
      expect(verdict, tool).toMatchObject({ source: "own-unasked" });
      expect(verdict.approve, tool).toBeTruthy();
    }
  });
  it("a custom server with a phone tool's name still asks", () => {
    const verdict = autoVerdict({ autoApprove: false, alwaysAllow: [] }, "mcp__evil__phone_text_compose", "x", { call: call("evil", "phone_text_compose") });
    expect(verdict.approve).toBeFalsy();
  });
  it("the Hermes ask hook lets the phone tools through", () => {
    const m = new RegExp(`^(?:${hermesAskMatcher(false, true)})$`);
    for (const tool of PHONE_TOOL_NAMES) expect(m.test(`mcp__phoneJobs__${tool}`), tool).toBe(false);
    expect(m.test("mcp__evil__phone_text_compose")).toBe(true);
  });
  it("the Hermes ask hook still asks for phone-named tools on a turn without the phone mount (N1)", () => {
    for (const host of [false, true]) {
      const m = new RegExp(`^(?:${hermesAskMatcher(host)})$`);
      for (const tool of PHONE_TOOL_NAMES) expect(m.test(`mcp__phoneJobs__${tool}`), tool).toBe(true);
    }
  });
  it("the Hermes spawn writes the phone pre-allow only for a turn that mounts the phone (N1)", () => {
    const written = (integrations: object) => {
      const root = mkdtempSync(join(tmpdir(), "murage-hermes-n1-"));
      const env: Record<string, string | undefined> = { MURAGE_DATA_DIR: root, HERMES_MANAGED_DIR: join(root, "no-admin") };
      hermesAcpSupport.spawnArgs({} as any, { integrations } as any, { env });
      return readFileSync(join(env.HERMES_MANAGED_DIR!, "config.yaml"), "utf8").includes("mcp__phoneJobs__phone_text_compose");
    };
    expect(written({ phoneJobs: { command: "node", args: [], env: {} } })).toBe(true);
    expect(written({})).toBe(false);
  });
});
