// A completed reply that is nothing but Murage's own memory provenance
// (evidence handles or whole reference records) is not an answer: the model
// copied machine-readable context instead of replying. The harness keeps such
// a reply out of the conversation and shows a retryable notice instead.
const HANDLE_KEYS = new Set(["sourceId", "revision", "startByte", "endByte"]);
const RECORD_KEYS = new Set(["id", "version", "scopeId", "text", "assertion", "pinned", "kind", "evidence"]);
const MAX_ECHO_BYTES = 65536;

const plainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function evidenceHandle(value: unknown): boolean {
  return plainObject(value)
    && Object.keys(value).every(key => HANDLE_KEYS.has(key))
    && typeof value.sourceId === "string"
    && typeof value.startByte === "number"
    && typeof value.endByte === "number";
}

function referenceRecord(value: unknown): boolean {
  return plainObject(value)
    && Object.keys(value).every(key => RECORD_KEYS.has(key))
    && typeof value.id === "string"
    && Array.isArray(value.evidence)
    && value.evidence.every(evidenceHandle);
}

/** True only when the whole reply is provenance JSON (optionally in one code
 * fence). Prose that mentions or quotes such JSON is an ordinary reply. */
export function isMemoryProvenanceEcho(text: string): boolean {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_ECHO_BYTES) return false;
  let body = text.trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i.exec(body);
  if (fenced) body = fenced[1].trim();
  if (!body.startsWith("{") && !body.startsWith("[")) return false;
  let value: unknown;
  try { value = JSON.parse(body); } catch { return false; }
  const items = Array.isArray(value) ? value : [value];
  return items.length > 0 && items.every(item => evidenceHandle(item) || referenceRecord(item));
}
