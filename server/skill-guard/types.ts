// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Skill Guard: a WARNING system, not a guarantee. A clean result reads "No
// red flags found", never "safe". Brought in from Ferrox Labs' Wayland app.
export type SkillSeverity = "critical" | "high" | "medium" | "low";
export type SkillVerdict = "clean" | "review" | "blocked";
export interface SkillScanFile { path: string; content: string }
export interface SkillScanInput { name: string; description: string; triggerTerms: string[]; files: SkillScanFile[] }
export interface SkillFinding {
  rule: string;
  category: string;
  severity: SkillSeverity;
  /** 0..1: how sure the rule is that this is what it looks like. */
  confidence: number;
  /** Plain words for the owner, from messages.ts. */
  message: string;
  /** At most 120 characters of the matching text. */
  evidence: string;
  /** Which file matched; "(description)" or "(trigger terms)" for those. */
  file: string;
  source: "skill-guard" | "murage" | "skillspector";
}
export interface SkillScan { verdict: SkillVerdict; findings: SkillFinding[]; contentHash: string; scannerVersion: number; scannedAt: string }
/** Bump when rules change: stored scans from an older version are redone. */
export const SKILL_SCANNER_VERSION = 1;
/** Matches below this confidence are not reported at all. */
export const REPORT_CONFIDENCE = 0.6;
