// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { constants } from "node:buffer";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { claudeMcpStartupEnv, claudeOverlayEnv, stripClaudeOwnedEnv } from "./claude.ts";
import { ownedTurnNames } from "../engine-env.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { consumePermissionResult } from "../testing/claude-permission-consumer.ts";

it("keeps permission results above every JS string size with and without mcp_status", () => {
  for (const supported of [true, false]) {
    const limit = Number(claudeMcpStartupEnv(supported).MAX_MCP_OUTPUT_TOKENS);
    expect(limit).toBe(Number.MAX_SAFE_INTEGER);
    // Even UTF-8 bytes with one token per byte fit below the fast-path half-limit.
    expect(limit / 2).toBeGreaterThan(constants.MAX_STRING_LENGTH * 4);
  }
});

for (const platform of ["linux", "win32"] as const) {
  it(`owns the permission limit over a captured shell and user/project settings on ${platform}`, () => {
    const strip = (map: Record<string, string | undefined>) => stripClaudeOwnedEnv(map, undefined, platform);
    const captured = { MAX_MCP_OUTPUT_TOKENS: "1000", ...(platform === "win32" ? { max_mcp_output_tokens: "1" } : {}) };
    strip(captured);
    expect(captured).toEqual({});
    const owned = ownedTurnNames(claudeMcpStartupEnv(), strip);
    expect(owned.MAX_MCP_OUTPUT_TOKENS).toBe(String(Number.MAX_SAFE_INTEGER));
    const dir = mkdtempSync(join(tmpdir(), "murage-output-env-"));
    try {
      const user = join(dir, "user.json"), project = join(dir, "project.json");
      writeFileSync(user, JSON.stringify({ env: { MAX_MCP_OUTPUT_TOKENS: "1000" } }));
      writeFileSync(project, JSON.stringify({ env: { MAX_MCP_OUTPUT_TOKENS: "1" } }));
      const overlay = claudeOverlayEnv(platform, { kind: "murage-exec", shell: "/bin/bash" }, { PATH: "/bin", ...owned }, [{ path: user, source: "user" }, { path: project, source: "project" }]);
      expect("env" in overlay && overlay.env.MAX_MCP_OUTPUT_TOKENS).toBe(String(Number.MAX_SAFE_INTEGER));
    } finally { removeTempDirSync(dir); }
  });
}

for (const platform of ["linux", "win32"] as const) {
  it(`refuses a managed permission limit that would corrupt an approved reply on ${platform}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-managed-output-"));
    try {
      const managed = join(dir, "managed-settings.json");
      const name = platform === "win32" ? "max_mcp_output_tokens" : "MAX_MCP_OUTPUT_TOKENS";
      const handed = { PATH: "/bin", ...claudeMcpStartupEnv() };
      for (const value of ["1000", "25000", "0", "", "invalid"]) {
        writeFileSync(managed, JSON.stringify({ env: { [name]: value } }));
        const overlay = claudeOverlayEnv(platform, { kind: "murage-exec", shell: "/bin/bash" }, handed, [], [managed]);
        // Policy env is applied AFTER flag settings. Prove the effective limit,
        // rather than inspecting only the overlay that policy can overwrite.
        if ("env" in overlay) {
          const effective = { ...handed, ...overlay.env, MAX_MCP_OUTPUT_TOKENS: value };
          const result = { content: [{ type: "text", text: JSON.stringify({ behavior: "allow", updatedInput: { file_path: "/fixture/build.py", content: "x".repeat(400 * 1024) } }) }] };
          expect(() => consumePermissionResult(result, effective, 400_000), `effective managed limit ${JSON.stringify(value)}`).not.toThrow();
        }
        expect(overlay).toHaveProperty("refusal");
        if ("refusal" in overlay) {
          expect(overlay.refusal).toContain(managed);
          expect(overlay.refusal).toContain(name);
          expect(overlay.refusal).toContain("managed");
        }
      }
    } finally { removeTempDirSync(dir); }
  });

  it(`reports a compatible managed permission limit and preserves the effective reply on ${platform}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-managed-output-"));
    try {
      const managed = join(dir, "managed-settings.json");
      const name = platform === "win32" ? "max_mcp_output_tokens" : "MAX_MCP_OUTPUT_TOKENS";
      const value = String(Number.MAX_SAFE_INTEGER);
      writeFileSync(managed, JSON.stringify({ env: { [name]: value } }));
      const handed = { PATH: "/bin", ...claudeMcpStartupEnv() };
      const overlay = claudeOverlayEnv(platform, { kind: "murage-exec", shell: "/bin/bash" }, handed, [], [managed]);
      expect(overlay).not.toHaveProperty("refusal");
      if (!("env" in overlay)) throw new Error(overlay.refusal);
      expect(overlay.managed).toContain(name);
      const effective = { ...handed, ...overlay.env, MAX_MCP_OUTPUT_TOKENS: value };
      const input = { file_path: "/fixture/build.py", content: "x".repeat(400 * 1024) };
      const result = { content: [{ type: "text", text: JSON.stringify({ behavior: "allow", updatedInput: input }) }] };
      expect(consumePermissionResult(result, effective, 400_000)).toEqual({ behavior: "allow", updatedInput: input });
    } finally { removeTempDirSync(dir); }
  });
}
