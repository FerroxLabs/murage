export type OpenCodeFailure = "authentication" | "rate_limit" | "unavailable" | "tool_count";
const MAX_RECORD = 8192;
const FIELDS = new Set(["timestamp", "level", "run", "message", "providerID", "modelID", "session.id", "small", "agent", "mode", "error.error"]);

/** OpenCode 1.19.5 print-logs grammar; unknown shapes fail closed. */
export function parseOpenCodeFailure(line: string, session: string): OpenCodeFailure | undefined {
  if (Buffer.byteLength(line) > MAX_RECORD) return;
  const fields = new Map<string, string>();
  const token = /([\w.]+)=("(?:[^"\\\r\n]|\\.)*"|[^\s"]+)(?: |$)/gy;
  let at = 0;
  while (at < line.length) {
    token.lastIndex = at;
    const match = token.exec(line);
    if (!match || !FIELDS.has(match[1]!) || fields.has(match[1]!)) return;
    let value = match[2]!;
    if (value.startsWith('"')) { try { value = JSON.parse(value); } catch { return; } }
    fields.set(match[1]!, value);
    at = token.lastIndex;
  }
  if (fields.size !== FIELDS.size || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(fields.get("timestamp") ?? "")
    || fields.get("level") !== "ERROR" || fields.get("message") !== "stream error"
    || fields.get("session.id") !== session || fields.get("small") !== "false"
    || fields.get("mode") !== "primary" || !fields.get("agent") || fields.get("agent") === "title"
    || !fields.get("providerID") || !fields.get("modelID") || !fields.get("run")) return;
  const error = fields.get("error.error");
  if (!error?.startsWith("AI_APICallError: ")) return;
  if (/\b(?:rate limit|rate_limit_exceeded|too many requests)\b/i.test(error)) return "rate_limit";
  if (/\b(?:invalid api key|authentication failed|unauthorized)\b/i.test(error)) return "authentication";
  if (/\b(?:service unavailable|provider unavailable|overloaded)\b/i.test(error)) return "unavailable";
  if (/\b(?:maximum|max)\b.{0,40}\btools\b/i.test(error)) return "tool_count";
}

/** One fresh process, one prompt. Logs never count as engine progress. */
export class OpenCodeQuiet {
  private session: string | undefined;
  private buffer = "";
  private bufferBytes = 0;
  private dropping = false;
  private generation = 0;
  private lastProgress = 0;
  private seen = new Set<OpenCodeFailure>();
  private pending = new Map<OpenCodeFailure, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private budget = 65536;
  private refill: ReturnType<typeof setImmediate> | undefined;
  private readonly emit: (category: OpenCodeFailure, quietMs: number) => void;
  constructor(emit: (category: OpenCodeFailure, quietMs: number) => void) { this.emit = emit; }
  start(session: string) { this.stop(); this.session = session; this.lastProgress = Date.now(); }
  progress() {
    this.generation++; this.lastProgress = Date.now(); this.pending.clear();
    if (this.buffer) this.dropping = true;
    this.buffer = ""; this.bufferBytes = 0; clearTimeout(this.timer); this.timer = undefined;
  }
  stop() {
    this.session = undefined; this.buffer = ""; this.bufferBytes = 0; this.dropping = false; this.pending.clear();
    clearTimeout(this.timer); this.timer = undefined;
    if (this.refill) clearImmediate(this.refill);
    this.refill = undefined; this.budget = 65536;
  }
  feed(text: string) {
    if (!this.session) return;
    if (!this.refill) this.refill = setImmediate(() => { this.budget = 65536; this.refill = undefined; });
    const length = Math.min(text.length, this.budget);
    this.budget -= length;
    for (let i = 0; i < length; i++) {
      const char = text[i]!;
      if (char !== "\n") {
        if (!this.dropping) {
          this.buffer += char;
          this.bufferBytes += Buffer.byteLength(char);
          if (this.bufferBytes > MAX_RECORD) { this.buffer = ""; this.bufferBytes = 0; this.dropping = true; }
        }
        continue;
      }
      const category = this.dropping ? undefined : parseOpenCodeFailure(this.buffer, this.session);
      this.buffer = ""; this.bufferBytes = 0; this.dropping = false;
      if (!category || this.seen.has(category) || this.seen.size + this.pending.size >= 3) continue;
      this.pending.set(category, this.generation);
      if (!this.timer) this.timer = setTimeout(() => {
        this.timer = undefined;
        if (!this.session) return;
        for (const [kind, generation] of this.pending) {
          if (generation !== this.generation || this.seen.has(kind)) continue;
          this.seen.add(kind); this.emit(kind, Date.now() - this.lastProgress);
        }
        this.pending.clear();
      }, Math.max(0, 60000 - (Date.now() - this.lastProgress)));
    }
    if (length < text.length) { this.buffer = ""; this.bufferBytes = 0; this.dropping = true; }
  }
}

export function openCodeQuietLine(category: OpenCodeFailure, quietMs: number): string {
  const labels: Record<OpenCodeFailure, string> = { authentication: "an authentication failure", rate_limit: "a rate limit", unavailable: "an unavailable provider", tool_count: "a tool-count limit" };
  return `OpenCode reported ${labels[category]}. No reply for ${Math.max(60, Math.floor(quietMs / 1000))} seconds.`;
}
