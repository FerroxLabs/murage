import { randomBytes } from "node:crypto";

const tools = new Set(["memory_search", "memory_get", "memory_save", "memory_propose_correction"]);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

/** One unpredictable alias per turn; the longest qualified tool is 61 bytes. */
export const newFuigoMemoryAlias = () => `murage-memory-${randomBytes(10).toString("hex")}`;

/** Canonical metadata is stamped by Fuigo's registered toolset. Display labels
 * and model arguments cannot establish ownership of a memory proxy. */
export function fuigoMemoryAllowOnce(toolCall: unknown, options: unknown, alias: string): string | null {
  if (!/^murage-memory-[a-f0-9]{20}$/.test(alias) || !record(toolCall) || !record(toolCall._meta)) return null;
  const identity = toolCall._meta["fuigo/tool"];
  if (!record(identity) || identity.version !== 1 || identity.namespace !== "mcp" || typeof identity.name !== "string") return null;
  if (![...tools].some(tool => identity.name === `${alias}__${tool}`) || !Array.isArray(options)) return null;
  const once = options.filter(option => record(option) && option.kind === "allow_once" && typeof option.optionId === "string" && option.optionId.length > 0);
  if (once.length !== 1) return null;
  const id = once[0].optionId as string;
  return options.filter(option => record(option) && option.optionId === id).length === 1 ? id : null;
}
