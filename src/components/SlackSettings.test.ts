import { expect, it, vi } from "vitest";
vi.mock("@/state/store", () => ({ api: vi.fn() }));
import { slackHealth, slackHelp, slackStatusFrom } from "./SlackSettings";
const base = { state: "idle", configured: false, appConfigured: false, botConfigured: false, paired: false, enabled: false, requiresRevoke: false, busy: false,
  pending: 0, uncertain: 0, rejected: 0, needsReview: 0, error: null, nextRetryAt: null };
it("rejects failed status payloads and strips undeclared secret fields", () => {
  expect(slackStatusFrom({ ...base, appToken: "private", botToken: "private" })).toEqual(base);
  for (const bad of [null, {}, { ...base, state: "unknown" }, { ...base, pending: true }, { ...base, uncertain: -1 }, { ...base, nextRetryAt: "tomorrow" }, { ...base, ownerUserId: 42 }])
    expect(() => slackStatusFrom(bad)).toThrow();
});
it("distinguishes saved credentials, pairing, connectivity and errors", () => {
  expect(slackHealth(slackStatusFrom(base))).toBe("Save your Slack credentials");
  expect(slackHealth(slackStatusFrom({ ...base, configured: true }))).toContain("not paired");
  expect(slackHealth(slackStatusFrom({ ...base, state: "pairing", enabled: true, requiresRevoke: true }))).toContain("Waiting");
  expect(slackHealth(slackStatusFrom({ ...base, paired: true, enabled: false }))).toContain("offline");
  expect(slackHealth(slackStatusFrom({ ...base, paired: true, enabled: true }))).toBe("Connected to Chief");
  expect(slackHealth(slackStatusFrom({ ...base, state: "retry", paired: true }))).toContain("reconnecting");
  expect(slackHealth(slackStatusFrom({ ...base, state: "pairing" }), true)).toContain("expired");
});
it("returns actionable safe guidance without reflecting unknown error bodies", () => {
  expect(slackHelp("chief-changed")).toContain("current Chief");
  expect(slackHelp("revoke-recovery-required")).toContain("retry Revoke");
  expect(slackHelp("retry-limit")).toContain("retry");
  expect(slackHelp("raw-secret-canary")).not.toContain("canary");
  expect(slackHelp(null)).toBeNull();
});
