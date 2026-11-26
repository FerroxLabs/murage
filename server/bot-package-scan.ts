import { MAX_BOT_PACKAGE_ENTRIES, MAX_BOT_PACKAGE_EXPANDED_BYTES, normalizeBotPackagePath } from "./bot-package-manifest.ts";

export interface BotPackageScanFile { path: string; content: string | Uint8Array }
export interface BotPackageFinding {
  path: string;
  rule: string;
  severity: "block" | "review";
  /** UTF-16 text offset and one-based line; zero for an uninspected file. */
  offset: number;
  line: number;
  /** Import guard findings only (bot-package-guard.ts). Skill Guard's plain
   * wording, the package field that matched ("agents[0].description"), the
   * matching text (at most 120 characters, secrets removed) and the Skill
   * Guard category. Absent on the older secret and path findings. */
  message?: string;
  field?: string;
  evidence?: string;
  category?: string;
  /** Review findings only: how many times the same rule matched in the same
   * file. One row stands for all of them; offset, line and evidence are the
   * first match. Absent means one. */
  count?: number;
}
export interface BotPackageScanResult {
  blocked: boolean; reviewRequired: boolean; findings: BotPackageFinding[]; truncated: boolean;
  /** Why a blocked result has no findings to read: the package is over the
   * size the check reads ("too-large"), or the check could not finish
   * ("unavailable", always retryable). */
  state?: "too-large" | "unavailable";
}
const MAX_FINDINGS = 1000;
// Deliberately bounded token lengths and no nested repetition. These are
// indicators for export review, never a malware-free or secret-free guarantee.
const RULES = [
  { rule: "private-key", severity: "block", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g },
  { rule: "provider-token", severity: "block", pattern: /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,512}|gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255}|xox[baprs]-[A-Za-z0-9-]{20,255}|AKIA[A-Z0-9]{16})\b/g },
  { rule: "bearer-token", severity: "block", pattern: /\bBearer[ \t]+[A-Za-z0-9._~+\/-]{16,2048}={0,2}/gi },
  { rule: "credential-value", severity: "block", pattern: /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key)["']?[ \t]{0,20}[:=][ \t]{0,20}["']?[A-Za-z0-9_./+~-]{16,2048}/gi },
  { rule: "session-cookie", severity: "block", pattern: /\b(?:session(?:id|_id|_token)?|auth_token|connect\.sid|__Secure-[A-Za-z0-9_-]{1,80})["']?[ \t]{0,20}[:=][ \t]{0,20}["']?[A-Za-z0-9%_./+~-]{16,2048}/gi },
  { rule: "jwt-token", severity: "block", pattern: /\beyJ[A-Za-z0-9_-]{8,1024}\.[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,1024}\b/g },
  { rule: "machine-local-path", severity: "review", pattern: /(?:\/(?:Users|home|root|Volumes)\/[^\s"'<>]{1,240}|(?<![A-Za-z0-9])[A-Za-z]:\\[^\s"'<>]{1,240}|~\/[^\s"'<>]{1,240})/g },
  { rule: "environment-lookup", severity: "review", pattern: /(?:\bprocess\.env(?:\.[A-Za-z_][A-Za-z0-9_]{0,127}|\[)|\bos\.(?:environ|getenv)\b|\$\{?[A-Z_][A-Z0-9_]{1,127}\}?|\$env:[A-Za-z_][A-Za-z0-9_]{0,127})/g },
] as const;

/** Replace anything the secret rules would block, so a finding can quote text
 * without repeating a key or token. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { severity, pattern } of RULES) {
    if (severity !== "block") continue;
    pattern.lastIndex = 0;
    out = out.replace(pattern, "[removed]");
  }
  return out;
}

function safePath(path: string, index: number): string {
  try {
    normalizeBotPackagePath(path);
    if (RULES.some(({ pattern }) => { pattern.lastIndex = 0; return pattern.test(path); })) return `entry-${index + 1}`;
    return path;
  } catch { return `entry-${index + 1}`; }
}

// One JSON string literal in raw JSON text. A literal never holds a raw
// newline or quote, so this is exact on text JSON.parse has accepted. The two
// alternatives never start with the same character, so matching is linear.
const JSON_STRING = /"(?:[^"\\\u0000-\u001f]|\\.)*"/g;
const EVIDENCE_LIMIT = 120;

/** The review rules read what a JSON file says, not how it is escaped: in raw
 * JSON a newline is the two characters `\n`, so "Mind:\n-" used to read as a
 * `d:\` drive path. Each string literal is decoded and read on its own; the
 * offset is where the literal starts in the raw text. Null when the file is not
 * JSON, so it is read as plain text. The block rules always read the raw text. */
function jsonStrings(path: string, content: string): Array<{ offset: number; text: string }> | null {
  if (!/\.json$/i.test(path)) return null;
  try { JSON.parse(content); } catch { return null; }
  const out: Array<{ offset: number; text: string }> = [];
  JSON_STRING.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = JSON_STRING.exec(content)) !== null) out.push({ offset: match.index, text: JSON.parse(match[0]) as string });
  return out;
}

/** Scan only explicitly selected in-memory payloads. No I/O or execution.
 * Warnings require user review. Binary/unscanned content fails closed until
 * a separate, explicit binary review policy is supplied by the caller. */
export function scanBotPackageContents(files: readonly BotPackageScanFile[], onProgress?: (fraction: number) => void): BotPackageScanResult {
  const result: BotPackageScanResult = { blocked: false, reviewRequired: false, findings: [], truncated: false };
  // Review findings are grouped per file and rule, so one path quoted fifteen
  // times is one readable row with its text, not fifteen bare lines. Block
  // findings stay one row per match.
  const grouped = new Map<string, BotPackageFinding>();
  const add = (path: string, rule: string, severity: "block" | "review", offset = 0, line = 0, matched?: string) => {
    if (severity === "block") result.blocked = true;
    else result.reviewRequired = true;
    const key = severity === "review" ? `${path}\u0000${rule}` : null;
    const seen = key === null ? undefined : grouped.get(key);
    if (seen) { seen.count = (seen.count ?? 1) + 1; return; }
    if (result.findings.length < MAX_FINDINGS) {
      const finding: BotPackageFinding = { path, rule, severity, offset, line };
      if (matched !== undefined) finding.evidence = redactSecrets(matched).slice(0, EVIDENCE_LIMIT);
      result.findings.push(finding);
      if (key !== null) grouped.set(key, finding);
    } else { result.blocked = true; result.truncated = true; }
  };
  if (files.length > MAX_BOT_PACKAGE_ENTRIES) {
    add("package", "file-count-limit", "block"); result.truncated = true; return result;
  }
  let totalBytes = 0;
  const sizeOf = (file: BotPackageScanFile) => (typeof file.content === "string" ? file.content.length : file.content.byteLength);
  const allBytes = onProgress ? Math.max(1, files.reduce((sum, file) => sum + sizeOf(file), 0)) : 1;
  let readBytes = 0;
  for (const [index, file] of files.entries()) {
    if (onProgress) { onProgress(readBytes / allBytes); readBytes += sizeOf(file); }
    const path = safePath(file.path, index);
    const size = typeof file.content === "string" ? Buffer.byteLength(file.content, "utf8") : file.content.byteLength;
    totalBytes += size;
    if (totalBytes > MAX_BOT_PACKAGE_EXPANDED_BYTES) {
      add(path, "byte-limit", "block"); result.truncated = true; break;
    }
    // A binary asset can happen to decode as UTF-8 (for example a small PDF).
    // Its format still requires separate review; readable bytes are not proof.
    if (/\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|wasm|exe|dll|so|dylib|mp[34]|wav|woff2?|ttf)$/i.test(file.path)) {
      add(path, "binary-content-review-required", "block"); continue;
    }
    let content: string;
    try { content = typeof file.content === "string" ? file.content : new TextDecoder("utf-8", { fatal: true }).decode(file.content); }
    catch { add(path, "binary-content-review-required", "block"); continue; }
    if (content.includes("\0")) { add(path, "binary-content-review-required", "block"); continue; }
    const strings = jsonStrings(file.path, content);
    for (const { rule, severity, pattern } of RULES) {
      const decoded = severity === "review" && strings !== null;
      const units = decoded ? strings : [{ offset: 0, text: content }];
      let lastOffset = 0;
      let line = 1;
      for (const unit of units) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(unit.text)) !== null) {
          // A decoded literal's own offsets are not raw-text offsets: point at the literal.
          const offset = decoded ? unit.offset : match.index;
          // Incremental line counting keeps repeated findings linear in file size.
          for (let cursor = lastOffset; cursor < offset; cursor++) if (content.charCodeAt(cursor) === 10) line++;
          lastOffset = Math.max(lastOffset, offset);
          add(path, rule, severity, offset, line, severity === "review" ? match[0] : undefined);
          if (result.truncated) return result;
        }
      }
    }
  }
  return result;
}
