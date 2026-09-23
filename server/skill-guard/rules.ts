// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Skill Guard's rules (Ferrox Labs, from the Wayland app) and Murage's own
// invisible-text checks. Each returns the matching text, or null.
import type { SkillFinding, SkillSeverity } from "./types.ts";

export interface SkillRule {
  id: string;
  category: string;
  severity: SkillSeverity;
  confidence: number;
  source: SkillFinding["source"];
  test(text: string): string | null;
}

const EVIDENCE_MAX = 120;
export const evidence = (text: string) => (text.length > EVIDENCE_MAX ? `${text.slice(0, EVIDENCE_MAX)}…` : text);
const first = (text: string, ...patterns: RegExp[]) => {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return evidence(match[0]);
  }
  return null;
};

const CREDENTIAL_USE = /(?:cat|type|read|open|copy|upload|send|print)\b[^\n]{0,80}(?:~\/\.ssh\/|\bid_rsa\b|\.aws\/credentials|\.netrc\b|\.env\b)/i;
const CREDENTIAL_LITERAL = /AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9_-]{20,}/;
const CREDENTIAL_MENTION = /~\/\.ssh\/|\bid_rsa\b|\.aws\/credentials|\.env\b/i;
const BASE64_RUN = (min: number) => new RegExp(`[A-Za-z0-9+/]{${min},}={0,2}`);
const DECODE_RUN = /\batob\s*\(|\bbase64\s+-(?:d|-decode)\b|\bopenssl\s+enc\b/i;
const EMOJI = /\p{Extended_Pictographic}/u;

function hiddenText(text: string): string | null {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const zeroWidth = code === 0x200b || code === 0x200c || (code >= 0x2060 && code <= 0x2064) || (code === 0xfeff && i > 0);
    const joiner = code === 0x200d && !(EMOJI.test(text.slice(Math.max(0, i - 2), i)) || EMOJI.test(text.slice(i + 1, i + 3)));
    if (zeroWidth || joiner) return evidence(JSON.stringify(text.slice(Math.max(0, i - 20), i + 20)));
  }
  return null;
}

function padding(text: string): string | null {
  const blank = text.match(/(?:\r?\n[ \t]*){30,}\S[^\n]{0,60}/);
  if (blank) return evidence(`${blank[0].split("\n").length - 1} blank lines, then: ${blank[0].trim()}`);
  const wide = text.match(/[ \t]{200,}\S[^\n]{0,60}/);
  return wide ? evidence(`a long run of spaces, then: ${wide[0].trim()}`) : null;
}

export const SKILL_RULES: SkillRule[] = [
  { id: "SG1", category: "credential-access", severity: "critical", confidence: 0.9, source: "skill-guard", test: (t) => first(t, CREDENTIAL_USE, CREDENTIAL_LITERAL) },
  { id: "SG1m", category: "credential-mention", severity: "medium", confidence: 0.6, source: "skill-guard",
    test: (t) => (first(t, CREDENTIAL_USE, CREDENTIAL_LITERAL) ? null : first(t, CREDENTIAL_MENTION)) },
  { id: "SG2", category: "network-exfiltration", severity: "critical", confidence: 0.9, source: "skill-guard",
    test: (t) => first(t, /\b(curl|wget)\b[^\n]*(?:\bPOST\b|--data|--upload-file|-T\s)/i) },
  { id: "SG3", category: "shell-execution", severity: "critical", confidence: 0.9, source: "skill-guard",
    test: (t) => first(t, /\brm\s+-rf\s+\/(?!\w)|\b(?:curl|wget)\b[^\n]{0,200}\|\s*(?:ba|z|da)?sh\b|\beval\s*[(`]/i) },
  { id: "SG4", category: "filesystem-write", severity: "medium", confidence: 0.7, source: "skill-guard",
    test: (t) => first(t, /(?:\b(?:write|tee)|>>?)\s*\/etc\/|~\/Library\/(?:Application Support|Preferences)\/|~\/\.config\/[a-z]/i) },
  { id: "SG5", category: "instruction-override", severity: "medium", confidence: 0.8, source: "skill-guard",
    test: (t) => first(t, /\bignore (?:previous|prior|all|the above) instructions\b|\bdisregard (?:the |your )?(?:system |previous )?(?:prompt|instructions)\b|\boverride (?:the |your )?system\b/i) },
  { id: "SG6", category: "obfuscation", severity: "medium", confidence: 0.75, source: "skill-guard",
    test: (t) => (DECODE_RUN.test(t) ? first(t, BASE64_RUN(80)) : null) },
  { id: "SG6b", category: "obfuscation", severity: "medium", confidence: 0.6, source: "murage",
    test: (t) => (DECODE_RUN.test(t) ? null : first(t, BASE64_RUN(120))) },
  { id: "M1", category: "hidden-text", severity: "medium", confidence: 0.8, source: "murage", test: hiddenText },
  { id: "M2", category: "direction-override", severity: "high", confidence: 0.9, source: "murage", test: (t) => first(t, /[\u202A-\u202E\u2066-\u2069][^\n]{0,40}/) },
  { id: "M3", category: "padding", severity: "medium", confidence: 0.7, source: "murage", test: padding },
];
