// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One skill in, one verdict out. Offline, no model, pure.
import { skillContentHash } from "./content-hash.ts";
import { plainMessage } from "./messages.ts";
import { evidence, SKILL_RULES } from "./rules.ts";
import { SPECTOR_PATTERNS } from "./spector-patterns.generated.ts";
import { REPORT_CONFIDENCE, SKILL_SCANNER_VERSION, type SkillFinding, type SkillScan, type SkillScanInput, type SkillVerdict } from "./types.ts";

/** Where a finding stops being "worth a look" and becomes Blocked. */
export const BLOCK_RULES = { criticalAt: 0.85, highAt: 0.9 };

// SkillSpector matches line by line, hence "m".
let compiled: Array<(typeof SPECTOR_PATTERNS)[number] & { regex: RegExp }> | null = null;
const spector = () => (compiled ??= SPECTOR_PATTERNS.map((p) => ({ ...p, regex: new RegExp(p.source, "im") })));

const CODE_FILE = /\.(?:py|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|ps1|rb|go|rs|php|pl|lua|toml|ya?ml|json|ini|cfg)$/i;
const MANIFEST_FILE = /(?:^|\/)(?:requirements[^/]*\.txt|package\.json|pyproject\.toml|Pipfile|Gemfile|Cargo\.toml|go\.mod)$/i;

/** A file's text as SkillSpector reads it: code files are all code; in
 *  markdown and prose, fenced blocks are code and the rest is prose. */
function views(path: string, content: string): { code: string; prose: string; manifest: boolean } {
  if (CODE_FILE.test(path) || MANIFEST_FILE.test(path)) return { code: content, prose: "", manifest: MANIFEST_FILE.test(path) };
  const code: string[] = [];
  const prose = content.replace(/^(```|~~~)[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm, (_all, _fence, body: string) => {
    code.push(body);
    return "";
  });
  return { code: code.join("\n"), prose, manifest: false };
}

export function verdictFor(findings: SkillFinding[]): SkillVerdict {
  if (findings.some((f) => (f.severity === "critical" && f.confidence >= BLOCK_RULES.criticalAt) || (f.severity === "high" && f.confidence >= BLOCK_RULES.highAt))) return "blocked";
  return findings.length ? "review" : "clean";
}

export function scanSkill(input: SkillScanInput, now: Date = new Date()): SkillScan {
  // Trigger terms are single words: only Skill Guard's rules and the
  // index-poisoning check read them, never SkillSpector's line patterns.
  const texts = [
    ...input.files.map((file) => ({ file: file.path, text: file.content, spector: true })),
    { file: "(description)", text: input.description, spector: true },
    { file: "(trigger terms)", text: input.triggerTerms.join(" "), spector: false },
  ];
  const findings: SkillFinding[] = [];
  for (const { file, text, spector: readBySpector } of texts) {
    if (!text) continue;
    for (const rule of SKILL_RULES) {
      const match = rule.test(text);
      if (match !== null) findings.push({ rule: rule.id, category: rule.category, severity: rule.severity, confidence: rule.confidence, message: plainMessage(rule.category), evidence: match, file, source: rule.source });
    }
    if (!readBySpector) continue;
    const view = file.startsWith("(") ? { code: "", prose: text, manifest: false } : views(file, text);
    for (const pattern of spector()) {
      const target = pattern.applies === "manifest" ? (view.manifest ? view.code : "")
        : pattern.applies === "code" ? view.code
        : pattern.applies === "prose" ? view.prose
        : text;
      if (!target) continue;
      const match = target.match(pattern.regex);
      if (match) findings.push({ rule: `skillspector:${pattern.id}`, category: pattern.category, severity: pattern.severity, confidence: pattern.confidence, message: plainMessage(pattern.category), evidence: evidence(match[0]), file, source: "skillspector" });
    }
  }
  if (input.triggerTerms.length >= 5) {
    const haystack = `${input.files.map((f) => f.content).join("\n")}\n${input.description}`.toLowerCase();
    const appearing = input.triggerTerms.filter((term) => haystack.includes(term.toLowerCase())).length;
    if (appearing / input.triggerTerms.length < 0.3) {
      findings.push({ rule: "SG7", category: "index-poisoning", severity: "low", confidence: 0.6, message: plainMessage("index-poisoning"), evidence: evidence(input.triggerTerms.slice(0, 8).join(", ")), file: "(trigger terms)", source: "skill-guard" });
    }
  }
  const reported = findings.filter((f) => f.confidence >= REPORT_CONFIDENCE);
  return { verdict: verdictFor(reported), findings: reported, contentHash: skillContentHash(input), scannerVersion: SKILL_SCANNER_VERSION, scannedAt: now.toISOString() };
}
