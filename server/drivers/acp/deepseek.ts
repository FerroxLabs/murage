// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// U22 C24, adapted from OpenMausBot 404a36b37. The owner's installed dsh uses
// ACP session config options and session/resume, rather than session/load.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ModelCatalog } from "../../contracts.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import { discoverAcpModels } from "./custom-model-catalog.ts";
import { resolveDeepseekDestination } from "./deepseek-destination.ts";

export const DEEPSEEK_MODELS: ModelCatalog = {
  default: "deepseek-official/deepseek-v4-flash",
  options: [
    { id: "deepseek-official/deepseek-v4-flash", label: "DeepSeek-V4-Flash" },
    { id: "deepseek-official/deepseek-flash", label: "DeepSeek-V4.1-Flash-1017" },
    { id: "deepseek-official/deepseek-v4-pro", label: "DeepSeek-V4-Pro" },
  ],
};
export function deepseekWireValue(id: string): string {
  const slash = id.indexOf("/");
  return slash > 0 && slash < id.length - 1 ? JSON.stringify([id.slice(0, slash), id.slice(slash + 1)]) : id;
}
export function deepseekPickerId(value: string): string | null {
  try {
    const pair: unknown = JSON.parse(value);
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some(part => typeof part !== "string" || !part.trim())) return null;
    // A slash in the provider would make the inverse ambiguous.
    if (pair[0].includes("/")) return null;
    const id = `${pair[0]}/${pair[1]}`;
    return id.length <= 200 ? id : null;
  } catch { return null; }
}
export function deepseekCatalog(catalog: ModelCatalog): ModelCatalog {
  const options = catalog.options.flatMap(option => {
    const id = deepseekPickerId(option.id);
    return id ? [{ ...option, id }] : [];
  });
  if (!options.length) throw new Error("DeepSeek Harness advertised no usable models. The previous catalog was kept.");
  const current = deepseekPickerId(catalog.default);
  return { default: current && options.some(option => option.id === current) ? current : options[0].id, options };
}
export function dshHome(env: Record<string, string | undefined>): string {
  return env.DSH_HOME || join((process.platform === "win32" ? env.USERPROFILE : env.HOME) || homedir(), ".dsh");
}
const present = (value: unknown) => typeof value === "string" && value.trim().length > 0;
export function hasDeepSeekKey(env: Record<string, string | undefined>): boolean {
  if (present(env.DEEPSEEK_API_KEY)) return true;
  const home = dshHome(env);
  try {
    const text = readFileSync(join(home, ".credentials.yaml"), "utf8");
    const doc = text.length <= 65536 ? parseYaml(text) : null;
    if (doc && typeof doc === "object" && (present(doc.refs?.DEEPSEEK_API_KEY) || present(doc.DEEPSEEK_API_KEY))) return true;
  } catch { /* Missing or malformed native credentials are not a sign-in. */ }
  try {
    const text = readFileSync(join(home, ".env"), "utf8");
    if (text.length > 65536) return false;
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=(.*)$/.exec(line);
      if (!match) continue;
      const raw = match[1].trim();
      const quoted = /^(["'])(.*?)\1(?:\s*#.*)?$/.exec(raw);
      if (present(quoted ? quoted[2] : raw.replace(/\s+#.*$/, "").trim())) return true;
    }
  } catch { /* No home .env. Never inspect a conversation's .env. */ }
  return false;
}
export const deepseekSupport: AcpSupport = {
  driverKind: "deepseekAgent", displayName: "DeepSeek Harness", nativeSource: "deepseek.acp",
  defaultCli: "dsh", models: DEEPSEEK_MODELS,
  loginNote: "DeepSeek Harness needs a DeepSeek API key. Configure it in dsh or set DEEPSEEK_API_KEY, then check again.",
  install: { command: { darwin: "npm install -g @deepseek-ai/dsh", linux: "npm install -g @deepseek-ai/dsh", win32: "npm install -g @deepseek-ai/dsh" }, docsUrl: "https://github.com/deepseek-ai/deepseek-harness", needsNode: true },
  spawnArgs: () => ["--profile", "acp"], credentialEnv: ["DEEPSEEK_API_KEY"],
  pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: env => hasDeepSeekKey(env),
  selectModel: { configId: "model" }, modelVariants: true, resumeMethod: "resume",
  resolveModelsOnCreate: false,
  resolveModels: async (env, config) => deepseekCatalog(await discoverAcpModels(env, config.cli || "dsh", ["--profile", "acp"])),
  resolveTurnModel: model => model ? deepseekWireValue(model) : model,
  effectiveDestination: resolveDeepseekDestination,
  buildPromptText: turn => turn.system ? `${turn.system}\n\n${turn.text}` : turn.text,
};
export const DeepSeekAgentDriver = createAcpDriver(deepseekSupport);
