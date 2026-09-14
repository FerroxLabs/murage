import { expect, it, vi } from "vitest";
vi.mock("@/state/store", () => ({ api: vi.fn() }));
import { discordHealth, discordHelp, discordStatusFrom } from "./DiscordSettings";
const base = { state: "idle", configured: false, botConfigured: false, paired: false, enabled: false, requiresRevoke: false, busy: false,
  pending: 0, uncertain: 0, rejected: 0, needsReview: 0, error: null, nextRetryAt: null };
it("rejects failed status payloads and strips undeclared secret fields", () => {
  expect(discordStatusFrom({ ...base, appToken: "private", botToken: "private" })).toEqual(base);
  for (const bad of [null, {}, { ...base, state: "unknown" }, { ...base, pending: true }, { ...base, uncertain: -1 }, { ...base, nextRetryAt: "tomorrow" }, { ...base, ownerUserId: 42 }])
    expect(() => discordStatusFrom(bad)).toThrow();
});
it("distinguishes saved credentials, pairing, connectivity and errors", () => {
  expect(discordHealth(discordStatusFrom(base))).toBe("Save your Discord credentials");
  expect(discordHealth(discordStatusFrom({ ...base, configured: true }))).toContain("not paired");
  expect(discordHealth(discordStatusFrom({ ...base, state: "pairing", enabled: true, requiresRevoke: true }))).toContain("Waiting");
  expect(discordHealth(discordStatusFrom({ ...base, paired: true, enabled: false }))).toContain("offline");
  expect(discordHealth(discordStatusFrom({ ...base, paired: true, enabled: true }))).toBe("Connected to Chief");
  expect(discordHealth(discordStatusFrom({ ...base, state: "retry", paired: true }))).toContain("reconnecting");
  expect(discordHealth(discordStatusFrom({ ...base, state: "pairing" }), true)).toContain("expired");
});
it("returns actionable safe guidance without reflecting unknown error bodies", () => {
  expect(discordHelp("chief-changed")).toContain("current Chief");
  expect(discordHelp("revoke-recovery-required")).toContain("retry Revoke");
  expect(discordHelp("retry-limit")).toContain("retry");
  expect(discordHelp("raw-secret-canary")).not.toContain("canary");
  expect(discordHelp(null)).toBeNull();
});
