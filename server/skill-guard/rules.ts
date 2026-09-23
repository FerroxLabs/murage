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

// Blocked means theft: reading or sending private keys and cloud
// credentials. A public key (.pub) is meant to be shared.
// Reading means a command aimed straight at the file; sending may be said
// in a sentence ("upload the key to...").
const READ_OR_SEND = String.raw`(?:\b(?:cat|type|print|less|more|head|tail|base64)\s+[^\n|;&]{0,40}|\b(?:upload|send|post|exfiltrate|email|paste)\b[^\n]{0,80})`;
const PRIVATE_KEYS = String.raw`(?:~\/\.ssh\/(?!\S*\.pub\b)[\w.-]+|\bid_(?:rsa|dsa|ecdsa|ed25519)\b(?!\.pub)|\.aws\/credentials|\.netrc\b|\.gnupg\/)`;
const CREDENTIAL_USE = new RegExp(READ_OR_SEND + PRIVATE_KEYS, "i");
// A settings file of secrets: worth a look, never Blocked on its own
// (setup guides copy .env.example to .env all the time). Not `process.env`.
const ENV_FILE_USE = new RegExp(READ_OR_SEND + String.raw`(?<![\w$.])\.env\b(?!\.example|\.sample|\.template)`, "i");
// A key pasted into a skill is a leak, not theft; placeholders don't count.
const CREDENTIAL_LITERAL = /AKIA[0-9A-Z]{16}|Bearer\s+(?![^\s]*(?:EXAMPLE|REPLACE|YOUR|xxx|dummy|placeholder|<))[A-Za-z0-9_-]{20,}/;
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
  { id: "SG1", category: "credential-access", severity: "critical", confidence: 0.9, source: "skill-guard", test: (t) => first(t, CREDENTIAL_USE) },
  { id: "SG1e", category: "credential-mention", severity: "medium", confidence: 0.7, source: "skill-guard", test: (t) => first(t, ENV_FILE_USE) },
  { id: "SG1k", category: "credential-literal", severity: "medium", confidence: 0.7, source: "skill-guard", test: (t) => first(t, CREDENTIAL_LITERAL) },
  { id: "SG2", category: "network-exfiltration", severity: "critical", confidence: 0.9, source: "skill-guard",
    test: (t) => first(t, /\b(curl|wget)\b[^\n]*(?:\bPOST\b|--data|--upload-file|-T\s)/i) },
  // Piping a download into a shell, or wiping the disk: documented as bad
  // examples far more often than meant, so worth a look, not Blocked.
  { id: "SG3", category: "shell-execution", severity: "medium", confidence: 0.8, source: "skill-guard",
    test: (t) => first(t, /\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|\brm\s+-rf\s+\/(?![\w.$"'{])/i) },
  { id: "SG4", category: "filesystem-write", severity: "medium", confidence: 0.7, source: "skill-guard",
    test: (t) => first(t, /(?:\b(?:write|tee)|>>?)\s*\/etc\/|~\/Library\/(?:Application Support|Preferences)\/|~\/\.config\/[a-z]/i) },
  { id: "SG5", category: "instruction-override", severity: "medium", confidence: 0.8, source: "skill-guard",
    test: (t) => first(t, /\bignore (?:previous|prior|all|the above) instructions\b|\bdisregard (?:the |your )?(?:system |previous )?(?:prompt|instructions)\b|\boverride (?:the |your )?system\b/i) },
  { id: "SG6", category: "obfuscation", severity: "medium", confidence: 0.75, source: "skill-guard",
    test: (t) => (DECODE_RUN.test(t) ? first(t, BASE64_RUN(80)) : null) },
  { id: "SG6b", category: "obfuscation", severity: "medium", confidence: 0.6, source: "murage",
    test: (t) => (DECODE_RUN.test(t) ? null : first(t, BASE64_RUN(120))) },
  { id: "M1", category: "hidden-text", severity: "medium", confidence: 0.8, source: "murage", test: hiddenText },
  { id: "M2", category: "direction-override", severity: "high", confidence: 0.9, source: "murage", test: (t) => first(t, /[‪-‮⁦-⁩][^\n]{0,40}/) },
  { id: "M3", category: "padding", severity: "medium", confidence: 0.7, source: "murage", test: padding },
];
