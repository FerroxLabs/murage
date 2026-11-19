// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// One bounded, secret-free line for an error that a consuming-ledger catch maps to a
// refusal. Without it the first cause of a sealed turn is invisible (1.0.20 relay seals).
// Never logs frames, bodies, tokens, paths or message text: class, code, fence, the message
// only when it is a bare code word (MEMORY_CONTEXT_REVOKED), and the top three stack frames
// as file:line. A JSON.parse or SQLite message can quote stored bytes, so free text is dropped.

const MAX_PER_SITE = 20;
const MESSAGE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const counts = new Map<string, number>();

const clip = (text: string, max: number) => text
  .replace(/(?:\/Users|\/home|\/root|[A-Za-z]:\\Users)[\\/][^\\/\s"')]+/g, "~")
  .replace(/[A-Za-z0-9+/_=-]{32,}/g, "<long>")
  .replace(/[\r\n\t]+/g, " ")
  .slice(0, max);

export function describeSwallowedError(error: unknown): string {
  const value = error as { name?: unknown; code?: unknown; message?: unknown; stack?: unknown; fence?: { state?: unknown; reason?: unknown } } | null;
  const name = error instanceof Error ? error.constructor.name || String(value?.name) : typeof error;
  const code = typeof value?.code === "string" || typeof value?.code === "number" ? clip(String(value.code), 64) : "-";
  const fence = value?.fence && typeof value.fence === "object" ? `${clip(String(value.fence.state), 24)}/${clip(String(value.fence.reason), 32)}` : "-";
  const message = typeof value?.message === "string" && MESSAGE_CODE.test(value.message) ? value.message : "-";
  const frames = typeof value?.stack === "string" ? value.stack.split("\n").slice(1)
    .map(line => line.match(/([^\\/\s(]+\.(?:[cm]?[jt]s)):(\d+)(?::\d+)?\)?\s*$/))
    .filter((match): match is RegExpMatchArray => match !== null).slice(0, 3)
    .map(match => `${match[1]}:${match[2]}`).join(" < ") : "";
  return `class=${name} code=${code} fence=${fence} message=${JSON.stringify(message)} at=${frames || "-"}`;
}

/** At most MAX_PER_SITE lines per site per process; logging can never throw into the caller. */
export function logSwallowedConsumingError(site: string, error: unknown): void {
  try {
    const seen = counts.get(site) ?? 0;
    if (seen >= MAX_PER_SITE) return;
    counts.set(site, seen + 1);
    console.warn(`[consuming] swallowed error site=${site} n=${seen + 1} ${describeSwallowedError(error)}`);
  } catch { /* diagnostics only */ }
}
