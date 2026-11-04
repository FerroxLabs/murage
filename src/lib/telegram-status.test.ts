import { describe, expect, it } from "vitest";
import { shouldPollTelegramStatus, telegramAutoPairPlan, telegramHealthLabel, telegramStatusFrom, type TelegramStatus } from "./telegram-status";

const status: TelegramStatus = { configured: true, enabled: true, paired: true, pending: 0, uncertain: 0, connecting: false };

describe("telegramStatusFrom", () => {
  it("accepts the status shape exposed to settings", () => {
    expect(telegramStatusFrom({ ...status, rejected: 1, deliveryRetryAt: 42, resumeState: "retry" })).toMatchObject(status);
    expect(telegramStatusFrom({ ...status, paired: false, resumeState: "blocked", canReplaceToken: true })).toMatchObject({ canReplaceToken: true });
  });

  it.each([null, "offline", { ...status, pending: -1 }, { ...status, resumeState: "unknown" }, { ...status, canResume: "true" }, { ...status, canReplaceToken: "true" }, { ...status, canReplaceToken: 1 }, { ...status, deliveryRetryAt: "later" }])("rejects malformed responses", value => {
    expect(() => telegramStatusFrom(value)).toThrow("Telegram status could not be read.");
  });
});

describe("Telegram health polling and labels", () => {
  it("keeps polling configured, retrying, and blocked saved connections", () => {
    expect(shouldPollTelegramStatus({ ...status, paired: false, enabled: false, resumeState: "retry", requiresRevoke: true })).toBe(true);
    expect(shouldPollTelegramStatus({ ...status, paired: false, enabled: false, resumeState: "blocked", requiresRevoke: true })).toBe(true);
    expect(shouldPollTelegramStatus({ ...status, configured: false, paired: false, enabled: false, requiresRevoke: false })).toBe(false);
  });

  it("names automatic retry and Chief re-pairing without implying token loss", () => {
    expect(telegramHealthLabel({ ...status, paired: false, resumeState: "blocked", canResume: true, resumeMessage: "Changed wording" }, false, false)).toBe("Another app is receiving this bot");
    expect(telegramHealthLabel({ ...status, paired: false, resumeState: "retry" }, false, false)).toBe("Connection saved · retrying automatically");
    expect(telegramHealthLabel({ ...status, paired: false, resumeState: "blocked", resumeMessage: "The paired Chief changed or is unavailable. Revoke this connection, then pair the current workspace Chief." }, false, false)).toBe("Chief unavailable · revoke and re-pair");
  });

  it("names a rejected token as replaceable only when the server offers replacement", () => {
    const rejected = "Telegram rejected the saved bot token. Paste a new token for this same bot from BotFather to reconnect. Your pairing is saved.";
    expect(telegramHealthLabel({ ...status, paired: false, resumeState: "blocked", canReplaceToken: true, resumeMessage: rejected }, false, false)).toBe("Token rejected · paste a new token for this bot");
    expect(telegramHealthLabel({ ...status, paired: false, resumeState: "blocked", canReplaceToken: false, resumeMessage: rejected }, false, false)).toBe("Connection needs attention");
    expect(telegramHealthLabel({ ...status, paired: false, resumeState: "blocked", canResume: true, canReplaceToken: true }, false, false)).toBe("Another app is receiving this bot");
    expect(telegramHealthLabel({ ...status, paired: false, resumeState: "blocked", canReplaceToken: false, resumeMessage: "The paired Chief changed or is unavailable. Revoke this connection, then pair the current workspace Chief." }, false, false)).toBe("Chief unavailable · revoke and re-pair");
    expect(telegramHealthLabel({ ...status, paired: false, resumeState: "retry", canReplaceToken: true }, false, false)).toBe("Connection saved · retrying automatically");
  });
});

describe("auto-pair after the first token (job 7)", () => {
  const now = 1_000_000;
  const unlinked: TelegramStatus = { configured: true, enabled: false, paired: false, pending: 0, uncertain: 0, connecting: false };
  it("pairs without a revoke when nothing is pending", () => {
    expect(telegramAutoPairPlan(unlinked, now)).toEqual({ pair: true, revokeFirst: false });
  });
  it("revokes an expired-by-time pending code before pairing", () => {
    expect(telegramAutoPairPlan({ ...unlinked, pending: 1, pairingExpired: false, pairingExpiresAt: now - 1 }, now)).toEqual({ pair: true, revokeFirst: true });
  });
  it("revokes a pending code whose saved status says expired", () => {
    expect(telegramAutoPairPlan({ ...unlinked, pending: 1, pairingExpired: true, pairingExpiresAt: now + 60_000 }, now)).toEqual({ pair: true, revokeFirst: true });
  });
  it("leaves a valid pending code alone: no pair, no revoke", () => {
    expect(telegramAutoPairPlan({ ...unlinked, pending: 1, pairingExpired: false, pairingExpiresAt: now + 60_000 }, now)).toEqual({ pair: false, revokeFirst: false });
  });
  it("never starts when linked", () => {
    for (const linked of [{ paired: true }, { enabled: true }, { connecting: true }, { requiresRevoke: true }, { configured: false }]) expect(telegramAutoPairPlan({ ...unlinked, ...linked }, now).pair).toBe(false);
  });
});
