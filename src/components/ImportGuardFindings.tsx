// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What the import guard found in a bot or team file, in plain words: the
// field and line, the text that matched, and whether it stops the import
// (Blocked) or is left to the owner (Worth a look). Shared by every place a
// file can be imported, so they all read the same.
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

export interface GuardFinding {
  path: string; rule: string; severity?: "block" | "review"; line?: number;
  field?: string; message?: string; evidence?: string; category?: string;
}
export interface GuardScan { blocked: boolean; reviewRequired: boolean; findings: GuardFinding[]; state?: "too-large" | "unavailable" }
export interface OfficialStatus { official: boolean; keyId?: string }

const MESSAGE_KEYS = new Set<string>([
  "credential-access", "credential-mention", "credential-literal", "network-exfiltration", "shell-execution", "filesystem-write",
  "instruction-override", "obfuscation", "index-poisoning", "hidden-text", "direction-override", "padding", "Prompt Injection",
  "Data Exfiltration", "Privilege Escalation", "Supply Chain", "Excessive Agency", "Output Handling", "System Prompt Leakage",
  "Memory Poisoning", "Tool Misuse", "Rogue Agent", "Agent Snooping", "Anti-Refusal", "Server-Side Request Forgery",
  "Insecure Deserialization", "Harmful Content", "obfuscated", "encoded-payload", "tag-characters", "homoglyph",
]);
const slug = (category: string) => category.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
/** The finding's meaning in the app's language; the server's English if a
 * category has no entry yet. */
export function guardMessage(finding: GuardFinding): string {
  if (finding.category && MESSAGE_KEYS.has(finding.category)) return t(`importGuard.cat.${slug(finding.category)}` as LocaleKey);
  return finding.message ?? "";
}

/** The line above a refused import: too large to check, the check could not
 * finish (try again), or the findings below. */
export function guardBlockedNote(scan: GuardScan | null | undefined): string {
  if (scan?.state === "too-large") return t("importGuard.tooLarge");
  if (scan?.state === "unavailable") return t("importGuard.unavailable");
  return t("importGuard.blockedNote");
}

export function OfficialMark({ status }: { status?: OfficialStatus | null }) {
  if (!status?.official) return null;
  return <p aria-label={t("importGuard.official")} className="mt-2 text-[12px]"><span className="rounded bg-inset px-1.5 py-0.5 font-medium">{t("importGuard.official")}</span> <span className="text-ink-secondary">{t("importGuard.officialNote")}</span></p>;
}

export function ImportGuardFindings({ scan }: { scan: GuardScan | null | undefined }) {
  if (!scan || scan.findings.length === 0) return null;
  return <ul aria-label={t("importGuard.listLabel")} className="mt-3 space-y-2 text-[12px] text-ink-secondary">
    {scan.findings.map((finding, index) => {
      if (!finding.message) return <li key={index} className="break-words">{finding.path}: {finding.rule}{finding.line ? " (" + t("importGuard.line", { line: finding.line }) + ")" : ""}</li>;
      const where = finding.field ?? finding.path;
      return <li key={index} className="break-words">
        <span className="font-medium text-ink">{finding.severity === "block" ? t("importGuard.blocked") : t("importGuard.review")}</span>
        {" · "}{guardMessage(finding)}
        <span className="block">{finding.line ? t("importGuard.where", { where, line: finding.line }) : t("importGuard.whereNoLine", { where })}</span>
        {finding.evidence && <code className="mt-0.5 block whitespace-pre-wrap rounded bg-inset px-1.5 py-1 text-[11px] text-ink">{finding.evidence}</code>}
      </li>;
    })}
  </ul>;
}

/** The guard's answer when an import is refused, from the error `api()` throws. */
export function guardScanFromError(cause: unknown): { scan: GuardScan; status: number } | null {
  const status = (cause as { status?: number } | null)?.status;
  const scan = (cause as { body?: { scan?: GuardScan } } | null)?.body?.scan;
  return scan && Array.isArray(scan.findings) && (status === 409 || status === 422) ? { scan, status } : null;
}
