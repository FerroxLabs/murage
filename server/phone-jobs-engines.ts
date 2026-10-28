// 1.0.9 S13b: which driver kinds mount the phone-jobs MCP server (integrations.phoneJobs, server name "phoneJobs").
// Every kind in ENGINE_LABEL (conversation-deletion.ts) must be classified here; phone-jobs-engines.test.ts fails for a new engine
// that is not, so one cannot be silently missed. A kind marked "unsupported" is never told it has phone tools (capabilities-primer.ts).

export type PhoneJobsEngineStatus = { mounts: true; where: string } | { mounts: false; why: string };

const ACP = "server/drivers/acp/core.ts acpMcpServers (served by the engine's file in server/drivers/acp/)";

export const PHONE_JOBS_ENGINES: Readonly<Record<string, PhoneJobsEngineStatus>> = {
  fuigoAgent: { mounts: true, where: ACP + " via acp/fuigo.ts" },
  grokAgent: { mounts: true, where: ACP + " via acp/grok.ts" },
  claudeAgent: { mounts: true, where: "server/drivers/claude.ts mcpServers.phoneJobs" },
  codex: { mounts: true, where: "server/drivers/codex.ts mount(\"phoneJobs\")" },
  piAgent: { mounts: true, where: "server/drivers/pi.ts buildMcpServers" },
  opencodeGo: { mounts: true, where: ACP + " via acp/opencode-go.ts" },
  geminiAgent: { mounts: true, where: ACP + " via acp/gemini.ts" },
  qwenAgent: { mounts: true, where: ACP + " via acp/qwen.ts" },
  kimiAgent: { mounts: true, where: ACP + " via acp/kimi.ts" },
  cursorAgent: { mounts: true, where: ACP + " via acp/cursor.ts" },
  droidAgent: { mounts: true, where: ACP + " via acp/droid.ts" },
  hermesAgent: { mounts: true, where: ACP + " via acp/hermes.ts" },
  clineAgent: { mounts: true, where: ACP + " via acp/cline.ts" },
  customAcp: { mounts: true, where: ACP + " via acp/custom.ts" },
  antigravityAgent: {
    mounts: false,
    why: "agy has no per-session MCP flag: server/drivers/antigravity.ts writes Murage's servers into the owner's global agy config file, and a phone-jobs token must not be left in a persistent file outside the turn",
  },
  openclawAgent: {
    mounts: false,
    why: "acp/openclaw.ts sets ownTools: true, so acp/core.ts hands it no MCP servers (support.ownTools ? [] : acpMcpServers) and it declares agentsMcp false",
  },
};

/** Whether this driver kind mounts integrations.phoneJobs. An unknown kind is treated as not mounting (fail closed). */
export function driverMountsPhoneJobs(driverKind: string): boolean {
  const status = PHONE_JOBS_ENGINES[driverKind];
  return status !== undefined && status.mounts === true;
}
