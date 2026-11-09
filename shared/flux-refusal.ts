/** Call only at a known Flux boundary. Owner providers keep their own errors. */
export function fluxRefusalCode(body: unknown): string {
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return body as string; }
  }
  if (!body || typeof body !== "object") return "";
  const value = body as Record<string, unknown>;
  const error = value.error && typeof value.error === "object" ? value.error as Record<string, unknown> : value;
  return typeof error.code === "string" ? error.code : typeof value.code === "string" ? value.code : typeof value.error === "string" ? value.error : "";
}
export function classifyFluxRefusal(status: number, body: unknown): "budget" | "premium" | "other" {
  const code = fluxRefusalCode(body);
  if (code === "premium_locked") return "premium";
  if (status === 402 || status === 4402) return "budget";
  return /^(key_budget_reached|budget_exceeded|account_monthly_budget_exhausted|insufficient_(quota|balance|credits?|funds)|balance_exhausted|out_of_credits|payment_required|credit_exhausted|daily_cap|monthly_cap)$/.test(code) ? "budget" : "other";
}
