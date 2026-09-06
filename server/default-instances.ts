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
  pi: { driver: "piAgent" },
};
