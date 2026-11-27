import type { InstanceConfigMap } from "./contracts.ts";

/** Data only; recovery can list choices without importing/probing drivers. */
export const DEFAULT_INSTANCES: InstanceConfigMap = {
  fuigo: { driver: "fuigoAgent" },
  grok: { driver: "grokAgent" },
  kimi: { driver: "kimiAgent" },
  droid: { driver: "droidAgent" },
  cursor: { driver: "cursorAgent" },
  claude: { driver: "claudeAgent" },
  codex: { driver: "codex" },
  antigravity: { driver: "antigravityAgent" },
  opencodeGo: { driver: "opencodeGo" },
  computer: { driver: "boxAgent" },
  openaiCompat: { driver: "openai-compat" },
  qwen: { driver: "qwenAgent" },
  hermes: { driver: "hermesAgent" },
  cline: { driver: "clineAgent" },
  muse: { driver: "museCode" },
  pi: { driver: "piAgent" },
  commandCode: { driver: "commandCodeAgent" },
  kiro: { driver: "kiroAgent" },
  omp: { driver: "ompAgent" },
  devin: { driver: "devinAgent" },
  // Last on purpose: the person's own Copilot CLI is offered after every other engine, never as a default.
  deepseek: { driver: "deepseekAgent" },
  githubCopilot: { driver: "copilotAgent" },
};
