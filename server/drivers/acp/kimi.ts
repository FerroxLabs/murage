// Kimi Code harness support — Moonshot's `kimi` CLI over ACP stdio
// (`kimi acp`), on the Kimi Code subscription login
// (~/.kimi-code/credentials/kimi-code.json), not a Moonshot API key.
// The generic protocol runtime lives in acp/core.ts; this file is only the
// per-harness quirks. Verified against kimi-code 0.29.1: initialize reports
// loadSession:true (session/load resume works), mcpCapabilities http+sse,
// and a full session/new → session/prompt roundtrip streams
// agent_thought_chunk + agent_message_chunk and settles with end_turn.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createAcpDriver, type AcpSupport } from "./core.ts";

const support: AcpSupport = {
  driverKind: "kimiAgent",
  displayName: "Kimi",
  // Aliases from the CLI's own catalog (~/.kimi-code/config.toml
  // [models."kimi-code/…"] — `kimi provider list` reports the same four).
  models: {
    default: "kimi-code/k3",
    options: [
      { id: "kimi-code/k3", label: "Kimi K3" },
      { id: "kimi-code/k3-256k", label: "Kimi K3 256K" },
      { id: "kimi-code/kimi-for-coding", label: "Kimi for Coding" },
      { id: "kimi-code/kimi-for-coding-highspeed", label: "Kimi for Coding Highspeed" },
    ],
  },
  defaultCli: "kimi",
  nativeSource: "kimi.acp",
  loginNote: "Kimi Code CLI is not signed in — run `kimi login` in a terminal",

  // -m is a global commander option and must precede the `acp` subcommand
  // (verified against 0.29.1).
  spawnArgs: (_config, turn) => [...(turn.model ? ["-m", turn.model] : []), "acp"],

  // Subscription CLI: a leaked Moonshot/Kimi API key must not flip billing
  // to pay-as-you-go inside the spawned agent (mirrors claude/grok).
  transformEnv: (env) => {
    delete env.MOONSHOT_API_KEY;
    delete env.KIMI_API_KEY;
  },

  // The only advertised authMethod is {id:"login", type:"terminal"} — a
  // device-code flow that cannot be driven over ACP. Never pick it; ride
  // the ambient login from a prior `kimi login` instead.
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => existsSync(join(homedir(), ".kimi-code", "credentials", "kimi-code.json")),

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const KimiAgentDriver = createAcpDriver(support);
