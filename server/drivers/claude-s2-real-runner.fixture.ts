import { isAbsolute } from "node:path";
import { claudeS2NativeBuild } from "./claude-s2-qualification.ts";

/** No PATH fallback, ambient login files, auto-login or downloaded CLI. The
 * qualification launcher supplies these only after its explicit real opt-in. */
export async function requireRealClaudeS2Runner(): Promise<string> {
  const cli = process.env.MURAGE_REAL_CLAUDE_S2_CLI;
  const pin = process.env.MURAGE_REAL_CLAUDE_S2_BUILD;
  if (!cli || !isAbsolute(cli) || !pin || !/^[a-f0-9]{64}$/.test(pin)) throw new Error("real S2 requires an absolute native CLI and explicit build SHA256 pin; use scripts/qualify-claude-s2.mjs");
  if (Boolean(process.env.ANTHROPIC_API_KEY) === Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN)) throw new Error("real S2 requires exactly one dedicated qualification credential, never an ambient login directory");
  if (await claudeS2NativeBuild(cli) !== pin) throw new Error("real S2 native CLI changed or does not match its build pin");
  return cli;
}
