import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DATA_DIR, loadConfig, parseConfigPatch, saveConfig, stripWorkspaceCredentialEnv, syncCredentialEnv } from "./config.ts";
// Vitest's existing setup owns DATA_DIR; no user configuration is resolved here.
afterEach(() => { rmSync(join(DATA_DIR, "config.json"), { force: true }); vi.unstubAllEnvs(); });
it("preserves identity across key-only commits, hydrates and clears independent Slack credentials", () => {
  mkdirSync(DATA_DIR, { recursive: true });
  vi.stubEnv("MURAGE_SLACK_APP_TOKEN", undefined); vi.stubEnv("MURAGE_SLACK_BOT_TOKEN", undefined);
  saveConfig(parseConfigPatch({ slack: { teamId: "TEAM", appId: "APP", ownerUserId: "UOWNER", appToken: "", botToken: "" } }));
  syncCredentialEnv({ slack: { appToken: "fake-app-secret", botToken: "fake-bot-secret" } });
  expect(loadConfig().slack).toMatchObject({ teamId: "TEAM", appToken: "fake-app-secret", botToken: "fake-bot-secret" });
  expect(readFileSync(join(DATA_DIR, "config.json"), "utf8")).not.toContain("secret");
  syncCredentialEnv({ slack: { appToken: "" } });
  expect(loadConfig().slack).toMatchObject({ appToken: "", botToken: "fake-bot-secret", ownerUserId: "UOWNER" });
  const env = { MURAGE_SLACK_APP_TOKEN: "fake-a", MURAGE_SLACK_BOT_TOKEN: "fake-b", SAFE_FIELD: "keep" };
  stripWorkspaceCredentialEnv(env); expect(env).toEqual({ SAFE_FIELD: "keep" });
});
it("rejects arbitrary Slack fields and malformed chosen identities", () => {
  expect(() => parseConfigPatch({ slack: { webHookUrl: "https://example.invalid" } })).toThrow();
  expect(() => parseConfigPatch({ slack: { ownerUserId: "../owner" } })).toThrow();
  expect(() => parseConfigPatch({ slack: { appToken: "x".repeat(513) } })).toThrow();
});
