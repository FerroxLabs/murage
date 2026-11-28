import { BOT_FIELDS, FLUX_FIELDS } from "../spend-gate.ts";

const fields = new Set<string>([
  "code", "type", FLUX_FIELDS.limit, FLUX_FIELDS.keyId, BOT_FIELDS.id,
  FLUX_FIELDS.resetsAt, FLUX_FIELDS.keyBudget, FLUX_FIELDS.tokenLimit,
  FLUX_FIELDS.spent, FLUX_FIELDS.tokens, BOT_FIELDS.budget, FLUX_FIELDS.accountId,
]);
const wrappers = new Set(["error", "detail", "provider_specific_fields"]);
const code = /^[a-z][a-z0-9_]{0,79}$/;

/** Keep private classification/scope evidence, never provider prose or navigation. */
function project(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(value)) {
    if (wrappers.has(name)) {
      if (name === "error" && typeof field === "string" && code.test(field)) result[name] = field;
      else if (field && typeof field === "object" && !Array.isArray(field)) result[name] = project(field);
    } else if (fields.has(name)) {
      if ((name === "code" || name === "type") && (typeof field !== "string" || !code.test(field))) continue;
      if (typeof field === "string" || (typeof field === "number" && Number.isFinite(field))) result[name] = field;
    }
  }
  return result;
}

/** Read a complete 402 within one monotonic deadline; cleanup never owns the outcome. */
export async function read402Body(res: Response): Promise<unknown> {
  const until = performance.now() + 1000;
  const reader = res.body?.getReader();
  if (!reader) return null;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1000); });
  let bytes = 0, depth = 0, quoted = false, escaped = false, text = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (;;) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part === null || performance.now() >= until) return null;
      if (part.done) {
        const body: unknown = JSON.parse(text + decoder.decode());
        return performance.now() < until ? project(body) : null;
      }
      bytes += part.value.byteLength;
      if (bytes > 16384) return null;
      const chunk = decoder.decode(part.value, { stream: true });
      for (const character of chunk) {
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') quoted = false;
        } else if (character === '"') quoted = true;
        else if (character === "{" || character === "[") { if (++depth > 6) return null; }
        else if (character === "}" || character === "]") depth--;
      }
      text += chunk;
    }
  } catch { return null; }
  finally {
    clearTimeout(timer!);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
