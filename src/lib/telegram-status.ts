export type TelegramStatus = {
  configured: boolean;
  targetBotId?: string;
  enabled: boolean;
  paired: boolean;
  pending: number;
  uncertain: number;
  rejected?: number;
  error?: string | null;
  deliveryError?: string | null;
  deliveryRetryAt?: number | null;
  nextRetryAt?: number | null;
  connecting: boolean;
  pairingExpired?: boolean;
  pairingExpiresAt?: number | null;
  requiresRevoke?: boolean;
  canResume?: boolean;
  resumeState?: "idle" | "verifying" | "active" | "retry" | "pair-required" | "blocked";
  resumeMessage?: string | null;
};

const resumeStates = new Set<TelegramStatus["resumeState"]>(["idle", "verifying", "active", "retry", "pair-required", "blocked"]);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isTimestamp = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Reject proxy/error bodies so a failed status probe never replaces the last known state. */
export function telegramStatusFrom(value: unknown): TelegramStatus {
  if (!value || typeof value !== "object") throw new Error("Telegram status could not be read.");
  const status = value as Record<string, unknown>;
  if (typeof status.configured !== "boolean" || typeof status.enabled !== "boolean" || typeof status.paired !== "boolean"
    || typeof status.connecting !== "boolean" || !isCount(status.pending) || !isCount(status.uncertain)) throw new Error("Telegram status could not be read.");
  if (status.rejected !== undefined && !isCount(status.rejected)) throw new Error("Telegram status could not be read.");
  if (status.resumeState !== undefined && (typeof status.resumeState !== "string" || !resumeStates.has(status.resumeState as TelegramStatus["resumeState"]))) throw new Error("Telegram status could not be read.");
  for (const key of ["pairingExpiresAt", "deliveryRetryAt", "nextRetryAt"] as const) if (status[key] !== undefined && status[key] !== null && !isTimestamp(status[key])) throw new Error("Telegram status could not be read.");
  for (const key of ["targetBotId", "error", "deliveryError", "resumeMessage"] as const) if (status[key] !== undefined && status[key] !== null && typeof status[key] !== "string") throw new Error("Telegram status could not be read.");
  for (const key of ["pairingExpired", "requiresRevoke", "canResume"] as const) if (status[key] !== undefined && typeof status[key] !== "boolean") throw new Error("Telegram status could not be read.");
  return status as TelegramStatus;
}

export function shouldPollTelegramStatus(status: TelegramStatus | null) {
  return Boolean(status && (status.configured || status.enabled || status.paired || status.pending > 0 || status.connecting || status.requiresRevoke));
}

export function telegramHealthLabel(status: TelegramStatus | null, expired: boolean, waiting: boolean) {
  if (!status) return "Checking Telegram…";
  if (status.resumeState === "verifying") return "Reconnecting to Telegram…";
  if (status.resumeState === "retry") return "Connection saved · retrying automatically";
  if (status.resumeState === "blocked" && status.canResume) return "Another app is receiving this bot";
  if (status.resumeState === "blocked") return status.resumeMessage?.includes("Chief") ? "Chief unavailable · revoke and re-pair" : "Connection needs attention";
  if (status.paired) return "Paired";
  if (expired) return "Pairing expired · create a new code";
  if (status.connecting) return "Connecting…";
  if (waiting) return "Waiting for pairing";
  return status.configured ? "Token saved · not paired" : "No token saved";
}
