import { MAX_BOT_PACKAGE_ENTRIES, MAX_BOT_PACKAGE_EXPANDED_BYTES, normalizeBotPackagePath } from "./bot-package-manifest.ts";

export interface BotPackageScanFile { path: string; content: string | Uint8Array }
export interface BotPackageFinding {
  path: string;
  rule: string;
  severity: "block" | "review";
  /** UTF-16 text offset and one-based line; zero for an uninspected file. */
  offset: number;
  line: number;
}
export interface BotPackageScanResult { blocked: boolean; reviewRequired: boolean; findings: BotPackageFinding[]; truncated: boolean }
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
  { rule: "machine-local-path", severity: "review", pattern: /(?:\/(?:Users|home|root|Volumes)\/[^\s"'<>]{1,240}|[A-Za-z]:\\[^\s"'<>]{1,240}|~\/[^\s"'<>]{1,240})/g },
  { rule: "environment-lookup", severity: "review", pattern: /(?:\bprocess\.env(?:\.[A-Za-z_][A-Za-z0-9_]{0,127}|\[)|\bos\.(?:environ|getenv)\b|\$\{?[A-Z_][A-Z0-9_]{1,127}\}?|\$env:[A-Za-z_][A-Za-z0-9_]{0,127})/g },
] as const;

function safePath(path: string, index: number): string {
  try {
    normalizeBotPackagePath(path);
    if (RULES.some(({ pattern }) => { pattern.lastIndex = 0; return pattern.test(path); })) return `entry-${index + 1}`;
    return path;
  } catch { return `entry-${index + 1}`; }
}

/** Scan only explicitly selected in-memory payloads. No I/O or execution.
 * Warnings require user review. Binary/unscanned content fails closed until
 * a separate, explicit binary review policy is supplied by the caller. */
export function scanBotPackageContents(files: readonly BotPackageScanFile[]): BotPackageScanResult {
  const result: BotPackageScanResult = { blocked: false, reviewRequired: false, findings: [], truncated: false };
  const add = (path: string, rule: string, severity: "block" | "review", offset = 0, line = 0) => {
    if (severity === "block") result.blocked = true;
    else result.reviewRequired = true;
    if (result.findings.length < MAX_FINDINGS) result.findings.push({ path, rule, severity, offset, line });
    else { result.blocked = true; result.truncated = true; }
  };
  if (files.length > MAX_BOT_PACKAGE_ENTRIES) {
    add("package", "file-count-limit", "block"); result.truncated = true; return result;
  }
  let totalBytes = 0;
  for (const [index, file] of files.entries()) {
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
    for (const { rule, severity, pattern } of RULES) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      let lastOffset = 0;
      let line = 1;
      while ((match = pattern.exec(content)) !== null) {
        // Incremental line counting keeps repeated findings linear in file size.
        for (let cursor = lastOffset; cursor < match.index; cursor++) if (content.charCodeAt(cursor) === 10) line++;
        lastOffset = match.index;
        add(path, rule, severity, match.index, line);
        if (result.truncated) return result;
      }
    }
  }
  return result;
}
